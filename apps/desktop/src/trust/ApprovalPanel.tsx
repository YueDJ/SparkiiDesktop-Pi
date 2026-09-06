import { useState } from 'react';
import { Button, Countdown, Drawer } from '@sparkii/ui';
import { payloadSummary, type ApprovalProposalLike } from './types.js';
import { present } from './present.js';
import { ApprovalPreviewBlock } from './ApprovalPreviewBlock.js';

export interface ApprovalPanelProps {
  proposals: ApprovalProposalLike[];
  currentSessionId?: string | null;
  timeoutMs?: number;
  onDecide(id: string, approved: boolean, note?: string): void;
  onClose(): void;
}

function ApprovalQueueItem({
  proposal,
  timeoutMs,
  onDecide,
}: {
  proposal: ApprovalProposalLike;
  timeoutMs: number;
  onDecide(id: string, approved: boolean, note?: string): void;
}) {
  const vm = present(proposal);
  const [showPayload, setShowPayload] = useState(false);
  const until = proposal.createdAt + timeoutMs;

  return (
    <div className="ui-approval-queue-item" data-testid="approval-queue-item">
      <div className="ui-approval-queue-item-head">
        <div className="ui-approval-queue-item-title">
          <b>{vm.title}</b>
        </div>
      </div>
      <ApprovalPreviewBlock preview={vm.preview} />
      <button type="button" className="ui-btn ui-btn--sm ui-approval-queue-toggle" onClick={() => setShowPayload((v) => !v)}>
        技术细节 {showPayload ? '▾' : '▸'}
      </button>
      {showPayload && (
        <div className="ui-approval-queue-payload">
          <pre className="ui-payload">{payloadSummary(proposal.payload)}</pre>
        </div>
      )}
      <span aria-hidden="true" className="ui-countdown--hidden">
        <Countdown until={until} onExpire={() => onDecide(proposal.id, false, 'timeout')} />
      </span>
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false)}>{vm.actions.reject}</Button>
        <Button variant="primary" className="ui-panel-action" onClick={() => onDecide(proposal.id, true)}>{vm.actions.allow}</Button>
      </div>
    </div>
  );
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const { proposals, currentSessionId = null, timeoutMs = 120000, onDecide, onClose } = props;
  const current = proposals.filter((p) => p.sessionId === currentSessionId);
  const others = proposals.filter((p) => p.sessionId !== currentSessionId);
  const isEmpty = proposals.length === 0;

  return (
    <Drawer open fixed title="需要你确认" onClose={onClose} className="ui-approval-drawer">
      <div className="ui-approval-qhead">
        <b>{isEmpty ? '暂无待确认' : `${proposals.length} 处改动等你看`}</b>
      </div>
      <div className="ui-approval-queue">
        {isEmpty ? (
          <div className="ui-muted ui-approval-empty">没有待确认的事项</div>
        ) : (
          <>
            {current.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">当前会话</div>
                {current.map((p) => (
                  <ApprovalQueueItem key={p.id} proposal={p} timeoutMs={timeoutMs} onDecide={onDecide} />
                ))}
              </section>
            )}
            {others.length > 0 && (
              <section className="ui-approval-group">
                <div className="ui-approval-group-title">其他会话</div>
                {others.map((p) => (
                  <ApprovalQueueItem key={p.id} proposal={p} timeoutMs={timeoutMs} onDecide={onDecide} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
