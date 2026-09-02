import { describe, it, expect } from 'vitest';
import { parseRiskFindings, formatReport, stepStatus, parseClauseGroups } from '../agents/contract-review/surface/contract.js';
import { deriveSteps } from '../agents/contract-review/surface/manifest-steps.js';

describe('parseRiskFindings', () => {
  it('maps rows with risk levels and advice to findings', () => {
    const rows = [
      { 条款: '第7条 付款条件', 风险: '高风险', 建议: '约定逾期付款违约金上限' },
      { 条款: '第12条 违约责任', 风险: '中', 建议: '限定赔偿范围' },
      { clause: '第3条 定义', level: 'low', advice: '补充验收定义' },
    ];
    const out = parseRiskFindings(rows);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 'f0', title: '第7条 付款条件', level: 'high', advice: '约定逾期付款违约金上限' });
    expect(out[1].level).toBe('mid');
    expect(out[2].level).toBe('low');
  });

  it('handles primitive rows, empty and undefined input', () => {
    expect(parseRiskFindings(['第7条 付款条件', 42])[0].title).toBe('第7条 付款条件');
    expect(parseRiskFindings([])).toEqual([]);
    expect(parseRiskFindings(undefined)).toEqual([]);
  });

  it('prefers structured id/title/level/advice fields', () => {
    const out = parseRiskFindings([
      { id: 'r1', title: '付款周期过长', level: 'high', clause: '第7条', ruleId: 'rg-01', ruleText: '账期≤30天', advice: '约定逾期违约金' },
    ]);
    expect(out[0]).toMatchObject({ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' });
  });
});

describe('formatReport', () => {
  it('formats title/sections reports', () => {
    const r = { title: '合同审核报告', sections: [{ heading: '结论', body: '重点关注付款条款' }] };
    expect(formatReport(r)).toEqual({ title: '合同审核报告', blocks: [{ heading: '结论', body: '重点关注付款条款' }] });
  });

  it('falls back to a single block for plain strings and null', () => {
    expect(formatReport('hello')!.blocks[0].body).toBe('hello');
    expect(formatReport(null)).toBeNull();
  });

  it('carries through a structured risk table', () => {
    const r = formatReport({ title: '报告', sections: [{ heading: '结论', body: '重点关注' }], riskTable: { totals: { high: 2 } } });
    expect(r?.title).toBe('报告');
    expect(r?.riskTable).toEqual({ totals: { high: 2 } });
  });
});

describe('parseClauseGroups', () => {
  it('parses typed clause groups', () => {
    const out = parseClauseGroups([{ category: '付款', clauses: [{ text: '第7条 约定账期30天', position: 'p12' }] }]);
    expect(out[0].category).toBe('付款');
    expect(out[0].clauses[0].text).toBe('第7条 约定账期30天');
  });
});

describe('stepStatus', () => {
  it('marks steps by workflow state', () => {
    const status = stepStatus({ status: 'running', step: 'compare' });
    expect(status[0].state).toBe('done');
    expect(status.find((s) => s.id === 'compare')!.state).toBe('active');
    expect(status.find((s) => s.id === 'report')!.state).toBe('pending');
  });

  it('resolves idle and done states', () => {
    expect(stepStatus({ status: 'done' }).every((s) => s.state === 'done')).toBe(true);
    expect(stepStatus({ status: 'idle' })[0].state).toBe('active');
    expect(stepStatus({ status: 'idle' })[1].state).toBe('pending');
  });
});

describe('deriveSteps', () => {
  it('yields the five backend workflow steps from the single source of truth', () => {
    const steps = deriveSteps({ status: 'running', step: 'compare' });
    expect(steps.map((s) => s.id)).toEqual(['load', 'search', 'extract', 'compare', 'report']);
  });

  it('marks the current running step active', () => {
    const steps = deriveSteps({ status: 'running', step: 'compare' });
    expect(steps.find((s) => s.id === 'compare')?.state).toBe('active');
  });
});
