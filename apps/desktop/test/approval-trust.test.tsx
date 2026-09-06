import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApprovalPanel } from '../src/trust/ApprovalPanel.js';
import { ApprovalModal } from '../src/trust/ApprovalModal.js';
import { ApprovalCenter } from '../src/trust/ApprovalCenter.js';

afterEach(cleanup);

const PROPOSAL = {
  id: 'p1', summary: '导出审核报告', toolName: 'report.export', targetSystem: '本地文件目录',
  payload: { title: '报告' }, payloadHash: 'abc123', risk: 'write', createdAt: Date.now(),
  sessionId: 'session-1234', profileId: 'contract-review',
};

describe('ApprovalCenter', () => {
  it('lists routine proposals by title without mid-risk chrome', () => {
    const onOpenDetail = vi.fn();
    render(<ApprovalCenter proposals={[PROPOSAL]} onOpenDetail={onOpenDetail} />);
    expect(screen.getByText('导出审核报告')).toBeTruthy();
    expect(screen.queryByText(/中风险/)).toBeNull();
    expect(screen.queryByText(/report\.export/)).toBeNull();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpenDetail).toHaveBeenCalledWith(PROPOSAL);
    expect(document.querySelector('.dot')).toBeNull();
  });

  it('shows high-risk badge and countdown', () => {
    render(
      <ApprovalCenter
        proposals={[{ ...PROPOSAL, risk: 'high-risk', summary: '永久删除 reports/' }]}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText('永久删除 reports/')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    expect(document.querySelector('.ui-countdown')).toBeTruthy();
  });
});

describe('ApprovalPanel', () => {
  it('shows the summary title and allows without a note', () => {
    const onDecide = vi.fn();
    render(<ApprovalPanel proposals={[PROPOSAL]} currentSessionId="session-1234" onDecide={onDecide} onClose={() => {}} />);
    expect(screen.getByText('导出审核报告')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '需要你确认' })).toBeTruthy();
    expect(screen.getByText('1 处改动等你看')).toBeTruthy();
    expect(screen.getByText('当前会话')).toBeTruthy();
    expect(screen.queryByText(/本地文件目录/)).toBeNull();
    expect(screen.queryByText(/中风险/)).toBeNull();
    expect(screen.queryByPlaceholderText(/审批意见/)).toBeNull();
    fireEvent.click(screen.getByText('允许'));
    expect(onDecide).toHaveBeenCalledWith('p1', true);
  });

  it('reveals payload JSON under 技术细节', () => {
    render(<ApprovalPanel proposals={[PROPOSAL]} onDecide={vi.fn()} onClose={() => {}} />);
    expect(screen.queryByText(/"title": "报告"/)).toBeNull();
    fireEvent.click(screen.getByText(/技术细节/));
    expect(screen.getByText(/"title": "报告"/)).toBeTruthy();
  });

  it('groups approvals by session and lists all pending items', () => {
    const other = { ...PROPOSAL, id: 'p2', summary: '写入文件', sessionId: 'session-9999' };
    render(<ApprovalPanel proposals={[PROPOSAL, other]} currentSessionId="session-1234" onDecide={vi.fn()} onClose={() => {}} />);
    expect(screen.getByText('当前会话')).toBeTruthy();
    expect(screen.getByText('其他会话')).toBeTruthy();
    expect(screen.getAllByTestId('approval-queue-item')).toHaveLength(2);
    expect(screen.queryByText(/session-1234/)).toBeNull();
    expect(screen.queryByText(/session-9999/)).toBeNull();
  });

  it('keeps a hidden timeout path for routine cards', () => {
    vi.useFakeTimers();
    const onDecide = vi.fn();
    render(
      <ApprovalPanel
        proposals={[{ ...PROPOSAL, createdAt: Date.now() }]}
        timeoutMs={0}
        onDecide={onDecide}
        onClose={() => {}}
      />,
    );
    expect(document.querySelector('.ui-countdown--hidden')).toBeTruthy();
    expect(screen.queryByText(/\d+s/)).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onDecide).toHaveBeenCalledWith('p1', false, 'timeout');
    vi.useRealTimers();
  });
});

describe('ApprovalModal', () => {
  it('requires a second confirm for high-risk approvals', () => {
    const onDecide = vi.fn();
    const high = { ...PROPOSAL, risk: 'high-risk', summary: '永久删除 reports/' };
    render(<ApprovalModal proposal={high} onDecide={onDecide} onClose={() => {}} />);
    expect(screen.getByText('可能无法恢复')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    fireEvent.click(screen.getByText('允许'));
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('再次确认允许'));
    expect(onDecide).toHaveBeenCalledWith('p1', true, '');
  });

  it('decides directly for non-high-risk approvals', () => {
    const onDecide = vi.fn();
    render(<ApprovalModal proposal={PROPOSAL} onDecide={onDecide} onClose={() => {}} />);
    fireEvent.click(screen.getByText('允许'));
    expect(onDecide).toHaveBeenCalledWith('p1', true, '');
  });
});
