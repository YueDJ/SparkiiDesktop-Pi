/**
 * Bid-writing three-column surface (custom surface, thin contract).
 *
 * Platform shell passes the unified AgentSurfaceProps; all project/workspace
 * logic lives here in the agent package. Conversation rendering reuses the
 * Live Session Pipeline via the `session` prop — we never build our own pipe.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentSurfaceProps, SessionEntry } from '../../../src/surface/contract.js';
import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import {
  ensureSkeleton,
  newProject,
  readChapter,
  readProject,
  writeChapter,
  writeProject,
  type ProjectFile,
} from './project-store.js';
import { threeWayMerge } from './block-merge.js';
import { loadIndex as loadVersionIndex, restoreFile, snapshot } from './version-store.js';
import { buildIndex, loadIndex as loadMaterialIndex, loadMaterialDocs, retrieve } from './project-index.js';
import { extractSourceChips, sourceChip, type ContextBlock } from './context-lines.js';
import { toolDenyLabel } from './denial-label.js';
import { normalizeSpec, toSvg, toDrawioXml } from './figure-converter.js';
import WysiwygEditor from './wysiwyg.js';
import './styles.css';

const AGENT_ID = 'bid-writing';

function api(): SparkiiApi {
  return ((window as unknown as { sparkii?: SparkiiApi }).sparkii ?? {}) as SparkiiApi;
}

interface SessionMeta {
  id: string;
  workspacePath?: string;
  updatedAt?: number;
}

/** promptSession also returns gate failures as `{ ok:false, code, error }`. */
interface PromptResult {
  ok?: boolean;
  sessionId?: string;
  code?: string;
  error?: string;
}

type View = 'list' | 'workbench';

function sessionText(entry: SessionEntry): string {
  if (entry.kind === 'custom') return '';
  const e = entry as { role?: string; text?: string; content?: string };
  return String(e.text ?? e.content ?? '');
}

