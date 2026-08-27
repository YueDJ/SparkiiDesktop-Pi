import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApiKey, loadSettings, saveApiKey, saveSettings } from '../electron/main/settings.js';
import { Keyring } from '../electron/main/keyring.js';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
  } as any;
}

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeDir() {
  dir = await mkdtemp(join(tmpdir(), 'sparkii-settings-'));
  return dir;
}

describe('settings store', () => {
  it('returns defaults when no settings file exists', async () => {
    const d = await makeDir();
    expect(await loadSettings(d)).toEqual({});
  });

  it('roundtrips saved settings', async () => {
    const d = await makeDir();
    await saveSettings(d, {
      activeProviderId: 'deepseek',
      providers: [
        { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      ],
      maxAgents: 2,
    });
    const loaded = await loadSettings(d);
    expect(loaded.activeProviderId).toBe('deepseek');
    expect(loaded.providers).toEqual([
      { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
    ]);
    expect(loaded.maxAgents).toBe(2);
  });

  it('persists activeProviderId and providers without writing keys to settings.json', async () => {
    const d = await makeDir();
    await saveSettings(
      d,
      {
        activeProviderId: 'ollama',
        providers: [
          { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
          { id: 'claude-compat', name: 'Claude 兼容', baseUrl: 'https://example.com', api: 'anthropic-messages' },
        ],
      },
    );
    const raw = await readFile(join(d, 'settings.json'), 'utf8');
    expect(raw).toContain('"activeProviderId": "ollama"');
    expect(raw).toContain('"id": "claude-compat"');
    expect(raw).not.toContain('sk-secret');

    const loaded = await loadSettings(d);
    expect(loaded.activeProviderId).toBe('ollama');
    expect(loaded.providers).toEqual([
      { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
      { id: 'claude-compat', name: 'Claude 兼容', baseUrl: 'https://example.com', api: 'anthropic-messages' },
    ]);
  });

  it('loads and saves per-provider keys under apiKey:<providerId>', async () => {
    const d = await makeDir();
    const keyring = new Keyring(join(d, 'keyring'), fakeSafeStorage());
    await saveApiKey(keyring, 'deepseek', 'sk-deepseek');
    expect(await loadApiKey(keyring, 'deepseek')).toBe('sk-deepseek');
    expect(await loadApiKey(keyring, 'ollama')).toBeNull();
  });
});
