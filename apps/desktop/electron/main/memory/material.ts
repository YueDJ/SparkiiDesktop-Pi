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

  const cursorIndex = cursorId ? branch.findIndex((e) => e.id === cursorId) : -1;
  const fresh = cursorIndex >= 0 ? branch.slice(cursorIndex + 1) : branch;
  const lines: string[] = [];
  let userTurns = 0;
  let used = 0;
  for (const entry of fresh) {
    if (entry.type !== 'message') continue;
    const message = (entry as unknown as { message?: { role?: string; content?: unknown } }).message;
    const role = entry.role ?? message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(entry.text ?? message?.content ?? message);
    if (!text) continue;
    if (role === 'user') userTurns += 1;
    const line = `${role === 'user' ? '用户' : '助手'}：${text.slice(0, 800)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  const lastEntryId = fresh.length ? fresh[fresh.length - 1].id : cursorId;
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
