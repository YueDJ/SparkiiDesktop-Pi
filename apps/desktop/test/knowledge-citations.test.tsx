import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { KnowledgeAnswerBubble } from '../src/surface/knowledge-citations.js';
import KnowledgeQaSurface from '../agents/knowledge-qa/surface/index.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    on: vi.fn(() => () => {}),
    openChatSession: vi.fn().mockResolvedValue({ entries: [], streamingMessage: null, streaming: false }),
    getChatSession: vi.fn().mockResolvedValue({}),
    getChatState: vi.fn().mockResolvedValue({ streaming: false, steering: [], followUp: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true, cleared: { steering: [], followUp: [] } }),
    queueMutate: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true }),
    listThinkingLevels: vi.fn().mockResolvedValue(['off']),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({}),
    allocateAutoWorkspace: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({
      chatDetailLevel: 'standard',
      rag: { bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'hr' }] },
    }),
    getPathForFile: vi.fn(),
    listAgentSkills: vi.fn().mockResolvedValue({ skills: [{ name: 'brainstorming', description: 'x' }] }),
    listRagDatasets: vi.fn().mockResolvedValue({
      ok: true,
      datasets: [{ id: 'law', name: '法规库' }, { id: 'hr', name: '制度库' }],
    }),
    setSessionKnowledge: vi.fn().mockResolvedValue({ ok: true }),
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

