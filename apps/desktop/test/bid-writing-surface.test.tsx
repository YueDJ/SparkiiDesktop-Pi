import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import BidWritingSurface from '../agents/bid-writing/surface/index.js';
import type { AgentSession } from '../src/surface/contract.js';
import type { ProjectFile } from '../agents/bid-writing/surface/project-store.js';

afterEach(() => {
  cleanup();
  delete (window as any).sparkii;
});

function projectFixture(over: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: 'bid-1',
    name: '智慧园区投标文件',
    status: 'drafting',
    workspacePath: 'C:/docs/Sparkii/workspaces/bid-writing/glow-fox-k7m',
    knowledgeBases: [],
    chapters: [
      { id: '1', title: '投标函', file: '01-投标函.md', status: 'todo' },
      { id: '3', title: '技术方案', file: '03-技术方案.md', status: 'todo' },
    ],
    progress: { done: 0, total: 2 },
    version: 1,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function makeApi(opts: { project?: ProjectFile | null; sessions?: unknown[] } = {}) {
  const project = opts.project === undefined ? projectFixture() : opts.project;
  const sessions = opts.sessions ?? [];
  const store = new Map<string, string>();
  return {
    on: vi.fn(() => () => {}),
    listChatSessions: vi.fn().mockResolvedValue(sessions),
    allocateAutoWorkspace: vi.fn().mockResolvedValue({ workspacePath: 'C:/docs/Sparkii/workspaces/bid-writing/new-proj-1' }),
    createSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'new-session-1', workspacePath: 'C:/docs/Sparkii/workspaces/bid-writing/new-proj-1' }),
    promptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'new-session-1' }),
    workspaceRead: vi.fn(async ({ path }: { path: string }) => {
      if (path === 'project.json') {
        return project ? { ok: true, op: 'read', path, content: JSON.stringify(project) } : { ok: false, code: 'INVALID', reason: 'none' };
      }
      if (path.startsWith('output/manuscript/')) {
        return { ok: true, op: 'read', path, content: store.get(path) ?? '' };
      }
      return { ok: false, code: 'INVALID', reason: 'none' };
    }),
    workspaceWrite: vi.fn(async ({ path, content }: { path: string; content: string }) => {
      store.set(path, content);
      return { ok: true, op: 'write', path };
    }),
    workspaceMkdir: vi.fn().mockResolvedValue({ ok: true, op: 'mkdir', path: '' }),
    setChatTitle: vi.fn().mockResolvedValue({ ok: true }),
    listRagDatasets: vi.fn().mockResolvedValue({ ok: true, datasets: [] }),
    setSessionKnowledge: vi.fn().mockResolvedValue({ ok: true }),
    relocateWorkspace: vi.fn(async (_sid: string, newPath: string) => ({ ok: true, workspacePath: newPath })),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/docs/Sparkii/workspaces/bid-writing/new-location' }),
    openWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    on: vi.fn(() => () => {}),
    chooseDocument: vi.fn().mockResolvedValue({}),
    readDocumentBytes: vi.fn().mockResolvedValue({ error: 'denied' }),
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

function emptySession(): AgentSession {
  return { entries: [], streaming: false, meta: {} };
}

function renderSurface(api: ReturnType<typeof makeApi>, sessionId: string | null = null, session: AgentSession = emptySession()) {
  return render(
    <BidWritingSurface
      agent={{ id: 'bid-writing', name: '标书写作智能体', surfaceType: 'custom' }}
      sessionId={sessionId}
      mode="live"
      session={session}
      actions={actions}
    />,
  );
}

