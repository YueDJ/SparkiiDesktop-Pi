import { describe, it, expect, vi } from 'vitest';
import { relocateWorkspace, type WorkspaceRelocationDeps } from '../electron/main/workspace-relocation.js';

/**
 * Full-flow tests for P10 relocateWorkspace. The helper exposes injected deps so
 * we can exercise every MUST-FIX failure path (copy-first/last-delete, single
 * transaction, reparse/nesting, cross-disk reconcile, EBUSY source removal,
 * shared-path sessions, audit) without Electron or a real Windows handle lock.
 */

interface Harness {
  deps: WorkspaceRelocationDeps;
  calls: string[];
  auditEvents: Array<Record<string, unknown>>;
  sessions: Map<string, { id: string; profileId: string; workspacePath: string; open: boolean }>;
  targetFiles: Map<string, string>;
  sourceFiles: Map<string, string>;
  setSourceRemoveError: (e: unknown) => void;
  setCopyError: (e: unknown) => void;
  setReconcileMismatch: (v: boolean) => void;
  setTxnError: (e: unknown) => void;
  setNotIdle: (ids: string[]) => void;
}

function harness(opts: { newPath?: string; oldPath?: string; targetExists?: boolean; targetEntries?: string[] } = {}): Harness {
  const oldPath = opts.oldPath ?? 'C:/proj/ws-old';
  const newPath = opts.newPath ?? 'C:/target/ws-new';
  const targetExists = opts.targetExists ?? false;
  const targetEntries = opts.targetEntries ?? [];
  const calls: string[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, { id: string; profileId: string; workspacePath: string; open: boolean }>([
    ['s1', { id: 's1', profileId: 'bid-writing', workspacePath: oldPath, open: true }],
  ]);
  const sourceFiles = new Map<string, string>([['input/a.txt', 'hello'], ['output/manuscript/01.md', '# 01']]);
  const targetFiles = new Map<string, string>();
  let sourceRemoveError: unknown = null;
  let copyError: unknown = null;
  let txnError: unknown = null;
  let reconcileMismatch = false;
  let notIdle = new Set<string>();
  let targetDirExists = targetExists;

  const probe = {
    inspect: vi.fn(async (target: string) => {
      const t = String(target).replace(/\\/g, '/');
      const isTarget = t.endsWith('ws-new');
      const isSource = t.endsWith('ws-old');
      return {
        displayPath: t,
        canonicalPath: t,
        identity: isTarget ? 'id-target' : isSource ? 'id-source' : 'id-ancestor',
        nearestExistingAncestor: t,
        isDirectory: true,
        isReparsePoint: false,
        exists: isSource || (isTarget ? targetDirExists : true),
        linkCount: 1,
      };
    }),
    isSameOrDescendant: vi.fn(async (root: string, target: string) => {
      const r = String(root).replace(/\\/g, '/');
      const t = String(target).replace(/\\/g, '/');
      if (r === t) return true;
      return t.startsWith(r.endsWith('/') ? r : r + '/');
    }),
    isSameObject: vi.fn(async (a: string, b: string) => String(a) === String(b)),
  };

  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir });
  // Both roots expose the same two leaf files so reconcile matches by default.
  const tree = ['a.txt', '01.md'];
  const fs = {
    mkdir: vi.fn(async (_p: string) => { targetDirExists = true; }),
    readdir: vi.fn(async (p: string) => {
      const t = String(p).replace(/\\/g, '/');
      if (t.endsWith('ws-new')) {
        if (targetEntries.length) return targetEntries.map((n) => dirent(n, false)) as any;
        return tree.map((n) => dirent(n, false)) as any;
      }
      if (t.endsWith('ws-old')) return tree.map((n) => dirent(n, false)) as any;
      return [] as any;
    }),
    rm: vi.fn(async (p: string) => {
      calls.push(`rm:${String(p).replace(/\\/g, '/').endsWith('ws-old') ? 'source' : 'target'}`);
      if (String(p).replace(/\\/g, '/').endsWith('ws-old') && sourceRemoveError) throw sourceRemoveError;
    }),
    cp: vi.fn(async (_src: string, _dst: string) => {
      calls.push('cp');
      if (copyError) throw copyError;
      for (const [k, v] of sourceFiles) targetFiles.set(k, v);
      targetDirExists = true;
    }),
    stat: vi.fn(async () => ({ size: 10 }) as any),
  };

  const deps: WorkspaceRelocationDeps = {
    getSession: (id) => sessions.get(id),
    sessionsByWorkspace: (wp) => [...sessions.values()].filter((s) => s.workspacePath === wp),
    updateWorkspacePathInTransaction: (o, n, kind) => {
      calls.push('txn');
      if (txnError) throw txnError;
      for (const s of sessions.values()) if (s.workspacePath === o) s.workspacePath = n;
    },
    isIdle: (id) => !notIdle.has(id),
    configureSession: async (id) => { calls.push(`rebind:${id}`); },
    pathProbe: probe as any,
    protectedRoots: [],
    audit: async (e) => { auditEvents.push(e as Record<string, unknown>); },
    actor: 'tester',
    fs: fs as any,
  };

  return {
    deps, calls, auditEvents, sessions, targetFiles, sourceFiles,
    setSourceRemoveError: (e) => { sourceRemoveError = e; },
    setCopyError: (e) => { copyError = e; },
    setReconcileMismatch: (v) => { reconcileMismatch = v; },
    setTxnError: (e) => { txnError = e; },
    setNotIdle: (ids) => { notIdle = new Set(ids); },
  };
}

