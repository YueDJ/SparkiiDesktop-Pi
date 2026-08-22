import { join } from 'node:path';
import { app } from 'electron';

export function dataDirFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(app.getPath('userData'), 'data', safe);
}
