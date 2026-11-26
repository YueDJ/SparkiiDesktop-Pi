import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettings,
  type ProjectRef,
} from './types.js';
import {
  inspectTruthFile,
  inspectTruthFiles,
  inspectTruthFilesTwice,
  readTruthFileVerifiedResult,
  removeTruthPathVerified,
  TruthPathSafetyError,
  type TruthAttributeProbe,
} from './truth-path.js';

export const MEMORY_DIR = 'memory';
export const MEMORY_SETTINGS_FILE = 'memory-settings.json';
export const PROJECT_REGISTRY_FILE = 'projects.json';
export const EXTRACTION_STATE_FILE = 'extraction-state.json';
export const EPISODE_PROPOSALS_DIR = 'episode-proposals';

export interface ProjectRegistry {
  version: 1;
  projects: ProjectRef[];
}

function atomicWrite(path: string, content: string, probeAttributes?: TruthAttributeProbe, onRenamed?: () => void): string {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const [parentInfo, targetBefore] = inspectTruthFiles([
    { path: parent },
    { path, options: { allowMissing: true, regularFile: true } },
  ], probeAttributes);
  if (!parentInfo?.stats.isDirectory()) throw new TruthPathSafetyError(`记忆真相父路径不是普通目录：${parent}`);
  const temp = join(parent, `.${Math.random().toString(36).slice(2)}.tmp`);
  const descriptor = openSync(temp, 'wx');
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    const [tempImmediatelyBefore, targetImmediatelyBefore] = inspectTruthFilesTwice([
      { path: temp, options: { regularFile: true } },
      { path, options: { allowMissing: true, regularFile: true, expectedIdentity: targetBefore?.identity } },
    ], probeAttributes);
    if (!tempImmediatelyBefore?.stats.isFile()) {
      throw new TruthPathSafetyError(`记忆真相临时文件在重命名前发生变化：${temp}`);
    }
    if (targetImmediatelyBefore?.identity !== targetBefore?.identity) {
      throw new TruthPathSafetyError(`记忆真相目标在写入前发生变化：${path}`);
    }
    renameSync(temp, path);
    onRenamed?.();
    const [writtenInfo, tempAfter] = inspectTruthFilesTwice([
      { path, options: { regularFile: true } },
      { path: temp, options: { allowMissing: true } },
    ], probeAttributes);
    if (!writtenInfo?.stats.isFile()
      || writtenInfo.stats.dev !== tempImmediatelyBefore.stats.dev
      || writtenInfo.stats.ino !== tempImmediatelyBefore.stats.ino
      || writtenInfo.stats.mode !== tempImmediatelyBefore.stats.mode
      || writtenInfo.stats.nlink !== tempImmediatelyBefore.stats.nlink
      || writtenInfo.stats.size !== tempImmediatelyBefore.stats.size) {
      throw new TruthPathSafetyError(`记忆真相文件重命名后身份不一致：${path}`);
    }
    // The double-lstat rename fence is also the fresh pre-read boundary; only
    // the independent post-read identity probe remains here.
    const contentRead = readFileSync(path);
    const written = inspectTruthFile(path, probeAttributes, { regularFile: true });
    if (!written || written.identity !== writtenInfo.identity) {
      throw new TruthPathSafetyError(`记忆真相文件在读取后变化：${path}`);
    }
    if (!contentRead.equals(Buffer.from(content, 'utf8'))) {
      throw new TruthPathSafetyError(`记忆真相文件写后内容不一致：${path}`);
    }
    if (tempAfter) {
      throw new TruthPathSafetyError(`记忆真相临时文件重命名后仍然存在：${temp}`);
    }
    return written.identity;
  } catch (error) {
    try { removeTruthPathVerified(temp, { probeAttributes }); } catch { /* preserve unsafe evidence for recovery */ }
    throw error;
  }
}

/** 归一化路径：同一个工作区在不同盘符大小写/斜杠下仍归一个项目。 */
export function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

export function workspacePathKey(path: string): string {
  return normalizeWorkspacePath(path).toLowerCase();
}

export class ProjectIdentityConflictError extends Error {
  constructor(public readonly projectId: string, public readonly workspacePath: string) {
    super(`项目身份冲突：${projectId} 已绑定其他工作区 ${workspacePath}`);
    this.name = 'ProjectIdentityConflictError';
  }
}

export function memoryDir(dataDir: string): string {
  return join(dataDir, MEMORY_DIR);
}

export function memoryDbPath(dataDir: string): string {
  return join(dataDir, 'memory.db');
}

export function userMemoryFile(dataDir: string): string {
  return join(memoryDir(dataDir), 'user.json');
}

export function agentMemoryFile(dataDir: string, agentId: string): string {
  return join(memoryDir(dataDir), 'agents', `${sanitizeSegment(agentId)}.json`);
}

export function episodesFile(dataDir: string): string {
  return join(memoryDir(dataDir), 'episodes.jsonl');
}

export function projectRegistryFile(dataDir: string): string {
  return join(memoryDir(dataDir), PROJECT_REGISTRY_FILE);
}

export function extractionStateFile(dataDir: string): string {
  return join(memoryDir(dataDir), EXTRACTION_STATE_FILE);
}

export function episodeProposalsDir(dataDir: string): string {
  return join(memoryDir(dataDir), EPISODE_PROPOSALS_DIR);
}

export function episodeProposalFile(dataDir: string, sessionId: string): string {
  return join(episodeProposalsDir(dataDir), `${sanitizeSegment(sessionId)}.json`);
}

