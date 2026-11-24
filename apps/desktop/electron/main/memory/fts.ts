import Database from 'better-sqlite3';
import type { ErrorStore } from '../error-store.js';

/**
 * M1 第 0 步：运行时探测 FTS5 trigram。
 * 编译期已有 SQLite 3.53.4 + SQLITE_ENABLE_FTS5 的证据，但预构建二进制一致性只是推断。
 * 探测失败不是致命错误：检索退化 LIKE，并在设置页/汇报里记录。
 */
export function probeFts5Trigram(): { available: boolean; sqliteVersion: string; reason?: string } {
  let db: Database.Database | undefined;
  try {
    db = new Database(':memory:');
    const sqliteVersion = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')");
    db.prepare('INSERT INTO t(x) VALUES (?)').run('记忆探测：中文 trigram 分词');
    const row = db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?').get('"记忆探测"') as { c: number };
    if (row.c < 1) return { available: false, sqliteVersion, reason: 'trigram query returned no match' };
    return { available: true, sqliteVersion };
  } catch (error) {
    return {
      available: false,
      sqliteVersion: 'unknown',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

/** trigram 需要三个字符；短查询必须走 LIKE，否则永远命中不了。 */
export function canUseTrigram(query: string, ftsAvailable: boolean): boolean {
  return ftsAvailable && query.replace(/\s+/g, '').length >= 3;
}

/** FTS MATCH 字符串转义：引号加倍，避免用户查询把表达式弄坏。 */
export function ftsMatchQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * 短语没命中时的退路：把查询切成若干三字窗口做 OR，交给 bm25 排序。
 * 中文没有空格，用户"上个月那个项目的报价"这种整句问法用短语匹配必然落空；
 * 切片后「上个月」「那个项」「项目的」「的报价」至少能撞上情景摘要里的原话。
 */
export function ftsWindowQuery(query: string, maxTerms = 6): string | null {
  const compact = query.replace(/\s+/g, '');
  if (compact.length < 4) return null;
  const windows: string[] = [];
  for (let i = 0; i + 3 <= compact.length && windows.length < maxTerms; i += 2) {
    const piece = compact.slice(i, i + 3);
    if (!windows.includes(piece)) windows.push(piece);
  }
  if (!windows.length) return null;
  return windows.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ');
}

export function recordMemoryError(errors: ErrorStore | undefined, source: string, message: string): void {
  errors?.append({
    id: `memory:${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    message,
    source: `memory.${source}`,
    createdAt: Date.now(),
  });
}
