import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApprovalInboxProvider } from '../src/trust/ApprovalInbox.js';
import { ApprovalDrawer } from '../src/trust/ApprovalDrawer.js';
import { HighRiskApprovalDialog } from '../src/trust/HighRiskApprovalDialog.js';
import { ApprovalCenter } from '../src/trust/ApprovalCenter.js';

afterEach(cleanup);

const PROPOSAL = {
  id: 'p1', requestId: 'r1', summary: '导出审核报告', toolName: 'report.export', targetSystem: '本地文件目录',
  payload: { title: '报告' }, payloadHash: 'abc123', risk: 'write', createdAt: Date.now(),
  sessionId: 'session-1234', profileId: 'contract-review', status: 'pending',
};

function renderApproval(ui: ReactNode, proposals: unknown[] = [], decideApproval = vi.fn(async () => ({}))) {
  const api = {
    listPendingApprovals: async () => proposals,
    decideApproval,
    on: () => () => {},
  };
  return render(<ApprovalInboxProvider api={api as never}>{ui}</ApprovalInboxProvider>);
}

describe('ApprovalCenter', () => {
  it('lists routine proposals by title without mid-risk chrome', async () => {
    const onOpenDetail = vi.fn();
    renderApproval(<ApprovalCenter onOpenDetail={onOpenDetail} />, [PROPOSAL]);
    expect(await screen.findByText('导出审核报告')).toBeTruthy();
    expect(screen.queryByText(/中风险/)).toBeNull();
    expect(screen.queryByText(/report\.export/)).toBeNull();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpenDetail).toHaveBeenCalledWith(PROPOSAL);
    expect(document.querySelector('.dot')).toBeNull();
  });

  it('shows high-risk badge and countdown', async () => {
    renderApproval(
      <ApprovalCenter onOpenDetail={vi.fn()} />,
      [{ ...PROPOSAL, risk: 'high-risk', summary: '永久删除 reports/' }],
    );
    expect(await screen.findByText('永久删除 reports/')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    expect(document.querySelector('.ui-countdown')).toBeTruthy();
  });
});

describe('ApprovalDrawer', () => {
  it('shows the summary and decides without a note', async () => {
    const decideApproval = vi.fn(async () => ({}));
    renderApproval(
      <ApprovalDrawer open currentSessionId="session-1234" onClose={() => {}} />,
      [PROPOSAL],
      decideApproval,
    );
    expect(await screen.findByText('导出审核报告')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '需要你确认' })).toBeTruthy();
    expect(screen.getByText('1 处改动等你看')).toBeTruthy();
    expect(screen.getByText('当前会话')).toBeTruthy();
    expect(screen.queryByText(/本地文件目录/)).toBeNull();
    expect(screen.queryByText(/中风险/)).toBeNull();
    expect(screen.queryByPlaceholderText(/审批意见/)).toBeNull();
    fireEvent.click(screen.getByText('允许'));
    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(decideApproval.mock.calls[0].slice(0, 2)).toEqual(['p1', true]);
  });

  it('reveals payload JSON under 技术细节', async () => {
    renderApproval(<ApprovalDrawer open onClose={() => {}} />, [PROPOSAL]);
    expect(await screen.findByText(/技术细节/)).toBeTruthy();
    expect(screen.queryByText(/"title": "报告"/)).toBeNull();
    fireEvent.click(screen.getByText(/技术细节/));
    expect(screen.getByText(/"title": "报告"/)).toBeTruthy();
  });

  it('groups approvals by session and only lists unclaimed items', async () => {
    const other = { ...PROPOSAL, id: 'p2', requestId: 'r2', summary: '写入文件', sessionId: 'session-9999' };
    renderApproval(<ApprovalDrawer open currentSessionId="session-1234" onClose={() => {}} />, [PROPOSAL, other]);
    expect(await screen.findByText('当前会话')).toBeTruthy();
    expect(screen.getByText('其他会话')).toBeTruthy();
    expect(screen.getAllByTestId('approval-queue-item')).toHaveLength(2);
    expect(screen.queryByText(/session-1234/)).toBeNull();
    expect(screen.queryByText(/session-9999/)).toBeNull();
  });

  it('does not drive a renderer-side timeout for routine cards', async () => {
    renderApproval(<ApprovalDrawer open onClose={() => {}} />, [PROPOSAL]);
    expect(await screen.findByText('导出审核报告')).toBeTruthy();
    expect(document.querySelector('.ui-countdown--hidden')).toBeNull();
    expect(document.querySelector('.ui-countdown')).toBeNull();
  });
});

describe('HighRiskApprovalDialog', () => {
  it('requires a second confirm for high-risk approvals', async () => {
    const decideApproval = vi.fn(async () => ({}));
    renderApproval(<HighRiskApprovalDialog />, [{ ...PROPOSAL, risk: 'high-risk', summary: '永久删除 reports/' }], decideApproval);
    expect(await screen.findByText('可能无法恢复')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    fireEvent.click(screen.getByText('允许'));
    expect(decideApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('再次确认允许'));
    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(decideApproval.mock.calls[0].slice(0, 2)).toEqual(['p1', true]);
  });

  it('renders nothing when there is no high-risk proposal', async () => {
    renderApproval(<HighRiskApprovalDialog />, [PROPOSAL]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
