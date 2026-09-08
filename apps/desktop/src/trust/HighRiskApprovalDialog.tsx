import { useState } from 'react';
import { Button, Countdown, Modal, RiskBadge, TextArea } from '@sparkii/ui';
import { payloadSummary } from './types.js';
import { present } from './present.js';
import { ApprovalPreviewBlock } from './ApprovalPreviewBlock.js';
import { useApprovalInbox } from './ApprovalInbox.js';

export interface HighRiskApprovalDialogProps {
  timeoutMs?: number;
}

export function HighRiskApprovalDialog({ timeoutMs = 120000 }: HighRiskApprovalDialogProps) {
  const { proposals, decide } = useApprovalInbox();
  const proposal = [...proposals.values()].find((p) => p.risk === 'high-risk');
  const [note, setNote] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const [armed, setArmed] = useState(false);

  if (!proposal) return null;

  const vm = present(proposal);
  const approve = () => {
    if (!armed) { setArmed(true); return; }
    void decide(proposal.id, true, note);
  };

  return (
    <Modal open title={vm.title} onClose={() => {}}>
      <div className="ui-kv">
        {vm.subtitle && <div>{vm.subtitle}</div>}
        {vm.chrome.showRisk && <RiskBadge risk={proposal.risk} />}
        {vm.chrome.showCountdown && (
          <> · 剩余 <Countdown until={proposal.createdAt + timeoutMs} className="ui-countdown" /></>
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
        <Button className="ui-panel-action" onClick={() => void decide(proposal.id, false, note)}>{vm.actions.reject}</Button>
        <Button variant="primary" className="ui-panel-action" onClick={approve}>
          {armed ? vm.actions.confirmAllow : vm.actions.allow}
        </Button>
      </div>
      <div className="ui-muted ui-panel-hint">超时自动拒绝 · 拒绝即不写</div>
    </Modal>
  );
}
