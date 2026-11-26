import { describe, it, expect, vi, afterEach } from 'vitest';
import { dialog } from 'electron';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listPiSessions } from '@sparkii/agent-host';
import {
  ApprovalGate,
  AuditStore,
  TaskGrantRegistry,
  CapabilityGateway,
  ConnectorExecutor,
  type Proposal,
  type SecurityAction,
  type TaskGrant,
} from '@sparkii/approval';
import { Rbac } from '@sparkii/identity';
import { Keyring } from '../electron/main/keyring.js';
import { registerIpc } from '../electron/main/ipc.js';
import { buildAgentSaddle } from '../electron/main/saddle.js';
import { listUserSkills } from '../electron/main/skill-library.js';
import { resetGrantedDocumentPaths } from '../electron/main/document-bytes.js';
import { selectModel } from '../electron/main/workflow.js';
import { TaskLifecycle } from '../electron/main/security/task-lifecycle.js';
import { ShellGrantStore } from '../electron/main/security/shell-grant-store.js';
import { ExtractionScheduler } from '../electron/main/memory/index.js';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createActionNormalizer,
} from '../electron/main/security/action-normalizer.js';
import type { Runtime } from '../electron/main/runtime.js';
import { downloadDocumentParseModule } from '../electron/main/document-parse-modules.js';

vi.mock('@sparkii/agent-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sparkii/agent-host')>();
  return {
    ...actual,
    listPiSessions: vi.fn(actual.listPiSessions),
  };
});

vi.mock('electron', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    getHandlers: () => handlers,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    app: {
      getPath: (name: string) => (name === 'documents' ? join(tmpdir(), 'sparkii-test-documents') : ''),
      on: () => {},
      once: () => {},
      quit: () => {},
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    shell: {
      openPath: vi.fn(async () => ''),
    },
    nativeImage: {
      createFromPath: vi.fn(),
    },
  };
});

const { supervisorMocks, executeDocumentReadMock, loadSettingsMock, loadSettingsControl } = vi.hoisted(() => ({
  supervisorMocks: {
    failSession: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({ status: 'stopped' as const, waiting: [] })),
    stopCurrent: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    beginQuit: vi.fn(async () => {}),
    setIdleMinutes: vi.fn(),
    setKeepResident: vi.fn(),
    clearCircuit: vi.fn(),
    setErrorReporter: vi.fn(),
  },
  executeDocumentReadMock: vi.fn(async () => ({ ok: true, data: { text: 'x', engine: 'native' } })),
  loadSettingsMock: vi.fn(),
  loadSettingsControl: { original: undefined as undefined | ((dataDir: string) => Promise<unknown>) },
}));

vi.mock('../electron/main/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/main/settings.js')>();
  loadSettingsControl.original = actual.loadSettings;
  loadSettingsMock.mockImplementation(actual.loadSettings);
  return { ...actual, loadSettings: loadSettingsMock };
});

vi.mock('../electron/main/document-parse-supervisor.js', () => ({
  getDocumentParseSupervisor: () => ({
    failSession: supervisorMocks.failSession,
    subscribe: supervisorMocks.subscribe,
    snapshot: supervisorMocks.snapshot,
    stopCurrent: supervisorMocks.stopCurrent,
    release: supervisorMocks.release,
    beginQuit: supervisorMocks.beginQuit,
    setIdleMinutes: supervisorMocks.setIdleMinutes,
    setKeepResident: supervisorMocks.setKeepResident,
    clearCircuit: supervisorMocks.clearCircuit,
    setErrorReporter: supervisorMocks.setErrorReporter,
  }),
}));

vi.mock('../electron/main/document-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/main/document-read.js')>();
  return {
    ...actual,
    executeDocumentRead: executeDocumentReadMock,
  };
});

