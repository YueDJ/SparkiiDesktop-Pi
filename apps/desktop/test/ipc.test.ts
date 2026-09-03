import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPiSessions } from '@sparkii/agent-host';
import { Keyring } from '../electron/main/keyring.js';
import { registerIpc } from '../electron/main/ipc.js';
import { selectModel } from '../electron/main/workflow.js';
import type { Runtime } from '../electron/main/runtime.js';

vi.mock('@sparkii/agent-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sparkii/agent-host')>();
  return {
    ...actual,
    listPiSessions: vi.fn(actual.listPiSessions),
  };
});

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    getHandlers: () => handlers,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    app: { getPath: () => '' },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    nativeImage: {
      createFromPath: vi.fn(),
    },
  };
});

async function registeredHandlers(): Promise<Map<string, (...args: unknown[]) => unknown>> {
  const electron = (await import('electron')) as unknown as {
    getHandlers: () => Map<string, (...args: unknown[]) => unknown>;
  };
  return electron.getHandlers();
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
  } as any;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllGlobals();
});

async function makeRuntime(opts: {
  dataDir: string;
  piAgentDir: string;
  client: { send: (command: any) => Promise<any>; onEvent?: (cb: (event: any) => void) => () => void };
  setKey?: (providerId: string, key: string) => Promise<void>;
  chatSession?: { profileId: string; model: string | null; piSessionFile?: string | null; kind?: string };
  profile?: unknown;
  agentOf?: (id: string) => unknown;
  getWindow?: () => { webContents: { send: (...args: unknown[]) => void } } | null;
}): Promise<Runtime> {
  const rt = {
    profiles: new Map(),
    gate: {},
    executor: {},
    audit: {},
    pool: {
      acquire: vi.fn(async () => ({ client: opts.client, supervisor: { onProposal: () => {} } })),
      release: vi.fn(async () => {}),
      renameSession: vi.fn(),
      activeCount: vi.fn(() => 0),
      get: () => opts.client,
      broadcast: vi.fn(async () => {}),
      snapshot: vi.fn(() => ({ maxAgents: 4, active: 0, queued: 0, slots: [], queue: [] })),
      subscribe: vi.fn(() => () => {}),
      cancelPending: vi.fn(() => true),
      setMaxAgents: vi.fn(),
    },
    subject: { userId: 'tester', roles: ['admin'] },
    chatSessions: { get: () => opts.chatSession ?? null, list: vi.fn(() => []), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dataDir: opts.dataDir,
    keyring: null as any,
    piAgentDir: opts.piAgentDir,
    profileOf: () =>
      opts.profile ?? ({
        dir: join(opts.dataDir, 'profiles', 'contract-review'),
        profile: { agent: { tools: [], prompts: { system: 'test' } } },
        router: { resolve: () => undefined },
      } as any),
    agentOf: (id: string) => {
      if (opts.agentOf) return opts.agentOf(id);
      const pr = opts.profile ?? ({
        dir: join(opts.dataDir, 'profiles', 'contract-review'),
        profile: { agent: { tools: [], prompts: { system: 'test' } } },
      } as any);
      const dir = pr.dir ?? join(opts.dataDir, 'profiles', 'contract-review');
      const tools = pr.profile?.agent?.tools ?? pr.agent?.tools ?? [];
      const systemPrompt = pr.profile?.agent?.prompts?.system ?? pr.agent?.prompts?.system ?? 'test';
      return {
        id: 'contract-review',
        manifest: {
          id: 'contract-review',
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools },
        },
        tools,
        dir,
        skillsDir: join(dir, 'agent', 'skills'),
        systemPrompt,
      };
    },
    keyFor: async () => null,
    setKey: opts.setKey ?? (async () => {}),
  } as unknown as Runtime;
  registerIpc(rt, (opts.getWindow ?? (() => null)) as any, { export: async () => '' } as any);
  return rt;
}

