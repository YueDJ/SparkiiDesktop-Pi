import { ToolCard as UiToolCard } from '@sparkii/ui';
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
  const resultRec = (result ?? {}) as { details?: { diff?: string } };
  const inputRec = (input ?? {}) as { diff?: string };
  const diff = inputRec.diff ?? resultRec.details?.diff;
  return (
    <UiToolCard
      toolName={toolName}
      input={input}
      result={result}
      awaitingApproval={awaitingApproval}
      summary={summaryOf(toolName, input)}
      detail={typeof diff === 'string' ? <DiffView diff={diff} /> : undefined}
    />
  );
}