describe('knowledge citations', () => {
  it('folds a knowledge_turn after an assistant message into one bubble', () => {
    render(<KnowledgeAnswerBubble text={'根据办法发放[1]'} documents={[{ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' }]} />);
    expect(screen.getByText(/根据办法发放/)).toBeTruthy();
    expect(screen.getByTestId('knowledge-source').textContent).toContain('高温作业津贴办法.pdf');
  });

  it('numbers each retrieved chunk in the source list', () => {
    render(
      <KnowledgeAnswerBubble
        text={'根据办法发放[1][2]'}
        documents={[{ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' }]}
        citations={[
          { index: 1, documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law', snippet: '津贴按日计' },
          { index: 2, documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law', snippet: '适用范围本方案' },
        ]}
      />,
    );
    const sources = screen.getAllByTestId('knowledge-source');
    expect(sources).toHaveLength(2);
    expect(sources[0].textContent).toMatch(/\[1\].*高温作业津贴办法\.pdf/);
    expect(sources[1].textContent).toMatch(/\[2\].*高温作业津贴办法\.pdf/);
  });

  it('opens the source document when the file name is clicked', () => {
    const onOpenDocument = vi.fn();
    render(<KnowledgeAnswerBubble text={'根据办法发放[1]'} documents={[{ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' }]} onOpenDocument={onOpenDocument} />);
    screen.getByTestId('knowledge-source').click();
    expect(onOpenDocument).toHaveBeenCalledWith({ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' });
  });
});

describe('knowledge-qa surface', () => {
  it('assistant followed by refused knowledge_turn shows only refuse text', () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [
            { kind: 'message', id: 'a1', role: 'assistant', text: '模型胡诌', streaming: false },
            { kind: 'custom', id: 't1', customType: 'knowledge_turn', data: { refused: true, text: '知识库没有相关内容，我无法回答。', documents: [] } },
          ],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    expect(screen.getByText('知识库没有相关内容，我无法回答。')).toBeTruthy();
    expect(screen.queryByText('模型胡诌')).toBeNull();
    expect(screen.queryByTestId('knowledge-source')).toBeNull();
  });

  it('folds sources onto the last assistant in the turn, not an earlier thinking bubble', () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [
            { kind: 'message', id: 'u1', role: 'user', text: '汕昆高速的概括', streaming: false },
            { kind: 'message', id: 'a0', role: 'assistant', text: 'The user asks for a general overview', streaming: false },
            { kind: 'custom', id: 't1', customType: 'knowledge_turn', data: { refused: false, documents: [{ documentId: 'd1', documentName: 'TJ5标墩柱专项施工方案.docx', datasetId: 'law' }], citations: [{ index: 1, documentId: 'd1', documentName: 'TJ5标墩柱专项施工方案.docx', datasetId: 'law', snippet: '汕梅高速改扩建' }] } },
            { kind: 'message', id: 'a1', role: 'assistant', text: '该标段起讫里程 K101+700[1]', streaming: false },
          ],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    expect(screen.getByText(/该标段起讫里程/)).toBeTruthy();
    const sources = screen.getAllByTestId('knowledge-source');
    expect(sources).toHaveLength(1);
    expect(sources[0].textContent).toContain('TJ5标墩柱专项施工方案.docx');
    const thinking = screen.getByText(/The user asks for a general overview/);
    expect(thinking.closest('.ui-chat-message')?.querySelector('[data-testid="knowledge-source"]')).toBeNull();
    expect(screen.getByText(/该标段起讫里程/)?.closest('.ui-chat-message')?.querySelector('[data-testid="knowledge-source"]')).toBeTruthy();
  });

  it('folds sources into the assistant bubble when lifecycle events sit between', () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [
            { kind: 'message', id: 'u1', role: 'user', text: '津贴怎么发', streaming: false },
            { kind: 'message', id: 'a1', role: 'assistant', text: '根据办法发放[1]', streaming: false },
            { kind: 'event', id: 'e1', event: 'agent_end', label: 'Pi 处理完成' },
            { kind: 'event', id: 'e2', event: 'agent_settled', label: 'Pi 已就绪' },
            { kind: 'custom', id: 't1', customType: 'knowledge_turn', data: { refused: false, documents: [{ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' }] } },
          ],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    expect(screen.getByText(/根据办法发放/)).toBeTruthy();
    expect(screen.getByTestId('knowledge-source').textContent).toContain('高温作业津贴办法.pdf');
  });

  it('hides completed knowledge.search at standard detail', async () => {
    const api = makeApi({
      getSettings: vi.fn().mockResolvedValue({
        chatDetailLevel: 'standard',
        rag: { bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'hr' }] },
      }),
    });
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [
            { kind: 'message', id: 'u1', role: 'user', text: '津贴怎么发', streaming: false },
            { kind: 'tool', id: 'tool1', toolName: 'knowledge.search', input: { query: '津贴' }, result: { ok: true } },
            { kind: 'message', id: 'a1', role: 'assistant', text: '根据办法发放[1]', streaming: false },
          ],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => expect(screen.getByText(/根据办法发放/)).toBeTruthy());
    expect(screen.queryByTestId('tool-card')).toBeNull();
  });

  it('shows completed knowledge.search when detail is debug', async () => {
    const api = makeApi({
      getSettings: vi.fn().mockResolvedValue({
        chatDetailLevel: 'debug',
        rag: { bindings: [{ agentId: 'knowledge-qa', defaultDatasetId: 'hr' }] },
      }),
    });
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [
            { kind: 'message', id: 'u1', role: 'user', text: '津贴怎么发', streaming: false },
            { kind: 'tool', id: 'tool1', toolName: 'knowledge.search', input: { query: '津贴' }, result: { ok: true } },
            { kind: 'message', id: 'a1', role: 'assistant', text: '根据办法发放[1]', streaming: false },
          ],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('tool-card')).toBeTruthy());
    expect(screen.getByText(/根据办法发放/)).toBeTruthy();
  });

  it('shows dataset select when knowledge-qa surface mounts picker', async () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('knowledge-dataset-select')).toBeTruthy());
  });

  it('selects the agent default dataset instead of all visible libraries', async () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
  });

  it('resets picker to the agent default when the session changes', async () => {
    const api = makeApi();
    const view = render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
    fireEvent.change(screen.getByTestId('knowledge-dataset-select'), { target: { value: '__all__' } });
    expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('__all__');
    view.rerender(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k2"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
  });

  it('does not copy a draft picker choice onto an opened session', async () => {
    const api = makeApi();
    const view = render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId={null}
        mode="live"
        draft
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
    fireEvent.change(screen.getByTestId('knowledge-dataset-select'), { target: { value: '__all__' } });
    expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('__all__');
    view.rerender(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k-history"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
  });

  it('keeps an explicit all-libraries draft choice after the session is created', async () => {
    const api = makeApi({
      promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 's-new' }),
    });
    const view = render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId={null}
        mode="live"
        draft
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => {
      expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('hr');
    });
    fireEvent.change(screen.getByTestId('knowledge-dataset-select'), { target: { value: '__all__' } });
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '高温津贴怎么发' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(actions.openSession).toHaveBeenCalledWith('s-new'));
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('s-new', '高温津贴怎么发', 'agent'));
    view.rerender(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="s-new"
        mode="live"
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    expect((screen.getByTestId('knowledge-dataset-select') as HTMLSelectElement).value).toBe('__all__');
  });

  it('publishes a placeholder title when promptSession creates a session', async () => {
    const api = makeApi({
      promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'k-left' }),
    });
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId={null}
        mode="live"
        draft
        session={{ entries: [], streaming: false, meta: {} }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('knowledge-dataset-select')).toBeTruthy());
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '汕昆高速的概括' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('k-left', '汕昆高速的概括', 'agent'));
    expect(actions.openSession).toHaveBeenCalledWith('k-left');
  });

  it('publishes a placeholder title from the first user message', async () => {
    const api = makeApi();
    render(
      <KnowledgeQaSurface
        agent={{ id: 'knowledge-qa', name: '企业知识问答', surfaceType: 'chat', knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' } }}
        sessionId="k1"
        mode="live"
        session={{
          entries: [{ kind: 'message', id: 'u1', role: 'user', text: '汕昆高速的概括', streaming: false }],
          streaming: false,
          meta: {},
        }}
        actions={actions}
        api={api as any}
      />,
    );
    await waitFor(() => expect(api.setChatTitle).toHaveBeenCalledWith('k1', '汕昆高速的概括', 'agent'));
    expect(api.completeText).not.toHaveBeenCalled();
  });
});