export function projectMemoryFile(workspacePath: string): string {
  return join(workspacePath, '.sparkii', 'memory.json');
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 宽容读取设置：损坏/字段缺失一律用默认值补齐，不因此拒绝启动。 */
export function loadMemorySettings(dataDir: string): MemorySettings {
  const path = join(memoryDir(dataDir), MEMORY_SETTINGS_FILE);
  try {
    const current = readTruthFileVerifiedResult(path, { allowMissing: true });
    if (!current) return structuredClone(DEFAULT_MEMORY_SETTINGS);
    const parsed = JSON.parse(current.content.toString('utf8')) as Partial<MemorySettings>;
    const d = DEFAULT_MEMORY_SETTINGS;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : d.enabled,
      autoExtract: typeof parsed.autoExtract === 'boolean' ? parsed.autoExtract : d.autoExtract,
      idleConsolidation: typeof parsed.idleConsolidation === 'boolean' ? parsed.idleConsolidation : d.idleConsolidation,
      halfLifeDays: { ...d.halfLifeDays, ...(parsed.halfLifeDays ?? {}) },
      budgets: { ...d.budgets, ...(parsed.budgets ?? {}) },
      extractionDebounceMs: numberOr(parsed.extractionDebounceMs, d.extractionDebounceMs),
      minUserTurns: numberOr(parsed.minUserTurns, d.minUserTurns),
      consolidateIdleMinutes: numberOr(parsed.consolidateIdleMinutes, d.consolidateIdleMinutes),
      consolidateIntervalHours: numberOr(parsed.consolidateIntervalHours, d.consolidateIntervalHours),
    };
  } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    return structuredClone(DEFAULT_MEMORY_SETTINGS);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function saveMemorySettings(dataDir: string, partial: Partial<MemorySettings>): MemorySettings {
  const next = { ...loadMemorySettings(dataDir), ...partial };
  atomicWrite(join(memoryDir(dataDir), MEMORY_SETTINGS_FILE), JSON.stringify(next, null, 2));
  return next;
}

export function parseProjectRegistry(text: string, path: string): ProjectRegistry {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(`项目注册表损坏：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`项目注册表损坏：${path}（根节点不是对象）`);
  }
  const value = parsed as Partial<ProjectRegistry>;
  if (!Array.isArray(value.projects)) throw new Error(`项目注册表损坏：${path}（projects 不是数组）`);
  const projects: ProjectRef[] = [];
  const workspaces = new Set<string>();
  const ids = new Set<string>();
  for (const item of value.projects) {
    if (!item || typeof item !== 'object' || typeof item.projectId !== 'string' || !item.projectId || typeof item.workspacePath !== 'string' || !item.workspacePath) {
      throw new Error(`项目注册表损坏：${path}（项目字段非法）`);
    }
    const workspacePath = normalizeWorkspacePath(item.workspacePath);
    const workspaceKey = workspacePathKey(workspacePath);
    if (workspaces.has(workspaceKey) || ids.has(item.projectId)) {
      throw new Error(`项目注册表损坏：${path}（项目身份重复）`);
    }
    workspaces.add(workspaceKey);
    ids.add(item.projectId);
    projects.push({ ...item, workspacePath });
  }
  return { version: 1, projects };
}

export function readProjectRegistry(dataDir: string): ProjectRegistry {
  const path = join(memoryDir(dataDir), PROJECT_REGISTRY_FILE);
  const current = readTruthFileVerifiedResult(path, { allowMissing: true });
  if (!current) return { version: 1, projects: [] };
  return parseProjectRegistry(current.content.toString('utf8'), path);
}

export function loadProjectRegistry(dataDir: string): ProjectRegistry {
  try { return readProjectRegistry(dataDir); } catch (error) {
    if (error instanceof TruthPathSafetyError) throw error;
    return { version: 1, projects: [] };
  }
}

export function saveProjectRegistry(dataDir: string, registry: ProjectRegistry): void {
  atomicWrite(join(memoryDir(dataDir), PROJECT_REGISTRY_FILE), JSON.stringify(registry, null, 2));
}

export function upsertProjectRefInRegistry(registry: ProjectRegistry, ref: ProjectRef): ProjectRegistry {
  const normalized = normalizeWorkspacePath(ref.workspacePath);
  const key = workspacePathKey(normalized);
  const projects = registry.projects.map((project) => ({ ...project }));
  const existing = projects.find((p) => workspacePathKey(p.workspacePath) === key);
  const sameId = projects.find((p) => p.projectId === ref.projectId);
  if (existing && existing.projectId !== ref.projectId) {
    throw new ProjectIdentityConflictError(ref.projectId, existing.workspacePath);
  }
  if (sameId && workspacePathKey(sameId.workspacePath) !== key) {
    if (existsSync(projectMemoryFile(sameId.workspacePath))) {
      throw new ProjectIdentityConflictError(ref.projectId, sameId.workspacePath);
    }
    projects.splice(projects.indexOf(sameId), 1);
  }
  if (existing) {
    existing.projectId = ref.projectId;
    existing.name = ref.name;
    existing.workspacePath = normalized;
    existing.archived = ref.archived;
  } else {
    projects.push({ ...ref, workspacePath: normalized });
  }
  return { version: 1, projects };
}

export function upsertProjectRef(dataDir: string, ref: ProjectRef): ProjectRegistry {
  const registry = upsertProjectRefInRegistry(readProjectRegistry(dataDir), ref);
  saveProjectRegistry(dataDir, registry);
  return registry;
}

export function removeProjectRef(dataDir: string, workspacePath: string): void {
  const normalized = normalizeWorkspacePath(workspacePath);
  const registry = loadProjectRegistry(dataDir);
  saveProjectRegistry(dataDir, {
    version: 1,
    projects: registry.projects.filter((p) => normalizeWorkspacePath(p.workspacePath) !== normalized),
  });
}

export { atomicWrite };
