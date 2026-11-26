import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';

const fault = vi.hoisted(() => ({ failDisk: false, failDiskCount: false }));

vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-sqlite3')>();
  const Database = actual.default;
  return {
    default: class FaultDatabase extends Database {
      private readonly memoryIndex: boolean;
      constructor(...args: any[]) {
        const path = String(args[0]);
        if (path.endsWith('memory.db') && (fault.failDisk || fault.failDiskCount)) {
          if (fault.failDisk) throw new Error('injected memory index disk failure');
        }
        super(...args);
        this.memoryIndex = path === ':memory:';
      }
      override prepare(sql: string) {
        if (!this.memoryIndex && fault.failDiskCount && sql.includes('count(*)')) {
          throw new Error('injected memory index count failure');
        }
        return super.prepare(sql);
      }
    },
  };
});

let root: string;
let dataDir: string;
let errors: ErrorStore;
let service: MemoryService | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-index-fallback-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  fault.failDisk = false;
  fault.failDiskCount = false;
});

afterEach(() => {
  service?.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

describe('memory index fallback', () => {
  it.each(['disk open', 'disk query'] as const)('keeps truth writes and reads working after %s failure', (failure) => {
    fault.failDisk = failure === 'disk open';
    fault.failDiskCount = failure === 'disk query';
    service = new MemoryService({ dataDir, errors });

    const added = service.addMemory({ scope: 'user', text: '内存索引下的真相源记忆' });

    expect(service.list().warnings.join('\n')).toContain('内存索引');
    expect(service.searchMemory('真相源').map((entry) => entry.id)).toContain(added.id);
    expect(service.buildBlock({ profileId: 'general' })).toContain('内存索引下的真相源记忆');
    service.close();
    service = undefined;

    fault.failDisk = false;
    fault.failDiskCount = false;
    service = new MemoryService({ dataDir, errors });
    expect(service.searchMemory('真相源').map((entry) => entry.id)).toContain(added.id);
  });
});
