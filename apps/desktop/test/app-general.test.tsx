import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { App, sessionDisplayName, orderSessions } from '../src/App.js';

afterEach(cleanup);

describe('sessionDisplayName', () => {
  it('prefers title, then firstMessage, then time, then a default', () => {
    expect(sessionDisplayName({ title: 'PRD 标题', firstMessage: 'x', updatedAt: 1 })).toBe('PRD 标题');
    expect(sessionDisplayName({ firstMessage: '帮我写一个合同审核流程' })).toBe('帮我写一个合同审核流程'.slice(0, 20));
    expect(sessionDisplayName({ firstMessage: 'a'.repeat(30) })).toBe('a'.repeat(20));
    expect(sessionDisplayName({ title: '很长的标题'.repeat(5), firstMessage: 'x' })).toBe('很长的标题'.repeat(5));
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
    getLocalSubject: vi.fn().mockResolvedValue({ userId: 'admin', roles: ['admin', 'reviewer'] }),
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
    chooseDocument: vi.fn().mockResolvedValue({}),
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
    listChatSessions: vi.fn().mockResolvedValue([{ id: 'g1', profileId: 'general', title: '会话 08-25 17:10', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710', model: null, piSessionFile: null, createdAt: 0, updatedAt: 0 }]),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710', workspaceKind: 'auto' }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [] }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'g1', behavior: 'prompt' }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true, steering: [], followUp: [] }),
    setChatTitle: vi.fn(async (sessionId: string, title: string) => {
      channels['chat-event']?.({ type: 'session_title', sessionId, title });
      return { ok: true };
    }),
    completeText: vi.fn().mockResolvedValue({ ok: false }),
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
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalledWith(null, '你好', undefined, undefined, expect.any(Object)));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ sessionId: 'g1', type: 'message', role: 'assistant', delta: '在的' }));
    expect(screen.getByText(/在的/)).toBeTruthy();
  });

  it('clicking the general agent in the nav opens a new conversation', async () => {
    makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);

    fireEvent.click(screen.getByTestId('agent-nav-general'));
    await screen.findByTestId('composer-input');
    await screen.findByTestId('composer-input');
  });

  it('shows an error when the first draft prompt fails', async () => {
    const { api } = makeApi();
    api.promptSession.mockRejectedValueOnce(new Error('session create failed'));
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);

    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('session create failed');
  });

  it('deletes the active session and returns to empty state', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ type: 'message', role: 'user', text: '你好', sessionId: 'g1' }));
    await waitFor(() => expect(screen.getByTestId('session-g1')).toBeTruthy());
    fireEvent.contextMenu(await screen.findByTestId('session-g1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }));
    await waitFor(() => expect(api.deleteChatSession).toHaveBeenCalledWith('g1'));
    await screen.findByTestId('composer-input');
  });

  it('opens a selected session from the chat history list', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([
      { id: 'g1', profileId: 'general', title: '旧会话', workspaceKind: 'auto', workspacePath: 'C:/ws/old', model: null, piSessionFile: null, createdAt: 0, updatedAt: 1 },
      { id: 'g2', profileId: 'general', title: '另一个会话', workspaceKind: 'auto', workspacePath: 'C:/ws/new', model: null, piSessionFile: null, createdAt: 0, updatedAt: 2 },
    ]);
    api.openChatSession.mockImplementation(async (sessionId: string) => ({
      messages: sessionId === 'g1' ? [{ role: 'user', text: '历史消息' }] : [],
    }));

    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByTestId('composer-input');
    fireEvent.click(await screen.findByText('旧会话'));

    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    expect(await screen.findByText('历史消息')).toBeTruthy();
    expect(screen.getByTestId('session-g1').className).toMatch(/current/);
    expect(screen.getByTestId('session-g2').className).not.toMatch(/current/);
  });

  it('reloads a history session after leaving to home', async () => {
    const { api, channels } = makeApi();
    let opened = 0;
    api.openChatSession.mockImplementation(async () => {
      opened += 1;
      return opened === 1
        ? { messages: [] }
        : { messages: [{ role: 'assistant', text: '在的' }] };
    });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalledWith(null, '你好', undefined, undefined, expect.any(Object)));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ sessionId: 'g1', type: 'message', role: 'assistant', delta: '在的' }));
    expect(screen.getByText(/在的/)).toBeTruthy();

    fireEvent.click(screen.getByText('Sparkii'));
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
    expect(screen.getByText(/工作台 · 上午好/)).toBeTruthy();
    const opensBeforeReturn = api.openChatSession.mock.calls.length;
    fireEvent.click(await screen.findByTestId('session-g1'));
    await waitFor(() => expect(api.openChatSession.mock.calls.length).toBeGreaterThan(opensBeforeReturn));
    expect(await screen.findByText(/在的/)).toBeTruthy();
    expect(screen.getByTestId('session-g1').className).toMatch(/current/);
  });

  it('keeps a brand-new session visible even before the backend persists it', async () => {
    const { api, channels } = makeApi();
    api.listChatSessions.mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ type: 'session_title', sessionId: 'g1', title: '你好' }));
    expect(screen.getByTestId('session-g1')).toBeTruthy();
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0);
  });

  it('lets the general agent publish a placeholder title onto the sidebar', async () => {
    const { api, channels } = makeApi();
    api.listChatSessions.mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ type: 'message', role: 'user', text: '你好', sessionId: 'g1' }));
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '你好', 'agent'));
    expect(await screen.findByTestId('session-g1')).toBeTruthy();
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0);
  });

  it('does not insert a sidebar row from openSession alone', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([]);
    api.setChatTitle = vi.fn().mockResolvedValue({ ok: true });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '你好', 'agent'));
    expect(screen.queryByTestId('session-g1')).toBeNull();
  });

  it('inserts a sidebar row when session_title arrives for the bound session', async () => {
    const { api, channels } = makeApi();
    api.listChatSessions.mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    act(() => channels['chat-event']({ type: 'session_title', sessionId: 'g1', title: '占位名' }));
    expect(await screen.findByTestId('session-g1')).toBeTruthy();
    expect(screen.getAllByText('占位名').length).toBeGreaterThan(0);
    expect(screen.getByTestId('session-g1').className).toMatch(/current/);
  });

  it('inserts a titled session on home without highlighting it', async () => {
    const { api, channels } = makeApi();
    api.listChatSessions.mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    fireEvent.click(screen.getByText('Sparkii'));
    act(() => channels['chat-event']({ type: 'session_title', sessionId: 'g1', title: '占位名' }));
    expect(await screen.findByTestId('session-g1')).toBeTruthy();
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
  });

  it('publishes a placeholder after leaving before promptSession returns', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([
      { id: 'old', profileId: 'general', title: '旧会话', workspaceKind: 'auto', workspacePath: 'C:/ws/x', model: null, piSessionFile: null, createdAt: 0, updatedAt: 1 },
    ]);
    let finish!: (value: { ok: boolean; sessionId: string }) => void;
    api.promptSession.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '新开的一句' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('旧会话'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('old'));
    await act(async () => { finish({ ok: true, sessionId: 'g-new' }); });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g-new', '新开的一句', 'agent'));
    expect(await screen.findByTestId('session-g-new')).toBeTruthy();
    expect(screen.getByTestId('session-g-new').className).not.toMatch(/current/);
    expect(screen.getByTestId('session-old').className).toMatch(/current/);
  });

  it('renames a session and updates the history list immediately', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([{ id: 'g1', profileId: 'general', title: '旧标题', workspaceKind: 'auto', workspacePath: 'C:/ws/x', model: null, piSessionFile: null, createdAt: 0, updatedAt: 1 }]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByTestId('composer-input');
    fireEvent.click(await screen.findByText('旧标题'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    fireEvent.contextMenu(screen.getByTestId('session-g1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /重命名/ }));
    const input = screen.getByDisplayValue('旧标题');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '新标题', 'user'));
    // 后端仍返回旧标题，但左侧历史应立即显示新标题
    expect(screen.getAllByText('新标题').length).toBeGreaterThan(0);
  });

  it('keeps the generated session title after a refresh', async () => {
    const { api, channels } = makeApi();
    let persisted = false;
    api.listChatSessions.mockImplementation(async () =>
      persisted
        ? [{ id: 'g1', profileId: 'general', title: '优胜美地山谷全景赏析', firstMessage: '你好', updatedAt: 1 }]
        : [],
    );
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));

    persisted = true;
    act(() => channels['chat-event']({ type: 'session_title', sessionId: 'g1', title: '优胜美地山谷全景赏析' }));
    expect((await screen.findAllByText('优胜美地山谷全景赏析')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('agent-nav-general'));
    await waitFor(() => expect(screen.getByTestId('session-g1').textContent).toContain('优胜美地山谷全景赏析'));
  });

  it('resets the chat title to 新对话 on the first new-session click after opening history', async () => {
    const { api } = makeApi();
    const history = [
      { id: 'g1', profileId: 'general', title: '历史绘画标题', workspaceKind: 'auto', workspacePath: 'C:/ws/old', model: null, piSessionFile: null, createdAt: 0, updatedAt: 1 },
    ];
    api.listChatSessions.mockResolvedValue(history);
    api.openChatSession.mockResolvedValue({ messages: [{ role: 'user', text: '历史消息' }] });

    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByTestId('composer-input');
    fireEvent.click(await screen.findByText('历史绘画标题'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    expect((await screen.findByTestId('chat-title')).textContent).toBe('历史绘画标题');

    const callsBefore = api.listChatSessions.mock.calls.length;
    fireEvent.click(screen.getByTestId('agent-nav-general'));
    await waitFor(() => expect(api.listChatSessions.mock.calls.length).toBeGreaterThan(callsBefore));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('chat-title').textContent).toBe('新对话');
    expect(screen.getByTestId('session-g1').textContent).toContain('历史绘画标题');
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
  });

  it('clears highlight on settings and on a new home-card session', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([
      { id: 'g1', profileId: 'general', title: '旧会话', workspaceKind: 'auto', workspacePath: 'C:/ws/old', model: null, piSessionFile: null, createdAt: 0, updatedAt: 1 },
    ]);
    api.openChatSession.mockResolvedValue({ messages: [{ role: 'user', text: '历史消息' }] });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(await screen.findByText('旧会话'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('g1'));
    expect(screen.getByTestId('session-g1').className).toMatch(/current/);

    fireEvent.click(screen.getByLabelText('设置'));
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);

    fireEvent.click(screen.getByText('Sparkii'));
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByTestId('composer-input');
    expect(screen.getByTestId('chat-title').textContent).toBe('新对话');
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
  });

  it('reports a main-process runtime_error once, reusing its errorId', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => channels['chat-event']({
      type: 'runtime_error',
      sessionId: 'wf-1',
      message: '步骤记录写入失败（review）：disk full',
      errorId: 'err-1',
      source: '合同审核智能体',
    }));
    expect((await screen.findByRole('alert')).textContent).toContain('步骤记录写入失败');
    await waitFor(() => expect(api.appendError).toHaveBeenCalledTimes(1));
    expect(api.appendError).toHaveBeenCalledWith(expect.objectContaining({ id: 'err-1', source: '合同审核智能体' }));

    // 同一条重放不再多出一行
    act(() => channels['chat-event']({
      type: 'runtime_error',
      sessionId: 'wf-1',
      message: '步骤记录写入失败（review）：disk full',
      errorId: 'err-1',
      source: '合同审核智能体',
    }));
    fireEvent.click(screen.getByLabelText(/报错中心/));
    expect(screen.getAllByText('步骤记录写入失败（review）：disk full')).toHaveLength(1);
  });

  it('ignores a Pi runtime_error without errorId at the App level', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => channels['chat-event']({ type: 'runtime_error', sessionId: 'g1', message: 'api rate limit' }));
    await act(async () => { await Promise.resolve(); });
    expect(api.appendError).not.toHaveBeenCalled();
  });
});

