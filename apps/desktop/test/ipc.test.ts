import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '../electron/main/keyring.js';
import { registerIpc } from '../electron/main/ipc.js';
import { selectModel } from '../electron/main/workflow.js';
import type { Runtime } from '../electron/main/runtime.js';

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

let dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllGlobals();
});

async function makeRuntime(opts: {
  dataDir: string;
  piAgentDir: string;
  client: { send: (command: any) => Promise<any>; onEvent?: (cb: (event: any) => void) => () => void };
  setKey?: (providerId: string, key: string) => Promise<void>;
  chatSession?: { profileId: string; model: string | null; piSessionFile?: string | null };
  profile?: unknown;
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
    keyFor: async () => null,
    setKey: opts.setKey ?? (async () => {}),
  } as unknown as Runtime;
  registerIpc(rt, () => null, { export: async () => '' } as any);
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
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
    });

    const handlers = await registeredHandlers();
    const promptSession = handlers.get('sparkii:promptSession');
    expect(promptSession).toBeTypeOf('function');
    await promptSession!(null, 's1', '你好');

    expect(sent).toContainEqual({ type: 'set_model', provider: 'zai', modelId: 'glm-5' });
  });

  it('newChatSession returns a session id and pipes runtime events', async () => {
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
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const newChatSession = handlers.get('sparkii:newChatSession');
    const result = await newChatSession!(null, 'general');

    expect(result).toMatchObject({ sessionId: 's-new' });
    expect(client.onEvent).toHaveBeenCalled();
  });

  it('newChatSession creates the Pi session with the app model and thinking level', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash', defaultThinkingLevel: 'off' }),
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
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const newChatSession = handlers.get('sparkii:newChatSession');
    await newChatSession!(null, 'general');

    expect(rt.pool.acquire).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        saddle: expect.objectContaining({
          model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
          thinkingLevel: 'off',
        }),
      }),
    );
    expect(sent).toContainEqual({ type: 'new_session' });
    expect(sent).not.toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-flash' });
  });

  it('newChatSession rejects when the runtime pool has reached maxAgents', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ maxAgents: 4 }), 'utf8');

    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt.pool as unknown as { activeCount: () => number }).activeCount = () => 4;

    const handlers = await registeredHandlers();
    const newChatSession = handlers.get('sparkii:newChatSession');
    await expect(newChatSession!(null, 'general')).rejects.toThrow('已达到最大并发会话数 4');
  });

  it('listChatSessions includes empty sessions from the local store', async () => {
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
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'empty-1', profileId: 'general' }),
    ]));
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

    const setChatModel = handlers.get('sparkii:setChatModel');
    await setChatModel!(null, 's1', 'deepseek-v4-pro');

    expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
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
});
