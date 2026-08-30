import { useEffect, useRef } from 'react';
import { useErrors } from '@sparkii/ui';

export type WorkflowStatusState = {
  status: 'idle' | 'running' | 'done' | 'failed';
  step?: string;
  error?: string;
};

export function WorkflowStatus(props: { state: WorkflowStatusState }) {
  const { status, step, error } = props.state;
  const { reportError } = useErrors();
  const reportedRef = useRef(false);

  useEffect(() => {
    if (status !== 'failed') {
      reportedRef.current = false;
      return;
    }
    if (reportedRef.current) return;
    reportedRef.current = true;
    reportError(error ?? '未知错误', { source: '合同审核' });
  }, [status, error, reportError]);

  if (status === 'idle') return null;
  if (status === 'running') return <div data-testid="workflow-status">审核中：{step ?? '…'}</div>;
  if (status === 'failed') return <div data-testid="workflow-status">审核失败：{error ?? '未知错误'}</div>;
  return <div data-testid="workflow-status">审核完成</div>;
}
