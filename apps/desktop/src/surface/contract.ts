import type { ComponentType } from 'react';
import type { ChatEntry } from '@sparkii/ui';

export interface AgentDescriptor {
  id: string;
  name: string;
  surfaceType: string;
}

export interface CustomSessionEntry {
  kind: 'custom';
  id: string;
  customType: string;
  data: Record<string, unknown>;
  timestamp?: number;
}

/** Unified session timeline entry: the platform chat entry types plus Pi custom JSONL rows. */
export type SessionEntry = ChatEntry | CustomSessionEntry;

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
  startWorkflow(payload: Record<string, unknown>): void | Promise<{ sessionId?: string }>;
  review(action: string, payload: Record<string, unknown>): void;
  requestExport(payload?: Record<string, unknown>): void;
  /** 平台文件对话框；返回用户选择的文件路径（取消时无 path）。 */
  chooseDocument(opts?: { extensions?: string[] }): Promise<{ path?: string }>;
  /** 读取用户已选/会话输入/工作区内的文档字节，供 Agent 预览。 */
  readDocumentBytes(path: string): Promise<
    | { kind: 'pdf' | 'docx' | 'txt'; fileName: string; fileSize: number; bytes: ArrayBuffer }
    | { error: 'missing' | 'unsupported' | 'too_large' | 'denied' }
  >;
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
