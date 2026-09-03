import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown, ModelEffortControl, RiskBadge, THINKING_LEVELS } from '@sparkii/ui';
import type { AgentSession, AgentSurfaceActions, AgentSurfaceProps } from '../../../src/surface/contract.js';
import { deriveWorkflowTimeline, extractWorkflowResult, type WorkflowStateEntry } from '../../../src/surface/normalize.js';
import { formatReport, parseRiskFindings } from './contract.js';

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
}

function sparkiiApi(): SparkiiWindowApi {
  return ((window as any).sparkii ?? {}) as SparkiiWindowApi;
}

function reviewStateEntries(entries: AgentSession['entries']): WorkflowStateEntry[] {
  return entries.filter((e): e is WorkflowStateEntry => e.kind === 'workflow_state');
}

function initialReviewState(entries: AgentSession['entries']): Record<string, ReviewState> {
  const next: Record<string, ReviewState> = {};
  for (const e of reviewStateEntries(entries)) {
    const riskId = typeof e.payload.riskId === 'string' ? e.payload.riskId : '';
    if (!riskId) continue;
    if (e.action === 'risk_confirmed') next[riskId] = 'confirmed';
    if (e.action === 'risk_ignored') next[riskId] = 'ignored';
    if (e.action === 'risk_escalated') next[riskId] = 'escalated';
  }
  return next;
}

function initialNotes(entries: AgentSession['entries']): Record<string, string> {
  const next: Record<string, string> = {};
  for (const e of reviewStateEntries(entries)) {
    const riskId = typeof e.payload.riskId === 'string' ? e.payload.riskId : '';
    const note = typeof e.payload.note === 'string' ? e.payload.note : '';
    if (riskId && note) next[riskId] = note;
  }
  return next;
}

