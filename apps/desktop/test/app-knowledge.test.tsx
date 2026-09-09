import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
      { id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } },
    ]),
    chooseDocument: vi.fn().mockResolvedValue({}),
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
    listChatSessions: vi.fn().mockResolvedValue([]),
    getChatSession: vi.fn().mockResolvedValue({}),
    openChatSession: vi.fn().mockResolvedValue({ entries: [], streamingMessage: null, streaming: false }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    getSettings: vi.fn().mockResolvedValue({
      chatDetailLevel: 'standard',
      rag: { bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'hr' }] },
    }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'k1', behavior: 'prompt' }),
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
    listRagDatasets: vi.fn().mockResolvedValue({
      ok: true,
      datasets: [{ id: 'hr', name: '制度库' }],
    }),
    setSessionKnowledge: vi.fn().mockResolvedValue({ ok: true }),
    listAgentSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getPathForFile: vi.fn(),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App knowledge-qa history', () => {
  it('inserts a sidebar row after sending the first message', async () => {
    const { api } = makeApi();
    render(<App />);
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-knowledge-qa'));
    await waitFor(() => expect(screen.getByTestId('knowledge-dataset-select')).toBeTruthy());
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '汕昆高速的概括' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('k1', '汕昆高速的概括', 'agent'));
    expect(await screen.findByTestId('session-k1')).toBeTruthy();
    expect(screen.getAllByText('汕昆高速的概括').length).toBeGreaterThan(0);
  });
});
