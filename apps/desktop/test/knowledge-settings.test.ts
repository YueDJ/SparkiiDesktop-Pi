import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_KNOWLEDGE_BASE_URL,
  checkKnowledgeBaseUrl,
  isKnowledgeBackendId,
  knowledgeBackendSettings,
  patchKnowledgeSettings,
} from '../electron/main/knowledge-settings.js';
import { loadSettings } from '../electron/main/settings.js';
import { registerIpc } from '../electron/main/ipc.js';
import { parseProfileManifest } from '@sparkii/config';
import { knowledgeClientFor } from '../electron/main/rag-search.js';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    getHandlers: () => handlers,
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    app: { getPath: () => '', on: () => {}, quit: () => {} },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    shell: { openPath: vi.fn(async () => '') },
    nativeImage: { createFromPath: vi.fn() },
  };
});

vi.mock('../electron/main/document-parse-supervisor.js', () => ({
  getDocumentParseSupervisor: () => ({
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
  }),
}));

let dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function makeDataDir(settings?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-settings-'));
  dirs.push(dir);
  if (settings !== undefined) {
    await writeFile(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings), 'utf8');
  }
  return dir;
}

async function registeredHandlers(): Promise<Map<string, (...args: unknown[]) => unknown>> {
  const electron = (await import('electron')) as unknown as {
    getHandlers: () => Map<string, (...args: unknown[]) => unknown>;
  };
  return electron.getHandlers();
}

