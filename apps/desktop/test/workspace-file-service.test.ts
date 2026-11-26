import { mkdtempSync, mkdirSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkspacePathProbe } from '@sparkii/approval';
import { createWorkspaceFileService } from '../electron/main/security/workspace-file-service.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Real-filesystem probe with canonical identity via realpath semantics approximated on temp dirs. */
function makeProbe(reparse = new Set<string>()): WorkspacePathProbe {
  return {
    inspect: async (target) => {
      const abs = resolve(target);
      const exists = existsSync(abs);
      return {
        displayPath: target,
        canonicalPath: abs,
        identity: `mock:${key(abs)}`,
        nearestExistingAncestor: abs,
        isDirectory: exists ? (await import('node:fs')).statSync(abs).isDirectory() : false,
        isReparsePoint: reparse.has(key(abs)),
        exists,
      };
    },
    isSameOrDescendant: async (root, target) => {
      const r = key(root);
      const t = key(target);
      return t === r || t.startsWith(`${r}/`);
    },
    isSameObject: async (left, right) => key(left) === key(right),
  };
}

interface AuditCall { action: string; decision?: string; sessionId?: string; ruleId?: string; resource?: string }

function setup(opts?: { reparse?: Set<string>; withWorkspace?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'bid-wsfile-'));
  const workspace = join(base, 'workspace');
  if (opts?.withWorkspace !== false) mkdirSync(workspace, { recursive: true });
  const outside = join(base, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');

  const audits: AuditCall[] = [];
  const rec = { id: 's1', profileId: 'bid-writing', workspacePath: workspace };
  const deps = {
    chatSessions: { get: (id: string) => (id === 's1' ? rec : undefined) } as never,
    audit: { append: async (ev: AuditCall) => { audits.push(ev); return ev; } } as never,
    security: {
      pathProbe: makeProbe(opts?.reparse),
      protectedRoots: [],
    } as never,
    subjectUserId: 'u1',
  };
  return { service: createWorkspaceFileService(deps), workspace, outside, base, audits, rec };
}