describe('bid-writing surface (P1 skeleton)', () => {
  it('renders the project list view with the new-project button', async () => {
    const api = makeApi({ sessions: [] });
    (window as any).sparkii = api;
    renderSurface(api);
    expect(await screen.findByText('我的标书项目')).toBeTruthy();
    expect(screen.getByText('＋ 新建项目')).toBeTruthy();
  });

  it('lists a project read from project.json by workspacePath grouping', async () => {
    const p = projectFixture();
    const api = makeApi({
      sessions: [{ id: 's1', workspacePath: p.workspacePath, updatedAt: 10 }],
      project: p,
    });
    (window as any).sparkii = api;
    renderSurface(api);
    expect(await screen.findByText(p.name)).toBeTruthy();
  });

  it('creates a project with an EMPTY session: no prompt is dispatched (P9)', async () => {
    const api = makeApi({ sessions: [], project: null });
    (window as any).sparkii = api;
    renderSurface(api);
    fireEvent.click(await screen.findByText('＋ 新建项目'));
    const input = screen.getByPlaceholderText('如：智慧园区智能化项目 · 投标文件') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '测试标书' } });
    await act(async () => { fireEvent.click(screen.getByText('创建')); });
    await waitFor(() => {
      expect(api.allocateAutoWorkspace).toHaveBeenCalledWith('bid-writing');
      expect(api.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: 'bid-writing', workspacePath: 'C:/docs/Sparkii/workspaces/bid-writing/new-proj-1', workspaceKind: 'auto' }),
      );
      expect(actions.openSession).toHaveBeenCalledWith('new-session-1');
    });
    // The core regression guard: creating a project must NOT start writing.
    expect(api.promptSession).not.toHaveBeenCalled();
    // skeleton dirs + project.json (status=setup) + chapter files written
    expect(api.workspaceMkdir.mock.calls.length).toBeGreaterThanOrEqual(6);
    const projWrite = api.workspaceWrite.mock.calls.find((c: any[]) => c[0].path === 'project.json');
    expect(projWrite).toBeTruthy();
    expect(JSON.parse(projWrite[0].content).status).toBe('setup');
  });

  it('renders the three-column workbench when a session is bound', async () => {
    const p = projectFixture();
    const api = makeApi({ sessions: [], project: p });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    expect(await screen.findByText('章节大纲')).toBeTruthy();
    expect(await screen.findByText('本次对话')).toBeTruthy();
    expect(screen.getByText('1 · 投标函')).toBeTruthy();
    // B1: WYSIWYG renders blocks; the source textarea appears after "查看源码".
    expect(screen.getByText('所见即所得')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('查看源码')); });
    expect(screen.getByPlaceholderText('在此撰写章节正文…')).toBeTruthy();
  });

  it('saves an edited chapter through the fenced workspace write', async () => {
    const p = projectFixture();
    const api = makeApi({ sessions: [], project: p });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    await screen.findByText('章节大纲');
    await act(async () => { fireEvent.click(screen.getByText('查看源码')); });
    const editor = screen.getByPlaceholderText('在此撰写章节正文…') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# 投标函\n\n正文内容' } });
    await act(async () => { fireEvent.click(screen.getByText('保存')); });
    expect(api.workspaceWrite.mock.calls.some((c: any[]) => c[0].path === 'output/manuscript/01-投标函.md')).toBe(true);
  });

  it('starts a new conversation bound to the same fixed workspace (P5)', async () => {
    const p = projectFixture();
    const api = makeApi({ sessions: [], project: p });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    await screen.findByText('章节大纲');
    // B3: both the outline and conversation "+ buttons now bind the workspace.
    const newConvBtns = screen.getAllByTitle('新对话（绑定同一项目）');
    expect(newConvBtns.length).toBeGreaterThanOrEqual(1);
    await act(async () => { fireEvent.click(newConvBtns[0]); });
    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'bid-writing', workspacePath: p.workspacePath, workspaceKind: 'auto' }),
    );
    // A new empty conversation must not dispatch a writing prompt.
    expect(api.promptSession).not.toHaveBeenCalled();
  });
});

describe('bid-writing surface — composer & degraded knowledge (runtime fix)', () => {
  it('sends composer text into the bound session with degraded knowledge opt-in', async () => {
    const api = makeApi({ sessions: [], project: projectFixture() });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    await screen.findByText('本次对话');
    const input = screen.getByPlaceholderText(/描述要写或要改的内容/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '帮我写完技术方案' } });
    await act(async () => { fireEvent.click(screen.getByText('发送')); });
    await waitFor(() => {
      expect(api.promptSession).toHaveBeenCalledWith(
        's1',
        '帮我写完技术方案',
        undefined,
        undefined,
        { allowDegradedKnowledge: true },
      );
    });
    // input clears only after a successful prompt
    expect((screen.getByPlaceholderText(/描述要写或要改的内容/) as HTMLTextAreaElement).value).toBe('');
  });

  it('surfaces the gateway error instead of silently failing when the session cannot be created', async () => {
    const api = makeApi({ sessions: [], project: null });
    api.createSession.mockResolvedValue({ ok: false, error: '知识库尚未就绪' });
    (window as any).sparkii = api;
    renderSurface(api);
    fireEvent.click(await screen.findByText('＋ 新建项目'));
    fireEvent.change(await screen.findByPlaceholderText('如：智慧园区智能化项目 · 投标文件'), { target: { value: '失败案例' } });
    await act(async () => { fireEvent.click(screen.getByText('创建')); });
    expect(await screen.findByText('知识库尚未就绪')).toBeTruthy();
    expect(actions.openSession).not.toHaveBeenCalledWith(undefined);
  });
});

