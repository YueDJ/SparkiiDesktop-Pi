import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../electron/main/logger.js';

describe('Logger', () => {
  it('appends structured jsonl and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'info', msg: 'start', ctx: { profile: 'contract-review' } });
    const exported = await l.export();
    expect(JSON.parse(exported.trim().split('\n')[0]).msg).toBe('start');
  });

  it('drops entries below the configured level', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    l.level = 'warn';
    await l.log({ level: 'info', msg: 'should-drop' });
    await l.log({ level: 'warn', msg: 'kept' });
    const exported = await l.export();
    expect(exported).not.toContain('should-drop');
    expect(exported).toContain('kept');
  });

  it('echoes to console with level mapping', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'warn', msg: 'careful' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
