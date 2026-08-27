export interface AuditTimelineRow { id?: string; action?: string; actor?: string; ts?: number; payloadSummary?: string; denied?: boolean; executed?: boolean; }
export function AuditTimeline({ rows }: { rows: AuditTimelineRow[] }) {
  return <div className="ui-audit-timeline">{rows.map((r, i) => (
    <div key={r.id ?? i} className={`ui-audit-item ${r.denied ? 'denied' : r.executed ? 'executed' : ''}`}>
      <b>{r.action ?? '-'}</b>
      <div className="ui-muted">{r.actor ?? '-'} · {r.ts ? new Date(r.ts).toLocaleString('zh-CN') : '-'}{r.payloadSummary ? ` · ${r.payloadSummary}` : ''}</div>
      {r.executed !== undefined && (
        <span className={`ui-risk-badge ui-risk-badge--${r.denied ? 'high' : 'low'}`}>{r.denied ? '未执行' : '已执行'}</span>
      )}
    </div>
  ))}</div>;
}
