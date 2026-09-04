import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

afterEach(cleanup);

function localSubject(username: string) {
  return { userId: username, roles: ['admin', 'reviewer'] as const };
}

describe('local subject', () => {
  it('grants full roles without login', () => {
    expect(localSubject('alice').roles).toEqual(['admin', 'reviewer']);
  });
});

const HOME = {
  page: 'contract-review/home',
  layout: { type: 'grid', columns: 2 },
  widgets: [
    { id: 'upload', type: 'file-upload', bind: 'documents' },
    { id: 'review', type: 'action-button', action: 'run-workflow:contract-review' },
    { id: 'risk', type: 'table', bind: 'workflow.result.compare' },
    { id: 'report', type: 'doc-preview', bind: 'workflow.result.report' },
    { id: 'export', type: 'action-button', action: 'export-report' },
  ],
};

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
    getProfile: vi.fn().mockResolvedValue({ pages: { home: HOME } }),
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
    chooseDocument: vi.fn().mockResolvedValue({ path: 'C:/tmp/contract.pdf' }),
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
    runWorkflow: vi.fn().mockResolvedValue({ ok: true, sessionId: 'ws1' }),
    setChatTitle: vi.fn().mockResolvedValue({ ok: true }),
    openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
    listChatSessions: vi.fn().mockResolvedValue([]),
    deleteChatSession: vi.fn().mockResolvedValue({ ok: true }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    getChatSession: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'g1', behavior: 'prompt' }),
    exportReport: vi.fn(),
    requestExportReport: vi.fn().mockResolvedValue({ ok: true, approved: true }),
    updateWorkflowState: vi.fn().mockResolvedValue({ ok: true }),
    prompt: vi.fn().mockResolvedValue({ ok: true }),
    decideApproval: vi.fn(),
    queryAudit: vi.fn().mockResolvedValue([]),
    getRuntimePool: vi.fn().mockResolvedValue({ maxAgents: 4, active: 0, queued: 1, slots: [], queue: [{ queueId: 'q1', profileId: 'general', profileName: 'general', label: '新会话', position: 1 }] }),
    abortChat: vi.fn().mockResolvedValue({ ok: true }),
    releaseSessionSlot: vi.fn().mockResolvedValue({ ok: true }),
    cancelQueuedSession: vi.fn().mockResolvedValue({ ok: true }),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App workflow feedback', () => {
  it('inserts a workflow session when session_title arrives', async () => {
    const { api, channels } = makeApi();
    api.listChatSessions = vi.fn().mockResolvedValue([]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-contract-review'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    expect(screen.queryByText('更换文件')).toBeNull();
    fireEvent.click(screen.getByTestId('review'));
    await waitFor(() => expect(api.runWorkflow).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => channels['chat-event']({ type: 'session_title', sessionId: 'ws1', title: '采购合同' }));
    expect(await screen.findByText('采购合同')).toBeTruthy();
    expect(screen.getByTestId('session-ws1').className).toMatch(/current/);
  });

  it('groups workflow sessions under contract-review', async () => {
    const { api } = makeApi();
    api.listChatSessions = vi.fn().mockResolvedValue([{ id: 'pi-workflow-1', title: '采购合同', updatedAt: 1 }]);
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    expect(await screen.findByText('采购合同')).toBeTruthy();
  });

  it('shows workflow status from chat-event entries', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    // 以 OS 用户作为单一本地主体,直接进入工作台首页
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-contract-review'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    expect(screen.queryByText('更换文件')).toBeNull();
    fireEvent.click(screen.getByTestId('review'));
    expect(api.runWorkflow).toHaveBeenCalledWith('contract-review', expect.objectContaining({ documents: ['C:/tmp/contract.pdf'] }));
    // 让 runWorkflow 解析出 sessionId，useAgentSession 重新订阅到该会话
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => channels['chat-event']({
      sessionId: 'ws1',
      type: 'entry_appended',
      entry: { type: 'custom', id: 'c1', customType: 'workflow_step_start', data: { stepId: 'load' } },
    }));
    expect(screen.getByText('审核中：load')).toBeTruthy();
    act(() => channels['chat-event']({
      sessionId: 'ws1',
      type: 'entry_appended',
      entry: { type: 'custom', id: 'c2', customType: 'workflow_step_end', data: { stepId: 'load', status: 'completed' } },
    }));
    expect(screen.getByText('审核完成')).toBeTruthy();
  });

  it('derives agent status from the runtime pool snapshot', async () => {
    const { channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    act(() => channels['runtime-pool']({
      maxAgents: 4,
      active: 1,
      queued: 1,
      slots: [{ slotId: 'slot-1', sessionId: 's1', profileId: 'general', profileName: 'general', label: '会话#1', status: 'streaming', startedAt: 1 }],
      queue: [{ queueId: 'q1', profileId: 'contract-review', profileName: 'contract-review', label: '新会话', position: 1 }],
    }));
    expect(screen.getByText(/运行 1\/4 · 1 排队/)).toBeTruthy();
  });

  it('exports findings count from review step output', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-contract-review'));
    await screen.findByTestId('review');
    fireEvent.click(screen.getByTestId('upload'));
    await screen.findByTestId('remove-document');
    fireEvent.click(screen.getByTestId('review'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => channels['chat-event']({
      sessionId: 'ws1',
      type: 'entry_appended',
      entry: {
        type: 'custom',
        id: 'c1',
        customType: 'workflow_step_end',
        data: {
          stepId: 'review',
          status: 'completed',
          output: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high' }] },
        },
      },
    }));
    act(() => channels['chat-event']({
      sessionId: 'ws1',
      type: 'entry_appended',
      entry: {
        type: 'custom',
        id: 'c2',
        customType: 'workflow_step_end',
        data: {
          stepId: 'report',
          status: 'completed',
          output: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] },
        },
      },
    }));
    fireEvent.click(screen.getByText('合并到报告'));
    act(() => channels['chat-event']({
      sessionId: 'ws1',
      type: 'entry_appended',
      entry: {
        type: 'custom',
        id: 'c3',
        customType: 'workflow_state',
        data: { stepId: 'report', action: 'report_merged' },
      },
    }));
    fireEvent.click(screen.getByText('导出报告'));
    await waitFor(() => {
      expect(api.requestExportReport).toHaveBeenCalledWith('ws1', expect.objectContaining({
        title: '合同审核报告',
        content: expect.stringMatching(/^UEs/),
      }));
    });
    expect(api.requestExportReport.mock.calls[0][1].html).toBeUndefined();
  });

  it('highlights only the opened contract history row', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([
      { id: 'c1', profileId: 'contract-review', title: '合同 A', updatedAt: 2 },
      { id: 'g1', profileId: 'general', title: '通用旧会话', updatedAt: 1 },
    ]);
    api.openChatSession.mockResolvedValue({ entries: [] });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(await screen.findByText('合同 A'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('c1'));
    expect(screen.getByTestId('session-c1').className).toMatch(/current/);
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
  });

  it('clears the only highlight when opening a new general session', async () => {
    const { api } = makeApi();
    api.listChatSessions.mockResolvedValue([
      { id: 'c1', profileId: 'contract-review', title: '合同 A', updatedAt: 2 },
      { id: 'g1', profileId: 'general', title: '通用旧会话', updatedAt: 1 },
    ]);
    api.openChatSession.mockResolvedValue({ entries: [] });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(await screen.findByText('合同 A'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('c1'));
    expect(screen.getByTestId('session-c1').className).toMatch(/current/);
    fireEvent.click(screen.getByTestId('agent-nav-general'));
    await screen.findByTestId('composer-input');
    expect(screen.getByTestId('session-c1').className).not.toMatch(/current/);
    expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
  });

  it('returns to an empty live workspace after deleting the current contract session', async () => {
    const { api } = makeApi();
    let remaining = [{ id: 'c1', profileId: 'contract-review', title: '合同 A', updatedAt: 2 }];
    api.listChatSessions.mockImplementation(async () => remaining);
    api.openChatSession.mockResolvedValue({ entries: [] });
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(await screen.findByText('合同 A'));
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('c1'));
    fireEvent.contextMenu(screen.getByTestId('session-c1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /删除/ }));
    remaining = [];
    await waitFor(() => expect(api.deleteChatSession).toHaveBeenCalledWith('c1'));
    await screen.findByTestId('review');
    await waitFor(() => expect(screen.queryByTestId('session-c1')).toBeNull());
  });
});
