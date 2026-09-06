import type { ReactNode } from 'react';
import { ApprovalItem, Countdown, RiskBadge } from '@sparkii/ui';
import type { ApprovalProposalLike } from './types.js';
import { present } from './present.js';

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
        <div className="ui-muted ui-approval-empty">没有待确认的事项</div>
      ) : (
        proposals.map((p) => {
          const vm = present(p);
          const badge: ReactNode = vm.chrome.showRisk ? <RiskBadge risk={p.risk} /> : undefined;
          const countdown: ReactNode = vm.chrome.showCountdown
            ? <Countdown until={p.createdAt + timeoutMs} className="ui-countdown" />
            : undefined;
          return (
            <ApprovalItem
              key={p.id}
              title={vm.title}
              badge={badge}
              countdown={countdown}
              onOpenDetail={() => onOpenDetail(p)}
            />
          );
        })
      )}
    </div>
  );
}
