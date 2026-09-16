import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

afterEach(cleanup);
import ProcurementSurface from '../agents/procurement-review/surface/index.js';
import { canStartFull, canStartThin } from '../agents/procurement-review/surface/pack.js';
import { analysisProgress } from '../agents/procurement-review/surface/progress.js';
import { documentFromHtml, reportHtml } from '../agents/procurement-review/surface/report-docx.js';
import { procurementSessionTitle } from '../agents/procurement-review/surface/title.js';

expect.extend({
  toBeDisabled(received: unknown) {
    const disabled = Boolean((received as { disabled?: boolean } | null)?.disabled);
    return {
      pass: disabled,
      message: () => `expected element ${disabled ? 'not ' : ''}to be disabled`,
    };
  },
});

const empty = { planReady: false, qtyReady: false, priceReady: false, timeReady: false, policyKb: 'default' as const };

describe('procurementSessionTitle', () => {
  it('prefers plan number, then file stem, then the agent name', () => {
    expect(procurementSessionTitle('CG20260914021', '9月需求计划.xlsx')).toBe('CG20260914021');
    expect(procurementSessionTitle(null, '9月需求计划.xlsx')).toBe('9月需求计划');
    expect(procurementSessionTitle(null, null)).toBe('财务采购审核');
  });
});

describe('pack gates', () => {
  it('allows thin when plan is ready; full when plan plus any fact dim', () => {
    expect(canStartThin(empty)).toBe(false);
    expect(canStartFull(empty)).toBe(false);
    expect(canStartThin({ ...empty, planReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true })).toBe(false);
    expect(canStartFull({ ...empty, planReady: true, qtyReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true, priceReady: true })).toBe(true);
  });

  it('disables start buttons without a plan and keeps pull disabled', () => {
    render(<ProcurementSurface
      sessionId={null} mode="live" title=""
      session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
      actions={{} as any}
      agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }}
    />);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完整性审核' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /从 OA 获取/ })).toBeDisabled();
  });
});

const evaluation = {
  lines: [{ id: 'M-煤', code: 'RM-001', name: '烟煤', qty: 2800, unit: '吨', unitPrice: 920, stockQty: 4200, usageQty: 2100, medianPrice: null, dealCount: 0, transitQty: null, transitRef: null, qtyOpen: true, priceOpen: false, timeOpen: false }],
  hits: [{ id: 'h1', rowId: 'M-煤', dim: 'qty', level: 'high', ruleId: 'qty.over-cover', metrics: { coverMonths: 10 }, cite: { label: '覆盖>4个月', refs: [] } }],
  closed: { qty: false, price: true, time: true, compliance: false },
  conflicts: [],
};
const findingsJson = {
  findings: [
    { id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'high', title: '烟煤可覆盖约 10 个月', reason: '超过 4 个月', advice: '核减', cite: { label: '覆盖>4个月' }, hitId: 'h1' },
    { id: 'c1', rowId: 'M-煤', dim: 'compliance', level: 'mid', title: '烟煤单行金额超集采线', reason: '超 200 万', advice: '补说明', cite: { label: '《采购管理办法》第12条' }, hitId: '' },
  ],
};
const session = {
  entries: [
    { id: 'e0', kind: 'custom', customType: 'workflow_state', data: { action: 'evaluation', payload: evaluation } },
    { id: 'e1', kind: 'custom', customType: 'workflow_step_end', data: { stepId: 'review', status: 'ok', output: findingsJson } },
  ],
  streaming: false,
  status: 'done',
  meta: { currentStep: 'report' },
};

