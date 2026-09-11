import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup, act, screen, fireEvent } from '@testing-library/react';
import GeneralAgentSurface from '../agents/general/surface/index.js';
import { placeholderOf, shortTitlePrompt } from '../agents/general/surface/title.js';
import type { AgentSession } from '../src/surface/contract.js';
import { ApprovalInboxProvider } from '../src/trust/ApprovalInbox.js';

afterEach(() => {
  cleanup();
  delete (window as any).sparkii;
});

function makeApi(over: Record<string, unknown> = {}) {
  return {
    on: vi.fn(() => () => {}),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    decideApproval: vi.fn().mockResolvedValue({}),
    openChatSession: vi.fn().mockResolvedValue({ entries: [], streamingMessage: null, streaming: false }),
    getChatSession: vi.fn().mockResolvedValue({}),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off', 'medium', 'high']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({}),
    allocateAutoWorkspace: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    setChatTitle: vi.fn().mockResolvedValue({ ok: true }),
    completeText: vi.fn().mockResolvedValue({ ok: false }),
    ...over,
  };
}

const actions = {
  newSession: vi.fn(),
  openSession: vi.fn(),
  startWorkflow: vi.fn(),
  review: vi.fn(),
  requestExport: vi.fn(),
  chooseDocument: vi.fn().mockResolvedValue({}),
  readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
};

function session(entries: AgentSession['entries']): AgentSession {
  return { entries, streaming: false, meta: {} };
}

function renderGeneral(opts: {
  api: ReturnType<typeof makeApi>;
  sessionId?: string | null;
  title?: string;
  entries?: AgentSession['entries'];
}) {
  return render(
    <ApprovalInboxProvider api={opts.api as any}>
      <GeneralAgentSurface
        agent={{ id: 'general', name: '通用智能体', surfaceType: 'chat' }}
        sessionId={opts.sessionId === undefined ? 'g1' : opts.sessionId}
        mode="live"
        session={session(opts.entries ?? [])}
        actions={actions}
        title={opts.title}
        api={opts.api as any}
      />
    </ApprovalInboxProvider>,
  );
}

describe('GeneralAgentSurface titles', () => {
  it('publishes a placeholder from promptSession when the viewport never receives the id', async () => {
    const api = makeApi({
      promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'g-left' }),
    });
    render(
      <ApprovalInboxProvider api={api as any}>
        <GeneralAgentSurface
          agent={{ id: 'general', name: '通用智能体', surfaceType: 'chat' }}
          sessionId={null}
          mode="live"
          draft
          session={{ entries: [], streaming: false, meta: {} }}
          actions={actions}
          api={api as any}
        />
      </ApprovalInboxProvider>,
    );
    const input = await screen.findByTestId('composer-input');
    fireEvent.change(input, { target: { value: '你好世界' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g-left', '你好世界', 'agent'));
    expect(actions.openSession).toHaveBeenCalledWith('g-left');
  });

  it('publishes a placeholder title from the first user message', async () => {
    const api = makeApi();
    renderGeneral({
      api,
      entries: [{ kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false }],
    });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '你好', 'agent'));
    expect(api.completeText).not.toHaveBeenCalled();
  });

  it('asks for a short title after the first assistant reply while the placeholder is still showing', async () => {
    const api = makeApi({
      completeText: vi.fn().mockResolvedValue({ ok: true, text: '违约责任条款修改' }),
    });
    const userText = '帮我看看这份合同的违约责任条款怎么改';
    const assistantText = '建议把赔偿上限写清楚';
    renderGeneral({
      api,
      title: placeholderOf(userText),
      entries: [
        { kind: 'message', id: 'u1', role: 'user', text: userText, streaming: false },
        { kind: 'message', id: 'a1', role: 'assistant', text: assistantText, streaming: false },
      ],
    });
    await waitFor(() => expect(api.completeText).toHaveBeenCalledWith('g1', shortTitlePrompt(userText, assistantText)));
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '违约责任条款修改', 'agent'));
  });

  it('truncates a completed short title to 20 characters', async () => {
    const long = '这是一个非常非常长的短名应该被截断到二十个字以外';
    const api = makeApi({
      completeText: vi.fn().mockResolvedValue({ ok: true, text: long }),
    });
    renderGeneral({
      api,
      title: '你好',
      entries: [
        { kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false },
        { kind: 'message', id: 'a1', role: 'assistant', text: '在的', streaming: false },
      ],
    });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', long.slice(0, 20), 'agent'));
  });

  it('does not complete or rename when the user already changed the title', async () => {
    const api = makeApi({
      completeText: vi.fn().mockResolvedValue({ ok: true, text: '不该用' }),
    });
    renderGeneral({
      api,
      title: '用户改的',
      entries: [
        { kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false },
        { kind: 'message', id: 'a1', role: 'assistant', text: '在的', streaming: false },
      ],
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(api.completeText).not.toHaveBeenCalled();
    expect(api.setChatTitle).not.toHaveBeenCalled();
  });

  it('keeps the placeholder when completeText fails', async () => {
    const api = makeApi({
      completeText: vi.fn().mockResolvedValue({ ok: false }),
    });
    const { rerender } = renderGeneral({
      api,
      entries: [{ kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false }],
    });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('g1', '你好', 'agent'));

    rerender(
      <ApprovalInboxProvider api={api as any}>
        <GeneralAgentSurface
          agent={{ id: 'general', name: '通用智能体', surfaceType: 'chat' }}
          sessionId="g1"
          mode="live"
          session={session([
            { kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false },
            { kind: 'message', id: 'a1', role: 'assistant', text: '在的', streaming: false },
          ])}
          actions={actions}
          title="你好"
          api={api as any}
        />
      </ApprovalInboxProvider>,
    );
    await waitFor(() => expect(api.completeText).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(api.setChatTitle).toHaveBeenCalledTimes(1);
    expect(api.setChatTitle).toHaveBeenCalledWith('g1', '你好', 'agent');
  });

  it('projects approval_required onto the tool card', async () => {
    const api = makeApi();
    renderGeneral({
      api,
      entries: [
        { kind: 'tool', id: 't1', toolName: 'write', input: { path: 'a.ts' }, toolCallId: 'c1' },
        {
          kind: 'custom',
          id: 'e1',
          customType: 'approval_required',
          data: { requestId: 'r1', toolName: 'write', status: 'pending', toolCallId: 'c1' },
        },
      ],
    });
    expect(await screen.findByText(/等待审批/)).toBeTruthy();
  });

  it('renders an inline approval card under the awaiting tool card', async () => {
    const api = makeApi({
      listPendingApprovals: vi.fn().mockResolvedValue([
        {
          id: 'p1', requestId: 'r1', sessionId: 'g1', risk: 'write', status: 'pending',
          summary: '写入 a.ts', toolName: 'write', targetSystem: 'general', payload: {}, payloadHash: 'h',
          profileId: 'general', createdAt: Date.now(),
        },
      ]),
    });
    renderGeneral({
      api,
      entries: [
        { kind: 'tool', id: 't1', toolName: 'write', input: { path: 'a.ts' }, toolCallId: 'c1' },
        {
          kind: 'custom',
          id: 'e1',
          customType: 'approval_required',
          data: { requestId: 'r1', toolName: 'write', status: 'pending', toolCallId: 'c1' },
        },
      ],
    });
    expect(await screen.findByTestId('approval-queue-item')).toBeTruthy();
    expect(screen.getByText('等待审批')).toBeTruthy();
    expect(screen.getByText('写入 a.ts')).toBeTruthy();
  });
});
