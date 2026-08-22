import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export class Keyring {
  constructor(private dir: string, private ss = safeStorage) {}
  private file(name: string) { return join(this.dir, `${name}.enc`); }
  async set(name: string, value: string): Promise<void> {
    const enc = this.ss.encryptString(value).toString('base64');
    await writeFile(this.file(name), enc);
  }
  async get(name: string): Promise<string | null> {
    try {
      const enc = Buffer.from(await readFile(this.file(name), 'utf8'), 'base64');
      return this.ss.decryptString(enc);
    } catch { return null; }
  }
}
