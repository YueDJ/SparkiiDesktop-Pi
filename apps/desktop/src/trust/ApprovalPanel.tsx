import { useState } from 'react';
import { Button, Countdown, Drawer, RiskBadge, TextArea } from '@sparkii/ui';
import { payloadSummary, riskInfo, type ApprovalProposalLike } from './types.js';
import { DiffView } from '../workbench/DiffView.js';

export interface ApprovalPanelProps {
  proposals: ApprovalProposalLike[];
  currentSessionId?: string | null;
  timeoutMs?: number;
  focusId?: string | null;
  onDecide(id: string, approved: boolean, note?: string): void;
  onClose(): void;
}

function ApprovalQueueItem({
  proposal,
  currentSessionId,
  timeoutMs,
  onDecide,
  initialExpanded = false,
}: {
  proposal: ApprovalProposalLike;
  currentSessionId: string | null;
  timeoutMs: number;
  onDecide(id: string, approved: boolean, note?: string): void;
  initialExpanded?: boolean;
}) {
  const [note, setNote] = useState('');
  const [showPayload, setShowPayload] = useState(initialExpanded);
  const [armed, setArmed] = useState(false);
  const risk = riskInfo(proposal.risk);
  const highRisk = risk.level === 'high';
  const until = proposal.createdAt + timeoutMs;
  const isCurrent = proposal.sessionId === currentSessionId;
  const sessionShort = proposal.sessionId?.slice(0, 8);
  const payload = (proposal.payload ?? {}) as { diff?: string };

  const approve = () => {
    if (highRisk && !armed) { setArmed(true); return; }
    onDecide(proposal.id, true, note);
  };

  return (
    <div className="ui-approval-queue-item" data-testid="approval-queue-item">
      <div className="ui-approval-queue-item-head">
        <div className="ui-approval-queue-item-title">
          <b>{proposal.summary}</b>
          <span>
            {proposal.toolName ?? '-'}
            {sessionShort ? ` · 会话 ${sessionShort}` : ''}
          </span>
        </div>
        <div className="ui-approval-queue-item-badges">
          <RiskBadge risk={proposal.risk} />
          <span className="ui-approval-queue-session">{isCurrent ? '本会话' : sessionShort ? `会话 ${sessionShort}` : '其他'}</span>
          <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} className="ui-countdown" />
        </div>
      </div>
      <div className="ui-approval-queue-item-meta">目标: {proposal.targetSystem ?? '-'}</div>
      <button type="button" className="ui-btn ui-btn--sm ui-approval-queue-toggle" onClick={() => setShowPayload((v) => !v)}>
        冻结参数 {showPayload ? '▾' : '▸'}
      </button>
      {showPayload && (
        <div className="ui-approval-queue-payload">
          <pre className="ui-payload">{payloadSummary(proposal.payload)}</pre>
          {typeof payload.diff === 'string' && <DiffView diff={payload.diff} />}
        </div>
      )}
      <div className="ui-approval-queue-note">
        <div className="ui-approval-queue-label">审批意见(可选)</div>
        <TextArea rows={2} placeholder="审批意见(可选)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false, note)}>拒绝</Button>
        <Button variant="primary" className="ui-panel-action" onClick={approve}>{highRisk && armed ? '再次确认批准' : '批准'}</Button>
      </div>
      {highRisk && <div className="ui-muted ui-panel-hint">高风险操作需二次确认 · 超时自动拒绝</div>}
    </div>
  );
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const { proposals, currentSessionId = null, timeoutMs = 120000, focusId = null, onDecide, onClose } = props;
  const current = proposals.filter((p) => p.sessionId === currentSessionId);
  const others = proposals.filter((p) => p.sessionId !== currentSessionId);
  const isEmpty = proposals.length === 0;

  return (
    <Drawer open fixed title="写操作审批" onClose={onClose} className="ui-approval-drawer">
      <div className="ui-approval-qhead">
        <b>{isEmpty ? '暂无待审批' : `待审批 ${proposals.length} 项`}</b>
        {!isEmpty && <span className="ui-approval-qhint">在抽屉内直接批准或拒绝</span>}
      </div>
      <div className="ui-approval-queue">
        {isEmpty ? (
          <div className="ui-muted ui-approval-empty">没有待处理的审批事项</div>
        ) : (
          <>
            {current.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">当前会话</div>
                {current.map((p) => (
                  <ApprovalQueueItem key={p.id} proposal={p} currentSessionId={currentSessionId} timeoutMs={timeoutMs} onDecide={onDecide} initialExpanded={p.id === focusId} />
                ))}
              </section>
            )}
            {others.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">其他会话</div>
                {others.map((p) => (
                  <ApprovalQueueItem key={p.id} proposal={p} currentSessionId={currentSessionId} timeoutMs={timeoutMs} onDecide={onDecide} initialExpanded={p.id === focusId} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
