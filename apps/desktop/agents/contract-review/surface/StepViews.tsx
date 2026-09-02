import { Card, RiskBadge } from '@sparkii/ui';
import { parseRiskFindings, formatReport } from './contract.js';

export interface StepViewProps {
  stepId: string;
  state: Record<string, unknown>;
}

function valueAt(state: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    state,
  );
}

export function StepViews({ stepId, state }: StepViewProps) {
  const workflow = (state.workflow ?? {}) as Record<string, unknown>;
  const result = (workflow.result ?? {}) as Record<string, unknown>;
  const documents = Array.isArray(state.documents) ? state.documents : [];
  const doc = documents.length ? String(documents[0]) : '';
  const toText = (value: unknown) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const findings = parseRiskFindings(result.compare);
  const report = formatReport(result.report);

  let body: React.ReactNode;
  if (stepId === 'upload') {
    body = doc ? <div className="contract-step-file">{doc}</div> : <div className="ui-muted">尚未上传合同文件</div>;
  } else if (stepId === 'load') {
    body = <div className="ui-muted contract-pre-wrap">{toText(valueAt(state, 'workflow.result.load'))}</div>;
  } else if (stepId === 'search') {
    body = <div className="ui-muted contract-pre-wrap">{toText(valueAt(state, 'workflow.result.search'))}</div>;
  } else if (stepId === 'extract') {
    body = <div className="ui-muted contract-pre-wrap">{toText(valueAt(state, 'workflow.result.extract'))}</div>;
  } else if (stepId === 'compare') {
    body = findings.length === 0
      ? <div className="ui-muted">暂无风险发现</div>
      : (
        <ul className="contract-finding-list">
          {findings.map((f) => (
            <li key={f.id} className="contract-finding">
              <RiskBadge risk={f.level === 'high' ? '高风险' : f.level === 'mid' ? '中风险' : '低风险'} />
              <span>{f.title}</span>
              {f.advice && <span className="ui-muted contract-advice">{f.advice}</span>}
            </li>
          ))}
        </ul>
      );
  } else if (stepId === 'report') {
    body = report
      ? (
        <div className="contract-report">
          <b>{report.title}</b>
          {report.blocks.map((b, i) => (
            <div key={i} className="contract-block">
              {b.heading && <b className="contract-block-heading">{b.heading}</b>}
              <div className="ui-muted contract-pre-wrap">{b.body}</div>
            </div>
          ))}
        </div>
      )
      : <div className="ui-muted">报告将在审核完成后生成</div>;
  } else if (stepId === 'review') {
    body = <div className="ui-muted">复核阶段在报告生成后进入</div>;
  } else {
    body = <div className="ui-muted">该步骤暂无内容</div>;
  }

  return (
    <Card className="contract-step-detail">
      <div className="contract-step-detail-head">当前步骤：{stepId}</div>
      <div className="contract-step-detail-body">{body}</div>
    </Card>
  );
}
