import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { StandardChatSurface } from '../src/surface/standard-chat.js';
import { applyChatEvent, normalizeMessages, ErrorProvider, createMemoryErrorStore } from '@sparkii/ui';
import type { ChatEntry } from '@sparkii/ui';

afterEach(cleanup);

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [{ role: 'user', text: 'hi' }] }),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710' }),
    getChatMessages: vi.fn().mockResolvedValue([]),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off', 'medium', 'high']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/user-ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getPathForFile: vi.fn((file: File) => `C:/downloads/${file.name}`),
  };
  return { api: api as any, channels };
}

const baseProps = (sessionId: string | null, over: Record<string, unknown> = {}) => ({
  agent: { id: 'general', name: '通用智能体', surfaceType: 'chat' },
  sessionId,
  mode: 'live' as const,
  session: { entries: [], streaming: false, meta: {} },
  actions: {
    newSession: vi.fn(),
    openSession: vi.fn(),
    startWorkflow: vi.fn(),
    review: vi.fn(),
    requestExport: vi.fn(),
    chooseDocument: vi.fn().mockResolvedValue({}),
  },
  ...over,
});

describe('StandardChatSurface (contract)', () => {
  beforeEach(() => {
    (globalThis as any).window.sparkii = makeApi().api;
  });

  it('renders history messages from session entries and prompts with sessionId', async () => {
    const { api, channels } = makeApi();
    (globalThis as any).window.sparkii = api;
    const session = { entries: [{ kind: 'message', id: 'm0', role: 'user', text: 'hi', streaming: false }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { session })} />);
    await screen.findByText('hi');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(api.promptSession).toHaveBeenCalledWith('s1', '请创建 hello.txt', undefined, undefined, undefined);
    expect(api.openChatSession).not.toHaveBeenCalled();
  });

  it('shows the draft composer when sessionId is null and draft is set', () => {
    render(<StandardChatSurface {...baseProps(null, { draft: true })} />);
    expect(screen.getByTestId('composer-input')).toBeTruthy();
  });

  it('renders the empty state when no session and not a draft and calls newSession', () => {
    const actions = baseProps(null).actions;
    render(<StandardChatSurface {...baseProps(null, { actions })} />);
    expect(screen.getByText('新建会话')).toBeTruthy();
    fireEvent.click(screen.getByText('新建会话'));
    expect(actions.newSession).toHaveBeenCalled();
  });
});

describe('applyChatEvent (pi-timeline)', () => {
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

  it('streams thinking deltas then finalizes thinking and text', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', thinkingDelta: '想' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', thinkingDelta: '考' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', text: '答案', thinking: '思考' });
    expect(entries).toEqual([{ kind: 'message', id: entries[0].id, role: 'assistant', text: '答案', thinking: '思考', streaming: false }]);
  });
});

describe('normalizeMessages (pi-timeline)', () => {
  it('maps user/assistant text messages', () => {
    const out = normalizeMessages([{ role: 'user', text: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }]);
    expect(out.map((e) => (e.kind === 'message' ? e.role : null))).toEqual(['user', 'assistant']);
  });
  it('extracts thinking content from assistant messages', () => {
    const out = normalizeMessages([{ role: 'assistant', content: [{ type: 'thinking', thinking: '想想' }, { type: 'text', text: '回答' }] }]);
    expect(out).toEqual([{ kind: 'message', id: 'm0', role: 'assistant', text: '回答', thinking: '想想', streaming: false }]);
  });
});

