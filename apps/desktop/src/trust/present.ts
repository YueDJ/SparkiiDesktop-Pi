import type { ApprovalPreviewKind } from '@sparkii/approval';

export const PREVIEW_VISIBLE_LINES = 5;

export type PresentableProposal = {
  summary?: string | null;
  preview?: { kind?: string; lines?: unknown } | null;
  risk?: string | null;
};

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

function previewLines(preview: PresentableProposal['preview']): string[] {
  if (!Array.isArray(preview?.lines)) return [];
  return preview.lines.filter((line): line is string => typeof line === 'string');
}

function previewKind(preview: PresentableProposal['preview']): ApprovalPreviewKind | 'none' {
  return preview?.kind === 'diff' || preview?.kind === 'text' ? preview.kind : 'none';
}

export function present(proposal: PresentableProposal): ApprovalViewModel {
  const highRisk = proposal.risk === 'high-risk';
  const lines = previewKind(proposal.preview) === 'none' ? [] : previewLines(proposal.preview);
  const kind = previewKind(proposal.preview);
  return {
    title: (proposal.summary ?? '').trim() || '需要你确认',
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

export function partitionApprovals<T extends PresentableProposal>(pending: T[]): { routine: T[]; highRisk: T[] } {
  const routine: T[] = [];
  const highRisk: T[] = [];
  for (const proposal of pending) {
    if (present(proposal).chrome.mode === 'modal') highRisk.push(proposal);
    else routine.push(proposal);
  }
  return { routine, highRisk };
}
