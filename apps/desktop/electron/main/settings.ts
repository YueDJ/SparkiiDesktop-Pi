import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';
import { normalizeCustomProvider, type CustomProvider } from './provider-catalog.js';
import type { LogLevel } from './logger.js';
import { SHELL_REVIEWER_POLICY_VERSION } from './security/reviewer-policy.js';

export interface AppSettings {
  activeProviderId?: string;
  providers?: CustomProvider[];
  defaultModel?: string;
  routes?: Record<string, string>;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  maxAgents?: number;
  queueEnabled?: boolean;
  chatDetailLevel?: 'minimal' | 'standard' | 'debug';
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
  logLevel?: LogLevel;
  rag?: {
    baseUrl?: string;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
  };
  sparkiionto?: {
    baseUrl?: string;
    similarityThreshold?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
  };
  documentParse?: {
    idleMinutes?: number;
    keepResident?: boolean;
  };
  /**
   * 自动更新设置（§7.4）。独立于 rag.baseUrl：更新源是静态文件目录，不复用 RAG 业务地址。
   * autoDownload 恒为 false（写死，不提供开启入口）；其单测覆盖在 G3。
   * loadSettings / saveSettings 的 merge 语义保持不变，normalize 只处理 providers，
   * 不得丢弃本字段。
   */
  update?: {
    baseUrl?: string;
    autoCheck?: boolean;
    checkIntervalHours?: number;
    checkOnStartup?: boolean;
    startupDelaySeconds?: number;
    checkOnNetworkResume?: boolean;
    checkOnSystemResume?: boolean;
    remindIntervalHours?: number;
    requestTimeoutMs?: number;
    autoDownload?: false;
  };
  /**
   * Only the operational knobs of the platform reviewer live here. The system
   * prompt, the policy version and the output schema stay in reviewer-policy.ts.
   */
  permissionModes?: {
    reviewer?: {
      provider?: string;
      modelId?: string;
      timeoutMs?: number;
      idleMs?: number;
    };
  };
}

export interface ReviewerConfig {
  provider: string;
  modelId: string;
  timeoutMs: number;
  idleMs: number;
  policyVersion: string;
}

export const REVIEWER_DEFAULT_TIMEOUT_MS = 15_000;
export const REVIEWER_DEFAULT_IDLE_MS = 5 * 60_000;

/**
 * Resolves where the reviewer runs. A non-positive timeout or idle window is a
 * configuration mistake, so it falls back to the platform default instead of
 * producing an unbounded or permanently hot worker.
 */
export function resolveReviewerConfig(settings: AppSettings): ReviewerConfig {
  const reviewer = settings.permissionModes?.reviewer;
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
  return {
    provider: reviewer?.provider || settings.activeProviderId || 'deepseek',
    modelId: reviewer?.modelId || settings.defaultModel || 'deepseek-v4-flash',
    timeoutMs: positive(reviewer?.timeoutMs, REVIEWER_DEFAULT_TIMEOUT_MS),
    idleMs: positive(reviewer?.idleMs, REVIEWER_DEFAULT_IDLE_MS),
    policyVersion: SHELL_REVIEWER_POLICY_VERSION,
  };
}

export type { CustomProvider } from './provider-catalog.js';

const apiKeyName = (providerId: string): string => `apiKey:${providerId}`;

export async function loadSettings(dataDir: string): Promise<AppSettings> {
  try {
    const settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as AppSettings;
    return settings.providers
      ? { ...settings, providers: settings.providers.map(normalizeCustomProvider) }
      : settings;
  } catch {
    return {};
  }
}

export async function saveSettings(
  dataDir: string,
  settings: AppSettings,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const normalized = settings.providers
    ? { ...settings, providers: settings.providers.map(normalizeCustomProvider) }
    : settings;
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(normalized, null, 2), 'utf8');
}

export async function loadApiKey(keyring: Keyring, providerId: string): Promise<string | null> {
  return keyring.get(apiKeyName(providerId));
}

export async function saveApiKey(keyring: Keyring, providerId: string, key: string): Promise<void> {
  await keyring.set(apiKeyName(providerId), key);
}