function wasReportMerged(entries: AgentSession['entries']): boolean {
  return reviewStateEntries(entries).some((e) => e.action === 'report_merged');
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

function ModelEffortBar({ agentId, sessionId, session }: { agentId: string; sessionId: string | null; session: AgentSession }) {
  const api = sparkiiApi();
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState<string | null>(session.meta.model ?? null);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([...THINKING_LEVELS]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(session.meta.workspacePath ?? null);
  const [contextUsage, setContextUsage] = useState<{ tokens?: number | null; contextWindow?: number; percent?: number | null } | null>(session.meta.contextUsage ?? null);
  const initialized = useRef(false);

  useEffect(() => {
    setModel(session.meta.model ?? null);
    setWorkspacePath(session.meta.workspacePath ?? null);
    setContextUsage(session.meta.contextUsage ?? null);
  }, [session.meta.model, session.meta.workspacePath, session.meta.contextUsage]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void api.getModelOptions?.(agentId).then((r) => {
      if (!r) return;
      setModels(Array.isArray(r.models) ? r.models : []);
      setDefaultModel(r.defaultModel ?? null);
      setProvider(r.provider ?? 'deepseek');
      if (!sessionId) return;
      void api.getChatSession?.(sessionId).then((rec) => {
        if (!rec) return;
        setWorkspacePath(rec.workspacePath ?? null);
        setThinkingLevel(rec.thinkingLevel ?? null);
        if (rec.model) setModel(rec.model);
      }).catch(() => {});
      void api.getChatState?.(sessionId).then((state) => setContextUsage(state?.contextUsage ?? null)).catch(() => {});
    }).catch(() => {});
  }, [agentId, sessionId]);

  const refreshThinkingLevels = (nextModel: string | null) => {
    const target = nextModel ?? defaultModel;
    if (!target) { setThinkingLevels([...THINKING_LEVELS]); return; }
    const slash = target.indexOf('/');
    const modelId = slash >= 0 ? target.slice(slash + 1) : target;
    void api.listThinkingLevels?.(provider, modelId).then((levels) => {
      setThinkingLevels(levels?.length ? levels : [...THINKING_LEVELS]);
    }).catch(() => setThinkingLevels([...THINKING_LEVELS]));
  };

  const onModelChange = (next: string | null) => {
    setModel(next);
    if (sessionId) void api.setChatModel?.(sessionId, next);
    refreshThinkingLevels(next);
  };

  const onThinkingLevelChange = (next: string | null) => {
    setThinkingLevel(next);
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
        title={workspacePath ?? ''}
        onClick={() => {
          void api.chooseWorkspace?.().then(({ path } = {}) => {
            if (!path) return;
            setWorkspacePath(path);
            if (sessionId) void api.setChatWorkspace?.(sessionId, path);
          });
        }}
      >
        <span className="contract-model-ws-name">{workspaceName}</span>
      </button>
      <div className="ui-composer-context" title="上下文占用">
        {contextUsage
          ? `${contextUsage.tokens ?? '—'} / ${contextUsage.contextWindow ?? '—'}`
          : '上下文 —'}
      </div>
      <ModelEffortControl
        model={model}
        defaultModel={defaultModel}
        models={models}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        onModelChange={onModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
      />
    </div>
  );
}

export function ContractAgentSurface(props: AgentSurfaceProps) {
  const { sessionId, session, actions } = props;
  const timeline = deriveWorkflowTimeline(session.entries);
  const status = session.status && session.status !== 'idle' ? session.status : timeline.status;
  const currentStep = session.meta.currentStep ?? timeline.step ?? null;
  const result = session.result ?? extractWorkflowResult(session.entries);
  const reviewPayload = (result?.['review'] ?? result?.['compare'] ?? result) as unknown;
  const findings = parseRiskFindings(reviewPayload);
  const report = formatReport(result?.['report']);
  const inputs = session.meta.inputs ?? [];
  const firstInput = inputs[0];
  const fileName = firstInput?.name ?? (firstInput?.path ? basename(firstInput.path) : '');
  const [documents, setDocuments] = useState<string[]>(inputs.map((i) => i.path));
  const [localFileName, setLocalFileName] = useState<string>('');
  const inputsKey = inputs.map((i) => i.path).join('\u0000');
  const lastInputsKey = useRef(inputsKey);
  useEffect(() => {
    if (inputsKey === lastInputsKey.current) return;
    lastInputsKey.current = inputsKey;
    setDocuments((prev) => Array.from(new Set([...inputs.map((i) => i.path), ...prev])));
  }, [inputsKey]);
  const [reviewed, setReviewed] = useState<Record<string, ReviewState>>(() => initialReviewState(session.entries));
  const [notes, setNotes] = useState<Record<string, string>>(() => initialNotes(session.entries));
  const [noteDraft, setNoteDraft] = useState<Record<string, string | undefined>>({});
  const [reportMerged, setReportMerged] = useState(() => wasReportMerged(session.entries));
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'high' | 'mid' | 'low' | 'unprocessed'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setReviewed(initialReviewState(session.entries));
    setNotes(initialNotes(session.entries));
    setReportMerged(wasReportMerged(session.entries));
    setFilter('all');
    setSelected(new Set());
    setLocalFileName('');
    setDocuments(inputs.map((i) => i.path));
  }, [sessionId, inputsKey, session.entries]);

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
    setReviewed((prev) => ({ ...prev, [id]: prev[id] === action ? 'none' : action }));
    actions.review(`risk_${action}`, { riskId: id, stepId: 'review' });
  };

  const saveNote = (id: string) => {
    const text = (noteDraft[id] ?? '').trim();
    if (!text) return;
    setNotes((prev) => ({ ...prev, [id]: text }));
    setNoteDraft((prev) => ({ ...prev, [id]: undefined }));
    actions.review('risk_comment', { riskId: id, note: text, stepId: 'review' });
  };

  const mergeReport = () => {
    setReportMerged(true);
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
    const res = await actions.chooseDocument();
    if (res?.path) {
      setDocuments((prev) => Array.from(new Set([...prev, res.path!])));
      setLocalFileName(basename(res.path));
    }
  };

  const removeLocalDocument = () => {
    setDocuments([]);
    setLocalFileName('');
  };

  const reportNodeState = status === 'done' || status === 'failed' ? 'done' : status === 'running' ? 'active' : 'pending';
  const reviewNodeState = reportMerged ? 'done' : unprocessed.length ? 'warn' : 'ready';
  const reviewNodeClass = reviewNodeState === 'warn' ? 'warn' : reviewNodeState === 'done' ? 'done' : 'ready';

  const reportBlocks = useMemo(() => {
    if (!report) return '';
    return report.blocks.map((b) => `${b.heading ? `## ${b.heading}` : ''}\n${b.body}`).join('\n\n');
  }, [report]);

  const selectedName = fileName || localFileName || (documents[0] ? basename(documents[0]) : '');

  return (
    <div className="contract-workbench">
      <header className="contract-header">
        <div className="contract-header-main">
          {selectedName && <span className="contract-header-file">{selectedName}</span>}
          <span className="contract-status" data-testid="workflow-status">
            {status === 'running' ? `审核中：${currentStep ?? '…'}` : status === 'done' ? '审核完成' : status === 'failed' ? '审核失败' : ''}
          </span>
        </div>
        <div className="contract-header-right">
          <ModelEffortBar agentId={props.agent.id} sessionId={sessionId} session={session} />
          {status === 'idle' && (
            <>
              <button type="button" className="ui-btn ui-btn--ghost" data-testid="upload" onClick={chooseDocument}>
                {selectedName ? '更换文件' : '选择合同文件'}
              </button>
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
                onClick={() => actions.startWorkflow({ documents })}
              >
                开始审核
              </button>
            </>
          )}
          {status !== 'idle' && (
            <button type="button" className="ui-btn" data-testid="new-review" onClick={() => actions.newSession()}>
              新会话
            </button>
          )}
        </div>
      </header>

      <div className="contract-stage">
        <span className={`contract-stage-item ${reportNodeState}`}><span className="contract-stage-dot" />审核</span>
        <span className="contract-stage-sep" />
        <span className={`contract-stage-item ${reportNodeState}`}><span className="contract-stage-dot" />报告</span>
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
            <button type="button" className="contract-collapse-btn" aria-label="收起合同原文" onClick={() => setLeftCollapsed((v) => !v)}>‹</button>
          </header>
          <div className="contract-panel-body">
            {firstInput?.missing ? (
              <div className="contract-missing-note">无法找到原文件，风险发现与报告仍可从会话历史恢复。</div>
            ) : selectedName ? (
              <>
                <div className="contract-doc contract-doc-head">
                  <div className="contract-doc-icon">PDF</div>
                  <div>
                    <div className="contract-doc-name">{selectedName}</div>
                    <div className="contract-doc-meta">PDF · 14 页</div>
                  </div>
                </div>
                <div className="contract-doc-body">
                  <div className="contract-doc-block">
                    <b>合同原文</b>
                    原文预览将在后续版本提供。
                  </div>
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
            <button type="button" className="contract-collapse-btn" aria-label="收起风险发现" onClick={() => setRightCollapsed((v) => !v)}>›</button>
          </header>
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
              <div className="contract-empty">运行审核后，风险发现会显示在这里</div>
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
              <button type="button" className="ui-btn ui-btn--primary" disabled={!findings.length || reportMerged} onClick={mergeReport}>合并到报告</button>
              {unprocessedHigh > 0 && !reportMerged && <span className="contract-warning">仍有 {unprocessedHigh} 项高风险未处理</span>}
            </div>

            {report && (
              <>
                <div className="contract-section-label">报告预览</div>
                <div className="contract-report contract-report-mock">
                  <div className="contract-report-head contract-report-mock-head">
                    <div>
                      <div className="contract-report-mock-title">{report.title}</div>
                      <div className="contract-report-mock-meta">deepseek-v4-pro</div>
                    </div>
                    <span className={`contract-report-status ${reportMerged ? 'done' : ''}`}>{reportMerged ? '已合并' : '待复核'}</span>
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
                  {report.blocks.map((block, index) => (
                    <div className="contract-report-section" key={index}>
                      <h4>{block.heading}</h4>
                      <Markdown text={block.body} />
                    </div>
                  ))}
                  <div className="contract-report-section">
                    <h4>风险明细</h4>
                    <table className="contract-report-table">
                      <thead>
                        <tr><th>风险项</th><th>等级</th><th>复核状态</th></tr>
                      </thead>
                      <tbody>
                        {findings.map((f) => (
                          <tr key={f.id}>
                            <td>{f.title}</td>
                            <td>{riskLevelLabel(f.level)}</td>
                            <td>{reviewLabel(reviewed[f.id] ?? 'none')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="contract-risk-actions contract-report-actions">
                  <button type="button" className="ui-btn ui-btn--primary" disabled={!reportMerged} onClick={() => actions.requestExport()}>导出报告</button>
                </div>
              </>
            )}
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
