import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { StandardChatSurface } from '../src/surface/standard-chat.js';

afterEach(cleanup);

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [{ role: 'user', text: 'hi' }] }),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/x' }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off', 'medium']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-pro'], provider: 'deepseek' }),
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

  it('renders history messages from the session stream and prompts with sessionId', async () => {
    const { api, channels } = makeApi();
    (globalThis as any).window.sparkii = api;
    render(<StandardChatSurface {...baseProps('s1')} />);
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('s1'));
    await screen.findByText('hi');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(api.promptSession).toHaveBeenCalledWith('s1', '请创建 hello.txt', undefined, undefined, undefined);
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', delta: '收到' }));
    expect(screen.getByText(/收到/)).toBeTruthy();
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
