import type { ReactNode } from 'react';
import { ApprovalItem, Countdown, RiskBadge } from '@sparkii/ui';
import type { ApprovalProposalLike } from './types.js';
import { present } from './present.js';
import { useApprovalInbox } from './ApprovalInbox.js';

export interface ApprovalCenterProps {
  timeoutMs?: number;
  onOpenDetail(proposal: ApprovalProposalLike): void;
}

export function ApprovalCenter(props: ApprovalCenterProps) {
  const { timeoutMs = 120000, onOpenDetail } = props;
  const { proposals } = useApprovalInbox();
  const list = [...proposals.values()];
  return (
    <div className="ui-approval-list">
      {list.length === 0 ? (
        <div className="ui-muted ui-approval-empty">没有待确认的事项</div>
      ) : (
        list.map((p) => {
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
