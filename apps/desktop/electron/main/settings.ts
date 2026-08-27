import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';
import type { CustomProvider } from './provider-catalog.js';

export interface AppSettings {
  activeProviderId?: string;
  providers?: CustomProvider[];
  defaultModel?: string;
  routes?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
}

export type { CustomProvider } from './provider-catalog.js';

const LEGACY_API_KEY_NAME = 'apiKey';
const apiKeyName = (providerId: string): string => `apiKey:${providerId}`;

export async function loadSettings(
  dataDir: string,
  keyring?: Keyring,
): Promise<AppSettings & { apiKey?: string }> {
  let base: AppSettings = {};
  try {
    base = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as AppSettings;
  } catch {
    // 首次运行无文件
  }
  const apiKey = keyring ? await keyring.get(LEGACY_API_KEY_NAME) : undefined;
  return { ...base, ...(apiKey ? { apiKey } : {}) };
}

export async function saveSettings(
  dataDir: string,
  settings: AppSettings & { apiKey?: string },
  keyring?: Keyring,
): Promise<void> {
  const { apiKey, ...rest } = settings;
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(rest, null, 2), 'utf8');
  if (keyring) {
    await keyring.set(LEGACY_API_KEY_NAME, apiKey ?? '');
  }
}

export async function loadApiKey(keyring: Keyring, providerId: string): Promise<string | null> {
  return keyring.get(apiKeyName(providerId));
}

export async function saveApiKey(keyring: Keyring, providerId: string, key: string): Promise<void> {
  await keyring.set(apiKeyName(providerId), key);
}
