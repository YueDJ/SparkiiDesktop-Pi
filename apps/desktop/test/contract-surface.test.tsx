import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ContractSurface, ContractAgentSurface } from '../agents/contract-review/surface/index.js';
import { extractWorkflowResult, normalizeSessionEntries } from '../src/surface/normalize.js';

afterEach(cleanup);

function makeState(over: Record<string, unknown> = {}) {
  return {
    documents: ['C:/tmp/contract.pdf'],
    workflow: {
      result: {
        compare: [
          { 条款: '第7条 付款条件', 风险: '高风险', 建议: '约定逾期付款违约金上限' },
          { 条款: '第12条 违约责任', 风险: '中', 建议: '限定赔偿范围' },
        ],
        report: { title: '合同审核报告', sections: [{ heading: '结论', body: '重点关注付款条款' }] },
      },
    },
    ...over,
  };
}

function renderSurface(workflow: { status: string; step?: string }, state: Record<string, unknown> = makeState()) {
  return render(<ContractSurface state={state} workflow={workflow as any} onAction={vi.fn()} onRequestExport={vi.fn()} />);
}

describe('ContractSurface', () => {
  it('shows upload and start controls when idle', () => {
    renderSurface({ status: 'idle' }, { documents: [] });
    expect(screen.getByTestId('upload').textContent).toBe('选择合同文件');
    expect(screen.queryByText('更换文件')).toBeNull();
    expect(screen.getByTestId('review')).toBeTruthy();
  });

  it('collapses the upload card into a compact file chip after choosing a file', async () => {
    const onAction = vi.fn();
    const chooseDocument = vi.fn().mockResolvedValue({ path: 'C:/tmp/chosen.txt' });
    const readDocumentBytes = vi.fn().mockResolvedValue({
      kind: 'txt',
      fileName: 'chosen.txt',
      fileSize: 12,
      bytes: new TextEncoder().encode('合同正文').buffer,
    });
    render(
      <ContractAgentSurface
        agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={{
          newSession: vi.fn(),
          openSession: vi.fn(),
          startWorkflow: onAction,
          review: vi.fn(),
          requestExport: vi.fn(),
          chooseDocument,
          readDocumentBytes,
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('upload'));
    expect(chooseDocument).toHaveBeenCalledWith({ extensions: ['pdf', 'docx', 'txt'] });
    expect(await screen.findByTestId('remove-document')).toBeTruthy();
    expect(screen.queryByTestId('upload')).toBeNull();
    expect(screen.queryByText('更换文件')).toBeNull();
    expect((await screen.findAllByText('chosen.txt')).length).toBeGreaterThan(0);
    expect(screen.queryByText('尚未选择合同文件')).toBeNull();
    await waitFor(() => expect(readDocumentBytes).toHaveBeenCalledWith('C:/tmp/chosen.txt'));
  });

  it('renders risk findings with levels and advice from workflow result', () => {
    renderSurface({ status: 'done' });
    expect(screen.getAllByText('第7条 付款条件').length).toBeGreaterThan(0);
    expect(screen.getAllByText('高风险').length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, el) => el?.textContent?.includes('约定逾期付款违约金上限') ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText('第12条 违约责任').length).toBeGreaterThan(0);
  });

  it('shows the original document panel alongside the risk panel', () => {
    renderSurface({ status: 'done' });
    expect(screen.getAllByText('合同原文').length).toBeGreaterThan(0);
    expect(screen.getAllByText('contract.pdf').length).toBeGreaterThan(0);
    expect(screen.getAllByText('合同审核报告').length).toBeGreaterThan(0);
  });

  it('uses the source filename as the report subtitle, not the model name', () => {
    renderSurface({ status: 'done' });
    const preview = screen.getByTestId('report-preview');
    expect(preview.textContent).toContain('contract.pdf');
    expect(preview.textContent).not.toMatch(/deepseek/i);
    expect(preview.querySelector('.contract-report-status')).toBeNull();
  });

  it('requests export via the approval path after merging', async () => {
    const onRequestExport = vi.fn();
    const agent = { id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' as const };
    const first = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] } } },
    ]);
    const { rerender } = render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: first, streaming: false, result: extractWorkflowResult(first), meta: { currentStep: 'report' } }}
        actions={{
          newSession: vi.fn(),
          openSession: vi.fn(),
          startWorkflow: vi.fn(),
          review: vi.fn(),
          requestExport: onRequestExport,
          chooseDocument: vi.fn().mockResolvedValue({}),
          readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
        }}
      />,
    );
    fireEvent.click(screen.getByText('合并到报告'));
    const second = [...first, { kind: 'custom' as const, id: 'w1', customType: 'workflow_state', data: { stepId: 'report', action: 'report_merged' } }];
    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: second, streaming: false, result: extractWorkflowResult(second), meta: { currentStep: 'report' } }}
        actions={{
          newSession: vi.fn(),
          openSession: vi.fn(),
          startWorkflow: vi.fn(),
          review: vi.fn(),
          requestExport: onRequestExport,
          chooseDocument: vi.fn().mockResolvedValue({}),
          readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
        }}
      />,
    );
    fireEvent.click(screen.getByText('导出报告'));
    await waitFor(() => expect(onRequestExport).toHaveBeenCalled());
  });

  it('exports a ready document built from the preview, not html', async () => {
    const onRequestExport = vi.fn();
    const agent = { id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' as const };
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [
        { id: 'r1', title: '付款周期过长', level: 'high', clause: '第7条', position: 'p12' },
      ] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '- 约定逾期付款违约金\n- 限定赔偿范围' }] } } },
      { type: 'custom', id: 'c3', customType: 'workflow_state', data: { stepId: 'report', action: 'report_merged' } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries, streaming: false, status: 'done', result: extractWorkflowResult(entries), meta: { currentStep: 'report' } }}
        actions={{
          newSession: vi.fn(),
          openSession: vi.fn(),
          startWorkflow: vi.fn(),
          review: vi.fn(),
          requestExport: onRequestExport,
          chooseDocument: vi.fn().mockResolvedValue({}),
          readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
        }}
      />,
    );
    fireEvent.click(screen.getByText('导出报告'));
    await waitFor(() => {
      expect(onRequestExport).toHaveBeenCalledWith(expect.objectContaining({
        format: 'docx',
        content: expect.stringMatching(/^UEs/),
      }));
    });
    expect(onRequestExport.mock.calls[0][0].html).toBeUndefined();
  });

  it('renders the review stage in the single-page stage rail', () => {
    renderSurface({ status: 'done' });
    expect(screen.getByText('审核')).toBeTruthy();
    expect(screen.getByText('报告')).toBeTruthy();
    expect(screen.getAllByText('复核').length).toBeGreaterThan(0);
  });

  it('renders a structured risk view without raw JSON', () => {
    const { container } = renderSurface({ status: 'done' });
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getAllByText('第7条 付款条件').length).toBeGreaterThan(0);
  });

  it('records risk confirmation when a workflow session is active', () => {
    const onWorkflowState = vi.fn();
    render(
      <ContractSurface
        state={makeState()}
        workflow={{ status: 'done' } as any}
        sessionId="s1"
        onAction={vi.fn()}
        onWorkflowState={onWorkflowState}
        onRequestExport={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByText('确认')[0]);
    expect(onWorkflowState).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'f0' } });
  });

  it('filters risk cards and applies a batch confirmation', () => {
    const onWorkflowState = vi.fn();
    render(
      <ContractSurface
        state={makeState()}
        workflow={{ status: 'done' } as any}
        sessionId="s1"
        onAction={vi.fn()}
        onWorkflowState={onWorkflowState}
        onRequestExport={vi.fn()}
      />,
    );
    expect(screen.getByText('全部')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '高风险' })[0]);
    expect(screen.getAllByText('第7条 付款条件').length).toBeGreaterThan(0);
    expect(screen.getAllByText('第12条 违约责任').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '选择 第7条 付款条件' }));
    fireEvent.click(screen.getByText('批量确认'));
    expect(onWorkflowState).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'f0' } });
  });
});

