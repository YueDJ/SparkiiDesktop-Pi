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
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
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
    runWorkflow: vi.fn().mockResolvedValue({ ok: true, sessionId: 'ws1' }),
    openChatSession: vi.fn().mockResolvedValue({ entries: [] }),
    listChatSessions: vi.fn().mockResolvedValue([]),
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
    await screen.findByText('更换文件');
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
    await screen.findByText('更换文件');
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
});