const randomUUIDControl = vi.hoisted(() => {
  const crypto = process.getBuiltinModule('node:crypto');
  const module = process.getBuiltinModule('node:module');
  const original = crypto.randomUUID;
  let implementation = original;
  crypto.randomUUID = ((...args: Parameters<typeof original>) => implementation(...args)) as typeof original;
  module.syncBuiltinESMExports();
  return {
    set(value: string): void {
      implementation = () => value;
      module.syncBuiltinESMExports();
    },
    setSequence(values: string[]): void {
      let index = 0;
      implementation = () => values[Math.min(index++, values.length - 1)];
      module.syncBuiltinESMExports();
    },
    restore(): void {
      implementation = original;
      crypto.randomUUID = original;
      module.syncBuiltinESMExports();
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

/** In-memory Pi transport handle used by runtime IPC regressions; no child process is started. */
class FakeHandle {
  private listeners = new Set<(event: any) => void>();
  readonly send = vi.fn(async (_command: any): Promise<any> => ({ success: true }));

  constructor(send?: (command: any) => Promise<any>) {
    if (send) this.send.mockImplementation(send);
  }

  onEvent(callback: (event: any) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  emit(event: any): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

let dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  randomUUIDControl.restore();
  vi.mocked(dialog.showSaveDialog).mockReset();
  resetGrantedDocumentPaths();
  loadSettingsMock.mockReset();
  loadSettingsMock.mockImplementation(loadSettingsControl.original!);
  supervisorMocks.failSession.mockReset();
  supervisorMocks.failSession.mockResolvedValue(undefined);
  supervisorMocks.setIdleMinutes.mockReset();
  supervisorMocks.setKeepResident.mockReset();
  supervisorMocks.clearCircuit.mockReset();
  supervisorMocks.setErrorReporter.mockReset();
  executeDocumentReadMock.mockReset();
  executeDocumentReadMock.mockResolvedValue({ ok: true, data: { text: 'x', engine: 'native' } });
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
  await rm(join(tmpdir(), 'sparkii-test-documents'), { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function makeRuntime(opts: {
  dataDir: string;
  piAgentDir: string;
  client: {
    send: (command: any) => Promise<any>;
    onEvent?: (cb: (event: any) => void) => () => void;
    origin?: string;
    sessionGeneration?: () => number;
  };
  setKey?: (providerId: string, key: string) => Promise<void>;
  keyFor?: (providerId: string) => Promise<string | null>;
  knowledgeToken?: (backend: string) => Promise<string | null>;
  setKnowledgeToken?: (backend: string, token: string) => Promise<void>;
  chatSession?: { profileId: string; model: string | null; piSessionFile?: string | null; kind?: string };
  profile?: unknown;
  agentOf?: (id: string) => unknown;
  agents?: Map<string, unknown>;
  audit?: { append: (ev: unknown) => Promise<unknown>; query?: (filter: object) => Promise<unknown[]> };
  errors?: { append: (rec: unknown) => unknown };
  getWindow?: () => { webContents: { send: (...args: unknown[]) => void } } | null;
  /** 测试用：收集 ipc 订上的 `supervisor.onExit` 回调，用来模拟子进程退出。 */
  exitCbs?: Array<(code: number | null) => void>;
  logger?: { export: () => Promise<string>; log: (entry: unknown) => Promise<void> };
  security?: unknown;
  gate?: unknown;
  executor?: unknown;
  memory?: unknown;
  register?: typeof registerIpc;
}): Promise<Runtime> {
  // 一根进程一根管子：牌子（活 sessionId）由池子持有，acquire/release/rename 改它。
  let boundSessionId: string | null = null;
  let bindingLease = 0;
  let sessionGeneration = 0;
  let latestOriginToken: string | undefined;
  const originalSend = opts.client.send;
  opts.client.send = vi.fn(async (command: any) => {
    if (typeof command.originToken === 'string') latestOriginToken = command.originToken;
    return originalSend(command);
  });
  Object.assign(opts.client, {
    origin: opts.client.origin ?? `test-client-${Math.random().toString(36).slice(2)}`,
    sessionGeneration: () => sessionGeneration,
  });
  const requestContext = (cb: (req: any, context: unknown) => unknown) =>
    (req: any, originToken?: string) => cb(req, {
      client: opts.client,
      sessionGeneration,
      originToken: originToken ?? latestOriginToken,
    });
  const slot = {
    client: opts.client,
    get lease() { return bindingLease; },
    supervisor: {
      onProposal: (cb: (req: any, context: unknown) => Promise<unknown>) => {
        (rt as unknown as { __onProposal?: (req: any, originToken?: string) => Promise<unknown> }).__onProposal = requestContext(cb);
      },
      onConnectorRead: (cb: (req: unknown, context: unknown) => Promise<unknown>) => {
        (rt as unknown as { __onConnectorRead?: (req: unknown, originToken?: string) => Promise<unknown> }).__onConnectorRead = requestContext(cb);
      },
      onAction: (cb: (req: unknown, context: unknown) => Promise<unknown>) => {
        (rt as unknown as { __onAction?: (req: unknown, originToken?: string) => Promise<unknown> }).__onAction = requestContext(cb);
        return () => {};
      },
      onExit: (cb: (code: number | null) => void) => {
        opts.exitCbs?.push(cb);
        return () => {
          const index = opts.exitCbs?.indexOf(cb) ?? -1;
          if (index >= 0) opts.exitCbs?.splice(index, 1);
        };
      },
    },
    getSessionId: () => boundSessionId,
  };
  // 与生产 `createKnowledgeSecretStore` 对齐：`sparkiirag` 的知识凭据就是 `keyFor('sparkiirag')`。
  const keyFor = opts.keyFor ?? (async () => null);
    const rt: any = {
    profiles: new Map(),
    gate: opts.gate ?? {},
    executor: opts.executor ?? {},
    agents: opts.agents ?? new Map(),
    audit: opts.audit ?? { append: vi.fn(async (ev) => ev), query: vi.fn(async () => []) },
    errors: opts.errors ?? { append: vi.fn() },
    pool: {
      acquire: vi.fn(async (sessionId: string, acquireOpts?: { meta?: { internal?: boolean } }) => {
        // 内部探测在真实池子里占的是另一个槽位，不动这条会话的牌子。
        if (!acquireOpts?.meta?.internal) {
          boundSessionId = sessionId;
          bindingLease += 1;
        }
        return { ...slot, lease: bindingLease };
      }),
      release: vi.fn(async (sessionId: string, expectedLease?: number) => {
        if (boundSessionId === sessionId && (expectedLease === undefined || expectedLease === bindingLease)) {
          boundSessionId = null;
        }
      }),
      renameSession: vi.fn((from: string, to: string) => {
        if (boundSessionId === from) boundSessionId = to;
      }),
      activeCount: vi.fn(() => 0),
      get: () => opts.client,
      getBinding: (sessionId: string) => boundSessionId === sessionId
        ? { client: opts.client, lease: bindingLease }
        : undefined,
      broadcast: vi.fn(async () => {}),
      snapshot: vi.fn(() => ({ maxAgents: 4, active: 0, queued: 0, slots: [], queue: [] })),
      subscribe: vi.fn(() => () => {}),
      cancelPending: vi.fn(() => true),
      cancelAcquire: vi.fn(() => true),
      waitForAcquire: vi.fn(async () => {}),
      setMaxAgents: vi.fn(),
      updateMeta: vi.fn(() => true),
    },
    subject: { userId: 'tester', roles: ['admin'] },
    security: opts.security,
    memory: opts.memory,
    chatSessions: { get: () => opts.chatSession ?? null, rawPiSessionFile: () => opts.chatSession?.piSessionFile ?? undefined, list: vi.fn(() => []), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
    keyFor,
    setKey: opts.setKey ?? (async () => {}),
    knowledgeToken: opts.knowledgeToken ?? (async (backend: string) => (backend === 'sparkiirag' ? keyFor('sparkiirag') : null)),
    setKnowledgeToken: opts.setKnowledgeToken ?? (async () => {}),
  } as unknown as Runtime;
  (opts.register ?? registerIpc)(
    rt,
    (opts.getWindow ?? (() => null)) as any,
    (opts.logger ?? { export: async () => '', log: vi.fn(async () => {}) }) as any,
  );
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

  it('getSettings reports hasApiKey without returning the secret', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>();
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
      setKey: async (id, key) => { keys.set(id, key); },
    });
    await rt.setKey('sparkiirag', 'rag-secret-please-hide');
    const handlers = await registeredHandlers();
    const s = await handlers.get('sparkii:getSettings')!(null) as { rag: { hasApiKey: boolean } };
    expect(JSON.stringify(s)).not.toContain('rag-secret-please-hide');
    expect(s.rag.hasApiKey).toBe(true);
  });

  it('getApiKey(sparkiirag) returns null even when keyring has the secret', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>([['sparkiirag', 'rag-secret-please-hide']]);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
    });
    const handlers = await registeredHandlers();
    expect(await handlers.get('sparkii:getApiKey')!(null, 'sparkiirag')).toBeNull();
  });

  it('getApiKey also hides sparkiionto and both knowledge keyring names', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>([
      ['deepseek', 'sk-ds'],
      ['sparkiirag', 'rag-secret-please-hide'],
      ['sparkiionto', 'onto-token-please-hide'],
      ['apiKey:sparkiirag', 'rag-secret-please-hide'],
      ['apiKey:sparkiionto', 'onto-token-please-hide'],
    ]);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
    });
    const handlers = await registeredHandlers();
    const getApiKey = handlers.get('sparkii:getApiKey')!;
    expect(await getApiKey(null, 'sparkiirag')).toBeNull();
    expect(await getApiKey(null, 'sparkiionto')).toBeNull();
    expect(await getApiKey(null, 'apiKey:sparkiirag')).toBeNull();
    expect(await getApiKey(null, 'apiKey:sparkiionto')).toBeNull();
    // 守卫只认知识后端的保留名，普通服务商的 key 照旧返回。
    expect(await getApiKey(null, 'deepseek')).toBe('sk-ds');
  });

  it('saveSettings rejects a custom provider whose id collides with a knowledge credential id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const ollama = { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' };
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ providers: [ollama] }), 'utf8');
    await makeRuntime({ dataDir, piAgentDir, client: { send: async () => ({ success: true }) } });
    const handlers = await registeredHandlers();
    const save = handlers.get('sparkii:saveSettings')!;

    for (const id of ['sparkiirag', 'sparkiionto', 'apiKey:sparkiirag']) {
      const rejected = await save(null, {
        activeProviderId: id,
        providers: [{ id, name: id, baseUrl: 'http://x', api: 'openai-completions' }],
        apiKey: 'sk-x',
      }) as { ok: boolean; error?: string };
      expect(rejected.ok, id).toBe(false);
      expect(rejected.error, id).toMatch(/保留名/);
      expect(rejected.error, id).toContain(id);
    }

    // 被拒的保存没有动过既有的自定义服务商。
    const afterReject = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    expect(afterReject.providers).toEqual([ollama]);

    // 不撞名的保存照旧成功，既有服务商原样保留。
    const ok = await save(null, { activeProviderId: 'ollama', providers: [ollama], apiKey: 'sk-ollama' }) as { ok: boolean };
    expect(ok.ok).toBe(true);
    const afterSave = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    expect(afterSave.providers).toEqual([ollama]);
  });

  it('testKnowledgeConnection probes healthz → info → datasets with the onto settings and token', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ sparkiionto: { baseUrl: 'http://onto.example:9380/', similarityThreshold: 0.3 } }),
      'utf8',
    );
    const calls: Array<{ path: string; auth?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (path === '/api/v1/system/healthz') {
        return new Response('{"status":"ok","product":"SparkiiOnto","version":"0.6.8"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/info') {
        return new Response(JSON.stringify({
          product: 'SparkiiOnto',
          version: '0.6.8',
          api_version: 'v1',
          deployment_profile: 'single-instance',
          retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
          capabilities: { datasets: true, document_fetch: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/datasets') {
        return new Response('{"code":0,"data":[{"id":"d264d494","name":"水泥工艺知识域"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      knowledgeToken: async (backend) => (backend === 'sparkiionto' ? 'tok-onto' : null),
    });

    const handlers = await registeredHandlers();
    const out = await handlers.get('sparkii:testKnowledgeConnection')!(null, 'sparkiionto') as {
      ok: boolean;
      baseUrl?: string;
      info?: { retrieval: { backend: string; semantic_embeddings: boolean } };
      datasets?: Array<{ id: string; name: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.baseUrl).toBe('http://onto.example:9380');
    expect(out.info?.retrieval).toEqual({ backend: 'sql-lexical', semantic_embeddings: false });
    expect(out.datasets).toEqual([{ id: 'd264d494', name: '水泥工艺知识域' }]);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/system/healthz', '/api/v1/info', '/api/v1/datasets']);
    expect(calls[1].auth).toBe('Bearer tok-onto');
    // 探活不读也不回传 RAG 的凭据。
    expect(JSON.stringify(out)).not.toContain('tok-onto');
  });

  it('testKnowledgeConnection honours an unsaved override', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response('{"status":"nok"}', { status: 503, headers: { 'content-type': 'application/json' } });
    }));
    await makeRuntime({ dataDir, piAgentDir, client: { send: async () => ({ success: true }) } });

    const handlers = await registeredHandlers();
    const out = await handlers.get('sparkii:testKnowledgeConnection')!(null, 'sparkiionto', {
      baseUrl: 'http://override.example:9380',
      apiKey: 'tok-override',
    }) as { ok: boolean; baseUrl?: string; error?: { reason: string } };
    expect(out.ok).toBe(false);
    expect(out.error?.reason).toBe('unhealthy');
    expect(urls[0]).toBe('http://override.example:9380/api/v1/system/healthz');
  });

  it('listKnowledgeDatasets tells 401 (credential) from 403 (permission) and flags an /info mismatch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ sparkiionto: { baseUrl: 'http://onto.example' } }), 'utf8');

    const serve = (info: Response | (() => Response), datasets?: Response) => vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/system/healthz') {
        return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/info') return typeof info === 'function' ? info() : info;
      if (path === '/api/v1/datasets' && datasets) return datasets;
      throw new Error(`unexpected request ${url}`);
    }));
    const ontoInfo = () => new Response(JSON.stringify({
      product: 'SparkiiOnto',
      version: '0.6.8',
      api_version: 'v1',
      deployment_profile: 'single-instance',
      retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
      capabilities: { datasets: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      knowledgeToken: async () => 'tok-onto',
    });
    const handlers = await registeredHandlers();
    const list = handlers.get('sparkii:listKnowledgeDatasets')!;

    serve(new Response('{"code":401,"message":"invalid or expired credential"}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const denied = await list(null, 'sparkiionto') as { ok: boolean; error: { code: string; message: string; reason: string } };
    expect(denied).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'unauthorized' } });
    expect(denied.error.message).toMatch(/凭据/);

    serve(ontoInfo, new Response('{"code":403,"message":"action denied"}', { status: 403, headers: { 'content-type': 'application/json' } }));
    const forbidden = await list(null, 'sparkiionto') as { ok: boolean; error: { code: string; message: string; reason: string } };
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED', reason: 'forbidden' } });
    expect(forbidden.error.message).toMatch(/权限/);
    expect(forbidden.error.message).not.toBe(denied.error.message);

    serve(() => new Response(JSON.stringify({ product: 'SparkiiRAG', api_version: 'v1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const mismatch = await list(null, 'sparkiionto') as { ok: boolean; error: { code: string; reason: string } };
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'CONNECTOR_UNSUPPORTED', reason: 'unsupported' } });

    const unknown = await list(null, 'bm25') as { ok: boolean; error: { reason: string } };
    expect(unknown).toMatchObject({ ok: false, error: { reason: 'invalid_config' } });
  });

  it('keeps testRagConnection as a thin sparkiirag wrapper', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/system/healthz') {
        return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/datasets') {
        return new Response('{"code":0,"data":[{"id":"law","name":"法规"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      knowledgeToken: async (backend) => (backend === 'sparkiirag' ? 'rag-tok' : null),
    });

    const handlers = await registeredHandlers();
    const ok = await handlers.get('sparkii:testRagConnection')!(null, null) as { ok: boolean; datasets?: Array<{ id: string; name: string }> };
    expect(ok).toEqual({ ok: true, datasets: [{ id: 'law', name: '法规' }] });
  });

  it('testRagConnection keeps the legacy "no key" wording', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({ dataDir, piAgentDir, client: { send: async () => ({ success: true }) } });

    const handlers = await registeredHandlers();
    const missing = await handlers.get('sparkii:testRagConnection')!(null, null) as { ok: boolean; error?: string };
    expect(missing).toEqual({ ok: false, error: '未配置 API Key' });
  });

  it('empty saveRagSettings apiKey keeps the keyring value', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>([['sparkiirag', 'keep-me']]);
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
      setKey: async (id, key) => { keys.set(id, key); },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:saveRagSettings')!(null, { baseUrl: 'http://127.0.0.1:9380', apiKey: '' });
    expect(await rt.keyFor('sparkiirag')).toBe('keep-me');
  });

  it('saveSettings does not wipe rag', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>();
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
      setKey: async (id, key) => { keys.set(id, key); },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:saveRagSettings')!(null, { baseUrl: 'http://rag.example' });
    await handlers.get('sparkii:saveSettings')!(null, { activeProviderId: 'deepseek', apiKey: 'sk-ds' });
    const s = await handlers.get('sparkii:getSettings')!(null) as { rag: { baseUrl: string } };
    expect(s.rag.baseUrl).toBe('http://rag.example');
  });

  it('saveSettings does not wipe documentParse', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const keys = new Map<string, string>();
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      keyFor: async (id) => keys.get(id) ?? null,
      setKey: async (id, key) => { keys.set(id, key); },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:saveDocumentParseSettings')!(null, { idleMinutes: 12, keepResident: true });
    await handlers.get('sparkii:saveSettings')!(null, {
      activeProviderId: 'deepseek',
      apiKey: 'sk-ds',
      documentParse: { idleMinutes: 1, keepResident: false },
    });
    const s = await handlers.get('sparkii:getSettings')!(null) as {
      documentParse: { idleMinutes: number; keepResident: boolean };
    };
    expect(s.documentParse.idleMinutes).toBe(12);
    expect(s.documentParse.keepResident).toBe(true);
    expect(supervisorMocks.setIdleMinutes).toHaveBeenCalledWith(12);
    expect(supervisorMocks.setKeepResident).toHaveBeenCalledWith(true);
    expect(supervisorMocks.clearCircuit).toHaveBeenCalled();
  });

  it('download huggingface URL is rejected', async () => {
    await expect(downloadDocumentParseModule('seal', {
      catalog: [{
        id: 'seal',
        label: '印章',
        url: 'https://huggingface.co/PaddlePaddle/foo/resolve/main/x.tar',
        sha256: 'ab'.repeat(32),
        minBytes: 1,
        target: 'optional/seal',
      }],
    })).rejects.toThrow('网络不可达，请改用导入离线包。');
  });

  it('promptSession refuses sparkiirag profiles when RAG is unconfigured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
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
      chatSession: { profileId: 'qa', model: null },
      profile: {
        dir: join(dataDir, 'profiles', 'qa'),
        profile: {
          manifest: { name: 'qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: [], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:promptSession')!(null, 's1', '你好');
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_DENIED' });
    expect(sent.some((c) => c.type === 'prompt')).toBe(false);
  });

  it('promptSession does not create a session when sparkiirag is unconfigured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const sent: any[] = [];
    const create = vi.fn();
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      profile: {
        dir: join(dataDir, 'profiles', 'qa'),
        profile: {
          manifest: { name: 'qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: [], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    (rt as any).chatSessions.create = create;
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:promptSession')!(null, null, '你好', undefined, undefined, { profileId: 'qa' });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_DENIED' });
    expect(create).not.toHaveBeenCalled();
    expect(sent.some((c) => c.type === 'prompt' || c.type === 'new_session')).toBe(false);
  });

  it('promptSession opens the session when allowDegradedKnowledge is set (product §15)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') return { success: true, data: { sessionId: 's-new', sessionFile: null } };
        return { success: true };
      },
    };
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380' },
    }), 'utf8');
    const fetchSpy = vi.fn(async () => { throw new Error('RAG preflight must be skipped in degraded mode'); });
    vi.stubGlobal('fetch', fetchSpy);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      knowledgeToken: async () => 'test-token',
      profile: {
        dir: join(dataDir, 'profiles', 'qa'),
        profile: {
          manifest: { name: 'qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: [], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:promptSession')!(
      null, null, '你好', undefined, undefined,
      { profileId: 'qa', allowDegradedKnowledge: true },
    );
    // Degraded mode skips the RAG preflight altogether — not just its failure:
    // a configured-but-unreachable backend must not add a 30s stall (perf).
    expect(result).not.toMatchObject({ code: 'CONNECTOR_DENIED' });
    expect(result.sessionId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('setSessionKnowledge stores selection and promptSession migrates draft key before prompt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380', bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'law' }] },
    }), 'utf8');
    let retrieveBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }, { id: 'hr', name: '制度' }] }),
        };
      }
      if (u.includes('/retrieval')) {
        retrieveBody = JSON.parse(String(init?.body ?? '{}'));
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            code: 0,
            data: { chunks: [{ id: 'c', content: 'x', document_id: 'd', document_keyword: 'f', dataset_id: 'law', similarity: 1 }], doc_aggs: [] },
          }),
        };
      }
      throw new Error(u);
    }));
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-real', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string }>();
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    const setResult = await handlers.get('sparkii:setSessionKnowledge')!(null, 'draft:knowledge-qa', { mode: 'all' });
    expect(setResult).toEqual({ ok: true });
    const result = await handlers.get('sparkii:promptSession')!(null, null, '你好', undefined, undefined, { profileId: 'knowledge-qa' });
    expect(result).toMatchObject({ ok: true, sessionId: 's-real' });
    const promptIndex = sent.findIndex((c) => c.type === 'prompt');
    expect(promptIndex).toBeGreaterThan(-1);
    const read = (rt as any).__onConnectorRead;
    const out = await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: 'q' } });
    expect(out?.ok).toBe(true);
    expect(retrieveBody?.dataset_ids).toEqual(['law', 'hr']);
  });

  it('empty retrieval returns first then aborts and appends refused knowledge_turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380' },
    }), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }] }),
        };
      }
      if (u.includes('/retrieval')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: { chunks: [], doc_aggs: [] } }),
        };
      }
      throw new Error(u);
    }));
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-empty', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string }>();
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, null, '你好', undefined, undefined, { profileId: 'knowledge-qa' });
    const read = (rt as any).__onConnectorRead;
    const out = await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: 'q' } });
    expect(out?.ok).toBe(true);
    expect(Array.isArray((out as { data?: { chunks?: unknown[] } })?.data?.chunks)).toBe(true);
    await waitUntil(() => sent.some((c) => c.type === 'abort'));
    const abortIdx = sent.findIndex((c) => c.type === 'abort');
    const refusedIdx = sent.findIndex((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn');
    expect(refusedIdx).toBeGreaterThanOrEqual(0);
    expect(refusedIdx).toBeLessThan(abortIdx);
    const refused = sent.find((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn');
    expect(refused?.data).toMatchObject({ refused: true, documents: [] });
  });

  it('does not copy leftover draft selection onto an existing session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380', bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'law' }] },
    }), 'utf8');
    let retrieveBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }, { id: 'hr', name: '制度' }] }),
        };
      }
      if (u.includes('/retrieval')) {
        retrieveBody = JSON.parse(String(init?.body ?? '{}'));
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            code: 0,
            data: { chunks: [{ id: 'c', content: 'x', document_id: 'd', document_keyword: 'f', dataset_id: 'law', similarity: 1 }], doc_aggs: [] },
          }),
        };
      }
      throw new Error(u);
    }));
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-real', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string; model: string | null }>([
      ['s-real', { id: 's-real', profileId: 'knowledge-qa', model: null }],
    ]);
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:setSessionKnowledge')!(null, 's-real', { mode: 'ids', datasetIds: ['law'] });
    await handlers.get('sparkii:setSessionKnowledge')!(null, 'draft:knowledge-qa', { mode: 'all' });
    const result = await handlers.get('sparkii:promptSession')!(null, 's-real', '你好', undefined, undefined, { profileId: 'knowledge-qa' });
    expect(result).toMatchObject({ ok: true, sessionId: 's-real' });
    const read = (rt as any).__onConnectorRead;
    const out = await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: 'q' } });
    expect(out?.ok).toBe(true);
    expect(retrieveBody?.dataset_ids).toEqual(['law']);
  });

  it('aborts when the session dataset is no longer visible', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380' },
    }), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }] }),
        };
      }
      throw new Error(u);
    }));
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-gone', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string }>();
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, null, '你好', undefined, undefined, { profileId: 'knowledge-qa' });
    await handlers.get('sparkii:setSessionKnowledge')!(null, 's-gone', { mode: 'ids', datasetIds: ['gone'] });
    const read = (rt as any).__onConnectorRead;
    const out = await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: 'q' } });
    expect(out?.ok).toBe(false);
    expect((out as { error?: { message?: string } })?.error?.message).toBe('所选知识库已不可见，请重新选择');
    await waitUntil(() => sent.some((c) => c.type === 'abort'));
    const refused = sent.find((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn');
    expect(refused?.data).toMatchObject({
      refused: true,
      text: '所选知识库已不可见，请重新选择',
      documents: [],
    });
  });

  it('empty search after a sealed hit aborts a new turn', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380' },
    }), 'utf8');
    let retrievals = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }] }),
        };
      }
      if (u.includes('/retrieval')) {
        retrievals += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => (retrievals === 1
            ? { code: 0, data: { chunks: [{ id: 'c', content: 'x', document_id: 'd', document_keyword: 'f', dataset_id: 'law', similarity: 1 }], doc_aggs: [] } }
            : { code: 0, data: { chunks: [], doc_aggs: [] } }),
        };
      }
      throw new Error(u);
    }));
    const sent: any[] = [];
    let emit: ((ev: any) => void) | undefined;
    const client = {
      onEvent: (cb: (ev: any) => void) => {
        emit = cb;
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-follow', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string }>();
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, null, '你好', undefined, undefined, { profileId: 'knowledge-qa' });
    const read = (rt as any).__onConnectorRead;
    const hit = await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: 'q1' } });
    expect(hit?.ok).toBe(true);
    emit?.({ type: 'message_end', message: { role: 'assistant', content: '根据办法' } });
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn')).toBe(false);
    emit?.({ type: 'agent_end' });
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn')).toBe(false);
    emit?.({ type: 'agent_settled' });
    await waitUntil(() => sent.some((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn' && c.data?.refused === false));
    const hitTurn = sent.find((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn' && c.data?.refused === false);
    expect(hitTurn?.data?.citations?.[0]).toMatchObject({ index: 1, documentId: 'd', documentName: 'f', datasetId: 'law' });
    const miss = await read?.({ requestId: 'r2', toolName: 'knowledge.search', args: { query: 'q2' } });
    expect(miss?.ok).toBe(true);
    await waitUntil(() => sent.some((c) => c.type === 'abort'));
    const refused = sent.filter((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn');
    expect(refused.at(-1)?.data).toMatchObject({ refused: true, documents: [] });
  });

  it('openRagDocument with an Onto backend still fetches through the ontology client cache segment', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      sparkiionto: { baseUrl: 'http://onto.example:9380' },
    }), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/info') {
        return new Response(JSON.stringify({
          product: 'SparkiiOnto', version: '0.6.8', api_version: 'v1', deployment_profile: 'single-instance',
          retrieval: { backend: 'sql-lexical', semantic_embeddings: false }, capabilities: { datasets: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/v1/datasets/d264d494/documents/doc-1') {
        return new Response(new Uint8Array([104, 105]), {
          status: 200, headers: { 'content-type': 'application/octet-stream' },
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { onEvent: vi.fn(() => () => {}), send: async () => ({ success: true }) },
      knowledgeToken: async (backend) => (backend === 'sparkiionto' ? 'tok-onto' : null),
    });
    const handlers = await registeredHandlers();

    const electron = await import('electron') as unknown as { shell: { openPath: ReturnType<typeof vi.fn> } };
    electron.shell.openPath.mockClear();
    const opened = await handlers.get('sparkii:openRagDocument')!(null, {
      backend: 'sparkiionto', datasetId: 'd264d494', documentId: 'doc-1', fileName: '水泥工艺.md',
    }) as { ok: boolean; path?: string };
    expect(opened.ok).toBe(true);
    const cachedPath = String(opened.path ?? '');
    expect(cachedPath.replace(/\\/g, '/')).toMatch(/\/rag-cache\/sparkiionto\/d264d494\/doc-1\.md$/);
    expect((await readFile(cachedPath)).toString()).toBe('hi');
    expect(electron.shell.openPath).toHaveBeenCalledTimes(1);
    expect(electron.shell.openPath).toHaveBeenCalledWith(cachedPath);
  });

  it('openRagDocument defaults to sparkiirag and returns a bounded error when the credential is missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({ dataDir, piAgentDir, client: { send: async () => ({ success: true }) } });
    const handlers = await registeredHandlers();
    const out = await handlers.get('sparkii:openRagDocument')!(null, {
      datasetId: 'law', documentId: 'd1',
    }) as { ok: boolean; error?: string };
    expect(out).toEqual({ ok: false, error: '未配置 API Key' });
  });

  it('setSessionKnowledge rejects invalid payload', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:setSessionKnowledge')!(null, 's1', { mode: 'nope' });
    expect(result).toMatchObject({ ok: false });
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
    expect(sent).toContainEqual({ type: 'prompt', message: 'hello', promptId: expect.any(String), originToken: expect.any(String) });
    expect(rt.pool.acquire).toHaveBeenCalled();
    expect((rt as any).chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKind: 'auto',
      workspacePath: expect.stringMatching(/Sparkii[\\/]+workspaces[\\/]+general[\\/]+[a-z]+-[a-z]+-[a-z2-9]{3}/i),
    }));
    const created = (rt as any).chatSessions.create.mock.calls[0][0] as { workspacePath: string };
    const documentsDir = join(tmpdir(), 'sparkii-test-documents');
    expect(created.workspacePath.startsWith(documentsDir)).toBe(true);
    expect(created.workspacePath.replace(/\\/g, '/')).toMatch(/sparkii-test-documents\/Sparkii\/workspaces\/general\/[a-z]+-[a-z]+-[a-z2-9]{3}$/);
    expect(existsSync(created.workspacePath)).toBe(false);
  });

  it('R7 reuses one open session for a follow-up after the first prompt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    let releaseAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => { releaseAcquire = resolve; });
    const client = { onEvent: () => () => {}, send: async () => ({ success: true, data: { sessionId: 's1', sessionFile: null } }) };
    const rt = await makeRuntime({
      dataDir, piAgentDir, client,
      chatSession: { profileId: 'contract-review', model: null },
    });
    const originalAcquire = rt.pool.acquire;
    rt.pool.acquire = vi.fn(async (...args: Parameters<typeof originalAcquire>) => {
      await acquireGate;
      return originalAcquire(...args);
    });
    const prompt = (await registeredHandlers()).get('sparkii:promptSession')!;
    const first = prompt(null, 's1', 'first');
    await waitUntil(() => vi.mocked(rt.pool.acquire).mock.calls.length > 0);
    releaseAcquire();
    await first;
    const second = prompt(null, 's1', 'second', { behavior: 'followUp' });
    await second;
    expect(rt.pool.acquire).toHaveBeenCalledTimes(1);
  });

  it('R7 promptSession rejects a stale binding while model key lookup is suspended', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    let resolveKey!: (key: string) => void;
    const keyGate = new Promise<string>((resolve) => { resolveKey = resolve; });
    const keyFor = vi.fn(async () => keyGate);
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        sent.push(command);
        return { success: true, data: { sessionId: 's1', sessionFile: null } };
      },
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir, client, keyFor,
      chatSession: { profileId: 'contract-review', model: 'deepseek-chat' },
    });
    const prompt = (await registeredHandlers()).get('sparkii:promptSession')!;
    const pending = prompt(null, 's1', 'stale model prompt');
    await waitUntil(() => keyFor.mock.calls.length > 0);
    const oldLease = rt.pool.getBinding('s1')!.lease;
    await rt.pool.release('s1', oldLease);
    await rt.pool.acquire('s1');
    const replacementLease = rt.pool.getBinding('s1')!.lease;
    resolveKey('sk-test');

    await expect(pending).rejects.toThrow('session s1 is no longer bound');
    expect(sent.some((command) => command.type === 'set_api_key' || command.type === 'set_model')).toBe(false);
    expect(sent.some((command) => command.type === 'prompt')).toBe(false);
    expect(rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
  });

  it('R7 promptSession rejects a stale binding after deferred get_state before sending', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    let resolveState!: () => void;
    const stateGate = new Promise<void>((resolve) => { resolveState = resolve; });
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') await stateGate;
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      },
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir, client,
      chatSession: { profileId: 'contract-review', model: null },
    });
    const prompt = (await registeredHandlers()).get('sparkii:promptSession')!;
    const pending = prompt(null, 's1', 'stale prompt');
    await waitUntil(() => sent.some((command) => command.type === 'get_state'));
    const oldLease = rt.pool.getBinding('s1')!.lease;
    await rt.pool.release('s1', oldLease);
    await rt.pool.acquire('s1');
    const replacementLease = rt.pool.getBinding('s1')!.lease;
    resolveState();

    await expect(pending).rejects.toThrow('session s1 is no longer bound');
    expect(sent.some((command) => command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up')).toBe(false);
    expect(rt.chatSessions.update).not.toHaveBeenCalled();
    expect(rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
  });

  it('R7 stale task admission cannot replace a same-id replacement grant', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const workspacePath = join(dataDir, 'workspace');
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let admissions = 0;
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: async (target: string) => {
        admissions += 1;
        if (admissions === 1) await admissionGate;
        return {
          displayPath: target, canonicalPath: target, identity: `object:${key(target)}`,
          nearestExistingAncestor: target, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
        };
      },
      isSameOrDescendant: async (root: string, target: string) => key(target) === key(root) || key(target).startsWith(`${key(root)}/`),
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const registry = new TaskGrantRegistry();
    const taskLifecycle = new TaskLifecycle(registry);
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        sent.push(command);
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      },
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir, client,
      chatSession: { profileId: 'general', model: null },
      security: {
        profilePolicies: new Map([['general', { defaultPermissionMode: 'ask', allowedPermissionModes: ['ask'] }]]),
        taskLifecycle, taskGrants: registry, pathProbe, protectedRoots: [], scratchParent: join(dataDir, 'scratch'),
        hostShell: { terminate: vi.fn(async () => {}) },
        reviewer: { cancel: vi.fn(async () => {}) },
        capabilityGateway: { revokeTask: vi.fn() },
        shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
        hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      },
    });
    (rt.chatSessions as any).get = () => ({
      id: 's1', profileId: 'general', workspaceKind: 'auto', workspacePath,
      model: null, thinkingLevel: null, piSessionFile: null, permissionMode: 'ask', inputs: [],
    });
    const prompt = (await registeredHandlers()).get('sparkii:promptSession')!;
    const stale = prompt(null, 's1', 'stale admission prompt');
    const staleRejection = expect(stale).rejects.toThrow('session s1 is no longer bound');
    await waitUntil(() => admissions === 1);
    const oldLease = rt.pool.getBinding('s1')!.lease;
    await rt.pool.release('s1', oldLease);
    releaseAdmission();

    await expect(prompt(null, 's1', 'replacement prompt')).resolves.toMatchObject({ ok: true });
    const replacementLease = rt.pool.getBinding('s1')!.lease;
    const replacementTaskId = taskLifecycle.active('s1')?.taskId;
    expect(replacementTaskId).toBeTruthy();

    await staleRejection;
    expect(taskLifecycle.active('s1')?.taskId).toBe(replacementTaskId);
    expect(sent.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual(['replacement prompt']);
    expect(rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
  });

  it('R7 session creation failure cannot release or delete a same-id replacement', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ defaultModel: 'deepseek-chat' }), 'utf8');
    let resolveKey!: (key: string) => void;
    const keyGate = new Promise<string>((resolve) => { resolveKey = resolve; });
    const client = {
      onEvent: () => () => {},
      send: async (command: any) => {
        if (command.type === 'get_state') return { success: true, data: { sessionId: 'created-race', sessionFile: null } };
        if (command.type === 'set_api_key') return { success: false, error: 'injected key failure' };
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client, keyFor: async () => keyGate });
    const handlers = await registeredHandlers();
    const creating = handlers.get('sparkii:createSession')!(null, { profileId: 'general' });
    await waitUntil(() => Boolean(rt.pool.getBinding('created-race')));
    const oldLease = rt.pool.getBinding('created-race')!.lease;
    await rt.pool.release('created-race', oldLease);
    await rt.pool.acquire('created-race');
    const replacementLease = rt.pool.getBinding('created-race')!.lease;
    resolveKey('sk-test');
    await expect(creating).rejects.toThrow('session created-race is no longer bound');
    expect(rt.pool.getBinding('created-race')?.lease).toBe(replacementLease);
    expect(rt.chatSessions.delete).not.toHaveBeenCalled();
    expect(rt.pool.release).not.toHaveBeenCalledWith('created-race', undefined);
  });

  it('createSession binds a workspace WITHOUT sending a prompt (P9, holds slot + 15s idle release)', async () => {
    vi.useFakeTimers();
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
          return { success: true, data: { sessionId: 's-bare', sessionFile: null } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    (rt as any).chatSessions.create = vi.fn();

    const handlers = await registeredHandlers();
    const createSession = handlers.get('sparkii:createSession');
    expect(createSession).toBeTypeOf('function');
    const result = await createSession!(null, { profileId: 'general' });

    expect(result).toMatchObject({ ok: true, sessionId: 's-bare' });
    // NO LLM turn: no prompt / startSessionTask command was dispatched.
    expect(sent.some((c) => c.type === 'prompt')).toBe(false);
    expect(sent.some((c) => c.type === 'steer' || c.type === 'follow_up')).toBe(false);
    // Session record was still created with a fixed workspace path.
    expect((rt as any).chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKind: 'auto',
      workspacePath: expect.any(String),
    }));
    // P9 折中策略：建会话不再立即解绑（避免 new_session 的迟到 settled 在首条
    // prompt 建立 Grant 后误撤销它）；槽位保持，由更激进的 15s idle 定时器回收。
    expect(rt.pool.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rt.pool.release).toHaveBeenCalledWith('s-bare', 1);
    vi.useRealTimers();
  });

  it('B1: a late agent_settled never revokes a Grant that is not this prompt\'s', async () => {
    vi.useFakeTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-b1-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(e: any) => void>();
    let liveGrant: { taskId: string; sessionId: string } | undefined;
    const ended: Array<{ sessionId: string; reason: string }> = [];
    const client = {
      onEvent: (cb: (e: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const security: Record<string, unknown> = {
      profilePolicies: new Map([['general', {
        defaultPermissionMode: 'ask',
        allowedPermissionModes: ['ask'],
      }]]),
      taskLifecycle: {
        start: vi.fn(async (_factory: () => Promise<any>, _beforeCommit?: () => void, onStarted?: (created: any) => void) => {
          liveGrant = { taskId: `task-${ended.length + 1}`, sessionId: 's1' };
          onStarted?.(liveGrant);
          return liveGrant;
        }),
        active: vi.fn(() => liveGrant),
        end: vi.fn(async (sessionId: string, reason: string) => {
          ended.push({ sessionId, reason });
          liveGrant = undefined;
        }),
        registerCancellation: vi.fn(() => () => {}),
      },
      capabilityGateway: { revokeTask: vi.fn() },
      shellGrants: { allows: () => false, revoke: vi.fn() },
      taskGrants: { onRevoke: vi.fn(() => () => {}) },
      reviewerModel: 'deepseek-v4-flash',
      reviewerPolicyVersion: 'shell-review-v1',
      hostShellReport: {
        backend: 'host-git-bash', status: 'available', executionBoundary: 'host',
        version: 'host-job-v1', limitations: [],
      },
      hostShell: { terminate: vi.fn(async () => {}) },
      reviewer: { cancel: vi.fn(async () => {}) },
    };
    const sessions = new Map<string, any>([['s1', {
      id: 's1', profileId: 'general', kind: 'chat', workspaceKind: 'auto',
      workspacePath: 'C:/ws', permissionMode: 'ask',
    }]]);
    const rt = await makeRuntime({
      dataDir, piAgentDir, client, security,
      chatSession: sessions.get('s1'),
    });
    (rt as any).chatSessions.get = (id: string) => sessions.get(id);
    const handlers = await registeredHandlers();

    // (1) Setup 阶段（尚未 arm 本轮 prompt）的迟到 settled：绝不 end 任何 Grant。
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(ended).toEqual([]);

    // (2) 本轮 prompt 投递成功 → arm 本轮 taskId。
    await handlers.get('sparkii:promptSession')!(null, 's1', '写技术方案', undefined, undefined, {
      profileId: 'general', allowDegradedKnowledge: true,
    });
    expect(liveGrant).toBeTruthy();
    expect(ended).toEqual([]);
    for (const cb of listeners) cb({ type: 'agent_start' });

    // (3) 模拟旧 new_session 的迟到 settled：活跃 Grant 已被下一轮 startSessionTask
    // 换成新 taskId，但 armed 仍是上一轮的 —— taskId 不一致，不得撤销新 Grant。
    const previousGrant = liveGrant!;
    liveGrant = { taskId: 'task-late-from-old-session', sessionId: 's1' };
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(ended).toEqual([]);
    expect(liveGrant?.taskId).toBe('task-late-from-old-session');

    // (4) 恢复本轮 Grant 后，真正属于本轮的 settled 才 end 一次。
    liveGrant = previousGrant;
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(ended).toEqual([{ sessionId: 's1', reason: 'session-ended' }]);

    // (5) 重复 settled 不再 end（归属已消费）。
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(ended).toHaveLength(1);
    vi.useRealTimers();
  });

  it('setChatWorkspace(null) allocates a new Documents auto path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    const store = {
      profileId: 'general',
      workspaceKind: 'user' as const,
      workspacePath: 'C:/old/user-ws',
    };
    const updates: Array<{ workspaceKind?: string; workspacePath?: string }> = [];
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) },
      agents,
    });
    (rt as any).chatSessions.get = () => store;
    (rt as any).chatSessions.update = (_id: string, patch: { workspaceKind?: string; workspacePath?: string }) => {
      Object.assign(store, patch);
      updates.push(patch);
    };
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:setChatWorkspace')!(null, 's1', null);
    expect(updates[0]?.workspaceKind).toBe('auto');
    const documentsDir = join(tmpdir(), 'sparkii-test-documents');
    expect(updates[0]?.workspacePath?.startsWith(documentsDir)).toBe(true);
    expect(updates[0]?.workspacePath?.replace(/\\/g, '/')).toMatch(/sparkii-test-documents\/Sparkii\/workspaces\/general\/[a-z]+-[a-z]+-[a-z2-9]{3}$/);
    expect(existsSync(updates[0]!.workspacePath!)).toBe(false);
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
    expect(sent).toContainEqual({ type: 'prompt', message: 'hello', promptId: expect.any(String), originToken: expect.any(String) });
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

  it('listChatSessions includes DB-only P9 sessions when includeEmpty is true', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const client = { send: async () => ({ success: true }) };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    const emptySession = {
      id: 'p9-empty-1',
      profileId: 'bid-writing',
      workspaceKind: 'auto' as const,
      workspacePath: 'C:/ws/p9-empty',
      model: null,
      thinkingLevel: null,
      piSessionFile: null,
      createdAt: 123,
      updatedAt: 456,
    };
    (rt.chatSessions as unknown as { list: (profileId?: string) => unknown[] }).list = () => [emptySession];

    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:listChatSessions')!(
      null, 'bid-writing', { includeEmpty: true },
    ) as Array<{ id: string; profileId?: string; firstMessage: string; updatedAt: number; title?: string }>;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'p9-empty-1',
      profileId: 'bid-writing',
      firstMessage: '(no messages)',
      updatedAt: 456,
    });
    expect(result[0].title).toBeUndefined();
    expect(result[0].workspacePath).toBe('C:/ws/p9-empty');
  });

  it('listChatSessions falls back to project.json.name through the fenced service', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    const workspace = join(dataDir, 'ws-project');
    await mkdir(piAgentDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: '智慧园区投标文件' }), 'utf8');

    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: async (t: string) => ({
        displayPath: t, canonicalPath: t, identity: `object:${key(t)}`,
        nearestExistingAncestor: t, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      }),
      isSameOrDescendant: async (root: string, t: string) => key(t) === key(root) || key(t).startsWith(`${key(root)}/`),
      isSameObject: async (a: string, b: string) => key(a) === key(b),
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir,
      client: { send: async () => ({ success: true }) },
      security: {
        profilePolicies: new Map(), taskGrants: { onRevoke: () => () => {} },
        hostShellReport: { version: 'v1', status: 'available', backend: 'host', executionBoundary: 'host', limitations: [] },
        taskLifecycle: { active: vi.fn(() => undefined), end: vi.fn(async () => {}) },
        pathProbe, protectedRoots: [],
      },
      audit: { append: vi.fn(async (e) => e) },
    });
    const emptySession = {
      id: 'p9-named', profileId: 'bid-writing', workspaceKind: 'auto' as const,
      workspacePath: workspace, model: null, thinkingLevel: null, piSessionFile: null,
      createdAt: 123, updatedAt: 456,
    };
    (rt.chatSessions as unknown as { list: (profileId?: string) => unknown[] }).list = () => [emptySession];
    (rt.chatSessions as unknown as { get: (id: string) => unknown }).get = (id: string) => id === emptySession.id ? emptySession : null;

    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:listChatSessions')!(
      null, 'bid-writing', { includeEmpty: true },
    ) as Array<{ title?: string; workspacePath?: string }>;
    expect(result[0]).toMatchObject({ title: '智慧园区投标文件', workspacePath: workspace });
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
    expect(rt.pool.release).toHaveBeenCalledWith('s1', 1);
    vi.useRealTimers();
  });

  it('does not idle-release a knowledge session on agent_end before agent_settled', async () => {
    vi.useFakeTimers();
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      rag: { baseUrl: 'http://127.0.0.1:9380' },
    }), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/datasets') && !u.includes('/documents')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 0, data: [{ id: 'law', name: '法规' }] }),
        };
      }
      if (u.includes('/retrieval')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            code: 0,
            data: {
              chunks: [{ id: 'c', content: 'x', document_id: 'd', document_keyword: 'f', dataset_id: 'law', similarity: 1 }],
              doc_aggs: [],
            },
          }),
        };
      }
      throw new Error(u);
    }));
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
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      keyFor: async (id) => (id === 'sparkiirag' ? 'rag-key' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'knowledge-qa'),
        profile: {
          manifest: { name: 'knowledge-qa', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
          agent: { tools: ['knowledge.search'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const sessions = new Map<string, { id: string; profileId: string }>();
    (rt as any).chatSessions.create = (rec: { id: string; profileId: string }) => { sessions.set(rec.id, rec); };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, null, '津贴怎么发', undefined, undefined, { profileId: 'knowledge-qa' });
    const read = (rt as any).__onConnectorRead;
    await read?.({ requestId: 'r1', toolName: 'knowledge.search', args: { query: '津贴' } });
    events[0]?.({ type: 'agent_end' });
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rt.pool.release).not.toHaveBeenCalled();
    events[0]?.({ type: 'agent_settled' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'append_workflow_entry' && c.customType === 'knowledge_turn')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rt.pool.release).toHaveBeenCalledWith('s1', 1);
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

  it('rejects a transient prompt waiter after its slot is rebound instead of forwarding the new session event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    let promptSent = false;
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'prompt') promptSent = true;
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { windowSent.push(args); } } }) as any,
    });
    rt.profiles.set('general', rt.profileOf('general'));
    const handlers = await registeredHandlers();
    const pending = handlers.get('sparkii:prompt')!(null, '旧提示词');
    const settled = pending.then(() => null, (error: unknown) => error);
    for (let i = 0; i < 100 && !promptSent; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptSent).toBe(true);
    const rebound = await rt.pool.acquire('B');
    expect(rebound.getSessionId()).toBe('B');
    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'agent_end' });

    expect(await settled).toMatchObject({ message: expect.stringMatching(/no longer bound/i) });
    expect(windowSent).toEqual([]);
    expect(rebound.getSessionId()).toBe('B');
  });

  it('R7 rejects a transient prompt waiter after same-id release and reacquire without forwarding the new binding event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    let promptSent = false;
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'prompt') promptSent = true;
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { windowSent.push(args); } } }) as any,
    });
    rt.profiles.set('general', rt.profileOf('general'));
    const handlers = await registeredHandlers();
    const pending = handlers.get('sparkii:prompt')!(null, '旧提示词');
    const settled = pending.then(() => null, (error: unknown) => error);
    for (let i = 0; i < 100 && !promptSent; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptSent).toBe(true);
    const sessionId = vi.mocked(rt.pool.acquire).mock.calls[0][0] as string;
    const oldLease = rt.pool.getBinding(sessionId)?.lease;
    expect(oldLease).toBeTypeOf('number');
    await rt.pool.release(sessionId);
    const rebound = await rt.pool.acquire(sessionId);
    expect(rebound.getSessionId()).toBe(sessionId);
    expect(rt.pool.getBinding(sessionId)?.lease).not.toBe(oldLease);
    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'agent_end' });

    expect(await settled).toMatchObject({ message: expect.stringMatching(/no longer bound/i) });
    expect(windowSent).toEqual([]);
    expect(rt.pool.getBinding(sessionId)?.lease).not.toBe(oldLease);
    expect(rt.pool.release).toHaveBeenLastCalledWith(sessionId, oldLease);
  });

  it('R7 rejects a transient prompt when a successful send completes after same-id rebinding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    let promptSent = false;
    let resolvePrompt!: (response: any) => void;
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type !== 'prompt') return { success: true };
        promptSent = true;
        return new Promise((resolve) => { resolvePrompt = resolve; });
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { windowSent.push(args); } } }) as any,
    });
    rt.profiles.set('general', rt.profileOf('general'));
    const handlers = await registeredHandlers();
    const pending = handlers.get('sparkii:prompt')!(null, '旧提示词');
    const settled = pending.then(() => null, (error: unknown) => error);
    for (let i = 0; i < 100 && !promptSent; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptSent).toBe(true);
    const sessionId = vi.mocked(rt.pool.acquire).mock.calls[0][0] as string;
    const oldLease = rt.pool.getBinding(sessionId)?.lease;
    await rt.pool.release(sessionId);
    await rt.pool.acquire(sessionId);
    windowSent.length = 0;
    resolvePrompt({ success: true });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    for (const cb of listeners) cb({ type: 'agent_end' });

    expect(await settled).toMatchObject({ message: expect.stringMatching(/no longer bound/i) });
    expect(windowSent).toEqual([]);
    expect(rt.pool.getBinding(sessionId)?.lease).not.toBe(oldLease);
    expect(rt.pool.release).toHaveBeenLastCalledWith(sessionId, oldLease);
  });

  it('R7 cancels every same-id transient waiter without old completion erasing the replacement', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    const listeners = new Set<(event: any) => void>();
    const promptResolvers: Array<(response: any) => void> = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'R7-OVERLAP-SESSION', sessionFile: null } };
        }
        if (command.type !== 'prompt') return { success: true };
        return new Promise((resolve) => { promptResolvers.push(resolve); });
      },
    };
    const rt = await makeRuntime({ dataDir, piAgentDir, client });
    rt.profiles.set('general', rt.profileOf('general'));
    randomUUIDControl.set('R7-OVERLAP-SESSION');
    const handlers = await registeredHandlers();
    const prompt = handlers.get('sparkii:prompt')!;
    const first = prompt(null, '旧提示词').then(() => null, (error: unknown) => error);
    await waitUntil(() => promptResolvers.length === 1);
    await rt.pool.release('R7-OVERLAP-SESSION');

    const second = prompt(null, '新提示词').then(() => null, (error: unknown) => error);
    await waitUntil(() => promptResolvers.length === 2);
    expect(vi.mocked(rt.pool.acquire).mock.calls.map(([id]) => id)).toEqual(['R7-OVERLAP-SESSION', 'R7-OVERLAP-SESSION']);
    expect(rt.pool.getBinding('R7-OVERLAP-SESSION')).toBeDefined();

    await expect(handlers.get('sparkii:releaseSessionSlot')!(null, 'R7-OVERLAP-SESSION')).resolves.toMatchObject({ ok: true });
    const firstOutcome = await Promise.race([
      first,
      new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 200); }),
    ]);
    try {
      expect(firstOutcome).not.toBe('timeout');
      expect(firstOutcome).toMatchObject({ message: expect.stringMatching(/no longer bound/i) });
      promptResolvers[0]({ success: true });
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      const secondOutcome = await Promise.race([
        second,
        new Promise<'timeout'>((resolve) => { setTimeout(() => resolve('timeout'), 200); }),
      ]);
      expect(secondOutcome).not.toBe('timeout');
      expect(secondOutcome).toMatchObject({ message: expect.stringMatching(/no longer bound/i) });
      expect(rt.pool.getBinding('R7-OVERLAP-SESSION')).toBeUndefined();
    } finally {
      promptResolvers[0]({ success: true });
      promptResolvers[1]({ success: true });
      for (const cb of listeners) cb({ type: 'agent_end' });
      await Promise.all([first, second]);
    }
  });

  it('stamps chat-events with the live slot sessionId, not the subscribe-time id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'A', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    expect(listeners.size).toBe(1);

    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(windowSent.at(-1)?.[1]).toMatchObject({ type: 'message_start', sessionId: 'A' });

    // 同一个进程借给 B：不新增监听，出门读到的是新牌子。
    rt.pool.renameSession('A', 'B');
    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'message_update', message: { role: 'assistant', content: [] } });
    expect(listeners.size).toBe(1);
    expect(windowSent.at(-1)?.[1]).toMatchObject({ type: 'message_update', sessionId: 'B' });
  });

  it('stamps over an inner sessionId carried by the event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async () => ({ success: true }),
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'session_info_changed', sessionId: 'stale-inner' });
    expect(windowSent.at(-1)?.[1]).toMatchObject({ type: 'session_info_changed', sessionId: 'A' });
  });

  it('drops events while the slot has no session bound', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'A', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    await handlers.get('sparkii:releaseSessionSlot')!(null, 'A');
    expect(rt.pool.release).toHaveBeenCalledWith('A', 1);

    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'agent_settled' });
    expect(windowSent).toEqual([]);
    // 管子还在（进程稳定），只是牌子空了。
    expect(listeners.size).toBe(1);
  });

  it('sends session_unbound before releasing the slot so the spinner stops', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const order: string[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'A', sessionFile: '/tmp/a.jsonl', isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: any) => {
            if (channel === 'sparkii:event:chat-event' && payload?.type === 'session_unbound') {
              order.push(`unbound:${payload.sessionId}`);
            }
          },
        },
      }) as any,
    });
    (rt.pool as any).release = vi.fn(async () => { order.push('release'); });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    order.length = 0;
    await handlers.get('sparkii:releaseSessionSlot')!(null, 'A');

    expect(order).toEqual(['unbound:A', 'release']);
  });

  it('logs and stops stamping when the pi child exits', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    const windowSent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return {
            success: true,
            data: {
              sessionId: 'A',
              sessionFile: null,
              isStreaming: true,
              streamingMessage: { role: 'assistant', content: [{ type: 'text', text: '半句' }] },
            },
          };
        }
        return { success: true };
      },
    };
    const exitCbs: Array<(code: number | null) => void> = [];
    const logger = { export: async () => '', log: vi.fn(async () => {}) };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      exitCbs,
      logger,
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    await handlers.get('sparkii:getChatState')!(null, 'A');
    // 与管子同一套去重：一根进程只订一次退出。
    expect(exitCbs).toHaveLength(1);
    expect(listeners.size).toBe(1);

    windowSent.length = 0;
    exitCbs[0](2);
    await waitUntil(() => windowSent.some((c) => c[1]?.type === 'session_unbound'));

    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      msg: 'pi runtime exited',
      ctx: expect.objectContaining({ sessionId: 'A', code: 2 }),
    }));
    expect(windowSent.filter((c) => c[1]?.type === 'session_unbound')).toHaveLength(1);
    expect(rt.pool.release).toHaveBeenCalledWith('A', 1);

    // 牌子卸了，管子还在，但不再往窗口盖章。
    windowSent.length = 0;
    for (const cb of listeners) cb({ type: 'agent_end' });
    expect(windowSent).toEqual([]);

    // 再打开走死了路径：JSONL 正文，没有 preview。
    const reopened = await handlers.get('sparkii:openChatSession')!(null, 'A') as any;
    expect(reopened).toMatchObject({ entries: [], streamingMessage: null, streaming: false });
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
    // 牌子被卸掉就不再盖章；管子本身留着给下一条会话用。
    expect(windowSent.some((c) => c[0] === 'sparkii:event:chat-event' && c[1]?.sessionId === 'wf-done')).toBe(false);
    expect(listeners.size).toBe(1);

    const opened = await handlers.get('sparkii:openChatSession')!(null, 'wf-done');
    expect(sent.some((c) => c.type === 'get_session_entries')).toBe(false);
    expect(opened).toMatchObject({ entries: [], streamingMessage: null, streaming: false });
  });

  it('idle-releases a post-run workflow slot so a later runWorkflow is not blocked', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const listeners = new Set<(event: any) => void>();
    let created = 0;
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'new_session') {
          created += 1;
          return { success: true };
        }
        if (command.type === 'get_state') {
          return {
            success: true,
            data: {
              sessionId: created <= 1 ? 'wf-done' : 'wf-2',
              sessionFile: '/tmp/w.jsonl',
              isStreaming: false,
            },
          };
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
        webContents: { send: () => {} },
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

    const occupied = new Set<string>();
    const waiters: Array<() => void> = [];
    let bound: string | null = null;
    let bindingLease = 0;
    const slot = {
      client,
      get lease() { return bindingLease; },
      supervisor: { onProposal: () => {}, onExit: () => () => {} },
      getSessionId: () => bound,
    };
    (rt as any).pool.acquire = vi.fn(async (key: string) => {
      while (occupied.size >= 1 && !occupied.has(key)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      occupied.add(key);
      bound = key;
      bindingLease += 1;
      return slot;
    });
    (rt as any).pool.release = vi.fn(async (key: string, expectedLease?: number) => {
      if (expectedLease !== undefined && expectedLease !== bindingLease) return;
      occupied.delete(key);
      if (bound === key) bound = null;
      const queued = waiters.splice(0);
      for (const wake of queued) wake();
    });
    (rt as any).pool.get = (key?: string) => (key && occupied.has(key) ? client : undefined);
    (rt as any).pool.getBinding = (key: string) => occupied.has(key)
      ? { client, lease: bindingLease }
      : undefined;
    (rt as any).pool.renameSession = vi.fn((from: string, to: string) => {
      if (occupied.has(from)) {
        occupied.delete(from);
        occupied.add(to);
      }
      if (bound === from) bound = to;
    });

    const handlers = await registeredHandlers();
    const first = await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [] });
    expect(first).toEqual({ ok: true, sessionId: 'wf-done' });
    await waitUntil(() => (rt.pool.release as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(rt.pool.release).toHaveBeenCalledWith('wf-done', 1);

    await handlers.get('sparkii:updateWorkflowState')!(null, 'wf-done', { action: 'risk_confirmed' });
    expect(occupied.has('wf-done')).toBe(true);

    vi.useFakeTimers();
    for (const cb of listeners) cb({ type: 'agent_settled' });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    expect(rt.pool.release).toHaveBeenCalledTimes(2);
    expect(occupied.has('wf-done')).toBe(false);

    const second = handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [] });
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('second runWorkflow blocked by zombie slot')), 1000);
      }),
    ]);
    expect(result).toEqual({ ok: true, sessionId: 'wf-2' });
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

  it('workflow selectModel prefers the session-selected model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }),
      'utf8',
    );
    const sent: any[] = [];
    const rt = {
      dataDir,
      chatSessions: { get: () => ({ model: 'deepseek/deepseek-v4-pro' }) },
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

    await selectModel(rt, 'extract', 's1');
    expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
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

    let streaming = false;
    const sent: any[] = [];
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return { success: true, data: { isStreaming: streaming, sessionFile: null } };
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
    streaming = true;
    const result = await promptSession!(null, 's1', '继续做');

    expect(sent).toContainEqual({ type: 'follow_up', message: '继续做', originToken: expect.any(String), promptId: expect.any(String) });
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

  it('connector_read document.read is handled by executeDocumentRead', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
      'utf8',
    );
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' },
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review', displayName: '合同审核' },
          agent: { tools: ['document.read'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, 's1', '开始');
    const read = (rt as any).__onConnectorRead;
    const fullText = '# 合同全文不得写入审计';
    executeDocumentReadMock.mockResolvedValue({
      ok: true,
      data: {
        text: fullText,
        engine: 'structure',
        meta: { fileName: 'a.docx', pageCount: 2, quality: { score: 0.91 } },
      },
    });
    const out = await read?.({ requestId: 'r1', toolName: 'document.read', args: { documents: ['/tmp/a.docx'] } });
    expect(out?.ok).toBe(true);
    expect(out?.error?.message).not.toBe('unhandled');
    expect(executeDocumentReadMock).toHaveBeenCalled();
    expect(rt.audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'tester',
      action: 'tool.read',
      resource: 'document.read',
      sessionId: 's1',
    }));
    const auditCall = (rt.audit.append as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as { resource?: string })?.resource === 'document.read',
    );
    const summary = String((auditCall?.[0] as { payloadSummary?: string })?.payloadSummary ?? '');
    expect(summary).toContain('a.docx');
    expect(summary).toContain('structure');
    expect(summary).toContain('0.91');
    expect(summary).not.toContain(fullText);
  });

  it('connector_read rejects an ontology tool name outside the whitelist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ sparkiionto: { baseUrl: 'http://127.0.0.1:9380' } }),
      'utf8',
    );
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
      knowledgeToken: async (backend) => (backend === 'sparkiionto' ? 'token-onto-secret' : null),
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review', displayName: '合同审核' },
          agent: { tools: ['ontology.query'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, 's1', '开始');
    const read = (rt as any).__onConnectorRead;
    const out = await read?.({ requestId: 'r0', toolName: 'ontology.unknown', args: {} });
    expect(out).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED' } });
  });

  it('connector_read writes exactly one audit per ontology tool call and records the query text', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ sparkiionto: { baseUrl: 'http://127.0.0.1:9380' } }),
      'utf8',
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/v1/info')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            product: 'SparkiiOnto',
            version: '0.6.8',
            api_version: 'v1',
            deployment_profile: 'single-instance',
            retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
            capabilities: { datasets: true, graph: true },
          }),
        };
      }
      if (u.includes('/api/sparql')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ rows: [] }),
        };
      }
      throw new Error(`unexpected ${u}`);
    }));
    const auditAppend = vi.fn(async (ev) => ev);
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
        }
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null },
      knowledgeToken: async (backend) => (backend === 'sparkiionto' ? 'token-onto-secret' : null),
      audit: { append: auditAppend, query: vi.fn(async () => []) },
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review', displayName: '合同审核' },
          agent: { tools: ['ontology.query'], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, 's1', '开始');
    const read = (rt as any).__onConnectorRead;
    await read?.({ requestId: 'r1', toolName: 'ontology.query', args: { query: 'SELECT ?s WHERE { ?s ?p ?o }' } });
    const appended = auditAppend.mock.calls;
    expect(appended).toHaveLength(1);
    const row = JSON.stringify(appended[0]);
    expect(row).toContain('ontology.query');
    expect(row).toContain('SELECT ?s WHERE');
    expect(row).not.toContain('token-');
  });

  it('reports document-parse spawn failures to the error center as 文档解析', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const append = vi.fn();
    const send = vi.fn();
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      errors: { append },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send },
      }),
    });
    const reporter = supervisorMocks.setErrorReporter.mock.calls.at(-1)?.[0] as ((message: string) => void) | undefined;
    expect(typeof reporter).toBe('function');
    reporter!('内存不足或文档解析无法启动，请到设置 → 文档解析查看。');
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      message: '内存不足或文档解析无法启动，请到设置 → 文档解析查看。',
      source: '文档解析',
    }));
    expect(send).toHaveBeenCalledWith(
      'sparkii:event:chat-event',
      expect.objectContaining({
        type: 'runtime_error',
        message: '内存不足或文档解析无法启动，请到设置 → 文档解析查看。',
        source: '文档解析',
      }),
    );
  });

  it('abortChat calls failSession before Pi abort', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
      'utf8',
    );
    const order: string[] = [];
    supervisorMocks.failSession.mockImplementation(async () => { order.push('fail'); });
    const client = {
      onEvent: (cb: (event: any) => void) => {
        queueMicrotask(() => cb({ type: 'agent_end' }));
        return () => {};
      },
      send: async (command: any) => {
        if (command.type === 'abort') order.push('abort');
        if (command.type === 'clear_queue') order.push('clear');
        if (command.type === 'get_state') {
          return { success: true, data: { isStreaming: false, sessionFile: null, steering: [], followUp: [] } };
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
    await handlers.get('sparkii:promptSession')!(null, 's1', '开始');
    order.length = 0;
    await handlers.get('sparkii:abortChat')!(null, 's1');
    expect(order[0]).toBe('fail');
    expect(order.indexOf('fail')).toBeLessThan(order.indexOf('abort'));
    expect(order.indexOf('fail')).toBeLessThan(order.indexOf('clear'));
  });

  it('releaseSessionSlot calls failSession before unbind', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const order: string[] = [];
    supervisorMocks.failSession.mockImplementation(async () => { order.push('fail'); });
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 'A', sessionFile: '/tmp/a.jsonl', isStreaming: false } };
        }
        order.push(`send:${command.type}`);
        return { success: true };
      },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: () => {} },
      }) as any,
    });
    (rt.pool as any).release = vi.fn(async () => { order.push('release'); });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    order.length = 0;
    await handlers.get('sparkii:releaseSessionSlot')!(null, 'A');
    expect(order[0]).toBe('fail');
    expect(order.indexOf('fail')).toBeLessThan(order.indexOf('release'));
  });

  it('R7 does not release a same-id replacement while an explicit slot release is awaiting task shutdown', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    let finishEnd!: () => void;
    const endPromise = new Promise<void>((resolve) => { finishEnd = resolve; });
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => command.type === 'get_state'
        ? { success: true, data: { sessionId: 'A', sessionFile: '/tmp/a.jsonl', isStreaming: false } }
        : { success: true },
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null },
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: () => {} } }) as any,
    });
    (rt as any).security = { taskLifecycle: { end: vi.fn(() => endPromise) } };
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 'A', { action: 'risk_confirmed' });
    vi.mocked(rt.chatSessions.update).mockClear();
    const oldLease = rt.pool.getBinding('A')?.lease;
    expect(oldLease).toBeTypeOf('number');

    const releasing = handlers.get('sparkii:releaseSessionSlot')!(null, 'A');
    await rt.pool.release('A');
    await rt.pool.acquire('A');
    const releaseCalls = vi.mocked(rt.pool.release).mock.calls.length;
    const newLease = rt.pool.getBinding('A')?.lease;
    expect(newLease).not.toBe(oldLease);
    finishEnd();
    await releasing;

    expect(rt.pool.getBinding('A')?.lease).toBe(newLease);
    expect(vi.mocked(rt.pool.release).mock.calls).toHaveLength(releaseCalls);
    expect(supervisorMocks.failSession).not.toHaveBeenCalled();
    expect(rt.chatSessions.update).not.toHaveBeenCalled();
  });

  it('getDocumentParse handler exists', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }), onEvent: () => () => {} },
    });
    const handlers = await registeredHandlers();
    const getDocumentParse = handlers.get('sparkii:getDocumentParse');
    expect(getDocumentParse).toBeTypeOf('function');
    expect(await getDocumentParse!(null)).toEqual({ status: 'stopped', waiting: [] });
  });

  it('downloadDocumentParseModule without production hashes fails with offline import hint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }), onEvent: () => () => {} },
    });
    const handlers = await registeredHandlers();
    const download = handlers.get('sparkii:downloadDocumentParseModule');
    expect(download).toBeTypeOf('function');
    expect(await download!(null, 'seal')).toEqual({
      ok: false,
      error: '网络不可达，请改用导入离线包。',
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

    let streaming = false;
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
              isStreaming: streaming,
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
    streaming = true;

    const queueMutate = handlers.get('sparkii:queueMutate');
    const result = await queueMutate!(null, 's1', {
      action: 'transfer',
      queue: 'followUp',
      index: 0,
      targetQueue: 'steering',
    });

    const clearIndex = sent.findIndex((c) => c.type === 'clear_queue');
    const rebuild = sent.slice(clearIndex + 1);
    expect(rebuild).toContainEqual({ type: 'steer', message: '先做这个', originToken: expect.any(String) });
    expect(rebuild).toContainEqual({ type: 'steer', message: '做完后整理', originToken: expect.any(String) });
    expect(rebuild).toContainEqual({ type: 'follow_up', message: '再跑一遍测试', originToken: expect.any(String), promptId: expect.any(String) });
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
    let boundSessionId: string | undefined;
    (rt as any).pool.acquire = vi.fn(async (sessionId: string) => {
      boundSessionId = sessionId;
      return {
        client,
        lease: 1,
        supervisor: { onProposal, onExit: () => () => {} },
        getSessionId: () => boundSessionId,
      };
    });
    (rt as any).pool.getBinding = (sessionId: string) => boundSessionId === sessionId ? { client, lease: 1 } : undefined;
    (rt as any).pool.renameSession = (_from: string, to: string) => { boundSessionId = to; };
    (rt as any).pool.release = vi.fn(async () => { boundSessionId = undefined; });
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

  it('classifies current DeepSeek models with orthogonal capabilities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-model-capabilities-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    await makeRuntime({
      dataDir,
      piAgentDir,
      client: {
        send: async (command: any) => command.type === 'list_models'
          ? {
              success: true,
              data: [
                { modelId: 'deepseek-flash', supportsImages: true },
                { modelId: 'future-vision-chat', supportsImages: true },
                { modelId: 'deepseek-vision', supportsImages: true },
              ],
            }
          : { success: true },
      },
      agentOf: () => ({
        id: 'general',
        tools: [],
        dir: join(dataDir, 'profiles', 'general'),
        systemPrompt: 'test',
        manifest: {
          id: 'general',
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools: [] },
          modelRequirements: { requires: ['chat', 'toolCall'] },
        },
      }),
    });

    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:getModelOptions')!(null, 'general') as {
      compatibleModels: string[];
      incompatibleModels: string[];
    };

    expect(result.compatibleModels).toEqual([
      'deepseek-flash',
      'future-vision-chat',
    ]);
    expect(result.incompatibleModels).toEqual(['deepseek-vision']);
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

  it('chooseDocument grants the selected path for readDocumentBytes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const file = join(dataDir, 'contract.txt');
    await writeFile(file, 'preview-me');
    const electron = await import('electron');
    vi.mocked(electron.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [file] } as any);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: () => {} },
      }) as any,
    });
    const handlers = await registeredHandlers();
    const chosen = await handlers.get('sparkii:chooseDocument')!(null, { extensions: ['pdf', 'docx', 'txt'] });
    expect(chosen).toEqual({ path: file });
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filters: [{ name: '文档', extensions: ['pdf', 'docx', 'txt'] }] }),
    );
    const preview = await handlers.get('sparkii:readDocumentBytes')!(null, file);
    expect(preview).toMatchObject({ kind: 'txt', fileName: 'contract.txt' });
    expect(await handlers.get('sparkii:readDocumentBytes')!(null, join(dataDir, 'other.txt'))).toEqual({ error: 'denied' });
  });

  it('openChatSession ENOENT still returns session inputs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const missingFile = join(dataDir, 'not-written-yet.jsonl');
    const chatSession = {
      profileId: 'contract-review',
      model: null,
      kind: 'workflow',
      piSessionFile: missingFile,
      inputs: JSON.stringify([{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }]),
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      chatSession,
    });
    const handlers = await registeredHandlers();
    const opened = await handlers.get('sparkii:openChatSession')!(null, 'wf-missing');
    expect(opened).toMatchObject({
      entries: [],
      streamingMessage: null,
      streaming: false,
      inputs: [expect.objectContaining({ path: 'C:/tmp/a.pdf', name: 'a.pdf' })],
      workspacePath: null,
      workspaceKind: null,
    });
  });

  it('opens a live session from getBranch + streamingMessage, not get_messages', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const branch = [
      { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
      { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核合同' }] } },
    ];
    const streamingMessage = { role: 'assistant', content: [{ type: 'text', text: '第3条' }] };
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return {
            success: true,
            data: { sessionId: 's1', sessionFile: '/tmp/s.jsonl', isStreaming: true, streamingMessage },
          };
        }
        if (command.type === 'get_session_entries') return { success: true, data: branch };
        if (command.type === 'get_messages') {
          return { success: true, data: [{ role: 'assistant', content: [{ type: 'text', text: '更短的一句' }] }] };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl' },
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'risk_confirmed' });
    sent.length = 0;

    const opened = await handlers.get('sparkii:openChatSession')!(null, 's1') as {
      entries: unknown[];
      streamingMessage: unknown;
      streaming: boolean;
    };
    expect(opened.entries).toEqual(branch);
    expect(opened.streamingMessage).toEqual(streamingMessage);
    expect(opened.streaming).toBe(true);
    expect(sent.filter((c) => c.type === 'get_messages')).toHaveLength(0);
  });

  it('recovers the micro-gap assistant from get_messages only while streaming without a slot message', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const branch = [
      { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核合同' }] } },
      { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: '早先那句' }] } },
    ];
    const inFlight = { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] };
    const sent: any[] = [];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        sent.push(command);
        if (command.type === 'get_state') {
          return {
            success: true,
            data: { sessionId: 's1', sessionFile: '/tmp/s.jsonl', isStreaming: true, streamingMessage: null },
          };
        }
        if (command.type === 'get_session_entries') return { success: true, data: branch };
        if (command.type === 'get_messages') {
          return {
            success: true,
            data: [{ role: 'user', content: '请审核合同' }, { role: 'assistant', content: [{ type: 'text', text: '早先那句' }] }, inFlight],
          };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl' },
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'risk_confirmed' });
    sent.length = 0;

    const opened = await handlers.get('sparkii:openChatSession')!(null, 's1') as {
      entries: unknown[];
      streamingMessage: unknown;
      streaming: boolean;
    };
    expect(opened.streamingMessage).toEqual(inFlight);
    expect(opened.streaming).toBe(true);
    expect(sent.filter((c) => c.type === 'get_messages')).toHaveLength(1);
  });

  it('skips the micro-gap when the last assistant is already on the branch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const branch = [
      { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: '已经入树的那句' }] } },
    ];
    const client = {
      onEvent: vi.fn(() => () => {}),
      send: async (command: any) => {
        if (command.type === 'get_state') {
          return {
            success: true,
            data: { sessionId: 's1', sessionFile: '/tmp/s.jsonl', isStreaming: true, streamingMessage: null },
          };
        }
        if (command.type === 'get_session_entries') return { success: true, data: branch };
        if (command.type === 'get_messages') {
          return { success: true, data: [{ role: 'assistant', content: [{ type: 'text', text: '已经入树的那句' }] }] };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl' },
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'risk_confirmed' });
    const opened = await handlers.get('sparkii:openChatSession')!(null, 's1') as { streamingMessage: unknown };
    expect(opened.streamingMessage).toBeNull();
  });

  it('does not read get_messages when the live session is idle', async () => {
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
          return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/s.jsonl', isStreaming: false } };
        }
        if (command.type === 'get_session_entries') return { success: true, data: [] };
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl' },
    });

    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'risk_confirmed' });
    sent.length = 0;
    const opened = await handlers.get('sparkii:openChatSession')!(null, 's1') as {
      streamingMessage: unknown;
      streaming: boolean;
    };
    expect(opened.streamingMessage).toBeNull();
    expect(opened.streaming).toBe(false);
    expect(sent.filter((c) => c.type === 'get_messages')).toHaveLength(0);
  });

  it('dead session reads JSONL entries only (no preview)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const file = join(dataDir, 'dead.jsonl');
    const body = [
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-05T00:00:01.000Z', message: { role: 'user', content: '请审核合同' } },
      { type: 'custom', id: 'c1', parentId: 'm1', timestamp: '2026-09-05T00:00:02.000Z', customType: 'workflow_step_end', data: { stepId: 'review' } },
    ];
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'dead', timestamp: '2026-09-05T00:00:00.000Z', cwd: dataDir }),
        ...body.map((entry) => JSON.stringify(entry)),
      ].join('\n'),
      'utf8',
    );

    const sent: any[] = [];
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: {
        send: async (command: any) => {
          sent.push(command);
          return { success: true };
        },
      },
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: file },
    });

    const handlers = await registeredHandlers();
    const opened = await handlers.get('sparkii:openChatSession')!(null, 'dead') as {
      entries: unknown[];
      streamingMessage: unknown;
      streaming: boolean;
    };
    expect(opened.entries).toEqual(body);
    expect(opened.streamingMessage).toBeNull();
    expect(opened.streaming).toBe(false);
    expect(sent).toEqual([]);
  });

  it('R8 final review uses the raw Pi carrier for dead-session reads and runtime acquisition', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const file = join(dataDir, 'raw-carrier.jsonl');
    const body = {
      type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-05T00:00:01.000Z',
      message: { role: 'user', content: 'raw carrier' },
    };
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'dead', timestamp: '2026-09-05T00:00:00.000Z', cwd: dataDir }),
      JSON.stringify(body),
    ].join('\n'), 'utf8');
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true, data: { entries: [], state: {} } }) },
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '[已删除]' },
    });
    const rawPiSessionFile = vi.fn(() => file);
    rt.chatSessions.rawPiSessionFile = rawPiSessionFile;
    const handlers = await registeredHandlers();

    const opened = await handlers.get('sparkii:openChatSession')!(null, 'dead') as { entries: unknown[] };
    expect.soft(opened.entries).toEqual([body]);
    expect.soft(rawPiSessionFile).toHaveBeenCalledWith('dead');

    await handlers.get('sparkii:setChatTitle')!(null, 's1', 'raw carrier', 'user');
    expect.soft(rt.pool.acquire).toHaveBeenCalledWith('s1', expect.objectContaining({ resumeSessionFile: file }));
  });

  it('setChatTitle notifies the renderer so the sidebar can show the filename', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const windowSent: any[] = [];
    const send = vi.fn(async (command: any) => {
      if (command.type === 'set_session_name') return { success: true };
      return { success: true };
    });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send },
      chatSession: { profileId: 'contract-review', model: null, kind: 'workflow' },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:setChatTitle')!(null, 'wf-1', '采购合同.pdf', 'agent');
    expect(result).toEqual({ ok: true });
    expect(windowSent.some((c) => c[0] === 'sparkii:event:chat-event' && c[1]?.type === 'session_title' && c[1]?.title === '采购合同.pdf')).toBe(true);
  });

  it('setChatTitle updates the runtime pool label instead of leaving the session id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const send = vi.fn(async (command: any) => {
      if (command.type === 'set_session_name') return { success: true };
      return { success: true };
    });
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send },
      chatSession: { profileId: 'contract-review', model: null, kind: 'workflow' },
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: () => {} },
      }) as any,
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: { manifest: { displayName: '合同审核智能体' }, agent: { tools: [], prompts: { system: 'test' } } },
      } as any,
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:setChatTitle')!(null, 'wf-1', '采购合同', 'agent');
    expect(rt.pool.updateMeta).toHaveBeenCalledWith('wf-1', { label: '采购合同' });
  });

  it('reopening a session acquires the pool with displayName and Pi title, not the uuid prefix', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    vi.mocked(listPiSessions).mockResolvedValueOnce([
      {
        id: '01a06da9-ff37-7fe6-b320-2bda26cb3188',
        name: '采购合同',
        firstMessage: '---\nname: contract_risk_review\n',
        path: '/tmp/s.jsonl',
        cwd: '',
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
      },
    ] as any);
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      chatSession: {
        profileId: 'contract-review',
        model: null,
        piSessionFile: '/tmp/s.jsonl',
        kind: 'workflow',
      },
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: { manifest: { displayName: '合同审核智能体' }, agent: { tools: [], prompts: { system: 'test' } } },
      } as any,
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:completeText')!(null, '01a06da9-ff37-7fe6-b320-2bda26cb3188', 'x');
    expect(rt.pool.acquire).toHaveBeenCalledWith(
      '01a06da9-ff37-7fe6-b320-2bda26cb3188',
      expect.objectContaining({
        meta: {
          profileId: 'contract-review',
          profileName: '合同审核智能体',
          label: '采购合同',
        },
      }),
    );
    vi.mocked(listPiSessions).mockReset();
    vi.mocked(listPiSessions).mockImplementation(listPiSessions as any);
  });

  it('reopening a nameless workflow session uses 新会话, not the skill body', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    vi.mocked(listPiSessions).mockResolvedValueOnce([
      {
        id: 'wf-skill',
        name: '   ',
        firstMessage: '---\nname: contract_risk_review\n---\n# 风险比对',
        path: '/tmp/s.jsonl',
        cwd: '',
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
      },
    ] as any);
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl', kind: 'workflow' },
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: { manifest: { displayName: '合同审核智能体' }, agent: { tools: [], prompts: { system: 'test' } } },
      } as any,
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:completeText')!(null, 'wf-skill', 'x');
    expect(rt.pool.acquire).toHaveBeenCalledWith(
      'wf-skill',
      expect.objectContaining({
        meta: { profileId: 'contract-review', profileName: '合同审核智能体', label: '新会话' },
      }),
    );
    vi.mocked(listPiSessions).mockReset();
    vi.mocked(listPiSessions).mockImplementation(listPiSessions as any);
  });

  it('reopening still acquires display meta when listing Pi sessions fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    vi.mocked(listPiSessions).mockRejectedValueOnce(new Error('catalog down'));
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      chatSession: { profileId: 'contract-review', model: null, piSessionFile: '/tmp/s.jsonl', kind: 'workflow' },
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: { manifest: { displayName: '合同审核智能体' }, agent: { tools: [], prompts: { system: 'test' } } },
      } as any,
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:completeText')!(null, 'wf-down', 'x');
    expect(rt.pool.acquire).toHaveBeenCalledWith(
      'wf-down',
      expect.objectContaining({
        meta: { profileId: 'contract-review', profileName: '合同审核智能体', label: '新会话' },
      }),
    );
    vi.mocked(listPiSessions).mockReset();
    vi.mocked(listPiSessions).mockImplementation(listPiSessions as any);
  });

  it('setChatTitle rejects empty titles and agent writes after a user lock', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const windowSent: any[] = [];
    const send = vi.fn(async (command: any) => {
      if (command.type === 'set_session_name') return { success: true };
      return { success: true };
    });
    const chatSession: { profileId: string; model: null; kind: string; titleLockedByUser: boolean; piSessionFile?: string | null } = {
      profileId: 'contract-review',
      model: null,
      kind: 'workflow',
      titleLockedByUser: false,
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send },
      chatSession,
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });
    (rt as any).chatSessions.get = () => chatSession;
    (rt as any).chatSessions.update = (_id: string, patch: { titleLockedByUser?: boolean }) => {
      if (patch.titleLockedByUser != null) chatSession.titleLockedByUser = patch.titleLockedByUser;
    };
    const handlers = await registeredHandlers();
    const setTitle = handlers.get('sparkii:setChatTitle')!;
    expect(await setTitle(null, 'wf-1', '   ', 'agent')).toEqual({ ok: false });
    expect(windowSent.filter((c) => c[1]?.type === 'session_title')).toHaveLength(0);

    expect(await setTitle(null, 'wf-1', '我改的名字', 'user')).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({ type: 'set_session_name', name: '我改的名字' });
    expect(chatSession.titleLockedByUser).toBe(true);

    send.mockClear();
    windowSent.length = 0;
    expect(await setTitle(null, 'wf-1', '采购合同', 'agent')).toEqual({ ok: false, reason: 'locked' });
    expect(send).not.toHaveBeenCalled();
    expect(windowSent.some((c) => c[1]?.type === 'session_title')).toBe(false);
  });

  it('listChatSessions does not put firstMessage into title', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    vi.mocked(listPiSessions).mockReset();
    vi.mocked(listPiSessions).mockResolvedValue([
      {
        id: 's1',
        name: undefined,
        firstMessage: 'A'.repeat(80),
        path: '/tmp/s.jsonl',
        cwd: '',
        created: new Date(),
        modified: new Date(),
        messageCount: 1,
      },
    ] as any);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      chatSession: { profileId: 'general', model: null },
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:listChatSessions')!(null, 'general') as Array<{ title?: string; firstMessage?: string }>;
    expect(result[0].title).toBeUndefined();
    expect(result[0].firstMessage).toBe('A'.repeat(80));
    vi.mocked(listPiSessions).mockReset();
    vi.mocked(listPiSessions).mockImplementation(listPiSessions as any);
  });

  it('completeText forwards text to complete without renaming the session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ defaultModel: 'deepseek-v4-flash', activeProviderId: 'deepseek' }), 'utf8');
    const send = vi.fn(async (command: any) => {
      if (command.type === 'complete') return { success: true, data: '模型回答' };
      return { success: true };
    });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send },
      chatSession: { profileId: 'general', model: null },
    });
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:completeText')!(null, 's1', '只是一句普通补全');
    expect(result).toEqual({ ok: true, text: '模型回答' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete', text: '只是一句普通补全' }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'set_session_name' }));
  });

  it('does not auto-title a chat session on agent_end', async () => {
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
        if (command.type === 'new_session') return { success: true };
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/s.jsonl', isStreaming: false } };
        }
        return { success: true };
      },
    };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      chatSession: { profileId: 'general', model: null, kind: 'chat' },
    });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:promptSession')!(null, null, 'hello', undefined, undefined, { profileId: 'general' });
    for (const cb of events) cb({ type: 'agent_end' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.some((c) => c.type === 'complete')).toBe(false);
    expect(sent.some((c) => c.type === 'set_session_name')).toBe(false);
  });
});

