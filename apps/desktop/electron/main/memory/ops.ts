export interface ExtractedOp {
  op: 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP';
  scope?: string;
  text?: string;
  targetId?: string;
  importance?: number;
  excerpt?: string;
  reason?: string;
  replacementText?: string;
}

export interface ParsedExtraction {
  sessionSummary: string;
  topics: string[];
  ops: ExtractedOp[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('可选字段必须是字符串');
  return value;
}

/** fail closed：任何字段非法整批抛错，调用方丢弃整批并落 errors.db。 */
export function parseExtraction(raw: string): ParsedExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('提炼输出不是合法 JSON');
  }
  if (!isRecord(parsed)) throw new Error('提炼输出必须是对象');
  if (typeof parsed.sessionSummary !== 'string') throw new Error('sessionSummary 必须是字符串');
  const sessionSummary = parsed.sessionSummary.trim();
  if (!sessionSummary || sessionSummary.length > 150) throw new Error('sessionSummary 必须是 1–150 字');
  if (!Array.isArray(parsed.topics) || parsed.topics.some((t) => typeof t !== 'string')) {
    throw new Error('topics 必须是字符串数组');
  }
  if (!Array.isArray(parsed.ops) || parsed.ops.length > 5) throw new Error('ops 必须是数组且不超过 5 条');
  const ops: ExtractedOp[] = parsed.ops.map((value) => {
    if (!isRecord(value)) throw new Error('op 必须是对象');
    if (typeof value.op !== 'string') throw new Error('op 必须是字符串');
    const op = value.op as ExtractedOp['op'];
    if (!['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'].includes(op)) throw new Error('未知 op');
    if (op === 'NOOP') return { op };
    if (op === 'ADD') {
      if (typeof value.text !== 'string') throw new Error('ADD.text 必须是字符串');
      const text = value.text.trim();
      if (!text || text.length > 200) throw new Error('ADD.text 必须是 1–200 字');
      if (value.scope !== undefined && typeof value.scope !== 'string') throw new Error('scope 必须是字符串');
      const scope = value.scope ?? 'user';
      if (!['user', 'agent', 'project'].includes(scope)) throw new Error('未知 scope');
      if (value.importance !== undefined && typeof value.importance !== 'number') throw new Error('importance 必须是数字');
      const importance = value.importance ?? 2;
      if (!Number.isInteger(importance) || importance < 1 || importance > 3) throw new Error('importance 必须是 1–3');
      return {
        op, text, scope, importance,
        excerpt: optionalString(value.excerpt).slice(0, 120),
      };
    }
    if (typeof value.targetId !== 'string') throw new Error(`${op} 缺少合法 targetId`);
    const targetId = value.targetId;
    if (!targetId.startsWith('mem_')) throw new Error(`${op} 缺少合法 targetId`);
    if (op === 'UPDATE') {
      if (typeof value.text !== 'string') throw new Error('UPDATE.text 必须是字符串');
      const text = value.text.trim();
      if (!text || text.length > 200) throw new Error('UPDATE.text 必须是 1–200 字');
      return { op, targetId, text, excerpt: optionalString(value.excerpt).slice(0, 120) };
    }
    if (typeof value.replacementText !== 'string') throw new Error('SUPERSEDE.replacementText 必须是字符串');
    const replacementText = value.replacementText.trim();
    if (!replacementText || replacementText.length > 200) throw new Error('SUPERSEDE.replacementText 必须是 1–200 字');
    return { op, targetId, replacementText, reason: optionalString(value.reason).slice(0, 200) };
  });
  return {
    sessionSummary,
    topics: (parsed.topics as string[]).map((t) => t.slice(0, 80)),
    ops,
  };
}

/** 字符三元组 Jaccard；同 scope 文本 ≥0.85 的 ADD 降级为 UPDATE 候选。 */
export function trigramSimilarity(left: string, right: string): number {
  const grams = (value: string): Set<string> => {
    const normalized = value.replace(/\s+/g, '').toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i + 3 <= normalized.length; i += 1) out.add(normalized.slice(i, i + 3));
    if (!out.size) out.add(normalized);
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  let intersection = 0;
  for (const g of a) if (b.has(g)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}
