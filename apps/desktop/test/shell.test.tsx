import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Shell, type ShellProps } from '../src/shell/Shell.js';

afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  localStorage.clear();
  document.getElementById('sparkii-theme-tokens')?.remove();
});

function makeProps(): ShellProps {
  return {
    active: 'contract',
    agents: [
      { id: 'contract', name: '合同审核', status: 'running' },
      { id: 'chat', name: '法规问答', status: 'idle' },
      { id: 'dashboard', name: '舆情监控', status: 'queued', queuePosition: 1 },
    ],
    sessions: {
      contract: [
        { id: 's3', name: '会话#3', state: '比对中', time: '今天', active: true },
        { id: 's2', name: '会话#2', state: '已完成', time: '昨天' },
      ],
      chat: [{ id: 'c1', name: '会话#1', state: '进行中', time: '昨天' }],
      dashboard: [],
    },
    pendingApprovals: 2,
    statusText: '正在比对 12 条',
    onNavigate: vi.fn(),
    onNewSession: vi.fn(),
    children: <div data-testid="surface">surface</div>,
  };
}

describe('Shell', () => {
  it('renders topbar, rail, status bar and surface', () => {
    render(<Shell {...makeProps()} />);
    expect(screen.getByText('Sparkii')).toBeTruthy();
    expect(screen.getAllByText('合同审核').length).toBeGreaterThan(0);
    expect(screen.getByText('正在比对 12 条')).toBeTruthy();
    expect(screen.getByTestId('surface')).toBeTruthy();
  });

  it('navigates via logo and agent buttons', () => {
    const props = makeProps();
    render(<Shell {...props} />);
    fireEvent.click(screen.getByText('Sparkii'));
    expect(props.onNavigate).toHaveBeenCalledWith('home');
    fireEvent.click(screen.getByTestId('agent-nav-chat'));
    expect(props.onNavigate).toHaveBeenCalledWith('chat');
  });

  it('theme toggle flips the document dark class and persists', () => {
    render(<Shell {...makeProps()} />);
    fireEvent.click(screen.getByTitle('深色/浅色'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('sparkii-theme')).toBe('dark');
    fireEvent.click(screen.getByTitle('深色/浅色'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('rail groups sessions by agent instead of a right drawer', () => {
    render(<Shell {...makeProps()} />);
    // 会话历史直接内嵌在左侧栏，按智能体分组
    expect(screen.getByText('会话#3')).toBeTruthy();
    expect(screen.getByText('会话#2')).toBeTruthy();
    expect(screen.getByText('会话#1')).toBeTruthy();
    // 右侧抽屉不再存在
    expect(document.querySelector('.ui-drawer')).toBeNull();
  });

  it('filters session history by the search query', () => {
    render(<Shell {...makeProps()} />);
    fireEvent.click(screen.getByTitle('搜索会话'));
    const input = screen.getByPlaceholderText('搜索会话…');
    fireEvent.change(input, { target: { value: '会话#3' } });
    expect(screen.getByText('会话#3')).toBeTruthy();
    expect(screen.queryByText('会话#2')).toBeNull();
    expect(screen.queryByText('会话#1')).toBeNull();
  });

  it('clicking an agent in the nav starts a new conversation', () => {
    const props = makeProps();
    render(<Shell {...props} />);
    fireEvent.click(screen.getByTestId('agent-nav-contract'));
    expect(props.onNewSession).toHaveBeenCalledWith('contract');
  });

  it('queue panel opens from the status bar with running and queued agents', () => {
    render(<Shell {...makeProps()} />);
    fireEvent.click(screen.getByText('运行 1/4 · 1 排队'));
    expect(screen.getByText('运行中心')).toBeTruthy();
    expect(screen.getAllByText('合同审核').length).toBeGreaterThan(0);
    expect(screen.getByText('舆情监控 · 舆情监控 · 第 1 位')).toBeTruthy();
  });

  it('closes a drawer when clicking outside it', () => {
    render(<Shell {...makeProps()} />);
    fireEvent.click(screen.getByText('运行 1/4 · 1 排队'));
    expect(screen.getByText('运行中心')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByText('运行中心')).toBeNull();
  });

  it('account drawer shows the current user', () => {
    render(<Shell {...makeProps()} />);
    fireEvent.click(screen.getByTitle('账号'));
    expect(screen.getByText('admin')).toBeTruthy();
  });

  it('renames and deletes a session through the right-click menu', () => {
    const props = makeProps();
    props.active = 'general';
    props.agents = [...props.agents, { id: 'general', name: '通用智能体', status: 'idle' }];
    props.sessions = { ...props.sessions, general: [{ id: 'g1', name: '会话 08-25 17:10', state: '', time: '今天' }] };
    props.onRenameSession = vi.fn();
    props.onDeleteSession = vi.fn();
    render(<Shell {...props} />);
    fireEvent.contextMenu(screen.getByTestId('session-g1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }));
    const input = screen.getByDisplayValue('会话 08-25 17:10');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRenameSession).toHaveBeenCalledWith('general', 'g1', '新标题');
    fireEvent.contextMenu(screen.getByTestId('session-g1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }));
    expect(props.onDeleteSession).toHaveBeenCalledWith('general', 'g1');
  });

  it('opens a selected session through onOpenSession instead of re-navigating', () => {
    const props = makeProps();
    props.active = 'general';
    props.agents = [...props.agents, { id: 'general', name: '通用智能体', status: 'idle' }];
    props.sessions = { ...props.sessions, general: [{ id: 'g1', name: '旧会话', state: '', time: '今天' }] };
    props.onOpenSession = vi.fn();
    render(<Shell {...props} />);
    fireEvent.click(screen.getByText('旧会话'));
    expect(props.onOpenSession).toHaveBeenCalledWith('general', 'g1');
    expect(props.onNavigate).not.toHaveBeenCalled();
  });
});