describe('orderSessions', () => {
  it('puts a brand-new session (no manual order) first, before manually ordered ones', () => {
    const ordered = orderSessions([
      { id: 'a', name: 'A', state: '', updatedAt: 100, sortOrder: 0 } as any,
      { id: 'b', name: 'B', state: '', updatedAt: 50, sortOrder: 1 } as any,
      { id: 'new', name: 'New', state: '', updatedAt: 200, sortOrder: null } as any,
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['new', 'a', 'b']);
  });

  it('orders untouched sessions by time, newest first', () => {
    const ordered = orderSessions([
      { id: 'a', name: 'A', state: '', updatedAt: 100, sortOrder: null } as any,
      { id: 'b', name: 'B', state: '', updatedAt: 200, sortOrder: null } as any,
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('keeps manual drag order below recency-ordered sessions', () => {
    const ordered = orderSessions([
      { id: 'a', name: 'A', state: '', updatedAt: 999, sortOrder: null } as any,
      { id: 'b', name: 'B', state: '', updatedAt: 1, sortOrder: 0 } as any,
      { id: 'c', name: 'C', state: '', updatedAt: 2, sortOrder: 1 } as any,
    ]);
    // 未手动排序的 a 按时间在前；已拖拽的 b、c 按自定义顺序在后
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps pinned sessions on top of the default order (sticky pin)', () => {
    const ordered = orderSessions([
      { id: 'old', name: 'Old', state: '', updatedAt: 100, sortOrder: null, pinned: true } as any,
      { id: 'new1', name: 'New1', state: '', updatedAt: 300, sortOrder: null } as any,
      { id: 'new2', name: 'New2', state: '', updatedAt: 200, sortOrder: null } as any,
    ]);
    // 置顶的 old 在最前，即使新建的 new1/new2 时间更新
    expect(ordered.map((s) => s.id)).toEqual(['old', 'new1', 'new2']);
  });
});
