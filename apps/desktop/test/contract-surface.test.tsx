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
    expect(screen.getByText('高风险')).toBeTruthy();
    expect(screen.getByText('约定逾期付款违约金上限')).toBeTruthy();
    expect(screen.getByText('第12条 违约责任')).toBeTruthy();
  });

  it('switches between report and original document panes', () => {
    renderSurface({ status: 'done' });
    expect(screen.getAllByText('合同审核报告').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('原文'));
    expect(screen.getByText('C:/tmp/contract.pdf')).toBeTruthy();
  });

  it('requests export via the approval path', () => {
    const onRequestExport = vi.fn();
    render(<ContractSurface state={makeState()} workflow={{ status: 'done' } as any} onAction={vi.fn()} onRequestExport={onRequestExport} />);
    fireEvent.click(screen.getByText('导出报告 · 需审批'));
    expect(onRequestExport).toHaveBeenCalled();
  });

  it('marks the active workflow step', () => {
    const { container } = renderSurface({ status: 'running', step: 'compare' });
    expect(container.querySelector('.ui-workflow-steps')).toBeTruthy();
    const stepEl = screen.getAllByText('比对')[0].closest('.ui-workflow-step');
    expect(stepEl?.getAttribute('data-state')).toBe('active');
  });

  it('renders a clickable workflow step nav', () => {
    renderSurface({ status: 'done' });
    expect(screen.getByRole('button', { name: '比对' })).toBeTruthy();
  });

  it('renders a structured compare step without raw JSON', () => {
    renderSurface({ status: 'done' });
    fireEvent.click(screen.getByRole('button', { name: '比对' }));
    expect(document.querySelector('pre')).toBeNull();
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
    expect(onWorkflowState).toHaveBeenCalledWith('risk_confirmed', { riskId: 'f0', stepId: 'compare' });
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
