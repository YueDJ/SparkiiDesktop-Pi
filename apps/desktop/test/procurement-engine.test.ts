import { describe, it, expect } from 'vitest';
import { evaluatePack, prepareWorkflowInput } from '../agents/procurement-review/engine/evaluate.js';
import { DEFAULT_RULES } from '../agents/procurement-review/engine/default-rules.js';

const coal = { id: 'M-煤', code: 'RM-001', name: '烟煤', qty: 2800, unit: '吨', unitPrice: 920 };
const brick = { id: 'M-砖', code: 'SP-203', name: '镁铬砖', qty: 40, unit: '吨', unitPrice: 2680 };

function baseFacts() {
  return {
    stock: [
      { code: 'RM-001', qty: 4200, asOf: '2026-09-13', source: 'upload' as const },
      { code: 'SP-203', qty: 95, asOf: '2026-09-13', source: 'upload' as const },
    ],
    usage: [
      { code: 'RM-001', qty: 2100, days: 90, source: 'upload' as const },
      { code: 'SP-203', qty: 12, days: 90, source: 'upload' as const },
    ],
    deals: [
      ...Array.from({ length: 12 }, (_, i) => ({
        code: 'RM-001', unitPrice: 780, at: `2026-0${(i % 9) + 1}-15`, source: 'upload' as const,
      })),
      ...Array.from({ length: 5 }, () => ({
        code: 'SP-203', unitPrice: 2410, at: '2026-06-01', source: 'upload' as const,
      })),
    ],
    transit: [{ code: 'SP-203', qty: 36, ref: 'PO-883', at: '2026-09-02', source: 'upload' as const }],
  };
}

const ranges = { usageDays: 90 as const, priceMonths: 12 as const, transitDays: 30 as const };

