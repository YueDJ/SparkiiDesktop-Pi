export interface WorkflowStep { id: string; label: string; state: 'idle' | 'active' | 'done' | 'failed'; }
export function WorkflowSteps({ steps, onStepClick }: { steps: WorkflowStep[]; onStepClick?: (id: string) => void }) {
  return (
    <div className="ui-workflow-steps" data-testid="workflow-steps">
      {steps.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`ui-workflow-step ui-workflow-step--${s.state}`}
          data-state={s.state}
          onClick={() => onStepClick?.(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
