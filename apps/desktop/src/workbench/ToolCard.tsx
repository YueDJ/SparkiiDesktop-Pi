import { useState } from 'react';
import { DiffView } from './DiffView.js';

export interface ToolCardProps {
  toolName: string;
  input: unknown;
  result?: unknown;
  awaitingApproval?: boolean;
}

function summaryOf(toolName: string, input: unknown): string {
  const rec = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'bash') return String(rec.command ?? '');
  if (typeof rec.path === 'string') return rec.path;
  return toolName;
}

export function ToolCard(props: ToolCardProps) {
  const { toolName, input, result, awaitingApproval } = props;
  const [open, setOpen] = useState(false);
  const resultRec = (result ?? {}) as { details?: { diff?: string } };
  const inputRec = (input ?? {}) as { diff?: string };
  const diff = inputRec.diff ?? resultRec.details?.diff;
  const status = awaitingApproval ? '等待审批' : result ? '完成' : '运行中…';
  const cls = awaitingApproval ? 'await' : result ? 'done' : 'run';

  return (
    <div className={`tool-card ${cls}`} data-testid="tool-card">
      <div className="tool-head">
        <b>{toolName}</b>
        <span className="tool-summary">{summaryOf(toolName, input)}</span>
        <span className={`tool-status ${cls}`}>{status}</span>
      </div>
      <button type="button" className="btn sm" onClick={() => setOpen((v) => !v)}>详情 {open ? '▾' : '▸'}</button>
      {open && (
        <div className="tool-detail">
          <pre className="payload-box">{JSON.stringify(input, null, 2)}</pre>
          {typeof result === 'string' && <pre className="payload-box">{result}</pre>}
          {diff && <DiffView diff={diff} />}
        </div>
      )}
    </div>
  );
}
