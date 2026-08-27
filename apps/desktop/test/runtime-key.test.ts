import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '../electron/main/keyring.js';
import { createKeyStore } from '../electron/main/runtime.js';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ''),
  } as any;
}

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runtime key store', () => {
  it('reads apiKey:<providerId> on first use and serves the rest from cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-key-'));
    const keyring = new Keyring(join(dir, 'keyring'), fakeSafeStorage());
    await keyring.set('apiKey:deepseek', 'sk-first');
    const spy = vi.spyOn(keyring, 'get');

    const store = createKeyStore(keyring);
    expect(await store.keyFor('deepseek')).toBe('sk-first');
    expect(await store.keyFor('deepseek')).toBe('sk-first');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('apiKey:deepseek');
  });

  it('setKey writes the keyring and makes keyFor return the new key without re-reading', async () => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-key-'));
    const keyring = new Keyring(join(dir, 'keyring'), fakeSafeStorage());
    const store = createKeyStore(keyring);

    await store.setKey('deepseek', 'sk-new');
    const spy = vi.spyOn(keyring, 'get');
    expect(await store.keyFor('deepseek')).toBe('sk-new');
    expect(spy).not.toHaveBeenCalled();
  });
});
