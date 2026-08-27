import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContractSurface } from '../src/surfaces/ContractSurface.js';

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
    expect(screen.getByText('合同审核报告')).toBeTruthy();
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
    const stepEl = screen.getByText('比对').closest('.ui-workflow-step');
    expect(stepEl?.getAttribute('data-state')).toBe('active');
  });
});