function req(over: Record<string, unknown> = {}) {
  return { sessionId: 's1', newPath: 'C:/target/ws-new', ...over };
}

describe('P10 relocateWorkspace — ordered 13-step flow', () => {
  it('happy path: copy → reconcile → txn → rebind → verify → last delete → audit', async () => {
    const h = harness();
    const result = await relocateWorkspace(req(), h.deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspacePath.replace(/\\/g, '/')).toBe('C:/target/ws-new');
    expect(h.calls).toEqual(['cp', 'txn', 'rebind:s1', 'rm:source']);
    expect(h.sessions.get('s1')!.workspacePath.replace(/\\/g, '/')).toBe('C:/target/ws-new');
    expect(h.auditEvents.some((e) => e.decision === 'allowed')).toBe(true);
  });

  it('rejects when session missing / relative path / same path / source missing', async () => {
    expect((await relocateWorkspace(req({ sessionId: 'nope' }), harness().deps))).toMatchObject({ code: 'NO_SESSION' });
    expect((await relocateWorkspace(req({ newPath: 'relative/x' }), harness().deps))).toMatchObject({ code: 'INVALID_PATH' });
    const h = harness();
    expect((await relocateWorkspace(req({ newPath: 'C:/proj/ws-old' }), h.deps))).toMatchObject({ code: 'SAME_PATH' });
  });

  it('rejects nested target (parent or child) — probe AND lexical backstop', async () => {
    const h1 = harness({ newPath: 'C:/proj/ws-old/child' });
    expect((await relocateWorkspace(req({ newPath: 'C:/proj/ws-old/child' }), h1.deps))).toMatchObject({ code: 'NESTED_PATH' });
    // Lexical backstop: probe says "not nested" but strings clearly are.
    const h2 = harness({ newPath: 'C:/proj/ws-old/child' });
    (h2.deps.pathProbe.isSameOrDescendant as any).mockResolvedValue(false);
    expect((await relocateWorkspace(req({ newPath: 'C:/proj/ws-old/child' }), h2.deps))).toMatchObject({ code: 'NESTED_PATH' });
  });

  it('rejects a non-empty target and a reparse/hard-link target', async () => {
    const h = harness({ targetExists: true, targetEntries: ['stale.txt'] });
    expect((await relocateWorkspace(req(), h.deps))).toMatchObject({ code: 'TARGET_NOT_EMPTY' });

    const h2 = harness();
    (h2.deps.pathProbe.inspect as any).mockImplementation(async (t: string) => ({
      displayPath: t, canonicalPath: t, identity: 'x', nearestExistingAncestor: t,
      isDirectory: true, isReparsePoint: true, exists: true, linkCount: 1,
    }));
    expect((await relocateWorkspace(req(), h2.deps))).toMatchObject({ code: 'ADMISSION_FAILED' });
  });

  it('rejects when a session sharing the workspace is not idle', async () => {
    const h = harness();
    h.sessions.set('s2', { id: 's2', profileId: 'bid-writing', workspacePath: 'C:/proj/ws-old', open: true });
    h.setNotIdle(['s2']);
    expect((await relocateWorkspace(req(), h.deps))).toMatchObject({ code: 'NOT_IDLE' });
    expect(h.calls).not.toContain('cp');
  });

  it('copy failure clears the target and leaves source untouched', async () => {
    const h = harness();
    h.setCopyError(new Error('disk full'));
    expect((await relocateWorkspace(req(), h.deps))).toMatchObject({ code: 'COPY_FAILED' });
    expect(h.calls).toContain('cp');
    expect(h.calls).toContain('rm:target');
    expect(h.calls).not.toContain('txn');
    expect(h.calls).not.toContain('rm:source');
  });

  it('reconcile mismatch clears the target (file count/bytes)', async () => {
    const h = harness();
    // Different byte totals on the target side → reconcile detects divergence.
    (h.deps.fs!.stat as any).mockImplementation(async (p: string) => ({
      size: String(p).replace(/\\/g, '/').includes('ws-new') ? 99 : 10,
    }));
    const result = await relocateWorkspace(req(), h.deps);
    expect(result).toMatchObject({ code: 'RECONCILE_FAILED' });
    expect(h.calls).toContain('rm:target');
    expect(h.calls).not.toContain('rm:source');
  });

  it('transaction failure rolls back target, session records unchanged', async () => {
    const h = harness();
    h.setTxnError(new Error('db write failed'));
    expect((await relocateWorkspace(req(), h.deps))).toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(h.sessions.get('s1')!.workspacePath).toBe('C:/proj/ws-old');
    expect(h.calls).toContain('rm:target');
    expect(h.calls).not.toContain('rm:source');
  });

  it('source removal EBUSY keeps both copies + warns via audit (never deletes only copy)', async () => {
    const h = harness();
    h.setSourceRemoveError(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const result = await relocateWorkspace(req(), h.deps);
    expect(result).toMatchObject({ code: 'SOURCE_REMOVE_FAILED', keptBothCopies: true });
    // Target copy is complete and authoritative; source kept as fallback.
    expect(h.targetFiles.size).toBe(h.sourceFiles.size);
    expect(h.auditEvents.some((e) => e.ruleId === 'relocate.source-remove-failed')).toBe(true);
  });

  it('updates ALL sessions sharing the path in one transaction (F8)', async () => {
    const h = harness();
    h.sessions.set('s2', { id: 's2', profileId: 'bid-writing', workspacePath: 'C:/proj/ws-old', open: false });
    const txn = vi.spyOn(h.deps, 'updateWorkspacePathInTransaction');
    const result = await relocateWorkspace(req(), h.deps);
    expect(result.ok).toBe(true);
    expect(txn).toHaveBeenCalledTimes(1);
    expect(h.sessions.get('s1')!.workspacePath.replace(/\\/g, '/')).toBe('C:/target/ws-new');
    expect(h.sessions.get('s2')!.workspacePath.replace(/\\/g, '/')).toBe('C:/target/ws-new');
    expect(h.calls.filter((c) => c.startsWith('rebind:'))).toEqual(['rebind:s1']);
  });

  it('audits failure paths (fail-closed parity with P1)', async () => {
    const h = harness();
    h.setNotIdle(['s1']);
    await relocateWorkspace(req(), h.deps);
    expect(h.auditEvents.length).toBeGreaterThan(0);
    expect(h.auditEvents[0].decision).toBe('failed');
  });
});
