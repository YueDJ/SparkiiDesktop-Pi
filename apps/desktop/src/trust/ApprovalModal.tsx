import { useState } from 'react';
import { Button, Countdown, Modal, RiskBadge, TextArea } from '@sparkii/ui';
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
    <Modal open title="写操作审批" onClose={onClose}>
      <div className="ui-kv">
        操作:<b>{proposal.summary}</b><br />
        工具:{proposal.toolName ?? '-'}<br />
        目标:{proposal.targetSystem ?? '-'}<br />
        来源:会话 {proposal.sessionId?.slice(0, 8) ?? '-'}<br />
        风险:<RiskBadge risk={proposal.risk} /> · 剩余 <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} className="ui-countdown" />
      </div>
      <div className="ui-panel-block">
        <Button size="sm" onClick={() => setShowPayload((v) => !v)}>冻结参数 {showPayload ? '▾' : '▸'}</Button>
        {showPayload && (
          <>
            <pre className="ui-payload">{payloadSummary(proposal.payload)}</pre>
            {typeof (proposal.payload as { diff?: unknown })?.diff === 'string' && (
              <DiffView diff={(proposal.payload as { diff: string }).diff} />
            )}
          </>
        )}
      </div>
      <TextArea rows={2} placeholder="审批意见(可选)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false, note)}>拒绝</Button>
        <Button variant="primary" className="ui-panel-action" onClick={approve}>{highRisk && armed ? '再次确认批准' : '批准'}</Button>
      </div>
      <div className="ui-muted ui-panel-hint">超时自动拒绝 · 拒绝即不写</div>
    </Modal>
  );
}
