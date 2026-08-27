import { useEffect, useState } from 'react';
import { AuditTimeline, Button, Card, Select } from '@sparkii/ui';

export interface AuditRowLike {
  id?: string;
  ts?: number;
  actor?: string;
  action?: string;
  resource?: string;
  payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired' | string;
  modelRoute?: string;
  sessionId?: string;
}

export interface AuditViewProps {
  api: { queryAudit(filter: object): Promise<unknown[]> };
  onExport?(jsonl: string): void;
}

function isDenied(r: AuditRowLike): boolean {
  return r.decision === 'denied' || r.decision === 'expired';
}

export function AuditView(props: AuditViewProps) {
  const [rows, setRows] = useState<AuditRowLike[]>([]);
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [result, setResult] = useState<'all' | 'executed' | 'not-executed'>('all');

  useEffect(() => {
    props.api.queryAudit({}).then((r) => setRows(r as AuditRowLike[]));
  }, [props.api]);

  const filtered = rows.filter((r) => {
    if (result === 'all') return true;
    return result === 'not-executed' ? isDenied(r) : !isDenied(r);
  });

  const exportJsonl = () => {
    props.onExport?.(rows.map((r) => JSON.stringify(r)).join('\n'));
  };

  const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleString('zh-CN') : '-');

  return (
    <div>
      <div className="audit-head">
        <b className="audit-title">审计留痕</b>
        <Button size="sm" variant={view === 'timeline' ? 'primary' : 'secondary'} className="audit-head-right" onClick={() => setView('timeline')}>时间线</Button>
        <Button size="sm" variant={view === 'table' ? 'primary' : 'secondary'} onClick={() => setView('table')}>表格</Button>
        <Select className="audit-filter" value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
          <option value="all">全部结果</option>
          <option value="executed">已执行</option>
          <option value="not-executed">未执行</option>
        </Select>
        <Button variant="primary" size="sm" onClick={exportJsonl}>导出</Button>
      </div>

      {view === 'timeline' ? (
        <Card className="audit-card">
          {filtered.length === 0 && <div className="ui-muted">暂无审计记录</div>}
          <AuditTimeline rows={filtered.map((r) => ({
            id: r.id,
            action: r.action,
            actor: r.actor,
            ts: r.ts,
            payloadSummary: r.payloadSummary,
            denied: isDenied(r),
            executed: r.decision ? true : undefined,
          }))} />
        </Card>
      ) : (
        <Card className="audit-card audit-card-table">
          <table className="tbl">
            <thead>
              <tr><th>时间</th><th>智能体</th><th>动作</th><th>操作人</th><th>结果</th></tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td>{fmt(r.ts)}</td>
                  <td>{r.sessionId ? `会话 ${r.sessionId.slice(0, 8)}` : '-'}</td>
                  <td>{r.action ?? '-'}</td>
                  <td>{r.actor ?? '-'}</td>
                  <td>{r.decision ? (isDenied(r) ? <span className="audit-denied">未执行</span> : <span className="audit-executed">已执行</span>) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
