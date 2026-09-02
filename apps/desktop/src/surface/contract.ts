import type { ComponentType } from 'react';

export interface AgentDescriptor {
  id: string;
  name: string;
  surfaceType: string;
}

export type SessionEntry =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'assistant';
      text: string;
      thinking?: string;
      streaming: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      input: unknown;
      result?: unknown;
      awaitingApproval?: boolean;
      toolCallId?: string;
    }
  | {
      kind: 'event';
      id: string;
      event: string;
      label: string;
      detail?: string;
      status?: string;
      timestamp?: number;
      payload?: unknown;
    }
  | {
      kind: 'workflow_step';
      id: string;
      stepId: string;
      state: 'start' | 'end';
      status?: string;
      timestamp?: number;
    }
  | {
      kind: 'workflow_state';
      id: string;
      stepId: string;
      action: string;
      payload: Record<string, unknown>;
      timestamp?: number;
    };

export interface AgentSession {
  entries: SessionEntry[];
  streaming: boolean;
  status?: 'idle' | 'running' | 'done' | 'failed';
  result?: Record<string, unknown>;
  meta: {
    model?: string | null;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    workspacePath?: string | null;
    currentStep?: string | null;
  };
}

export interface AgentSurfaceActions {
  newSession(): void;
  openSession(id: string): void;
  startWorkflow(payload: Record<string, unknown>): void;
  review(action: string, payload: Record<string, unknown>): void;
  requestExport(): void;
}

export interface AgentSurfaceProps {
  agent: AgentDescriptor;
  sessionId: string | null;
  mode: 'live' | 'history';
  session: AgentSession;
  actions: AgentSurfaceActions;
}

export type AgentSurfaceComponent = ComponentType<AgentSurfaceProps>;
