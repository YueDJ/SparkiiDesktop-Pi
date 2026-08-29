import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { GeneralChatSurface, applyChatEvent, normalizeMessages, type ChatEntry } from '../src/surfaces/GeneralChatSurface.js';

afterEach(cleanup);

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [{ role: 'user', text: 'hi' }] }),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710', workspaceKind: 'auto' }),
    getChatMessages: vi.fn().mockResolvedValue([]),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true, steering: [], followUp: [] }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off', 'medium', 'high']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/user-ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
  };
  return { api: api as any, channels };
}

describe('applyChatEvent', () => {
  it('appends streaming deltas and finalizes text', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', delta: 'Hel' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', delta: 'lo' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', text: 'Hello' });
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).text).toBe('Hello');
    expect((entries[0] as any).streaming).toBe(false);
  });

  it('pairs tool_call with tool_result and ignores user echo', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'user', text: 'x' });
    entries = applyChatEvent(entries, { type: 'tool_call', toolName: 'bash', input: { command: 'ls' } });
    entries = applyChatEvent(entries, { type: 'tool_result', toolName: 'bash', result: { exitCode: 0 } });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('tool');
    expect((entries[0] as any).result).toMatchObject({ exitCode: 0 });
  });
});

describe('normalizeMessages', () => {
  it('maps user/assistant text messages', () => {
    const out = normalizeMessages([{ role: 'user', text: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }]);
    expect(out.map((e) => (e.kind === 'message' ? e.role : null))).toEqual(['user', 'assistant']);
  });
  it('extracts thinking content from assistant messages', () => {
    const out = normalizeMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: '想想' }, { type: 'text', text: '回答' }] }]);
    expect(out).toEqual([{ kind: 'message', id: 'm0', role: 'assistant', text: '回答', thinking: '想想', streaming: false }]);
  });
});

describe('applyChatEvent thinking', () => {
  it('streams thinking deltas then finalizes thinking and text', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', thinkingDelta: '想' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', thinkingDelta: '考' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', text: '答案', thinking: '思考' });
    expect(entries).toEqual([{ kind: 'message', id: entries[0].id, role: 'assistant', text: '答案', thinking: '思考', streaming: false }]);
  });
});

