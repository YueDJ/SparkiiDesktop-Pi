import { readFileSync } from "node:fs";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

export interface PiSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

export async function listPiSessions(sessionDir: string): Promise<PiSessionSummary[]> {
  const sessions: SessionInfo[] = await SessionManager.listAll(sessionDir);
  return sessions.map((session) => ({
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    firstMessage: session.firstMessage,
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
  }));
}

export function readPiSessionMessages(filePath: string): Array<{ role: string; content: unknown }> {
  const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
  return entries
    .filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
    .map((entry) => entry.message as { role: string; content: unknown });
}

export function readPiSessionEntries(filePath: string): SessionEntry[] {
  const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
  return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

export interface WorkflowStepMarker {
  stepId: string;
  attempt?: number;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowStateEvent {
  stepId?: string;
  action: string;
  [key: string]: unknown;
}

export interface WorkflowTimeline {
  steps: WorkflowStepMarker[];
  stateEvents: WorkflowStateEvent[];
}

export function parseWorkflowTimeline(entries: Array<Record<string, unknown>>): WorkflowTimeline {
  const steps: WorkflowStepMarker[] = [];
  const stateEvents: WorkflowStateEvent[] = [];
  for (const entry of entries) {
    if (entry.type === 'workflow_step_start' || entry.type === 'workflow_step_end') {
      steps.push({
        stepId: String(entry.stepId ?? ''),
        attempt: typeof entry.attempt === 'number' ? entry.attempt : undefined,
        status: typeof entry.status === 'string' ? entry.status : undefined,
        startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : undefined,
        finishedAt: typeof entry.finishedAt === 'string' ? entry.finishedAt : undefined,
      });
    }
    if (entry.type === 'workflow_state') {
      const { type: _type, ...rest } = entry as Record<string, unknown>;
      stateEvents.push({ action: String(rest.action ?? ''), ...rest } as WorkflowStateEvent);
    }
  }
  return { steps, stateEvents };
}
