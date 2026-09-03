import type { ComponentType } from 'react';
import type { ChatEntry } from '@sparkii/ui';

export interface AgentDescriptor {
  id: string;
  name: string;
  surfaceType: string;
}

export interface WorkflowStepEntry {
  kind: 'workflow_step';
  id: string;
  stepId: string;
  state: 'start' | 'end';
  status?: string;
  timestamp?: number;
}

export interface WorkflowStateEntry {
  kind: 'workflow_state';
  id: string;
  stepId: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

/** Unified session timeline entry: the platform chat entry types plus the workflow lifecycle entries. */
export type SessionEntry = ChatEntry | WorkflowStepEntry | WorkflowStateEntry;

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
    /** 会话输入文件（由平台从 workspace/DB 暴露），供自定义 surface 作为输入/原文使用。 */
    inputs?: { path: string; name?: string; missing?: boolean }[];
  };
}

export interface AgentSurfaceActions {
  newSession(): void;
  openSession(id: string, title?: string): void;
  startWorkflow(payload: Record<string, unknown>): void;
  review(action: string, payload: Record<string, unknown>): void;
  requestExport(): void;
  /** 平台文件对话框；返回用户选择的文件路径（取消时无 path）。 */
  chooseDocument(): Promise<{ path?: string }>;
}

export interface AgentSurfaceProps {
  agent: AgentDescriptor;
  sessionId: string | null;
  mode: 'live' | 'history';
  session: AgentSession;
  actions: AgentSurfaceActions;
  title?: string;
}

export type AgentSurfaceComponent = ComponentType<AgentSurfaceProps>;
