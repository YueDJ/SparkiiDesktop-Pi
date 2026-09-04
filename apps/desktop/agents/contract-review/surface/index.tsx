import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextUsageBar, Markdown, ModelEffortControl, RiskBadge, THINKING_LEVELS } from '@sparkii/ui';
import type { AgentSession, AgentSurfaceActions, AgentSurfaceProps, CustomSessionEntry } from '../../../src/surface/contract.js';
import { deriveWorkflowTimeline, extractWorkflowResult } from '../../../src/surface/normalize.js';
import { captureReportHtml, formatReport, parseRiskFindings, reportExportPath } from './contract.js';
import { contractSessionTitle } from './title.js';
import { bytesToBase64, documentFromHtml } from './report-docx.js';
import { DocumentPreview, formatFileSize, kindLabel, type PreviewKind } from './DocumentPreview.js';
import './styles.css';

const PREVIEW_EXTENSIONS = ['pdf', 'docx', 'txt'];

type PreviewResult = { kind: PreviewKind; fileName: string; fileSize: number; bytes: ArrayBuffer };
type PreviewError = 'missing' | 'unsupported' | 'too_large' | 'denied';

function previewErrorText(error: PreviewError): string {
  if (error === 'missing') return '无法找到原文件';
  if (error === 'unsupported') return '暂不支持预览该文件类型';
  if (error === 'too_large') return '文件过大，无法预览';
  return '无法预览该文件';
}

function kindFromName(name: string): PreviewKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt')) return 'txt';
  return null;
}

type ReviewState = 'none' | 'confirmed' | 'ignored' | 'escalated';

