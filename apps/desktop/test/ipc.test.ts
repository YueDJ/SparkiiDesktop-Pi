import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '../electron/main/keyring.js';
import { registerIpc } from '../electron/main/ipc.js';
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
});

async function makeRuntime(opts: {
  dataDir: string;
  piAgentDir: string;
  client: { send: (command: any) => Promise<any> };
  setKey?: (providerId: string, key: string) => Promise<void>;
}): Promise<Runtime> {
  const rt = {
    profiles: new Map(),
    gate: {},
    executor: {},
    audit: {},
    pool: {
      acquire: vi.fn(async () => ({ client: opts.client, supervisor: { onProposal: () => {} } })),
      release: vi.fn(async () => {}),
    },
    subject: { userId: 'tester', roles: ['admin'] },
    chatSessions: { get: () => null, create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dataDir: opts.dataDir,
    keyring: null as any,
    piAgentDir: opts.piAgentDir,
    profileOf: () => {
      throw new Error('no profile');
    },
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
    await makeRuntime({ dataDir, piAgentDir, client, setKey });

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
  });
});
