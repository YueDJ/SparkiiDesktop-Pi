import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findPrebuild,
  prebuildTarget,
  resolveBetterSqlite3Root,
  shouldSkipRebuild,
} from '../scripts/install-native-deps.mjs';

const repoRoot = join(__dirname, '../../..');

describe('better-sqlite3 install policy', () => {
  it('blocks host node-gyp on pnpm 9 and pnpm 10.26+/11', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      pnpm?: { neverBuiltDependencies?: string[] };
    };
    expect(pkg.pnpm?.neverBuiltDependencies).toContain('better-sqlite3');

    const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toMatch(/better-sqlite3:\s*false/);

    const desktop = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(desktop.scripts.postinstall).toBe('node scripts/install-native-deps.mjs');
    expect(desktop.scripts.postinstall).not.toContain('install-app-deps');
    expect(desktop.scripts.dist).toContain('install-native-deps.mjs --rebuild');
  });
});

describe('install-native-deps prebuild selection', () => {
  it('maps Windows and musl targets the same way better-sqlite3 does', () => {
    expect(prebuildTarget({ platform: 'win32', arch: 'x64' })).toBe('win32-x64');
    expect(prebuildTarget({ platform: 'win32', arch: 'arm64' })).toBe('win32-arm64');
    expect(prebuildTarget({ platform: 'linux', arch: 'x64', musl: true })).toBe('linuxmusl-x64');
    expect(prebuildTarget({ platform: 'linux', arch: 'x64', musl: false })).toBe('linux-x64');
    expect(prebuildTarget({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
  });

  it('skips electron-builder rebuild when a package prebuild exists', () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), 'bsql-prebuild-'));
    mkdirSync(join(pkgRoot, 'prebuilds'));
    const file = join(pkgRoot, 'prebuilds', 'win32-x64.node');
    writeFileSync(file, '');

    expect(findPrebuild(pkgRoot, 'win32-x64')).toBe(file);
    expect(findPrebuild(pkgRoot, 'linux-x64')).toBeNull();
    expect(shouldSkipRebuild({ rebuildRequested: false, prebuildPath: file })).toBe(true);
    expect(shouldSkipRebuild({ rebuildRequested: true, prebuildPath: file })).toBe(false);
    expect(shouldSkipRebuild({ rebuildRequested: false, prebuildPath: null })).toBe(false);
  });

  it('resolves the installed package and its win32-x64 prebuild', () => {
    const pkgRoot = resolveBetterSqlite3Root();
    expect(pkgRoot).toBeTruthy();
    expect(findPrebuild(pkgRoot, 'win32-x64')).toMatch(/win32-x64\.node$/);

    const requireFromDesktop = createRequire(join(repoRoot, 'apps/desktop/package.json'));
    const Database = requireFromDesktop('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as n').get()).toEqual({ n: 1 });
    db.close();

    const resolvedRoot = dirname(requireFromDesktop.resolve('better-sqlite3/package.json'));
    expect(existsSync(join(resolvedRoot, 'prebuilds', 'win32-x64.node'))).toBe(true);
  });
});
