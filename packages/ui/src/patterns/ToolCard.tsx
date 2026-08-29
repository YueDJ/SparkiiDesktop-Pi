import { useState, type ReactNode } from 'react';

const TOOL_GLYPH: Record<string, string> = {
  bash: '›_', write: '✎', edit: '✎', read: '◉', read_file: '◉', patch: '✚',
  apply_patch: '✚', search: '⌕', grep: '⌕', knowledge: '❖', report: '▤',
  export: '⇩', web: '↗', http: '↗', list: '≡', ls: '›_', cat: '›_',
};

export function ToolCard({
  toolName,
  input,
  result,
  awaitingApproval = false,
  detail,
  summary,
  defaultOpen = false,
}: {
  toolName: string;
  input: unknown;
  result?: unknown;
  awaitingApproval?: boolean;
  detail?: ReactNode;
  summary?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const status = awaitingApproval ? 'approval' : result ? 'ok' : 'running';
  const statusLabel = awaitingApproval ? '等待审批' : result ? '完成' : '运行中';
  const glyph = TOOL_GLYPH[toolName] ?? '⚙';

  return (
    <div className={`ui-tool-card ui-tool-card--${status}`} data-testid="tool-card">
      <div className="ui-tool-card-head">
        <span className="ui-tool-card-icon" aria-hidden="true">{glyph}</span>
        <b className="ui-tool-card-name">{toolName}</b>
        {summary && <span className="ui-tool-card-summary" title={summary}>{summary}</span>}
        <span className={`ui-tool-card-status ui-status-badge ui-status-badge--${status}`}>{statusLabel}</span>
        <button
          type="button"
          className="ui-btn ui-btn--sm ui-btn--ghost ui-tool-card-toggle"
          data-testid="tool-card-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '详情 ▾' : '详情 ▸'}
        </button>
      </div>
      {open && <div className="ui-tool-card-detail">{detail ?? <pre className="ui-payload">{JSON.stringify({ input, result }, null, 2)}</pre>}</div>}
    </div>
  );
}
