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
});
