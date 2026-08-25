import { useState } from 'react';
import { widgetRegistry } from '../composer/registry.js';
import { WorkflowStatus, type WorkflowStatusState } from '../workbench/WorkflowStatus.js';
import { formatReport, parseRiskFindings, stepStatus } from './contract.js';

export interface ContractSurfaceProps {
  state: Record<string, unknown>;
  workflow: WorkflowStatusState;
  onAction(action: string): void;
  onRequestExport(): void;
}

export function ContractSurface(props: ContractSurfaceProps) {
  const { state, workflow, onAction, onRequestExport } = props;
  const [tab, setTab] = useState<'report' | 'original'>('report');
  const FileUpload = widgetRegistry['file-upload'];
  const ActionButton = widgetRegistry['action-button'];

  const steps = stepStatus(workflow);
  const rawCompare = (state.workflow as Record<string, unknown> | undefined)?.['result'] as Record<string, unknown> | undefined;
  const findings = parseRiskFindings(rawCompare?.['compare']);
  const report = formatReport(rawCompare?.['report']);
  const documents = Array.isArray(state.documents) ? state.documents : state.documents ? [state.documents] : [];
  const docPath = String(documents[0] ?? '');

  return (
    <div>
      <WorkflowStatus state={workflow} />
      <div className="steps">
        {steps.map((s) => (
          <span key={s.id} className={`step ${s.state}`} data-state={s.state}>
            <span className="n">{s.state === 'done' ? '✓' : s.id === 'upload' ? '1' : '•'}</span>{s.label}
            {s.id !== steps[steps.length - 1].id && <span className="sep">→</span>}
          </span>
        ))}
      </div>

      {workflow.status === 'idle' && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>上传合同并开始审核</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <FileUpload id="upload" bind="documents" state={state} onAction={onAction} />
            <ActionButton id="review" action="run-workflow:contract-review" state={state} onAction={onAction} />
          </div>
        </div>
      )}

      <div className="split-pane">
        <div className="card" style={{ padding: 0 }}>
          <div className="tabs" style={{ padding: '0 8px' }}>
            <button type="button" className={`tab ${tab === 'report' ? 'on' : ''}`} onClick={() => setTab('report')}>报告</button>
            <button type="button" className={`tab ${tab === 'original' ? 'on' : ''}`} onClick={() => setTab('original')}>原文</button>
          </div>
          {tab === 'report' ? (
            <div style={{ padding: '4px 18px 16px' }}>
              {report ? (
                <>
                  <b>{report.title}</b>
                  <div style={{ height: 8 }} />
                  {report.blocks.map((b, i) => (
                    <div key={i} style={{ marginBottom: 10 }}>
                      {b.heading && <b style={{ display: 'block', marginBottom: 4 }}>{b.heading}</b>}
                      <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{b.body}</div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="muted" style={{ padding: '12px 0' }}>报告将在审核完成后生成</div>
              )}
            </div>
          ) : (
            <div style={{ padding: '4px 18px 16px' }}>
              {docPath ? (
                <>
                  <div className="muted" style={{ marginBottom: 8 }}>{docPath}</div>
                  <div className="card" style={{ padding: '18px', textAlign: 'center' }}>原文预览将在后续版本提供</div>
                </>
              ) : (
                <div className="muted" style={{ padding: '12px 0' }}>尚未选择合同文件</div>
              )}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--color-border, #EAF0F6)' }}>
            <b>风险发现</b>
            <button type="button" className="btn primary sm" onClick={onRequestExport}>导出报告 · 需审批</button>
          </div>
          <div style={{ padding: '12px 14px' }}>
            {findings.length === 0 ? (
              <div className="muted">运行审核后,风险发现会显示在这里</div>
            ) : (
              findings.map((f) => (
                <div key={f.id} className="item" style={{ border: '1px solid var(--color-border, #EAF0F6)', borderRadius: 10, marginBottom: 8, padding: '9px 8px' }}>
                  <span className={`risk-b risk-${f.level}`}>
                    {f.level === 'high' ? '高风险' : f.level === 'mid' ? '中风险' : '低风险'}
                  </span>
                  <span>{f.title}</span>
                  {f.advice && <span className="muted" style={{ marginLeft: 'auto' }}>{f.advice}</span>}
                </div>
              ))
            )}
          </div>
          <div style={{ marginTop: 'auto', padding: '10px 14px', borderTop: '1px dashed var(--color-border, #EAF0F6)', fontSize: 12, color: 'var(--color-textMuted, #94A3B8)' }}>
            {workflow.status === 'done' ? '已审计 ✓ · 导出需经审批' : '活动:等待开始…'}
          </div>
        </div>
      </div>
    </div>
  );
}
