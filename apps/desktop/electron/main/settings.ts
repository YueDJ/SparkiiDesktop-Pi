import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';
import type { CustomProvider } from './provider-catalog.js';

export interface AppSettings {
  activeProviderId?: string;
  providers?: CustomProvider[];
  defaultModel?: string;
  routes?: Record<string, string>;
  defaultThinkingLevel?: string;
  modelThinkingLevels?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
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