describe('ipc user skill library', () => {
  function userAgent(dataDir: string, id = 'writer') {
    const skillsDir = join(dataDir, 'agents', id, 'skills');
    return {
      id,
      dir: join(dataDir, 'pkg', id),
      tools: ['read'],
      skillsDir,
      systemPrompt: 'writer',
      manifest: {
        id,
        displayName: '写作助手',
        version: '1.0.0',
        sortOrder: 10,
        surface: { type: 'chat' as const },
        capabilities: { tools: ['read'] },
        skillLibrary: 'user' as const,
      },
    };
  }

  function packageAgent(dataDir: string) {
    const dir = join(dataDir, 'pkg', 'reviewer');
    return {
      id: 'reviewer',
      dir,
      tools: ['read'],
      skillsDir: join(dir, 'agent', 'skills'),
      systemPrompt: 'reviewer',
      manifest: {
        id: 'reviewer',
        displayName: '审核助手',
        version: '1.0.0',
        sortOrder: 20,
        surface: { type: 'workflow' as const },
        capabilities: { tools: ['read'] },
      },
    };
  }

  async function writeSkillFolder(dir: string, name: string, description: string): Promise<string> {
    const source = join(dir, name);
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
      'utf8',
    );
    return source;
  }

  it('imports, lists, audits, and uninstalls a user skill', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-skill-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const writer = userAgent(dataDir);
    const reviewer = packageAgent(dataDir);
    const audit = { append: vi.fn(async (ev) => ev), query: vi.fn(async () => []) };
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      agents: new Map([[writer.id, writer], [reviewer.id, reviewer]]),
      agentOf: (id) => (id === reviewer.id ? reviewer : writer),
      audit,
    });
    const source = await writeSkillFolder(dataDir, 'summarize', 'Summarize text.');
    const handlers = await registeredHandlers();

    const imported = await handlers.get('sparkii:importUserSkill')!(null, { sourceDir: source });
    expect(imported).toEqual({ ok: true, name: 'summarize' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'tester',
      action: 'skill.installed',
      resource: 'summarize',
      payloadSummary: source,
    }));

    const listed = await handlers.get('sparkii:listUserSkills')!(null);
    expect(listed).toMatchObject({
      agent: { id: 'writer', name: '写作助手' },
      skills: [{ name: 'summarize', description: 'Summarize text.' }],
    });

    const uninstalled = await handlers.get('sparkii:uninstallUserSkill')!(null, { name: 'summarize' });
    expect(uninstalled).toEqual({ ok: true });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'skill.uninstalled',
      resource: 'summarize',
    }));

    const after = await handlers.get('sparkii:listUserSkills')!(null);
    expect(after.skills).toEqual([]);

    expect(reviewer.skillsDir.endsWith(join('agent', 'skills')) || reviewer.skillsDir.replace(/\\/g, '/').endsWith('agent/skills')).toBe(true);
    expect(buildAgentSaddle(reviewer as any, join(dataDir, 'anchor')).skillsDir).toBe(reviewer.skillsDir);
    expect(buildAgentSaddle(reviewer as any, join(dataDir, 'anchor')).skillsDir).not.toBe(writer.skillsDir);
  });

  it('returns no-user-library when no skillLibrary user agent is assembled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-skill-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      agents: new Map(),
    });
    const handlers = await registeredHandlers();
    expect(await handlers.get('sparkii:listUserSkills')!(null)).toEqual({ agent: null, skills: [] });
    expect(await handlers.get('sparkii:importUserSkill')!(null, { sourceDir: dataDir })).toEqual({
      ok: false,
      reason: 'no-user-library',
    });
    expect(await handlers.get('sparkii:uninstallUserSkill')!(null, { name: 'x' })).toEqual({
      ok: false,
      reason: 'no-user-library',
    });
    expect(await handlers.get('sparkii:openUserSkillsDir')!(null)).toEqual({
      ok: false,
      reason: 'no-user-library',
    });
  });

  it('prefers SPARKII_E2E_SKILL_DIR for chooseSkillFolder', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-skill-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
    });
    process.env.SPARKII_E2E_SKILL_DIR = '/tmp/e2e-skill';
    try {
      const handlers = await registeredHandlers();
      expect(await handlers.get('sparkii:chooseSkillFolder')!(null)).toEqual({ path: '/tmp/e2e-skill' });
    } finally {
      delete process.env.SPARKII_E2E_SKILL_DIR;
    }
  });

  it('opens the user skills dir after creating it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-skill-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const writer = userAgent(dataDir);
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      agents: new Map([[writer.id, writer]]),
    });
    const handlers = await registeredHandlers();
    const opened = await handlers.get('sparkii:openUserSkillsDir')!(null);
    expect(opened).toEqual({ ok: true, path: writer.skillsDir });
    expect(existsSync(writer.skillsDir)).toBe(true);
    const electron = await import('electron') as unknown as { shell: { openPath: ReturnType<typeof vi.fn> } };
    expect(electron.shell.openPath).toHaveBeenCalledWith(writer.skillsDir);
  });

  it('lists skills for an agent id from that agent skillsDir only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-agent-skills-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const writer = userAgent(dataDir);
    const reviewer = packageAgent(dataDir);
    await mkdir(join(writer.skillsDir, 'brainstorming'), { recursive: true });
    await writeFile(
      join(writer.skillsDir, 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: Brainstorm ideas.\n---\n# brainstorm\n',
      'utf8',
    );
    await mkdir(join(writer.skillsDir, 'my-skill'), { recursive: true });
    await writeFile(
      join(writer.skillsDir, 'my-skill', 'SKILL.md'),
      '---\nname: My Skill\ndescription: Works anyway.\n---\n# body\n',
      'utf8',
    );
    await mkdir(join(reviewer.skillsDir, 'contract_risk_review'), { recursive: true });
    await writeFile(
      join(reviewer.skillsDir, 'contract_risk_review', 'SKILL.md'),
      '---\nname: contract_risk_review\ndescription: Review contract risk.\n---\n# risk\n',
      'utf8',
    );
    await makeRuntime({
      dataDir,
      piAgentDir,
      client: { send: async () => ({ success: true }) },
      agents: new Map([[writer.id, writer], [reviewer.id, reviewer]]),
    });
    const handlers = await registeredHandlers();
    const listAgentSkills = handlers.get('sparkii:listAgentSkills')!;

    const writerListed = await listAgentSkills(null, writer.id) as { skills: Array<{ name: string }> };
    expect(writerListed.skills.map((s) => s.name).sort()).toEqual(['brainstorming', 'my-skill']);
    expect(writerListed.skills.some((s) => s.name === 'My Skill')).toBe(false);
    expect(writerListed.skills.map((s) => s.name)).not.toContain('contract_risk_review');

    const reviewerListed = await listAgentSkills(null, reviewer.id) as { skills: Array<{ name: string }> };
    expect(reviewerListed.skills.map((s) => s.name)).toEqual(['contract_risk_review']);
    expect(reviewerListed.skills.map((s) => s.name)).not.toContain('brainstorming');

    const packageListed = await listUserSkills(reviewer.skillsDir);
    expect(packageListed.map((s) => s.name)).toContain('contract_risk_review');

    expect(await listAgentSkills(null, 'unknown-agent')).toEqual({ skills: [] });
  });

  it('allocateAutoWorkspace returns a Documents path and does not create it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({ dataDir, piAgentDir: join(dataDir, 'pi-agent'), client: { send: async () => ({ success: true }) }, agents });
    const handlers = await registeredHandlers();
    const { workspacePath } = await handlers.get('sparkii:allocateAutoWorkspace')!(null, 'general') as { workspacePath: string };
    expect(workspacePath.replace(/\\/g, '/')).toMatch(/Sparkii\/workspaces\/general\/[a-z]+-[a-z]+-[a-z2-9]{3}$/i);
    expect(existsSync(workspacePath)).toBe(false);
  });

  it('allocateAutoWorkspace rejects unknown agent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({ dataDir, piAgentDir: join(dataDir, 'pi-agent'), client: { send: async () => ({ success: true }) }, agents });
    const handlers = await registeredHandlers();
    expect(() => handlers.get('sparkii:allocateAutoWorkspace')!(null, 'nope')).toThrow(/unknown agent/);
  });

  it('chooseWorkspace mkdirs an absolute defaultPath and forwards it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const ws = join(dataDir, 'abs-ws');
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) }, agents,
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: () => {} } }) as any,
    });
    const electron = await import('electron');
    vi.mocked(electron.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as any);
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:chooseWorkspace')!(null, { defaultPath: ws });
    expect(existsSync(ws)).toBe(true);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openDirectory'], defaultPath: ws }),
    );
  });

  it('chooseWorkspace ignores a relative defaultPath without mkdir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) }, agents,
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: () => {} } }) as any,
    });
    const electron = await import('electron');
    vi.mocked(electron.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as any);
    const handlers = await registeredHandlers();
    const rel = 'SparkiiRelChooseWs';
    await handlers.get('sparkii:chooseWorkspace')!(null, { defaultPath: rel });
    expect(existsSync(rel)).toBe(false);
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ defaultPath: rel }),
    );
  });

  it('openWorkspace mkdirs an absolute path and opens it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const ws = join(dataDir, 'open-ws');
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) }, agents,
    });
    const electron = await import('electron');
    vi.mocked(electron.shell.openPath).mockResolvedValueOnce('');
    const handlers = await registeredHandlers();
    const result = await handlers.get('sparkii:openWorkspace')!(null, ws) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(existsSync(ws)).toBe(true);
    expect(electron.shell.openPath).toHaveBeenCalledWith(ws);
  });

  it('openWorkspace ignores a relative path without mkdir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);
    await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) }, agents,
    });
    const electron = await import('electron');
    vi.mocked(electron.shell.openPath).mockClear();
    const handlers = await registeredHandlers();
    const rel = 'SparkiiRelOpenWs';
    const result = await handlers.get('sparkii:openWorkspace')!(null, rel) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(existsSync(rel)).toBe(false);
    expect(electron.shell.openPath).not.toHaveBeenCalled();
  });

  it('runWorkflow without workspacePath allocates Documents path and does not mkdir', async () => {
    const created: Array<{ workspacePath?: string; workspaceKind?: string }> = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const contractAgents = new Map([['contract-review', { id: 'contract-review', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'contract-review' } }]]);
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: {
        send: async (command: any) => {
          if (command.type === 'new_session') return { success: true };
          if (command.type === 'get_state') return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/w.jsonl' } };
          return { success: true };
        },
        onEvent: () => () => {},
      },
      agents: contractAgents,
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review' },
          agent: { tools: ['read'], prompts: { system: 'sys' }, workflow: { version: 1, engine: 'linear', steps: [] } },
        },
        router: { resolve: () => undefined },
      } as any,
    });
    (rt as any).chatSessions.create = (rec: { workspacePath?: string; workspaceKind?: string }) => { created.push(rec); return { id: 's1' }; };
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [] });
    expect(created[0].workspacePath?.replace(/\\/g, '/')).toMatch(/Sparkii\/workspaces\/contract-review\//);
    expect(created[0].workspaceKind).toBe('auto');
    expect(existsSync(created[0].workspacePath!)).toBe(false);
  });

  it('runWorkflow with an allocated path keeps workspaceKind auto', async () => {
    const created: Array<{ workspaceKind?: string; workspacePath?: string }> = [];
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const contractAgents = new Map([['contract-review', { id: 'contract-review', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'contract-review' } }]]);
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: {
        send: async (command: any) => {
          if (command.type === 'new_session') return { success: true };
          if (command.type === 'get_state') return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/w.jsonl' } };
          return { success: true };
        },
        onEvent: () => () => {},
      },
      agents: contractAgents,
      profile: {
        dir: join(dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review' },
          agent: { tools: ['read'], prompts: { system: 'sys' }, workflow: { version: 1, engine: 'linear', steps: [] } },
        },
        router: { resolve: () => undefined },
      } as any,
    });
    (rt as any).chatSessions.create = (rec: { workspaceKind?: string; workspacePath?: string }) => { created.push(rec); return { id: 's1' }; };
    const handlers = await registeredHandlers();
    const allocated = join(dataDir, 'Sparkii', 'workspaces', 'contract-review', 'ws-auto');
    await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [], workspacePath: allocated });
    expect(created[0].workspacePath).toBe(allocated);
    expect(created[0].workspaceKind).toBe('auto');
  });

  it('R8-P0-2 privacy deletion stops the active task, extraction and Pi binding before memory cleanup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const order: string[] = [];
    const end = vi.fn(async () => { order.push('task-end'); });
    const security = {
      taskLifecycle: {
        active: vi.fn(() => ({ taskId: 'task-private', sessionId: 's-private' })),
        end,
        registerCancellation: vi.fn(() => () => {}),
      },
      hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      taskGrants: { onRevoke: vi.fn(() => () => {}) },
      capabilityGateway: { revokeTask: vi.fn() },
      shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
      reviewer: { cancel: vi.fn(async () => {}) },
      hostShell: { terminate: vi.fn(async () => {}) },
    };
    const memory = {
      setEmitter: vi.fn(),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      deleteMemory: vi.fn(() => { order.push('memory-delete'); return { ok: true, removed: ['m-private'] }; }),
    };
    const cancel = vi.spyOn(ExtractionScheduler.prototype, 'cancel').mockImplementation(() => { order.push('extraction-cancel'); });
    const rt = await makeRuntime({
      dataDir, piAgentDir,
      client: { send: async () => ({ success: true, data: { sessionId: 's-private', sessionFile: null } }) },
      chatSession: { profileId: 'general', model: null },
      security, memory,
    });
    await rt.pool.acquire('s-private');
    const lease = rt.pool.getBinding('s-private')!.lease;
    const handlers = await registeredHandlers();

    try {
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' }))).resolves.toMatchObject({ ok: true });
      expect(end).toHaveBeenCalledWith('s-private', 'session-ended');
      expect(cancel).toHaveBeenCalledWith('s-private');
      expect(supervisorMocks.failSession).toHaveBeenCalledWith('s-private');
      expect(rt.pool.release).toHaveBeenCalledWith('s-private', lease);
      expect(order).toEqual(['task-end', 'extraction-cancel', 'memory-delete']);
      expect(rt.pool.getBinding('s-private')).toBeUndefined();
    } finally {
      cancel.mockRestore();
    }
  });

  it('R8 round7 B1 privacy deletion waits for a cancelled opening bind before destructive cleanup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishBind!: () => void;
    let rejectBind!: (error: Error) => void;
    const bindGate = new Promise<void>((resolve) => { finishBind = resolve; });
    const opening = new Promise<never>((_resolve, reject) => { rejectBind = reject; });
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: vi.fn(async () => ({ success: true })) },
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    rt.pool.acquire = vi.fn(() => opening);
    rt.pool.waitForAcquire = vi.fn(async () => {
      await bindGate;
      await opening.catch(() => undefined);
    });
    rt.pool.cancelAcquire = vi.fn(() => true);
    const handlers = await registeredHandlers();
    const openingRequest = Promise.resolve(handlers.get('sparkii:queueMutate')!(null, 's-private', { type: 'clear' }));
    const openingRejected = expect(openingRequest).rejects.toThrow('RUNTIME_ACQUIRE_CANCELLED');
    await waitUntil(() => rt.pool.acquire.mock.calls.length === 1);

    try {
      const deleting = Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' }));
      await waitUntil(() => rt.pool.cancelAcquire.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rt.pool.waitForAcquire).toHaveBeenCalledWith('s-private');
      expect(memory.deleteMemory).not.toHaveBeenCalled();
      expect(rt.chatSessions.delete).not.toHaveBeenCalled();

      finishBind();
      rejectBind(new Error('RUNTIME_ACQUIRE_CANCELLED'));
      await openingRejected;
      await expect(deleting).resolves.toMatchObject({ ok: true });
      expect(memory.deleteMemory).toHaveBeenCalledTimes(1);
    } finally {
      finishBind();
      rejectBind(new Error('RUNTIME_ACQUIRE_CANCELLED'));
      await openingRejected;
    }
  });

  it('R8-P0-2 stops an active document parser even when no Pi binding exists', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    const order: string[] = [];
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      deleteMemory: vi.fn(() => { order.push('memory-delete'); return { ok: true, removed: ['m-private'] }; }),
    };
    const cancel = vi.spyOn(ExtractionScheduler.prototype, 'cancel').mockImplementation(() => { order.push('extraction-cancel'); });
    supervisorMocks.failSession.mockImplementationOnce(async () => { order.push('parser-stop'); });
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: vi.fn(async () => ({ success: true })) },
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    const handlers = await registeredHandlers();

    try {
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' })))
        .resolves.toMatchObject({ ok: true });
      expect(rt.pool.getBinding('s-private')).toBeUndefined();
      expect(supervisorMocks.failSession).toHaveBeenCalledWith('s-private');
      expect(cancel).toHaveBeenCalledWith('s-private');
      expect(order).toEqual(['parser-stop', 'extraction-cancel', 'memory-delete']);
      expect(rt.pool.release).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
    }
  });

  it('R8-P0-2 does not delete memory or release a same-id replacement while task shutdown is awaiting', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
    let shutdownStarted!: () => void;
    const started = new Promise<void>((resolve) => { shutdownStarted = resolve; });
    const end = vi.fn(async () => {
      shutdownStarted();
      await shutdownGate;
    });
    const security = {
      taskLifecycle: { active: vi.fn(() => ({ taskId: 'task-old', sessionId: 's-private' })), end },
      hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      taskGrants: { onRevoke: vi.fn(() => () => {}) },
      capabilityGateway: { revokeTask: vi.fn() },
      shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
      reviewer: { cancel: vi.fn(async () => {}) },
      hostShell: { terminate: vi.fn(async () => {}) },
    };
    const memory = {
      setEmitter: vi.fn(),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const cancel = vi.spyOn(ExtractionScheduler.prototype, 'cancel').mockImplementation(() => {});
    const oldClient = { send: vi.fn(async () => ({ success: true })) };
    const replacementClient = { send: vi.fn(async () => ({ success: true })) };
    const rt = await makeRuntime({ dataDir, piAgentDir: join(dataDir, 'pi-agent'), client: oldClient, security, memory });
    let binding: { client: unknown; lease: number } | undefined = { client: oldClient, lease: 1 };
    rt.pool.get = () => binding?.client;
    rt.pool.getBinding = () => binding;
    rt.pool.release = vi.fn(async () => {});
    const handlers = await registeredHandlers();

    try {
      const deleting = Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' }));
      await started;
      binding = { client: replacementClient, lease: 2 };
      finishShutdown();
      await expect(deleting).rejects.toThrow('重新绑定');
      expect(end).toHaveBeenCalledWith('s-private', 'session-ended');
      expect(cancel).toHaveBeenCalledWith('s-private');
      expect(memory.deleteMemory).not.toHaveBeenCalled();
      expect(rt.pool.release).not.toHaveBeenCalled();
      expect(supervisorMocks.failSession).not.toHaveBeenCalledWith('s-private');
      expect(oldClient.send).not.toHaveBeenCalled();
      expect(replacementClient.send).not.toHaveBeenCalled();
      expect(rt.pool.getBinding('s-private')).toEqual({ client: replacementClient, lease: 2 });
    } finally {
      finishShutdown();
      cancel.mockRestore();
    }
  });

  it('R8-P0-2 cancels a same-id session opening before pool acquisition', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishListing!: (sessions: unknown[]) => void;
    const listing = new Promise<unknown[]>((resolve) => { finishListing = resolve; });
    vi.mocked(listPiSessions).mockImplementationOnce(() => listing as ReturnType<typeof listPiSessions>);
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: vi.fn(async () => ({ success: true })) },
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    const handlers = await registeredHandlers();
    const priorListCalls = vi.mocked(listPiSessions).mock.calls.length;

    try {
      const opening = Promise.resolve(handlers.get('sparkii:abortChat')!(null, 's-private'));
      await waitUntil(() => vi.mocked(listPiSessions).mock.calls.length > priorListCalls);
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' })))
        .resolves.toMatchObject({ ok: true });
      expect(rt.pool.cancelAcquire).toHaveBeenCalledWith('s-private');
      expect(rt.pool.acquire).not.toHaveBeenCalled();
      finishListing([]);
      await expect(opening).rejects.toThrow('opening was cancelled');
      expect(rt.pool.acquire).not.toHaveBeenCalled();
      expect(rt.pool.getBinding('s-private')).toBeUndefined();
      expect(memory.deleteMemory).toHaveBeenCalledTimes(1);
    } finally {
      finishListing([]);
    }
  });

  it('R8-P0-2 releases a stale acquisition instead of letting it bind after privacy deletion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishAcquisition!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => { finishAcquisition = resolve; });
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const client = { send: vi.fn(async () => ({ success: true })) };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client,
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    const acquire = rt.pool.acquire.getMockImplementation()!;
    rt.pool.acquire.mockImplementation(async (sessionId, options) => {
      await acquisitionGate;
      return acquire(sessionId, options);
    });
    const handlers = await registeredHandlers();

    try {
      const opening = Promise.resolve(handlers.get('sparkii:abortChat')!(null, 's-private'));
      await waitUntil(() => rt.pool.acquire.mock.calls.length === 1);
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' })))
        .resolves.toMatchObject({ ok: true });
      expect(rt.pool.cancelAcquire).toHaveBeenCalledWith('s-private');
      expect(memory.deleteMemory).toHaveBeenCalledTimes(1);
      finishAcquisition();
      await expect(opening).rejects.toThrow('opening was cancelled');
      expect(rt.pool.release).toHaveBeenCalledWith('s-private', 1);
      expect(rt.pool.getBinding('s-private')).toBeUndefined();
      expect(client.send).not.toHaveBeenCalled();
    } finally {
      finishAcquisition();
    }
  });

  it('R8 final review releases a stale setChatTitle acquisition after privacy deletion starts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishAcquisition!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => { finishAcquisition = resolve; });
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const client = { send: vi.fn(async () => ({ success: true })) };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client,
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    const acquire = rt.pool.acquire.getMockImplementation()!;
    rt.pool.acquire.mockImplementation(async (sessionId, options) => {
      await acquisitionGate;
      return acquire(sessionId, options);
    });
    const handlers = await registeredHandlers();

    try {
      const renaming = handlers.get('sparkii:setChatTitle')!(null, 's-private', 'private title', 'user');
      await waitUntil(() => rt.pool.acquire.mock.calls.length === 1);
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' })))
        .resolves.toMatchObject({ ok: true });
      expect(rt.pool.cancelAcquire).toHaveBeenCalledWith('s-private');
      expect(memory.deleteMemory).toHaveBeenCalledTimes(1);
      finishAcquisition();
      await expect(renaming).resolves.toEqual({ ok: true });
      expect(rt.pool.release).toHaveBeenCalledWith('s-private', 1);
      expect(rt.pool.getBinding('s-private')).toBeUndefined();
      expect(client.send).not.toHaveBeenCalled();
    } finally {
      finishAcquisition();
    }
  });

  it('R8-P0-2 never releases a same-client replacement installed while a stale acquisition resumes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
    dirs.push(dataDir);
    let finishAcquisition!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => { finishAcquisition = resolve; });
    const memory = {
      setEmitter: vi.fn(),
      buildBlock: vi.fn(() => null),
      getSettings: vi.fn(() => ({ enabled: false })),
      privacySourceSessionFor: vi.fn(() => 's-private'),
      privacyDeletePending: vi.fn(() => false),
      deleteMemory: vi.fn(() => ({ ok: true, removed: ['m-private'] })),
    };
    const client = { send: vi.fn(async () => ({ success: true })) };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client,
      chatSession: { profileId: 'general', model: null },
      memory,
    });
    const acquire = rt.pool.acquire.getMockImplementation()!;
    rt.pool.acquire.mockImplementation(async (sessionId, options) => {
      await acquisitionGate;
      const stale = await acquire(sessionId, options);
      await rt.pool.release(sessionId, stale.lease);
      await acquire(sessionId, options);
      return stale;
    });
    const handlers = await registeredHandlers();

    try {
      const opening = Promise.resolve(handlers.get('sparkii:abortChat')!(null, 's-private'));
      await waitUntil(() => rt.pool.acquire.mock.calls.length === 1);
      await expect(Promise.resolve(handlers.get('sparkii:deleteMemory')!(null, 'm-private', { mode: 'privacy' })))
        .resolves.toMatchObject({ ok: true });
      finishAcquisition();
      await expect(opening).rejects.toThrow();
      expect(rt.pool.release).toHaveBeenCalledTimes(1);
      expect(rt.pool.release).toHaveBeenCalledWith('s-private', 1);
      expect(rt.pool.getBinding('s-private')).toEqual({ client, lease: 2 });
      expect(client.send).not.toHaveBeenCalled();
    } finally {
      finishAcquisition();
    }
  });
});

