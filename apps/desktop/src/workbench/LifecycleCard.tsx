import type { ChatEntry, TimelineStatus } from './pi-timeline.js';

const GLYPHS: Record<string, string> = {
  agent_start: '▶',
  agent_end: '✓',
  agent_settled: '✓',
  turn_start: '↻',
  turn_end: '✓',
  compaction_start: '◐',
  compaction_end: '✓',
  compaction: '≡',
  model_change: '◈',
  thinking_level_change: '✦',
  session_info: 'ℹ',
  custom_message: '✉',
  branch_summary: '⑂',
  custom: '◇',
  label: '#',
  auto_retry_start: '↻',
  auto_retry_end: '✓',
  summarization_retry_scheduled: '⏱',
  summarization_retry_attempt_start: '↻',
  summarization_retry_finished: '✓',
  shell_selected: '⚙',
  runtime_error: '!',
};

const STATUS_LABEL: Partial<Record<TimelineStatus, string>> = {
  running: '进行中',
  ok: '完成',
  warn: '注意',
  error: '错误',
  info: '',
};

export function LifecycleCard({ entry }: { entry: Extract<ChatEntry, { kind: 'event' }> }) {
  const status = entry.status ?? 'info';
  const statusLabel = STATUS_LABEL[status] ?? '';
  return (
    <div className={`pi-lifecycle-card pi-lifecycle-card--${status}`} data-testid="lifecycle-card">
      <div className="pi-lifecycle-card-head">
        <span className="pi-lifecycle-card-icon" aria-hidden="true">{GLYPHS[entry.event] ?? '·'}</span>
        <b className="pi-lifecycle-card-label">{entry.label}</b>
        {statusLabel && <span className={`pi-lifecycle-card-status ui-status-badge ui-status-badge--${status}`}>{statusLabel}</span>}
      </div>
      {entry.detail && <div className="pi-lifecycle-card-detail">{entry.detail}</div>}
    </div>
  );
}
