import { useEffect, useRef } from 'react';

export function ApprovalDialog(props: { proposal: { id: string; summary: string; risk: string; payloadHash: string; createdAt: number }; timeoutMs?: number; onDecide(id: string, approved: boolean, note?: string): void }) {
  const note = useRef('');
  useEffect(() => {
    if (!props.timeoutMs) return;
    const t = setTimeout(() => props.onDecide(props.proposal.id, false, 'timeout'), props.timeoutMs);
    return () => clearTimeout(t);
  }, [props.timeoutMs]);
  return (
    <div role="dialog" aria-label="approval">
      <p>{props.proposal.summary}</p>
      <p className="muted">risk: {props.proposal.risk} · {props.proposal.payloadHash.slice(0, 12)}</p>
      <textarea onChange={(e) => (note.current = e.target.value)} placeholder="审批意见" />
      <button onClick={() => props.onDecide(props.proposal.id, true, note.current)}>批准</button>
      <button onClick={() => props.onDecide(props.proposal.id, false, note.current)}>拒绝</button>
    </div>
  );
}
