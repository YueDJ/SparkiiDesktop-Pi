import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalPanel } from '../src/trust/ApprovalPanel.js';
import { ApprovalModal } from '../src/trust/ApprovalModal.js';
import type { ApprovalProposalLike } from '../src/trust/types.js';

afterEach(cleanup);

const base = (over: Partial<ApprovalProposalLike> = {}): ApprovalProposalLike => ({
  id: 'p1',
  summary: '编辑 a.txt',
  risk: 'write',
  createdAt: Date.now(),
  toolName: 'edit',
  payload: { path: 'a.txt', content: 'hi', diff: '--- a/a.txt\n+++ b/a.txt\n+hi' },
  ...over,
});

describe('approval diff rendering', () => {
  it('panel shows DiffView when payload.diff exists', () => {
    render(<ApprovalPanel proposals={[base()]} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });

  it('panel hides DiffView without diff', () => {
    render(<ApprovalPanel proposals={[base({ payload: { path: 'a.txt' } })]} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });

  it('modal shows DiffView when payload.diff exists', () => {
    render(<ApprovalModal proposal={base()} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
