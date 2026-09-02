import { useEffect, useRef, useState } from 'react';
import { Button, Card, RiskBadge, Tabs, WorkflowStatus, WorkflowSteps, type WorkflowStatusState, type WorkflowStep } from '@sparkii/ui';
import type { AgentSession, AgentSurfaceActions, AgentSurfaceProps } from '../../../src/surface/contract.js';
import { deriveWorkflowTimeline, extractWorkflowResult } from '../../../src/surface/normalize.js';
import { formatReport, parseRiskFindings } from './contract.js';
import { deriveSteps } from './manifest-steps.js';
import { StepViews } from './StepViews.js';

export interface ContractSurfaceProps {
  state: Record<string, unknown>;
  workflow: WorkflowStatusState;
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
    status: workflow.status,
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

export function ContractAgentSurface(props: AgentSurfaceProps) {
  const { sessionId, session, actions } = props;
  const [tab, setTab] = useState<'report' | 'original'>('report');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, 'confirmed' | 'ignored'>>({});

  // 权威状态：live/pushed status 优先，history 从 entries 推导
  const timeline = deriveWorkflowTimeline(session.entries);
  const status: WorkflowStatusState['status'] = session.status && session.status !== 'idle' ? session.status : timeline.status;
  const currentStep = session.meta.currentStep ?? timeline.step ?? null;
  const result = session.result ?? extractWorkflowResult(session.entries);

  // 输入文件
  const inputs = (session.meta.inputs ?? []).map((i) => i.path);
  const inputsKey = inputs.join('\u0000');
  const [documents, setDocuments] = useState<string[]>(inputs);
  const lastInputsKey = useRef(inputsKey);
  useEffect(() => {
    if (inputsKey === lastInputsKey.current) return;
    lastInputsKey.current = inputsKey;
    setDocuments((prev) => Array.from(new Set([...inputs, ...prev])));
  }, [inputsKey]);
  const docPath = documents[0] ?? '';

  const steps: WorkflowStep[] = deriveSteps({ status, step: currentStep ?? undefined }).map((s) => ({
    id: s.id,
    label: s.label,
    state: s.state === 'pending' ? 'idle' : s.state,
  }));
  const activeStepId = selectedStep ?? (status === 'done' ? 'report' : currentStep ?? 'load');

  const findings = parseRiskFindings(result?.['compare']);
  const report = formatReport(result?.['report']);

  const onChooseDocument = async () => {
    const res = await actions.chooseDocument();
    if (res?.path) setDocuments((prev) => Array.from(new Set([...prev, res.path!])));
  };
  const onStart = () => actions.startWorkflow({ documents });

  return (
    <div>
      <WorkflowStatus state={{ status, step: currentStep ?? undefined }} />
      <WorkflowSteps steps={steps} onStepClick={setSelectedStep} />

      {status === 'idle' && (
        <Card className="contract-idle-card">
          <h3 className="contract-card-title">上传合同并开始审核</h3>
          <div className="contract-actions">
            <Button id="upload" data-testid="upload" onClick={onChooseDocument}>选择合同文件</Button>
            <Button id="review" data-testid="review" variant="primary" onClick={onStart}>开始审核</Button>
          </div>
        </Card>
      )}

      <StepViews stepId={activeStepId} state={{ documents, workflow: { result } }} />

      <div className="split-pane">
        <Card className="contract-pane">
          <Tabs tabs={[{ id: 'report', label: '报告' }, { id: 'original', label: '原文' }]} active={tab} onChange={(id) => setTab(id as 'report' | 'original')} />
          {tab === 'report' ? (
            <div className="contract-pane-body">
              {report ? (
                <>
                  <b>{report.title}</b>
                  <div className="contract-gap" />
                  {report.blocks.map((b, i) => (
                    <div key={i} className="contract-block">
                      {b.heading && <b className="contract-block-heading">{b.heading}</b>}
                      <div className="ui-muted contract-pre-wrap">{b.body}</div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="ui-muted contract-pad">报告将在审核完成后生成</div>
              )}
            </div>
          ) : (
            <div className="contract-pane-body">
              {docPath ? (
                <>
                  <div className="ui-muted contract-mb-sm">{docPath}</div>
                  <Card className="contract-placeholder">原文预览将在后续版本提供</Card>
                </>
              ) : (
                <div className="ui-muted contract-pad">尚未选择合同文件</div>
              )}
            </div>
          )}
        </Card>

        <Card className="contract-risk-pane">
          <div className="contract-risk-head">
            <b>风险发现</b>
            <Button variant="primary" size="sm" onClick={() => actions.requestExport()}>导出报告 · 需审批</Button>
          </div>
          <div className="contract-risk-body">
            {findings.length === 0 ? (
              <div className="ui-muted">运行审核后,风险发现会显示在这里</div>
            ) : (
              findings.map((f) => (
                <div key={f.id} className="contract-finding">
                  <RiskBadge risk={f.level === 'high' ? '高风险' : f.level === 'mid' ? '中风险' : '低风险'} />
                  <span>{f.title}</span>
                  {f.advice && <span className="ui-muted contract-advice">{f.advice}</span>}
                  {sessionId && (
                    <span className="contract-finding-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setReviewed((prev) => ({ ...prev, [f.id]: 'confirmed' }));
                          actions.review('risk_confirmed', { riskId: f.id, stepId: 'compare' });
                        }}
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReviewed((prev) => ({ ...prev, [f.id]: 'ignored' }));
                          actions.review('risk_ignored', { riskId: f.id, stepId: 'compare' });
                        }}
                      >
                        忽略
                      </button>
                      {reviewed[f.id] && <span className="ui-muted">{reviewed[f.id] === 'confirmed' ? '已确认' : '已忽略'}</span>}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default ContractAgentSurface;