describe('evaluatePack', () => {
  it('marks coal over-cover as high qty and fills joined line', () => {
    const snap = evaluatePack({
      plan: [coal, brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: 'default', ranges, asOf: '2026-09-14',
    });
    const hit = snap.hits.find((h) => h.rowId === 'M-煤' && h.ruleId === 'qty.over-cover');
    expect(hit).toMatchObject({ dim: 'qty', level: 'high' });
    expect(Number(hit!.metrics.coverMonths)).toBeCloseTo(10, 0);
    expect(snap.lines.find((l) => l.id === 'M-煤')).toMatchObject({
      stockQty: 4200, usageQty: 2100, qtyOpen: true,
    });
    expect(snap.closed.qty).toBe(false);
  });

  it('marks coal price high, brick price mid, and closes compliance when policyKb is null', () => {
    const snap = evaluatePack({
      plan: [coal, brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'price.dev-high')).toMatchObject({ rowId: 'M-煤', level: 'high' });
    expect(snap.hits.find((h) => h.ruleId === 'price.dev-mid')).toMatchObject({ rowId: 'M-砖', level: 'mid' });
    expect(snap.closed.compliance).toBe(true);
    expect(snap.hits.some((h) => h.dim === 'compliance')).toBe(false);
  });

  it('marks brick in-transit as time duplicate', () => {
    const snap = evaluatePack({
      plan: [brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'time.duplicate')).toMatchObject({
      rowId: 'M-砖', dim: 'time', level: 'mid',
    });
  });

  it('closes qty on a line that has stock but no usage', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: { ...baseFacts(), usage: [] },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.lines[0].qtyOpen).toBe(false);
    expect(snap.closed.qty).toBe(true);
    expect(snap.hits.some((h) => h.dim === 'qty')).toBe(false);
  });

  it('emits dims-closed on a thin pack', () => {
    const thin = evaluatePack({
      plan: [coal],
      facts: { stock: [], usage: [], deals: [], transit: [] },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(thin.closed).toEqual({ qty: true, price: true, time: true, compliance: true });
    expect(thin.hits.some((h) => h.ruleId === 'completeness.dims-closed')).toBe(true);
    expect(thin.banner).toMatch(/未评估/);
  });

  it('closes qty/price/time for a line without material code', () => {
    const snap = evaluatePack({
      plan: [{ id: 'x', code: null, name: '杂项', qty: 1, unit: '个', unitPrice: 10 }],
      facts: baseFacts(), rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.lines[0]).toMatchObject({ qtyOpen: false, priceOpen: false, timeOpen: false });
    expect(snap.hits.some((h) => h.ruleId === 'completeness.missing-code')).toBe(true);
  });

  it('uses upload stock for coverMonths and still records the pull conflict', () => {
    const facts = baseFacts();
    facts.stock.push({ code: 'RM-001', qty: 100, asOf: '2026-09-13', source: 'pull' });
    const snap = evaluatePack({
      plan: [coal], facts, rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.conflicts.some((c) => c.code === 'RM-001' && c.field === 'stock' && c.pull === 100 && c.upload === 4200)).toBe(true);
    expect(snap.lines[0].stockQty).toBe(4200);
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')!.cite.label).toMatch(/100/);
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')!.cite.label).toMatch(/4200/);
  });

  it('cites stale stock against pack.asOf when requestDate is missing', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: {
        stock: [{ code: 'RM-001', qty: 4200, asOf: '2026-08-01', source: 'upload' }],
        usage: [{ code: 'RM-001', qty: 2100, days: 90, source: 'upload' }],
        deals: [],
        transit: [],
      },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')?.cite.label).toMatch(/库存可能不是当天/);
  });

  it('raises price.dev-mid when midPct < |dev| ≤ highPct even if dealCount < minSamples', () => {
    const snap = evaluatePack({
      plan: [brick],
      facts: {
        stock: [],
        usage: [],
        deals: [{ code: 'SP-203', unitPrice: 2410, at: '2026-06-01', source: 'upload' }],
        transit: [],
      },
      rules: DEFAULT_RULES,
      policyKb: null,
      ranges,
      asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'price.dev-mid')).toMatchObject({ rowId: 'M-砖', level: 'mid' });
    expect(snap.hits.some((h) => h.ruleId === 'price.dev-high')).toBe(false);
  });

  it('does not raise price.dev-high when the last deal is older than staleMonths but inside priceMonths', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: {
        stock: [],
        usage: [],
        deals: Array.from({ length: 4 }, () => ({
          code: 'RM-001', unitPrice: 780, at: '2025-01-01', source: 'upload' as const,
        })),
        transit: [],
      },
      rules: DEFAULT_RULES, policyKb: null,
      ranges: { usageDays: 90, priceMonths: 24, transitDays: 30 },
      asOf: '2026-09-14',
    });
    expect(snap.hits.some((h) => h.ruleId === 'price.dev-high')).toBe(false);
  });

  it('uses upload deal median and records pull/upload deal conflict', () => {
    const facts = {
      stock: [],
      usage: [],
      deals: [
        ...Array.from({ length: 5 }, () => ({
          code: 'RM-001', unitPrice: 780, at: '2026-06-01', source: 'upload' as const,
        })),
        ...Array.from({ length: 5 }, () => ({
          code: 'RM-001', unitPrice: 900, at: '2026-06-01', source: 'pull' as const,
        })),
      ],
      transit: [],
    };
    const snap = evaluatePack({
      plan: [coal], facts, rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.conflicts.some((c) => c.code === 'RM-001' && c.field === 'deal' && c.pull === 900 && c.upload === 780)).toBe(true);
    expect(snap.lines[0].medianPrice).toBe(780);
    const hit = snap.hits.find((h) => h.ruleId === 'price.dev-high');
    expect(hit?.cite.label).toMatch(/900/);
    expect(hit?.cite.label).toMatch(/780/);
  });

  it('uses upload transit qty and records pull/upload transit conflict', () => {
    const facts = {
      stock: [],
      usage: [],
      deals: [],
      transit: [
        { code: 'SP-203', qty: 36, ref: 'PO-883', at: '2026-09-02', source: 'upload' as const },
        { code: 'SP-203', qty: 10, ref: 'PO-100', at: '2026-09-02', source: 'pull' as const },
      ],
    };
    const snap = evaluatePack({
      plan: [brick], facts, rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.conflicts.some((c) => c.code === 'SP-203' && c.field === 'transit' && c.pull === 10 && c.upload === 36)).toBe(true);
    expect(snap.lines[0].transitQty).toBe(36);
    const hit = snap.hits.find((h) => h.ruleId === 'time.duplicate');
    expect(hit?.cite.label).toMatch(/10/);
    expect(hit?.cite.label).toMatch(/36/);
  });

  it('prepareWorkflowInput blanks query when policyKb is null', () => {
    const pack = {
      plan: [coal], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null as const, ranges, asOf: '2026-09-14',
    };
    expect(prepareWorkflowInput(pack, ['C:/plan.csv']).query).toBe('');
    expect(prepareWorkflowInput({ ...pack, policyKb: 'default' }, ['C:/plan.csv']).query).toMatch(/烟煤/);
  });
});
