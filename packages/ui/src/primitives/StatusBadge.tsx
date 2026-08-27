export type UiStatus = 'running' | 'queued' | 'approval' | 'ok' | 'fail';

const LABELS: Record<UiStatus, string> = {
  running: '运行中',
  queued: '排队',
  approval: '等待审批',
  ok: '完成',
  fail: '失败',
};

export function StatusBadge({ status }: { status: UiStatus }) {
  return <span className={`ui-status-badge ui-status-badge--${status}`}>{LABELS[status]}</span>;
}
