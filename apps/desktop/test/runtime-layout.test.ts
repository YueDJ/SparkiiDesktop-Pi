import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  needsProvision,
  needsSearchTools,
  resolveRuntimePaths,
  resolveRuntimeRoot,
  resolveRuntimeToolsDir,
  resolveSearchToolPaths,
} from '../electron/main/runtime-layout.js';

function provision(root: string, { bash = true, git = true } = {}): void {
  const portableGit = join(root, 'portable-git');
  mkdirSync(join(portableGit, 'bin'), { recursive: true });
  mkdirSync(join(portableGit, 'cmd'), { recursive: true });
  if (bash) writeFileSync(join(portableGit, 'bin', 'bash.exe'), 'x');
  if (git) writeFileSync(join(portableGit, 'cmd', 'git.exe'), 'x');
}

describe('resolveRuntimeRoot', () => {
  it('uses LOCALAPPDATA\\SparkiiDesktop\\runtime by default', () => {
    const root = resolveRuntimeRoot({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' });
    expect(root).toBe(join('C:/Users/x/AppData/Local', 'SparkiiDesktop', 'runtime'));
  });

  it('honors SPARKII_RUNTIME_ROOT override', () => {
    expect(resolveRuntimeRoot({ SPARKII_RUNTIME_ROOT: 'D:/sparkii/runtime' })).toBe('D:/sparkii/runtime');
  });
});

describe('resolveRuntimePaths', () => {
  it('locates bash and git under portable-git', () => {
    const paths = resolveRuntimePaths({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' });
    expect(paths.portableGitDir).toBe(join('C:/Users/x/AppData/Local', 'SparkiiDesktop', 'runtime', 'portable-git'));
    expect(paths.bashPath).toBe(join(paths.portableGitDir, 'bin', 'bash.exe'));
    expect(paths.gitCmdDir).toBe(join(paths.portableGitDir, 'cmd'));
    expect(paths.gitPath).toBe(join(paths.portableGitDir, 'cmd', 'git.exe'));
  });
});

describe('needsProvision', () => {
  it('returns true when nothing is extracted', () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    expect(needsProvision({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('returns true when only bash is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    provision(root, { git: false });
    expect(needsProvision({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('returns false when bash and git are present', () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-rt-'));
    provision(root);
    expect(needsProvision({ SPARKII_RUNTIME_ROOT: root })).toBe(false);
  });
});

describe('search tool paths', () => {
  it('uses LOCALAPPDATA\\SparkiiDesktop\\runtime\\tools by default', () => {
    const toolsDir = resolveRuntimeToolsDir({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' });
    expect(toolsDir).toBe(join('C:/Users/x/AppData/Local', 'SparkiiDesktop', 'runtime', 'tools'));
  });

  it('honors SPARKII_RUNTIME_ROOT override', () => {
    expect(resolveRuntimeToolsDir({ SPARKII_RUNTIME_ROOT: 'D:/sparkii/runtime' }))
      .toBe(join('D:/sparkii/runtime', 'tools'));
  });

  it('locates fd.exe and rg.exe under the resolved tools dir', () => {
    const paths = resolveSearchToolPaths({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' });
    expect(paths.fdPath).toBe(join(paths.toolsDir, 'fd.exe'));
    expect(paths.rgPath).toBe(join(paths.toolsDir, 'rg.exe'));
  });

  it('reports missing search tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-search-'));
    expect(needsSearchTools({ SPARKII_RUNTIME_ROOT: root })).toBe(true);
  });

  it('reports search tools ready when both files exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'sparkii-search-'));
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, 'fd.exe'), 'x');
    writeFileSync(join(toolsDir, 'rg.exe'), 'x');
    expect(needsSearchTools({ SPARKII_RUNTIME_ROOT: root })).toBe(false);
  });
});
