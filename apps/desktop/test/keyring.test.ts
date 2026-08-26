import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Keyring } from '../electron/main/keyring.js';

describe('Keyring', () => {
  it('roundtrips encrypted secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-'));
    const fakeSafeStorage = { encryptString: (s: string) => Buffer.from(s).toString('base64'), decryptString: (b: Buffer) => b.toString('utf8') };
    const k = new Keyring(dir, fakeSafeStorage as any);
    await k.set('api', 'secret123');
    expect(await k.get('api')).toBe('secret123');
  });

  it('creates the storage directory when it does not exist', async () => {
    const base = mkdtempSync(join(tmpdir(), 'key-dir-'));
    const dir = join(base, 'nested', 'keyring');
    const fakeSafeStorage = { encryptString: (s: string) => Buffer.from(s).toString('base64'), decryptString: (b: Buffer) => b.toString('utf8') };
    const k = new Keyring(dir, fakeSafeStorage as any);
    await k.set('api', 'secret456');
    expect(await k.get('api')).toBe('secret456');
  });
});
