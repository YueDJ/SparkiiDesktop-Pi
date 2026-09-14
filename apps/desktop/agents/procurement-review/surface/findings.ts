import type { Cite, Dim, EvaluationSnapshot, Level } from '../engine/types.js';

export interface Finding {
  id: string;
  rowId: string;
  dim: Dim;
  level: Level;
  title: string;
  reason: string;
  advice: string;
  cite: Cite;
  hitId: string;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function citeLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const label = (value as { label?: unknown }).label;
  return typeof label === 'string' ? label.trim() : '';
}

function citeRefs(value: unknown): Cite['refs'] {
  if (!value || typeof value !== 'object') return [];
  const refs = (value as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((ref): ref is Cite['refs'][number] => {
    return !!ref && typeof ref === 'object' && typeof (ref as { kind?: unknown }).kind === 'string';
  });
}

function asDim(value: unknown): Dim | null {
  return value === 'qty' || value === 'price' || value === 'time' || value === 'compliance' || value === 'completeness'
    ? value
    : null;
}

function asLevel(value: unknown): Level | null {
  return value === 'high' || value === 'mid' ? value : null;
}

export function sanitizeFindings(raw: unknown, snap: EvaluationSnapshot): Finding[] {
  const parsed = parseRaw(raw);
  if (!parsed || typeof parsed !== 'object') return [];
  const rows = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(rows)) return [];

  const hitsById = new Map(snap.hits.map((hit) => [hit.id, hit]));
  const out: Finding[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const label = citeLabel(rec.cite);
    if (!label) continue;

    const hitId = typeof rec.hitId === 'string' ? rec.hitId : '';
    const hit = hitId ? hitsById.get(hitId) : undefined;
    const claimedDim = asDim(rec.dim);

    if (claimedDim === 'compliance') {
      if (snap.closed.compliance) continue;
      const rowId = typeof rec.rowId === 'string' ? rec.rowId : '';
      if (!rowId) continue;
      out.push({
        id: typeof rec.id === 'string' ? rec.id : '',
        rowId,
        dim: 'compliance',
        level: asLevel(rec.level) ?? 'mid',
        title: typeof rec.title === 'string' ? rec.title : '',
        reason: typeof rec.reason === 'string' ? rec.reason : '',
        advice: typeof rec.advice === 'string' ? rec.advice : '',
        cite: { label, refs: citeRefs(rec.cite) },
        hitId,
      });
      continue;
    }

    if (!hit) continue;
    out.push({
      id: typeof rec.id === 'string' ? rec.id : '',
      rowId: typeof rec.rowId === 'string' ? rec.rowId : hit.rowId,
      dim: hit.dim,
      level: hit.level,
      title: typeof rec.title === 'string' ? rec.title : '',
      reason: typeof rec.reason === 'string' ? rec.reason : '',
      advice: typeof rec.advice === 'string' ? rec.advice : '',
      cite: { label, refs: citeRefs(rec.cite) },
      hitId: hit.id,
    });
  }

  return out;
}
