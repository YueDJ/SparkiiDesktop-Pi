import { RiskBadge } from './RiskBadge.js';

export interface AuditTimelineRow { id?: string; action?: string; actor?: string; ts?: number; payloadSummary?: string; denied?: boolean; executed?: boolean; }
export function AuditTimeline({ rows }: { rows: AuditTimelineRow[] }) {
  return <div className="ui-audit-timeline">{rows.map((r, i) => (
    <div key={r.id ?? i} className={`ui-audit-item ${r.denied ? 'denied' : r.executed ? 'executed' : ''}`}>
      <b>{r.action ?? '-'}</b>
      <div className="ui-muted">{r.actor ?? '-'} · {r.ts ? new Date(r.ts).toLocaleString('zh-CN') : '-'}{r.payloadSummary ? ` · ${r.payloadSummary}` : ''}</div>
      {r.executed !== undefined && <RiskBadge risk={r.denied ? 'high-risk' : 'read'} />}
    </div>
  ))}</div>;
}
