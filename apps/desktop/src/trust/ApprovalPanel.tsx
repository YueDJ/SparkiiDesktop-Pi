import { useState } from 'react';
import { Countdown } from './Countdown.js';
import { payloadSummary, riskInfo, type ApprovalProposalLike } from './types.js';

export interface ApprovalPanelProps {
  proposal: ApprovalProposalLike;
  timeoutMs?: number;
  onDecide(id: string, approved: boolean, note?: string): void;
  onClose(): void;
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const { proposal, timeoutMs = 120000, onDecide, onClose } = props;
  const [note, setNote] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const risk = riskInfo(proposal.risk);
  const until = proposal.createdAt + timeoutMs;

  return (
    <>
      <button type="button" className="drawer-backdrop fixed" aria-label="关闭审批" onClick={onClose} />
      <aside className="drawer open fixed" role="dialog" aria-label="写操作审批">
        <div className="drawer-head"><span>写操作审批</span><button type="button" className="icon-btn" title="关闭" onClick={onClose}>✕</button></div>
        <div className="drawer-body">
          <div className="kv">操作:<b>{proposal.summary}</b></div>
          <div className="kv">工具:{proposal.toolName ?? '-'}</div>
          <div className="kv">目标:{proposal.targetSystem ?? '-'}</div>
          <div className="kv">来源:会话 {proposal.sessionId?.slice(0, 8) ?? '-'}</div>
          <div className="kv" style={{ marginTop: 8 }}>
            风险:<span className={`risk-b ${risk.cls}`}>{risk.label}</span> · 剩余 <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} className="countdown" />
          </div>
          <div style={{ margin: '12px 0' }}>
            <button type="button" className="btn sm" onClick={() => setShowPayload((v) => !v)}>冻结参数 {showPayload ? '▾' : '▸'}</button>
            {showPayload && (
              <pre className="payload-box">{payloadSummary(proposal.payload)}</pre>
            )}
          </div>
          <textarea className="field" rows={3} placeholder="审批意见(可选)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onDecide(proposal.id, false, note)}>拒绝</button>
            <button type="button" className="btn primary" style={{ flex: 1 }} onClick={() => onDecide(proposal.id, true, note)}>批准</button>
          </div>
          <div className="muted" style={{ textAlign: 'center', marginTop: 10 }}>超时自动拒绝 · 拒绝即不写</div>
        </div>
      </aside>
    </>
  );
}
