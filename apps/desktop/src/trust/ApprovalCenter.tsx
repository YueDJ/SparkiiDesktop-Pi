import { Countdown } from './Countdown.js';
import { riskInfo, type ApprovalProposalLike } from './types.js';

export interface ApprovalCenterProps {
  proposals: ApprovalProposalLike[];
  timeoutMs?: number;
  onOpenDetail(proposal: ApprovalProposalLike): void;
}

export function ApprovalCenter(props: ApprovalCenterProps) {
  const { proposals, timeoutMs = 120000, onOpenDetail } = props;
  return (
    <div className="card appr-list">
      {proposals.length === 0 ? (
        <div className="muted" style={{ padding: '12px 4px' }}>没有待处理的审批事项</div>
      ) : (
        proposals.map((p) => {
          const risk = riskInfo(p.risk);
          return (
            <div key={p.id} className="item">
              <span className={`dot ${risk.level === 'high' ? 'dot-wait' : 'dot-idle'}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{p.summary}</b>
                <div className="muted">{p.toolName ?? ''}{p.sessionId ? ` · 会话 ${p.sessionId.slice(0, 8)}` : ''}</div>
              </div>
              <span className={`risk-b ${risk.cls}`}>{risk.label} · <Countdown until={p.createdAt + timeoutMs} className="countdown" /></span>
              <button type="button" className="btn sm primary" onClick={() => onOpenDetail(p)}>详情</button>
            </div>
          );
        })
      )}
    </div>
  );
}
