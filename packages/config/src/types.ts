export interface ProfileManifest {
  name: string;
  version: string;
  extends?: string;
  modelRouting: {
    tasks: Record<string, Array<{ provider: string; modelId: string }>>;
  };
  integrity?: { sha256: string };
}

export interface SkillRef { name: string; file: string; params?: Record<string, unknown>; }
export type PageSchema = Record<string, unknown>;
export interface ThemeRef { file: string; }

export interface RoleConfig { name: string; pages: string[]; tools: string[]; canApprove: Array<'write' | 'high-risk'>; }
export interface ApprovalPolicy {
  autoApprove?: string[];
  requireApproval: string[];
  timeoutMs: number;
  highRiskDoubleConfirm: boolean;
}

export interface AgentConfig {
  skills: SkillRef[];
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
