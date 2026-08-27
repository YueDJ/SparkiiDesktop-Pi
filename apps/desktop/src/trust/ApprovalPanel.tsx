import { useState } from 'react';
import { Button, Countdown, Drawer, RiskBadge, TextArea } from '@sparkii/ui';
import { payloadSummary, type ApprovalProposalLike } from './types.js';
import { DiffView } from '../workbench/DiffView.js';

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
  const until = proposal.createdAt + timeoutMs;

  return (
    <Drawer open fixed title="写操作审批" onClose={onClose}>
      <div className="ui-kv">操作:<b>{proposal.summary}</b></div>
      <div className="ui-kv">工具:{proposal.toolName ?? '-'}</div>
      <div className="ui-kv">目标:{proposal.targetSystem ?? '-'}</div>
      <div className="ui-kv">来源:会话 {proposal.sessionId?.slice(0, 8) ?? '-'}</div>
      <div className="ui-kv ui-kv-mt">
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
      <TextArea rows={3} placeholder="审批意见(可选)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false, note)}>拒绝</Button>
        <Button variant="primary" className="ui-panel-action" onClick={() => onDecide(proposal.id, true, note)}>批准</Button>
      </div>
      <div className="ui-muted ui-panel-hint">超时自动拒绝 · 拒绝即不写</div>
    </Drawer>
  );
}