describe('GeneralChatSurface', () => {
  it('shows empty state and creates a session via onNewSession', async () => {
    const { api } = makeApi();
    const onNewSession = vi.fn();
    render(<GeneralChatSurface api={api} sessionId={null} onNewSession={onNewSession} />);
    fireEvent.click(screen.getByText('新建会话'));
    expect(onNewSession).toHaveBeenCalled();
  });

  it('restores history and sends promptSession with sessionId', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('s1'));
    await screen.findByText('hi');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(api.promptSession).toHaveBeenCalledWith('s1', '请创建 hello.txt');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', delta: '收到' }));
    expect(screen.getByText(/收到/)).toBeTruthy();
  });

  it('restores full Pi history entries and renders a compaction card', async () => {
    const { api } = makeApi();
    api.openChatSession = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', text: 'hi' }],
      entries: [
        { type: 'message', message: { role: 'user', content: 'hi' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'out' }] } },
        { type: 'compaction', summary: '已压缩较早内容', firstKeptEntryId: 'call_1', tokensBefore: 150000 },
      ],
    });
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('bash')).toBeTruthy();
    expect(screen.getByText('上下文压缩')).toBeTruthy();
    expect(screen.getByText(/150000 tokens/)).toBeTruthy();
  });

  it('shows the Pi context usage bar from getChatState', async () => {
    const { api } = makeApi();
    api.getChatState = vi.fn().mockResolvedValue({
      streaming: false,
      steering: [],
      followUp: [],
      isCompacting: false,
      contextUsage: { tokens: 12300, contextWindow: 200000, percent: 6 },
    });
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    expect(await screen.findByTestId('context-bar')).toBeTruthy();
    expect(screen.getByText(/6%/)).toBeTruthy();
    expect(screen.getByText(/12,300/)).toBeTruthy();
  });

  it('refreshes model options after a provider change without forcing a null override', async () => {
    const { api } = makeApi();
    api.getModelOptions = vi.fn()
      .mockResolvedValueOnce({ defaultModel: 'k3', models: ['k3'], provider: 'kimi' })
      .mockResolvedValue({ defaultModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro'], provider: 'deepseek' });
    const view = render(<GeneralChatSurface api={api} sessionId="s1" active onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    expect(await screen.findByText('k3')).toBeTruthy();

    view.rerender(<GeneralChatSurface api={api} sessionId="s1" active={false} onNewSession={vi.fn()} />);
    view.rerender(<GeneralChatSurface api={api} sessionId="s1" active onNewSession={vi.fn()} />);

    await waitFor(() => expect(api.getModelOptions).toHaveBeenCalledTimes(2));
    expect(api.setChatModel).not.toHaveBeenCalled();
    expect(await screen.findByText('deepseek-v4-pro')).toBeTruthy();
  });

  it('clears an explicit session model when its provider no longer matches the active provider', async () => {
    const { api } = makeApi();
    api.getChatSession = vi.fn().mockResolvedValue({
      workspacePath: 'C:/ws/SparkiiXyZ9202608251710',
      workspaceKind: 'auto',
      model: 'kimi/kimi-for-coding',
      thinkingLevel: null,
    });
    api.getModelOptions = vi.fn().mockResolvedValue({
      provider: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      models: ['deepseek-v4-pro'],
    });

    render(<GeneralChatSurface api={api} sessionId="s1" active onNewSession={vi.fn()} />);

    await waitFor(() => expect(api.setChatModel).toHaveBeenCalledWith('s1', null));
    expect(await screen.findByText('deepseek-v4-pro')).toBeTruthy();
  });

  it('marks a tool card awaiting approval from approval events', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'tool_call', toolName: 'write', input: { path: 'C:/ws/a.txt' } }));
    act(() => channels['approval']({ sessionId: 's1', toolName: 'write' }));
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });

  it('changes the thinking level through the composer', async () => {
    const { api } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('思考强度'));
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    expect(api.setChatThinkingLevel).toHaveBeenCalledWith('s1', 'high');
  });

  it('shows the thinking process while streaming', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', thinkingDelta: '让我想想' }));
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', text: '答案是 42', thinking: '让我想想' }));
    expect(screen.getByText('让我想想')).toBeTruthy();
    expect(screen.getByText(/答案是 42/)).toBeTruthy();
  });

  it('renders Pi queue updates and promotes a follow-up item to steering', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');

    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'queue_update',
      steering: [],
      followUp: ['做完后整理'],
    }));
    expect(screen.getByText('做完后整理')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '引导' }));
    expect(api.queueMutate).toHaveBeenCalledWith('s1', {
      action: 'transfer',
      queue: 'followUp',
      index: 0,
      targetQueue: 'steering',
    });
  });

  it('renders a user message appended by Pi for steering or follow-up', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');

    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'message',
      role: 'user',
      text: '先检查一下结果',
    }));
    expect(screen.getByText('先检查一下结果')).toBeTruthy();
  });

  it('shows runtime errors pushed by Pi', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');

    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'runtime_error',
      message: 'api rate limit',
      command: 'prompt',
    }));
    expect(screen.getByRole('alert').textContent).toContain('api rate limit');
  });

  it('hides model changes in standard detail level', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'model_change',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }));

    expect(screen.queryByText('模型切换')).toBeNull();
  });

  it('does not duplicate the local user message when Pi echoes the idle prompt', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'message',
      role: 'user',
      text: '请创建 hello.txt',
    }));
    expect(screen.getAllByText('请创建 hello.txt')).toHaveLength(1);
  });
});
