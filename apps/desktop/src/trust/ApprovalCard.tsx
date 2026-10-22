import { useState } from 'react';
import { Button } from '@sparkii/ui';
import { payloadSummary, type ApprovalProposalLike } from './types.js';
import { present } from './present.js';
import { ApprovalPreviewBlock } from './ApprovalPreviewBlock.js';

export interface ApprovalCardProps {
  proposal: ApprovalProposalLike;
  onDecide(
    id: string,
    approved: boolean,
    note?: string,
    scope?: 'once' | 'task',
  ): void;
}

/** Only a plain platform Shell command may be allowed for the rest of a Task. */
export function isTaskScopableShell(proposal: ApprovalProposalLike): boolean {
  return proposal.targetSystem === 'platform:process.exec' && proposal.risk !== 'high-risk';
}

export function ApprovalCard({ proposal, onDecide }: ApprovalCardProps) {
  const vm = present(proposal);
  const [showPayload, setShowPayload] = useState(false);
  const shell = isTaskScopableShell(proposal);
  return (
    <div className="ui-approval-queue-item" data-testid="approval-queue-item">
      <div className="ui-approval-queue-item-head">
        <div className="ui-approval-queue-item-title">
          <b>{vm.title}</b>
        </div>
        {shell && (
          <div className="ui-approval-queue-item-subtitle">宿主执行，非沙箱</div>
        )}
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
      <div className="ui-panel-actions">
        <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, false)}>{vm.actions.reject}</Button>
        {shell && (
          <Button className="ui-panel-action" onClick={() => onDecide(proposal.id, true, undefined, 'task')}>
            本任务允许 Shell
          </Button>
        )}
        <Button
          variant="primary"
          className="ui-panel-action"
          onClick={() => onDecide(proposal.id, true, undefined, shell ? 'once' : undefined)}
        >
          {shell ? '允许一次' : vm.actions.allow}
        </Button>
      </div>
    </div>
  );
}
