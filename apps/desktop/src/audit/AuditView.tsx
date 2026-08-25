import { useEffect, useState } from 'react';

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
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>审计留痕</b>
        <button type="button" className={`btn sm ${view === 'timeline' ? 'primary' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => setView('timeline')}>时间线</button>
        <button type="button" className={`btn sm ${view === 'table' ? 'primary' : ''}`} onClick={() => setView('table')}>表格</button>
        <select className="set-field" value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
          <option value="all">全部结果</option>
          <option value="executed">已执行</option>
          <option value="not-executed">未执行</option>
        </select>
        <button type="button" className="btn primary sm" onClick={exportJsonl}>导出</button>
      </div>

      {view === 'timeline' ? (
        <div className="card" style={{ padding: '16px 18px' }}>
          {filtered.length === 0 && <div className="muted">暂无审计记录</div>}
          {filtered.map((r, i) => (
            <div key={r.id ?? i} className="audit-ev">
              <span className={`adot ${isDenied(r) ? 'red' : r.decision ? '' : 'gray'}`} />
              <b>{r.action ?? '-'}</b>
              <div className="muted">
                {r.actor ?? '-'} · {r.sessionId ? `会话 ${r.sessionId.slice(0, 8)}` : '-'} · {fmt(r.ts)}
                {r.payloadSummary && <span> · {r.payloadSummary}</span>}
              </div>
              {r.decision && (
                <span className={`risk-b ${isDenied(r) ? 'risk-high' : 'risk-low'}`} style={{ marginTop: 4 }}>
                  {isDenied(r) ? '未执行' : '已执行'}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
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
                  <td>{r.decision ? (isDenied(r) ? <span style={{ color: 'var(--color-risk, #B91C1C)' }}>未执行</span> : <span className="ok-t">已执行</span>) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