describe('analyze and review workbench', () => {
  it('hides adopt on analyze and blocks export while high risk is open', async () => {
    const review = vi.fn();
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{ review } as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    expect(screen.getByRole('button', { name: '导出' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: '采纳' })[0]);
    expect(review).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'r1' } });
  });

  it('renders compliance as a sibling column not a full-width strip', () => {
    const { container } = render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
    const conds = container.querySelector('.conds');
    const rule = container.querySelector('.rule-bar');
    expect(rule && conds?.contains(rule) && rule.parentElement === conds).toBe(true);
  });

  const agent = { id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' as const };
  const emptySession = { entries: [], streaming: false, status: 'idle' as const, meta: { currentStep: null } };

  it('resets to analyze when sessionId changes to another session with review output', () => {
    const { rerender } = render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy();
    rerender(<ProcurementSurface sessionId="s2" mode="live" title="" session={session as any} actions={{} as any} agent={agent} />);
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull();
    expect(screen.getByRole('button', { name: '进入复核' })).toBeTruthy();
  });

  it('resets to pack when sessionId changes to a session without review output', () => {
    const { rerender } = render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    rerender(<ProcurementSurface sessionId="s2" mode="live" title="" session={emptySession} actions={{} as any} agent={agent} />);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出' })).toBeNull();
  });

  it('returns to analyze from pack after 返回准备 when findings exist', () => {
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
    expect(screen.getByRole('button', { name: '开始分析' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
    expect(screen.queryByRole('button', { name: '采纳' })).toBeNull();
    expect(screen.getByRole('button', { name: '进入复核' })).toBeTruthy();
  });

  it('exports a docx when review is open and high risk is cleared', async () => {
    const requestExport = vi.fn();
    const reviewed = {
      ...session,
      entries: [
        ...session.entries,
        { id: 'e2', kind: 'custom', customType: 'workflow_state', data: { action: 'risk_confirmed', payload: { riskId: 'r1' } } },
      ],
      meta: { currentStep: 'report', workspacePath: 'C:/ws/procurement' },
    };
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={reviewed as any} actions={{ review: vi.fn(), requestExport } as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    expect(screen.getByRole('button', { name: '导出' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(requestExport).toHaveBeenCalledWith(expect.objectContaining({
      title: '财务采购审核',
      format: 'docx',
      content: expect.stringMatching(/^UEs/),
      path: expect.stringMatching(/财务采购审核\.docx$/),
    })));
  });

  it('writes opinion via report_merged when high risk is cleared', () => {
    const review = vi.fn();
    const reviewed = {
      ...session,
      entries: [
        ...session.entries,
        { id: 'e2', kind: 'custom', customType: 'workflow_state', data: { action: 'risk_confirmed', payload: { riskId: 'r1' } } },
      ],
    };
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={reviewed as any} actions={{ review } as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '进入复核' }));
    fireEvent.click(screen.getByRole('button', { name: '写入意见' }));
    expect(review).toHaveBeenCalledWith('report_merged', { stepId: 'report' });
  });
});

describe('pack startWorkflow', () => {
  const agent = { id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' as const };
  const idleSession = { entries: [], streaming: false, status: 'idle' as const, meta: { currentStep: null } };

  function csvFile(name: string, text: string, path?: string) {
    const file = new File([text], name, { type: 'text/csv' });
    if (path) Object.defineProperty(file, 'path', { value: path });
    return file;
  }

  function upload(label: string, file: File) {
    fireEvent.change(document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement, {
      target: { files: [file] },
    });
  }

  it('starts workflow with evaluation and persists the snapshot', async () => {
    const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-1' });
    const review = vi.fn();
    const plan = csvFile(
      'plan.csv',
      '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      'C:/tmp/plan.csv',
    );
    render(<ProcurementSurface
      sessionId={null} mode="live" title=""
      session={idleSession}
      actions={{ startWorkflow, review } as any}
      agent={agent}
    />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    const payload = startWorkflow.mock.calls[0][0];
    expect(typeof payload.documents[0]).toBe('string');
    expect(payload.documents[0]).toBe('C:/tmp/plan.csv');
    expect(payload.evaluation.closed).toMatchObject({ qty: true, price: true, time: true });
    expect(payload.query).toMatch(/烟煤/);
    expect(payload.evaluation.hits.some((h: { ruleId: string }) => h.ruleId === 'completeness.dims-closed')).toBe(true);
    await waitFor(() => expect(review).toHaveBeenCalledWith('evaluation', expect.objectContaining({
      stepId: 'review',
      payload: expect.objectContaining({ hits: expect.any(Array) }),
    })));
  });

  it('starts 开始分析 with open qty after stock and usage files', async () => {
    const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-2' });
    const plan = csvFile(
      'plan.csv',
      '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      'C:/tmp/plan.csv',
    );
    const stock = csvFile('stock.csv', '物资编码,库存数量,快照日期\nRM-001,4200,2026-09-13\n');
    const usage = csvFile('usage.csv', '物资编码,领用数量,天数\nRM-001,2100,90\n');
    render(<ProcurementSurface
      sessionId={null} mode="live" title=""
      session={idleSession}
      actions={{ startWorkflow, review: vi.fn() } as any}
      agent={agent}
    />);
    upload('上传计划', plan);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    upload('上传库存', stock);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    upload('上传领用', usage);
    expect(screen.getByRole('button', { name: '开始分析' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    const payload = startWorkflow.mock.calls[0][0];
    expect(typeof payload.documents[0]).toBe('string');
    expect(payload.evaluation.closed.qty).toBe(false);
    expect(payload.evaluation.lines[0].stockQty).toBe(4200);
  });

  it('does not persist evaluation when startWorkflow returns no sessionId', async () => {
    const startWorkflow = vi.fn().mockResolvedValue({});
    const review = vi.fn();
    const plan = csvFile(
      'plan.csv',
      '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      'C:/tmp/plan.csv',
    );
    render(<ProcurementSurface
      sessionId="prev" mode="live" title=""
      session={idleSession}
      actions={{ startWorkflow, review } as any}
      agent={agent}
    />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    expect(review).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/未能开始/));
  });

  it('does not persist evaluation when startWorkflow fails', async () => {
    const startWorkflow = vi.fn().mockRejectedValue(new Error('start failed'));
    const review = vi.fn();
    const plan = csvFile(
      'plan.csv',
      '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      'C:/tmp/plan.csv',
    );
    render(<ProcurementSurface
      sessionId="prev" mode="live" title=""
      session={idleSession}
      actions={{ startWorkflow, review } as any}
      agent={agent}
    />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    expect(review).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/未能开始|start failed/));
  });

  it('resolves upload paths via window.sparkii.getPathForFile when File.path is missing', async () => {
    (window as any).sparkii = {
      getPathForFile: vi.fn((file: File) => `C:/downloads/${file.name}`),
    };
    try {
      const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-path' });
      const plan = csvFile(
        'plan.csv',
        '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      );
      render(<ProcurementSurface
        sessionId={null} mode="live" title=""
        session={idleSession}
        actions={{ startWorkflow, review: vi.fn() } as any}
        agent={agent}
      />);
      upload('上传计划', plan);
      fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
      await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
      expect(startWorkflow.mock.calls[0][0].documents[0]).toBe('C:/downloads/plan.csv');
    } finally {
      delete (window as any).sparkii;
    }
  });

  it('clears pack uploads when sessionId changes', () => {
    const plan = csvFile(
      'plan.csv',
      '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n',
      'C:/tmp/plan.csv',
    );
    const { rerender } = render(<ProcurementSurface
      sessionId="s1" mode="live" title=""
      session={idleSession}
      actions={{} as any}
      agent={agent}
    />);
    upload('上传计划', plan);
    expect(screen.getByRole('button', { name: '完整性审核' })).not.toBeDisabled();
    rerender(<ProcurementSurface
      sessionId="s2" mode="live" title=""
      session={idleSession}
      actions={{} as any}
      agent={agent}
    />);
    expect(screen.getByRole('button', { name: '完整性审核' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
  });

  it('passes only the plan path as documents even when facts are uploaded', async () => {
    const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-docs' });
    const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n', 'C:/tmp/plan.csv');
    const stock = csvFile('stock.csv', '物资编码,库存数量,快照日期\nRM-001,4200,2026-09-13\n', 'C:/tmp/stock.csv');
    const usage = csvFile('usage.csv', '物资编码,领用数量,天数\nRM-001,2100,90\n', 'C:/tmp/usage.csv');
    render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
    upload('上传计划', plan);
    upload('上传库存', stock);
    upload('上传领用', usage);
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    expect(startWorkflow.mock.calls[0][0].documents).toEqual(['C:/tmp/plan.csv']);
  });

  it('shows an alert when startWorkflow fails', async () => {
    const startWorkflow = vi.fn().mockRejectedValue(new Error('start failed'));
    const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n', 'C:/tmp/plan.csv');
    render(<ProcurementSurface sessionId="prev" mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/未能开始|start failed/));
  });

  it('shows an alert when the plan path cannot be resolved', async () => {
    const startWorkflow = vi.fn();
    const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n');
    render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/路径/));
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('publishes the session title via window.sparkii.setChatTitle after start', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = { getPathForFile: (file: File) => `C:/tmp/${file.name}`, setChatTitle };
    try {
      const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-title' });
      const plan = csvFile('plan.csv', '计划单号,物资编码,物资名称,申请数量,单位,预估单价\nPR-202609-01,RM-001,烟煤,2800,吨,920\n');
      render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
      upload('上传计划', plan);
      fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
      await waitFor(() => expect(setChatTitle).toHaveBeenCalledWith('wf-title', 'PR-202609-01', 'agent'));
    } finally {
      delete (window as any).sparkii;
    }
  });

  it('keeps pack window prefs after returning to 准备', () => {
    render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{ review: vi.fn() } as any} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
    fireEvent.click(screen.getByLabelText('领用范围'));
    fireEvent.click(screen.getByRole('menuitem', { name: '领用 30 天' }));
    fireEvent.click(screen.getByLabelText('本次用哪套制度'));
    fireEvent.click(screen.getByRole('menuitem', { name: '不使用' }));
    fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
    fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
    expect((screen.getByLabelText('领用范围') as HTMLButtonElement).value).toBe('30');
    expect((screen.getByLabelText('本次用哪套制度') as HTMLButtonElement).value).toBe('');
  });
});

describe('analysis progress and export title', () => {
  const agent = { id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' as const };

  it('marks 制度 on and 撰写发现 waiting while search is streaming', () => {
    const steps = analysisProgress({
      streaming: true, status: 'running', currentStep: 'search',
      thin: false, policyClosed: false, reviewReady: false,
    });
    expect(steps.find((s) => s.id === 'policy')).toMatchObject({ state: 'on' });
    expect(steps.find((s) => s.id === 'write')).toMatchObject({ state: 'wait' });
    expect(steps.find((s) => s.id === 'rules')).toMatchObject({ state: 'done' });
  });

  it('skips 套规则 on a thin pack and skips 制度 when policy is closed', () => {
    const steps = analysisProgress({
      streaming: false, status: 'done', currentStep: 'report',
      thin: true, policyClosed: true, reviewReady: true,
    });
    expect(steps.find((s) => s.id === 'rules')).toMatchObject({ state: 'skip' });
    expect(steps.find((s) => s.id === 'policy')).toMatchObject({ state: 'skip' });
  });

  it('shows live analysis progress on ProcurementSurface while search is streaming', () => {
    const liveSession = {
      entries: [
        { kind: 'custom', id: 'e1', customType: 'workflow_state', data: { action: 'evaluation', payload: {
          lines: [], hits: [], closed: { qty: false, price: false, time: false, compliance: false }, conflicts: [],
        } } },
        { kind: 'custom', id: 'e2', customType: 'workflow_step_start', data: { stepId: 'search' } },
      ],
      streaming: true,
      status: 'running' as const,
      meta: { currentStep: 'search' },
    };
    render(<ProcurementSurface sessionId="s-live" mode="live" title="" session={liveSession as any} actions={{ review: vi.fn() } as any} agent={agent} />);
    const bar = screen.getByLabelText('分析进度');
    const policy = Array.from(bar.querySelectorAll('.prog')).find((n) => (n.textContent ?? '').includes('制度'));
    const write = Array.from(bar.querySelectorAll('.prog')).find((n) => (n.textContent ?? '').includes('撰写发现'));
    expect(policy?.className).toMatch(/\bon\b/);
    expect(write?.className).not.toMatch(/\bdone\b/);
    expect((screen.getByRole('button', { name: '进入复核' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('分析进行中')).toBeTruthy();
  });

  it('does not write the title twice into the docx', async () => {
    const html = reportHtml([], {});
    expect(html.includes('<h1>')).toBe(false);
    const xml = new TextDecoder().decode(await documentFromHtml('财务采购审核', html));
    expect(xml.split('财务采购审核').length - 1).toBe(1);
  });

  it('falls back to 财务采购审核, not 合同审核报告, when the title is empty', async () => {
    const xml = new TextDecoder().decode(await documentFromHtml('', reportHtml([], {})));
    expect(xml).not.toContain('合同审核报告');
    expect(xml).toContain('财务采购审核');
  });
});

