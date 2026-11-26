/** 记忆模块的数据契约。文件为真相源，SQLite 只保存派生索引与使用统计。 */

export type MemoryStatus = 'active' | 'pending' | 'superseded';
export type MemoryOp = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP';
export type MemoryScopeKind = 'user' | 'agent' | 'project' | 'episode';

export interface MemorySource {
  sessionId: string;
  excerpt: string;
  kind: 'extracted' | 'explicit' | 'consolidated';
}

export interface PendingOperation {
  op: Exclude<MemoryOp, 'NOOP'> | 'EPISODE_UPDATE';
  targetId?: string;
  proposedText?: string;
  projectId?: string;
  /** 目标已失效后从 UPDATE/SUPERSEDE 降级而来。 */
  degradedFrom?: Exclude<MemoryOp, 'NOOP'>;
  [key: string]: unknown;
}

export function isPendingSchemaKey(key: string): boolean {
  return key === 'op' || key === 'degradedFrom' || key === 'targetId'
    || key === 'projectId' || key === 'mergeIds' || key === 'proposedText'
    || key === 'idempotencyKey';
}

export function isPendingStructuralFieldValid(key: string, value: unknown): boolean {
  if (key === 'op') return value === 'ADD' || value === 'UPDATE' || value === 'SUPERSEDE'
    || value === 'NOOP' || value === 'EPISODE_UPDATE';
  if (key === 'degradedFrom') return value === 'ADD' || value === 'UPDATE'
    || value === 'SUPERSEDE' || value === 'NOOP';
  if (key === 'targetId' || key === 'projectId') {
    return typeof value === 'string' && value.trim().length > 0;
  }
  if (key === 'mergeIds') {
    return Array.isArray(value) && value.every((id) => typeof id === 'string' && id.trim().length > 0);
  }
  return false;
}

/** 真相源中的一张记忆卡。使用统计（lastAccessedAt/accessCount）只在 db。 */
export interface MemoryEntry {
  id: string;
  text: string;
  status: MemoryStatus;
  pinned: boolean;
  importance: number;
  createdAt: number;
  updatedAt: number;
  source: MemorySource | null;
  supersededBy: string | null;
  pendingOp: PendingOperation | null;
}

export interface MemoryFileV1 {
  version: 1;
  entries: MemoryEntry[];
}

export interface ProjectMemoryFileV1 extends MemoryFileV1 {
  projectId: string;
  archived?: boolean;
}

export interface EpisodeRecord {
  sessionId: string;
  agentId: string;
  workspacePath: string;
  projectId?: string;
  ts: number;
  summary: string;
  topics: string[];
}

export interface MemoryUsage {
  lastAccessedAt: number | null;
  accessCount: number;
}

export interface MemoryEntryView extends MemoryEntry {
  scope: string;
  usage: MemoryUsage;
  /** 来源会话已被删除（隐私清理）时为真。 */
  sourceDeleted: boolean;
  projectId?: string;
  workspacePath?: string;
}

export interface ScopeView {
  scope: string;
  kind: MemoryScopeKind;
  label: string;
  agentId?: string;
  projectId?: string;
  workspacePath?: string;
  archived?: boolean;
  corrupt?: boolean;
  /** 置顶记忆超出注入预算时的用户可见警示。 */
  warning?: string;
  entries: MemoryEntryView[];
}

export interface MemorySettings {
  enabled: boolean;
  autoExtract: boolean;
  idleConsolidation: boolean;
  halfLifeDays: Record<'user' | 'agent' | 'project' | 'episode', number>;
  budgets: Record<'user' | 'agent' | 'project', number>;
  extractionDebounceMs: number;
  minUserTurns: number;
  consolidateIdleMinutes: number;
  consolidateIntervalHours: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  autoExtract: true,
  idleConsolidation: true,
  halfLifeDays: { user: 180, agent: 90, project: 60, episode: 14 },
  budgets: { user: 500, agent: 300, project: 800 },
  extractionDebounceMs: 90_000,
  minUserTurns: 3,
  consolidateIdleMinutes: 10,
  consolidateIntervalHours: 24,
};

export interface ProjectRef {
  projectId: string;
  workspacePath: string;
  name?: string;
  archived?: boolean;
}

export interface MemoryListResult {
  scopes: ScopeView[];
  pending: MemoryEntryView[];
  agents: Array<{ id: string; name: string }>;
  projects: ProjectRef[];
  settings: MemorySettings;
  ftsAvailable: boolean;
  warnings: string[];
}

export interface MemorySearchHit {
  id: string;
  scope: string;
  text: string;
  kind: 'memory' | 'episode';
  status?: MemoryStatus;
  score: number;
  projectId?: string;
  workspacePath?: string;
  sessionId?: string;
  summary?: string;
}

export const PLACEHOLDER_SOURCE = '来源已删除';

export function scopeKindOf(scope: string): MemoryScopeKind {
  if (scope === 'user') return 'user';
  if (scope.startsWith('agent:')) return 'agent';
  if (scope.startsWith('project:')) return 'project';
  return 'episode';
}

export function idOfProjectScope(scope: string): string {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : '';
}

export function idOfAgentScope(scope: string): string {
  return scope.startsWith('agent:') ? scope.slice('agent:'.length) : '';
}

export function newMemoryId(): string {
  return `mem_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/** 归一化哈希：驳回黑名单用，去掉空白与常见标点。 */
export function normalizeTextHash(text: string): string {
  const normalized = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `n${(hash >>> 0).toString(36)}`;
}
