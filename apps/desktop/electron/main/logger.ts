import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivacyRedactions } from './privacy-redactions.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SCHEMA_KEYS = new Set([
  'ts', 'level', 'msg', 'ctx',
  'sessionId', 'profileId', 'agentId', 'taskId', 'actionId', 'requestId',
]);

function physicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export class Logger {
  level: LogLevel = 'info';
  private readonly redactions: PrivacyRedactions;
  constructor(private dir: string, private consoleEcho = true) {
    this.redactions = new PrivacyRedactions(join(dir, 'privacy-redactions.json'));
  }
  private file() { return join(this.dir, 'sparkii.log.jsonl'); }
  private redactionMarker(): string {
    return this.redactions.marker();
  }
  private containsRegisteredSecret(text: string): boolean {
    return this.redactions.contains(text);
  }
  private containsRegisteredValue(value: unknown): boolean {
    if (typeof value === 'string') return this.containsRegisteredSecret(value);
    if (Array.isArray(value)) return value.some((item) => this.containsRegisteredValue(item));
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).some(([key, item]) =>
        (!SCHEMA_KEYS.has(key) && this.containsRegisteredSecret(key)) || this.containsRegisteredValue(item));
    }
    return false;
  }
  private serializeVerified(value: unknown): string {
    return this.containsRegisteredValue(value) ? this.malformedPlaceholder() : JSON.stringify(value);
  }
  private malformedLineContainsPhysicalSecret(line: string): boolean {
    return this.redactions.hasPhysicalNewlineSecret && !line.trimStart().startsWith('{');
  }

  private verifiedOutput(text: string): string {
    return this.containsRegisteredSecret(text) ? this.malformedPlaceholder() : text;
  }
  private redactText(text: string): string {
    return this.redactions.redact(text, this.redactionMarker());
  }
  /** 只替换 JSON 字符串值；明确 schema 键保持不变，动态键由统一输出验证拦截。 */
  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactValue(item)]));
    }
    return value;
  }
  private malformedPlaceholder(): string {
    const marker = this.redactionMarker();
    const level = (['error', 'warn', 'info', 'debug'] as const)
      .find((candidate) => !this.containsRegisteredSecret(candidate)) ?? marker;
    return JSON.stringify({ level, msg: marker, ctx: {} });
  }
  private redactMalformedLine(line: string): string {
    if (this.redactions.size === 0) return line;
    let output = '';
    let offset = 0;
    let index = 0;
    while (index < line.length) {
      const quote = line.indexOf('"', index);
      if (quote < 0) break;
      const prefix = line.slice(offset, quote);
      // 字符串外的转义无法可靠解释，不能把可能的编码秘密留回结果。
      if (prefix.includes('\\')) return this.malformedPlaceholder();
      output += this.redactText(prefix);

      let end = quote + 1;
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2;
          continue;
        }
        if (line[end] === '"') break;
        end += 1;
      }
      if (end >= line.length) return this.malformedPlaceholder();
      const token = line.slice(quote, end + 1);
      let decoded: unknown;
      try {
        // JSON.parse 覆盖全部 JSON 转义，包括 \uXXXX、代理对和 \/。
        decoded = JSON.parse(token);
      } catch {
        return this.malformedPlaceholder();
      }
      if (typeof decoded !== 'string') return this.malformedPlaceholder();
      if (/^\s*:/.test(line.slice(end + 1))) {
        const schemaKey = SCHEMA_KEYS.has(decoded);
        if (!schemaKey && this.containsRegisteredSecret(decoded)) {
          return this.malformedPlaceholder();
        }
        output += token;
      } else {
        output += JSON.stringify(this.redactText(decoded));
      }
      offset = end + 1;
      index = offset;
    }
    const suffix = line.slice(offset);
    if (suffix.includes('\\')) return this.malformedPlaceholder();
    return output + this.redactText(suffix);
  }
  private redactLine(line: string): string {
    if (!line) return line;
    try {
      return this.serializeVerified(this.redactValue(JSON.parse(line)));
    } catch {
      if (this.malformedLineContainsPhysicalSecret(line)) return this.malformedPlaceholder();
      // 保留可安全清理的损坏历史行；无法解码的字符串整体替换为脱敏占位记录。
      return this.verifiedOutput(this.redactMalformedLine(line));
    }
  }
  private outputPreservesSecret(text: string): boolean {
    if (this.redactions.hasPhysicalNewlineSecret && this.redactions.containsAcrossRecords(text)) return true;
    return physicalLines(text).some((line) => {
      if (!line) return false;
      try {
        return this.containsRegisteredValue(JSON.parse(line));
      } catch {
        return this.containsRegisteredSecret(line);
      }
    });
  }
  private rewrite(lines: string[]): void {
    const path = this.file();
    const temp = `${path}.redact.tmp`;
    let output = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    if (this.outputPreservesSecret(output)) throw new Error('log redaction verification failed');
    writeFileSync(temp, output, 'utf8');
    renameSync(temp, path);
  }
  redactMemoryPromptLogs(): void {
    let lines: string[];
    try {
      lines = physicalLines(readFileSync(this.file(), 'utf8')).filter((line) => {
        if (!line.trim()) return false;
        try { return JSON.parse(line).msg !== 'memory prompt block appended to saddle'; } catch { return true; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    this.rewrite(lines.map((line) => this.redactLine(line)));
  }
  redactSession(sessionId: string, texts: string[]): void {
    this.redactions.register(texts);
    let existing: string;
    try { existing = readFileSync(this.file(), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const lines = physicalLines(existing).filter((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as { ctx?: { sessionId?: unknown } };
        return entry.ctx?.sessionId !== sessionId;
      } catch { return true; }
    });
    this.rewrite(lines.map((line) => this.redactLine(line)));
  }
  private safeContext(ctx: Record<string, unknown> | undefined): unknown {
    if (ctx === undefined) return undefined;
    try {
      const serialized = JSON.stringify(ctx);
      return serialized === undefined ? { serialization: 'failed' } : JSON.parse(serialized);
    } catch {
      return { serialization: 'failed' };
    }
  }
  async log(entry: { level: LogLevel; msg: string; ctx?: Record<string, unknown> }): Promise<void> {
    if (LEVEL_RANK[entry.level] < LEVEL_RANK[this.level]) return;
    const ctx = this.safeContext(entry.ctx);
    if (this.consoleEcho) {
      const message = this.verifiedOutput(this.redactText(entry.msg));
      const context = this.serializeVerified(this.redactValue(ctx ?? ''));
      if (entry.level === 'error') console.error(message, context);
      else if (entry.level === 'warn') console.warn(message, context);
      else console.log(message, context);
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      const line = this.serializeVerified(this.redactValue({ ts: Date.now(), ...entry, ctx }));
      appendFileSync(this.file(), `${line}\n`, 'utf8');
    } catch {
      // 日志写盘失败不阻断主流程
    }
  }
  async export(): Promise<string> {
    try {
      const existing = await readFile(this.file(), 'utf8');
      const output = physicalLines(existing).map((line) => this.redactLine(line)).join('\n');
      return this.outputPreservesSecret(output) ? this.malformedPlaceholder() : output;
    } catch { return ''; }
  }
}