describe('workspace file service — P1 hard conditions (product §14 R1)', () => {
  it('writes and reads a file inside the fixed workspace, auditing both', async () => {
    const { service, audits } = setup();
    const w = await service.execute('write', { sessionId: 's1', path: 'project.json', content: '{"name":"x"}' });
    expect(w.ok).toBe(true);
    const r = await service.execute('read', { sessionId: 's1', path: 'project.json' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('{"name":"x"}');
    expect(audits.length).toBe(2);
    expect(audits.every((a) => a.decision === 'allowed' && a.sessionId === 's1')).toBe(true);
  });

  it('rejects a read outside the workspace (.. escape) and records a failed audit', async () => {
    const { service, outside, audits } = setup();
    const rel = '../outside/secret.txt';
    const r = await service.execute('read', { sessionId: 's1', path: rel });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code === 'DENIED' || r.code === 'INVALID').toBe(true);
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });

  it('rejects an absolute-path escape', async () => {
    const { service } = setup();
    const r = await service.execute('read', { sessionId: 's1', path: 'C:/Windows/System32/config' });
    expect(r.ok).toBe(false);
  });

  it('rejects a target marked as reparse point (symlink escape)', async () => {
    const { service, workspace, outside } = setup();
    const link = join(workspace, 'link.txt');
    try { symlinkSync(join(outside, 'secret.txt'), link); } catch { /* symlink may need privilege */ }
    // Force the probe to treat the link path as a reparse point regardless of OS.
    const base = dirname(workspace);
    const reparse = new Set([key(link)]);
    const audits: AuditCall[] = [];
    const rec = { id: 's1', profileId: 'bid-writing', workspacePath: workspace };
    const svc = createWorkspaceFileService({
      chatSessions: { get: (id: string) => (id === 's1' ? rec : undefined) } as never,
      audit: { append: async (ev: AuditCall) => { audits.push(ev); return ev; } } as never,
      security: { pathProbe: makeProbe(reparse), protectedRoots: [] } as never,
      subjectUserId: 'u1',
    });
    const r = await svc.execute('read', { sessionId: 's1', path: 'link.txt' });
    expect(r.ok).toBe(false);
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });

  it('refuses an unknown session and a session with no workspace (fail closed)', async () => {
    const { service } = setup();
    const noSession = await service.execute('read', { sessionId: 'nope', path: 'x' });
    expect(noSession.ok).toBe(false);
    if (!noSession.ok) expect(noSession.code).toBe('NO_SESSION');
  });

  it('refuses to delete the workspace root itself', async () => {
    const { service } = setup();
    const r = await service.execute('delete', { sessionId: 's1', path: '.' });
    expect(r.ok).toBe(false);
  });

  it.each([
    ['delete', '.sparkii'],
    ['rename', '.sparkii'],
    ['move', '.sparkii'],
    ['delete', '.SpArKiI'],
    ['rename', '.SpArKiI'],
    ['move', '.SpArKiI'],
  ] as const)(
    'rejects %s of an ordinary parent containing nested %s/secret',
    async (op, reservedName) => {
      const { service, workspace } = setup();
      const parent = join(workspace, 'generated');
      const secret = join(parent, 'nested', reservedName, 'secret');
      mkdirSync(dirname(secret), { recursive: true });
      writeFileSync(secret, 'keep');

      const result = await service.execute(op, {
        sessionId: 's1',
        path: 'generated',
        ...(op === 'delete' ? {} : { to: 'moved' }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('DENIED');
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(join(workspace, 'moved'))).toBe(false);
      expect(readFileSync(secret, 'utf8')).toBe('keep');
    },
  );

  it('continues to reject direct reserved delete and rename/move requests', async () => {
    const { service, workspace } = setup();
    const reserved = join(workspace, '.sparkii');
    const secret = join(reserved, 'secret');
    mkdirSync(reserved);
    writeFileSync(secret, 'keep');

    for (const op of ['delete', 'rename', 'move'] as const) {
      const result = await service.execute(op, {
        sessionId: 's1',
        path: '.sparkii',
        ...(op === 'delete' ? {} : { to: 'moved-secret' }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('DENIED');
    }
    expect(readFileSync(secret, 'utf8')).toBe('keep');
    expect(existsSync(join(workspace, 'moved-secret'))).toBe(false);
  });

  it('deletes and moves ordinary trees without reserved descendants', async () => {
    const { service, workspace } = setup();
    const deleteParent = join(workspace, 'delete-me');
    const deleteFile = join(deleteParent, 'nested', 'a.txt');
    mkdirSync(dirname(deleteFile), { recursive: true });
    writeFileSync(deleteFile, 'delete');

    const deleted = await service.execute('delete', { sessionId: 's1', path: 'delete-me' });
    expect(deleted.ok).toBe(true);
    expect(existsSync(deleteParent)).toBe(false);

    const from = join(workspace, 'move-me');
    const file = join(from, 'nested', 'a.txt');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'keep');
    for (const op of ['rename', 'move'] as const) {
      const source = op === 'rename' ? 'move-me' : 'renamed';
      const to = op === 'rename' ? 'renamed' : 'moved';
      const result = await service.execute(op, { sessionId: 's1', path: source, to });
      expect(result.ok).toBe(true);
    }
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(workspace, 'moved', 'nested', 'a.txt'), 'utf8')).toBe('keep');
  });

  it.each(['.sparkii', '.SpArKiI'])(
    'continues to list ordinary root entries while hiding %s',
    async (reservedName) => {
      const { service, workspace } = setup();
      mkdirSync(join(workspace, 'input'));
      writeFileSync(join(workspace, 'project.json'), '{}');
      mkdirSync(join(workspace, reservedName));

      const result = await service.execute('list', { sessionId: 's1', path: '.' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entries?.slice().sort()).toEqual(['input', 'project.json']);
    },
  );

  it('rename/move require a valid destination inside the workspace', async () => {
    const { service } = setup();
    await service.execute('write', { sessionId: 's1', path: 'a.md', content: 'x' });
    const ok = await service.execute('rename', { sessionId: 's1', path: 'a.md', to: 'b.md' });
    expect(ok.ok).toBe(true);
    const bad = await service.execute('move', { sessionId: 's1', path: 'b.md', to: '../../escape.md' });
    expect(bad.ok).toBe(false);
  });
});