describe('ContractAgentSurface', () => {
  const agent = { id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' as const };
  const makeActions = () => ({
    newSession: vi.fn(),
    openSession: vi.fn(),
    startWorkflow: vi.fn(),
    review: vi.fn(),
    requestExport: vi.fn(),
    chooseDocument: vi.fn().mockResolvedValue({}),
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
  });

  it('renders the single-page cockpit with review and report panels', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' }] } } },
      { type: 'custom', id: 'c3', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] } } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries, streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    expect(screen.getAllByText('a.pdf').length).toBeGreaterThan(0);
    expect(screen.getAllByText('风险发现').length).toBeGreaterThan(0);
    expect(screen.getAllByText('付款周期过长').length).toBeGreaterThan(0);
  });

  it('renders the report from the session stream without workflow/state props', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'f0', title: '第1条', level: 'high' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_start', data: { stepId: 'report' } },
      { type: 'custom', id: 'c3', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '会话报告', sections: [{ heading: '结论', body: '关注' }] } } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries, streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/a.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    expect(screen.getAllByText('会话报告').length).toBeGreaterThan(0);
  });

  it('starts workflow with input documents', () => {
    const actions = makeActions();
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [{ path: 'C:/tmp/a.pdf' }] } }}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByTestId('review'));
    expect(actions.startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ documents: ['C:/tmp/a.pdf'] }));
  });

  it('offers a new session action instead of reusing the active review', () => {
    const actions = makeActions();
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: [], streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] } }}
        actions={actions}
      />,
    );
    expect(screen.getByTestId('new-review')).toBeTruthy();
    expect(screen.queryByTestId('upload')).toBeNull();
    fireEvent.click(screen.getByTestId('new-review'));
    expect(actions.newSession).toHaveBeenCalled();
  });

  it('clears the previous file when starting a new session even if session props are stale', () => {
    const actions = makeActions();
    const stale = {
      entries: [],
      streaming: false,
      status: 'done' as const,
      meta: { currentStep: 'report' as const, inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] },
    };
    const { rerender } = render(
      <ContractAgentSurface agent={agent} sessionId="s1" mode="history" session={stale} actions={actions} />,
    );
    expect(screen.getAllByText('a.pdf').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('new-review'));
    expect(actions.newSession).toHaveBeenCalled();
    rerender(
      <ContractAgentSurface agent={agent} sessionId={null} mode="live" session={stale} actions={actions} />,
    );
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByText('尚未选择合同文件')).toBeTruthy();
    expect((screen.getByTestId('review') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('合并到报告') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the session after the stripped contract filename', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState: async () => ({}),
      getChatSession: async () => ({}),
      setChatTitle,
      on: () => () => {},
    };
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-title"
        mode="live"
        session={{ entries: [], streaming: false, status: 'running', meta: { currentStep: 'review', inputs: [{ path: 'C:/tmp/采购合同.pdf', name: '采购合同.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    await waitFor(() => expect(setChatTitle).toHaveBeenCalledWith('s-title', '采购合同', 'agent'));
    delete (window as any).sparkii;
  });

  it('does not overwrite an existing session title', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState: async () => ({}),
      getChatSession: async () => ({}),
      setChatTitle,
      on: () => () => {},
    };
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-title"
        mode="live"
        title="用户改的"
        session={{ entries: [], streaming: false, status: 'running', meta: { currentStep: 'review', inputs: [{ path: 'C:/tmp/采购合同.pdf', name: '采购合同.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(setChatTitle).not.toHaveBeenCalled();
    delete (window as any).sparkii;
  });

  it('does not backfill a title when opening history', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState: async () => ({}),
      getChatSession: async () => ({}),
      setChatTitle,
      on: () => () => {},
    };
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-hist"
        mode="history"
        session={{ entries: [], streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/采购合同.pdf', name: '采购合同.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(setChatTitle).not.toHaveBeenCalled();
    delete (window as any).sparkii;
  });

  it('does not publish a title before the session exists', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState: async () => ({}),
      getChatSession: async () => ({}),
      setChatTitle,
      on: () => () => {},
    };
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [{ path: 'C:/tmp/采购合同.pdf', name: '采购合同.pdf' }] } }}
        actions={makeActions()}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(setChatTitle).not.toHaveBeenCalled();
    delete (window as any).sparkii;
  });

  it('keeps merge enabled in history when a report exists', () => {
    const actions = makeActions();
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] } } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-hist"
        mode="history"
        session={{ entries, streaming: false, status: 'done', result: extractWorkflowResult(entries), meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] } }}
        actions={actions}
      />,
    );
    const merge = screen.getByText('合并到报告') as HTMLButtonElement;
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(actions.review).toHaveBeenCalledWith('report_merged', { stepId: 'report' });
  });

  it('keeps merge enabled in history after the session was already merged', () => {
    const actions = makeActions();
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] } } },
      { type: 'custom', id: 'c3', customType: 'workflow_state', data: { stepId: 'report', action: 'report_merged' } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-hist-merged"
        mode="history"
        session={{ entries, streaming: false, status: 'done', result: extractWorkflowResult(entries), meta: { currentStep: 'report' } }}
        actions={actions}
      />,
    );
    const merge = screen.getByText('合并到报告') as HTMLButtonElement;
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(actions.review).toHaveBeenCalledWith('report_merged', { stepId: 'report' });
  });

  it('recovers findings from history assistant messages when step output is missing', () => {
    const actions = makeActions();
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-hist-msg"
        mode="history"
        session={{
          entries: [{
            kind: 'message',
            id: 'm1',
            role: 'assistant',
            text: '{"riskFindings":[{"id":"r1","title":"付款周期过长","level":"high"}],"title":"合同审核报告","sections":[{"heading":"结论","body":"关注"}]}',
            streaming: false,
          }],
          streaming: false,
          status: 'done',
          result: {},
          meta: { currentStep: 'report' },
        }}
        actions={actions}
      />,
    );
    expect(screen.getAllByText('付款周期过长').length).toBeGreaterThan(0);
    const merge = screen.getByText('合并到报告') as HTMLButtonElement;
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    expect(actions.review).toHaveBeenCalledWith('report_merged', { stepId: 'report' });
  });

  it('still locks merge after a live merge', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_state', data: { stepId: 'report', action: 'report_merged' } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-live"
        mode="live"
        session={{ entries, streaming: false, status: 'done', result: extractWorkflowResult(entries), meta: { currentStep: 'review' } }}
        actions={makeActions()}
      />,
    );
    expect((screen.getByText('合并到报告') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows risk cards after a review step_end output without session.result', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
    ]);
    render(<ContractAgentSurface agent={agent} sessionId="s1" mode="history"
      session={{ entries, streaming: false, result: extractWorkflowResult(entries), meta: { currentStep: 'review' } }}
      actions={makeActions()} />);
    expect(screen.getAllByText('付款周期过长').length).toBeGreaterThan(0);
  });

  it('keeps confirmation after a later custom row arrives', () => {
    const actions = makeActions();
    const first = normalizeSessionEntries([
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
    ]);
    const { rerender } = render(<ContractAgentSurface
      agent={agent}
      sessionId="s1"
      mode="history"
      session={{ entries: first, streaming: false, result: extractWorkflowResult(first), meta: { currentStep: 'review' } }}
      actions={actions}
    />);
    fireEvent.click(screen.getAllByText('确认')[0]);
    expect(actions.review).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'r1' } });
    const second = [...first, { kind: 'custom' as const, id: 'w1', customType: 'workflow_state', data: { stepId: 'review', action: 'risk_confirmed', payload: { riskId: 'r1' } } }];
    rerender(<ContractAgentSurface
      agent={agent}
      sessionId="s1"
      mode="history"
      session={{ entries: second, streaming: false, result: extractWorkflowResult(second), meta: { currentStep: 'review' } }}
      actions={actions}
    />);
    expect(screen.getAllByText('已确认').length).toBeGreaterThan(0);
  });

  it('shows a risk skeleton after review start before step output', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'review' } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="live"
        session={{ entries, streaming: true, status: 'running', meta: { currentStep: 'review' } }}
        actions={makeActions()}
      />,
    );
    expect(screen.getByText('审核中…')).toBeTruthy();
  });

  it('shows a report skeleton after report start before step output', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_start', data: { stepId: 'report' } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="live"
        session={{ entries, streaming: true, status: 'running', result: extractWorkflowResult(entries), meta: { currentStep: 'report' } }}
        actions={makeActions()}
      />,
    );
    expect(screen.getByText('报告生成中…')).toBeTruthy();
  });

  it('resets filter, selection, and documents when sessionId changes', () => {
    const actions = makeActions();
    const entriesA = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [
        { id: 'r1', title: '付款周期过长', level: 'high' },
        { id: 'r2', title: '违约范围过宽', level: 'mid' },
      ] } } },
    ]);
    const { rerender } = render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-a"
        mode="history"
        session={{ entries: entriesA, streaming: false, status: 'done', result: extractWorkflowResult(entriesA), meta: { currentStep: 'review', inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] } }}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '高风险' })[0]);
    expect(screen.queryByText('违约范围过宽')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择 付款周期过长' }));
    expect(screen.getByRole('button', { name: '选择 付款周期过长' }).className).toMatch(/checked/);

    const entriesB = normalizeSessionEntries([
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [
        { id: 'r1', title: '付款周期过长', level: 'high' },
        { id: 'r2', title: '违约范围过宽', level: 'mid' },
      ] } } },
    ]);
    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-b"
        mode="history"
        session={{ entries: entriesB, streaming: false, status: 'done', result: extractWorkflowResult(entriesB), meta: { currentStep: 'review', inputs: [{ path: 'C:/tmp/b.pdf', name: 'b.pdf' }] } }}
        actions={actions}
      />,
    );
    expect(screen.getByRole('button', { name: '全部' }).className).toMatch(/active/);
    expect(screen.getAllByText('违约范围过宽').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '选择 付款周期过长' }).className).not.toMatch(/checked/);
    expect(screen.queryByText('a.pdf')).toBeNull();

    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [] } }}
        actions={actions}
      />,
    );
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.queryByText('b.pdf')).toBeNull();
    expect((screen.getByTestId('review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the local draft file when a live session id is bound', async () => {
    const chooseDocument = vi.fn().mockResolvedValue({ path: 'C:/tmp/采购合同.pdf' });
    const { rerender } = render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={{ ...makeActions(), chooseDocument }}
      />,
    );
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    expect(screen.getAllByText('采购合同.pdf').length).toBeGreaterThan(0);
    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-new"
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [] } }}
        actions={{ ...makeActions(), chooseDocument }}
      />,
    );
    expect(screen.getAllByText('采购合同.pdf').length).toBeGreaterThan(0);
    expect((screen.getByTestId('review') as HTMLButtonElement).disabled).toBe(false);
  });

  it('resets a local draft when opening history from a new session', async () => {
    const chooseDocument = vi.fn().mockResolvedValue({ path: 'C:/tmp/采购合同.pdf' });
    const { rerender } = render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={{ ...makeActions(), chooseDocument }}
      />,
    );
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-hist"
        mode="history"
        session={{ entries: [], streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/b.pdf', name: 'b.pdf' }] } }}
        actions={{ ...makeActions(), chooseDocument }}
      />,
    );
    expect(screen.queryByText('采购合同.pdf')).toBeNull();
    expect(screen.getAllByText('b.pdf').length).toBeGreaterThan(0);
  });

  it('publishes a title from the startWorkflow result without a viewport session id', async () => {
    const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState: async () => ({}),
      getChatSession: async () => ({}),
      setChatTitle,
      on: () => () => {},
    };
    const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'ws-left' });
    const chooseDocument = vi.fn().mockResolvedValue({ path: 'C:/tmp/采购合同.pdf' });
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={{ ...makeActions(), startWorkflow, chooseDocument }}
      />,
    );
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    fireEvent.click(screen.getByTestId('review'));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
    await waitFor(() => expect(setChatTitle).toHaveBeenCalledWith('ws-left', '采购合同', 'agent'));
    delete (window as any).sparkii;
  });

  it('loads context usage after a session id appears', async () => {
    const getChatState = vi.fn().mockResolvedValue({
      contextUsage: { tokens: 12800, contextWindow: 200000, percent: 6 },
    });
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
      getChatState,
      getChatSession: async () => ({}),
      on: () => () => {},
    };
    const actions = makeActions();
    const { rerender } = render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={actions}
      />,
    );
    expect(screen.getByTestId('context-bar').textContent).toMatch(/—/);
    rerender(
      <ContractAgentSurface
        agent={agent}
        sessionId="s-live"
        mode="live"
        session={{ entries: [], streaming: false, status: 'running', meta: { currentStep: 'review' } }}
        actions={actions}
      />,
    );
    await waitFor(() => expect(getChatState).toHaveBeenCalledWith('s-live'));
    await waitFor(() => {
      const bar = screen.getByTestId('context-bar');
      expect(bar.textContent).toMatch(/12,800/);
      expect(bar.textContent).toMatch(/200,000/);
      expect(bar.textContent).toMatch(/6%/);
    });
    delete (window as any).sparkii;
  });

  it('passes workspace and model into startWorkflow', async () => {
    (window as any).sparkii = {
      getModelOptions: async () => ({ models: ['deepseek-v4-pro'], defaultModel: 'deepseek-v4-pro', provider: 'deepseek' }),
      chooseWorkspace: async () => ({ path: 'C:/ws/contract' }),
      on: () => () => {},
    };
    const startWorkflow = vi.fn();
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId={null}
        mode="live"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
        actions={{ ...makeActions(), startWorkflow, chooseDocument: vi.fn().mockResolvedValue({ path: 'C:/tmp/a.pdf' }) }}
      />,
    );
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    expect(screen.queryByText('更换文件')).toBeNull();
    expect(screen.queryByTestId('upload')).toBeNull();
    fireEvent.click(screen.getByTestId('workspace'));
    await waitFor(() => expect(screen.getByTestId('workspace').textContent).toContain('contract'));
    fireEvent.click(screen.getByTestId('review'));
    await waitFor(() => expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      documents: ['C:/tmp/a.pdf'],
      workspacePath: 'C:/ws/contract',
    })));
    delete (window as any).sparkii;
  });

  it('lists report risks by level with clause and position', () => {
    const entries = normalizeSessionEntries([
      { type: 'custom', id: 'c1', customType: 'workflow_step_end', data: { stepId: 'review', status: 'completed', output: { riskFindings: [
        { id: 'r1', title: '付款周期过长', level: 'high', clause: '第7条 付款条件', position: 'p12' },
        { id: 'r2', title: '验收边界不清', level: 'mid', clause: '第12条', position: 'p20' },
      ] } } },
      { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'report', status: 'completed', output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注付款' }] } } },
    ]);
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries, streaming: false, status: 'done', result: extractWorkflowResult(entries), meta: { currentStep: 'report' } }}
        actions={makeActions()}
      />,
    );
    expect(screen.getByTestId('report-risk-high')).toBeTruthy();
    expect(screen.getByTestId('report-risk-high').textContent).toContain('付款周期过长');
    expect(screen.getByTestId('report-risk-high').textContent).toContain('p12');
    expect(screen.getByTestId('report-risk-mid').textContent).toContain('验收边界不清');
  });

  it('renders original text after readDocumentBytes returns txt bytes', async () => {
    const bytes = new TextEncoder().encode('第一条 合同标的').buffer;
    const readDocumentBytes = vi.fn().mockResolvedValue({
      kind: 'txt',
      fileName: 'contract.txt',
      fileSize: 24,
      bytes,
    });
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [{ path: 'C:/tmp/contract.txt', name: 'contract.txt' }] } }}
        actions={{ ...makeActions(), readDocumentBytes }}
      />,
    );
    expect(await screen.findByTestId('document-preview')).toBeTruthy();
    expect(screen.getByTestId('document-preview').textContent).toContain('第一条 合同标的');
    expect(screen.getByText(/TXT · /)).toBeTruthy();
    expect(screen.queryByText('原文预览将在后续版本提供。')).toBeNull();
    expect(readDocumentBytes).toHaveBeenCalledWith('C:/tmp/contract.txt');
  });

  it('does not fetch preview when the original file is missing', async () => {
    const readDocumentBytes = vi.fn();
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: [], streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/gone/contract.pdf', name: 'contract.pdf', missing: true }] } }}
        actions={{ ...makeActions(), readDocumentBytes }}
      />,
    );
    expect(screen.getByText('无法找到原文件，风险发现与报告仍可从会话历史恢复。')).toBeTruthy();
    expect(readDocumentBytes).not.toHaveBeenCalled();
  });

  it('shows an unsupported preview message', async () => {
    const readDocumentBytes = vi.fn().mockResolvedValue({ error: 'unsupported' });
    render(
      <ContractAgentSurface
        agent={agent}
        sessionId="s1"
        mode="history"
        session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null, inputs: [{ path: 'C:/tmp/old.doc', name: 'old.doc' }] } }}
        actions={{ ...makeActions(), readDocumentBytes }}
      />,
    );
    expect(await screen.findByText('暂不支持预览该文件类型')).toBeTruthy();
  });
});
