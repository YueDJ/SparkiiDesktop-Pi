import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Logger } from '../electron/main/logger.js';

describe('Logger', () => {
  it('appends structured jsonl and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'info', msg: 'start', ctx: { profile: 'contract-review' } });
    const exported = await l.export();
    expect(JSON.parse(exported.trim().split('\n')[0]).msg).toBe('start');
  });
});
