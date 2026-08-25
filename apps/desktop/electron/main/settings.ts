import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppSettings {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  routes?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
}

export async function loadSettings(dataDir: string): Promise<AppSettings> {
  try {
    const raw = await readFile(join(dataDir, 'settings.json'), 'utf8');
    return JSON.parse(raw) as AppSettings;
  } catch {
    return {};
  }
}

export async function saveSettings(dataDir: string, settings: AppSettings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}
