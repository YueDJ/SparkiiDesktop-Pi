import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { KnowledgeAnswerBubble } from '../src/surface/knowledge-citations.js';
import KnowledgeQaSurface from '../agents/knowledge-qa/surface/index.js';
import { StandardChatSurface } from '../src/surface/standard-chat.js';

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
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], provider: 'deepseek' }),
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
    getPathForFile: vi.fn(),
    listAgentSkills: vi.fn().mockResolvedValue({ skills: [{ name: 'brainstorming', description: 'x' }] }),
    listRagDatasets: vi.fn().mockResolvedValue({ ok: true, datasets: [{ id: 'law', name: '法规库' }] }),
    setSessionKnowledge: vi.fn().mockResolvedValue({ ok: true }),
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
});
