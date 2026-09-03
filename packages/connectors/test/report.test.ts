import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildReportDocx, reportConnector } from '../src/report/index.js';

describe('report', () => {
  it('returns a valid zip/docx byte buffer', async () => {
    const buf = await buildReportDocx({ title: '风险报告', sections: [{ heading: '结论', body: '通过' }], format: 'docx' });
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
  it('write handler saves to the frozen path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'));
    const out = join(dir, 'out.docx');
    const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
    const r = await tool.handler({ title: 'x', sections: [{ heading: 'h', body: 'b' }], format: 'docx', path: out }, { profileId: 'p', sessionId: 's', actor: 'u', requestId: 'r' });
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
  it('writes a ready-made document without rebuilding it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'));
    const out = join(dir, 'ready.docx');
    const bytes = Buffer.from('PK ready-docx');
    const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
    const r = await tool.handler({
      title: 'x',
      format: 'docx',
      path: out,
      content: bytes.toString('base64'),
    }, { profileId: 'p', sessionId: 's', actor: 'u', requestId: 'r' });
    expect(r.ok).toBe(true);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(out)).toEqual(bytes);
  });

  it('does not accept html for conversion', () => {
    const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
    expect((tool.params as { properties?: Record<string, unknown> }).properties?.html).toBeUndefined();
  });

  it('renders optional section tables into the docx', async () => {
    const buf = await buildReportDocx({
      title: '合同审核报告',
      sections: [
        { heading: '结论', body: '关注付款' },
        { heading: '高风险（1）', table: { headers: ['风险项', '位置', '复核'], rows: [['付款周期过长', 'p12', '未处理']] } },
      ],
      format: 'docx',
    });
    const mammoth = await import('mammoth');
    const html = (await mammoth.convertToHtml({ buffer: buf })).value;
    expect(html).toContain('<table');
    expect(html).toContain('风险项');
    expect(html).toContain('p12');
    expect(html).toContain('关注付款');
  });

  it('does not require a path from the agent', () => {
    const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
    expect((tool.params as any).required).not.toContain('path');
    expect((tool.params as any).properties?.path).toBeUndefined();
  });
});
