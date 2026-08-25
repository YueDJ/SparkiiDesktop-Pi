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
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/user-ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }),
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
    expect(screen.getByText('hi')).toBeTruthy();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    expect(api.promptSession).toHaveBeenCalledWith('s1', '请创建 hello.txt');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', delta: '收到' }));
    expect(screen.getByText(/收到/)).toBeTruthy();
  });

  it('marks a tool card awaiting approval from approval events', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'tool_call', toolName: 'write', input: { path: 'C:/ws/a.txt' } }));
    act(() => channels['approval']({ sessionId: 's1', toolName: 'write' }));
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });
});
