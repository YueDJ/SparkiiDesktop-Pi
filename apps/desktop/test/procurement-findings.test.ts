import { describe, it, expect } from 'vitest';
import { sanitizeFindings } from '../agents/procurement-review/surface/findings.js';
import type { EvaluationSnapshot } from '../agents/procurement-review/engine/types.js';

const snap: EvaluationSnapshot = {
  lines: [],
  hits: [{
    id: 'h1', rowId: 'M-煤', dim: 'qty', level: 'high', ruleId: 'qty.over-cover',
    metrics: { coverMonths: 10 }, cite: { label: '覆盖>4个月', refs: [] },
  }],
  closed: { qty: false, price: true, time: true, compliance: true },
  conflicts: [],
};

describe('sanitizeFindings', () => {
  it('keeps findings whose hitId exists and forces hit level/dim', () => {
    const out = sanitizeFindings({
      findings: [
        { id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'low', title: '烟煤可覆盖约 10 个月', reason: '库里多', advice: '核减', cite: { label: '覆盖>4个月' }, hitId: 'h1' },
        { id: 'r2', rowId: 'M-煤', dim: 'price', level: 'high', title: '价格正常', reason: '我觉得还行', advice: '', cite: { label: '无' }, hitId: 'nope' },
        { id: 'r3', rowId: 'M-煤', dim: 'qty', level: 'high', title: '无依据', reason: 'x', advice: 'y', cite: { label: '' }, hitId: 'h1' },
      ],
    }, snap);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'high', dim: 'qty', title: '烟煤可覆盖约 10 个月' });
  });

  it('accepts workflow_step_end review output as a JSON string', () => {
    const raw = JSON.stringify({
      findings: [{ id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'high', title: '烟煤可覆盖约 10 个月', reason: 'x', advice: 'y', cite: { label: '覆盖>4个月' }, hitId: 'h1' }],
    });
    expect(sanitizeFindings(raw, snap)).toHaveLength(1);
  });

  it('drops compliance when that dim is closed', () => {
    expect(sanitizeFindings({
      findings: [{ id: 'c1', rowId: 'M-煤', dim: 'compliance', level: 'mid', title: '越权', reason: '猜的', advice: '补签', cite: { label: '第12条' }, hitId: '' }],
    }, snap)).toEqual([]);
  });
});
