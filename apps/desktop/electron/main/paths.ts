import { dirname, join } from 'node:path';
import { app } from 'electron';

export const DATA_APP_DIR = 'SparkiiDesktop';

export function dataDirFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(defaultDataDir(), safe);
}

export function defaultDataDir(): string {
  const base = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, DATA_APP_DIR)
    : join(dirname(app.getPath('userData')), DATA_APP_DIR);
  return join(base, 'data');
}
