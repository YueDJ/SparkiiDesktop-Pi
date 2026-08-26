import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../electron/main/settings.js';
import { Keyring } from '../electron/main/keyring.js';

function fakeSafeStorage() {
  const store = new Map<string, string>();
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
    await saveSettings(d, { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', maxAgents: 2 });
    const loaded = await loadSettings(d);
    expect(loaded.provider).toBe('DeepSeek');
    expect(loaded.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(loaded.maxAgents).toBe(2);
  });

  it('stores apiKey in keyring, not in settings.json', async () => {
    const d = await makeDir();
    const keyring = new Keyring(join(d, 'keyring'), fakeSafeStorage());
    await saveSettings(
      d,
      { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret' } as any,
      keyring,
    );
    const raw = await readFile(join(d, 'settings.json'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    const loaded = await loadSettings(d, keyring) as any;
    expect(loaded.apiKey).toBe('sk-secret');
  });
});
