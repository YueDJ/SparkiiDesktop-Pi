import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  linkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWindowsSandboxAdapter,
  assertNoHardLinkAliases,
  prepareTrustAnchorIsolation,
  scanTrustAnchors,
} from '../electron/main/security/windows-sandbox.js';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'sandbox-adapter-'));
  const workspace = join(base, 'workspace');
  const scratch = join(base, 'scratch');
  mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(workspace, '.env'), 'SECRET=1');
  writeFileSync(join(workspace, '.git', 'hooks', 'pre-commit'), 'hook');
  writeFileSync(join(workspace, '.git', 'config'), '[core]\n');
  writeFileSync(join(workspace, '.mcp.json'), '{}');
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export {}');
  return { base, workspace, scratch };
}

describe('Windows sandbox trust-anchor isolation', () => {
  it('finds trust anchors without treating ordinary source files as protected', () => {
    const f = fixture();
    expect(scanTrustAnchors(f.workspace).sort()).toEqual([
      join(f.workspace, '.env'),
      join(f.workspace, '.git', 'config'),
      join(f.workspace, '.git', 'hooks'),
      join(f.workspace, '.mcp.json'),
    ].sort());
  });

  it('quarantines secrets and hooks, restores them, and discards sandbox replacements', async () => {
    const f = fixture();
    const isolation = await prepareTrustAnchorIsolation(f.workspace, f.scratch);
    expect(existsSync(join(f.workspace, '.env'))).toBe(false);
    expect(existsSync(join(f.workspace, '.git', 'hooks'))).toBe(false);
    writeFileSync(join(f.workspace, '.env'), 'ATTACKER');
    mkdirSync(join(f.workspace, '.git', 'hooks'));
    writeFileSync(join(f.workspace, '.git', 'hooks', 'pre-commit'), 'malicious');
    writeFileSync(join(f.workspace, '.git', 'config'), '[core]\nfsmonitor = malware\n');
    const changes = await isolation.restore();

    expect(readFileSync(join(f.workspace, '.env'), 'utf8')).toBe('SECRET=1');
    expect(readFileSync(join(f.workspace, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('hook');
    expect(readFileSync(join(f.workspace, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(changes.length).toBeGreaterThan(0);
  });

  it('reports unavailable rather than enabling shell when the helper is absent', async () => {
    const adapter = createWindowsSandboxAdapter({
      helperPath: join(tmpdir(), 'missing-sparkii-sandbox.exe'),
      probeExecutablePath: join(tmpdir(), 'missing-sandbox-probe.exe'),
      runtimeRoot: tmpdir(),
    });
    await expect(adapter.probe()).resolves.toMatchObject({
      status: 'unavailable',
      capabilities: {
        filesystemBoundary: false,
        networkIsolation: false,
      },
    });
  });

  it('fails closed when a workspace file is a hardlink to another object', async () => {
    const f = fixture();
    const outside = join(f.base, 'outside.bin');
    writeFileSync(outside, 'x');
    linkSync(outside, join(f.workspace, 'linked.bin'));
    await expect(assertNoHardLinkAliases(f.workspace)).rejects.toThrow(/hardlink/i);
  });
});
