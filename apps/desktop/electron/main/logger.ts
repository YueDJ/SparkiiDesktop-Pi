import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class Logger {
  constructor(private dir: string) {}
  private file() { return join(this.dir, 'sparkii.log.jsonl'); }
  async log(entry: { level: 'info' | 'warn' | 'error'; msg: string; ctx?: Record<string, unknown> }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  }
  async export(): Promise<string> {
    try { return await readFile(this.file(), 'utf8'); } catch { return ''; }
  }
}
