import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  level: LogLevel = 'info';
  constructor(private dir: string, private consoleEcho = true) {}
  private file() { return join(this.dir, 'sparkii.log.jsonl'); }
  async log(entry: { level: LogLevel; msg: string; ctx?: Record<string, unknown> }): Promise<void> {
    if (LEVEL_RANK[entry.level] < LEVEL_RANK[this.level]) return;
    if (this.consoleEcho) {
      if (entry.level === 'error') console.error(entry.msg, entry.ctx ?? '');
      else if (entry.level === 'warn') console.warn(entry.msg, entry.ctx ?? '');
      else console.log(entry.msg, entry.ctx ?? '');
    }
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
    } catch {
      // 日志写盘失败不阻断主流程
    }
  }
  async export(): Promise<string> {
    try { return await readFile(this.file(), 'utf8'); } catch { return ''; }
  }
}