describe('bid-writing surface — P9 setup phase (create ≠ write)', () => {
  it('shows the setup panel for a setup-status project and blocks prompts until confirmed', async () => {
    const api = makeApi({ sessions: [], project: projectFixture({ status: 'setup' }) });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    expect(await screen.findByText(/准备阶段 · 尚未开始写作/)).toBeTruthy();
    expect(screen.getByText(/确认信息，开始写作/)).toBeTruthy();
    // Composer is present but must not dispatch a prompt while in setup.
    const input = screen.getByPlaceholderText(/描述要写或要改的内容/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '先写投标函' } });
    await act(async () => { fireEvent.click(screen.getByText('发送')); });
    expect(api.promptSession).not.toHaveBeenCalled();
  });

  it('confirming saves requirements, flips status to drafting, then dispatches the FIRST prompt', async () => {
    const api = makeApi({ sessions: [], project: projectFixture({ status: 'setup' }) });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    const reqBox = await screen.findByPlaceholderText(/重点突出技术方案/) as HTMLTextAreaElement;
    fireEvent.change(reqBox, { target: { value: '按评分办法组织技术方案' } });
    await act(async () => { fireEvent.click(screen.getByText(/确认信息，开始写作/)); });
    await waitFor(() => {
      // Requirements persisted into input/ before the prompt.
      expect(api.workspaceWrite.mock.calls.some((c: any[]) => c[0].path === 'input/requirements.md')).toBe(true);
      // project.json flipped to drafting.
      const projWrite = api.workspaceWrite.mock.calls.find((c: any[]) => c[0].path === 'project.json');
      expect(projWrite).toBeTruthy();
      expect(JSON.parse(projWrite[0].content).status).toBe('drafting');
      // The first and only prompt carries the confirmed requirements.
      expect(api.promptSession).toHaveBeenCalledTimes(1);
      expect(api.promptSession).toHaveBeenCalledWith(
        's1',
        expect.stringContaining('按评分办法组织技术方案'),
        undefined,
        undefined,
        { allowDegradedKnowledge: true },
      );
    });
    await waitFor(() => {
      expect(screen.queryByText(/准备阶段 · 尚未开始写作/)).toBeNull();
    });
  });
});

describe('bid-writing surface — B2 two context lines (architect review)', () => {
  it('wizard walks 3 steps and persists selected knowledge bases into project.json', async () => {
    const api = makeApi({ sessions: [], project: null });
    api.listRagDatasets.mockResolvedValue({ ok: true, datasets: [{ id: 'ds-1', name: '公司制度库' }] });
    (window as any).sparkii = api;
    renderSurface(api);
    fireEvent.click(await screen.findByText('＋ 新建项目'));
    // step 1 — name
    fireEvent.change(await screen.findByPlaceholderText('如：智慧园区智能化项目 · 投标文件'), { target: { value: 'B2 标书' } });
    await act(async () => { fireEvent.click(screen.getByText('下一步')); });
    // step 2 — material (optional)
    expect(await screen.findByText(/项目私有资料/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('下一步')); });
    // step 3 — knowledge base picker
    expect(await screen.findByText('公司制度库')).toBeTruthy();
    const cb = screen.getByRole('checkbox');
    await act(async () => { fireEvent.click(cb); });
    await act(async () => { fireEvent.click(screen.getByText('创建')); });
    await waitFor(() => {
      const projWrite = api.workspaceWrite.mock.calls.find((c: any[]) => c[0].path === 'project.json');
      expect(projWrite).toBeTruthy();
      const saved = JSON.parse(projWrite[0].content);
      expect(saved.knowledgeBases).toEqual([{ datasetId: 'ds-1', name: '公司制度库' }]);
      expect(api.setSessionKnowledge).toHaveBeenCalledWith(
        'new-session-1',
        { mode: 'ids', datasetIds: ['ds-1'] },
      );
    });
  });

  it('uploads material into input/ and builds the T1 index', async () => {
    const api = makeApi({ sessions: [], project: null });
    api.chooseDocument.mockResolvedValue({ path: 'C:/docs/招标文件.txt' });
    api.readDocumentBytes.mockResolvedValue({
      kind: 'txt', fileName: '招标文件.txt', fileSize: 8,
      bytes: new TextEncoder().encode('评分办法与工期要求').buffer,
    });
    (window as any).sparkii = api;
    renderSurface(api);
    fireEvent.click(await screen.findByText('＋ 新建项目'));
    fireEvent.change(await screen.findByPlaceholderText('如：智慧园区智能化项目 · 投标文件'), { target: { value: '资料标书' } });
    await act(async () => { fireEvent.click(screen.getByText('下一步')); });
    await act(async () => { fireEvent.click(screen.getByText('＋ 添加资料')); });
    expect(await screen.findByText('招标文件.txt')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('创建')); });
    await waitFor(() => {
      expect(api.workspaceWrite.mock.calls.some((c: any[]) => c[0].path === 'input/招标文件.txt')).toBe(true);
      expect(api.workspaceWrite.mock.calls.some((c: any[]) => c[0].path === 'input/manifest.md')).toBe(true);
      expect(api.workspaceWrite.mock.calls.some((c: any[]) => c[0].path === 'input/.index/chunks.json')).toBe(true);
    });
  });

  it('renders source-attribution chips from REAL Live Pipeline entries (O3)', async () => {
    const api = makeApi({ sessions: [], project: projectFixture() });
    (window as any).sparkii = api;
    // Real shapes: tool events normalize to kind:'tool'; knowledge retrieval
    // also emits a customType:'knowledge_turn' row — no custom tool_execution_*.
    const session: AgentSession = {
      entries: [
        {
          kind: 'tool', id: 't1', toolName: 'knowledge.search',
          input: { datasetId: '公司制度库', query: '评分办法' },
          result: { snippet: '制度条款片段' },
        } as any,
        {
          kind: 'tool', id: 't2', toolName: 'document.read',
          input: { fileName: '招标文件.txt' },
          result: { text: '工期要求' },
        } as any,
      ],
      streaming: false,
      meta: {},
    };
    renderSurface(api, 's1', session);
    expect(await screen.findByText(/引用来源/)).toBeTruthy();
    expect(await screen.findByText('知识库 · 公司制度库')).toBeTruthy();
    expect(await screen.findByText('资料 · 招标文件.txt')).toBeTruthy();
  });
});

