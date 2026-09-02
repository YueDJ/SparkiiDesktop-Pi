// Kept as a lightweight compatibility shim. The single-page workbench no longer
// renders per-step views; ContractSurface and ContractAgentSurface own the full page.
export interface StepViewProps {
  stepId: string;
  state: Record<string, unknown>;
}

export function StepViews(_props: StepViewProps) {
  return null;
}
