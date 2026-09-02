import { useState } from 'react';
import { Button, Card, RiskBadge, Tabs, WorkflowStatus, WorkflowSteps, type WorkflowStatusState, type WorkflowStep } from '@sparkii/ui';
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
  const [tab, setTab] = useState<'report' | 'original'>('report');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Record<string, 'confirmed' | 'ignored'>>({});

  const steps: WorkflowStep[] = deriveSteps({ status: workflow.status, step: workflow.step, error: workflow.error }).map((s) => ({
    id: s.id,
    label: s.label,
    state: s.state === 'pending' ? 'idle' : s.state,
  }));
  const activeStepId = selectedStep
    ?? (workflow.status === 'done' ? 'report' : workflow.step ?? 'load');
  const rawCompare = (state.workflow as Record<string, unknown> | undefined)?.['result'] as Record<string, unknown> | undefined;
  const findings = parseRiskFindings(rawCompare?.['compare']);
  const report = formatReport(rawCompare?.['report']);
  const documents = Array.isArray(state.documents) ? state.documents : state.documents ? [state.documents] : [];
  const docPath = String(documents[0] ?? '');

  return (
    <div>
      <WorkflowStatus state={workflow} />
      <WorkflowSteps steps={steps} onStepClick={setSelectedStep} />

      {workflow.status === 'idle' && (
        <Card className="contract-idle-card">
          <h3 className="contract-card-title">上传合同并开始审核</h3>
          <div className="contract-actions">
            <Button id="upload" data-testid="upload" onClick={() => onAction('documents.upload')}>选择合同文件</Button>
            <Button id="review" data-testid="review" variant="primary" onClick={() => onAction('run-workflow:contract-review')}>开始审核</Button>
          </div>
        </Card>
      )}

      <StepViews stepId={activeStepId} state={state} />

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
            <Button variant="primary" size="sm" onClick={onRequestExport}>导出报告 · 需审批</Button>
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
                          onWorkflowState?.('risk_confirmed', { riskId: f.id, stepId: 'compare' });
                        }}
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReviewed((prev) => ({ ...prev, [f.id]: 'ignored' }));
                          onWorkflowState?.('risk_ignored', { riskId: f.id, stepId: 'compare' });
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

export default ContractSurface;