async function makeRuntime(opts: { dataDir: string; keyFor?: (id: string) => Promise<string | null>; knowledgeToken?: (backend: string) => Promise<string | null> }) {
  const piAgentDir = join(opts.dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  const rt = {
    profiles: new Map(),
    agents: new Map(),
    gate: {},
    executor: {},
    audit: { append: vi.fn(async (event: unknown) => event), query: vi.fn(async () => []) },
    errors: { append: vi.fn() },
    pool: {
      subscribe: vi.fn(() => () => {}),
      acquire: vi.fn(async () => ({ client: { send: vi.fn(async () => ({ success: true })) } })),
      release: vi.fn(async () => {}),
      broadcast: vi.fn(async () => {}),
      snapshot: vi.fn(() => ({ maxAgents: 4, active: 0, queued: 0, slots: [], queue: [] })),
      activeCount: vi.fn(() => 0),
      get: () => null,
      cancelPending: vi.fn(() => true),
      setMaxAgents: vi.fn(),
      updateMeta: vi.fn(() => true),
    },
    subject: { userId: 'tester', roles: ['admin'] },
    chatSessions: {
      get: () => null,
      list: vi.fn(() => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    dataDir: opts.dataDir,
    keyring: null,
    piAgentDir,
    profileOf: () => ({
      dir: opts.dataDir,
      profile: { agent: { tools: [], prompts: { system: 'x' } } },
      router: { resolve: () => undefined },
    }),
    agentOf: () => ({ id: 'x', manifest: {}, tools: [], dir: opts.dataDir, systemPrompt: 'x' }),
    keyFor: opts.keyFor ?? (async () => null),
    setKey: vi.fn(async () => {}),
    knowledgeToken: opts.knowledgeToken ?? (async () => null),
    setKnowledgeToken: vi.fn(async () => {}),
  };
  registerIpc(
    rt as never,
    (() => null) as never,
    { export: async () => '', log: vi.fn(async () => {}) } as never,
  );
  return rt;
}

describe('knowledgeBackendSettings (read tolerance)', () => {
  it('falls back to the default url, never throws, and flags a missing or broken url', () => {
    const missing = knowledgeBackendSettings('sparkiionto', {});
    expect(missing).toEqual({
      baseUrl: DEFAULT_KNOWLEDGE_BASE_URL,
      similarityThreshold: 0.2,
      vectorSimilarityWeight: 0.3,
      bindings: [],
      invalidBaseUrl: true,
    });

    for (const baseUrl of ['not-a-url', 'ftp://onto.example', 'http://user:pw@onto.example', 'http://onto.example/?a=1', '  ']) {
      const out = knowledgeBackendSettings('sparkiionto', { sparkiionto: { baseUrl } });
      expect(out.baseUrl, baseUrl).toBe(DEFAULT_KNOWLEDGE_BASE_URL);
      expect(out.invalidBaseUrl, baseUrl).toBe(true);
    }
  });

  it('accepts intranet http with a port and normalizes trailing slashes', () => {
    const out = knowledgeBackendSettings('sparkiionto', {
      sparkiionto: { baseUrl: 'http://onto.internal:9380/', similarityThreshold: 0.35, bindings: [{ agentId: 'a', defaultDatasetId: 'd1' }] },
    });
    expect(out).toEqual({
      baseUrl: 'http://onto.internal:9380',
      similarityThreshold: 0.35,
      vectorSimilarityWeight: 0.3,
      bindings: [{ agentId: 'a', defaultDatasetId: 'd1' }],
    });
  });

  it('reads the two backends from their own blocks', () => {
    const settings = {
      rag: { baseUrl: 'http://rag.example', similarityThreshold: 0.11, vectorSimilarityWeight: 0.42, bindings: [{ agentId: 'qa', defaultDatasetId: 'law' }] },
      sparkiionto: { baseUrl: 'http://onto.example', similarityThreshold: 0.22, bindings: [{ agentId: 'qa', defaultDatasetId: 'kiln' }] },
    };
    expect(knowledgeBackendSettings('sparkiirag', settings)).toEqual({
      baseUrl: 'http://rag.example',
      similarityThreshold: 0.11,
      vectorSimilarityWeight: 0.42,
      bindings: [{ agentId: 'qa', defaultDatasetId: 'law' }],
    });
    expect(knowledgeBackendSettings('sparkiionto', settings)).toEqual({
      baseUrl: 'http://onto.example',
      similarityThreshold: 0.22,
      vectorSimilarityWeight: 0.3,
      bindings: [{ agentId: 'qa', defaultDatasetId: 'kiln' }],
    });
  });

  it('tolerates a corrupt settings.json (defaults, no throw)', async () => {
    const dataDir = await makeDataDir('{ this is not json');
    const settings = await loadSettings(dataDir);
    expect(settings).toEqual({});
    expect(knowledgeBackendSettings('sparkiionto', settings).baseUrl).toBe(DEFAULT_KNOWLEDGE_BASE_URL);
    expect(knowledgeBackendSettings('sparkiirag', settings).baseUrl).toBe(DEFAULT_KNOWLEDGE_BASE_URL);
  });

  it('ignores a malformed bindings array instead of throwing', () => {
    const out = knowledgeBackendSettings('sparkiionto', {
      sparkiionto: { baseUrl: 'http://onto.example', bindings: [{ agentId: '', defaultDatasetId: 'x' }, 'nope', { agentId: 'ok', defaultDatasetId: 'd' }] } as never,
    });
    expect(out.bindings).toEqual([{ agentId: 'ok', defaultDatasetId: 'd' }]);
  });
});

describe('knowledge settings (strict writes)', () => {
  it('rejects unusable urls when writing', () => {
    for (const raw of ['', 'x', 'ftp://host', 'http://user:pw@host', 'http://host?a=1', 'http://host#f']) {
      expect(checkKnowledgeBaseUrl(raw).ok, raw).toBe(false);
    }
    expect(checkKnowledgeBaseUrl('http://127.0.0.1:9380/')).toEqual({ ok: true, baseUrl: 'http://127.0.0.1:9380' });
  });

  it('throws when patching an invalid onto url and leaves the file untouched', async () => {
    const dataDir = await makeDataDir({ sparkiionto: { baseUrl: 'http://onto.example' } });
    await expect(patchKnowledgeSettings(dataDir, 'sparkiionto', { baseUrl: 'nope' })).rejects.toThrow(/地址无效/);
    expect(await loadSettings(dataDir)).toEqual({ sparkiionto: { baseUrl: 'http://onto.example' } });
  });

  it('keeps the two backends bindings independent', async () => {
    const dataDir = await makeDataDir({});
    await patchKnowledgeSettings(dataDir, 'sparkiionto', { baseUrl: 'http://onto.example', bindings: [{ agentId: 'qa', defaultDatasetId: 'kiln' }] });
    await patchKnowledgeSettings(dataDir, 'sparkiirag', { baseUrl: 'http://rag.example', bindings: [{ agentId: 'qa', defaultDatasetId: 'law' }] });

    const settings = await loadSettings(dataDir);
    expect(settings.rag?.bindings).toEqual([{ agentId: 'qa', defaultDatasetId: 'law' }]);
    expect(settings.sparkiionto?.bindings).toEqual([{ agentId: 'qa', defaultDatasetId: 'kiln' }]);
    expect(settings.sparkiionto?.baseUrl).toBe('http://onto.example');
    expect(settings.rag?.baseUrl).toBe('http://rag.example');
  });

  it('updates only the requested backend block', async () => {
    const dataDir = await makeDataDir({ rag: { baseUrl: 'http://rag.example' } });
    await patchKnowledgeSettings(dataDir, 'sparkiionto', { baseUrl: 'http://onto.example', similarityThreshold: 0.5 });
    const settings = await loadSettings(dataDir);
    expect(settings.rag?.baseUrl).toBe('http://rag.example');
    expect(settings.sparkiionto).toEqual({
      baseUrl: 'http://onto.example',
      similarityThreshold: 0.5,
      bindings: [],
    });
  });

  it('recognises only the two remote backends', () => {
    expect(isKnowledgeBackendId('sparkiirag')).toBe(true);
    expect(isKnowledgeBackendId('sparkiionto')).toBe(true);
    expect(isKnowledgeBackendId('bm25')).toBe(false);
    expect(isKnowledgeBackendId(undefined)).toBe(false);
  });
});

describe('knowledge settings over ipc', () => {
  it('getSettings rebuilds the onto block without ever returning the token', async () => {
    const dataDir = await makeDataDir({
      activeProviderId: 'deepseek',
      providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions' }],
      rag: { baseUrl: 'http://rag.example', bindings: [] },
      sparkiionto: { baseUrl: 'http://onto.internal:9380', similarityThreshold: 0.4, token: 'onto-token-please-hide' },
    } as never);
    await makeRuntime({
      dataDir,
      keyFor: async (id) => (id === 'deepseek' ? 'sk-ds' : id === 'sparkiirag' ? 'rag-secret-please-hide' : null),
      knowledgeToken: async (backend) => (backend === 'sparkiionto' ? 'onto-token-please-hide' : null),
    });
    const handlers = await registeredHandlers();
    const s = await handlers.get('sparkii:getSettings')!(null) as {
      sparkiionto: { baseUrl: string; similarityThreshold: number; bindings: unknown[]; hasToken: boolean; invalidBaseUrl?: boolean };
      rag: { baseUrl: string; hasApiKey: boolean };
    };

    expect(JSON.stringify(s)).not.toContain('onto-token-please-hide');
    expect(JSON.stringify(s)).not.toContain('rag-secret-please-hide');
    expect(s.sparkiionto).toEqual({
      baseUrl: 'http://onto.internal:9380',
      similarityThreshold: 0.4,
      bindings: [],
      hasToken: true,
      vectorSimilarityWeight: 0.3,
    });
    expect(s.rag).toEqual({ baseUrl: 'http://rag.example', hasApiKey: true, similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, bindings: [] });
  });

  it('getApiKey returns null for both knowledge backends and their keyring names', async () => {
    const dataDir = await makeDataDir({});
    const keys = new Map<string, string>([
      ['deepseek', 'sk-ds'],
      ['sparkiirag', 'rag-secret-please-hide'],
      ['sparkiionto', 'onto-token-please-hide'],
      ['apiKey:sparkiirag', 'rag-secret-please-hide'],
      ['apiKey:sparkiionto', 'onto-token-please-hide'],
    ]);
    await makeRuntime({ dataDir, keyFor: async (id) => keys.get(id) ?? null });
    const handlers = await registeredHandlers();
    const getApiKey = handlers.get('sparkii:getApiKey')!;

    expect(await getApiKey(null, 'sparkiirag')).toBeNull();
    expect(await getApiKey(null, 'sparkiionto')).toBeNull();
    expect(await getApiKey(null, 'apiKey:sparkiirag')).toBeNull();
    expect(await getApiKey(null, 'apiKey:sparkiionto')).toBeNull();
    expect(await getApiKey(null, 'deepseek')).toBe('sk-ds');
  });

  it('saveKnowledgeSettings rejects a bad url, rejects unknown backends, and writes the token', async () => {
    const dataDir = await makeDataDir({});
    const rt = await makeRuntime({ dataDir });
    const handlers = await registeredHandlers();
    const save = handlers.get('sparkii:saveKnowledgeSettings')!;

    expect(await save(null, 'sparkiirag', { baseUrl: 'not-a-url' })).toMatchObject({ ok: false });
    expect(await save(null, 'sparkiionto', { baseUrl: 'not-a-url' })).toMatchObject({ ok: false, error: expect.stringMatching(/地址无效/) });
    expect(await save(null, 'bm25', {})).toMatchObject({ ok: false });
    expect(await loadSettings(dataDir)).toEqual({});

    expect(await save(null, 'sparkiionto', { baseUrl: 'http://onto.internal:9380/', similarityThreshold: 0.3, apiKey: '  tok-1  ' })).toEqual({ ok: true });
    expect(rt.setKnowledgeToken).toHaveBeenCalledWith('sparkiionto', 'tok-1');
    expect(await loadSettings(dataDir)).toEqual({
      sparkiionto: { baseUrl: 'http://onto.internal:9380', similarityThreshold: 0.3, bindings: [] },
    });

    // 空 token 不覆盖已存凭据。
    await save(null, 'sparkiionto', { apiKey: '' });
    expect(rt.setKnowledgeToken).toHaveBeenCalledTimes(1);
  });

  it('saveKnowledgeSettings keeps the legacy sparkiirag write path intact', async () => {
    const dataDir = await makeDataDir({});
    const rt = await makeRuntime({ dataDir });
    const handlers = await registeredHandlers();
    const save = handlers.get('sparkii:saveKnowledgeSettings')!;

    expect(await save(null, 'sparkiirag', { baseUrl: 'http://rag.example/', apiKey: 'rag-tok' })).toEqual({ ok: true });
    expect(rt.setKnowledgeToken).toHaveBeenCalledWith('sparkiirag', 'rag-tok');
    const settings = await loadSettings(dataDir);
    expect(settings.rag?.baseUrl).toBe('http://rag.example');
    expect(settings.sparkiionto).toBeUndefined();
  });

  it('saveSettings rejects a custom provider that collides with a knowledge credential id', async () => {
    const dataDir = await makeDataDir({ providers: [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' }] });
    await makeRuntime({ dataDir });
    const handlers = await registeredHandlers();
    const save = handlers.get('sparkii:saveSettings')!;

    for (const id of ['sparkiirag', 'sparkiionto']) {
      const result = await save(null, { activeProviderId: id, providers: [{ id, name: id, baseUrl: 'http://x', api: 'openai-completions' }] }) as { ok: boolean; error?: string };
      expect(result.ok, id).toBe(false);
      expect(result.error, id).toMatch(/保留名/);
    }
    const settings = await loadSettings(dataDir);
    expect(settings.providers).toEqual([{ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' }]);

    const ok = await save(null, { activeProviderId: 'ollama', providers: [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' }] }) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });

  it('saveSettings cannot clobber the onto block', async () => {
    const dataDir = await makeDataDir({ sparkiionto: { baseUrl: 'http://onto.example', bindings: [] } });
    await makeRuntime({ dataDir });
    const handlers = await registeredHandlers();
    await handlers.get('sparkii:saveSettings')!(null, { activeProviderId: 'deepseek', apiKey: 'sk', sparkiionto: { baseUrl: 'http://evil.example' } });
    const settings = await loadSettings(dataDir);
    expect(settings.sparkiionto).toEqual({ baseUrl: 'http://onto.example', bindings: [] });
  });
});

describe('knowledge.search drops the ontology backend', () => {
  it('rejects a manifest whose knowledge backend is sparkiionto', () => {
    const manifest = {
      name: 'test',
      version: '1.0.0',
      modelRouting: { tasks: {} },
      knowledge: { enabled: true, picker: 'hidden', backend: 'sparkiionto' },
    };
    expect(() => parseProfileManifest(manifest)).toThrow();
  });

  it('keeps the ontology branch in knowledgeClientFor for fetch_document / openRagDocument', () => {
    const rag = { baseUrl: 'http://127.0.0.1:9380', similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, bindings: [] };
    expect(knowledgeClientFor('sparkiirag', rag, 'k')).not.toBeNull();
    expect(knowledgeClientFor('sparkiionto', rag, 'k')).not.toBeNull();
  });
});
