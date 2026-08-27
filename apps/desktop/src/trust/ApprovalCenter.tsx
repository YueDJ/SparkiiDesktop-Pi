import { ApprovalItem, Countdown } from '@sparkii/ui';
import type { ApprovalProposalLike } from './types.js';

export interface ApprovalCenterProps {
  proposals: ApprovalProposalLike[];
  timeoutMs?: number;
  onOpenDetail(proposal: ApprovalProposalLike): void;
}

export function ApprovalCenter(props: ApprovalCenterProps) {
  const { proposals, timeoutMs = 120000, onOpenDetail } = props;
  return (
    <div className="ui-approval-list">
      {proposals.length === 0 ? (
        <div className="ui-muted ui-approval-empty">没有待处理的审批事项</div>
      ) : (
        proposals.map((p) => (
          <ApprovalItem
            key={p.id}
            summary={p.summary}
            risk={p.risk}
            toolName={p.toolName}
            sessionId={p.sessionId}
            countdownText={<Countdown until={p.createdAt + timeoutMs} className="ui-countdown" />}
            onOpenDetail={() => onOpenDetail(p)}
          />
        ))
      )}
    </div>
  );
}