describe('retired task capability IPC', () => {
  it('does not expose task capability or user revocation handlers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-capability-'));
    dirs.push(dataDir);
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) },
      security: {
        taskGrants: { onRevoke: () => () => {} },
        hostShellReport: {
          backend: 'host-git-bash',
          status: 'unavailable',
          executionBoundary: 'host',
          version: 'host-job-v1',
          limitations: ['Git Bash unavailable'],
        },
      },
    });
    expect(rt).toBeTruthy();
    const handlers = await registeredHandlers();
    expect(handlers.has('sparkii:getTaskCapabilities')).toBe(false);
    expect(handlers.has('sparkii:revokeTaskCapabilities')).toBe(false);
  });
});

describe('permission mode IPC', () => {
  function securityStub(options: { withReviewer?: boolean } = {}) {
    const auditEvents: Array<Record<string, unknown>> = [];
    const review = vi.fn(async () => ({ decision: 'allow', risk: 'low', reason: 'ok' }));
    const security: Record<string, unknown> = {
      profilePolicies: new Map([['general', {
        defaultPermissionMode: 'ask',
        allowedPermissionModes: ['ask', 'auto_review'],
      }]]),
      hostShellReport: {
        backend: 'host-git-bash',
        status: 'available',
        executionBoundary: 'host',
        version: 'host-job-v1',
        limitations: ['宿主执行，不是操作系统沙箱', '网络能力由宿主进程决定'],
      },
      reviewerModel: 'deepseek-v4-flash',
      reviewerPolicyVersion: 'shell-review-v1',
      shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
      taskLifecycle: { active: vi.fn(() => undefined), end: vi.fn(async () => {}) },
      taskGrants: { onRevoke: () => () => {} },
    };
    if (options.withReviewer !== false) {
      security.reviewer = { review, cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    }
    return { auditEvents, review, security };
  }

  async function permissionRuntime(
    stub: ReturnType<typeof securityStub>,
    permissionMode = 'ask',
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-permission-'));
    dirs.push(dataDir);
    const sessions = new Map<string, Record<string, unknown>>([
      ['s1', {
        id: 's1',
        profileId: 'general',
        workspaceKind: 'auto',
        workspacePath: 'C:/ws',
        permissionMode,
      }],
    ]);
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: { send: async () => ({ success: true }) },
      security: stub.security,
      audit: {
        append: async (event: unknown) => {
          stub.auditEvents.push(event as Record<string, unknown>);
          return event;
        },
      },
    });
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    (rt as any).chatSessions.update = (id: string, patch: Record<string, unknown>) => {
      const current = sessions.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      sessions.set(id, next);
      return next;
    };
    return rt;
  }

  it('reads the session permission mode and host semantics without leaking credentials', async () => {
    const stub = securityStub();
    await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    const state = await handlers.get('sparkii:getPermissionModeState')!(null, 'general', 's1') as any;
    expect(state).toMatchObject({
      mode: 'ask',
      allowedModes: ['ask', 'auto_review'],
      taskActive: false,
      hostShellAvailable: true,
      reviewerAvailable: true,
    });
    expect(state.limitations.join(' ')).toContain('宿主');
    expect(state).not.toHaveProperty('pid');
    expect(state).not.toHaveProperty('apiKey');
    expect(JSON.stringify(state)).not.toMatch(/api-?key|authorization|token|secret|sk-/i);
  });

  it('writes the mode, ends the running task and audits the change', async () => {
    const stub = securityStub();
    const rt = await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    expect(await handlers.get('sparkii:setChatPermissionMode')!(null, 's1', 'auto_review'))
      .toEqual({ ok: true, mode: 'auto_review' });
    expect(rt.chatSessions.get('s1')?.permissionMode).toBe('auto_review');
    expect(stub.security.taskLifecycle.end).toHaveBeenCalledWith('s1', 'permission-mode-changed', undefined);
    expect(stub.auditEvents).toContainEqual(expect.objectContaining({
      action: 'permission-mode.changed',
      sessionId: 's1',
    }));
    const state = await handlers.get('sparkii:getPermissionModeState')!(null, 'general', 's1') as any;
    expect(state.mode).toBe('auto_review');
  });

  it('revokes the shell task grant when the mode changes', async () => {
    const stub = securityStub();
    stub.security.taskLifecycle.active = vi.fn(() => ({
      taskId: 'task-9',
      sessionId: 's1',
      permissionMode: 'auto_review',
    }));
    await permissionRuntime(stub, 'auto_review');
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:setChatPermissionMode')!(null, 's1', 'ask');
    expect(stub.security.shellGrants.revoke).toHaveBeenCalledWith('task-9');
  });

  it('R8 review runtime B8 persists the mode and revokes the original grant before cancellation awaits', async () => {
    const stub = securityStub();
    const oldAdmission = { sessionId: 's1', generation: 1 };
    const replacementAdmission = { sessionId: 's1', generation: 2 };
    let admission: unknown = oldAdmission;
    let active: any = { taskId: 'old-task', sessionId: 's1', permissionMode: 'ask' };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const lifecycle = stub.security.taskLifecycle as any;
    lifecycle.active = vi.fn(() => active);
    lifecycle.currentAdmission = vi.fn(() => admission);
    lifecycle.end = vi.fn(async (_sessionId: string, _reason: string, captured?: unknown) => {
      entered();
      await blocked;
      if (captured === oldAdmission && admission === oldAdmission) active = undefined;
    });
    const rt = await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    const changing = handlers.get('sparkii:setChatPermissionMode')!(null, 's1', 'auto_review');
    try {
      await started;
      expect((stub.security as any).taskLifecycle.end).toHaveBeenCalledWith('s1', 'permission-mode-changed', oldAdmission);
      expect(stub.security.shellGrants.revoke).toHaveBeenCalledWith('old-task');
      expect(rt.chatSessions.get('s1')?.permissionMode).toBe('auto_review');
      admission = replacementAdmission;
      active = { taskId: 'replacement-task', sessionId: 's1', permissionMode: 'auto_review' };
    } finally {
      release();
    }
    await changing;
    expect(lifecycle.active()).toMatchObject({ taskId: 'replacement-task' });
    expect(stub.security.shellGrants.revoke).not.toHaveBeenCalledWith('replacement-task');
  });

  it('refuses a permission mode the profile does not allow', async () => {
    const stub = securityStub();
    stub.security.profilePolicies = new Map([['general', {
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
    }]]);
    await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    const out = await handlers.get('sparkii:setChatPermissionMode')!(null, 's1', 'auto_review') as any;
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/not allowed/);
  });

  it('reports the reviewer as unavailable when Main has no worker', async () => {
    const stub = securityStub({ withReviewer: false });
    await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    const state = await handlers.get('sparkii:getPermissionModeState')!(null, 'general', 's1') as any;
    expect(state.reviewerAvailable).toBe(false);
    expect(state.mode).toBe('ask');
  });

  it('does not expose the Reviewer worker in the user runtime pool', async () => {
    const stub = securityStub();
    await permissionRuntime(stub);
    const handlers = await registeredHandlers();
    const pool = await handlers.get('sparkii:getRuntimePool')!(null);
    expect(JSON.stringify(pool)).not.toContain('reviewer');
    expect(JSON.stringify(pool)).not.toContain('shell-review');
  });

  it('runs an approved shell command through the host adapter and reports host semantics', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-host-shell-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });

    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: async (target: string) => ({
        displayPath: target,
        canonicalPath: target,
        identity: `object:${key(target)}`,
        nearestExistingAncestor: target,
        isDirectory: true,
        isReparsePoint: false,
        exists: true,
      }),
      isSameOrDescendant: async (root: string, target: string) => {
        const r = key(root);
        const t = key(target);
        return t === r || t.startsWith(`${r}/`);
      },
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };

    const executionOrder: string[] = [];
    const ensureWorkspace = vi.fn(async () => {
      executionOrder.push('ensure-workspace');
      return {
        displayPath: 'C:/ws',
        canonicalPath: 'C:/ws',
        identity: 'object:c:/ws',
        nearestExistingAncestor: 'C:/ws',
        isDirectory: true,
        isReparsePoint: false,
        exists: true,
      };
    });
    const run = vi.fn(async () => {
      executionOrder.push('shell-run');
      return {
        exitCode: 0,
        timedOut: false,
        stdout: 'host-ok',
        stderr: '',
        truncated: { stdout: false, stderr: false },
      };
    });
    let liveGrant: { taskId: string; sessionId: string; workspaceIdentity: string } | undefined;
    const review = vi.fn(async () => ({ decision: 'allow', risk: 'low', reason: '普通测试命令' }));
    const auditEvents: Array<Record<string, unknown>> = [];
    const stub = securityStub();
    Object.assign(stub.security, {
      pathProbe,
      protectedRoots: [],
      scratchParent: join(dataDir, 'tasks'),
      actionNormalizer: createActionNormalizer({
        descriptors: DEFAULT_TOOL_DESCRIPTORS,
        protectedRoots: [],
        probe: pathProbe,
      }),
      workspaceExecutor: {
        execute: vi.fn(async () => ({ path: 'C:/ws/a.txt', changes: [] })),
        ensureWorkspace,
        liveWorkspaceIdentity: () => undefined,
      },
      capabilityGateway: { revokeTask: vi.fn(), issue: vi.fn(), execute: vi.fn() },
      platformReadyFor: (action: { capability: string }) =>
        action.capability === 'fs.read'
        || action.capability === 'fs.write'
        || (action.capability === 'process.exec'
          && stub.security.hostShellReport.status === 'available'),
      taskLifecycle: {
        start: vi.fn(async (factory: () => Promise<any>, _beforeCommit?: () => void, onStarted?: (created: any) => void) => {
          const created = await factory();
          liveGrant = created;
          onStarted?.(created);
          return created;
        }),
        active: vi.fn(() => liveGrant),
        assertActive: vi.fn(() => liveGrant),
        end: vi.fn(async () => { liveGrant = undefined; }),
        registerCancellation: vi.fn(() => () => {}),
      },
      hostShell: { run, probe: async () => stub.security.hostShellReport, terminate: vi.fn(async () => {}) },
      reviewer: { review, cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
    });

    const listeners = new Set<(event: any) => void>();
    const client = {
      onEvent: (cb: (event: any) => void) => {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
      },
      send: async (command: any) => {
        if (command.type === 'new_session') return { success: true };
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's-host', sessionFile: 'C:/pi/s.jsonl', isStreaming: false } };
        }
        return { success: true };
      },
    };
    const sessions = new Map<string, Record<string, unknown>>();
    const rt = await makeRuntime({
      dataDir,
      piAgentDir,
      client,
      security: stub.security,
      audit: {
        append: async (event: unknown) => {
          auditEvents.push(event as Record<string, unknown>);
          return event;
        },
      },
      profile: {
        dir: join(dataDir, 'profiles', 'general'),
        profile: {
          manifest: { name: 'general', displayName: '通用智能体' },
          security: {
            approval: {
              requireApproval: [],
              timeoutMs: 60_000,
              highRiskDoubleConfirm: true,
              defaultPermissionMode: 'ask',
              allowedPermissionModes: ['ask', 'auto_review'],
            },
          },
          agent: { tools: ['bash'], prompts: { system: 'sys' } },
        },
        router: { resolve: () => undefined },
      } as any,
    });
    (rt as any).chatSessions.create = (rec: Record<string, unknown>) => {
      sessions.set(String(rec.id), { ...rec, permissionMode: 'auto_review' });
    };
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;

    const handlers = await registeredHandlers();
    const opened = await handlers.get('sparkii:promptSession')!(null, null, '跑一下测试', undefined, [], {
      profileId: 'general',
      workspaceKind: 'user',
      workspacePath: 'C:/ws',
    });
    expect(opened).toMatchObject({ ok: true, sessionId: 's-host' });

    // The Task started for this session must carry the stored permission mode.
    expect(liveGrant).toMatchObject({
      sessionId: 's-host',
      profileId: 'general',
      permissionMode: 'auto_review',
      planMode: 'execute',
      actorId: 'tester',
      unattended: false,
    });

    const onAction = (rt as any).__onAction as (request: unknown) => Promise<any>;
    expect(typeof onAction).toBe('function');
    const result = await onAction({ requestId: 'r1', toolName: 'bash', args: { command: 'pnpm test' } });

    expect(result).toMatchObject({
      requestId: 'r1',
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'reviewer.allow' },
    });
    expect(result.result).toMatchObject({
      exitCode: 0,
      output: 'host-ok',
      executionBoundary: 'host',
      backend: 'host-git-bash',
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: 'C:/ws',
      command: 'pnpm test',
    }));
    expect(executionOrder).toEqual(['ensure-workspace', 'shell-run']);
    expect(auditEvents).toContainEqual(expect.objectContaining({ action: 'reviewer.decision' }));
    expect(auditEvents).toContainEqual(expect.objectContaining({ action: 'action.executed' }));
    expect(JSON.stringify(result)).not.toMatch(/沙箱|sandbox/);
  });
});

