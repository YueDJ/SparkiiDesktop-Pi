export type CapabilityKind =
  | 'fs.read'
  | 'fs.write'
  | 'process.exec'
  | 'net.connect'
  | 'connector.invoke'
  | 'task.delegate';

export type PolicyDecision = 'allow' | 'ask' | 'deny';
export type RunMode = 'plan' | 'standard' | 'strict';
/** The only permission modes the platform offers. There is no full-access mode. */
export type PlatformPermissionMode = 'ask' | 'auto_review';
export type ReviewerDecision =
  | { decision: 'allow'; risk: 'low' | 'medium'; reason: string }
  | { decision: 'ask'; risk: 'high'; reason: string }
  | { decision: 'deny'; risk: 'critical'; reason: string };
export type ResourceKind = 'path' | 'domain' | 'connector' | 'process' | 'task';
export type ResourceScope = 'workspace' | 'input' | 'scratch' | 'external' | 'critical';
export type SecurityRisk = 'read' | 'write' | 'high-risk';

export interface ResourceRef {
  kind: ResourceKind;
  value: string;
  identity?: string;
  parentIdentity?: string;
  scope: ResourceScope;
  /** Main-derived flag; Runtime payloads cannot set this. */
  trustAnchor?: boolean;
}

/** The authoritative action produced by Main, never by Runtime. */
export interface SecurityAction {
  id: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  toolName: string;
  capability: CapabilityKind;
  resources: ResourceRef[];
  payload: unknown;
  payloadHash: string;
  risk: SecurityRisk;
  reason: string;
  externalEffect?: string;
}

export interface TaskGrant {
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  mode: RunMode;
  workspaceRoot: string;
  workspaceIdentity: string;
  inputRoots: Array<{ path: string; identity: string }>;
  scratchRoot: string;
  networkDomains: string[];
  externalCapabilities: string[];
  createdAt: number;
  expiresAt: number;
}

export interface PlatformProfilePolicy {
  mode?: RunMode;
  requireApproval?: string[];
  autoApprove?: string[];
  timeoutMs?: number;
  highRiskDoubleConfirm?: boolean;
}

export interface PolicyInput {
  action: SecurityAction;
  grant: TaskGrant;
  profilePolicy: PlatformProfilePolicy;
  platformReady: boolean;
  now?: number;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  ruleId: string;
  reason: string;
  autoApproved?: boolean;
}

export interface WorkspacePathInfo {
  displayPath: string;
  canonicalPath: string;
  identity: string;
  nearestExistingAncestor: string;
  isDirectory: boolean;
  isReparsePoint: boolean;
  /** False only when the requested target itself does not exist yet. */
  exists?: boolean;
}

export interface WorkspacePathProbe {
  inspect(target: string): Promise<WorkspacePathInfo>;
  isSameOrDescendant(root: string, target: string): Promise<boolean>;
  isSameObject(left: string, right: string): Promise<boolean>;
}

export interface ProtectedRoot {
  path: string;
  policy: 'boundary' | 'closure';
}

export interface WorkspaceAdmissionResult {
  ok: boolean;
  canonicalPath?: string;
  identity?: string;
  nearestExistingAncestor?: string;
  ruleId?: string;
  reason?: string;
}
