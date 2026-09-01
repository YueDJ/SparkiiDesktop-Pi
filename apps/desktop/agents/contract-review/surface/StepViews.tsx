import { Card } from '@sparkii/ui';

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
  const text = (value: unknown) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2));

  let body: string;
  if (stepId === 'upload') {
    body = documents.length ? documents.map(String).join('\n') : '尚未上传合同文件';
  } else if (stepId === 'load') {
    body = text(valueAt(state, 'workflow.result.load'));
  } else if (stepId === 'search') {
    body = text(valueAt(state, 'workflow.result.search'));
  } else if (stepId === 'extract') {
    body = text(valueAt(state, 'workflow.result.extract'));
  } else if (stepId === 'compare') {
    body = text(result.compare);
  } else if (stepId === 'report') {
    body = text(result.report);
  } else if (stepId === 'review') {
    body = text(result.review);
  } else {
    body = '该步骤暂无内容';
  }

  return (
    <Card className="contract-step-detail">
      <div className="contract-step-detail-head">当前步骤：{stepId}</div>
      <pre className="contract-step-detail-body">{body}</pre>
    </Card>
  );
}
