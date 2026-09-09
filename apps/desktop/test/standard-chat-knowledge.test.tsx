import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { StandardChatSurface } from '../src/surface/standard-chat.js';
import { ErrorProvider, createMemoryErrorStore } from '@sparkii/ui';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  const api = {
    on: vi.fn(() => () => {}),
    openChatSession: vi.fn().mockResolvedValue({ entries: [], streamingMessage: null, streaming: false }),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws' }),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 's1' }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off', 'medium', 'high']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/user-ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getPathForFile: vi.fn((file: File) => `C:/downloads/${file.name}`),
    listAgentSkills: vi.fn().mockResolvedValue({ skills: [] }),
    setSessionKnowledge: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  return api as any;
}

function chatProps(over: Record<string, unknown> = {}) {
  return {
    agent: { id: 'general', name: '通用智能体', surfaceType: 'chat' },
    sessionId: 's1',
    mode: 'live' as const,
    session: { entries: [], streaming: false, meta: {} },
    draft: true,
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
  };
}

describe('StandardChat knowledge slots', () => {
  beforeEach(() => {
    (globalThis as any).window.sparkii = makeApi();
  });

  it('does not show dataset select when StandardChat has no toolbarExtra', () => {
    render(<StandardChatSurface {...chatProps({})} />);
    expect(screen.queryByTestId('knowledge-dataset-select')).toBeNull();
  });

  it('calls onBeforeSend before promptSession', async () => {
    const order: string[] = [];
    const api = makeApi({
      setSessionKnowledge: async () => { order.push('knowledge'); return { ok: true }; },
      promptSession: async () => { order.push('prompt'); return { ok: true, sessionId: 's1' }; },
    });
    render(<StandardChatSurface {...chatProps({
      api,
      onBeforeSend: async () => { await api.setSessionKnowledge('draft:knowledge-qa', { mode: 'all' }); },
    })} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '高温津贴怎么发' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(order).toEqual(['knowledge', 'prompt']));
  });

  it('promptSession failure clears busy', async () => {
    const api = makeApi({
      promptSession: vi.fn().mockResolvedValue({ ok: false, error: '请先在设置 → 知识库配置 SparkiiRAG' }),
    });
    render(
      <ErrorProvider store={createMemoryErrorStore()}>
        <StandardChatSurface {...chatProps({ api })} />
      </ErrorProvider>,
    );
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '问一句' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('请先在设置'));
    expect(screen.getByTestId('composer-send').getAttribute('aria-label')).toBe('发送');
  });
});
