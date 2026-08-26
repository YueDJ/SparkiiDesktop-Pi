import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';

export interface AppSettings {
  provider?: string;
  baseUrl?: string;
  defaultModel?: string;
  routes?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
}

const API_KEY_NAME = 'apiKey';

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
  const apiKey = keyring ? await keyring.get(API_KEY_NAME) : undefined;
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
    await keyring.set(API_KEY_NAME, apiKey ?? '');
  }
}