export default function BidWritingSurface(props: AgentSurfaceProps) {
  const { sessionId, session, actions } = props;
  const [view, setView] = useState<View>('list');
  const [projects, setProjects] = useState<ProjectFile[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectFile | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [draftName, setDraftName] = useState('');
  // §6.2 line two — project-private material uploaded into input/.
  const [draftMaterials, setDraftMaterials] = useState<Array<{ name: string; text: string }>>([]);
  // §6.1 line one — SparkiiRAG datasets selected for this project.
  const [ragDatasets, setRagDatasets] = useState<Array<{ id: string; name: string }>>([]);
  const [draftDatasetIds, setDraftDatasetIds] = useState<string[]>([]);
  // §10.1/O3 — source chips attributed from the live session timeline.
  const [activeContext, setActiveContext] = useState<ContextBlock[]>([]);
  const [activeChapter, setActiveChapter] = useState<string | null>(null);
  const [chapterText, setChapterText] = useState('');
  const [status, setStatus] = useState('');
  const [projectSessions, setProjectSessions] = useState<Array<{ id: string; updatedAt?: number }>>([]);
  const [convQuery, setConvQuery] = useState('');
  const [editingFigure, setEditingFigure] = useState<{ name: string; source: string } | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  // Setup phase (P9): inputs the user can revise before writing begins.
  const [setupReq, setSetupReq] = useState('');
  const [setupMaterials, setSetupMaterials] = useState<Array<{ name: string; text: string }>>([]);
  const [setupBasic, setSetupBasic] = useState({ client: '', deadline: '', projectCode: '', template: '' });
  const [confirming, setConfirming] = useState(false);
  // P10 — workspace drawer + relocate (setup only). Drawer is available in any
  // phase to VIEW the path; the relocate action itself renders only in setup.
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = useState(false);

  // Load all bid-writing sessions, group by workspacePath, read each project.json.
  const refreshProjects = useCallback(async () => {
    const sparkii = api();
    try {
      const rows = (await sparkii.listChatSessions?.(AGENT_ID)) as SessionMeta[] | undefined;
      const byWorkspace = new Map<string, SessionMeta>();
      for (const row of rows ?? []) {
        const wp = String(row.workspacePath ?? '').trim();
        if (!wp) continue;
        const prev = byWorkspace.get(wp);
        if (!prev || (row.updatedAt ?? 0) > (prev.updatedAt ?? 0)) byWorkspace.set(wp, row);
      }
      // One read per workspace, in parallel (independent read-only IPCs).
      const loaded: ProjectFile[] = (await Promise.all(
        [...byWorkspace].map(async ([wp, meta]) => {
          const p = await readProject(meta.id);
          return p ? { ...p, workspacePath: wp } : null;
        }),
      )).filter((p): p is ProjectFile => p !== null);
      loaded.sort((a, b) => b.updatedAt - a.updatedAt);
      setProjects(loaded);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // P10 — 跨窗口/跨会话搬迁同步：平台广播后强制刷新项目列表与当前项目路径，
  // 避免旧 activeProject.workspacePath 被 writeProject 写回旧目录（计划 §5.6）。
  useEffect(() => {
    const off = api().on?.('workspace-relocated', (payload: unknown) => {
      const ev = payload as { workspacePath?: string } | undefined;
      if (ev?.workspacePath) {
        setActiveProject((prev) => prev ? { ...prev, workspacePath: ev.workspacePath! } : prev);
      }
      void refreshProjects();
    });
    return () => off?.();
  }, [refreshProjects]);

  // §6.1 — load visible RAG datasets when the wizard opens (line one picker).
  useEffect(() => {
    if (!wizardOpen) return;
    void (async () => {
      try {
        const r = await api().listRagDatasets?.();
        if (r?.ok) setRagDatasets(r.datasets ?? []);
      } catch { /* RAG down → line two still usable (§15) */ }
    })();
  }, [wizardOpen]);

  // §10.1/O3 — attribute source chips from the REAL Live Pipeline timeline.
  // The pipeline normalizes tool events to kind:'tool'; knowledge_turn rows are
  // kind:'custom'. Extraction lives in context-lines.ts (unit-testable).
  useEffect(() => {
    setActiveContext(extractSourceChips(session.entries));
  }, [session.entries]);

  // When a session is bound (draft=false), load its project + first chapter.
  useEffect(() => {
    if (!sessionId) return;
    void (async () => {
      const p = await readProject(sessionId);
      if (p) {
        setActiveProject(p);
        setView('workbench');
        // Remember chapter position per project (P5).
        const saved = localStorage.getItem(`bw:chapter:${p.id}`);
        const chapter = p.chapters.find((c) => c.id === saved) ?? p.chapters[0];
        if (chapter?.file) {
          setActiveChapter(chapter.id);
          setChapterText(await readChapter(sessionId, chapter.file));
        }
        // Setup phase (P9): restore previously added material + requirements.
        if (p.status === 'setup') {
          const { files } = await loadMaterialDocs(sessionId);
          setSetupMaterials(files);
          const req = await api().workspaceRead({ sessionId, path: 'input/requirements.md' });
          setSetupReq(req.ok && typeof req.content === 'string' ? req.content : '');
          setSetupBasic({
            client: p.client ?? '', deadline: p.deadline ?? '',
            projectCode: p.projectCode ?? '', template: p.template ?? '',
          });
        }
      }
    })();
  }, [sessionId]);

  // Load all sessions bound to the active project's workspace, sorted by updatedAt (P5).
  useEffect(() => {
    if (!activeProject) return;
    void (async () => {
      const rows = (await api().listChatSessions?.(AGENT_ID)) as SessionMeta[] | undefined;
      const mine = (rows ?? [])
        .filter((r) => r.workspacePath === activeProject.workspacePath)
        .map((r) => ({ id: r.id, updatedAt: r.updatedAt }))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      setProjectSessions(mine);
    })();
  }, [activeProject, sessionId]);

  const selectChapterAndRemember = useCallback(async (chId: string) => {
    setActiveChapter(chId);
    if (activeProject) localStorage.setItem(`bw:chapter:${activeProject.id}`, chId);
    const ch = activeProject?.chapters.find((c) => c.id === chId);
    if (sessionId && ch?.file) setChapterText(await readChapter(sessionId, ch.file));
  }, [activeProject, sessionId]);

  // New EMPTY conversation bound to the SAME fixed workspace (one-step binding,
  // §5.3). P9: no prompt is sent — the user decides what to write next.
  const startNewConversation = useCallback(async () => {
    if (!activeProject) return;
    const res = await api().createSession({
      profileId: AGENT_ID,
      workspacePath: activeProject.workspacePath,
      workspaceKind: 'auto',
    } as never) as PromptResult;
    if (res.sessionId) actions.openSession(res.sessionId);
    else setStatus(res.error ?? '创建会话失败');
  }, [activeProject, actions]);

  // P10 — change the project's storage location (setup only). The whole
  // workspace is relocated by the platform (sessionId unchanged). Order is
  // critical: relocate FIRST (updates session records), THEN write project.json
  // — otherwise P1 would write project.json back into the OLD directory (F1).
  const changeStorageLocation = useCallback(async () => {
    if (!sessionId || !activeProject) return;
    // 包内守卫：写作后锁定「存放位置」（高风险搬目录），与知识库生命周期分离。
    if (activeProject.status !== 'setup') {
      setStatus('开始写作后不可更改存放位置');
      return;
    }
    const sparkii = api();
    try {
      setStatus('正在搬迁工作区…');
      const parent = activeProject.workspacePath.replace(/[\\/][^\\/]+$/, '');
      const picked = await sparkii.chooseWorkspace?.({ defaultPath: parent });
      const newPath = picked?.path;
      if (!newPath) { setStatus('已取消'); return; }
      const r = await sparkii.relocateWorkspace(sessionId, newPath);
      if (!r.ok) {
        const suffix = r.keptBothCopies ? '（已保留两份副本，旧目录仍可用）' : '';
        setStatus(`搬迁失败：${r.code} · ${r.reason}${suffix}`);
        return;
      }
      const updated = { ...activeProject, workspacePath: r.workspacePath };
      setActiveProject(updated);
      await writeProject(sessionId, updated);
      await refreshProjects();
      setStatus(`工作区已搬到：${r.workspacePath}`);
    } catch (e) {
      setStatus(`搬迁失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sessionId, activeProject, refreshProjects]);

  // §9.2 step 2 — upload project-private material (line two). Only text-bearing
  // files can be indexed in-renderer; PDFs are registered by name and parsed by
  // the agent's document.read tool at session time. Data stays in the workspace.
  const addMaterial = useCallback(async () => {
    const sparkii = api();
    try {
      const picked = await sparkii.chooseDocument?.();
      const path = picked?.path;
      if (!path) return;
      const bytes = await sparkii.readDocumentBytes?.(path, null);
      const name = path.split(/[\\/]/).pop() ?? path;
      let text = '';
      if (bytes && !('error' in bytes) && bytes.bytes instanceof ArrayBuffer) {
        if (bytes.kind === 'txt' || /\.(txt|md|csv|json)$/i.test(name)) {
          text = new TextDecoder('utf-8').decode(bytes.bytes);
        } else {
          text = `[二进制资料 ${name}，正文将在会话中由文档解析工具读取]`;
        }
      }
      setDraftMaterials((prev) => [...prev, { name, text }]);
      setStatus(`已添加资料：${name}`);
    } catch {
      setStatus('添加资料失败');
    }
  }, []);

  const toggleDataset = useCallback((id: string) => {
    setDraftDatasetIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }, []);

  // Send a message into the Live Session Pipeline on the bound session.
  // The custom surface owns the composer (the platform does not inject one for
  // `custom` surfaces), and it opts into degraded knowledge so chat keeps
  // working when RAG is unconfigured (§15).
  const sendMessage = useCallback(async () => {
    const text = composerText.trim();
    if (!text || !sessionId) return;
    // P9: a project in setup has not been confirmed for writing yet. The
    // explicit "开始写作" action flips status to drafting before prompts flow.
    if (activeProject?.status === 'setup') {
      setStatus('请先在上方补充信息并点击「确认信息，开始写作」');
      return;
    }
    setSending(true);
    try {
      const res = await api().promptSession(sessionId, text, undefined, undefined, {
        allowDegradedKnowledge: true,
      } as never) as PromptResult;
      if (res?.ok === false) setStatus(res.error ?? '发送失败');
      else setComposerText('');
    } catch (e) {
      setStatus(`发送失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  }, [composerText, sessionId, activeProject]);

  // ── Setup phase (P9) ────────────────────────────────────────────────────
  // All of the following run BEFORE any LLM turn. They only touch workspace
  // files through the fenced P1 IPC + rebuild the project-local index.

  /** Add a reference file to input/ during setup (no LLM involved). */
  const addSetupMaterial = useCallback(async () => {
    if (!sessionId) return;
    const sparkii = api();
    try {
      const picked = await sparkii.chooseDocument?.();
      const path = picked?.path;
      if (!path) return;
      const bytes = await sparkii.readDocumentBytes?.(path, sessionId);
      const name = path.split(/[\\/]/).pop() ?? path;
      let text = '';
      if (bytes && !('error' in bytes) && bytes.bytes instanceof ArrayBuffer) {
        if (bytes.kind === 'txt' || /\.(txt|md|csv|json)$/i.test(name)) {
          text = new TextDecoder('utf-8').decode(bytes.bytes);
        } else {
          text = `[二进制资料 ${name}，正文将在会话中由文档解析工具读取]`;
        }
      }
      const { docs, files } = await loadMaterialDocs(sessionId);
      const safe = name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      const rel = `input/${safe}`;
      await sparkii.workspaceWrite({ sessionId, path: rel, content: text });
      docs[rel] = text;
      const nextFiles = [...files.filter((f) => f.name !== safe), { name: safe, text }];
      const manifest = ['# 项目私有资料清单', '', ...nextFiles.map((f) => `- ${f.name}`)];
      await sparkii.workspaceWrite({ sessionId, path: 'input/manifest.md', content: manifest.join('\n') });
      await buildIndex(sessionId, docs);
      setSetupMaterials(nextFiles);
      setStatus(`已添加资料：${name}`);
    } catch (e) {
      setStatus(`添加资料失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sessionId]);

  /**
   * Persist everything the user prepared (requirements + basic info), flip the
   * project to 'drafting', then dispatch the FIRST prompt. This is the single
   * moment the LLM starts writing — and it is now an explicit user action.
   */
  const confirmStartWriting = useCallback(async () => {
    if (!sessionId || !activeProject || activeProject.status !== 'setup') return;
    setConfirming(true);
    try {
      const sparkii = api();
      // Requirements line two: persist into input/ so every future empty
      // session can load it, and include it in the retrieval index.
      const req = setupReq.trim();
      if (req) {
        await sparkii.workspaceWrite({ sessionId, path: 'input/requirements.md', content: req });
        const { docs } = await loadMaterialDocs(sessionId);
        docs['input/requirements.md'] = req;
        await buildIndex(sessionId, docs);
      }
      const started: ProjectFile = {
        ...activeProject,
        client: setupBasic.client.trim() || activeProject.client,
        deadline: setupBasic.deadline.trim() || activeProject.deadline,
        projectCode: setupBasic.projectCode.trim() || activeProject.projectCode,
        template: setupBasic.template.trim() || activeProject.template,
        status: 'drafting',
        updatedAt: Date.now(),
      };
      await writeProject(sessionId, started);
      setActiveProject(started);
      await refreshProjects();

      // Compose the first prompt from everything the user confirmed. No model
      // work has happened up to this point.
      const kbNames = started.knowledgeBases.map((k) => k.name).join('、') || '（未选）';
      const matNames = setupMaterials.map((m) => m.name).join('、') || '（未上传）';
      const lines = [
        `请开始撰写标书项目「${started.name}」。`,
        `项目元信息：甲方 ${started.client ?? '未填'}；截止日 ${started.deadline ?? '未填'}；编号 ${started.projectCode ?? '未填'}；模板 ${started.template ?? '未填'}。`,
        `公司知识库：${kbNames}。项目参考资料：${matNames}。`,
      ];
      if (req) lines.push(`补充需求与要求：\n${req}`);
      lines.push('请先阅读 project.json、input/ 下的资料清单与补充需求，确认章节大纲后与我讨论；正文按确认的大纲逐章推进。');
      const res = await sparkii.promptSession(sessionId, lines.join('\n'), undefined, undefined, {
        allowDegradedKnowledge: true,
      } as never) as PromptResult;
      if (res?.ok === false) setStatus(res.error ?? '开始写作失败');
      else setStatus('已开始协作写作');
    } catch (e) {
      setStatus(`开始写作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirming(false);
    }
  }, [sessionId, activeProject, setupReq, setupMaterials, setupBasic, refreshProjects]);

  const createProject = useCallback(async () => {
    const name = draftName.trim();
    if (!name) { setStatus('请填写项目名称'); return; }
    const sparkii = api();
    try {
      const { workspacePath } = await sparkii.allocateAutoWorkspace(AGENT_ID);
      // P9: create an EMPTY session bound to the fixed project workspace. No
      // prompt is sent — creating a project does NOT start writing. The user
      // first reviews/adds materials + requirements, then clicks 开始写作.
      const res = await sparkii.createSession({
        profileId: AGENT_ID,
        workspacePath,
        workspaceKind: 'auto',
      } as never) as PromptResult;
      const newSessionId = res.sessionId;
      if (!newSessionId) { setStatus(res.error ?? '创建会话失败'); return; }
      // §6.1 line one — persist selected knowledge bases into project.json.
      const selectedKb = ragDatasets
        .filter((d) => draftDatasetIds.includes(d.id))
        .map((d) => ({ datasetId: d.id, name: d.name }));
      const project = newProject({ id: `bid-${Date.now()}`, name, workspacePath, knowledgeBases: selectedKb });
      // Skeleton first (chapter files live under output/manuscript), then the
      // six independent file writes in parallel — each still goes through the
      // same fenced P1 IPC with its own admission + audit.
      await ensureSkeleton(newSessionId);
      await Promise.all([
        writeProject(newSessionId, project),
        ...project.chapters
          .filter((ch) => Boolean(ch.file))
          .map((ch) => writeChapter(newSessionId, ch.file!, `# ${ch.title}\n\n`)),
      ]);
      // §6.2 line two — persist uploaded material into input/ + build the T1 index.
      if (draftMaterials.length) {
        const docs: Record<string, string> = {};
        const manifest: string[] = ['# 项目私有资料清单', ''];
        for (const m of draftMaterials) {
          const safe = m.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
          const rel = `input/${safe}`;
          await sparkii.workspaceWrite({ sessionId: newSessionId, path: rel, content: m.text });
          docs[rel] = m.text;
          manifest.push(`- ${safe}`);
        }
        await sparkii.workspaceWrite({ sessionId: newSessionId, path: 'input/manifest.md', content: manifest.join('\n') });
        await buildIndex(newSessionId, docs);
      }
      // Bind the session to the selected knowledge bases (line one). Best effort:
      // a RAG outage must not block project creation (§15).
      if (draftDatasetIds.length) {
        try {
          await sparkii.setSessionKnowledge?.(newSessionId, { mode: 'ids', datasetIds: draftDatasetIds });
        } catch { /* keep project; knowledge line can be rebound later */ }
      }
      setWizardOpen(false);
      setWizardStep(1);
      setDraftName('');
      setDraftMaterials([]);
      setDraftDatasetIds([]);
      await refreshProjects();
      actions.openSession(newSessionId);
      setStatus('项目已创建 · 请先补充信息，确认后再开始写作');
    } catch (e) {
      setStatus(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [draftName, draftMaterials, draftDatasetIds, ragDatasets, refreshProjects, actions]);

  const openProject = useCallback(async (p: ProjectFile) => {
    const sparkii = api();
    try {
      // Find or create a session bound to this project's workspace.
      const rows = (await sparkii.listChatSessions?.(AGENT_ID)) as SessionMeta[] | undefined;
      const match = (rows ?? []).find((r) => r.workspacePath === p.workspacePath);
      if (match) {
        actions.openSession(match.id);
      } else {
        // P9 — open with an empty session; no implicit writing prompt.
        const res = await sparkii.createSession({
          profileId: AGENT_ID,
          workspacePath: p.workspacePath,
          workspaceKind: 'auto',
        } as never) as PromptResult;
        if (res.sessionId) {
          // B2 — createSession 只建 record/槽位，不会建目录骨架；不补这一步，
          // 后续 workspaceRead/Write 会报 WORKSPACE_NOT_CREATED。与 createProject 对齐。
          await ensureSkeleton(res.sessionId);
          actions.openSession(res.sessionId);
        } else setStatus(res.error ?? '打开会话失败');
      }
      setActiveProject(p);
      setView('workbench');
    } catch (e) {
      setStatus(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [actions]);

  const saveChapter = useCallback(async () => {
    if (!sessionId || !activeProject || !activeChapter) return;
    const ch = activeProject.chapters.find((c) => c.id === activeChapter);
    if (!ch?.file) return;
    // Snapshot current on-disk content before overwriting (differential + dedup).
    const onDisk = await readChapter(sessionId, ch.file);
    if (onDisk && onDisk !== chapterText) {
      await snapshot(sessionId, { [ch.file]: onDisk }, `编辑前 · ${ch.title}`);
    }
    const ok = await writeChapter(sessionId, ch.file, chapterText);
    if (ok) {
      const vIndex = await loadVersionIndex(sessionId);
      const project = { ...activeProject, version: vIndex.length ? Math.max(...vIndex.map((v) => v.version)) : activeProject.version };
      await writeProject(sessionId, project);
      setActiveProject(project);
    }
    setStatus(ok ? '已保存并生成版本快照' : '保存失败（工作区边界或 IO 错误）');
  }, [sessionId, activeProject, activeChapter, chapterText]);

  const conversation = useMemo(
    () => session.entries.map((e, i) => {
      const role = (e as { role?: string }).role;
      // B3 — tool-deny entries carry no text/content; surface the ruleId/code
      // (e.g. TASK_REVOKED) so a failed workspace op can be located from chat.
      const text = sessionText(e) || toolDenyLabel(e);
      return { key: i, role: role === 'user' ? 'user' : 'assistant', text };
    }).filter((e) => e.text.trim().length > 0),
    [session.entries],
  );

  // Detect a block-scoped AI patch in the latest assistant turn.
  const aiPatch = useMemo(() => {
    for (let i = conversation.length - 1; i >= 0; i--) {
      const t = conversation[i].text;
      if (t.includes('<!-- block:')) {
        const marker = t.indexOf('<!-- block:');
        return t.slice(marker);
      }
    }
    return '';
  }, [conversation]);

  // Apply the AI patch with a three-way merge against the latest version baseline.
  const applyAiPatch = useCallback(async () => {
    if (!sessionId || !activeProject || !activeChapter || !aiPatch) return;
    const ch = activeProject.chapters.find((c) => c.id === activeChapter);
    if (!ch?.file) return;
    const current = await readChapter(sessionId, ch.file);
    const vIndex = await loadVersionIndex(sessionId);
    const baseVersion = vIndex.length ? vIndex[vIndex.length - 1].version : 0;
    const base = baseVersion > 0 ? (await restoreFile(sessionId, baseVersion, ch.file)) ?? '' : '';
    const result = threeWayMerge(base, current, aiPatch);
    if (result.conflicts.length) {
      setStatus(`检测到冲突（块 ${result.conflicts.join(', ')}）：已保留双方，请手动裁决`);
    }
    if (result.applied.length || result.conflicts.length) {
      await snapshot(sessionId, { [ch.file]: current }, `合并前 · ${ch.title}`);
      const ok = await writeChapter(sessionId, ch.file, result.merged);
      setChapterText(result.merged);
      setStatus((prev) => prev.startsWith('检测到冲突') ? prev : (ok ? `已应用补丁（${result.applied.length} 块）` : '应用失败'));
    } else {
      setStatus('补丁无可应用变更');
    }
  }, [sessionId, activeProject, activeChapter, aiPatch]);

  // User-initiated export: compile all manuscript MD + images → DOCX (P4).
  const exportProject = useCallback(async () => {
    if (!sessionId || !activeProject) return;
    const sparkii = api();
    setStatus('正在导出…');
    const chapters: Array<{ title: string; markdown: string }> = [];
    const imageRefs = new Set<string>();
    for (const ch of activeProject.chapters) {
      if (!ch.file) continue;
      const md = await readChapter(sessionId, ch.file);
      chapters.push({ title: ch.title, markdown: md });
      for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) imageRefs.add(m[1]);
    }
    const r = await sparkii.compileDocx({
      sessionId,
      outPath: 'output/final/投标文件.docx',
      title: activeProject.name,
      chapters,
      images: [...imageRefs],
    });
    if (!r.ok) { setStatus('导出失败（工作区边界或编译错误）'); return; }
    const updated = { ...activeProject, status: 'exported' as const };
    await writeProject(sessionId, updated);
    setActiveProject(updated);
    setStatus('已导出到 output/final/投标文件.docx');
  }, [sessionId, activeProject]);

  // Generate a diagram from a graph JSON found in the latest assistant turn.
  const generateFigure = useCallback(async () => {
    if (!sessionId || !activeChapter) return;
    const sparkii = api();
    // Find a JSON object with nodes+edges in the conversation.
    let spec: ReturnType<typeof normalizeSpec> = null;
    for (let i = conversation.length - 1; i >= 0 && !spec; i--) {
      const text = conversation[i].text;
      const start = text.indexOf('{');
      if (start < 0) continue;
      try {
        const parsed = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
        spec = normalizeSpec(parsed);
      } catch { /* not JSON */ }
    }
    if (!spec) { setStatus('未在本轮对话中检测到图结构 JSON'); return; }
    const name = `fig-${Date.now()}`;
    const svg = toSvg(spec);
    const xml = toDrawioXml(spec);
    // Persist BOTH editable sources: draw.io XML (source of truth) and the
    // structured JSON used by the point-and-edit panel (§7.4 path 1).
    await sparkii.workspaceWrite({ sessionId, path: `output/figures/${name}.drawio`, content: xml });
    await sparkii.workspaceWrite({ sessionId, path: `output/figures/${name}.json`, content: JSON.stringify(spec, null, 2) });
    const r = await sparkii.renderDiagram({
      sessionId,
      path: `output/figures/${name}.png`,
      svg,
      sourceXml: xml,
    });
    if (!r.ok) { setStatus('图表渲染失败'); return; }
    const md = `\n\n![${spec.title}](figures/${name}.png)\n`;
    const next = chapterText + md;
    setChapterText(next);
    // Persist the image reference immediately so a later export (which reads
    // from disk) sees it even if the user forgets to press Save (architect §3).
    const ch = activeProject?.chapters.find((c) => c.id === activeChapter);
    if (ch?.file) await writeChapter(sessionId, ch.file, next);
    setStatus(`已生成图表「${spec.title}」并插入正文（已落盘）`);
  }, [sessionId, activeChapter, activeProject, chapterText, conversation]);

  // §7.4 path 1 — point at an image to edit its source (draw.io / structured JSON).
  const editFigure = useCallback(async (src: string) => {
    if (!sessionId) return;
    const name = src.split('/').pop()?.replace(/\.png$/i, '') ?? '';
    const r = await api().workspaceRead({ sessionId, path: `output/figures/${name}.json` });
    if (!r.ok || typeof r.content !== 'string') {
      setStatus('未找到该图的源（.json / .drawio）');
      return;
    }
    setEditingFigure({ name, source: r.content });
  }, [sessionId]);

  const saveFigureSource = useCallback(async () => {
    if (!sessionId || !editingFigure) return;
    const parsed = normalizeSpec(JSON.parse(editingFigure.source));
    if (!parsed) { setStatus('图源 JSON 无效，未保存'); return; }
    const xml = toDrawioXml(parsed);
    await api().workspaceWrite({ sessionId, path: `output/figures/${editingFigure.name}.json`, content: JSON.stringify(parsed, null, 2) });
    await api().workspaceWrite({ sessionId, path: `output/figures/${editingFigure.name}.drawio`, content: xml });
    const r = await api().renderDiagram({
      sessionId,
      path: `output/figures/${editingFigure.name}.png`,
      svg: toSvg(parsed),
      sourceXml: xml,
    });
    if (!r.ok) { setStatus('图源已保存，但重渲染失败'); return; }
    setStatus('图源已更新并重渲染');
    setEditingFigure(null);
  }, [sessionId, editingFigure]);

  // On-demand retrieval over the project material index (T1).
  const [materialQuery, setMaterialQuery] = useState('');
  const [materialHits, setMaterialHits] = useState<Array<{ file: string; text: string; score: number }>>([]);
  const searchMaterials = useCallback(async () => {
    if (!sessionId || !materialQuery.trim()) return;
    const index = await loadMaterialIndex(sessionId);
    if (!index) { setStatus('资料索引未建立（导入资料后会自动建立）'); return; }
    const hits = retrieve(index, materialQuery, 5);
    setMaterialHits(hits.map((h) => ({ file: h.file, text: h.text, score: h.score })));
  }, [sessionId, materialQuery]);

  // ── Project list view ────────────────────────────────────────────────────
  if (view === 'list' || !sessionId) {
    return (
      <div className="bw-root bw-list">
        <div className="bw-list-head">
          <h2>我的标书项目</h2>
          <button className="bw-btn bw-btn-primary" onClick={() => { setWizardStep(1); setWizardOpen(true); }}>＋ 新建项目</button>
        </div>
        {wizardOpen && (
          <div className="bw-wizard">
            <div className="bw-wizard-steps">
              <span className={wizardStep === 1 ? 'active' : ''}>① 基本信息</span>
              <span className={wizardStep === 2 ? 'active' : ''}>② 项目资料</span>
              <span className={wizardStep === 3 ? 'active' : ''}>③ 知识库</span>
            </div>
            {wizardStep === 1 && (
              <>
                <label>项目名称（必填）</label>
                <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="如：智慧园区智能化项目 · 投标文件" />
              </>
            )}
            {wizardStep === 2 && (
              <>
                <label>项目私有资料（可选，可稍后补录）</label>
                <div className="bw-wizard-actions">
                  <button className="bw-btn" onClick={() => void addMaterial()}>＋ 添加资料</button>
                </div>
                {draftMaterials.length === 0
                  ? <div className="bw-hint">未添加资料，可跳过。</div>
                  : <ul className="bw-mat-list">{draftMaterials.map((m, i) => (
                      <li key={i}>{m.name}
                        <button className="bw-btn bw-btn-small" onClick={() => setDraftMaterials((p) => p.filter((_, j) => j !== i))}>移除</button>
                      </li>
                    ))}</ul>}
              </>
            )}
            {wizardStep === 3 && (
              <>
                <label>公司知识库（可选，可稍后补录）</label>
                {ragDatasets.length === 0
                  ? <div className="bw-hint">未检测到可用知识库连接，可跳过（资料线仍可用）。</div>
                  : <ul className="bw-kb-list">{ragDatasets.map((d) => (
                      <li key={d.id}>
                        <label>
                          <input type="checkbox" checked={draftDatasetIds.includes(d.id)} onChange={() => toggleDataset(d.id)} />
                          {d.name}
                        </label>
                      </li>
                    ))}</ul>}
              </>
            )}
            <div className="bw-wizard-actions">
              <button className="bw-btn" onClick={() => setWizardOpen(false)}>取消</button>
              {wizardStep > 1 && <button className="bw-btn" onClick={() => setWizardStep((s) => (s - 1) as 1 | 2)}>上一步</button>}
              {wizardStep < 3 && <button className="bw-btn" onClick={() => setWizardStep((s) => (s + 1) as 2 | 3)}>下一步</button>}
              <button className="bw-btn bw-btn-primary" onClick={() => void createProject()}>创建</button>
            </div>
          </div>
        )}
        <div className="bw-cards">
          {projects.map((p) => (
            <button key={p.id} className="bw-card" onClick={() => void openProject(p)}>
              <div className="bw-card-title">{p.name}</div>
              <div className="bw-card-meta">
                <span>{p.client ?? '未填甲方'}</span>
                <span className={`bw-badge ${p.status}`}>{p.status === 'exported' ? '已导出' : p.status === 'setup' ? '准备中' : '编制中'}</span>
              </div>
              <div className="bw-card-progress">章节 {p.progress.done}/{p.progress.total} · 版本 v{p.version}</div>
            </button>
          ))}
          {projects.length === 0 && <div className="bw-empty">还没有项目，点"＋ 新建项目"开始。</div>}
        </div>
        {status && <div className="bw-status">{status}</div>}
      </div>
    );
  }

  // ── Workbench: three columns ────────────────────────────────────────────
  return (
    <div className="bw-root bw-workbench">
      <div className="bw-topbar">
        <button className="bw-btn" onClick={() => setView('list')}>← 项目列表</button>
        <span className="bw-topbar-title">{activeProject?.name ?? '标书项目'}</span>
        <span className="bw-topbar-meta">版本 v{activeProject?.version ?? 1}</span>
        <button className="bw-btn bw-workspace-btn" onClick={() => setWorkspaceDrawerOpen((v) => !v)}>工作区</button>
        <button className="bw-btn bw-btn-primary bw-export" onClick={() => void exportProject()}>导出 Word</button>
      </div>
      {workspaceDrawerOpen && (
        <div className="bw-ws-drawer">
          <div className="bw-ws-drawer-head">
            <b>工作区</b>
            <button className="bw-btn bw-btn-small" onClick={() => setWorkspaceDrawerOpen(false)}>收起</button>
          </div>
          <div className="bw-ws-path" title={activeProject?.workspacePath}>{activeProject?.workspacePath ?? '（无）'}</div>
          <div className="bw-ws-actions">
            <button className="bw-btn bw-btn-small" onClick={() => void api().openWorkspace?.(activeProject?.workspacePath ?? '')}>在文件夹中打开</button>
            {activeProject?.status === 'setup' ? (
              <button className="bw-btn bw-btn-small" onClick={() => void changeStorageLocation()}>更改存放位置</button>
            ) : (
              <span className="bw-hint">开始写作后存放位置锁定</span>
            )}
          </div>
          <div className="bw-hint">准备阶段可更改存放位置（整体搬迁工作区，会话与知识库绑定保留）。</div>
        </div>
      )}
      {activeProject?.status === 'setup' && (
        <div className="bw-setup">
          <div className="bw-setup-head">
            <span className="bw-setup-badge">准备阶段 · 尚未开始写作</span>
            <span className="bw-hint">该项目已建好空骨架，但还没开始写作。可先补全信息，全部确认后再开始协作。</span>
          </div>
          <div className="bw-setup-grid">
            <div className="bw-setup-col">
              <div className="bw-col-title">项目基本信息（选填）</div>
              <label>甲方<input value={setupBasic.client} onChange={(e) => setSetupBasic((b) => ({ ...b, client: e.target.value }))} placeholder="如：某某管委会" /></label>
              <label>截止日期<input value={setupBasic.deadline} onChange={(e) => setSetupBasic((b) => ({ ...b, deadline: e.target.value }))} placeholder="如：2026-12-31" /></label>
              <label>项目编号<input value={setupBasic.projectCode} onChange={(e) => setSetupBasic((b) => ({ ...b, projectCode: e.target.value }))} /></label>
              <label>模板<input value={setupBasic.template} onChange={(e) => setSetupBasic((b) => ({ ...b, template: e.target.value }))} placeholder="如：政府招标文件模板" /></label>
            </div>
            <div className="bw-setup-col">
              <div className="bw-col-title">参考资料（可选，可稍后补录）</div>
              <button className="bw-btn" onClick={() => void addSetupMaterial()}>＋ 添加资料</button>
              {setupMaterials.length === 0
                ? <div className="bw-hint">未添加资料。</div>
                : <ul className="bw-mat-list">{setupMaterials.map((m, i) => (
                    <li key={i}>{m.name}</li>
                  ))}</ul>}
              <div className="bw-hint">已绑定知识库：{activeProject.knowledgeBases.map((k) => k.name).join('、') || '（未选）'}</div>
            </div>
            <div className="bw-setup-col bw-setup-wide">
              <div className="bw-col-title">补充需求 / 写作要求（选填）</div>
              <textarea
                className="bw-setup-req"
                value={setupReq}
                onChange={(e) => setSetupReq(e.target.value)}
                placeholder="例如：重点突出技术方案；按甲方评分办法组织章节；报价须含三年维保…"
                rows={4}
              />
            </div>
          </div>
          <div className="bw-setup-actions">
            <span className="bw-hint">以上都补充完成后再开始，写作会在你确认后才启动。</span>
            <button
              className="bw-btn bw-btn-primary"
              disabled={confirming}
              onClick={() => void confirmStartWriting()}
            >{confirming ? '正在开始…' : '确认信息，开始写作 →'}</button>
          </div>
        </div>
      )}
      <div className="bw-columns">
        <aside className="bw-col bw-outline">
          <div className="bw-col-title">章节大纲</div>
          <ul>
            {(activeProject?.chapters ?? []).map((ch) => (
              <li key={ch.id}>
                <button
                  className={activeChapter === ch.id ? 'active' : ''}
                  onClick={() => void selectChapterAndRemember(ch.id)}
                >
                  {ch.id} · {ch.title}
                </button>
              </li>
            ))}
          </ul>
          <div className="bw-col-title bw-conv-title">资料检索</div>
          <div className="bw-search">
            <input
              value={materialQuery}
              onChange={(e) => setMaterialQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void searchMaterials(); }}
              placeholder="搜索项目资料…"
            />
            <button className="bw-btn bw-btn-small" onClick={() => void searchMaterials()}>搜索</button>
          </div>
          {materialHits.map((hit, i) => (
            <div key={i} className="bw-hit" title={hit.text}>
              <span className="bw-hit-src">资料 · {hit.file}</span>
              <span className="bw-hit-snippet">{hit.text.slice(0, 60)}…</span>
            </div>
          ))}
          <div className="bw-col-title bw-conv-title">
            对话记录
            <button className="bw-btn bw-btn-small" title="新对话（绑定同一项目）" onClick={() => void startNewConversation()}>＋</button>
          </div>
          <div className="bw-search">
            <input
              value={convQuery}
              onChange={(e) => setConvQuery(e.target.value)}
              placeholder="搜索对话…"
            />
          </div>
          <div className="bw-conv-list">
            {projectSessions
              .filter((s) => !convQuery.trim() || s.id.toLowerCase().includes(convQuery.trim().toLowerCase()))
              .map((s) => (
                <button
                  key={s.id}
                  className={`bw-conv-item${s.id === sessionId ? ' active' : ''}`}
                  onClick={() => actions.openSession(s.id)}
                >
                  <span>会话 {s.id.slice(0, 8)}</span>
                  <span className="bw-hint">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}</span>
                </button>
              ))}
          </div>
        </aside>

        <main className="bw-col bw-manuscript">
          <div className="bw-col-title">{activeProject?.chapters.find((c) => c.id === activeChapter)?.title ?? '正文'}</div>
          <WysiwygEditor
            value={chapterText}
            sessionId={sessionId}
            onChange={setChapterText}
            onEditFigure={(src) => void editFigure(src)}
            placeholder="在此撰写章节正文…"
          />
          <div className="bw-editor-bar">
            <button className="bw-btn bw-btn-primary" onClick={() => void saveChapter()}>保存</button>
            <button className="bw-btn" onClick={() => void generateFigure()}>从对话生成图表</button>
            <span className="bw-status">{status}</span>
          </div>
        </main>

        <aside className="bw-col bw-conversation">
          <div className="bw-col-title">
            本次对话
            <button className="bw-btn bw-btn-small" onClick={() => void startNewConversation()} title="新对话（绑定同一项目）">＋</button>
          </div>
          <div className="bw-messages">
            {conversation.map((m) => (
              <div key={m.key} className="bw-msg"><span className="bw-role">{m.role === 'user' ? '我' : '助手'}</span>{m.text}</div>
            ))}
            {conversation.length === 0 && <div className="bw-hint">发送消息开始写作或微调…</div>}
          </div>
          {aiPatch && (
            <button className="bw-btn bw-apply-patch" onClick={() => void applyAiPatch()}>
              应用本轮章节补丁（块级合并）
            </button>
          )}
          {activeContext.length > 0 && (
            <div className="bw-sources">
              <div className="bw-sources-title">引用来源（不可信数据，已隔离标注）</div>
              {activeContext.map((b, i) => (
                <span key={i} className="bw-source-chip" title={b.text.slice(0, 160)}>{sourceChip(b)}</span>
              ))}
            </div>
          )}
          <div className="bw-composer">
            <textarea
              className="bw-composer-input"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendMessage(); }
              }}
              placeholder="描述要写或要改的内容，Ctrl/⌘+Enter 发送…"
              rows={2}
            />
            <button
              className="bw-btn bw-btn-primary"
              disabled={sending || !composerText.trim()}
              onClick={() => void sendMessage()}
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
          <div className="bw-disclaimer">对话复用平台 Live Session Pipeline</div>
        </aside>
      </div>
      {editingFigure && (
        <div className="bw-modal-backdrop" onClick={() => setEditingFigure(null)}>
          <div className="bw-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bw-modal-title">编辑图表源 · {editingFigure.name}</div>
            <div className="bw-modal-hint">修改图结构 JSON（节点/连线），保存后自动重绘 PNG 与 draw.io 源。</div>
            <textarea
              className="bw-figure-source"
              value={editingFigure.source}
              onChange={(e) => setEditingFigure({ ...editingFigure, source: e.target.value })}
            />
            <div className="bw-modal-actions">
              <button className="bw-btn" onClick={() => setEditingFigure(null)}>取消</button>
              <button className="bw-btn bw-btn-primary" onClick={() => void saveFigureSource()}>保存并重绘</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