describe('StandardChatSurface behaviors', () => {
  it('shows empty state and creates a session via newSession', async () => {
    const { api } = makeApi();
    const actions = baseProps(null).actions;
    render(<StandardChatSurface {...baseProps(null, { actions })} />);
    fireEvent.click(screen.getByText('新建会话'));
    expect(actions.newSession).toHaveBeenCalled();
  });

  it('passes attachments to promptSession when files are selected', async () => {
    const { api } = makeApi();
    const { container } = render(<StandardChatSurface {...baseProps('s1', { api })} />);
    const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '分析这个' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    expect(api.promptSession).toHaveBeenCalledWith(
      's1',
      '📎 report.pdf\n分析这个',
      undefined,
      [{ path: 'C:/downloads/report.pdf', name: 'report.pdf', size: 6, type: 'application/pdf' }],
      undefined,
    );
  });

  it('sends the attachment display text for the first draft message', async () => {
    const { api } = makeApi();
    const { container } = render(<StandardChatSurface {...baseProps(null, { draft: true, api })} />);
    const file = new File(['img'], 'photo.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '看这张图' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
    expect(api.promptSession).toHaveBeenCalledWith(
      null,
      '📎 photo.png\n看这张图',
      undefined,
      [{ path: 'C:/downloads/photo.png', name: 'photo.png', size: 3, type: 'image/png' }],
      expect.any(Object),
    );
  });

  it('warns when sending an image with a non-vision model', async () => {
    const { api } = makeApi();
    api.getModelOptions = vi.fn().mockResolvedValue({
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      provider: 'deepseek',
      supportsImages: { 'deepseek-v4-flash': false, 'deepseek-v4-flash-vision-exp': true },
    });
    const { container } = render(<StandardChatSurface {...baseProps('s1', { api })} />);
    await waitFor(() => expect(api.getModelOptions).toHaveBeenCalled());
    const file = new File(['img'], 'photo.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '看这张图' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(await screen.findByTestId('vision-warning')).toBeTruthy();
    expect(screen.getByText(/不支持图片输入/)).toBeTruthy();
    expect(api.promptSession).toHaveBeenCalled();
  });

  it('restores full Pi history entries and renders a compaction card', async () => {
    const { api } = makeApi();
    const session = {
      entries: [
        { kind: 'message', id: 'm1', role: 'user', text: 'hi', streaming: false },
        { kind: 'tool', id: 't1', toolName: 'bash', input: { command: 'ls' }, result: { content: [{ type: 'text', text: 'out' }] }, toolCallId: 'call_1' },
        { kind: 'event', id: 'ev1', event: 'compaction', label: '上下文压缩', detail: '已压缩较早内容 · 150000 tokens', status: 'info' },
      ],
      streaming: false,
      meta: {},
    };
    render(<StandardChatSurface {...baseProps('s1', { session })} />);
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
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    expect(await screen.findByTestId('context-bar')).toBeTruthy();
    expect(screen.getByText(/6%/)).toBeTruthy();
    expect(screen.getByText(/12,300/)).toBeTruthy();
  });

  it('refreshes model options after a provider change without forcing a null override', async () => {
    const { api } = makeApi();
    api.getModelOptions = vi.fn()
      .mockResolvedValueOnce({ defaultModel: 'k3', models: ['k3'], provider: 'kimi' })
      .mockResolvedValue({ defaultModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro'], provider: 'deepseek' });
    const view = render(<StandardChatSurface {...baseProps('s1', { active: true, api })} />);
    expect(await screen.findByText('k3')).toBeTruthy();
    view.rerender(<StandardChatSurface {...baseProps('s1', { active: false, api })} />);
    view.rerender(<StandardChatSurface {...baseProps('s1', { active: true, api })} />);
    await waitFor(() => expect(api.getModelOptions).toHaveBeenCalledTimes(2));
    expect(api.setChatModel).not.toHaveBeenCalled();
    expect(await screen.findByText('deepseek-v4-pro')).toBeTruthy();
  });

  it('clears an explicit session model when its provider no longer matches the active provider', async () => {
    const { api } = makeApi();
    api.getChatSession = vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/X', workspaceKind: 'auto', model: 'kimi/kimi-for-coding', thinkingLevel: null });
    api.getModelOptions = vi.fn().mockResolvedValue({ provider: 'deepseek', defaultModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] });
    render(<StandardChatSurface {...baseProps('s1', { active: true, api })} />);
    await waitFor(() => expect(api.setChatModel).toHaveBeenCalledWith('s1', null));
    expect(await screen.findByText('deepseek-v4-pro')).toBeTruthy();
  });

  it('marks a tool card awaiting approval from approval events', async () => {
    const { api, channels } = makeApi();
    const session = { entries: [{ kind: 'tool', id: 't1', toolName: 'write', input: { path: 'C:/ws/a.txt' } }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { session, api })} />);
    await screen.findByText('write');
    act(() => channels['approval']({ sessionId: 's1', toolName: 'write' }));
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });

  it('changes the thinking level through the composer', async () => {
    const { api } = makeApi();
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('思考强度'));
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    expect(api.setChatThinkingLevel).toHaveBeenCalledWith('s1', 'high');
  });

  it('shows the thinking process while streaming from session entries', async () => {
    const session = { entries: [{ kind: 'message', id: 'm1', role: 'assistant', text: '答案是 42', thinking: '让我想想', streaming: false }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { session })} />);
    expect(screen.getByText('让我想想')).toBeTruthy();
    expect(screen.getByText(/答案是 42/)).toBeTruthy();
  });

  it('renders Pi queue updates and promotes a follow-up item to steering', async () => {
    const { api, channels } = makeApi();
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'queue_update', steering: [], followUp: ['做完后整理'] }));
    expect(screen.getByText('做完后整理')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '引导' }));
    expect(api.queueMutate).toHaveBeenCalledWith('s1', { action: 'transfer', queue: 'followUp', index: 0, targetQueue: 'steering' });
  });

  it('renders a user message appended by Pi for steering or follow-up', async () => {
    const { api, channels } = makeApi();
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'user', text: '先检查一下结果' }));
    expect(screen.getByText('先检查一下结果')).toBeTruthy();
  });

  it('shows runtime errors pushed by Pi', async () => {
    const { api, channels } = makeApi();
    render(<ErrorProvider store={createMemoryErrorStore()}><StandardChatSurface {...baseProps('s1', { api })} /></ErrorProvider>);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'runtime_error', message: 'api rate limit', command: 'prompt' }));
    expect(screen.getByRole('alert').textContent).toContain('api rate limit');
  });

  it('hides model changes in standard detail level', async () => {
    const { api } = makeApi();
    const session = { entries: [{ kind: 'event', id: 'ev1', event: 'model_change', label: '模型切换', status: 'info' }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { session, api })} />);
    expect(screen.queryByText('模型切换')).toBeNull();
  });

  it('does not duplicate the local user message when Pi echoes the idle prompt', async () => {
    const { api, channels } = makeApi();
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'user', text: '请创建 hello.txt' }));
    expect(screen.getAllByText('请创建 hello.txt')).toHaveLength(1);
  });

  it('keeps each assistant reply below its triggering user message across turns', async () => {
    const { api, channels } = makeApi();
    const view = render(<StandardChatSurface {...baseProps('s1', { api, session: { entries: [], streaming: false, meta: {} } })} />);

    // Turn 1: user sends -> optimistic user message appears first.
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第一问' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });

    // Assistant reply arrives in the authoritative timeline.
    view.rerender(<StandardChatSurface {...baseProps('s1', {
      api,
      session: { entries: [{ kind: 'message', id: 'a1', role: 'assistant', text: '第一答', streaming: false }], streaming: false, meta: {} },
    })} />);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'agent_end' }));

    // Turn 2: user sends again (busy cleared by agent_end).
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第二问' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });

    view.rerender(<StandardChatSurface {...baseProps('s1', {
      api,
      session: {
        entries: [
          { kind: 'message', id: 'a1', role: 'assistant', text: '第一答', streaming: false },
          { kind: 'message', id: 'a2', role: 'assistant', text: '第二答', streaming: false },
        ],
        streaming: false,
        meta: {},
      },
    })} />);

    const order = Array.from(document.querySelectorAll('.ui-chat-message')).map((el) => el.textContent?.trim());
    expect(order).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });
});
