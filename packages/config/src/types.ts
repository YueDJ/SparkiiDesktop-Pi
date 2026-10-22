import type { SkillPackage } from './skills.js';

export interface ProfileManifest {
  name: string;
  version: string;
  displayName?: string;
  sortOrder?: number;
  extends?: string;
  surface?: {
    type: 'chat' | 'workflow' | 'dashboard' | 'custom';
    entry?: string;
  };
  capabilities?: {
    entry?: string;
    tools?: string[];
  };
  modelRequirements?: {
    requires: string[];
    prefers?: string[];
  };
  modelRouting: {
    tasks: Record<string, Array<{ provider: string; modelId: string }>>;
  };
  integrity?: { sha256: string };
  skillLibrary?: 'package' | 'user';
  knowledge?: {
    enabled: boolean;
    picker: 'hidden' | 'session';
    backend: 'bm25' | 'sparkiirag';
  };
}

export type PageSchema = Record<string, unknown>;
export interface ThemeRef { file: string; }

export interface RoleConfig { name: string; pages: string[]; tools: string[]; canApprove: Array<'write' | 'high-risk'>; }
/** The two platform permission modes; duplicated here because config cannot import approval. */
export type PermissionModeId = 'ask' | 'auto_review';
export interface ApprovalPolicy {
  autoApprove?: string[];
  requireApproval: string[];
  timeoutMs: number;
  highRiskDoubleConfirm: boolean;
  defaultPermissionMode?: PermissionModeId;
  allowedPermissionModes?: PermissionModeId[];
  /** Legacy hint only. `strict` restricts the profile to Ask. */
  mode?: 'standard' | 'strict';
}

export interface AgentConfig {
  skills: SkillPackage[];
  tools: string[];
  prompts: Record<string, string>;
  workflow: Record<string, unknown>;
  knowledge: Array<{ id: string; text: string }>;
}
export interface UiConfig { pages: Record<string, PageSchema>; theme: ThemeRef; }
export interface SecurityConfig { roles: RoleConfig[]; approval: ApprovalPolicy; }
export interface ResolvedProfile {
  manifest: ProfileManifest;
  agent: AgentConfig;
  ui: UiConfig;
  security: SecurityConfig;
}
