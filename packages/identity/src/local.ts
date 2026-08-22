import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { AuthError, type IdentityProvider, type Subject, type UserRecord } from './types.js';

const N = 16384, r = 8, p = 1;

function hash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, 64, { N, r, p }, (e, k) => (e ? rej(e) : res(k))));
}

export class LocalIdentityProvider implements IdentityProvider {
  private users = new Map<string, UserRecord>();
  constructor(private file: string) {}

  async seed(u: { id: string; username: string; password: string; roles: string[] }): Promise<void> {
    const salt = randomBytes(16);
    const key = await hash(u.password, salt);
    this.users.set(u.id, {
      id: u.id, username: u.username,
      passwordHash: `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`,
      roles: u.roles,
    });
    await this.persist();
  }

  async authenticate(username: string, password: string): Promise<Subject> {
    await this.load();
    const u = [...this.users.values()].find((x) => x.username === username);
    if (!u) throw new AuthError('USER_NOT_FOUND', 'no such user');
    const [, n, rr, pp, saltHex, hashHex] = u.passwordHash.split('$');
    const key = await hash(password, Buffer.from(saltHex, 'hex'));
    const expected = Buffer.from(hashHex, 'hex');
    if (key.length !== expected.length || !timingSafeEqual(key, expected)) throw new AuthError('AUTH_FAILED', 'bad password');
    return { userId: u.id, roles: u.roles };
  }

  async listUsers() { await this.load(); return [...this.users.values()].map(({ id, username, roles }) => ({ id, username, roles })); }

  private async load() {
    const raw = await readFile(this.file, 'utf8').catch(() => '[]');
    this.users = new Map((JSON.parse(raw) as UserRecord[]).map((u) => [u.id, u]));
  }
  private async persist() {
    const tmp = join(dirname(this.file), `.${basename(this.file)}.tmp`);
    await writeFile(tmp, JSON.stringify([...this.users.values()], null, 2));
    await rename(tmp, this.file);
  }
}