describe('P10 relocateWorkspace IPC', () => {
  it('registers the channel, moves files, updates all session records and broadcasts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-reloc-'));
    dirs.push(dataDir);
    const piAgentDir = join(dataDir, 'pi-agent');
    await mkdir(piAgentDir, { recursive: true });
    const source = join(dataDir, 'ws-old');
    const target = join(dataDir, 'ws-new');
    await mkdir(join(source, 'input'), { recursive: true });
    await writeFile(join(source, 'input', 'a.txt'), 'hello', 'utf8');

    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: async (t: string) => ({
        displayPath: t, canonicalPath: t, identity: `object:${key(t)}`,
        nearestExistingAncestor: t, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      }),
      isSameOrDescendant: async (root: string, t: string) => {
        const r = key(root); const x = key(t);
        return x === r || x.startsWith(`${r}/`);
      },
      isSameObject: async (a: string, b: string) => key(a) === key(b),
    };
    const records = new Map<string, any>([
      ['s1', { id: 's1', profileId: 'bid-writing', workspacePath: source }],
      ['s2', { id: 's2', profileId: 'bid-writing', workspacePath: source }],
    ]);
    const windowSent: any[] = [];
    const security = {
      profilePolicies: new Map(), taskGrants: { onRevoke: () => () => {} },
      hostShellReport: { version: 'v1', status: 'available', backend: 'host', executionBoundary: 'host', limitations: [] },
      taskLifecycle: { active: vi.fn(() => undefined), end: vi.fn(async () => {}) },
      pathProbe, protectedRoots: [],
    };
    const rt = await makeRuntime({
      dataDir, piAgentDir,
      client: { send: async () => ({ success: true }) },
      security,
      audit: { append: vi.fn(async (e) => e) },
      getWindow: () => ({
        on: () => {}, isDestroyed: () => false,
        webContents: { send: (...args: unknown[]) => { windowSent.push(args); } },
      }) as any,
    });
    (rt as any).chatSessions.get = (id: string) => records.get(id);
    (rt as any).chatSessions.list = () => [...records.values()];
    (rt as any).chatSessions.updateWorkspacePathInTransaction = (o: string, n: string) => {
      for (const r of records.values()) if (r.workspacePath === o) r.workspacePath = n;
    };

    const handlers = await registeredHandlers();
    const relocate = handlers.get('sparkii:relocateWorkspace');
    expect(relocate).toBeTypeOf('function');

    // Target must exist and be empty (plan §5.1 step 5 contract).
    await mkdir(target, { recursive: true });
    const result = await relocate!(null, 's1', target);
    expect(result).toMatchObject({ ok: true });

    // Files moved, source removed, both session records updated.
    expect((await import('node:fs')).existsSync(join(target, 'input', 'a.txt'))).toBe(true);
    expect((await import('node:fs')).existsSync(source)).toBe(false);
    expect(records.get('s1').workspacePath.replace(/\\/g, '/')).toBe(target.replace(/\\/g, '/'));
    expect(records.get('s2').workspacePath.replace(/\\/g, '/')).toBe(target.replace(/\\/g, '/'));
    expect(windowSent.some((c) => c[0] === 'sparkii:event:workspace-relocated')).toBe(true);
  });
});

