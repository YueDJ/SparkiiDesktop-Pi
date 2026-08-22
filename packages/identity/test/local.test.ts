import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LocalIdentityProvider } from '../src/local.js';

describe('LocalIdentityProvider', () => {
  it('authenticates a seeded user', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'id-')), 'users.json');
    const p = new LocalIdentityProvider(file);
    await p.seed({ id: 'u1', username: 'admin', password: 'pw123', roles: ['admin'] });
    const subj = await p.authenticate('admin', 'pw123');
    expect(subj.userId).toBe('u1');
    expect(subj.roles).toContain('admin');
  });
  it('rejects wrong password', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'id-')), 'users.json');
    const p = new LocalIdentityProvider(file);
    await p.seed({ id: 'u1', username: 'admin', password: 'pw123', roles: ['admin'] });
    await expect(p.authenticate('admin', 'bad')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
