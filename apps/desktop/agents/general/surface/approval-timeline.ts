import type { SessionEntry } from '../../../src/surface/contract.js';

function isApprovalRow(entry: SessionEntry, customType: string): entry is Extract<SessionEntry, { kind: 'custom' }> {
  return entry.kind === 'custom' && entry.customType === customType;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function applyApprovalStatus(entries: SessionEntry[]): SessionEntry[] {
  const hasApproval = entries.some((entry) =>
    isApprovalRow(entry, 'approval_required') || isApprovalRow(entry, 'approval_resolved'),
  );
  if (!hasApproval) return entries;

  const next = entries.map((entry) => (entry.kind === 'tool' ? { ...entry } : entry));
  const consumed = new Set<number>();
  const fifoByName = new Map<string, number[]>();
  const byCallId = new Map<string, number>();

  for (let i = 0; i < next.length; i += 1) {
    const entry = next[i];
    if (entry.kind !== 'tool') continue;
    if (entry.toolCallId) byCallId.set(entry.toolCallId, i);
    const queue = fifoByName.get(entry.toolName) ?? [];
    queue.push(i);
    fifoByName.set(entry.toolName, queue);
  }

  const takeTool = (toolName: string, toolCallId?: string): number => {
    if (toolCallId) {
      const indexed = byCallId.get(toolCallId);
      if (indexed !== undefined && !consumed.has(indexed)) {
        consumed.add(indexed);
        return indexed;
      }
    }
    const queue = fifoByName.get(toolName) ?? [];
    while (queue.length > 0) {
      const i = queue.shift()!;
      if (consumed.has(i)) continue;
      const tool = next[i];
      if (tool.kind !== 'tool' || tool.result !== undefined) continue;
      consumed.add(i);
      return i;
    }
    return -1;
  };

  const byRequestId = new Map<string, number>();

  for (const entry of entries) {
    if (entry.kind !== 'custom') continue;
    const requestId = stringField(entry.data, 'requestId');
    const toolName = stringField(entry.data, 'toolName') ?? '';
    const toolCallId = stringField(entry.data, 'toolCallId');

    if (entry.customType === 'approval_required') {
      const i = takeTool(toolName, toolCallId);
      if (i < 0 || !requestId) continue;
      byRequestId.set(requestId, i);
      const tool = next[i];
      if (tool.kind === 'tool') next[i] = { ...tool, awaitingApproval: true };
      continue;
    }

    if (entry.customType === 'approval_resolved') {
      if (!requestId) continue;
      const i = byRequestId.get(requestId);
      if (i === undefined) continue;
      const tool = next[i];
      if (tool.kind !== 'tool') continue;
      const denied = entry.data.status === 'denied';
      next[i] = {
        ...tool,
        awaitingApproval: false,
        ...(denied && tool.result === undefined ? { isError: true } : {}),
      };
    }
  }

  return next;
}
