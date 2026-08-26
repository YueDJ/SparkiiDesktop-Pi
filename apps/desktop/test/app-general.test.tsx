import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { App, sessionDisplayName } from '../src/App.js';

afterEach(cleanup);

describe('sessionDisplayName', () => {
  it('prefers title, then firstMessage, then time, then a default', () => {
    expect(sessionDisplayName({ title: 'PRD 标题', firstMessage: 'x', updatedAt: 1 })).toBe('PRD 标题');
    expect(sessionDisplayName({ firstMessage: '帮我写一个合同审核流程' })).toBe('帮我写一个合同审核流程');
    expect(sessionDisplayName({ firstMessage: 'a'.repeat(30) })).toBe('a'.repeat(24));
    expect(sessionDisplayName({ updatedAt: new Date(2026, 7, 26, 10, 30).getTime() })).toContain('08/26');
    expect(sessionDisplayName({})).toBe('会话');
  });
});

function makeApi() {
  const listeners: Record<string, Set<(p: any) => void>> = {};
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => {
      (listeners[channel] ??= new Set()).add(cb);
      channels[channel] = (p: any) => (listeners[channel] ?? new Set()).forEach((fn) => fn(p));
      return () => { listeners[channel]?.delete(cb); };
    }),
    login: vi.fn().mockResolvedValue({ userId: 'admin', roles: ['admin'] }),
    getProfile: vi.fn().mockResolvedValue({ pages: {} }),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([
      { id: 'contract', name: '合同审核' },
      { id: 'general', name: '通用智能体' },
    ]),
    newChatSession: vi.fn().mockResolvedValue({ sessionId: 'g1', workspacePath: 'C:/ws/SparkiiXyZ9202608251710', model: null }),
    listChatSessions: vi.fn().mockResolvedValue([{ id: 'g1', profileId: 'general', title: '会话 08-25 17:10', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710', model: null, piSessionFile: null, createdAt: 0, updatedAt: 0 }]),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710', workspaceKind: 'auto' }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [] }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    setChatTitle: vi.fn().mockResolvedValue({ ok: true }),
    deleteChatSession: vi.fn().mockResolvedValue({ ok: true }),
    decideApproval: vi.fn(),
    queryAudit: vi.fn().mockResolvedValue([]),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App general agent', () => {
  it('lists agents, creates a session, and streams a reply', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByText('新建会话');
    fireEvent.click(screen.getByText('新建会话'));
    await waitFor(() => expect(api.newChatSession).toHaveBeenCalledWith('general'));
    await screen.findByTestId('composer-input');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '你好' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalledWith('g1', '你好'));
    act(() => channels['chat-event']({ sessionId: 'g1', type: 'message', role: 'assistant', delta: '在的' }));
    expect(screen.getByText(/在的/)).toBeTruthy();
  });

  it('deletes the active session and returns to empty state', async () => {
    const { api } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByText('新建会话');
    fireEvent.click(screen.getByText('新建会话'));
    await screen.findByTestId('composer-input');
    fireEvent.click(screen.getByTitle('会话'));
    fireEvent.click(screen.getByTitle('删除 g1'));
    await waitFor(() => expect(api.deleteChatSession).toHaveBeenCalledWith('g1'));
    await screen.findByText('新建会话');
  });
});