describe('R8 runtime binding regressions', () => {
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function bindingRuntime(options: {
    keyFor?: (providerId: string) => Promise<string | null>;
    client?: { send: (command: any) => Promise<any>; onEvent?: (cb: (event: any) => void) => () => void };
    security?: unknown;
    gate?: unknown;
    executor?: unknown;
    shellGrants?: ShellGrantStore;
    profile?: unknown;
    getWindow?: () => { webContents: { send: (...args: unknown[]) => void } } | null;
  } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-binding-'));
    dirs.push(dataDir);
    const workspacePath = join(dataDir, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
      activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash',
    }), 'utf8');
    const session = {
      id: 's1', profileId: 'general', kind: 'chat', workspaceKind: 'auto',
      workspacePath, model: null, thinkingLevel: null, piSessionFile: null,
      permissionMode: 'ask', inputs: [],
    };
    const client = options.client ?? {
      onEvent: () => () => {},
      send: vi.fn(async () => ({ success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } })),
    };
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client,
      keyFor: options.keyFor,
      chatSession: session,
      security: options.security,
      gate: options.gate,
      executor: options.executor,
      profile: options.profile,
      getWindow: options.getWindow,
    });
    (rt as any).chatSessions.get = (id: string) => id === session.id ? { ...session } : null;
    return { rt, handlers: await registeredHandlers(), dataDir, workspacePath };
  }

  async function replaceBinding(rt: Runtime) {
    const sessionId = 's1';
    const previous = rt.pool.getBinding(sessionId);
    if (!previous) throw new Error('missing original binding');
    await rt.pool.release(sessionId, previous.lease);
    const replacement = await rt.pool.acquire(sessionId);
    const binding = rt.pool.getBinding(sessionId);
    if (!binding || binding.client !== previous.client || binding.lease === previous.lease) {
      throw new Error('replacement binding was not installed');
    }
    return { sessionId, client: binding.client, previousLease: previous.lease, replacementLease: binding.lease };
  }

  it.each(['stop', 'workspace-change'] as const)(
    'R8 runtime round3 B1 cancels a pending production admission on %s',
    async (mode) => {
      const h = await exportRuntime();
      const admissionGate = deferred();
      const inspect = h.pathProbe.inspect.getMockImplementation()!;
      let admissions = 0;
      h.pathProbe.inspect.mockImplementation(async (target: string) => {
        admissions += 1;
        if (admissions === 1) await admissionGate.promise;
        return inspect(target);
      });
      const prompting = Promise.resolve(h.handlers.get('sparkii:promptSession')!(null, 's1', 'pending admission'));
      const rejected = expect(prompting).rejects.toThrow(/admission.*cancelled/i);
      await waitUntil(() => admissions === 1);
      const originalLease = h.rt.pool.getBinding('s1')?.lease;

      if (mode === 'stop') {
        await expect(h.handlers.get('sparkii:deleteChatSession')!(null, 's1')).resolves.toEqual({ ok: true });
      } else {
        await expect(h.handlers.get('sparkii:setChatWorkspace')!(null, 's1', join(h.dataDir, 'next-workspace')))
          .resolves.toEqual({ ok: true });
      }
      admissionGate.resolve();

      await rejected;
      expect(h.taskLifecycle.active('s1')).toBeUndefined();
      expect(h.sent.filter((command) => command.type === 'prompt')).toEqual([]);
      if (mode === 'stop') {
        expect(h.rt.pool.getBinding('s1')).toBeUndefined();
      } else {
        expect(h.sent.filter((command) => command.type === 'configure_session')).toHaveLength(1);
        expect(h.rt.pool.getBinding('s1')?.lease).toBe(originalLease);
      }
    },
  );

  it.each([
    { name: 'settings', channel: 'sparkii:prompt', args: ['旧提示词'] },
    { name: 'key', channel: 'sparkii:prompt', args: ['旧提示词'] },
    { name: 'model', channel: 'sparkii:setChatModel', args: ['s1', 'deepseek-v4-pro'] },
    { name: 'complete', channel: 'sparkii:completeText', args: ['s1', '旧补全'] },
  ])('R8 B1 rejects stale $name commands after a same-client replacement', async ({ name, channel, args }) => {
    const keyGate = deferred<string>();
    const settingsGate = deferred<Record<string, unknown>>();
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: vi.fn(async (command: any) => {
        sent.push(command);
        if (command.type === 'complete') return { success: true, data: '补全结果' };
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      }),
    };
    const keyFor = vi.fn(async () => keyGate.promise);
    const { rt, handlers } = await bindingRuntime({ client, keyFor });
    rt.profiles.set('general', rt.profileOf('general'));
    if (name === 'model' || name === 'complete') {
      keyFor.mockResolvedValue('sk-test');
      await handlers.get('sparkii:abortChat')!(null, 's1');
      sent.length = 0;
    }
    if (name === 'settings' || name === 'model' || name === 'complete') {
      let blocked = false;
      loadSettingsMock.mockImplementation(async () => {
        if (!blocked) {
          blocked = true;
          return settingsGate.promise;
        }
        return { activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' };
      });
    }
    let pending: Promise<unknown> | undefined;
    try {
      pending = Promise.resolve(handlers.get(channel)!(null, ...args));
      const entered = name === 'settings' || name === 'model' || name === 'complete'
        ? waitUntil(() => loadSettingsMock.mock.calls.length > 0)
        : waitUntil(() => keyFor.mock.calls.length > 0);
      const enteredResult = await Promise.race([
        entered.then(() => true),
        pending.then(() => false, () => false),
      ]);
      if (!enteredResult) throw new Error(`stale ${name} request finished before its deferred await`);
      const sessionId = vi.mocked(rt.pool.acquire).mock.calls[0][0] as string;
      const oldLease = rt.pool.getBinding(sessionId)?.lease;
      expect(oldLease).toBeTypeOf('number');
      await rt.pool.release(sessionId, oldLease);
      await rt.pool.acquire(sessionId);
      const replacementLease = rt.pool.getBinding(sessionId)?.lease;
      expect(replacementLease).not.toBe(oldLease);
      if (settingsGate) settingsGate.resolve({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' });
      keyGate.resolve('sk-test');
      await expect(pending).rejects.toThrow('is no longer bound');
      expect(sent).toEqual([]);
      expect(rt.pool.getBinding(sessionId)).toEqual({ client, lease: replacementLease });
      expect(rt.pool.release).toHaveBeenLastCalledWith(sessionId, oldLease);
      expect(rt.chatSessions.update).not.toHaveBeenCalledWith('s1', expect.objectContaining({ model: expect.any(String) }));
    } finally {
      settingsGate?.resolve({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' });
      keyGate.resolve('sk-test');
      await pending.catch(() => {});
    }
  });

  it('R8 B1 rejects a stale key lookup before writing the original prompt', async () => {
    const keyGate = deferred<string>();
    const sent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: vi.fn(async (command: any) => {
        sent.push(command);
        return { success: true };
      }),
    };
    const keyFor = vi.fn(async () => keyGate.promise);
    const { rt, handlers } = await bindingRuntime({ client, keyFor });
    rt.profiles.set('general', rt.profileOf('general'));
    randomUUIDControl.set('R8-B1-KEY-SESSION');
    const pending = Promise.resolve(handlers.get('sparkii:prompt')!(null, '旧提示词'));
    await waitUntil(() => keyFor.mock.calls.length === 1);
    const oldLease = rt.pool.getBinding('R8-B1-KEY-SESSION')!.lease;
    await rt.pool.release('R8-B1-KEY-SESSION', oldLease);
    await rt.pool.acquire('R8-B1-KEY-SESSION');
    const replacementLease = rt.pool.getBinding('R8-B1-KEY-SESSION')!.lease;
    keyGate.resolve('sk-test');

    await expect(pending).rejects.toThrow('session R8-B1-KEY-SESSION is no longer bound');
    expect(sent).toEqual([]);
    expect(rt.pool.getBinding('R8-B1-KEY-SESSION')).toEqual({ client, lease: replacementLease });
    expect(rt.pool.release).toHaveBeenLastCalledWith('R8-B1-KEY-SESSION', oldLease);
  });

  it('R8 B1 does not overwrite a replacement model while set_model is deferred', async () => {
    const sent: any[] = [];
    const windowSent: any[] = [];
    const client = {
      onEvent: () => () => {},
      send: vi.fn(async (command: any) => {
        sent.push(command);
        return { success: true };
      }),
    };
    const { rt, handlers } = await bindingRuntime({
      client,
      keyFor: async () => 'sk-test',
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { windowSent.push(args); } } }) as any,
    });
    await handlers.get('sparkii:abortChat')!(null, 's1');
    sent.length = 0;
    windowSent.length = 0;
    let deferModels = false;
    let resolveModel!: () => void;
    const modelGate = new Promise<void>((resolve) => { resolveModel = resolve; });
    client.send.mockImplementation(async (command: any) => {
      sent.push(command);
      if (deferModels && command.type === 'set_model') await modelGate;
      return { success: true };
    });
    deferModels = true;
    const pending = Promise.resolve(handlers.get('sparkii:setChatModel')!(null, 's1', 'deepseek-v4-pro'));
    const staleRejection = expect(pending).rejects.toThrow('session s1 is no longer bound');
    await waitUntil(() => sent.some((command) => command.type === 'set_model'));
    const oldLease = rt.pool.getBinding('s1')!.lease;
    await rt.pool.release('s1', oldLease);
    await handlers.get('sparkii:abortChat')!(null, 's1');
    const replacementLease = rt.pool.getBinding('s1')?.lease;
    expect(replacementLease).not.toBe(oldLease);
    expect(rt.chatSessions.get('s1')?.model).toBeNull();
    deferModels = false;
    resolveModel();
    await handlers.get('sparkii:setChatModel')!(null, 's1', 'deepseek-v4-flash');

    await staleRejection;
    expect(sent.filter((command) => command.type === 'set_model')).toEqual([
      { type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      { type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    ]);
    expect(rt.chatSessions.update).not.toHaveBeenCalledWith('s1', { model: 'deepseek/deepseek-v4-pro' });
    expect(rt.chatSessions.update).toHaveBeenCalledWith('s1', { model: 'deepseek/deepseek-v4-flash' });
    expect(windowSent.filter(([, event]) => event?.type === 'model_change')).toEqual([
      ['sparkii:event:chat-event', { type: 'model_change', sessionId: 's1', provider: 'deepseek', modelId: 'deepseek-v4-flash' }],
    ]);
    expect(rt.pool.getBinding('s1')).toEqual({ client, lease: replacementLease });
  });

  it('R8 runtime round3 B4 stale abort cannot revoke or command a same-lease replacement task', async () => {
    const h = await exportRuntime();
    await h.handlers.get('sparkii:promptSession')!(null, 's1', 'original task');
    const originalTask = h.taskLifecycle.active('s1');
    const originalLease = h.rt.pool.getBinding('s1')?.lease;
    expect(originalTask).toBeTruthy();
    const terminateGate = deferred();
    const terminate = (h.rt as any).security.hostShell.terminate as ReturnType<typeof vi.fn>;
    terminate.mockImplementationOnce(async () => terminateGate.promise);
    h.sent.length = 0;

    const aborting = Promise.resolve(h.handlers.get('sparkii:abortChat')!(null, 's1'));
    await waitUntil(() => terminate.mock.calls.length === 1);
    // The aborted turn is explicitly terminal before the replacement is armed;
    // its cancellation hook may still be draining in parallel.
    h.client.emit({ type: 'agent_settled', aborted: true });
    await expect(h.handlers.get('sparkii:promptSession')!(null, 's1', 'replacement task'))
      .resolves.toMatchObject({ ok: true });
    const replacementTask = h.taskLifecycle.active('s1');
    expect(replacementTask?.taskId).not.toBe(originalTask?.taskId);
    const commandsBeforeRelease = h.sent.map((command) => command.type);
    terminateGate.resolve();

    await expect(aborting).rejects.toThrow(/admission.*no longer current/i);
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTask?.taskId);
    expect(h.rt.pool.getBinding('s1')?.lease).toBe(originalLease);
    expect(h.sent.map((command) => command.type)).toEqual(commandsBeforeRelease);
    expect(commandsBeforeRelease.filter((type) => type === 'prompt')).toEqual(['prompt']);
    expect(commandsBeforeRelease).not.toContain('clear_queue');
    expect(commandsBeforeRelease).not.toContain('abort');
    expect(terminate).toHaveBeenCalledWith(originalTask?.taskId);
  });

  it.each([
    { name: 'thinking', command: 'set_thinking_level' },
    { name: 'workspace', command: 'configure_session' },
  ] as const)('R8 runtime round3 B4 rejects stale %s commands after a same-client rebind', async ({ name, command }) => {
    const commandGate = deferred();
    let deferCommand = true;
    const client = new FakeHandle(async (request: any) => {
      if (deferCommand && request.type === command) await commandGate.promise;
      return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
    });
    const { rt, handlers, dataDir } = await bindingRuntime({ client });
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'open-original' });
    const pending = Promise.resolve(name === 'thinking'
      ? handlers.get('sparkii:setChatThinkingLevel')!(null, 's1', 'low')
      : handlers.get('sparkii:setChatWorkspace')!(null, 's1', join(dataDir, 'old-workspace')));
    await waitUntil(() => client.send.mock.calls.some(([request]) => request.type === command));
    const oldCommand = client.send.mock.calls.find(([request]) => request.type === command)?.[0];
    expect(oldCommand).toBeTruthy();

    deferCommand = false;
    await replaceBinding(rt);
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'open-replacement' });
    const replacementLease = rt.pool.getBinding('s1')?.lease;
    client.send.mockClear();
    if (name === 'thinking') {
      await expect(handlers.get('sparkii:setChatThinkingLevel')!(null, 's1', 'high')).resolves.toEqual({ ok: true });
    } else {
      await expect(handlers.get('sparkii:setChatWorkspace')!(null, 's1', join(dataDir, 'replacement-workspace')))
        .resolves.toEqual({ ok: true });
    }
    const replacementCommands = client.send.mock.calls.map(([request]) => request);
    expect(replacementCommands.map((request) => request.type)).toEqual([command]);
    commandGate.resolve();

    await expect(pending).rejects.toThrow('session s1 is no longer bound');
    expect(client.send.mock.calls.map(([request]) => request)).toEqual(replacementCommands);
    expect(rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
    if (name === 'thinking') {
      const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
      expect(settings.modelThinkingLevels['deepseek/deepseek-v4-flash']).toBe('high');
      expect(rt.chatSessions.update).toHaveBeenLastCalledWith('s1', { thinkingLevel: 'high' });
    } else {
      expect(rt.chatSessions.update).toHaveBeenLastCalledWith('s1', {
        workspaceKind: 'user', workspacePath: join(dataDir, 'replacement-workspace'),
      });
    }
  });

  it('R8 runtime round3 B4 rejects a stale workflow journal after its append await', async () => {
    const journalGate = deferred();
    let deferJournal = true;
    const client = new FakeHandle(async (command: any) => {
      if (deferJournal && command.type === 'append_workflow_entry') await journalGate.promise;
      return { success: true };
    });
    const { rt, handlers } = await bindingRuntime({ client });
    const stale = Promise.resolve(handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'stale' }));
    await waitUntil(() => client.send.mock.calls.some(([command]) => command.type === 'append_workflow_entry'));
    const staleCommand = client.send.mock.calls[0][0];
    expect(staleCommand).toEqual({
      type: 'append_workflow_entry', customType: 'workflow_state', data: { action: 'stale' },
    });

    deferJournal = false;
    await replaceBinding(rt);
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'replacement' });
    const finalLease = rt.pool.getBinding('s1')?.lease;
    const commands = client.send.mock.calls.map(([command]) => command);
    expect(commands).toEqual([
      { type: 'append_workflow_entry', customType: 'workflow_state', data: { action: 'stale' } },
      { type: 'append_workflow_entry', customType: 'workflow_state', data: { action: 'replacement' } },
    ]);
    journalGate.resolve();

    await expect(stale).rejects.toThrow('session s1 is no longer bound');
    expect(client.send.mock.calls.map(([command]) => command)).toEqual(commands);
    expect(rt.pool.getBinding('s1')).toEqual({ client, lease: finalLease });
  });

  it('R8 runtime round3 B4 relocation cannot configure a replacement binding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-round3-relocate-'));
    dirs.push(dataDir);
    const source = join(dataDir, 'ws-old');
    const target = join(dataDir, 'ws-new');
    await mkdir(join(source, 'input'), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, 'input', 'a.txt'), 'hello', 'utf8');
    const configureGate = deferred();
    let deferConfigure = true;
    const client = new FakeHandle(async (command: any) => {
      if (deferConfigure && command.type === 'configure_session') await configureGate.promise;
      return { success: true };
    });
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: async (value: string) => ({
        displayPath: value, canonicalPath: value, identity: `object:${key(value)}`,
        nearestExistingAncestor: value, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      }),
      isSameOrDescendant: async (root: string, value: string) => {
        const r = key(root); const v = key(value);
        return v === r || v.startsWith(`${r}/`);
      },
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const records = new Map<string, any>([
      ['s1', { id: 's1', profileId: 'general', workspacePath: source }],
    ]);
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'), client,
      chatSession: { profileId: 'general', model: null },
      security: {
        profilePolicies: new Map(), taskGrants: { onRevoke: () => () => {} },
        hostShellReport: { version: 'v1', status: 'available', backend: 'host', executionBoundary: 'host', limitations: [] },
        taskLifecycle: { active: vi.fn(() => undefined), end: vi.fn(async () => {}) },
        pathProbe, protectedRoots: [],
      },
      audit: { append: vi.fn(async (event) => event) },
    });
    (rt as any).chatSessions.get = (id: string) => records.get(id);
    (rt as any).chatSessions.list = () => [...records.values()];
    (rt as any).chatSessions.updateWorkspacePathInTransaction = (oldPath: string, nextPath: string) => {
      for (const record of records.values()) if (record.workspacePath === oldPath) record.workspacePath = nextPath;
    };
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'open-original' });
    client.send.mockClear();
    const relocating = Promise.resolve(handlers.get('sparkii:relocateWorkspace')!(null, 's1', target));
    await waitUntil(() => client.send.mock.calls.some(([command]) => command.type === 'configure_session'));
    expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(['configure_session']);

    deferConfigure = false;
    const replacement = await replaceBinding(rt);
    await handlers.get('sparkii:updateWorkflowState')!(null, 's1', { action: 'replacement' });
    const replacementLease = rt.pool.getBinding('s1')?.lease;
    const commands = client.send.mock.calls.map(([command]) => command.type);
    expect(commands).toEqual(['configure_session', 'append_workflow_entry']);
    configureGate.resolve();

    await expect(relocating).resolves.toMatchObject({ ok: false, code: 'REBIND_FAILED', keptBothCopies: true });
    expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(commands);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(target, 'input', 'a.txt'))).toBe(true);
    expect(rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
    expect(replacement.replacementLease).not.toBe(replacement.previousLease);
  });

  async function exportRuntime(clientOverride?: any, shellGrants?: ShellGrantStore) {
    const registry = new TaskGrantRegistry();
    const taskLifecycle = new TaskLifecycle(registry);
    const gate = new ApprovalGate({
      audit: {
        append: vi.fn(async (event: any) => event),
        query: vi.fn(async () => []),
        redactValue: vi.fn((value: unknown) => ({ value, redacted: false })),
        containsValue: vi.fn(() => false),
        redactText: vi.fn((value: string) => value),
        contains: vi.fn(() => false),
      } as any,
      policy: { requireApproval: ['report.export'], timeoutMs: 60_000, highRiskDoubleConfirm: true },
      rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
    });
    const approvalEvents: Proposal[] = [];
    const sent: any[] = [];
    const client = clientOverride ?? new FakeHandle(async (command: any) => {
      sent.push(command);
      return { success: true };
    });
    const workspacePath = join(tmpdir(), `ipc-export-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(workspacePath, { recursive: true });
    dirs.push(workspacePath);
    const scratchParent = join(tmpdir(), `ipc-export-scratch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(scratchParent);
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: vi.fn(async (target: string) => ({
        displayPath: target, canonicalPath: target, identity: `object:${key(target)}`,
        nearestExistingAncestor: target, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      })),
      isSameOrDescendant: async (root: string, target: string) => key(target) === key(root) || key(target).startsWith(`${key(root)}/`),
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const executor = { execute: vi.fn(async (proposal: Proposal) => ({ ...proposal, status: 'executed', execution: { ok: true } })) };
    const h = await bindingRuntime({
      client,
      gate,
      executor,
      shellGrants,
      security: {
        profilePolicies: new Map([['general', { defaultPermissionMode: 'ask', allowedPermissionModes: ['ask'] }]]),
        taskLifecycle, taskGrants: registry, pathProbe, protectedRoots: [], scratchParent,
        actionNormalizer: createActionNormalizer({ descriptors: DEFAULT_TOOL_DESCRIPTORS, protectedRoots: [], probe: pathProbe }),
        workspaceExecutor: {
          execute: vi.fn(async () => ({ result: { ok: true } })),
          ensureWorkspace: vi.fn(async () => ({
            displayPath: workspacePath, canonicalPath: workspacePath, identity: `object:${key(workspacePath)}`,
            nearestExistingAncestor: workspacePath, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
          })),
          liveWorkspaceIdentity: () => `object:${key(workspacePath)}`,
        },
        platformReadyFor: () => true,
        hostShell: { terminate: vi.fn(async () => {}) },
        reviewer: { cancel: vi.fn(async () => {}) },
        capabilityGateway: { issue: vi.fn(() => ({ id: 'lease', fingerprint: 'fingerprint' })), execute: vi.fn(async (_action, _lease, _grant, handler) => handler()), revokeTask: vi.fn() },
        shellGrants: shellGrants ?? { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
        hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      },
      profile: {
        dir: join(tmpdir(), 'ipc-export-profile'),
        profile: {
          manifest: { name: 'general' },
          security: { approval: { requireApproval: ['report.export'], timeoutMs: 60_000, highRiskDoubleConfirm: true } },
          agent: { tools: [], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      } as any,
      getWindow: () => ({
        on: () => {}, isDestroyed: () => false,
        webContents: { send: (channel: string, payload: Proposal) => {
          if (channel === 'sparkii:event:approval') approvalEvents.push(payload);
        } },
      }) as any,
    });
    const currentSession = h.rt.chatSessions.get('s1');
    (h.rt as any).chatSessions.get = () => ({ ...currentSession, workspacePath });
    return { ...h, registry, taskLifecycle, gate, pathProbe, approvalEvents, sent, client, executor, shellGrants };
  }

  it('R8 B1 serializes workflow A behind prompt B and denies late A envelopes after follow-up C', async () => {
    const shellGrants = new ShellGrantStore();
    const grantSpy = vi.spyOn(shellGrants, 'grant');
    const allowsSpy = vi.spyOn(shellGrants, 'allows');
    const client = new FakeHandle(async (command: any) => command.type === 'get_state'
      ? { success: true, data: { sessionId: 's-abc-origin', sessionFile: null, isStreaming: false } }
      : { success: true });
    const h = await exportRuntime(client, shellGrants);
    const profile = {
      dir: join(tmpdir(), 'ipc-origin-profile'),
      profile: {
        manifest: { name: 'general', displayName: '通用' },
        security: { approval: { timeoutMs: 60_000 } },
        agent: {
          tools: ['bash'], prompts: { system: 'test' },
          workflow: {
            version: 1, engine: 'linear',
            steps: [
              { id: 'draft', type: 'llm', template: 'WORKFLOW_A', inputs: {} },
              { id: 'review', type: 'human', inputs: {} },
            ],
          },
        },
      },
      router: { resolve: () => undefined },
    } as any;
    (h.rt as any).profileOf = () => profile;
    const handlers = await registeredHandlers();
    const prompt = handlers.get('sparkii:promptSession')!;
    const started = await handlers.get('sparkii:runWorkflow')!(null, 'general', {
      documents: [], workspacePath: join(tmpdir(), 'ipc-origin-workspace'),
    }) as { sessionId: string };
    const sessionId = started.sessionId;
    await waitUntil(() => client.send.mock.calls.some(([command]) => command.type === 'prompt'));
    const commands = () => client.send.mock.calls.map(([command]) => command as any);
    const promptA = commands().find((command) => command.type === 'prompt');
    expect(promptA.message).toBe('/skill:WORKFLOW_A {}');
    expect(promptA.promptId).toBeTypeOf('string');
    expect(promptA.originToken).toBeTypeOf('string');
    const originalAdmission = h.taskLifecycle.currentAdmission(sessionId);
    const originalTaskId = h.taskLifecycle.active(sessionId)?.taskId;
    const originalLease = h.rt.pool.getBinding(sessionId)?.lease;

    // B enters the same Main lane while A is live. It cannot replace A until
    // A's correlated terminal releases the queue.
    const pendingB = prompt(null, sessionId, 'PROMPT_B');
    await waitUntil(() => commands().filter((command) => command.type === 'get_state').length >= 3);
    expect(commands().some((command) => command.type === 'prompt' && command.message === 'PROMPT_B')).toBe(false);
    expect(h.taskLifecycle.currentAdmission(sessionId)).toBe(originalAdmission);
    client.emit({ type: 'agent_start' });
    client.emit({ type: 'agent_settled', aborted: false });
    await expect(pendingB).resolves.toMatchObject({ ok: true });
    await waitUntil(() => commands().some((command) => command.type === 'prompt' && command.message === 'PROMPT_B'));
    const promptB = commands().find((command) => command.type === 'prompt' && command.message === 'PROMPT_B');
    expect(promptB.promptId).not.toBe(promptA.promptId);
    expect(promptB.originToken).not.toBe(promptA.originToken);
    const taskBC = h.taskLifecycle.active(sessionId)?.taskId;
    expect(taskBC).toBeTruthy();
    expect(taskBC).not.toBe(originalTaskId);

    // C is a follow-up on B, never a replacement Task. Give B/C a real shell
    // grant so an attribution bug would be observable as execution, not just
    // as a different denial message.
    shellGrants.grant(taskBC!, Date.now() + 60_000);
    const bindingBeforeC = h.rt.pool.getBinding(sessionId);
    await expect(prompt(null, sessionId, 'PROMPT_C', { behavior: 'followUp' }))
      .resolves.toMatchObject({ ok: true, behavior: 'followUp' });
    const followUpC = commands().find((command) => command.type === 'follow_up' && command.message === 'PROMPT_C');
    expect(followUpC).toMatchObject({ promptId: promptB.promptId, originToken: promptB.originToken });
    expect(commands().some((command) => command.type === 'prompt' && command.message === 'PROMPT_C')).toBe(false);
    expect(h.taskLifecycle.active(sessionId)?.taskId).toBe(taskBC);
    expect(h.taskLifecycle.currentAdmission(sessionId)).not.toBe(originalAdmission);
    expect(h.rt.pool.getBinding(sessionId)).toEqual(bindingBeforeC);
    expect(h.rt.pool.getBinding(sessionId)?.lease).toBe(originalLease);
    expect((client as any).sessionGeneration()).toBe(0);

    const submitSpy = vi.spyOn(h.gate, 'submit');
    const approvalCount = h.approvalEvents.length;
    const grantCount = grantSpy.mock.calls.length;
    const allowsCount = allowsSpy.mock.calls.length;
    const lateAction = await (h.rt as any).__onAction({
      requestId: 'late-a-action', toolName: 'bash', args: { command: 'echo MUST_NOT_EXECUTE' },
    }, promptA.originToken);
    const lateProposal = await (h.rt as any).__onProposal({
      requestId: 'late-a-proposal', toolName: 'memory_forget', targetSystem: 'memory',
      summary: 'forget', payload: {}, risk: 'high-risk', executionMode: 'caller',
    }, promptA.originToken).then((value: unknown) => value, (error: unknown) => error);
    const lateConnector = await (h.rt as any).__onConnectorRead({
      requestId: 'late-a-connector', toolName: 'document.read', args: { documents: [join(tmpdir(), 'a.docx')] },
    }, promptA.originToken);

    expect(lateAction).toMatchObject({ status: 'denied', error: { code: 'ORIGIN_REQUIRED' } });
    expect(lateProposal).toBeInstanceOf(Error);
    expect((lateProposal as Error).message).toMatch(/origin.*not executable/i);
    expect(lateConnector).toMatchObject({ ok: false, error: { code: 'ORIGIN_REQUIRED' } });
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect((h.rt.security as any).workspaceExecutor.execute).not.toHaveBeenCalled();
    expect(executeDocumentReadMock).not.toHaveBeenCalled();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(h.approvalEvents).toHaveLength(approvalCount);
    expect(grantSpy).toHaveBeenCalledTimes(grantCount);
    expect(allowsSpy).toHaveBeenCalledTimes(allowsCount);
    expect(shellGrants.allows(taskBC!)).toBe(true);
    expect(h.taskLifecycle.active(sessionId)?.taskId).toBe(taskBC);
    expect(h.registry.get(sessionId)?.taskId).toBe(taskBC);
    expect(h.rt.pool.getBinding(sessionId)).toEqual(bindingBeforeC);
  });


  it('R8 round5 blocker1 keeps the workflow proposal dispatcher bound to its original admission', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-workflow-proposal-'));
    dirs.push(dataDir);
    const workspacePath = join(dataDir, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const registry = new TaskGrantRegistry();
    const taskLifecycle = new TaskLifecycle(registry);
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: vi.fn(async (target: string) => ({
        displayPath: target, canonicalPath: target, identity: `object:${key(target)}`,
        nearestExistingAncestor: target, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      })),
      isSameOrDescendant: async (root: string, target: string) => {
        const r = key(root); const t = key(target); return t === r || t.startsWith(`${r}/`);
      },
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const proposals: any[] = [];
    let invalidate: ((proposal: any) => void) | undefined;
    const gate = {
      submit: vi.fn(async (request: any, meta: any) => {
        const proposal = { id: `proposal-${proposals.length + 1}`, ...request, ...meta, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
        proposals.push(proposal);
        return proposal;
      }),
      expire: vi.fn(async (id: string) => proposals.find((proposal) => proposal.id === id)),
      get: (id: string) => proposals.find((proposal) => proposal.id === id),
      onProposalInvalidated: (listener: (proposal: any) => void) => { invalidate = listener; return () => {}; },
    };
    const client = new FakeHandle(async (command: any) => command.type === 'get_state'
      ? { success: true, data: { sessionId: 'wf-r8-proposal', sessionFile: null, isStreaming: false } }
      : { success: true });
    const profile = {
      dir: join(dataDir, 'profiles', 'general'),
      profile: {
        manifest: { name: 'general', displayName: '通用' },
        security: { approval: { timeoutMs: 60_000 } },
        agent: { tools: ['read'], prompts: { system: 'test' }, workflow: { version: 1, engine: 'linear', steps: [{ id: 'wait', type: 'human', inputs: {} }] } },
      },
      router: { resolve: () => undefined },
    } as any;
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'), client, profile, gate,
      security: {
        profilePolicies: new Map([['general', { defaultPermissionMode: 'ask', allowedPermissionModes: ['ask'] }]]),
        taskLifecycle, taskGrants: registry, pathProbe, protectedRoots: [], scratchParent: dataDir,
        hostShell: { terminate: vi.fn(async () => {}) },
        reviewer: { cancel: vi.fn(async () => {}) },
        capabilityGateway: { issue: vi.fn(() => ({ id: 'lease', fingerprint: 'fingerprint' })), execute: vi.fn(async (_action, _lease, _grant, handler) => handler()), revokeTask: vi.fn() },
        shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
        hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      },
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: vi.fn() } }) as any,
    });
    const sessions = new Map<string, any>();
    (rt as any).chatSessions.create = (record: any) => sessions.set(record.id, record);
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    const started = await handlers.get('sparkii:runWorkflow')!(null, 'general', { documents: [], workspacePath });
    const sessionId = (started as any).sessionId as string;
    await waitUntil(() => proposals.length === 1 && taskLifecycle.active(sessionId) !== undefined);
    const originalTaskId = taskLifecycle.active(sessionId)?.taskId;
    await taskLifecycle.start(async () => ({
      taskId: 'replacement-task', sessionId, agentId: 'general', profileId: 'general', actorId: 'tester', unattended: false,
      planMode: 'execute', permissionMode: 'ask', workspaceRoot: workspacePath, workspaceIdentity: `object:${key(workspacePath)}`,
      inputRoots: [], scratchRoot: join(dataDir, 'replacement-scratch'), networkDomains: [], externalCapabilities: [],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }), undefined, undefined, sessionId);
    const onProposal = (rt as any).__onProposal as (request: unknown) => Promise<unknown>;
    let proposalSettled = false;
    const lateProposal = onProposal({
      requestId: 'late-original-proposal', toolName: 'memory_forget', targetSystem: 'memory',
      summary: 'forget', payload: {}, risk: 'high-risk', executionMode: 'caller',
    }).then((decision) => { proposalSettled = true; return { decision }; }, (error: unknown) => { proposalSettled = true; return { error }; });
    await waitUntil(() => proposals.length === 2 || proposalSettled);
    for (const proposal of [...proposals]) invalidate?.(proposal);
    const outcome = await lateProposal;

    expect(outcome).toHaveProperty('error');
    expect((outcome as any).error).toMatchObject({ message: expect.stringMatching(/origin.*not executable/i) });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].taskId).toBe(originalTaskId);
    expect(taskLifecycle.active(sessionId)?.taskId).toBe('replacement-task');
    client.emit({ type: 'agent_settled', aborted: false });
  });

  async function workflowCleanupRuntime(sessionId: string) {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-workflow-cleanup-'));
    dirs.push(dataDir);
    const workspacePath = join(dataDir, 'workspace');
    await mkdir(workspacePath, { recursive: true });
    const registry = new TaskGrantRegistry();
    const taskLifecycle = new TaskLifecycle(registry);
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: vi.fn(async (target: string) => ({
        displayPath: target, canonicalPath: target, identity: `object:${key(target)}`,
        nearestExistingAncestor: target, isDirectory: true, isReparsePoint: false, exists: true, linkCount: 1,
      })),
      isSameOrDescendant: async (root: string, target: string) => {
        const r = key(root); const t = key(target); return t === r || t.startsWith(`${r}/`);
      },
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const proposals: any[] = [];
    let invalidate: ((proposal: any) => void) | undefined;
    const gate = {
      submit: vi.fn(async (request: any, meta: any) => {
        const proposal = { id: `proposal-${proposals.length + 1}`, ...request, ...meta, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
        proposals.push(proposal);
        return proposal;
      }),
      expire: vi.fn(async (id: string) => proposals.find((proposal) => proposal.id === id)),
      get: (id: string) => proposals.find((proposal) => proposal.id === id),
      onProposalInvalidated: (listener: (proposal: any) => void) => { invalidate = listener; return () => {}; },
    };
    const client = new FakeHandle(async (command: any) => command.type === 'get_state'
      ? { success: true, data: { sessionId, sessionFile: null, isStreaming: false } }
      : { success: true });
    const profile = {
      dir: join(dataDir, 'profiles', 'general'),
      profile: {
        manifest: { name: 'general', displayName: '通用' },
        security: { approval: { timeoutMs: 60_000 } },
        agent: { tools: ['read'], prompts: { system: 'test' }, workflow: { version: 1, engine: 'linear', steps: [{ id: 'wait', type: 'human', inputs: {} }] } },
      },
      router: { resolve: () => undefined },
    } as any;
    const events: any[] = [];
    const rt = await makeRuntime({
      dataDir, piAgentDir: join(dataDir, 'pi-agent'), client, profile, gate,
      security: {
        profilePolicies: new Map([['general', { defaultPermissionMode: 'ask', allowedPermissionModes: ['ask'] }]]),
        taskLifecycle, taskGrants: registry, pathProbe, protectedRoots: [], scratchParent: dataDir,
        hostShell: { terminate: vi.fn(async () => {}) },
        reviewer: { cancel: vi.fn(async () => {}) },
        capabilityGateway: { issue: vi.fn(() => ({ id: 'lease', fingerprint: 'fingerprint' })), execute: vi.fn(async (_action, _lease, _grant, handler) => handler()), revokeTask: vi.fn() },
        shellGrants: { allows: () => false, grant: vi.fn(), revoke: vi.fn(), clear: vi.fn() },
        hostShellReport: { backend: 'host-git-bash', status: 'available', executionBoundary: 'host', version: 'test', limitations: [] },
      },
      getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: (channel: string, payload: any) => {
        if (channel === 'sparkii:event:chat-event') events.push(payload);
      } } }) as any,
    });
    const sessions = new Map<string, any>();
    (rt as any).chatSessions.create = (record: any) => sessions.set(record.id, record);
    (rt as any).chatSessions.get = (id: string) => sessions.get(id) ?? null;
    const handlers = await registeredHandlers();
    return { rt, handlers, client, registry, taskLifecycle, pathProbe, proposals, events, workspacePath, dataDir,
      invalidate: (proposal: any) => invalidate?.(proposal) };
  }

  it('R8 round5 r2 cleans workflow bookkeeping when onReady fails before an admission', async () => {
    const sessionId = 'wf-r8-r2-cleanup';
    const h = await workflowCleanupRuntime(sessionId);
    h.pathProbe.inspect.mockRejectedValueOnce(new Error('grant factory failed'));
    const end = vi.spyOn(h.taskLifecycle, 'end');
    const running = h.handlers.get('sparkii:runWorkflow')!(null, 'general', { documents: [], workspacePath: h.workspacePath });

    await expect(running).rejects.toThrow('无法解析工作区的真实对象身份');
    expect(end).not.toHaveBeenCalled();
    expect(h.rt.pool.release).toHaveBeenCalledWith(sessionId, 1);
    expect(h.events).toContainEqual({ type: 'session_unbound', sessionId });
    expect(h.taskLifecycle.currentAdmission(sessionId)).toBeUndefined();
  });

  it('R8 round5 r2 does not end a replacement when onReady fails before returning its admission', async () => {
    const sessionId = 'wf-r8-r2-no-fallback';
    const h = await workflowCleanupRuntime(sessionId);
    const factoryGate = deferred();
    const inspect = h.pathProbe.inspect.getMockImplementation()!;
    let blockFirstInspect = true;
    h.pathProbe.inspect.mockImplementation(async (target: string) => {
      if (blockFirstInspect) {
        blockFirstInspect = false;
        await factoryGate.promise;
      }
      return inspect(target);
    });
    const end = vi.spyOn(h.taskLifecycle, 'end');
    const running = h.handlers.get('sparkii:runWorkflow')!(null, 'general', { documents: [], workspacePath: h.workspacePath });
    await waitUntil(() => !blockFirstInspect);
    await expect(h.handlers.get('sparkii:promptSession')!(null, sessionId, 'REPLACEMENT_B')).resolves.toMatchObject({ ok: true });
    const replacementTaskId = h.taskLifecycle.active(sessionId)?.taskId;
    expect(replacementTaskId).toBeTruthy();
    factoryGate.resolve();

    await expect(running).rejects.toThrow(/admission cancelled/i);
    expect(end).not.toHaveBeenCalled();
    expect(h.taskLifecycle.active(sessionId)?.taskId).toBe(replacementTaskId);
    expect(h.rt.pool.getBinding(sessionId)).toEqual({ client: h.client, lease: 1 });
    expect(h.rt.pool.release).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual({ type: 'session_unbound', sessionId });
    h.client.emit({ type: 'agent_start' });
    h.client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.active(sessionId) === undefined);
  });

  it('R8 round5 r2 preserves replacement bookkeeping when workflow cleanup awaits', async () => {
    const sessionId = 'wf-r8-r2-replacement';
    const h = await workflowCleanupRuntime(sessionId);
    const started = await h.handlers.get('sparkii:runWorkflow')!(null, 'general', { documents: [], workspacePath: h.workspacePath });
    expect(started).toMatchObject({ ok: true, sessionId });
    await waitUntil(() => h.proposals.length === 1 && h.taskLifecycle.active(sessionId) !== undefined);
    const originalTaskId = h.taskLifecycle.active(sessionId)!.taskId;
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    h.taskLifecycle.registerCancellation(originalTaskId, 'hold-workflow-cleanup', async () => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
    });
    const end = vi.spyOn(h.taskLifecycle, 'end');
    h.invalidate(h.proposals[0]);
    await cleanupStarted.promise;
    await expect(h.handlers.get('sparkii:promptSession')!(null, sessionId, 'REPLACEMENT_B')).resolves.toMatchObject({ ok: true });
    const replacementTaskId = h.taskLifecycle.active(sessionId)?.taskId;
    expect(replacementTaskId).toBeTruthy();
    expect(replacementTaskId).not.toBe(originalTaskId);
    const originalEnd = end.mock.results[0].value as Promise<void>;
    cleanupGate.resolve();
    await originalEnd;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(sessionId, 'session-ended', expect.anything());
    expect(h.taskLifecycle.active(sessionId)?.taskId).toBe(replacementTaskId);
    expect(h.rt.pool.getBinding(sessionId)).toEqual({ client: h.client, lease: 1 });
    expect(h.rt.pool.release).not.toHaveBeenCalled();
    expect(h.events).not.toContainEqual({ type: 'session_unbound', sessionId });
    h.client.emit({ type: 'agent_start' });
    h.client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.active(sessionId) === undefined);
  });

  it('R8 round5 blocker5 waits for prior prompt turns to settle before arming queued replacements', async () => {
    const client = new FakeHandle(async (command: any) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      }
      return { success: true };
    });
    const h = await exportRuntime(client);
    const prompt = h.handlers.get('sparkii:promptSession')!;
    await prompt(null, 's1', 'PROMPT_A');
    const originalTaskId = h.taskLifecycle.active('s1')?.taskId;
    client.emit({ type: 'agent_start' });
    const replacing = Promise.resolve(prompt(null, 's1', 'PROMPT_B'));
    const queuedReplacement = Promise.resolve(prompt(null, 's1', 'PROMPT_C'));
    await waitUntil(() => client.send.mock.calls.filter(([command]) => command.type === 'get_state').length >= 3);
    const promptsBeforeSettled = client.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'prompt')
      .map((command) => command.message);

    client.emit({ type: 'agent_settled', aborted: false });
    await expect(replacing).resolves.toMatchObject({ ok: true });
    await waitUntil(() => client.send.mock.calls.some(
      ([command]) => command.type === 'prompt' && command.message === 'PROMPT_B',
    ));
    expect(client.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'prompt')
      .map((command) => command.message)).toEqual(['PROMPT_A', 'PROMPT_B']);

    client.emit({ type: 'agent_start' });
    client.emit({ type: 'agent_settled', aborted: false });
    await expect(queuedReplacement).resolves.toMatchObject({ ok: true });
    const promptsAfterSettled = client.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'prompt')
      .map((command) => command.message);

    expect(promptsBeforeSettled).toEqual(['PROMPT_A']);
    expect(promptsAfterSettled).toEqual(['PROMPT_A', 'PROMPT_B', 'PROMPT_C']);
    expect(h.taskLifecycle.active('s1')?.taskId).toBeTruthy();
    expect(h.taskLifecycle.active('s1')?.taskId).not.toBe(originalTaskId);
  });

  it('R8 round6 keeps a delivered prompt barrier after post-send get_state rejects and ignores an unstarted late settled', async () => {
    let rejectPostSend!: (error: Error) => void;
    const postSendStarted = deferred();
    const postSend = new Promise<any>((_resolve, reject) => { rejectPostSend = reject; });
    let stateReads = 0;
    const client = new FakeHandle(async (command: any) => {
      if (command.type === 'get_state') {
        stateReads += 1;
        if (stateReads === 2) {
          postSendStarted.resolve();
          return postSend;
        }
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      }
      return { success: true };
    });
    const h = await exportRuntime(client);
    const prompt = h.handlers.get('sparkii:promptSession')!;
    const prompts = () => client.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'prompt')
      .map((command) => command.message);

    const first = prompt(null, 's1', 'PROMPT_A');
    const firstRejected = expect(first).rejects.toThrow('post-send get_state failed');
    await postSendStarted.promise;
    const originalTaskId = h.taskLifecycle.active('s1')?.taskId;
    expect(originalTaskId).toBeTruthy();
    expect(prompts()).toEqual(['PROMPT_A']);
    client.emit({ type: 'agent_start' });

    const replacing = Promise.resolve(prompt(null, 's1', 'PROMPT_B'));
    await waitUntil(() => stateReads >= 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts()).toEqual(['PROMPT_A']);

    rejectPostSend(new Error('post-send get_state failed'));
    await firstRejected;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts()).toEqual(['PROMPT_A']);
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(originalTaskId);

    client.emit({ type: 'agent_settled', aborted: false });
    // The replacement is still queued here. A stale start must not count as
    // the replacement's start once it is armed below.
    client.emit({ type: 'agent_start' });
    await expect(replacing).resolves.toMatchObject({ ok: true, behavior: 'prompt' });
    const replacementTaskId = h.taskLifecycle.active('s1')?.taskId;
    const replacementAdmission = h.taskLifecycle.currentAdmission('s1');
    expect(replacementTaskId).toBeTruthy();
    expect(replacementTaskId).not.toBe(originalTaskId);
    expect(replacementAdmission).toBeDefined();
    expect(prompts()).toEqual(['PROMPT_A', 'PROMPT_B']);

    const end = vi.spyOn(h.taskLifecycle, 'end');
    client.emit({ type: 'agent_settled', aborted: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(end).not.toHaveBeenCalled();
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTaskId);
    expect(h.taskLifecycle.currentAdmission('s1')).toBe(replacementAdmission);

    client.emit({ type: 'agent_start' });
    client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);
    expect(end).toHaveBeenCalledWith('s1', 'session-ended', replacementAdmission);
  });

  it('R8 round7 B2 completes a deterministic prompt failure and lets the next prompt run', async () => {
    let client!: FakeHandle;
    client = new FakeHandle(async (command: any) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      }
      if (command.type === 'prompt' && command.message === 'PROMPT_A') {
        queueMicrotask(() => client.emit({
          type: 'prompt_error', command: 'prompt', promptId: command.promptId,
          terminal: true, message: 'No model selected',
        }));
      }
      return { success: true };
    });
    const h = await exportRuntime(client);
    const prompt = h.handlers.get('sparkii:promptSession')!;

    await expect(prompt(null, 's1', 'PROMPT_A')).resolves.toMatchObject({ ok: true });
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);
    expect(h.registry.get('s1')).toBeUndefined();

    await expect(prompt(null, 's1', 'PROMPT_B')).resolves.toMatchObject({ ok: true });
    const replacementTaskId = h.taskLifecycle.active('s1')?.taskId;
    const replacementAdmission = h.taskLifecycle.currentAdmission('s1');
    expect(replacementTaskId).toBeTruthy();
    client.emit({ type: 'agent_start' });
    client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);
    expect(h.registry.get('s1')).toBeUndefined();
    expect(replacementAdmission).toBeDefined();
  });

  it('R8 round7 B2 ignores late correlated and generic errors after abort without ending replacement B', async () => {
    let client!: FakeHandle;
    let lateError: (() => void) | undefined;
    client = new FakeHandle(async (command: any) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionId: 's1', sessionFile: null, isStreaming: false } };
      }
      if (command.type === 'prompt' && command.message === 'PROMPT_A') {
        lateError = () => client.emit({
          type: 'prompt_error', command: 'prompt', promptId: command.promptId,
          terminal: true, message: 'late prepare rejection',
        });
      }
      return { success: true };
    });
    const h = await exportRuntime(client);
    const prompt = h.handlers.get('sparkii:promptSession')!;
    const abort = h.handlers.get('sparkii:abortChat')!;

    await prompt(null, 's1', 'PROMPT_A');
    await abort(null, 's1');
    await expect(prompt(null, 's1', 'PROMPT_B')).resolves.toMatchObject({ ok: true });
    const replacementTaskId = h.taskLifecycle.active('s1')?.taskId;
    const replacementAdmission = h.taskLifecycle.currentAdmission('s1');
    const replacementPromptId = client.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === 'prompt' && command.message === 'PROMPT_B')[0]?.promptId;
    expect(replacementTaskId).toBeTruthy();
    expect(replacementPromptId).toBeTypeOf('string');

    lateError?.();
    client.emit({ type: 'runtime_error', command: 'prompt', promptId: replacementPromptId, message: 'generic' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTaskId);
    expect(h.taskLifecycle.currentAdmission('s1')).toBe(replacementAdmission);
    expect(h.registry.get('s1')?.taskId).toBe(replacementTaskId);

    client.emit({ type: 'agent_start' });
    client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);
    expect(h.registry.get('s1')).toBeUndefined();
  });

  it('R8 round5 blocker3 rejects steer, follow-up and runtime actions while replacement ownership is pending', async () => {
    const h = await exportRuntime();
    const prompt = h.handlers.get('sparkii:promptSession')!;
    await prompt(null, 's1', 'PROMPT_A');
    const originalAdmission = h.taskLifecycle.currentAdmission('s1');
    const originalTaskId = h.taskLifecycle.active('s1')?.taskId;
    const factoryGate = deferred();
    const inspect = h.pathProbe.inspect.getMockImplementation()!;
    let blockNextInspect = true;
    h.pathProbe.inspect.mockImplementation(async (target: string) => {
      if (blockNextInspect) {
        blockNextInspect = false;
        await factoryGate.promise;
      }
      return inspect(target);
    });
    const replacing = Promise.resolve(prompt(null, 's1', 'PROMPT_B'));
    await waitUntil(() => h.sent.filter((command) => command.type === 'get_state').length >= 3);
    // Replacement prompts wait for the prior turn's terminal confirmation before
    // publishing their admission. Drive the old turn to completion, then hold B
    // inside its grant factory so its pending ownership can be inspected.
    h.client.emit({ type: 'agent_start' });
    h.client.emit({ type: 'agent_settled', aborted: false });
    await waitUntil(() => h.taskLifecycle.currentAdmission('s1') !== originalAdmission && !blockNextInspect);

    const steer = await prompt(null, 's1', 'STEER', { behavior: 'steer' }).then(() => null, (error: unknown) => error);
    const followUp = await prompt(null, 's1', 'FOLLOW_UP', { behavior: 'followUp' }).then(() => null, (error: unknown) => error);
    let actionDone = false;
    const actionPending = (h.rt as any).__onAction({
      requestId: 'pending-owner-action', toolName: 'read', args: { path: h.workspacePath },
    }).then((result: unknown) => { actionDone = true; return result; });
    await waitUntil(() => actionDone || h.approvalEvents.length > 0);
    if (!actionDone && h.approvalEvents.length > 0) {
      await h.handlers.get('sparkii:decideApproval')!(null, h.approvalEvents[0].id, false);
    }
    const action = await actionPending;
    const workspaceExecute = (h.rt.security as any).workspaceExecutor.execute as ReturnType<typeof vi.fn>;
    const pendingActiveTaskId = h.taskLifecycle.active('s1')?.taskId;
    factoryGate.resolve();
    await expect(replacing).resolves.toMatchObject({ ok: true });

    expect(pendingActiveTaskId).toBeUndefined();
    expect(h.taskLifecycle.active('s1')?.taskId).not.toBe(originalTaskId);
    expect(steer).toBeInstanceOf(Error);
    expect(followUp).toBeInstanceOf(Error);
    expect(action).toMatchObject({ status: 'denied', error: { code: 'ORIGIN_REQUIRED' } });
    expect(workspaceExecute).not.toHaveBeenCalled();
    expect(h.sent.some((command) => command.type === 'steer' || command.type === 'follow_up')).toBe(false);
  });

  it.each([false, true])('R8 review runtime B7 rejects an out-of-order prompt after send (reuseTaskId=%s)', async (reuseTaskId) => {
    const promptGate = deferred();
    const promptStarted = deferred();
    const listeners = new Set<(event: any) => void>();
    const sent: any[] = [];
    let statePrompt = '';
    const client = {
      onEvent: (listener: (event: any) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: vi.fn(async (command: any) => {
        sent.push(command);
        if (command.type === 'prompt') {
          statePrompt = command.message;
          if (command.message === 'PROMPT_A') {
            promptStarted.resolve();
            await promptGate.promise;
          }
        }
        if (command.type === 'get_state') {
          return { success: true, data: { sessionId: 's1', sessionFile: statePrompt ? `file-${statePrompt}` : null, isStreaming: false } };
        }
        return { success: true };
      }),
    };
    const h = await exportRuntime(client);
    let starts = 0;
    const lifecycleStart = h.taskLifecycle.start.bind(h.taskLifecycle);
    vi.spyOn(h.taskLifecycle, 'start').mockImplementation((factory, beforeCommit, onStarted, targetSessionId) =>
      lifecycleStart(async () => {
        const grant = await factory();
        starts += 1;
        return { ...grant, taskId: reuseTaskId ? 'shared-task' : `task-${starts}` };
      }, beforeCommit, onStarted, targetSessionId));
    const update = vi.spyOn(h.rt.chatSessions, 'update');
    const prompt = h.handlers.get('sparkii:promptSession')!;
    const first = prompt(null, 's1', 'PROMPT_A');
    const rejected = expect(first).rejects.toThrow(/admission.*no longer current/i);
    await promptStarted.promise;
    const end = vi.spyOn(h.taskLifecycle, 'end');
    // A's terminal event is observed before B may be armed. Its send completion
    // is deliberately held until after the replacement attempt.
    for (const listener of listeners) listener({ type: 'agent_start' });
    for (const listener of listeners) listener({ type: 'agent_settled' });
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);

    if (reuseTaskId) {
      await expect(prompt(null, 's1', 'PROMPT_B')).rejects.toThrow(/task id.*reuse/i);
      expect(sent.filter((command) => command.type === 'prompt').map((command) => command.message)).toEqual(['PROMPT_A']);
      promptGate.resolve();
      await rejected;
      expect(update.mock.calls.some(([, patch]) => patch.piSessionFile === 'file-PROMPT_A')).toBe(false);
      expect(update.mock.calls.some(([, patch]) => patch.piSessionFile === 'file-PROMPT_B')).toBe(false);
      expect(listeners.size).toBeGreaterThan(0);
      expect(h.rt.pool.getBinding('s1')).toBeDefined();
      expect(h.taskLifecycle.active('s1')).toBeUndefined();
      expect(h.taskLifecycle.currentAdmission('s1')).toBeUndefined();
      return;
    }

    await expect(prompt(null, 's1', 'PROMPT_B')).resolves.toMatchObject({ ok: true });
    const replacementTaskId = h.taskLifecycle.active('s1')?.taskId;
    promptGate.resolve();
    await rejected;

    expect(update.mock.calls.some(([, patch]) => patch.piSessionFile === 'file-PROMPT_A')).toBe(false);
    expect(update.mock.calls.some(([, patch]) => patch.piSessionFile === 'file-PROMPT_B')).toBe(true);
    expect(listeners.size).toBeGreaterThan(0);
    expect(h.rt.pool.getBinding('s1')).toBeDefined();
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTaskId);
    const admission = h.taskLifecycle.currentAdmission('s1');
    expect(admission).toBeDefined();
    for (const listener of listeners) listener({ type: 'agent_start' });
    for (const listener of listeners) listener({ type: 'agent_settled' });
    expect(end).toHaveBeenCalledWith('s1', 'session-ended', admission);
    await waitUntil(() => h.taskLifecycle.active('s1') === undefined);
    expect(replacementTaskId).toBeTruthy();
  });

  it('R8 B2 stale export admission cannot replace or revoke a replacement task', async () => {
    const h = await exportRuntime();
    const admissionGate = deferred();
    const inspect = h.pathProbe.inspect.getMockImplementation()!;
    let admissions = 0;
    h.pathProbe.inspect.mockImplementation(async (target: string) => {
      admissions += 1;
      if (admissions === 1) await admissionGate.promise;
      return inspect(target);
    });
    const stale = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', { title: '旧导出' }));
    await waitUntil(() => admissions === 1);
    await replaceBinding(h.rt);
    const replacing = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', { title: '替代导出' }));
    await waitUntil(() => h.approvalEvents.length === 1);
    const replacementProposal = h.approvalEvents[0];
    const replacementTask = h.taskLifecycle.active('s1');
    const replacementLease = h.rt.pool.getBinding('s1')?.lease;
    expect(replacementProposal.payload).toEqual({ title: '替代导出' });
    expect(replacementTask).toBeTruthy();
    admissionGate.resolve();

    await expect(stale).rejects.toThrow('session s1 is no longer bound');
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTask?.taskId);
    expect(h.registry.get('s1')?.taskId).toBe(replacementTask?.taskId);
    expect(h.gate.listPending().map((proposal) => proposal.payload)).toEqual([{ title: '替代导出' }]);
    expect(h.sent.filter((command) => command.type === 'append_workflow_entry')).toEqual([]);
    expect(h.rt.pool.getBinding('s1')).toEqual({ client: h.client, lease: replacementLease });
    await h.handlers.get('sparkii:decideApproval')!(null, replacementProposal.id, false);
    await expect(replacing).resolves.toMatchObject({ ok: true, approved: false });
  });

  it('R8 B2 approval cannot append a journal after a same-client rebind', async () => {
    const h = await exportRuntime();
    const stale = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', {
      title: '旧导出', path: join(h.dataDir, 'old-export.docx'),
    }));
    await waitUntil(() => h.approvalEvents.length === 1);
    const oldProposal = h.approvalEvents[0];
    expect(h.gate.get(oldProposal.id)?.status).toBe('pending');
    const oldTask = h.taskLifecycle.active('s1');
    expect(oldTask).toBeTruthy();
    const replacement = await replaceBinding(h.rt);
    expect(h.gate.get(oldProposal.id)?.status).toBe('pending');

    const decided = await h.handlers.get('sparkii:decideApproval')!(null, oldProposal.id, true) as Proposal;
    await expect(stale).rejects.toThrow('session s1 is no longer bound');
    expect(decided.execution).toMatchObject({ ok: false, error: expect.stringContaining('owner is no longer active') });
    expect(h.taskLifecycle.active('s1')).toBeUndefined();
    expect(h.sent.filter((command) => command.type === 'append_workflow_entry')).toEqual([]);
    expect(h.rt.pool.getBinding('s1')).toEqual({ client: h.client, lease: replacement.replacementLease });
  });
  it.each([
    { name: 'rejection', response: () => Promise.reject(new Error('journal transport rejected')) },
    { name: 'success false', response: () => Promise.resolve({ success: false, error: 'journal refused' }) },
  ])('R8 runtime round3 B5 export propagates journal $name and revokes only its grant', async ({ name, response }) => {
    const h = await exportRuntime();
    const journal = vi.fn(response);
    h.client.send.mockImplementation(async (command: any) => {
      h.sent.push(command);
      if (command.type === 'append_workflow_entry') return journal();
      return { success: true };
    });
    const exporting = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', {
      title: 'journal failure', path: join(h.dataDir, 'report.docx'),
    }));
    await waitUntil(() => h.approvalEvents.length === 1);
    const proposal = h.approvalEvents[0];
    const exportingTask = h.taskLifecycle.active('s1');
    expect(exportingTask).toBeTruthy();

    await h.handlers.get('sparkii:decideApproval')!(null, proposal.id, true);
    await expect(exporting).rejects.toThrow(name === 'rejection' ? 'journal transport rejected' : 'journal refused');
    expect(journal).toHaveBeenCalledTimes(1);
    expect(h.taskLifecycle.active('s1')).toBeUndefined();
    expect(h.registry.get('s1')).toBeUndefined();
    expect(h.sent.map((command) => command.type)).toEqual(['append_workflow_entry']);
    expect(h.sent[0]).toMatchObject({
      type: 'append_workflow_entry', customType: 'workflow_state',
      data: { stepId: 'report', action: 'report_exported', title: 'journal failure', path: join(h.dataDir, 'report.docx') },
    });
  });

  it('R8 runtime round3 B5 stale export journal failure cannot revoke a replacement task', async () => {
    const h = await exportRuntime();
    randomUUIDControl.setSequence(['R8-B5-SAME-TASK', 'R8-B5-OLD-PROPOSAL']);
    const stale = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', {
      title: '旧导出', path: join(h.dataDir, 'old-same-task.docx'),
    }));
    await waitUntil(() => h.approvalEvents.length === 1);
    const oldProposal = h.approvalEvents[0];
    const oldTask = h.taskLifecycle.active('s1');
    expect(oldTask?.taskId).toBe('task-R8-B5-SAME-TASK');
    const journalGate = deferred();
    h.client.send.mockImplementation(async (command: any) => {
      h.sent.push(command);
      if (command.type === 'append_workflow_entry') {
        await journalGate.promise;
        throw new Error('stale journal rejected');
      }
      return { success: true };
    });
    await h.handlers.get('sparkii:decideApproval')!(null, oldProposal.id, true);
    await waitUntil(() => h.sent.some((command) => command.type === 'append_workflow_entry'));

    randomUUIDControl.setSequence(['R8-B5-REPLACEMENT-TASK', 'R8-B5-REPLACEMENT-PROPOSAL']);
    const replacing = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', { title: '替代导出' }));
    await waitUntil(() => h.approvalEvents.some((proposal) => proposal.id === 'R8-B5-REPLACEMENT-PROPOSAL'));
    const replacementProposal = h.approvalEvents.find((proposal) => proposal.id === 'R8-B5-REPLACEMENT-PROPOSAL')!;
    const replacementTask = h.taskLifecycle.active('s1');
    expect(replacementTask?.taskId).not.toBe(oldTask?.taskId);
    const replacementLease = h.rt.pool.getBinding('s1')?.lease;
    const commands = h.sent.map((command) => command.type);
    expect(commands).toEqual(['append_workflow_entry']);
    journalGate.resolve();

    await expect(stale).rejects.toThrow('stale journal rejected');
    expect(h.taskLifecycle.active('s1')?.taskId).toBe(replacementTask?.taskId);
    expect(h.registry.get('s1')?.taskId).toBe(replacementTask?.taskId);
    expect(h.sent.map((command) => command.type)).toEqual(commands);
    expect(h.rt.pool.getBinding('s1')?.lease).toBe(replacementLease);
    await h.handlers.get('sparkii:decideApproval')!(null, replacementProposal.id, false);
    await expect(replacing).resolves.toEqual({ ok: true, approved: false });
  });

  it('R8 runtime round3 B5 export rejects when its binding changes during the journal await', async () => {
    const h = await exportRuntime();
    const journalGate = deferred();
    let deferJournal = true;
    h.client.send.mockImplementation(async (command: any) => {
      h.sent.push(command);
      if (deferJournal && command.type === 'append_workflow_entry') await journalGate.promise;
      return { success: true };
    });
    const exporting = Promise.resolve(h.handlers.get('sparkii:requestExportReport')!(null, 's1', {
      title: 'rebound export', path: join(h.dataDir, 'rebound.docx'),
    }));
    await waitUntil(() => h.approvalEvents.length === 1);
    await h.handlers.get('sparkii:decideApproval')!(null, h.approvalEvents[0].id, true);
    await waitUntil(() => h.sent.some((command) => command.type === 'append_workflow_entry'));
    deferJournal = false;
    const replacement = await replaceBinding(h.rt);
    const commands = h.sent.map((command) => command.type);
    expect(commands).toEqual(['append_workflow_entry']);
    journalGate.resolve();

    await expect(exporting).rejects.toThrow('session s1 is no longer bound');
    expect(h.taskLifecycle.active('s1')).toBeUndefined();
    expect(h.sent.map((command) => command.type)).toEqual(commands);
    expect(h.rt.pool.getBinding('s1')).toEqual({ client: h.client, lease: replacement.replacementLease });
  });
});

