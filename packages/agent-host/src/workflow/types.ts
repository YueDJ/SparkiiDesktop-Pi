import type { ProposalRequest, Proposal } from '@sparkii/approval';
import type { ToolResult } from '@sparkii/connectors';

export interface WorkflowStep {
  id: string;
  type: 'tool' | 'skill' | 'llm' | 'human';
  ref: string;
  inputs?: { from: string | string[] };
  map?: Record<string, string>;
  template?: string;
}
export interface WorkflowDef { version: 1; engine: 'linear'; steps: WorkflowStep[] }
export interface RunContext {
  profileId: string; sessionId: string; actor: string; input: Record<string, unknown>;
  sendPrompt(text: string, task?: string): Promise<string>;
  runTool(toolName: string, args: unknown): Promise<ToolResult>;
  requestApproval(req: ProposalRequest): Promise<Proposal>;
}
export type WorkflowEvent =
  | { type: 'step_started'; stepId: string }
  | { type: 'step_completed'; stepId: string; output: unknown }
  | { type: 'tool_call'; stepId: string; toolName: string }
  | { type: 'approval_required'; stepId: string; proposalId: string }
  | { type: 'workflow_completed'; result: unknown }
  | { type: 'workflow_failed'; stepId: string; error: { code: string; message: string } };
export interface WorkflowRunner { run(def: WorkflowDef, ctx: RunContext): AsyncIterable<WorkflowEvent>; }
