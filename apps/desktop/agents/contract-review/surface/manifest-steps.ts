export interface StepItem {
  id: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'failed';
}

export const STEP_IDS = ['load', 'search', 'extract', 'compare', 'report'] as const;

const LABELS: Record<string, string> = {
  load: '解析',
  search: '检索',
  extract: '抽取',
  compare: '比对',
  report: '报告',
};

export function deriveSteps(workflow: { status: string; step?: string; error?: string }): StepItem[] {
  const lastOf = (i: number) => i < 0 ? 0 : i;

  if (workflow.status === 'done') {
    return STEP_IDS.map((id) => ({ id, label: LABELS[id], state: 'done' as const }));
  }
  if (workflow.status === 'failed') {
    const idx = lastOf(STEP_IDS.indexOf(workflow.step as (typeof STEP_IDS)[number]));
    return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i < idx ? 'done' : i === idx ? 'failed' : 'pending' }));
  }
  if (workflow.status !== 'running') {
    return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i === 0 ? 'active' as const : 'pending' as const }));
  }
  const idx = lastOf(STEP_IDS.indexOf(workflow.step as (typeof STEP_IDS)[number]));
  return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i < idx ? 'done' : i === idx ? 'active' : 'pending' }));
}
