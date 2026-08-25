import { describe, it, expect } from 'vitest';
import { riskInfo, payloadSummary } from '../src/trust/types.js';

describe('riskInfo', () => {
  it('maps side-effect risks to labels and classes', () => {
    expect(riskInfo('high-risk')).toEqual({ level: 'high', label: '高风险', cls: 'risk-high' });
    expect(riskInfo('write')).toEqual({ level: 'mid', label: '中风险', cls: 'risk-mid' });
    expect(riskInfo('read')).toEqual({ level: 'low', label: '低风险', cls: 'risk-low' });
    expect(riskInfo('unknown').level).toBe('mid');
  });
});

describe('payloadSummary', () => {
  it('stringifies payloads and falls back for primitives', () => {
    expect(payloadSummary({ title: '报告' })).toContain('"title": "报告"');
    expect(payloadSummary('plain')).toBe('plain');
  });
});
