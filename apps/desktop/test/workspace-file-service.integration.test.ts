/**
 * Real-filesystem integration tests for the P1 workspace boundary (architect
 * review round 2, suggestion ⑧b). Unlike the unit test's hand-rolled probe,
 * these use the platform's REAL `createWindowsPathProbe` (realpath/lstat) plus
 * real symlink / hard-link fixtures, so the symlink-escapee and hard-link-alias
 * defenses are actually exercised rather than simulated.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createWindowsPathProbe } from '../electron/main/security/windows-platform.js';
import { createWorkspaceFileService } from '../electron/main/security/workspace-file-service.js';

interface AuditCall { action: string; decision?: string; sessionId?: string; payloadSummary?: string }

function makeService(workspace: string) {
  const probe = createWindowsPathProbe({
    home: homedir(),
    windowsDir: resolve(homedir(), '../Windows'),
    programFiles: 'C:/Program Files',
    programFilesX86: 'C:/Program Files (x86)',
    programData: 'C:/ProgramData',
    appData: join(homedir(), 'AppData/Roaming'),
    localAppData: join(homedir(), 'AppData/Local'),
    dataDir: join(homedir(), 'AppData/Local/Sparkii'),
  });
  const audits: AuditCall[] = [];
  const rec = { id: 's1', profileId: 'bid-writing', workspacePath: workspace };
  const service = createWorkspaceFileService({
    chatSessions: { get: (id: string) => (id === 's1' ? rec : undefined) } as never,
    audit: { append: async (ev: AuditCall) => { audits.push(ev); return ev; } } as never,
    security: { pathProbe: probe, protectedRoots: [] } as never,
    subjectUserId: 'u1',
  });
  return { service, audits };
}

function tempLayout() {
  const base = mkdtempSync(join(tmpdir(), 'bid-wsreal-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
  return { base, workspace, outside };
}

describe('workspace file service — REAL probe integration (symlink / hard-link)', () => {
  it('allows a normal in-workspace write/read and audits sessionId→projectPath', async () => {
    const { workspace } = tempLayout();
    const { service, audits } = makeService(workspace);
    const w = await service.execute('write', { sessionId: 's1', path: 'project.json', content: '{}' });
    expect(w.ok).toBe(true);
    const r = await service.execute('read', { sessionId: 's1', path: 'project.json' });
    expect(r.ok).toBe(true);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const allow = audits.find((a) => a.decision === 'allowed');
    expect(allow?.sessionId).toBe('s1');
    expect(allow?.payloadSummary).toContain('projectPath');
    expect((allow?.payloadSummary ?? '').toLowerCase().replace(/\\\\/g, '/')).toContain(
      workspace.toLowerCase().replace(/\\/g, '/'),
    );
  });

  it('lists the workspace root with path "." (P1 rejects an empty path)', async () => {
    const { workspace } = tempLayout();
    mkdirSync(join(workspace, 'input'), { recursive: true });
    writeFileSync(join(workspace, 'project.json'), '{}');
    const { service } = makeService(workspace);

    const empty = await service.execute('list', { sessionId: 's1', path: '' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('INVALID');

    const root = await service.execute('list', { sessionId: 's1', path: '.' });
    expect(root.ok).toBe(true);
    if (root.ok) expect(root.entries?.slice().sort()).toEqual(['input', 'project.json']);
  });

  it('writes and reads back binary bytes through the fenced workspace', async () => {
    const { workspace } = tempLayout();
    mkdirSync(join(workspace, 'input'), { recursive: true });
    const { service } = makeService(workspace);
    const bytesBase64 = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]).toString('base64');

    const w = await service.execute('writeBytes', {
      sessionId: 's1', path: 'input/report.pdf', bytesBase64,
    });
    expect(w.ok).toBe(true);

    const r = await service.execute('readBytes', { sessionId: 's1', path: 'input/report.pdf' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytesBase64).toBe(bytesBase64);
  });

  it('rejects .. escape with the REAL probe and records a failed audit', async () => {
    const { workspace } = tempLayout();
    const { service, audits } = makeService(workspace);
    const r = await service.execute('read', { sessionId: 's1', path: '../outside/secret.txt' });
    expect(r.ok).toBe(false);
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });

  it('rejects a REAL symlink pointing outside the workspace', async () => {
    const { workspace, outside } = tempLayout();
    const link = join(workspace, 'escape.txt');
    try {
      symlinkSync(join(outside, 'secret.txt'), link, 'file');
    } catch (err) {
      // Windows requires Developer Mode / elevation for symlinks. Emit a loud
      // warning instead of silently passing — see known limitation in the tech
      // design doc. The reparse-point logic is still covered by the mock-probe
      // unit test; CI with elevation should run this case for real.
      console.warn(`[ws-boundary] symlink fixture unavailable (${String(err)}); symlink-escape case skipped — run CI with Developer Mode to cover it for real`);
      return;
    }
    if (!existsSync(link)) return;
    const { service, audits } = makeService(workspace);
    const r = await service.execute('read', { sessionId: 's1', path: 'escape.txt' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DENIED');
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });

  it('rejects a REAL hard-link alias (nlink > 1) inside the workspace', async () => {
    const { workspace, outside } = tempLayout();
    const src = join(outside, 'secret.txt');
    const alias = join(workspace, 'alias.txt');
    try {
      linkSync(src, alias);
    } catch {
      return; // hard links across volumes may fail; skip
    }
    if (!existsSync(alias)) return;
    const { service, audits } = makeService(workspace);
    const r = await service.execute('read', { sessionId: 's1', path: 'alias.txt' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DENIED');
    expect(audits.some((a) => a.decision === 'failed')).toBe(true);
  });
});
