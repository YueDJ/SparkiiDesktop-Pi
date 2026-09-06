import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';
import { App } from '../src/App.js';

afterEach(cleanup);

function makeApi() {
  const listeners: Record<string, Set<(p: any) => void>> = {};
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => {
      (listeners[channel] ??= new Set()).add(cb);
      channels[channel] = (p: any) => (listeners[channel] ?? new Set()).forEach((fn) => fn(p));
      return () => { listeners[channel]?.delete(cb); };
    }),
    getLocalSubject: vi.fn().mockResolvedValue({ userId: 'alice', roles: ['admin', 'reviewer'] }),
    getProfile: vi.fn().mockResolvedValue({ pages: {} }),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    listErrors: vi.fn().mockResolvedValue([]),
    appendError: vi.fn().mockResolvedValue({ id: 'e', message: '', source: '', createdAt: 0, read: false }),
    clearError: vi.fn().mockResolvedValue({ ok: true }),
    clearErrors: vi.fn().mockResolvedValue({ ok: true }),
    markAllErrorsRead: vi.fn().mockResolvedValue({ ok: true }),
    listAgents: vi.fn().mockResolvedValue([
      { id: 'general', name: '通用智能体', surfaceType: 'chat' },
      { id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' },
    ]),
    listChatSessions: vi.fn().mockResolvedValue([]),
    getChatSession: vi.fn().mockResolvedValue({}),
    openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    getRuntimePool: vi.fn().mockResolvedValue({ maxAgents: 4, active: 0, queued: 0, slots: [], queue: [] }),
    decideApproval: vi.fn().mockReturnValue(new Promise(() => {})),
    queryAudit: vi.fn().mockResolvedValue([]),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

function writeProposal(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    summary: '写入 hello.txt',
    toolName: 'write',
    risk: 'write',
    createdAt: Date.now(),
    sessionId: 's1',
    payload: { path: 'hello.txt' },
    ...over,
  };
}

function highProposal(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    summary: '永久删除 reports/',
    toolName: 'bash',
    risk: 'high-risk',
    createdAt: Date.now(),
    sessionId: 's1',
    payload: { command: 'rm -rf reports' },
    ...over,
  };
}

describe('App approval shell', () => {
  it('opens a modal for high-risk and does not leave an empty drawer', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => { channels['approval'](highProposal()); });
    expect(screen.getByRole('dialog', { name: '永久删除 reports/' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '需要你确认' })).toBeNull();
  });

  it('shows routine items in the drawer and high-risk in a stacked modal', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => { channels['approval'](writeProposal()); });
    act(() => { channels['approval'](highProposal()); });
    const panel = screen.getByRole('dialog', { name: '需要你确认' });
    expect(within(panel).getByText('写入 hello.txt')).toBeTruthy();
    expect(within(panel).queryByText('永久删除 reports/')).toBeNull();
    expect(screen.getByRole('dialog', { name: '永久删除 reports/' })).toBeTruthy();
  });

  it('does not open the panel when 详情 is clicked on a high-risk item', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => { channels['approval'](highProposal()); });
    fireEvent.click(screen.getByRole('button', { name: /审批/ }));
    await screen.findByRole('heading', { name: '审批中心' });
    fireEvent.click(screen.getByText('详情'));
    expect(screen.getByRole('dialog', { name: '永久删除 reports/' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '需要你确认' })).toBeNull();
  });

  it('closes the drawer when only high-risk remains', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => { channels['approval'](writeProposal()); });
    act(() => { channels['approval'](highProposal()); });
    const panel = screen.getByRole('dialog', { name: '需要你确认' });
    fireEvent.click(within(panel).getByText('允许'));
    expect(screen.queryByRole('dialog', { name: '需要你确认' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '永久删除 reports/' })).toBeTruthy();
  });

  it('shows only the first high-risk modal until it is decided', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => { channels['approval'](highProposal({ id: 'h1', summary: '永久删除 A' })); });
    act(() => { channels['approval'](highProposal({ id: 'h2', summary: '永久删除 B' })); });
    expect(screen.getByRole('dialog', { name: '永久删除 A' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '永久删除 B' })).toBeNull();
    fireEvent.click(screen.getByText('允许'));
    fireEvent.click(screen.getByText('再次确认允许'));
    expect(screen.getByRole('dialog', { name: '永久删除 B' })).toBeTruthy();
  });
});