describe('approval execution canonical race regressions', () => {
  const secret = 'round7-approval-race-secret';

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function raceRuntime() {
    const dataDir = await mkdtemp(join(tmpdir(), 'ipc-approval-race-'));
    dirs.push(dataDir);
    const auditStore = new AuditStore(':memory:');
    const append = auditStore.append.bind(auditStore);
    const query = auditStore.query.bind(auditStore);
    const audit = {
      append: vi.fn(async (event: any) => append(event)),
      query: vi.fn(async (filter: any) => query(filter)),
      redactValue: vi.fn(auditStore.redactValue.bind(auditStore)),
      containsValue: vi.fn(auditStore.containsValue.bind(auditStore)),
      redactText: vi.fn(auditStore.redactText.bind(auditStore)),
      contains: vi.fn(auditStore.contains.bind(auditStore)),
      redactTexts: vi.fn(auditStore.redactTexts.bind(auditStore)),
    };
    const gate = new ApprovalGate({
      audit: audit as any,
      policy: { requireApproval: ['report.export'], timeoutMs: 60_000, highRiskDoubleConfirm: true },
      rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
    });
    const executor = new ConnectorExecutor(audit as any);
    const connectorHandler = vi.fn(async () => ({ ok: true, data: { exported: true } }));
    executor.register('report.export', connectorHandler);
    const gateway = new CapabilityGateway();
    const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const pathProbe = {
      inspect: vi.fn(async (target: string) => ({
        displayPath: target,
        canonicalPath: target,
        identity: `object:${key(target)}`,
        nearestExistingAncestor: target,
        isDirectory: true,
        isReparsePoint: false,
        exists: true,
        linkCount: 1,
      })),
      isSameOrDescendant: async (root: string, target: string) => {
        const r = key(root);
        const t = key(target);
        return t === r || t.startsWith(`${r}/`);
      },
      isSameObject: async (left: string, right: string) => key(left) === key(right),
    };
    const liveGrant: TaskGrant = {
      taskId: 'task-race',
      sessionId: 's-race',
      agentId: 'general',
      profileId: 'general',
      actorId: 'tester',
      unattended: false,
      planMode: 'execute',
      permissionMode: 'ask',
      workspaceRoot: 'C:/ws',
      workspaceIdentity: 'object:c:/ws',
      inputRoots: [],
      scratchRoot: 'C:/scratch/task-race',
      networkDomains: [],
      externalCapabilities: [],
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const workspaceHandler = vi.fn(async (_action: SecurityAction) => ({
      path: 'C:/ws/report.docx',
      changes: [],
    }));
    const taskRegistry = new TaskGrantRegistry();
    const taskLifecycle = new TaskLifecycle(taskRegistry);
    const security = {
      profilePolicies: new Map([['general', {
        defaultPermissionMode: 'ask',
        allowedPermissionModes: ['ask'],
        requireApproval: ['fs.write', 'process.exec', 'connector.invoke'],
      }]]),
      hostShellReport: {
        backend: 'host-git-bash',
        status: 'available',
        executionBoundary: 'host',
        version: 'host-job-v1',
        limitations: [],
      },
      reviewerModel: 'test-reviewer',
      reviewerPolicyVersion: 'shell-review-v1',
      taskLifecycle,
      taskGrants: taskRegistry,
      scratchParent: 'C:/scratch',
      hostShell: { terminate: vi.fn(async () => {}) },
      actionNormalizer: createActionNormalizer({
        descriptors: DEFAULT_TOOL_DESCRIPTORS,
        protectedRoots: [],
        probe: pathProbe,
      }),
      pathProbe,
      protectedRoots: [],
      scratchParent: 'C:/scratch',
      workspaceExecutor: {
        execute: workspaceHandler,
        ensureWorkspace: vi.fn(async () => ({
          displayPath: liveGrant.workspaceRoot,
          canonicalPath: liveGrant.workspaceRoot,
          identity: liveGrant.workspaceIdentity,
          nearestExistingAncestor: liveGrant.workspaceRoot,
          isDirectory: true,
          isReparsePoint: false,
          exists: true,
        })),
        liveWorkspaceIdentity: () => liveGrant.workspaceIdentity,
      },
      capabilityGateway: gateway,
      platformReadyFor: () => true,
      reviewer: { review: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
    };
    const approvalEvents: Proposal[] = [];
    const rt = await makeRuntime({
      dataDir,
      piAgentDir: join(dataDir, 'pi-agent'),
      client: {
        onEvent: () => () => {},
        send: async (command: any) => command.type === 'get_state'
          ? { success: true, data: { sessionId: 's-race', sessionFile: join(dataDir, 's-race.jsonl'), isStreaming: false } }
          : { success: true },
      },
      audit,
      security,
      gate,
      executor,
      profile: {
        dir: join(dataDir, 'profiles', 'general'),
        profile: {
          manifest: { name: 'general' },
          security: {
            approval: {
              requireApproval: ['report.export'],
              timeoutMs: 60_000,
              highRiskDoubleConfirm: true,
              defaultPermissionMode: 'ask',
              allowedPermissionModes: ['ask'],
            },
          },
          agent: { tools: [], prompts: { system: 'test' } },
        },
        router: { resolve: () => undefined },
      } as any,
      getWindow: () => ({
        on: () => {},
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: Proposal) => {
            if (channel === 'sparkii:event:approval') approvalEvents.push(payload);
          },
        },
      }) as any,
    });
    const records = new Map<string, any>();
    (rt as any).chatSessions.create = (record: any) => records.set(record.id, record);
    (rt as any).chatSessions.get = (id: string) => records.get(id) ?? null;
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:createSession')!(null, {
      profileId: 'general',
      workspaceKind: 'user',
      workspacePath: 'C:/ws',
    });
    await handlers.get('sparkii:promptSession')!(null, 's-race', 'start');
    return {
      rt, handlers, gate, executor, audit, gateway, pathProbe,
      connectorHandler, workspaceHandler, approvalEvents, taskLifecycle,
    };
  }

  async function submitProposal(
    h: Awaited<ReturnType<typeof raceRuntime>>,
    withSuggestedPath = true,
  ) {
    return h.gate.submit({
      requestId: 'proposal-race-request',
      toolName: 'report.export',
      targetSystem: 'report',
      summary: `export ${secret}`,
      payload: {
        title: 'report',
        body: secret,
        ...(withSuggestedPath ? { path: 'C:/ws/export.txt' } : {}),
      },
      risk: 'write',
      executionMode: 'proposal',
    }, { profileId: 'general', sessionId: 's-race', actor: 'tester', taskId: h.taskLifecycle.active('s-race')!.taskId });
  }

  it.each(['dialog', 'audit', 'gateway'] as const)(
    'blocks proposal-mode connector execution when privacy redaction wins during the %s await',
    async (window) => {
      const h = await raceRuntime();
      const proposal = await submitProposal(h, window !== 'dialog');
      const entered = deferred();
      const release = deferred();
      if (window === 'dialog') {
        vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { canceled: false, filePath: 'C:/ws/export.txt' };
        });
      } else if (window === 'audit') {
        const append = h.audit.append.getMockImplementation()!;
        h.audit.append.mockImplementation(async (event: any) => {
          if (event.action === 'gateway.lease-issued') {
            entered.resolve();
            await release.promise;
          }
          return append(event);
        });
      } else {
        const execute = h.gateway.execute.bind(h.gateway);
        vi.spyOn(h.gateway, 'execute').mockImplementation((async (
          action: SecurityAction,
          leaseId: string,
          grant: TaskGrant,
          handler: (signal: AbortSignal) => Promise<unknown>,
        ) => {
          entered.resolve();
          await release.promise;
          return execute(action, leaseId, grant, handler);
        }) as typeof h.gateway.execute);
      }

      const deciding = h.handlers.get('sparkii:decideApproval')!(null, proposal.id, true);
      await entered.promise;
      expect(h.gate.get(proposal.id)?.privacyRedacted).not.toBe(true);
      expect(h.gate.redactTexts([secret])).toBe(1);
      expect(h.connectorHandler).not.toHaveBeenCalled();
      release.resolve();
      const out = await deciding as Proposal;
      expect(out).toMatchObject({ id: proposal.id, privacyRedacted: true });
      expect(h.connectorHandler).not.toHaveBeenCalled();
    },
  );

  it('commits the chosen export path to the canonical proposal before connector execution', async () => {
    const h = await raceRuntime();
    const proposal = await submitProposal(h, false);
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:/ws/export.txt',
    });
    h.connectorHandler.mockImplementationOnce(async (payload: Record<string, unknown>) => {
      expect(payload.path).toBe('C:/ws/export.txt');
      expect(h.gate.get(proposal.id)?.payload).toBe(payload);
      expect(h.gate.get(proposal.id)?.payloadHash).toBe(
        (await import('@sparkii/approval')).hashPayload(payload),
      );
      return { ok: true, data: { exported: true } };
    });

    const out = await h.handlers.get('sparkii:decideApproval')!(null, proposal.id, true) as Proposal;
    expect(out).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(h.connectorHandler).toHaveBeenCalledTimes(1);
  });

  it.each(['revalidation', 'audit'] as const)(
    'blocks caller-mode workspace execution when privacy redaction wins during the %s await',
    async (window) => {
      const h = await raceRuntime();
      const release = deferred();
      let approvalDecided = false;
      let paused = false;
      if (window === 'revalidation') {
        const inspect = h.pathProbe.inspect.getMockImplementation()!;
        h.pathProbe.inspect.mockImplementation(async (target: string) => {
          if (approvalDecided) {
            paused = true;
            await release.promise;
          }
          return inspect(target);
        });
      } else {
        const append = h.audit.append.getMockImplementation()!;
        h.audit.append.mockImplementation(async (event: any) => {
          if (event.action === 'action.allowed') {
            paused = true;
            await release.promise;
          }
          return append(event);
        });
      }

      const onAction = (h.rt as any).__onAction as (request: unknown) => Promise<any>;
      const routing = onAction({
        requestId: 'caller-race-request',
        toolName: 'report.export',
        args: { path: 'C:/ws/report.docx', content: secret },
      });
      try {
        await waitUntil(() => h.approvalEvents.length === 1);
      } catch (error) {
        throw new Error(`caller approval was not requested: ${JSON.stringify(
          h.audit.append.mock.calls.map(([event]) => event.action),
        )}`, { cause: error });
      }
      const proposal = h.approvalEvents[0];
      const deciding = h.handlers.get('sparkii:decideApproval')!(null, proposal.id, true);
      approvalDecided = true;
      await deciding;
      try {
        await waitUntil(() => paused);
      } catch (error) {
        throw new Error(`caller ${window} window was not reached: ${JSON.stringify(
          h.audit.append.mock.calls.map(([event]) => event.action),
        )}`, { cause: error });
      }
      expect(h.gate.get(proposal.id)?.privacyRedacted).not.toBe(true);
      expect(h.gate.redactTexts([secret])).toBe(1);
      expect(h.workspaceHandler).not.toHaveBeenCalled();
      release.resolve();
      const result = await routing;
      expect(result).toMatchObject({ status: 'denied', error: { code: 'APPROVAL_INVALIDATED' } });
      expect(h.workspaceHandler).not.toHaveBeenCalled();
    },
  );
});

