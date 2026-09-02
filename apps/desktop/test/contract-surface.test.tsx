import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContractSurface, ContractAgentSurface } from '../agents/contract-review/surface/index.js';
import { normalizeSessionEntries } from '../src/surface/normalize.js';

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
    expect(screen.getByTestId('upload')).toBeTruthy();
    expect(screen.getByTestId('review')).toBeTruthy();
  });

  it('renders risk findings with levels and advice from workflow result', () => {
    renderSurface({ status: 'done' });
    expect(screen.getByText('第7条 付款条件')).toBeTruthy();
    expect(screen.getAllByText('高风险').length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, el) => el?.textContent?.includes('约定逾期付款违约金上限') ?? false).length).toBeGreaterThan(0);
    expect(screen.getByText('第12条 违约责任')).toBeTruthy();
  });

  it('shows the original document panel alongside the risk panel', () => {
    renderSurface({ status: 'done' });
    expect(screen.getByText('合同原文')).toBeTruthy();
    expect(screen.getAllByText('contract.pdf').length).toBeGreaterThan(0);
    expect(screen.getAllByText('合同审核报告').length).toBeGreaterThan(0);
  });

  it('requests export via the approval path after merging', () => {
    const onRequestExport = vi.fn();
    render(<ContractSurface state={makeState()} workflow={{ status: 'done' } as any} onAction={vi.fn()} onRequestExport={onRequestExport} />);
    fireEvent.click(screen.getByText('合并到报告'));
    fireEvent.click(screen.getByText('导出报告'));
    expect(onRequestExport).toHaveBeenCalled();
  });

  it('renders the review stage in the single-page stage rail', () => {
    renderSurface({ status: 'done' });
    expect(screen.getByText('审核')).toBeTruthy();
    expect(screen.getByText('报告')).toBeTruthy();
    expect(screen.getByText('复核')).toBeTruthy();
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
    expect(onWorkflowState).toHaveBeenCalledWith('risk_confirmed', { riskId: 'f0', stepId: 'review' });
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
    expect(screen.getByText('第7条 付款条件')).toBeTruthy();
    expect(screen.queryByText('第12条 违约责任')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择 第7条 付款条件' }));
    fireEvent.click(screen.getByText('批量确认'));
    expect(onWorkflowState).toHaveBeenCalledWith('risk_confirmed', { riskId: 'f0', stepId: 'review' });
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
  });

  it('renders the single-page cockpit with review and report panels', () => {
    const entries = normalizeSessionEntries([
      { type: 'workflow_step_start', data: { stepId: 'review' } },
      { type: 'workflow_step_end', data: { stepId: 'review', status: 'completed' } },
      { type: 'workflow_state', data: { stepId: 'review', action: 'result', payload: {
        review: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' }] },
        report: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] },
      } } },
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
    expect(screen.getByText('风险发现')).toBeTruthy();
    expect(screen.getByText('付款周期过长')).toBeTruthy();
  });

  it('renders the report from the session stream without workflow/state props', () => {
    const entries = normalizeSessionEntries([
      {
        type: 'workflow_state',
        data: { stepId: 'report', action: 'result', payload: { report: { title: '会话报告', sections: [{ heading: '结论', body: '关注' }] }, compare: [{ 条款: '第1条', 风险: '高' }] } },
      },
      { type: 'workflow_step_start', data: { stepId: 'report' } },
      { type: 'workflow_step_end', data: { stepId: 'report', status: 'completed' } },
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
    expect(actions.startWorkflow).toHaveBeenCalledWith({ documents: ['C:/tmp/a.pdf'] });
  });
});
