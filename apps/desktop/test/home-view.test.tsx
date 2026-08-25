import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { HomeView } from '../src/surfaces/HomeView.js';
import type { ShellAgent } from '../src/shell/Shell.js';

afterEach(cleanup);

const AGENTS: ShellAgent[] = [{ id: 'contract', name: '合同审核', status: 'idle' }];
const PROPOSALS = [{ id: 'p1', summary: '导出审核报告', risk: 'write', createdAt: Date.now() }];

describe('HomeView', () => {
  it('renders greeting, agent card and real pending approvals', () => {
    render(<HomeView userName="admin" agents={AGENTS} pendingApprovals={PROPOSALS} onNavigate={vi.fn()} />);
    expect(screen.getByText(/工作台 · 上午好,admin/)).toBeTruthy();
    expect(screen.getByText('合同审核')).toBeTruthy();
    expect(screen.getByText('导出审核报告')).toBeTruthy();
  });

  it('shows empty states when there is nothing pending or no sessions', () => {
    render(<HomeView userName="admin" agents={AGENTS} pendingApprovals={[]} onNavigate={vi.fn()} />);
    expect(screen.getByText('没有待审批事项')).toBeTruthy();
    expect(screen.getByText(/暂无会话记录/)).toBeTruthy();
  });

  it('navigates when an agent card is clicked', () => {
    const onNavigate = vi.fn();
    render(<HomeView userName="admin" agents={AGENTS} pendingApprovals={[]} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('合同审核'));
    expect(onNavigate).toHaveBeenCalledWith('contract');
  });
});
