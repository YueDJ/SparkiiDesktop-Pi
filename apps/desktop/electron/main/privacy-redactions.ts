import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';

interface RedactionPattern {
  hash: string;
  length: number;
}

interface RedactionFile {
  version: 1;
  patterns: RedactionPattern[];
  characters: string[];
  physicalNewline: boolean;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function patternKey(pattern: RedactionPattern): string {
  return `${pattern.length}:${pattern.hash}`;
}

export class PrivacyRedactions {
  private readonly patterns = new Map<string, RedactionPattern>();
  private readonly characters = new Set<string>();
  private physicalNewline = false;
  private signature = '';
  private initialized = false;

  constructor(private readonly file: string) {
    this.refresh();
  }

  private get initializedFile(): string {
    return `${this.file}.initialized`;
  }

  private lstat(file: string): BigIntStats | undefined {
    try {
      return lstatSync(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private requireRegularFile(info: BigIntStats): void {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('隐私脱敏登记文件不安全');
  }

  private ensureInitialized(): void {
    mkdirSync(dirname(this.initializedFile), { recursive: true });
    try {
      writeFileSync(this.initializedFile, '{"version":1}\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = this.lstat(this.initializedFile);
    if (!info) throw new Error('隐私脱敏初始化标记缺失');
    this.requireRegularFile(info);
    if (readFileSync(this.initializedFile, 'utf8') !== '{"version":1}\n') throw new Error('隐私脱敏初始化标记损坏');
    this.initialized = true;
  }

  refresh(): void {
    const initializedInfo = this.lstat(this.initializedFile);
    if (initializedInfo) {
      this.requireRegularFile(initializedInfo);
      if (readFileSync(this.initializedFile, 'utf8') !== '{"version":1}\n') throw new Error('隐私脱敏初始化标记损坏');
    } else if (this.initialized) {
      throw new Error('隐私脱敏初始化标记缺失');
    }
    const info = this.lstat(this.file);
    if (!info) {
      if (initializedInfo || this.signature) throw new Error('隐私脱敏登记文件缺失');
      this.initialized = false;
      return;
    }
    this.requireRegularFile(info);
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    if (signature === this.signature) return;
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RedactionFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.patterns) || !Array.isArray(parsed.characters)
      || typeof parsed.physicalNewline !== 'boolean'
      || parsed.patterns.some((pattern) => !pattern || typeof pattern.hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(pattern.hash) || !Number.isSafeInteger(pattern.length) || pattern.length <= 0)
      || parsed.characters.some((character) => typeof character !== 'string' || !/^[0-9a-f]{64}$/.test(character))) {
      throw new Error('隐私脱敏登记文件损坏');
    }
    for (const pattern of parsed.patterns) this.patterns.set(patternKey(pattern), pattern);
    for (const character of parsed.characters) this.characters.add(character);
    this.physicalNewline = parsed.physicalNewline;
    this.signature = signature;
    if (!initializedInfo && this.patterns.size > 0) this.ensureInitialized();
  }

  get size(): number {
    this.refresh();
    return this.patterns.size;
  }

  get hasPhysicalNewlineSecret(): boolean {
    this.refresh();
    return this.physicalNewline;
  }

  usesCharacter(character: string): boolean {
    this.refresh();
    return this.characters.has(fingerprint(character));
  }

  register(texts: string[]): void {
    this.refresh();
    const values = [...new Set(texts.filter((text) => text.length > 0))];
    if (!values.length) return;
    for (const value of values) {
      for (const character of Array.from(value)) this.characters.add(fingerprint(character));
      if (/[\r\n]/.test(value)) this.physicalNewline = true;
      const variants = [value, JSON.stringify(value).slice(1, -1)];
      if (this.physicalNewline && /[\r\n]/.test(value)) {
        for (const fragment of value.split(/\r\n|\r|\n/).filter(Boolean)) {
          variants.push(fragment, JSON.stringify(fragment).slice(1, -1));
        }
      }
      for (const variant of variants) {
        if (!variant) continue;
        const pattern = { hash: fingerprint(variant), length: variant.length };
        this.patterns.set(patternKey(pattern), pattern);
      }
    }
    const content: RedactionFile = {
      version: 1,
      patterns: [...this.patterns.values()].sort((a, b) => b.length - a.length || a.hash.localeCompare(b.hash)),
      characters: [...this.characters].sort(),
      physicalNewline: this.physicalNewline,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    if (!this.initialized) this.ensureInitialized();
    const temp = join(dirname(this.file), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(content)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.file);
      const info = lstatSync(this.file, { bigint: true });
      this.requireRegularFile(info);
      this.signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  private matches(text: string): Array<{ start: number; length: number }> {
    const byLength = new Map<number, Set<string>>();
    for (const pattern of this.patterns.values()) {
      const hashes = byLength.get(pattern.length) ?? new Set<string>();
      hashes.add(pattern.hash);
      byLength.set(pattern.length, hashes);
    }
    const matches: Array<{ start: number; length: number }> = [];
    for (const [length, hashes] of byLength) {
      for (let start = 0; start + length <= text.length; start += 1) {
        if (hashes.has(fingerprint(text.slice(start, start + length)))) matches.push({ start, length });
      }
    }
    return matches.sort((a, b) => b.length - a.length || a.start - b.start);
  }

  contains(text: string): boolean {
    this.refresh();
    return this.matches(text).length > 0;
  }

  containsAcrossRecords(text: string): boolean {
    this.refresh();
    return this.matches(text).some(({ start, length }) => {
      const value = text.slice(start, start + length);
      return /[\r\n]/.test(value) && /[^\r\n]/.test(value);
    });
  }

  marker(candidates = ['[已删除]', '[REDACTED]', '[removed]']): string {
    this.refresh();
    const safe = (candidate: string): boolean => candidate.length > 0
      && Array.from(candidate).every((character) => !this.characters.has(fingerprint(character)))
      && !this.contains(candidate);
    const named = candidates.find(safe);
    if (named) return named;
    for (let codePoint = 0x25a0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const candidate = String.fromCodePoint(codePoint).repeat(3);
      if (safe(candidate)) return candidate;
    }
    throw new Error('无法生成安全的隐私脱敏标记');
  }

  redact(text: string, marker = this.marker()): string {
    this.refresh();
    if (!text || !this.patterns.size) return text;
    const selected: Array<{ start: number; length: number }> = [];
    for (const match of this.matches(text)) {
      if (selected.some((other) => match.start < other.start + other.length && other.start < match.start + match.length)) continue;
      selected.push(match);
    }
    selected.sort((a, b) => a.start - b.start);
    let output = '';
    let cursor = 0;
    for (const match of selected) {
      output += text.slice(cursor, match.start) + marker;
      cursor = match.start + match.length;
    }
    output += text.slice(cursor);
    if (this.contains(output)) throw new Error('隐私脱敏输出仍包含登记模式');
    return output;
  }
}
