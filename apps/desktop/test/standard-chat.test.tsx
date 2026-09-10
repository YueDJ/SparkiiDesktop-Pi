import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { StandardChatSurface } from '../src/surface/standard-chat.js';
import { applyChatEvent, normalizeMessages, ErrorProvider, createMemoryErrorStore } from '@sparkii/ui';
import type { ChatEntry } from '@sparkii/ui';

afterEach(cleanup);

function typeDraft(input: HTMLElement, value: string, cursor = value.length) {
  fireEvent.change(input, { target: { value, selectionStart: cursor, selectionEnd: cursor } });
  (input as HTMLTextAreaElement).setSelectionRange(cursor, cursor);
  fireEvent.select(input);
}

function makeApi(over: Record<string, unknown> = {}) {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    openChatSession: vi.fn().mockResolvedValue({
      entries: [{ type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }],
      streamingMessage: null,
      streaming: false,
    }),
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
    listAgentSkills: vi.fn().mockResolvedValue({ skills: [] }),
    ...over,
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
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
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
  it('replaces the streaming slot on each tick and finalizes text', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message_start', message: { role: 'assistant', content: [] } });
    entries = applyChatEvent(entries, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] } });
    entries = applyChatEvent(entries, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    entries = applyChatEvent(entries, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).text).toBe('Hello');
    expect((entries[0] as any).streaming).toBe(false);
  });

  it('pairs the tool execution triple and keeps the user bubble', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } });
    entries = applyChatEvent(entries, { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c1', args: { command: 'ls' } });
    entries = applyChatEvent(entries, { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c1', result: { exitCode: 0 } });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'message', role: 'user', text: 'x' });
    expect(entries[1].kind).toBe('tool');
    expect((entries[1] as any).result).toMatchObject({ exitCode: 0 });
  });

  it('carries thinking and text from the full message on every tick', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message_start', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想' }] } });
    entries = applyChatEvent(entries, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }] } });
    entries = applyChatEvent(entries, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '答案' }] },
    });
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

  it('does not warn when the stored model is provider-prefixed but compatible', async () => {
    const { api } = makeApi();
    api.getChatSession = vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/X', model: 'deepseek/deepseek-v4-flash', thinkingLevel: null });
    api.getModelOptions = vi.fn().mockResolvedValue({
      provider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-vision'],
      compatibleModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      supportsImages: { 'deepseek-v4-flash': false },
    });
    render(<StandardChatSurface {...baseProps('s1', { api })} />);
    await waitFor(() => expect(api.getChatSession).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '你好' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(screen.queryByTestId('model-warning')).toBeNull();
  });

  it('shows awaiting approval from the session entry, not from approval IPC', async () => {
    const { api } = makeApi();
    const session = {
      entries: [{ kind: 'tool', id: 't1', toolName: 'write', input: { path: 'C:/ws/a.txt' }, awaitingApproval: true }],
      streaming: false,
      meta: {},
    };
    render(<StandardChatSurface {...baseProps('s1', { session, api })} />);
    expect(await screen.findByText(/等待审批/)).toBeTruthy();
  });

  it('does not subscribe to approval events for the tool card', async () => {
    const { api } = makeApi();
    const session = {
      entries: [{ kind: 'tool', id: 't1', toolName: 'write', input: { path: 'C:/ws/a.txt' }, result: { ok: true } }],
      streaming: false,
      meta: {},
    };
    render(<StandardChatSurface {...baseProps('s1', { session, api })} />);
    expect(await screen.findByText(/完成/)).toBeTruthy();
    expect(api.on.mock.calls.every((call: unknown[]) => call[0] !== 'approval')).toBe(true);
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
    const { api } = makeApi();
    const session = { entries: [{ kind: 'message', id: 'u9', role: 'user', text: '先检查一下结果', streaming: false }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { api, session })} />);
    expect(screen.getByText('先检查一下结果')).toBeTruthy();
  });

  it('shows runtime errors pushed by Pi', async () => {
    const { api, channels } = makeApi();
    render(<ErrorProvider store={createMemoryErrorStore()}><StandardChatSurface {...baseProps('s1', { api })} /></ErrorProvider>);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'runtime_error', message: 'api rate limit', command: 'prompt' }));
    expect(screen.getByRole('alert').textContent).toContain('api rate limit');
  });

  it('leaves a runtime_error that already has an errorId to the app-level error center', async () => {
    const { api, channels } = makeApi();
    render(<ErrorProvider store={createMemoryErrorStore()}><StandardChatSurface {...baseProps('s1', { api })} /></ErrorProvider>);
    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'runtime_error',
      message: '步骤记录写入失败（review）：disk full',
      errorId: 'err-1',
      source: '合同审核智能体',
    }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides model changes in standard detail level', async () => {
    const { api } = makeApi();
    const session = { entries: [{ kind: 'event', id: 'ev1', event: 'model_change', label: '模型切换', status: 'info' }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { session, api })} />);
    expect(screen.queryByText('模型切换')).toBeNull();
  });

  it('renders an echoed user message once from the single timeline', async () => {
    const { api } = makeApi();
    const session = { entries: [{ kind: 'message', id: 'u1', role: 'user', text: '请创建 hello.txt', streaming: false }], streaming: false, meta: {} };
    render(<StandardChatSurface {...baseProps('s1', { api, session })} />);
    expect(screen.getAllByText('请创建 hello.txt')).toHaveLength(1);
  });

  it('keeps each assistant reply below its triggering user message across turns', async () => {
    const { api } = makeApi();
    render(<StandardChatSurface {...baseProps('s1', {
      api,
      session: {
        entries: [
          { kind: 'message', id: 'u1', role: 'user', text: '第一问', streaming: false },
          { kind: 'message', id: 'a1', role: 'assistant', text: '第一答', streaming: false },
          { kind: 'message', id: 'u2', role: 'user', text: '第二问', streaming: false },
          { kind: 'message', id: 'a2', role: 'assistant', text: '第二答', streaming: false },
        ],
        streaming: false,
        meta: {},
      },
    })} />);

    const order = Array.from(document.querySelectorAll('.ui-chat-message')).map((el) => el.textContent?.trim());
    expect(order).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });

  it('keeps the user message and grows a streaming assistant reply from the single timeline', async () => {
    const { api } = makeApi();
    const baseSession = { entries: [{ kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false }], streaming: false, meta: {} };
    const view = render(<StandardChatSurface {...baseProps('s1', { api, session: baseSession })} />);
    expect(screen.getByText('你好')).toBeTruthy();

    // The single timeline (JSONL) grows: first streaming delta.
    view.rerender(<StandardChatSurface {...baseProps('s1', {
      api,
      session: {
        entries: [
          { kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false },
          { kind: 'message', id: 'a1', role: 'assistant', text: '第一行', streaming: true },
        ],
        streaming: true,
        meta: {},
      },
    })} />);
    expect(screen.getByText(/第一行/)).toBeTruthy();

    // Second streaming delta continues the SAME assistant entry, so its text grows.
    view.rerender(<StandardChatSurface {...baseProps('s1', {
      api,
      session: {
        entries: [
          { kind: 'message', id: 'u1', role: 'user', text: '你好', streaming: false },
          { kind: 'message', id: 'a1', role: 'assistant', text: '第一行\n第二行', streaming: true },
        ],
        streaming: true,
        meta: {},
      },
    })} />);

    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText(/第二行/)).toBeTruthy();
  });
});

