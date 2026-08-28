import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
  it('lists proposals with risk badges and opens detail', () => {
    const onOpenDetail = vi.fn();
    render(<ApprovalCenter proposals={[PROPOSAL]} onOpenDetail={onOpenDetail} />);
    expect(screen.getByText('导出审核报告')).toBeTruthy();
    expect(screen.getByText(/中风险/)).toBeTruthy();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpenDetail).toHaveBeenCalledWith(PROPOSAL);
    expect(document.querySelector('.dot')).toBeNull();
  });
});

describe('ApprovalPanel', () => {
  it('shows operation, target, source, risk and decides with note', () => {
    const onDecide = vi.fn();
    render(<ApprovalPanel proposals={[PROPOSAL]} currentSessionId="session-1234" onDecide={onDecide} onClose={() => {}} />);
    expect(screen.getByText('导出审核报告')).toBeTruthy();
    expect(screen.getByText(/本地文件目录/)).toBeTruthy();
    expect(screen.getByText('当前会话')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('审批意见(可选)'), { target: { value: '同意' } });
    fireEvent.click(screen.getByText('批准'));
    expect(onDecide).toHaveBeenCalledWith('p1', true, '同意');
  });

  it('reveals frozen payload on demand', () => {
    render(<ApprovalPanel proposals={[PROPOSAL]} onDecide={vi.fn()} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.getByText(/"title": "报告"/)).toBeTruthy();
  });

  it('groups approvals by session and lists all pending items', () => {
    const other = { ...PROPOSAL, id: 'p2', summary: '写入文件', sessionId: 'session-9999' };
    render(<ApprovalPanel proposals={[PROPOSAL, other]} currentSessionId="session-1234" onDecide={vi.fn()} onClose={() => {}} />);
    expect(screen.getByText('当前会话')).toBeTruthy();
    expect(screen.getByText('其他会话')).toBeTruthy();
    expect(screen.getAllByTestId('approval-queue-item')).toHaveLength(2);
  });
});

describe('ApprovalModal', () => {
  it('requires a second confirm for high-risk approvals', () => {
    const onDecide = vi.fn();
    const high = { ...PROPOSAL, risk: 'high-risk' };
    render(<ApprovalModal proposal={high} onDecide={onDecide} onClose={() => {}} />);
    fireEvent.click(screen.getByText('批准'));
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('再次确认批准'));
    expect(onDecide).toHaveBeenCalledWith('p1', true, '');
  });

  it('decides directly for non-high-risk approvals', () => {
    const onDecide = vi.fn();
    render(<ApprovalModal proposal={PROPOSAL} onDecide={onDecide} onClose={() => {}} />);
    fireEvent.click(screen.getByText('批准'));
    expect(onDecide).toHaveBeenCalledWith('p1', true, '');
  });
});
