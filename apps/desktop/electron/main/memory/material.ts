import { readPiSessionEntries } from '@sparkii/agent-host';

export interface MaterialEntry {
  id: string;
  type: string;
  parentId: string | null;
  timestamp?: string;
  role?: string;
  text?: string;
}

export interface SessionMaterial {
  branch: MaterialEntry[];
  fresh: MaterialEntry[];
  text: string;
  userTurns: number;
  lastEntryId: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = (block ?? {}) as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (typeof b.content === 'string') return b.content;
      return '';
    })
    .join(' ')
    .trim();
}

function entryText(entry: MaterialEntry): string {
  const message = (entry as unknown as { message?: { role?: string; content?: unknown } }).message;
  const role = entry.role ?? message?.role;
  if (role !== 'user' && role !== 'assistant') return '';
  return textOf(entry.text ?? message?.content ?? message);
}

/** JSONL 是树（parentId/分支）+ compaction 条目；位点用 entry-id，不用字节偏移。 */
export function readSessionMaterial(
  piSessionFile: string,
  cursorId: string,
  maxChars = 6000,
): SessionMaterial {
  const raw = readPiSessionEntries(piSessionFile) as unknown as MaterialEntry[];
  const byId = new Map(raw.map((e) => [e.id, e]));
  const branch: MaterialEntry[] = [];
  let cursor: MaterialEntry | undefined = raw[raw.length - 1];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();

  const offsetMarker = cursorId.lastIndexOf('@');
  const cursorEntryId = offsetMarker > 0 ? cursorId.slice(0, offsetMarker) : cursorId;
  const cursorOffset = offsetMarker > 0 ? Number(cursorId.slice(offsetMarker + 1)) : 0;
  const cursorIndex = cursorEntryId ? branch.findIndex((e) => e.id === cursorEntryId) : -1;
  if (cursorEntryId && cursorIndex < 0) {
    throw new Error(`material-unreadable: stale-cursor ${cursorEntryId}`);
  }
  if (!Number.isInteger(cursorOffset) || cursorOffset < 0) {
    throw new Error(`material-unreadable: stale-cursor ${cursorId}`);
  }
  if (cursorIndex >= 0 && cursorOffset > 0) {
    const text = entryText(branch[cursorIndex]);
    if (!text || cursorOffset > text.length) {
      throw new Error(`material-unreadable: stale-cursor ${cursorId}`);
    }
  }
  const fresh = cursorIndex >= 0 ? branch.slice(cursorIndex + (cursorOffset > 0 ? 0 : 1)) : branch;
  const lines: string[] = [];
  let userTurns = 0;
  let used = 0;
  let lastEntryId = cursorId;
  let consumed = false;
  for (const entry of fresh) {
    if (entry.type !== 'message') continue;
    const role = entry.role ?? (entry as unknown as { message?: { role?: string } }).message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = entryText(entry);
    if (!text) continue;
    const start = !consumed && entry.id === cursorEntryId ? cursorOffset : 0;
    const prefix = `${role === 'user' ? '用户' : '助手'}：`;
    const remaining = Math.max(0, maxChars - used - prefix.length);
    if (remaining <= 0) break;
    const part = text.slice(start, start + remaining);
    if (!part) continue;
    if (role === 'user') userTurns += 1;
    lines.push(`${prefix}${part}`);
    used += prefix.length + part.length;
    consumed = true;
    const absoluteOffset = start + part.length;
    lastEntryId = absoluteOffset < text.length ? `${entry.id}@${absoluteOffset}` : entry.id;
    if (absoluteOffset < text.length) break;
  }
  return { branch, fresh, text: lines.join('\n'), userTurns, lastEntryId };
}

/** 兼容测试与手工素材：从 role/text 对生成同样的文本。 */
export function materialFromTurns(turns: Array<{ role: 'user' | 'assistant'; text: string }>): SessionMaterial {
  const text = turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n');
  return {
    branch: [], fresh: [], text,
    userTurns: turns.filter((t) => t.role === 'user').length,
    lastEntryId: '',
  };
}
