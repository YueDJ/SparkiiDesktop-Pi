import { useEffect } from 'react';
import { ApprovalCard } from './ApprovalCard.js';
import { useApprovalInbox } from './ApprovalInbox.js';
import type { ApprovalProposalLike } from './types.js';

export function InlineApprovalCard({ proposal }: { proposal: ApprovalProposalLike }) {
  const { claim, release, decide } = useApprovalInbox();
  useEffect(() => {
    claim(proposal.id);
    return () => release(proposal.id);
  }, [proposal.id, claim, release]);
  return <ApprovalCard proposal={proposal} onDecide={(id, ok, note) => { void decide(id, ok, note); }} />;
}
