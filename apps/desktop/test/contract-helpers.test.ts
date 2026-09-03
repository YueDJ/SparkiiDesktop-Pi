import { inflateRawSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { parseRiskFindings, formatReport, stepStatus, parseClauseGroups, buildExportDocument, captureReportHtml, reportExportPath } from '../agents/contract-review/surface/contract.js';
import { documentFromHtml, bytesToBase64 } from '../agents/contract-review/surface/report-docx.js';
import { deriveSteps } from '../agents/contract-review/surface/manifest-steps.js';

function zipText(bytes: Uint8Array, name: string): string {
  const buf = Buffer.from(bytes);
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const file = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const start = i + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    if (file === name) {
      const raw = method === 0 ? data : inflateRawSync(data);
      return raw.toString('utf8');
    }
    i = start + compSize;
  }
  throw new Error(`zip entry not found: ${name}`);
}

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

  it('unwraps riskFindings from a JSON blob wrapped in prose', () => {
    const out = parseRiskFindings('thinking\n{"riskFindings":[{"id":"r1","title":"付款周期过长","level":"high"}]}\nmore');
    expect(out).toEqual([{ id: 'r1', title: '付款周期过长', level: 'high' }]);
  });

  it('unwraps the new contract_risk_review result shape', () => {
    const out = parseRiskFindings({
      riskFindings: [
        { id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' },
      ],
    });
    expect(out).toEqual([{ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' }]);
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

  it('extracts a JSON report wrapped in thinking prose', () => {
    const r = formatReport('I need to generate JSON.\n\n{"title":"合同审核报告","sections":[{"heading":"结论","body":"重点关注付款条款"}]}\n\n已生成。');
    expect(r).toEqual({ title: '合同审核报告', blocks: [{ heading: '结论', body: '重点关注付款条款' }] });
  });

  it('carries through a structured risk table', () => {
    const r = formatReport({ title: '报告', sections: [{ heading: '结论', body: '重点关注' }], riskTable: { totals: { high: 2 } } });
    expect(r?.title).toBe('报告');
    expect(r?.riskTable).toEqual({ totals: { high: 2 } });
  });
});

describe('documentFromHtml', () => {
  it('converts rendered html lists and tables into a ready docx', async () => {
    const buf = await documentFromHtml('合同审核报告', `
      <h4>结论</h4>
      <ul><li>约定逾期付款违约金</li><li>限定赔偿范围</li></ul>
      <table>
        <thead><tr><th>风险项</th><th>位置</th></tr></thead>
        <tbody><tr><td>付款周期过长</td><td>p12</td></tr></tbody>
      </table>
    `);
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    const xml = zipText(buf, 'word/document.xml');
    expect(xml).toContain('约定逾期付款违约金');
    expect(xml).toContain('<w:tbl');
    expect(xml).toContain('p12');
    expect(xml).toMatch(/<w:numPr>|<w:numId /);
    expect(bytesToBase64(buf).startsWith('UEs')).toBe(true);
  });

  it('lays out the contract-review preview instead of Word defaults', async () => {
    const buf = await documentFromHtml('合同审核报告', `
      <div class="contract-report">
        <div class="contract-report-mock-title">合同审核报告</div>
        <div class="contract-report-mock-meta">contract.pdf</div>
        <div class="contract-report-summary">
          <div class="contract-report-summary-item">
            <div class="num" style="color:rgb(185, 28, 28)">1</div>
            <div class="label">高风险</div>
          </div>
          <div class="contract-report-summary-item">
            <div class="num" style="color:rgb(194, 65, 12)">1</div>
            <div class="label">中风险</div>
          </div>
          <div class="contract-report-summary-item">
            <div class="num" style="color:rgb(21, 128, 61)">0</div>
            <div class="label">低风险</div>
          </div>
        </div>
        <div class="contract-report-section">
          <h4>结论</h4>
          <ul><li>约定逾期付款违约金</li></ul>
        </div>
        <div class="contract-report-section">
          <h4>高风险（1）</h4>
          <table class="contract-report-table">
            <thead><tr><th>风险项</th><th>位置</th><th>复核</th></tr></thead>
            <tbody>
              <tr>
                <td><div>付款周期过长</div><div class="contract-risk-meta">第7条 · 账期过长</div></td>
                <td>p12</td>
                <td>已确认</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `);
    const doc = zipText(buf, 'word/document.xml');
    const styles = zipText(buf, 'word/styles.xml');
    expect(styles).toContain('微软雅黑');
    expect(styles).toContain('ReportTitle');
    expect(doc).not.toContain('w:val="Title"');
    expect(doc.split('合同审核报告').length - 1).toBe(1);
    expect(doc).toContain('contract.pdf');
    expect(doc).not.toContain('deepseek');
    expect(doc).not.toContain('已合并');
    expect(doc).toContain('B91C1C');
    expect(doc).toContain('高风险');
    expect(doc).toContain('94A3B8');
    expect(doc).toContain('第7条 · 账期过长');
    expect(doc).toMatch(/<w:jc w:val="right"/);
    expect(doc).toMatch(/<w:bottom [^>]*w:color="EAF0F6"/);
    expect(doc).toMatch(/<w:pgMar /);
    expect(styles).toMatch(/ReportBody[\s\S]*w:line="360"/);
    expect(styles).not.toMatch(/w:line="444"/);
  });

  it('builds a ready document without Node Buffer, like the sandboxed renderer', async () => {
    const orig = globalThis.Buffer;
    // @ts-expect-error -- renderer has no Buffer
    delete globalThis.Buffer;
    try {
      const buf = await documentFromHtml('合同审核报告', '<ul><li>约定逾期付款违约金</li></ul>');
      expect(buf[0]).toBe(0x50);
      expect(bytesToBase64(buf).startsWith('UEs')).toBe(true);
    } finally {
      globalThis.Buffer = orig;
    }
  });
});

describe('captureReportHtml', () => {
  it('keeps lists and tables from the rendered preview', () => {
    document.body.innerHTML = `
      <div id="preview">
        <h4>结论</h4>
        <ul><li>约定逾期付款违约金</li></ul>
        <table><thead><tr><th>风险项</th></tr></thead></table>
      </div>`;
    const html = captureReportHtml(document.getElementById('preview')!);
    expect(html).toMatch(/<li[\s>]/);
    expect(html).toContain('约定逾期付款违约金');
    expect(html).toMatch(/<table[\s>]/);
  });
});

describe('reportExportPath', () => {
  it('writes into the workspace', () => {
    expect(reportExportPath('C:/ws/contract', '合同审核报告')).toMatch(/合同审核报告\.docx$/);
  });
});

describe('buildExportDocument', () => {
  it('groups findings into sections and writes into the workspace', () => {
    const doc = buildExportDocument({
      title: '合同审核报告',
      sections: [{ heading: '结论', body: '关注付款' }],
      findings: [
        { id: 'r1', title: '付款周期过长', level: 'high', clause: '第7条', position: 'p12' },
        { id: 'r2', title: '验收边界不清', level: 'mid', position: 'p20' },
      ],
      reviewed: { r1: 'confirmed' },
      workspacePath: 'C:/ws/contract',
    });
    expect(doc.title).toBe('合同审核报告');
    expect(doc.format).toBe('docx');
    expect(doc.path).toMatch(/合同审核报告\.docx$/);
    expect(doc.sections.find((s) => s.heading === '结论')).toEqual({ heading: '结论', body: '关注付款' });
    expect(doc.sections.find((s) => s.heading === '风险摘要')?.table).toEqual({
      headers: ['高风险', '中风险', '低风险'],
      rows: [['1', '1', '0']],
    });
    expect(doc.sections.find((s) => s.heading.startsWith('高风险'))?.table).toEqual({
      headers: ['风险项', '位置', '复核'],
      rows: [['付款周期过长\n第7条', 'p12', '已确认']],
    });
    expect(doc.sections.find((s) => s.heading.startsWith('中风险'))?.table?.rows[0]).toEqual(['验收边界不清', 'p20', '未处理']);
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
