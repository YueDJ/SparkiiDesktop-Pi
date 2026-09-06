import { useState } from 'react';
import { Button, Countdown, Modal, RiskBadge, TextArea } from '@sparkii/ui';
import { payloadSummary, type ApprovalProposalLike } from './types.js';
import { present } from './present.js';
import { ApprovalPreviewBlock } from './ApprovalPreviewBlock.js';

export interface ApprovalModalProps {
  proposal: ApprovalProposalLike;
  timeoutMs?: number;
  onDecide(id: string, approved: boolean, note?: string): void;
  onClose(): void;
}

export function ApprovalModal(props: ApprovalModalProps) {
  const { proposal, timeoutMs = 120000, onDecide, onClose } = props;
  const vm = present(proposal);
  const [note, setNote] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const [armed, setArmed] = useState(false);
  const until = proposal.createdAt + timeoutMs;
  const needsConfirm = vm.chrome.mode === 'modal';

  const approve = () => {
    if (needsConfirm && !armed) { setArmed(true); return; }
    onDecide(proposal.id, true, note);
  };

  return (
    <Modal open title={vm.title} onClose={onClose}>
      <div className="ui-kv">
        {vm.subtitle && <div>{vm.subtitle}</div>}
        {vm.chrome.showRisk && <RiskBadge risk={proposal.risk} />}
        {vm.chrome.showCountdown && (
          <> · 剩余 <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} className="ui-countdown" /></>
        )}
      </div>
      <ApprovalPreviewBlock preview={vm.preview} />
      <div className="ui-panel-block">
        <Button size="sm" onClick={() => setShowPayload((v) => !v)}>技术细节 {showPayload ? '▾' : '▸'}</Button>
        {showPayload && <pre className="ui-payload">{payloadSummary(proposal.payload)}</pre>}
      </div>
      {vm.chrome.showNote && (
        <TextArea rows={2} placeholder="审批意见（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false, note)}>{vm.actions.reject}</Button>
        <Button variant="primary" className="ui-panel-action" onClick={approve}>
          {needsConfirm && armed ? vm.actions.confirmAllow : vm.actions.allow}
        </Button>
      </div>
      <div className="ui-muted ui-panel-hint">超时自动拒绝 · 拒绝即不写</div>
    </Modal>
  );
}