describe('ipc provider handlers', () => {
  it('lists builtin whitelist plus custom providers through a probe slot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        providers: [
          { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
        ],
      }),
      'utf8',
    );

    const client = {
      send: async (command: any) => {
        if (command.type === 'list_providers') {
          return {
            type: 'response',
            command: 'list_providers',
            success: true,
            data: [
              { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
              { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', apiKeyAuth: true, oauthAuth: true },
            ],
          };
        }
        throw new Error(`unexpected command ${command.type}`);
      },
    };
    await makeRuntime({ dataDir, piAgentDir, client });

    const handlers = await registeredHandlers();
    const listProviders = handlers.get('sparkii:listProviders');
    expect(listProviders).toBeTypeOf('function');
    const result = (await listProviders!(null)) as Array<{ id: string; kind: string; api?: string }>;
    const ids = result.map((p) => p.id);
    expect(ids).toContain('deepseek');
    expect(ids).toContain('ollama');
    expect(ids).not.toContain('google');
    const ollama = result.find((p) => p.id === 'ollama');
    expect(ollama?.kind).toBe('custom');
    expect(ollama?.api).toBe('openai-completions');
  });

  it('saveSettings writes only custom providers to models.json and stores the per-provider key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keyring = new Keyring(join(dataDir, 'keyring'), fakeSafeStorage());
    const setKey = vi.fn(async (providerId: string, key: string) => {
      await keyring.set(`apiKey:${providerId}`, key);
    });
    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client, setKey });

    const handlers = await registeredHandlers();
    const save = handlers.get('sparkii:saveSettings');
    expect(save).toBeTypeOf('function');
    await save!(null, {
      activeProviderId: 'ollama',
      providers: [
        { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      ],
      apiKey: 'sk-ollama',
    });

    const cfg = JSON.parse(await readFile(join(piAgentDir, 'models.json'), 'utf8'));
    expect(cfg.providers).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
    });
    expect(cfg.providers.deepseek).toBeUndefined();
    expect(await keyring.get('apiKey:ollama')).toBe('sk-ollama');
    expect(rt.pool.broadcast as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      type: 'set_api_key',
      provider: 'ollama',
      apiKey: 'sk-ollama',
    });
  });

  it('getApiKey returns the per-provider key and getSettings includes the active provider key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek' }), 'utf8');
    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as unknown as { keyFor: (p: string) => Promise<string | null> }).keyFor = async (p: string) =>
      p === 'deepseek' ? 'sk-ds' : null;

    const handlers = await registeredHandlers();
    const getApiKey = handlers.get('sparkii:getApiKey');
    expect(await getApiKey!(null, 'deepseek')).toBe('sk-ds');
    expect(await getApiKey!(null, 'zai')).toBeNull();

    const getSettings = handlers.get('sparkii:getSettings');
    const settings = (await getSettings!(null)) as { activeProviderId: string; apiKey?: string };
    expect(settings.activeProviderId).toBe('deepseek');
    expect(settings.apiKey).toBe('sk-ds');
  });

  it('getRuntimePool returns the pool snapshot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt.pool as any).snapshot = () => ({ maxAgents: 4, active: 1, queued: 1, slots: [], queue: [] });

    const handlers = await registeredHandlers();
    const getRuntimePool = handlers.get('sparkii:getRuntimePool');
    await expect(getRuntimePool!(null)).toEqual({ maxAgents: 4, active: 1, queued: 1, slots: [], queue: [] });
  });

  it('listModels uses the caller-provided key instead of the stored keyring key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        activeProviderId: 'ollama',
        providers: [
          { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
        ],
      }),
      'utf8',
    );
    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as unknown as { keyFor: (p: string) => Promise<string | null> }).keyFor = async () => 'sk-stored';

    let headers: Record<string, string> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ data: [{ id: 'm1' }] }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const handlers = await registeredHandlers();
    const listModels = handlers.get('sparkii:listModels');
    expect(listModels).toBeTypeOf('function');
    const result = (await listModels!(null, 'ollama', 'sk-override')) as { ok: boolean; models?: string[] };

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['m1']);
    expect(headers?.Authorization).toBe('Bearer sk-override');
  });

  it('promptSession routes to settings active provider and default model when the session has no model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'zai', defaultModel: 'glm-5' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
    });
    const update = vi.fn();
    (rt as any).chatSessions.update = update;

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    expect(promptSession).toBeTypeOf('function');
    await promptSession!(null, 's1', '你好');

    expect(sent).toContainEqual({ type: 'set_model', provider: 'zai', modelId: 'glm-5' });
  });

  it('promptSession creates a session and sends the first prompt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    const result = await promptSession!(null, null, 'hello', undefined, undefined, { profileId: 'general' });

    expect(result).toMatchObject({ ok: true, sessionId: 's-new' });
    expect(sent).toContainEqual({ type: 'prompt', message: 'hello' });
    expect(rt.pool.acquire).toHaveBeenCalled();
    expect((rt as any).chatSessions.create).toHaveBeenCalled();
  });

  it('promptSession does not duplicate model application when the model is already in the saddle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'kimi', defaultModel: 'kimi-for-coding' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, null, 'hello', undefined, undefined, {
      profileId: 'general',
      model: 'kimi/kimi-for-coding',
      thinkingLevel: 'off',
    });

    expect(sent).not.toContainEqual({ type: 'set_model', provider: 'kimi', modelId: 'kimi-for-coding' });
    expect(sent).toContainEqual({ type: 'prompt', message: 'hello' });
    expect((rt as any).chatSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi/kimi-for-coding' }),
    );
  });

  it('listChatSessions excludes empty sessions from the local store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    const emptySession = {
      id: 'empty-1',
      profileId: 'general',
      workspaceKind: 'auto',
      workspacePath: 'C:/ws/empty',
      model: null,
      thinkingLevel: null,
      piSessionFile: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    (rt.chatSessions as unknown as { list: (profileId?: string) => unknown[] }).list = () => [emptySession];

    const handlers = await registeredHandlers();
    const listChatSessions = handlers.get('sparkii:listChatSessions');
    const result = await listChatSessions!(null, 'general');
    expect(result).toEqual([]);
  });

  it('getChatState does not acquire when a session has no lease', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
    });

    const handlers = await registeredHandlers();
    const getChatState = handlers.get('sparkii:getChatState');
    const result = await getChatState!(null, 's-missing');

    expect(result).toMatchObject({ streaming: false, steering: [], followUp: [] });
    expect(rt.pool.acquire).not.toHaveBeenCalled();
  });

  it('schedules idle release after agent_settled and releases after timeout', async () => {
    vi.useFakeTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const events: Array<(e: any) => void> = [];
    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        events.push(cb);
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/s.json', isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client, chatSession: { profileId: 'general', model: null } });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, null, 'hello', undefined, undefined, { profileId: 'general' });
    events[0]?.({ type: 'agent_settled' });
    events[0]?.({ type: 'session_info_changed', name: '标题生成后的事件' });

    expect(rt.pool.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rt.pool.release).toHaveBeenCalledWith('s1');
    vi.useRealTimers();
  });

  it('does not idle-release or title a workflow session after agent_settled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const events: Array<(e: any) => void> = [];
    const sent: any[] = [];
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        events.push(cb);
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'new_session') return { success: true };
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'wf-1', sessionFile: '/tmp/w.jsonl', isStreaming: false } };
        }
        if (command.type === 'get_messages') {
          return { success: true, data: [{ role: 'user', text: '审核合同' }] };
        }
        if (command.type === 'complete') {
          return { success: true, data: '自动标题' };
        }
        return { success: true };
      },
    };
    const sessions = new Map<string, { id: string; profileId: string; kind?: string }>();
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }),
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review', displayName: '合同审核' },
          security: { approval: { timeoutMs: 60_000 } },
          agent: {
            tools: ['read'],
            prompts: { system: 'sys' },
            workflow: {
              version: 1,
              engine: 'linear',
              steps: [{ id: 'review', type: 'skill', ref: 'contract_risk_review', template: 'review' }],
            },
          },
        },
        router: { resolve: () => undefined },
      } as any,
    });
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string; kind?: string }) => {
      sessions.set(rec.id, rec);
    };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    (rt as any).gate = {
      submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
      expire: async (id: string) => ({ id, status: 'expired' }),
    };

    const handlers = await registeredHandlers();
    const runWorkflowHandler = handlers.get('sparkii:runWorkflow');
    const result = await Promise.race([
      runWorkflowHandler!(null, 'contract-review', { documents: [] }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('runWorkflow IPC did not return sessionId before the runner finished')), 1000);
      }),
    ]);

    expect(result).toEqual({ ok: true, sessionId: 'wf-1' });
    expect(events.length).toBeGreaterThan(0);

    vi.useFakeTimers();
    for (const cb of events) cb({ type: 'agent_settled' });
    expect(windowSent.some((c) => c[0] === 'sparkii:event:chat-event' && c[1]?.type === 'agent_settled')).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rt.pool.release).not.toHaveBeenCalled();

    for (const cb of events) cb({ type: 'agent_end' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'complete')).toBe(false);
    expect(sent.some((c) => c.type === 'set_session_name')).toBe(false);

    vi.useRealTimers();
  });

  it('stops forwarding client events after the workflow slot is released', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    const sent: any[] = [];
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'new_session') return { success: true };
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'wf-done', sessionFile: '/tmp/w.jsonl', isStreaming: false } };
        }
        return { success: true };
      },
    };
    const sessions = new Map<string, { id: string; profileId: string; kind?: string }>();
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }),
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review', displayName: '合同审核' },
          security: { approval: { timeoutMs: 60_000 } },
          agent: {
            tools: ['read'],
            prompts: { system: 'sys' },
            workflow: { version: 1, engine: 'linear', steps: [] },
          },
        },
        router: { resolve: () => undefined },
      } as any,
    });
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string; kind?: string }) => {
      sessions.set(rec.id, rec);
    };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;

    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [] });
    expect(result).toEqual({ ok: true, sessionId: 'wf-done' });
    await waitUntil(() => (rt.pool.release as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(rt.pool.release).toHaveBeenCalledTimes(1);

    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(windowSent.some((c) => c[0] === 'sparkii:event:chat-event' && c[1]?.sessionId === 'wf-done')).toBe(false);

    const opened = await handlers.get('sparkii:openChatSession')!(null, 'wf-done');
    expect(sent.some((c) => c.type === 'get_session_entries')).toBe(false);
    expect(opened).toMatchObject({ messages: [] });
  });

  it('workflow selectModel routes to settings active provider and default model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'zai', defaultModel: 'glm-5' }),
      'utf8',
    );
    const sent: any[] = [];
    const rt = {
      dataDir,
      keyring: null as any,
      pool: {
        get: () => ({
          send: async (command: any) => {
            sent.push(command);
            return { success: true };
          },
        }),
      },
      keyFor: async () => null,
    } as any;

    await selectModel(rt, 'chat', 's1');
    expect(sent).toContainEqual({ type: 'set_model', provider: 'zai', modelId: 'glm-5' });
  });

  it('listThinkingLevels probes a model and returns available thinking levels', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek' }), 'utf8');
    const sent: any[] = [];
    const client = {
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'list_thinking_levels') {
          return { success: true, data: ['off', 'medium', 'high'] };
        }
        return { success: true };
      },
    };
    await makeRuntime({ dataDir, piAgentDir, client });

    const handlers = await registeredHandlers();
    const listThinkingLevels = handlers.get('sparkii:listThinkingLevels');
    const result = await listThinkingLevels!(null, 'deepseek', 'deepseek-v4-pro');
    expect(result).toEqual(['off', 'medium', 'high']);
    expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
    expect(sent).toContainEqual({ type: 'list_thinking_levels' });
  });

  it('setChatThinkingLevel stores the session level and remembers it per model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek' }), 'utf8');
    const client = { send: async () => ({ success: true }) };
    const update = vi.fn();
    const rt = await makeRuntime({ dataDir, piAgentDir, client, chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' } });
    (rt as unknown as { chatSessions: { update: (id: string, p: unknown) => void } }).chatSessions.update = update;

    const handlers = await registeredHandlers();
    const setChatThinkingLevel = handlers.get('sparkii:setChatThinkingLevel');
    await setChatThinkingLevel!(null, 's1', 'high');

    expect(update).toHaveBeenCalledWith('s1', { thinkingLevel: 'high' });
    const cfg = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    expect(cfg.modelThinkingLevels).toEqual({ 'deepseek/deepseek-v4-pro': 'high' });
  });

  it('promptSession applies the session thinking level before prompt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }), 'utf8');
    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionFile: null } };
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro', thinkingLevel: 'high' },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '你好');

    expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
    expect(sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
  });

  it('setChatModel applies the selected model to the open Pi session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
    });
    const update = vi.fn();
    (rt as any).chatSessions.update = update;

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '你好');
    sent.length = 0;

    const setChatModel = handlers.get('sparkii:setChatModel');
    await setChatModel!(null, 's1', 'deepseek-v4-pro');

    expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
    expect(update).toHaveBeenCalledWith('s1', { model: 'deepseek/deepseek-v4-pro' });
  });

  it('setChatThinkingLevel applies the selected level to the open Pi session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionFile: null } };
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '你好');
    sent.length = 0;

    const setChatThinkingLevel = handlers.get('sparkii:setChatThinkingLevel');
    await setChatThinkingLevel!(null, 's1', 'high');

    expect(sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
  });

  it('queues a follow_up by default while the Pi session is streaming', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { isStreaming: true, sessionFile: null } };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    const result = await promptSession!(null, 's1', '继续做');

    expect(sent).toContainEqual({ type: 'follow_up', message: '继续做' });
    expect(sent).not.toContainEqual({ type: 'prompt', message: '继续做' });
    expect(result).toMatchObject({ ok: true, behavior: 'followUp' });
  });

  it('abortChat clears the queue before aborting and returns the cleared items', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return {
            success: true,
            data: {
              isStreaming: false,
              sessionFile: null,
              steering: ['先做这个'],
              followUp: ['做完后整理'],
            },
          };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '开始');

    const abortChat = handlers.get('sparkii:abortChat');
    const result = await abortChat!(null, 's1');

    const clearIndex = sent.findIndex((c) => c.type === 'clear_queue');
    const abortIndex = sent.findIndex((c) => c.type === 'abort');
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(abortIndex).toBeGreaterThan(clearIndex);
    expect(result).toEqual({
      ok: true,
      cleared: { steering: ['先做这个'], followUp: ['做完后整理'] },
    });
  });

  it('queueMutate rebuilds both queues from the current Pi snapshot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
      'utf8',
    );

    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return {
            success: true,
            data: {
              isStreaming: true,
              sessionFile: null,
              steering: ['先做这个'],
              followUp: ['做完后整理', '再跑一遍测试'],
            },
          };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '开始');

    const queueMutate = handlers.get('sparkii:queueMutate');
    const result = await queueMutate!(null, 's1', {
      action: 'transfer',
      queue: 'followUp',
      index: 0,
      targetQueue: 'steering',
    });

    const clearIndex = sent.findIndex((c) => c.type === 'clear_queue');
    const rebuild = sent.slice(clearIndex + 1);
    expect(rebuild).toContainEqual({ type: 'steer', message: '先做这个' });
    expect(rebuild).toContainEqual({ type: 'steer', message: '做完后整理' });
    expect(rebuild).toContainEqual({ type: 'follow_up', message: '再跑一遍测试' });
    expect(result).toEqual({
      ok: true,
      steering: ['先做这个', '做完后整理'],
      followUp: ['再跑一遍测试'],
    });
  });

  it('promptSession stages attachments into the session workspace before prompting', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

    const ws = await mkdtemp(join(tmpdir(), 'ipc-ws-'));
    dirs.push(ws);
    const srcDir = await mkdtemp(join(tmpdir(), 'ipc-src-'));
    dirs.push(srcDir);
    const src = join(srcDir, 'report.txt');
    await writeFile(src, 'hello attachment');

    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { isStreaming: false, sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
    });
    (rt as any).chatSessions.get = () => ({ profileId: 'general', model: null, workspacePath: ws });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '请看附件', undefined, [{ path: src, name: 'report.txt' }]);

    const promptCmd = sent.find((c) => c.type === 'prompt');
    expect(promptCmd).toBeDefined();
    expect(promptCmd.message).toContain('.sparkii-attachments/report.txt');
    expect(promptCmd.message.endsWith('请看附件')).toBe(true);
    expect(await readFile(join(ws, '.sparkii-attachments', 'report.txt'), 'utf8')).toBe('hello attachment');
  });

  it('promptSession sends images directly and stages only non-image attachments', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

    const ws = await mkdtemp(join(tmpdir(), 'ipc-ws-'));
    dirs.push(ws);
    const srcDir = await mkdtemp(join(tmpdir(), 'ipc-src-'));
    dirs.push(srcDir);
    const img = join(srcDir, 'pixel.png');
    const raw = Buffer.from('fake-png-bytes');
    await writeFile(img, raw);
    const doc = join(srcDir, 'notes.txt');
    await writeFile(doc, 'doc bytes');
    const svg = join(srcDir, 'logo.svg');
    await writeFile(svg, '<svg></svg>');

    const electron = (await import('electron')) as unknown as {
      nativeImage: { createFromPath: ReturnType<typeof vi.fn> };
    };
    electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => true });

    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { isStreaming: false, sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
    });
    (rt as any).chatSessions.get = () => ({ profileId: 'general', model: null, workspacePath: ws });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, 's1', '看图', undefined, [
      { path: img, name: 'pixel.png', type: 'image/png' },
      { path: doc, name: 'notes.txt', type: 'text/plain' },
      { path: svg, name: 'logo.svg', type: 'image/svg+xml' },
    ]);

    const promptCmd = sent.find((c) => c.type === 'prompt');
    expect(promptCmd).toBeDefined();
    expect(promptCmd.images).toEqual([
      { type: 'image', mimeType: 'image/png', data: raw.toString('base64') },
    ]);
    expect(promptCmd.message).toContain('.sparkii-attachments/notes.txt');
    expect(promptCmd.message).toContain('.sparkii-attachments/logo.svg');
    expect(promptCmd.message.endsWith('看图')).toBe(true);
    expect(await readFile(join(ws, '.sparkii-attachments', 'notes.txt'), 'utf8')).toBe('doc bytes');
    expect(await readFile(join(ws, '.sparkii-attachments', 'logo.svg'), 'utf8')).toBe('<svg></svg>');
    expect(existsSync(join(ws, '.sparkii-attachments', 'pixel.png'))).toBe(false);
  });

  it('promptSession creates a session and stages attachments into the chosen workspace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

    const ws = await mkdtemp(join(tmpdir(), 'ipc-ws-'));
    dirs.push(ws);
    const srcDir = await mkdtemp(join(tmpdir(), 'ipc-src-'));
    dirs.push(srcDir);
    const src = join(srcDir, 'draft.txt');
    await writeFile(src, 'draft bytes');

    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, null, '看附件', undefined, [{ path: src, name: 'draft.txt' }], { profileId: 'general', workspacePath: ws });

    const promptCmd = sent.find((c) => c.type === 'prompt');
    expect(promptCmd.message).toContain('.sparkii-attachments/draft.txt');
    expect(promptCmd.message.endsWith('看附件')).toBe(true);
    expect(await readFile(join(ws, '.sparkii-attachments', 'draft.txt'), 'utf8')).toBe('draft bytes');
  });

  it('promptSession registers the proposal broker when creating a session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

    const onProposal = vi.fn();
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as any).pool.acquire = vi.fn(async () => ({ client, supervisor: { onProposal } }));
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await promptSession!(null, null, '看文件', undefined, undefined, { profileId: 'general' });

    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(onProposal).toHaveBeenCalledWith(expect.any(Function));
  });

  it('getModelOptions without agentId uses generic chat requirements instead of a default agent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const client = {
      send: async () => ({ success: true, data: [] }),
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      agentOf: (id: string) => {
        throw new Error(`unknown agent ${id}`);
      },
    });

    const handlers = await registeredHandlers();
    const getModelOptions = handlers.get('sparkii:getModelOptions');
    const result = await getModelOptions!(null);

    expect(result).toMatchObject({ modelRequirements: { requires: ['chat'] } });
  });

  it('promptSession refuses to create a session without profileId', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    await expect(promptSession!(null, null, 'hello')).rejects.toThrow(/profileId/);
    expect(rt.pool.acquire).not.toHaveBeenCalled();
    expect((rt as any).chatSessions.create).not.toHaveBeenCalled();
  });

  it('ensureSessionRecord does not invent profileId general when pinning a Pi-only session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    vi.mocked(listPiSessions).mockResolvedValueOnce([
      {
        id: 's-orphan',
        path: '/tmp/sessions/s-orphan.jsonl',
        cwd: 'C:/ws/orphan',
        name: '孤儿会话',
        created: new Date('2026-09-03T00:00:00.000Z'),
        modified: new Date('2026-09-03T00:00:00.000Z'),
        messageCount: 1,
        firstMessage: 'hi',
      },
    ]);

    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as any).chatSessions.get = () => null;
    const create = vi.fn();
    (rt as any).chatSessions.create = create;

    const handlers = await registeredHandlers();
    const setSessionPinned = handlers.get('sparkii:setSessionPinned');
    await setSessionPinned!(null, 's-orphan', true);

    expect(create).not.toHaveBeenCalled();
  });
});
