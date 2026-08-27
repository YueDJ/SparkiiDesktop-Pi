export interface WorkflowStep { id: string; label: string; state: 'idle' | 'active' | 'done' | 'failed'; }
export function WorkflowSteps({ steps }: { steps: WorkflowStep[] }) {
  return <div className="ui-workflow-steps">{steps.map((s) => <span key={s.id} className={`ui-workflow-step ui-workflow-step--${s.state}`} data-state={s.state}>{s.label}</span>)}</div>;
}
