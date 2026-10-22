import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';
import type { CustomProvider } from './provider-catalog.js';
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
    return JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as AppSettings;
  } catch {
    return {};
  }
}

export async function saveSettings(
  dataDir: string,
  settings: AppSettings,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

export async function loadApiKey(keyring: Keyring, providerId: string): Promise<string | null> {
  return keyring.get(apiKeyName(providerId));
}

export async function saveApiKey(keyring: Keyring, providerId: string, key: string): Promise<void> {
  await keyring.set(apiKeyName(providerId), key);
}