describe('bid-writing surface — P10 storage location (setup only)', () => {
  it('shows the relocate entry in setup and hides it in drafting', async () => {
    const apiSetup = makeApi({ sessions: [], project: projectFixture({ status: 'setup' }) });
    (window as any).sparkii = apiSetup;
    renderSurface(apiSetup, 's1');
    await screen.findByText('章节大纲');
    await act(async () => { fireEvent.click(screen.getByText('工作区')); });
    expect(screen.getByText('更改存放位置')).toBeTruthy();

    cleanup();
    delete (window as any).sparkii;

    const apiDraft = makeApi({ sessions: [], project: projectFixture({ status: 'drafting' }) });
    (window as any).sparkii = apiDraft;
    renderSurface(apiDraft, 's1');
    await screen.findByText('章节大纲');
    await act(async () => { fireEvent.click(screen.getByText('工作区')); });
    expect(screen.queryByText('更改存放位置')).toBeNull();
    expect(screen.getByText('开始写作后存放位置锁定')).toBeTruthy();
  });

  it('relocates then writes project.json with the new path (order + guard)', async () => {
    const p = projectFixture({ status: 'setup' });
    const api = makeApi({ sessions: [], project: p });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    await screen.findByText('章节大纲');
    await act(async () => { fireEvent.click(screen.getByText('工作区')); });

    const order: string[] = [];
    (api.chooseWorkspace as any).mockImplementation(async () => { order.push('choose'); return { path: 'C:/new/ws' }; });
    (api.relocateWorkspace as any).mockImplementation(async () => { order.push('relocate'); return { ok: true, workspacePath: 'C:/new/ws' }; });

    await act(async () => { fireEvent.click(screen.getByText('更改存放位置')); });
    await waitFor(() => expect(api.relocateWorkspace).toHaveBeenCalledWith('s1', 'C:/new/ws'));
    // project.json written AFTER relocate, with the NEW path.
    const projWrite = api.workspaceWrite.mock.calls.find((c: any[]) => c[0].path === 'project.json');
    expect(projWrite).toBeTruthy();
    expect(JSON.parse(projWrite[0].content).workspacePath).toBe('C:/new/ws');
    expect(order).toEqual(['choose', 'relocate']);
  });

  it('guards against calling relocate when the project is drafting', async () => {
    const api = makeApi({ sessions: [], project: projectFixture({ status: 'drafting' }) });
    (window as any).sparkii = api;
    renderSurface(api, 's1');
    await screen.findByText('章节大纲');
    await act(async () => { fireEvent.click(screen.getByText('工作区')); });
    expect(screen.queryByText('更改存放位置')).toBeNull();
    expect(api.relocateWorkspace).not.toHaveBeenCalled();
  });
});
