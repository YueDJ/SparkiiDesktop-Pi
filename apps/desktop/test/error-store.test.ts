import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ErrorStore } from '../electron/main/error-store.js';

function store(now?: () => number) {
  return new ErrorStore(join(mkdtempSync(join(tmpdir(), 'errors-')), 'errors.db'), now ? { now } : undefined);
}

describe('ErrorStore', () => {
  it('appends, lists newest-first, and keeps read state', () => {
    const s = store();
    const now = Date.now();
    s.append({ id: 'e1', message: 'a', source: '通用智能体', createdAt: now - 1 });
    s.append({ id: 'e2', message: 'b', source: '运行中心', createdAt: now });
    expect(s.list().map((r) => r.id)).toEqual(['e2', 'e1']);
    expect(s.list()[0]).toMatchObject({ id: 'e2', read: false });
    s.markAllRead();
    expect(s.list().every((r) => r.read)).toBe(true);
    s.close();
  });

  it('clears one or all', () => {
    const s = store();
    const now = Date.now();
    s.append({ id: 'e1', message: 'a', source: 'x', createdAt: now - 1 });
    s.append({ id: 'e2', message: 'b', source: 'x', createdAt: now });
    s.clearOne('e1');
    expect(s.list().map((r) => r.id)).toEqual(['e2']);
    s.clear();
    expect(s.list()).toEqual([]);
    s.close();
  });

  it('prunes records older than 30 days on append and list', () => {
    const now = 1_000_000;
    const s = store(() => now);
    s.append({ id: 'old', message: 'old', source: 'x', createdAt: now - 31 * 24 * 3600 * 1000 });
    s.append({ id: 'new', message: 'new', source: 'x', createdAt: now });
    expect(s.list().map((r) => r.id)).toEqual(['new']);
    s.close();
  });
});
