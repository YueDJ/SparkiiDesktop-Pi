import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MEMORY_SETTINGS,
  type MemorySettings,
  type ProjectRef,
} from './types.js';

export const MEMORY_DIR = 'memory';
export const MEMORY_SETTINGS_FILE = 'memory-settings.json';
export const PROJECT_REGISTRY_FILE = 'projects.json';

export interface ProjectRegistry {
  version: 1;
  projects: ProjectRef[];
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(temp, content, 'utf8');
  renameSync(temp, path);
}

/** 归一化路径：同一个工作区在不同盘符大小写/斜杠下仍归一个项目。 */
export function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
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

export function projectMemoryFile(workspacePath: string): string {
  return join(workspacePath, '.sparkii', 'memory.json');
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 宽容读取设置：损坏/字段缺失一律用默认值补齐，不因此拒绝启动。 */
export function loadMemorySettings(dataDir: string): MemorySettings {
  const path = join(memoryDir(dataDir), MEMORY_SETTINGS_FILE);
  if (!existsSync(path)) return structuredClone(DEFAULT_MEMORY_SETTINGS);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemorySettings>;
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
  } catch {
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

export function loadProjectRegistry(dataDir: string): ProjectRegistry {
  const path = join(memoryDir(dataDir), PROJECT_REGISTRY_FILE);
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectRegistry>;
    if (!Array.isArray(parsed.projects)) return { version: 1, projects: [] };
    return {
      version: 1,
      projects: parsed.projects
        .filter((p): p is ProjectRef => Boolean(p && typeof p.projectId === 'string' && typeof p.workspacePath === 'string'))
        .map((p) => ({ ...p, workspacePath: normalizeWorkspacePath(p.workspacePath) })),
    };
  } catch {
    return { version: 1, projects: [] };
  }
}

export function saveProjectRegistry(dataDir: string, registry: ProjectRegistry): void {
  atomicWrite(join(memoryDir(dataDir), PROJECT_REGISTRY_FILE), JSON.stringify(registry, null, 2));
}

export function upsertProjectRef(dataDir: string, ref: ProjectRef): ProjectRegistry {
  const registry = loadProjectRegistry(dataDir);
  const normalized = normalizeWorkspacePath(ref.workspacePath);
  const existing = registry.projects.find((p) => normalizeWorkspacePath(p.workspacePath) === normalized);
  if (existing) {
    existing.projectId = ref.projectId;
    existing.name = ref.name;
  } else {
    registry.projects.push({ ...ref, workspacePath: normalized });
  }
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
