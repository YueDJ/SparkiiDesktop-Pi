import { useState, type ReactNode } from 'react';

export function ToolCard({ toolName, input, result, awaitingApproval = false, detail }: { toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const status = awaitingApproval ? 'approval' : result ? 'ok' : 'running';
  const statusLabel = awaitingApproval ? '等待审批' : result ? '完成' : '运行中';
  return (
    <div className={`ui-tool-card ui-tool-card--${status}`} data-testid="tool-card">
      <div className="ui-tool-card-head"><b>{toolName}</b><span className="ui-tool-card-status">{statusLabel}</span></div>
      <button type="button" className="ui-btn ui-btn--sm" onClick={() => setOpen((v) => !v)}>详情 {open ? '▾' : '▸'}</button>
      {open && (detail ?? <pre className="ui-payload">{JSON.stringify({ input, result }, null, 2)}</pre>)}
    </div>
  );
}
