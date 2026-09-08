import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApprovalInboxProvider } from '../src/trust/ApprovalInbox.js';
import { ApprovalDrawer } from '../src/trust/ApprovalDrawer.js';
import { HighRiskApprovalDialog } from '../src/trust/HighRiskApprovalDialog.js';
import type { ApprovalProposalLike } from '../src/trust/types.js';

afterEach(cleanup);

const base = (over: Partial<ApprovalProposalLike> & Record<string, unknown> = {}): ApprovalProposalLike => ({
  id: 'p1',
  requestId: 'r1',
  summary: '编辑 a.txt',
  risk: 'write',
  createdAt: Date.now(),
  toolName: 'edit',
  payload: { path: 'a.txt', content: 'hi', diff: '--- a/a.txt\n+++ b/a.txt\n+hi' },
  sessionId: 's1',
  status: 'pending',
  ...over,
});

function renderApproval(ui: ReactNode, proposals: unknown[]) {
  const api = {
    listPendingApprovals: async () => proposals,
    decideApproval: async () => ({}),
    on: () => () => {},
  };
  return render(<ApprovalInboxProvider api={api as never}>{ui}</ApprovalInboxProvider>);
}

describe('approval diff rendering', () => {
  it('does not show DiffView from payload.diff without preview', async () => {
    renderApproval(<ApprovalDrawer open onClose={() => {}} />, [base()]);
    expect(await screen.findByText(/技术细节/)).toBeTruthy();
    expect(screen.queryByTestId('diff-view')).toBeNull();
    fireEvent.click(screen.getByText(/技术细节/));
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });

  it('shows DiffView by default when preview.kind is diff', async () => {
    const lines = ['--- a/a.txt', '+++ b/a.txt', '+hi'];
    renderApproval(<ApprovalDrawer open onClose={() => {}} />, [base({ preview: { kind: 'diff', lines } })]);
    expect(await screen.findByTestId('diff-view')).toBeTruthy();
    expect(screen.getByText('+hi')).toBeTruthy();
  });

  it('expands hidden preview lines and can collapse them', async () => {
    const lines = ['1', '2', '3', '4', '5', '6', '7', '8'];
    renderApproval(<ApprovalDrawer open onClose={() => {}} />, [base({ preview: { kind: 'text', lines } })]);
    await waitFor(() => expect(document.querySelector('.ui-approval-preview-text')?.textContent).toBe('1\n2\n3\n4\n5'));
    fireEvent.click(screen.getByText('还有 3 行 · 展开'));
    expect(document.querySelector('.ui-approval-preview-text')?.textContent).toBe('1\n2\n3\n4\n5\n6\n7\n8');
    fireEvent.click(screen.getByText('收起'));
    expect(document.querySelector('.ui-approval-preview-text')?.textContent).toBe('1\n2\n3\n4\n5');
  });

  it('modal also requires preview.kind=diff rather than payload.diff', async () => {
    renderApproval(<HighRiskApprovalDialog />, [base({ risk: 'high-risk' })]);
    await waitFor(() => expect(screen.queryByTestId('diff-view')).toBeNull());
    cleanup();
    renderApproval(<HighRiskApprovalDialog />, [base({ risk: 'high-risk', preview: { kind: 'diff', lines: ['+hi'] } })]);
    expect(await screen.findByTestId('diff-view')).toBeTruthy();
  });
});
