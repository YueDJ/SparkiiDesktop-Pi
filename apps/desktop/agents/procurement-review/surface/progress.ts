import type { SessionEntry } from '../../../src/surface/contract.js';

export type ProgState = 'done' | 'skip' | 'on' | 'wait';

export function hasReviewOutput(entries: SessionEntry[]): boolean {
  return entries.some((e) => (
    e.kind === 'custom'
    && e.customType === 'workflow_step_end'
    && String(e.data.stepId ?? '') === 'review'
  ));
}

export function analysisProgress(input: {
  streaming: boolean;
  status?: 'idle' | 'running' | 'done' | 'failed';
  currentStep?: string | null;
  thin: boolean;
  policyClosed: boolean;
  reviewReady: boolean;
}): Array<{ id: 'align' | 'complete' | 'rules' | 'policy' | 'write'; label: string; state: ProgState }> {
  const { streaming, status, currentStep, thin, policyClosed, reviewReady } = input;
  const policyDone = reviewReady || currentStep === 'review' || currentStep === 'report' || status === 'done';
  const writeDone = reviewReady || currentStep === 'report' || status === 'done';
  const policyState: ProgState = policyClosed
    ? 'skip'
    : streaming && currentStep === 'search'
      ? 'on'
      : policyDone
        ? 'done'
        : 'wait';
  const writeState: ProgState = streaming && currentStep === 'review'
    ? 'on'
    : writeDone
      ? 'done'
      : 'wait';
  return [
    { id: 'align', label: '对齐编码', state: 'done' },
    { id: 'complete', label: '完整性', state: 'done' },
    { id: 'rules', label: '套规则', state: thin ? 'skip' : 'done' },
    { id: 'policy', label: '制度', state: policyState },
    { id: 'write', label: '撰写发现', state: writeState },
  ];
}
