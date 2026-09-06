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
  it('does not show DiffView from payload.diff without preview', () => {
    render(<ApprovalPanel proposals={[base()]} onDecide={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-view')).toBeNull();
    fireEvent.click(screen.getByText(/技术细节/));
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });

  it('shows DiffView by default when preview.kind is diff', () => {
    const lines = ['--- a/a.txt', '+++ b/a.txt', '+hi'];
    render(
      <ApprovalPanel
        proposals={[base({ preview: { kind: 'diff', lines } })]}
        onDecide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('diff-view')).toBeTruthy();
    expect(screen.getByText('+hi')).toBeTruthy();
  });

  it('expands hidden preview lines and can collapse them', () => {
    const lines = ['1', '2', '3', '4', '5', '6', '7', '8'];
    render(
      <ApprovalPanel
        proposals={[base({ preview: { kind: 'text', lines } })]}
        onDecide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const preview = document.querySelector('.ui-approval-preview-text');
    expect(preview?.textContent).toBe('1\n2\n3\n4\n5');
    fireEvent.click(screen.getByText('还有 3 行 · 展开'));
    expect(preview?.textContent).toBe('1\n2\n3\n4\n5\n6\n7\n8');
    fireEvent.click(screen.getByText('收起'));
    expect(preview?.textContent).toBe('1\n2\n3\n4\n5');
  });

  it('modal also requires preview.kind=diff rather than payload.diff', () => {
    render(<ApprovalModal proposal={base({ risk: 'high-risk' })} onDecide={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('diff-view')).toBeNull();
    render(
      <ApprovalModal
        proposal={base({ risk: 'high-risk', preview: { kind: 'diff', lines: ['+hi'] } })}
        onDecide={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('diff-view').length).toBeGreaterThan(0);
  });
});
