import { useState } from 'react';
import { Countdown } from './Countdown.js';
import { payloadSummary, riskInfo, type ApprovalProposalLike } from './types.js';
import { DiffView } from '../workbench/DiffView.js';

export interface ApprovalModalProps {
  proposal: ApprovalProposalLike;
  timeoutMs?: number;
  onDecide(id: string, approved: boolean, note?: string): void;
  onClose(): void;
}

export function ApprovalModal(props: ApprovalModalProps) {
  const { proposal, timeoutMs = 120000, onDecide, onClose } = props;
  const [note, setNote] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const [armed, setArmed] = useState(false);
  const risk = riskInfo(proposal.risk);
  const highRisk = risk.level === 'high';
  const until = proposal.createdAt + timeoutMs;

  const approve = () => {
    if (highRisk && !armed) { setArmed(true); return; }
    onDecide(proposal.id, true, note);
  };

  return (
    <div className="modal-mask open">
      <div className="modal" role="dialog" aria-label="写操作审批">
        <h3 style={{ margin: '0 0 6px' }}>写操作审批</h3>
        <div className="kv">
          操作:<b>{proposal.summary}</b><br />
          工具:{proposal.toolName ?? '-'}<br />
          目标:{proposal.targetSystem ?? '-'}<br />
          来源:会话 {proposal.sessionId?.slice(0, 8) ?? '-'}<br />
          风险:<span className={`risk-b ${risk.cls}`}>{risk.label}</span> · 剩余 <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} className="countdown" />
        </div>
        <div style={{ margin: '10px 0' }}>
          <button type="button" className="btn sm" onClick={() => setShowPayload((v) => !v)}>冻结参数 {showPayload ? '▾' : '▸'}</button>
          {showPayload && (
            <>
              <pre className="payload-box">{payloadSummary(proposal.payload)}</pre>
              {typeof (proposal.payload as { diff?: unknown })?.diff === 'string' && (
                <DiffView diff={(proposal.payload as { diff: string }).diff} />
              )}
            </>
          )}
        </div>
        <textarea className="field" rows={2} placeholder="审批意见(可选)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onDecide(proposal.id, false, note)}>拒绝</button>
          <button type="button" className="btn primary" style={{ flex: 1 }} onClick={approve}>{highRisk && armed ? '再次确认批准' : '批准'}</button>
        </div>
        <div className="muted" style={{ marginTop: 10, textAlign: 'center' }}>超时自动拒绝 · 拒绝即不写</div>
      </div>
    </div>
  );
}
