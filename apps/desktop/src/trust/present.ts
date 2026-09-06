import type { ApprovalPreviewKind } from '@sparkii/approval';

export const PREVIEW_VISIBLE_LINES = 5;

export type ApprovalViewModel = {
  title: string;
  subtitle: string | null;
  preview: {
    kind: ApprovalPreviewKind | 'none';
    lines: string[];
    visibleLines: string[];
    hiddenCount: number;
  };
  chrome: {
    mode: 'panel' | 'modal';
    showRisk: boolean;
    showCountdown: boolean;
    showNote: boolean;
  };
  actions: {
    reject: '拒绝';
    allow: '允许';
    confirmAllow: '再次确认允许';
  };
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function previewLines(preview: unknown): string[] {
  const rec = recordOf(preview);
  if (!Array.isArray(rec.lines)) return [];
  return rec.lines.filter((line): line is string => typeof line === 'string');
}

function previewKind(preview: unknown): ApprovalPreviewKind | 'none' {
  const rec = recordOf(preview);
  return rec.kind === 'diff' || rec.kind === 'text' ? rec.kind : 'none';
}

export function present(proposal: unknown): ApprovalViewModel {
  const rec = recordOf(proposal);
  const highRisk = rec.risk === 'high-risk';
  const kind = previewKind(rec.preview);
  const lines = kind === 'none' ? [] : previewLines(rec.preview);
  return {
    title: (typeof rec.summary === 'string' ? rec.summary : '').trim() || '需要你确认',
    subtitle: highRisk ? '可能无法恢复' : null,
    preview: {
      kind,
      lines,
      visibleLines: lines.slice(0, PREVIEW_VISIBLE_LINES),
      hiddenCount: Math.max(0, lines.length - PREVIEW_VISIBLE_LINES),
    },
    chrome: {
      mode: highRisk ? 'modal' : 'panel',
      showRisk: highRisk,
      showCountdown: highRisk,
      showNote: highRisk,
    },
    actions: {
      reject: '拒绝',
      allow: '允许',
      confirmAllow: '再次确认允许',
    },
  };
}

export function partitionApprovals<T>(pending: T[]): { routine: T[]; highRisk: T[] } {
  const routine: T[] = [];
  const highRisk: T[] = [];
  for (const proposal of pending) {
    if (present(proposal).chrome.mode === 'modal') highRisk.push(proposal);
    else routine.push(proposal);
  }
  return { routine, highRisk };
}