interface SparkiiWindowApi {
  getModelOptions?(agentId?: string): Promise<{
    defaultModel?: string | null;
    models?: string[];
    provider?: string;
  }>;
  getChatSession?(sessionId: string): Promise<{ model?: string | null; thinkingLevel?: string | null; workspacePath?: string | null }>;
  getChatState?(sessionId: string): Promise<{ contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null }>;
  setChatModel?(sessionId: string, model: string | null): Promise<unknown>;
  setChatThinkingLevel?(sessionId: string, level: string | null): Promise<unknown>;
  listThinkingLevels?(providerId: string, modelId: string): Promise<string[]>;
  chooseWorkspace?(): Promise<{ path?: string }>;
  setChatWorkspace?(sessionId: string, path: string | null): Promise<unknown>;
  setChatTitle?(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>;
  on?(event: string, cb: (payload: unknown) => void): () => void;
  appendError?(rec: { id: string; message: string; source: string; createdAt: number }): Promise<unknown>;
}

const EMPTY_SESSION: AgentSession = { entries: [], streaming: false, status: 'idle', meta: { currentStep: null } };

function sparkiiApi(): SparkiiWindowApi {
  return ((window as any).sparkii ?? {}) as SparkiiWindowApi;
}

function reviewStateEntries(entries: AgentSession['entries']): CustomSessionEntry[] {
  return entries.filter((e): e is CustomSessionEntry => e.kind === 'custom' && e.customType === 'workflow_state');
}

function stateAction(e: CustomSessionEntry): string {
  return String(e.data.action ?? '');
}

function statePayload(e: CustomSessionEntry): Record<string, unknown> {
  const payload = e.data.payload;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function initialReviewState(entries: AgentSession['entries']): Record<string, ReviewState> {
  const next: Record<string, ReviewState> = {};
  for (const e of reviewStateEntries(entries)) {
    const payload = statePayload(e);
    const riskId = typeof payload.riskId === 'string' ? payload.riskId : '';
    if (!riskId) continue;
    const action = stateAction(e);
    if (action === 'risk_confirmed') next[riskId] = 'confirmed';
    if (action === 'risk_ignored') next[riskId] = 'ignored';
    if (action === 'risk_escalated') next[riskId] = 'escalated';
  }
  return next;
}

function initialNotes(entries: AgentSession['entries']): Record<string, string> {
  const next: Record<string, string> = {};
  for (const e of reviewStateEntries(entries)) {
    const payload = statePayload(e);
    const riskId = typeof payload.riskId === 'string' ? payload.riskId : '';
    const note = typeof payload.note === 'string' ? payload.note : '';
    if (riskId && note) next[riskId] = note;
  }
  return next;
}

function wasReportMerged(entries: AgentSession['entries']): boolean {
  return reviewStateEntries(entries).some((e) => stateAction(e) === 'report_merged');
}

function hasStepStart(entries: AgentSession['entries'], stepId: string): boolean {
  return entries.some((e) => e.kind === 'custom' && e.customType === 'workflow_step_start' && String(e.data.stepId) === stepId);
}

function hasStepEnd(entries: AgentSession['entries'], stepId: string): boolean {
  return entries.some((e) => e.kind === 'custom' && e.customType === 'workflow_step_end' && String(e.data.stepId) === stepId);
}

function hasStepOutput(result: Record<string, unknown>, stepId: string): boolean {
  return Object.prototype.hasOwnProperty.call(result, stepId);
}

function riskLevelLabel(level: string): '高风险' | '中风险' | '低风险' {
  return level === 'high' ? '高风险' : level === 'low' ? '低风险' : '中风险';
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function reviewLabel(state: ReviewState): string {
  if (state === 'confirmed') return '已确认';
  if (state === 'ignored') return '已忽略';
  if (state === 'escalated') return '已升级';
  return '未处理';
}

function ModelEffortBar({
  agentId,
  sessionId,
  session,
  onPrefs,
}: {
  agentId: string;
  sessionId: string | null;
  session: AgentSession;
  onPrefs?: (prefs: { workspacePath: string | null; model: string | null; thinkingLevel: string | null }) => void;
}) {
  const api = sparkiiApi();
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState<string | null>(session.meta.model ?? null);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([...THINKING_LEVELS]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(session.meta.workspacePath ?? null);
  const [contextUsage, setContextUsage] = useState<{ tokens?: number | null; contextWindow?: number; percent?: number | null } | null>(session.meta.contextUsage ?? null);

  useEffect(() => {
    setModel(session.meta.model ?? null);
    setWorkspacePath(session.meta.workspacePath ?? null);
    if (session.meta.contextUsage) setContextUsage(session.meta.contextUsage);
  }, [session.meta.model, session.meta.workspacePath, session.meta.contextUsage]);

  useEffect(() => {
    onPrefs?.({ workspacePath, model, thinkingLevel });
  }, [onPrefs, workspacePath, model, thinkingLevel]);

  useEffect(() => {
    void api.getModelOptions?.(agentId).then((r) => {
      if (!r) return;
      setModels(Array.isArray(r.models) ? r.models : []);
      setDefaultModel(r.defaultModel ?? null);
      setProvider(r.provider ?? 'deepseek');
    }).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    if (!sessionId) {
      setContextUsage(null);
      return;
    }
    const refresh = () => {
      void api.getChatSession?.(sessionId).then((rec) => {
        if (!rec) return;
        if (rec.workspacePath) setWorkspacePath(rec.workspacePath);
        if (rec.thinkingLevel !== undefined) setThinkingLevel(rec.thinkingLevel ?? null);
        if (rec.model) setModel(rec.model);
      }).catch(() => {});
      void api.getChatState?.(sessionId).then((state) => {
        if (state?.contextUsage) setContextUsage(state.contextUsage);
      }).catch(() => {});
    };
    refresh();
    const off = api.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      if (p?.type === 'agent_end' || p?.type === 'agent_settled' || p?.type === 'compaction_end' || p?.type === 'message') refresh();
    });
    const timer = setInterval(refresh, 3000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [sessionId]);

  const refreshThinkingLevels = (nextModel: string | null) => {
    const target = nextModel ?? defaultModel;
    if (!target) { setThinkingLevels([...THINKING_LEVELS]); return; }
    const slash = target.indexOf('/');
    const modelId = slash >= 0 ? target.slice(slash + 1) : target;
    void api.listThinkingLevels?.(provider, modelId).then((levels) => {
      setThinkingLevels(levels?.length ? levels : [...THINKING_LEVELS]);
    }).catch(() => setThinkingLevels([...THINKING_LEVELS]));
  };

  const publishPrefs = (next: { workspacePath?: string | null; model?: string | null; thinkingLevel?: string | null }) => {
    const prefs = {
      workspacePath: next.workspacePath !== undefined ? next.workspacePath : workspacePath,
      model: next.model !== undefined ? next.model : model,
      thinkingLevel: next.thinkingLevel !== undefined ? next.thinkingLevel : thinkingLevel,
    };
    onPrefs?.(prefs);
  };

  const onModelChange = (next: string | null) => {
    setModel(next);
    publishPrefs({ model: next });
    if (sessionId) void api.setChatModel?.(sessionId, next);
    refreshThinkingLevels(next);
  };

  const onThinkingLevelChange = (next: string | null) => {
    setThinkingLevel(next);
    publishPrefs({ thinkingLevel: next });
    if (sessionId) void api.setChatThinkingLevel?.(sessionId, next);
  };

  const workspaceName = workspacePath
    ? (workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath)
    : '未选择工作区';

  return (
    <div className="contract-model-bar">
      <button
        type="button"
        className="ui-composer-ws-btn"
        data-testid="workspace"
        title={workspacePath ?? ''}
        onClick={() => {
          void api.chooseWorkspace?.().then(({ path } = {}) => {
            if (!path) return;
            setWorkspacePath(path);
            publishPrefs({ workspacePath: path });
            if (sessionId) void api.setChatWorkspace?.(sessionId, path);
          });
        }}
      >
        <span className="contract-model-ws-name">{workspaceName}</span>
      </button>
      <ContextUsageBar
        contextUsage={contextUsage && {
          ...contextUsage,
          percent: contextUsage.percent ?? (
            typeof contextUsage.tokens === 'number' && contextUsage.contextWindow
              ? (contextUsage.tokens / contextUsage.contextWindow) * 100
              : null
          ),
        }}
      />
      <ModelEffortControl
        model={model}
        defaultModel={defaultModel}
        models={models}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        placement="bottom"
        onModelChange={onModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
      />
    </div>
  );
}

export function ContractAgentSurface(props: AgentSurfaceProps) {
  const { sessionId, session: rawSession, actions } = props;
  const [discardSession, setDiscardSession] = useState(false);
  const prevSessionId = useRef(sessionId);
  // 点「新会话」后平台会短暂仍传入上一会话；丢弃后只展示空白草稿。
  const session = discardSession ? EMPTY_SESSION : rawSession;
  const timeline = deriveWorkflowTimeline(session.entries);
  const status = session.status && session.status !== 'idle' ? session.status : timeline.status;
  const currentStep = session.meta.currentStep ?? timeline.step ?? null;
  const result = session.result ?? extractWorkflowResult(session.entries);
  const reviewPayload = (result?.['review'] ?? result?.['compare']) as unknown;
  const findings = parseRiskFindings(reviewPayload);
  const report = formatReport(result?.['report']);
  const reviewed = initialReviewState(session.entries);
  const notes = initialNotes(session.entries);
  const reportMerged = wasReportMerged(session.entries);
  const reviewPending = hasStepStart(session.entries, 'review') && !hasStepEnd(session.entries, 'review') && !hasStepOutput(result, 'review');
  const reportPending = hasStepStart(session.entries, 'report') && !hasStepEnd(session.entries, 'report') && !hasStepOutput(result, 'report');
  const inputs = session.meta.inputs ?? [];
  const firstInput = inputs[0];
  const fileName = firstInput?.name ?? (firstInput?.path ? basename(firstInput.path) : '');
  const [documents, setDocuments] = useState<string[]>(inputs.map((i) => i.path));
  const [localFileName, setLocalFileName] = useState<string>('');
  const inputsKey = inputs.map((i) => i.path).join('\u0000');
  const lastInputsKey = useRef(inputsKey);
  useEffect(() => {
    if (discardSession || !sessionId) {
      if (!sessionId && !discardSession && inputsKey !== lastInputsKey.current) {
        lastInputsKey.current = inputsKey;
        setDocuments(inputs.map((i) => i.path));
      }
      return;
    }
    if (inputsKey === lastInputsKey.current) return;
    lastInputsKey.current = inputsKey;
    setDocuments((prev) => Array.from(new Set([...inputs.map((i) => i.path), ...prev])));
  }, [inputsKey, sessionId, discardSession]);
  const [noteDraft, setNoteDraft] = useState<Record<string, string | undefined>>({});
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'high' | 'mid' | 'low' | 'unprocessed'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runPrefs, setRunPrefs] = useState<{ workspacePath: string | null; model: string | null; thinkingLevel: string | null }>({
    workspacePath: null, model: null, thinkingLevel: null,
  });
  const previewRef = useRef<HTMLDivElement>(null);
  const titledSessions = useRef(new Set<string>());
  const [docPreview, setDocPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<PreviewError | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewPath = firstInput?.missing ? '' : (documents[0] || firstInput?.path || '');
  useEffect(() => {
    if (!previewPath) {
      setDocPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    void actions.readDocumentBytes(previewPath).then((res) => {
      if (cancelled) return;
      setPreviewLoading(false);
      if ('error' in res) {
        setDocPreview(null);
        setPreviewError(res.error);
        return;
      }
      setDocPreview(res);
      setPreviewError(null);
    }).catch(() => {
      if (cancelled) return;
      setPreviewLoading(false);
      setDocPreview(null);
      setPreviewError('denied');
    });
    return () => { cancelled = true; };
  }, [previewPath, sessionId]);
  useEffect(() => {
    const leftSession = Boolean(prevSessionId.current) && !sessionId;
    prevSessionId.current = sessionId;
    if (sessionId) setDiscardSession(false);
    else if (leftSession) setDiscardSession(true);
    setFilter('all');
    setSelected(new Set());
    setNoteDraft({});
    setLocalFileName('');
    if (leftSession || (!sessionId && discardSession)) {
      setDocuments([]);
      lastInputsKey.current = '';
      return;
    }
    setDocuments(inputs.map((i) => i.path));
    lastInputsKey.current = inputsKey;
  }, [sessionId]);

  const processedCount = Object.values(reviewed).filter((v) => v !== 'none').length;
  const unprocessed = findings.filter((f) => !reviewed[f.id] || reviewed[f.id] === 'none');
  const unprocessedHigh = unprocessed.filter((f) => f.level === 'high').length;
  const highCount = findings.filter((f) => f.level === 'high').length;
  const midCount = findings.filter((f) => f.level === 'mid').length;
  const lowCount = findings.filter((f) => f.level === 'low').length;
  const filteredFindings = findings.filter((f) => {
    const state = reviewed[f.id] ?? 'none';
    if (filter === 'unprocessed') return state === 'none';
    if (filter === 'all') return true;
    return f.level === filter;
  });
  const hasSelection = filteredFindings.some((f) => selected.has(f.id));

  const applyReview = (id: string, action: Exclude<ReviewState, 'none'>) => {
    actions.review(`risk_${action}`, { stepId: 'review', payload: { riskId: id } });
  };

  const saveNote = (id: string) => {
    const text = (noteDraft[id] ?? '').trim();
    if (!text) return;
    setNoteDraft((prev) => ({ ...prev, [id]: undefined }));
    actions.review('risk_comment', { stepId: 'review', payload: { riskId: id, note: text } });
  };

  const mergeReport = () => {
    actions.review('report_merged', { stepId: 'report' });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const batchConfirm = () => {
    for (const f of filteredFindings) {
      if (selected.has(f.id)) applyReview(f.id, 'confirmed');
    }
  };

  const batchIgnore = () => {
    for (const f of filteredFindings) {
      if (selected.has(f.id)) applyReview(f.id, 'ignored');
    }
  };

  const chooseDocument = async () => {
    if (documents[0] || localFileName) return;
    const res = await actions.chooseDocument({ extensions: PREVIEW_EXTENSIONS });
    if (res?.path) {
      setDocuments([res.path]);
      setLocalFileName(basename(res.path));
    }
  };

  const removeLocalDocument = () => {
    setDocuments([]);
    setLocalFileName('');
  };

  const auditStep = currentStep === 'load' || currentStep === 'search' || currentStep === 'review';
  const reportStep = currentStep === 'report';
  const auditStageState = status === 'failed' && auditStep
    ? 'warn'
    : status === 'done' || status === 'failed' || (status === 'running' && reportStep)
      ? 'done'
      : status === 'running' && (auditStep || !reportStep)
        ? 'active'
        : 'pending';
  const reportStageState = status === 'failed' && reportStep
    ? 'warn'
    : status === 'done' || (status === 'failed' && !auditStep)
      ? 'done'
      : status === 'running' && reportStep
        ? 'active'
        : 'pending';
  const reviewNodeState = reportMerged ? 'done' : findings.length === 0 ? 'pending' : unprocessed.length ? 'warn' : 'ready';
  const reviewNodeClass = reviewNodeState === 'warn' ? 'warn' : reviewNodeState === 'done' ? 'done' : reviewNodeState === 'ready' ? 'ready' : 'pending';

  const reportBlocks = useMemo(() => {
    if (!report) return '';
    return report.blocks.map((b) => `${b.heading ? `## ${b.heading}` : ''}\n${b.body}`).join('\n\n');
  }, [report]);

  const selectedName = fileName || localFileName || (documents[0] ? basename(documents[0]) : '');
  useEffect(() => {
    if (!sessionId || !selectedName) return;
    if (props.mode === 'history') return;
    if (props.title?.trim()) return;
    if (titledSessions.current.has(sessionId)) return;
    titledSessions.current.add(sessionId);
    void sparkiiApi().setChatTitle?.(sessionId, contractSessionTitle(selectedName), 'agent');
  }, [sessionId, selectedName, props.title, props.mode]);

  const resetDraft = () => {
    setDocuments([]);
    setLocalFileName('');
    setFilter('all');
    setSelected(new Set());
    setNoteDraft({});
    lastInputsKey.current = '';
  };

  const startNewSession = () => {
    resetDraft();
    setDiscardSession(true);
    actions.newSession();
  };

  const canMerge = !reportMerged && (findings.length > 0 || Boolean(report));

  return (
    <div className="contract-workbench">
      <header className="contract-header">
        <div className="contract-header-main">
          <span className="contract-header-title">{props.agent.name}</span>
          {selectedName && <span className="contract-header-subtitle">{selectedName}</span>}
          <span className="contract-status" data-testid="workflow-status">
            {status === 'running' ? `审核中：${currentStep ?? '…'}` : status === 'done' ? '审核完成' : status === 'failed' ? '审核失败' : ''}
          </span>
        </div>
        <div className="contract-header-right">
          <ModelEffortBar agentId={props.agent.id} sessionId={sessionId} session={session} onPrefs={setRunPrefs} />
          {status === 'idle' && (
            <>
              {!selectedName && (
                <button type="button" className="ui-btn ui-btn--ghost" data-testid="upload" onClick={chooseDocument}>
                  选择合同文件
                </button>
              )}
              {selectedName && (
                <button type="button" className="ui-btn ui-btn--ghost" data-testid="remove-document" onClick={removeLocalDocument}>
                  移除
                </button>
              )}
              <button
                type="button"
                className="ui-btn ui-btn--primary"
                data-testid="review"
                disabled={!documents.length}
                onClick={() => actions.startWorkflow({
                  documents,
                  workspacePath: runPrefs.workspacePath,
                  model: runPrefs.model,
                  thinkingLevel: runPrefs.thinkingLevel,
                })}
              >
                开始审核
              </button>
            </>
          )}
          {status !== 'idle' && (
            <button type="button" className="ui-btn" data-testid="new-review" onClick={startNewSession}>
              新会话
            </button>
          )}
        </div>
      </header>

      <div className="contract-stage">
        <span className={`contract-stage-item ${auditStageState}`}><span className="contract-stage-dot" />审核</span>
        <span className="contract-stage-sep" />
        <span className={`contract-stage-item ${reportStageState}`}><span className="contract-stage-dot" />报告</span>
        <span className="contract-stage-sep" />
        <span className={`contract-stage-item human ${reviewNodeClass}`}>
          <span className="contract-stage-dot" />复核
        </span>
      </div>

      <div className={`contract-split ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
        <section className="contract-panel contract-panel--doc">
          <header className="contract-panel-head">
            <b>合同原文</b>
            {firstInput?.missing && <span className="contract-missing">无法找到原文件</span>}
            <button
              type="button"
              className="contract-collapse-btn"
              aria-label={leftCollapsed ? '展开合同原文' : '收起合同原文'}
              onClick={() => {
                if (leftCollapsed) setLeftCollapsed(false);
                else { setLeftCollapsed(true); setRightCollapsed(false); }
              }}
            >
              {leftCollapsed ? '›' : '‹'}
            </button>
          </header>
          <span className="contract-panel-rail-label">合同原文</span>
          <div className="contract-panel-body">
            {firstInput?.missing ? (
              <div className="contract-missing-note">无法找到原文件，风险发现与报告仍可从会话历史恢复。</div>
            ) : selectedName ? (
              <>
                <div className="contract-doc contract-doc-head">
                  <div className="contract-doc-icon">{kindLabel(docPreview?.kind ?? kindFromName(selectedName) ?? 'txt')}</div>
                  <div>
                    <div className="contract-doc-name">{selectedName}</div>
                    <div className="contract-doc-meta">
                      {kindLabel(docPreview?.kind ?? kindFromName(selectedName) ?? 'txt')}
                      {docPreview ? ` · ${formatFileSize(docPreview.fileSize)}` : ''}
                    </div>
                  </div>
                </div>
                <div className="contract-doc-body">
                  {previewLoading && <div className="contract-doc-note">正在加载原文…</div>}
                  {!previewLoading && previewError && <div className="contract-doc-note">{previewErrorText(previewError)}</div>}
                  {!previewLoading && docPreview && <DocumentPreview kind={docPreview.kind} bytes={docPreview.bytes} />}
                </div>
              </>
            ) : (
              <div className="contract-panel-empty">
                <div>尚未选择合同文件</div>
              </div>
            )}
          </div>
        </section>

        <section className="contract-panel contract-panel--risk">
          <header className="contract-panel-head">
            <b>风险发现</b>
            <span className="contract-panel-hint">已复核 {processedCount} / {findings.length}</span>
            <button
              type="button"
              className="contract-collapse-btn"
              aria-label={rightCollapsed ? '展开风险发现' : '收起风险发现'}
              onClick={() => {
                if (rightCollapsed) setRightCollapsed(false);
                else { setRightCollapsed(true); setLeftCollapsed(false); }
              }}
            >
              {rightCollapsed ? '‹' : '›'}
            </button>
          </header>
          <span className="contract-panel-rail-label">风险发现</span>
          <div className="contract-panel-body">
            <div className="contract-risk-summary">
              <div className="contract-risk-count high"><div className="num">{highCount}</div><div className="label">高风险</div></div>
              <div className="contract-risk-count mid"><div className="num">{midCount}</div><div className="label">中风险</div></div>
              <div className="contract-risk-count low"><div className="num">{lowCount}</div><div className="label">低风险</div></div>
            </div>
            <div className="contract-progress"><span style={{ width: `${findings.length ? Math.round((processedCount / findings.length) * 100) : 0}%` }} /></div>
            <div className="contract-filter-row">
              {(['all', 'high', 'mid', 'low', 'unprocessed'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`contract-filter-btn ${filter === value ? 'active' : ''}`}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? '全部' : value === 'high' ? '高风险' : value === 'mid' ? '中风险' : value === 'low' ? '低风险' : '未处理'}
                </button>
              ))}
              <div className="contract-batch-actions">
                <button type="button" className="ui-btn" disabled={!hasSelection} onClick={batchConfirm}>批量确认</button>
                <button type="button" className="ui-btn" disabled={!hasSelection} onClick={batchIgnore}>批量忽略</button>
              </div>
            </div>
            {findings.length === 0 ? (
              <div className="contract-empty">{reviewPending ? '审核中…' : '运行审核后，风险发现会显示在这里'}</div>
            ) : (
              filteredFindings.map((f) => {
                const state = reviewed[f.id] ?? 'none';
                const note = notes[f.id];
                return (
                  <article key={f.id} className={`contract-risk-card ${state}`}>
                    <div className="contract-risk-card-head">
                      <span
                        className={`contract-risk-check ${selected.has(f.id) ? 'checked' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`选择 ${f.title}`}
                        onClick={() => toggleSelected(f.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleSelected(f.id); }}
                      >
                        ✓
                      </span>
                      <RiskBadge risk={riskLevelLabel(f.level)} />
                      <b className="contract-risk-card-title">{f.title}</b>
                      <span className="contract-risk-status">{reviewLabel(state)}</span>
                    </div>
                    {f.clause && <div className="contract-risk-meta">{f.clause}{f.position ? ` · ${f.position}` : ''}</div>}
                    {f.reason && <div className="contract-risk-meta">{f.reason}</div>}
                    {f.advice && <div className="contract-risk-meta">建议：{f.advice}</div>}
                    <div className="contract-risk-actions">
                      <button type="button" className={`ui-btn ok ${state === 'confirmed' ? 'active' : ''}`} onClick={() => applyReview(f.id, 'confirmed')}>确认</button>
                      <button type="button" className={`ui-btn ${state === 'ignored' ? 'active' : ''}`} onClick={() => applyReview(f.id, 'ignored')}>忽略</button>
                      <button type="button" className={`ui-btn warn ${state === 'escalated' ? 'active' : ''}`} onClick={() => applyReview(f.id, 'escalated')}>升级</button>
                      <button type="button" className={`ui-btn ${note ? 'active' : ''}`} onClick={() => setNoteDraft((prev) => ({ ...prev, [f.id]: prev[f.id] ?? note ?? '' }))}>备注</button>
                    </div>
                    {noteDraft[f.id] !== undefined && (
                      <div className="contract-note-editor">
                        <textarea value={noteDraft[f.id]} placeholder="填写审核意见…" onChange={(e) => setNoteDraft((prev) => ({ ...prev, [f.id]: e.target.value }))} />
                        <div className="contract-risk-actions">
                          <button type="button" className="ui-btn ui-btn--primary" onClick={() => saveNote(f.id)}>保存</button>
                          <button type="button" className="ui-btn" onClick={() => setNoteDraft((prev) => ({ ...prev, [f.id]: undefined }))}>取消</button>
                        </div>
                      </div>
                    )}
                    {note && <div className="contract-note">审核意见：{note}</div>}
                  </article>
                );
              })
            )}

            <div className="contract-risk-actions contract-report-actions">
              <button type="button" className="ui-btn ui-btn--primary" disabled={!canMerge} onClick={mergeReport}>合并到报告</button>
              {unprocessedHigh > 0 && !reportMerged && <span className="contract-warning">仍有 {unprocessedHigh} 项高风险未处理</span>}
            </div>

            {report ? (
              <>
                <div className="contract-section-label">报告预览</div>
                <div className="contract-report contract-report-mock" data-testid="report-preview" ref={previewRef}>
                  <div className="contract-report-head contract-report-mock-head">
                    <div className="contract-report-mock-title">{report.title}</div>
                    {selectedName ? <div className="contract-report-mock-meta">{selectedName}</div> : null}
                  </div>
                  <div className="contract-report-summary">
                    <div className="contract-report-summary-item">
                      <div className="num" style={{ color: 'var(--color-risk)' }}>{highCount}</div>
                      <div className="label">高风险</div>
                    </div>
                    <div className="contract-report-summary-item">
                      <div className="num" style={{ color: 'var(--color-warn)' }}>{midCount}</div>
                      <div className="label">中风险</div>
                    </div>
                    <div className="contract-report-summary-item">
                      <div className="num" style={{ color: 'var(--color-ok)' }}>{lowCount}</div>
                      <div className="label">低风险</div>
                    </div>
                  </div>
                  {report.blocks.filter((b) => b.heading && b.heading !== '风险明细').map((block, index) => (
                    <div className="contract-report-section" key={index}>
                      <h4>{block.heading}</h4>
                      <Markdown text={block.body} />
                    </div>
                  ))}
                  {(['high', 'mid', 'low'] as const).map((level) => {
                    const items = findings.filter((f) => f.level === level);
                    if (!items.length) return null;
                    return (
                      <div className="contract-report-section" key={level} data-testid={`report-risk-${level}`}>
                        <h4>{riskLevelLabel(level)}（{items.length}）</h4>
                        <table className="contract-report-table">
                          <thead>
                            <tr><th>风险项</th><th>位置</th><th>复核</th></tr>
                          </thead>
                          <tbody>
                            {items.map((f) => (
                              <tr key={f.id}>
                                <td>
                                  <div>{f.title}</div>
                                  {(f.clause || f.reason) && <div className="contract-risk-meta">{[f.clause, f.reason].filter(Boolean).join(' · ')}</div>}
                                </td>
                                <td>{f.position ?? '—'}</td>
                                <td>{reviewLabel(reviewed[f.id] ?? 'none')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
                <div className="contract-risk-actions contract-report-actions">
                  <button type="button" className="ui-btn ui-btn--primary" disabled={!reportMerged} onClick={() => {
                    void (async () => {
                      try {
                        const html = previewRef.current ? captureReportHtml(previewRef.current) : '';
                        const bytes = await documentFromHtml(report.title, html);
                        actions.requestExport({
                          title: report.title,
                          format: 'docx',
                          content: bytesToBase64(bytes),
                          path: reportExportPath(runPrefs.workspacePath ?? session.meta.workspacePath, report.title),
                        });
                      } catch (e) {
                        void sparkiiApi().appendError?.({
                          id: `export-${Date.now()}`,
                          message: e instanceof Error ? e.message : String(e),
                          source: '合同审核智能体',
                          createdAt: Date.now(),
                        });
                      }
                    })();
                  }}>导出报告</button>
                </div>
              </>
            ) : reportPending ? (
              <div className="contract-empty">报告生成中…</div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

export interface ContractSurfaceProps {
  state: Record<string, unknown>;
  workflow: { status: string; step?: string };
  sessionId?: string | null;
  onAction(action: string): void;
  onWorkflowState?(action: string, payload: Record<string, unknown>): void;
  onRequestExport(): void;
}

export function ContractSurface(props: ContractSurfaceProps) {
  const { state, workflow, sessionId, onAction, onWorkflowState, onRequestExport } = props;
  const documents = Array.isArray(state.documents) ? state.documents : state.documents ? [state.documents] : [];
  const rawResult = (state.workflow as Record<string, unknown> | undefined)?.['result'] as Record<string, unknown> | undefined;
  const session: AgentSession = {
    entries: [],
    streaming: false,
    status: workflow.status as AgentSession['status'],
    meta: { currentStep: workflow.step ?? null, inputs: documents.map((d) => ({ path: String(d) })) },
    result: rawResult ?? {},
  };
  const actions: AgentSurfaceActions = {
    newSession: () => {},
    openSession: () => {},
    startWorkflow: () => onAction('run-workflow:contract-review'),
    review: (action, payload) => onWorkflowState?.(action, payload),
    requestExport: () => onRequestExport(),
    chooseDocument: async () => {
      onAction('documents.upload');
      return {};
    },
    readDocumentBytes: async () => ({ error: 'denied' }),
  };
  return (
    <ContractAgentSurface
      agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }}
      sessionId={sessionId ?? null}
      mode={sessionId ? 'history' : 'live'}
      session={session}
      actions={actions}
    />
  );
}

export default ContractAgentSurface;