describe('StandardChatSurface skill menu and timeline chips', () => {
  it('does not open a skill menu before listAgentSkills settles', async () => {
    const deferred = new Promise<{ skills: Array<{ name: string; description: string }> }>(() => {});
    const api = makeApi({ listAgentSkills: vi.fn(() => deferred) }).api;
    render(<StandardChatSurface {...baseProps('s1', { api, session: { entries: [], streaming: false, meta: {} } })} />);
    await screen.findByTestId('composer-input');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '/' } });
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    expect(screen.queryByText('还没有安装技能')).toBeNull();
  });

  it('shows listed skills after a successful fetch', async () => {
    const api = makeApi({
      listAgentSkills: vi.fn().mockResolvedValue({
        skills: [{ name: 'brainstorming', description: 'ideas', hasScripts: false, warnings: [] }],
      }),
    }).api;
    render(<StandardChatSurface {...baseProps('s1', { api, session: { entries: [], streaming: false, meta: {} } })} />);
    typeDraft(await screen.findByTestId('composer-input'), '/');
    await waitFor(() => expect(screen.getByText('brainstorming')).toBeTruthy());
    expect(api.listAgentSkills).toHaveBeenCalledWith('general');
  });

  it('omits the menu when listAgentSkills is missing and shows empty state only after []', async () => {
    const omitted = makeApi().api;
    delete omitted.listAgentSkills;
    const view = render(<StandardChatSurface {...baseProps('s1', { api: omitted, session: { entries: [], streaming: false, meta: {} } })} />);
    fireEvent.change(await screen.findByTestId('composer-input'), { target: { value: '/' } });
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    view.unmount();

    const api = makeApi({ listAgentSkills: vi.fn().mockResolvedValue({ skills: [] }) }).api;
    render(<StandardChatSurface {...baseProps('s1', { api, session: { entries: [], streaming: false, meta: {} } })} />);
    await waitFor(() => expect(api.listAgentSkills).toHaveBeenCalled());
    typeDraft(screen.getByTestId('composer-input'), '/');
    expect(screen.getByText('还没有安装技能')).toBeTruthy();
  });

  it('keeps the menu closed when listing fails and refetches on window focus', async () => {
    const listAgentSkills = vi.fn()
      .mockRejectedValueOnce(new Error('disk down'))
      .mockResolvedValue({ skills: [] });
    const api = makeApi({ listAgentSkills }).api;
    render(<StandardChatSurface {...baseProps('s1', { api, session: { entries: [], streaming: false, meta: {} } })} />);
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '/' } });
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledTimes(2));
  });

  it('projects destName slashes as timeline chips and leaves other user text plain', () => {
    const session = {
      entries: [
        { kind: 'message', id: 'c1', role: 'user', text: ' /brainstorming\n做对比', streaming: false },
        { kind: 'message', id: 'p1', role: 'user', text: '请读一下', streaming: false },
        { kind: 'message', id: 's1', role: 'user', text: '/skill:brainstorming', streaming: false },
        { kind: 'message', id: 'u1', role: 'user', text: '/contract_risk_review', streaming: false },
        { kind: 'message', id: 'x1', role: 'user', text: '<skill name="brainstorming">full body', streaming: false },
      ],
      streaming: false,
      meta: {},
    };
    render(<StandardChatSurface {...baseProps('s1', { session })} />);
    expect(screen.getByTestId('timeline-skill-chip').textContent).toContain('brainstorming');
    expect(screen.getByText('做对比')).toBeTruthy();
    expect(screen.getByText('请读一下')).toBeTruthy();
    expect(screen.getByText('/skill:brainstorming')).toBeTruthy();
    expect(screen.getByText('/contract_risk_review')).toBeTruthy();
    expect(screen.getByText('<skill name="brainstorming">full body')).toBeTruthy();
    expect(screen.getAllByTestId('timeline-skill-chip')).toHaveLength(1);
  });

  it('reports list failures and a missing API with agent.name', async () => {
    const failedStore = createMemoryErrorStore();
    const failedApi = makeApi({ listAgentSkills: vi.fn().mockRejectedValue(new Error('disk down')) }).api;
    render(
      <ErrorProvider store={failedStore}>
        <StandardChatSurface {...baseProps('s1', { api: failedApi, session: { entries: [], streaming: false, meta: {} } })} />
      </ErrorProvider>,
    );
    await waitFor(async () => {
      const records = await failedStore.load();
      expect(records[0]?.source).toBe('通用智能体');
      expect(records[0]?.message).toContain('disk down');
    });

    const missingStore = createMemoryErrorStore();
    const missingApi = makeApi().api;
    delete missingApi.listAgentSkills;
    render(
      <ErrorProvider store={missingStore}>
        <StandardChatSurface {...baseProps('s1', { api: missingApi, session: { entries: [], streaming: false, meta: {} } })} />
      </ErrorProvider>,
    );
    await waitFor(async () => {
      const records = await missingStore.load();
      expect(records[0]?.source).toBe('通用智能体');
      expect(records[0]?.message).toContain('无法加载技能列表');
    });
  });

  it('loads skills for a draft session and clears them when the agent changes', async () => {
    const listAgentSkills = vi.fn().mockResolvedValue({
      skills: [{ name: 'brainstorming', description: 'ideas', hasScripts: false, warnings: [] }],
    });
    const api = makeApi({ listAgentSkills }).api;
    const view = render(<StandardChatSurface {...baseProps(null, { api, draft: true })} />);
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledWith('general'));
    typeDraft(screen.getByTestId('composer-input'), '/');
    await waitFor(() => expect(screen.getByText('brainstorming')).toBeTruthy());

    let resolveNext: (value: { skills: Array<{ name: string; description: string }> }) => void = () => {};
    const pending = new Promise<{ skills: Array<{ name: string; description: string }> }>((resolve) => {
      resolveNext = resolve;
    });
    listAgentSkills.mockImplementation(() => pending);
    view.rerender(<StandardChatSurface {...baseProps(null, {
      api,
      draft: true,
      agent: { id: 'writer', name: '写作助手', surfaceType: 'chat' },
    })} />);
    await waitFor(() => expect(listAgentSkills).toHaveBeenCalledWith('writer'));
    typeDraft(screen.getByTestId('composer-input'), '/');
    expect(screen.queryByText('brainstorming')).toBeNull();
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    resolveNext({ skills: [] });
    await waitFor(() => {
      typeDraft(screen.getByTestId('composer-input'), '/');
      expect(screen.getByText('还没有安装技能')).toBeTruthy();
    });
  });

  it('shows only the compact recognition quality bar for structure document.read in minimal detail', async () => {
    const { api } = makeApi({ getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'minimal' }) });
    const session = {
      entries: [
        { kind: 'message', id: 'u1', role: 'user', text: '请读这个文件', streaming: false },
        {
          kind: 'tool',
          id: 't1',
          toolName: 'document.read',
          input: { documents: ['C:/tmp/scan.pdf'] },
          result: {
            ok: true,
            data: {
              engine: 'structure',
              meta: {
                fileName: 'scan.pdf',
                quality: { score: 0.78, level: 'mid', pages: [] },
              },
            },
          },
        },
      ],
      streaming: false,
      meta: {},
    };
    render(<StandardChatSurface {...baseProps('s1', { api, session })} />);
    await waitFor(() => {
      expect(screen.getByTestId('recognition-quality')).toBeTruthy();
      expect(screen.queryByTestId('tool-card')).toBeNull();
    });
    expect(screen.getByTestId('recognition-quality').textContent).toContain('识别质量');
    expect(screen.getByTestId('recognition-quality').textContent).toContain('中');
    expect(screen.getByTestId('recognition-quality').textContent).toContain('78%');
    expect(screen.getByTestId('recognition-quality').textContent).toContain('scan.pdf');
  });
});
