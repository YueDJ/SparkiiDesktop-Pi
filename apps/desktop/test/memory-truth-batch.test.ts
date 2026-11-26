import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { MemoryStore, parseMemoryFile, parseProjectMemoryFile } from '../electron/main/memory/store.js';
import { assertTruthPathSafe, commitTruthBatch, recoverTruthBatch } from '../electron/main/memory/truth-batch.js';
import { copyTruthFileVerified } from '../electron/main/memory/truth-path.js';
import { memoryDbPath, memoryDir, projectRegistryFile, projectMemoryFile, userMemoryFile, episodesFile, episodeProposalFile } from '../electron/main/memory/settings.js';

const fault = vi.hoisted(() => ({ failPath: '' }));
const nativeProbeHarness = vi.hoisted(() => ({
  afterAttributes: undefined as ((paths: string[]) => void) | undefined,
  reparseTarget: '',
}));

vi.mock('../electron/main/memory/truth-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/main/memory/truth-path.js')>();
  const probeAttributes = (paths: string[]): number[] => {
    const values = paths.map((path) => nativeProbeHarness.reparseTarget && path === nativeProbeHarness.reparseTarget ? 16 : 0);
    nativeProbeHarness.afterAttributes?.(paths);
    return values;
  };
  return {
    ...actual,
    assertTruthPathSafe: (path: string, probe?: (paths: string[]) => number[]) => actual.assertTruthPathSafe(path, probe ?? probeAttributes),
    inspectTruthFile: (path: string, probe?: (paths: string[]) => number[], options?: { allowMissing?: boolean; regularFile?: boolean }) =>
      actual.inspectTruthFile(path, probe ?? probeAttributes, options),
    inspectTruthFileTwice: (path: string, probe?: (paths: string[]) => number[], options?: { allowMissing?: boolean; regularFile?: boolean; expectedIdentity?: string }) =>
      actual.inspectTruthFileTwice(path, probe ?? probeAttributes, options),
    inspectTruthFiles: (inspections: Parameters<typeof actual.inspectTruthFiles>[0], probe?: (paths: string[]) => number[]) =>
      actual.inspectTruthFiles(inspections, probe ?? probeAttributes),
    inspectTruthFilesTwice: (inspections: Parameters<typeof actual.inspectTruthFilesTwice>[0], probe?: (paths: string[]) => number[]) =>
      actual.inspectTruthFilesTwice(inspections, probe ?? probeAttributes),
    readTruthDirectoriesVerified: (paths: string[], probe?: (paths: string[]) => number[]) =>
      actual.readTruthDirectoriesVerified(paths, probe ?? probeAttributes),
    readTruthFilesVerified: (requests: Parameters<typeof actual.readTruthFilesVerified>[0], probe?: (paths: string[]) => number[], preceding?: Parameters<typeof actual.readTruthFilesVerified>[2]) =>
      actual.readTruthFilesVerified(requests, probe ?? probeAttributes, preceding),
    readTruthFileVerifiedResult: (path: string, options?: Parameters<typeof actual.readTruthFileVerifiedResult>[1]) =>
      actual.readTruthFileVerifiedResult(path, { ...options, probeAttributes: options?.probeAttributes ?? probeAttributes }),
    assertTruthFileIdentity: (path: string, identity: string, probe?: (paths: string[]) => number[], options?: { regularFile?: boolean }) =>
      actual.assertTruthFileIdentity(path, identity, probe ?? probeAttributes, options),
    readTruthFileVerified: (path: string, options?: Parameters<typeof actual.readTruthFileVerified>[1]) =>
      actual.readTruthFileVerified(path, { ...options, probeAttributes: options?.probeAttributes ?? probeAttributes }),
    copyTruthFileVerified: (source: string, destination: string, options?: Parameters<typeof actual.copyTruthFileVerified>[2]) =>
      actual.copyTruthFileVerified(source, destination, { ...options, probeAttributes: options?.probeAttributes ?? probeAttributes }),
    removeTruthPathVerified: (path: string, options?: Parameters<typeof actual.removeTruthPathVerified>[1]) =>
      actual.removeTruthPathVerified(path, { ...options, probeAttributes: options?.probeAttributes ?? probeAttributes }),
    renameTruthPathVerified: (source: string, destination: string, options?: Parameters<typeof actual.renameTruthPathVerified>[2]) =>
      actual.renameTruthPathVerified(source, destination, { ...options, probeAttributes: options?.probeAttributes ?? probeAttributes }),
  };
});

vi.mock('../electron/main/memory/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/main/memory/settings.js')>();
  return {
    ...actual,
    atomicWrite: (path: string, content: string, probe?: (paths: string[]) => number[], onRenamed?: () => void) => {
      if (path === fault.failPath) throw new Error('injected truth write failure');
      actual.atomicWrite(path, content, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      )), onRenamed);
    },
  };
});

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-truth-batch-'));
  dataDir = join(root, 'data');
  mkdirSync(memoryDir(dataDir), { recursive: true });
  fault.failPath = '';
  nativeProbeHarness.afterAttributes = undefined;
  nativeProbeHarness.reparseTarget = '';
});

afterEach(() => {
  fault.failPath = '';
  nativeProbeHarness.afterAttributes = undefined;
  nativeProbeHarness.reparseTarget = '';
  rmSync(root, { recursive: true, force: true });
});

describe('truth batch journal', () => {
  it('restores every prior truth file and removes new files when a later write fails', () => {
    const a = userMemoryFile(dataDir);
    const b = episodesFile(dataDir);
    const c = episodeProposalFile(dataDir, 'new');
    writeFileSync(a, 'old-a');
    writeFileSync(b, 'old-b');
    fault.failPath = b;

    expect(() => commitTruthBatch(dataDir, new Map([
      [a, 'new-a'],
      [b, 'new-b'],
      [c, 'new-c'],
    ]))).toThrow('injected truth write failure');

    expect(readFileSync(a, 'utf8')).toBe('old-a');
    expect(readFileSync(b, 'utf8')).toBe('old-b');
    expect(existsSync(c)).toBe(false);
    expect(existsSync(join(memoryDir(dataDir), '.truth-batch-journal.json'))).toBe(false);
    expect(existsSync(join(memoryDir(dataDir), '.truth-backups'))).toBe(false);
  });

  it('R8-P1-4 removes an uncommitted journal when post-write verification fails without changing original truth', () => {
    const target = userMemoryFile(dataDir);
    const original = 'ORIGINAL_TRUTH_BYTES_71C\n';
    writeFileSync(target, original);

    expect(() => commitTruthBatch(dataDir, new Map([[target, 'NEW_TRUTH_92D']]), {
      onJournalWritten: () => { throw new Error('injected journal verification failure'); },
    })).toThrow('injected journal verification failure');

    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(existsSync(join(memoryDir(dataDir), '.truth-batch-journal.json'))).toBe(false);
    expect(existsSync(join(memoryDir(dataDir), '.truth-backups'))).toBe(false);
    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(() => commitTruthBatch(dataDir, new Map([[target, 'SAFE_RETRY_83E']]))).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('SAFE_RETRY_83E');
  });

  it('R8 final review never rolls back truth after the committed journal is durable', () => {
    const target = userMemoryFile(dataDir);
    writeFileSync(target, 'ORIGINAL_TRUTH_71C\n');
    expect(() => commitTruthBatch(dataDir, new Map([[target, 'COMMITTED_TRUTH_92D\n']]), {
      onCommittedJournalWritten: () => { throw new Error('injected committed journal verification failure'); },
    }))
      .toThrow('injected committed journal verification failure');

    expect(readFileSync(target, 'utf8')).toBe('COMMITTED_TRUTH_92D\n');
    expect(JSON.parse(readFileSync(join(memoryDir(dataDir), '.truth-batch-journal.json'), 'utf8')))
      .toEqual({ version: 1, files: [], committed: true });
    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('COMMITTED_TRUTH_92D\n');
  });

  it.each(['once', 'persistent'] as const)('R8 review truth round7 B1 keeps committed truth when post-rename journal probe fails %s', (failureMode) => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(dir, '.truth-backups', '0.backup');
    const original = 'ORIGINAL_TRUTH_B1_71C\n';
    const committed = 'COMMITTED_TRUTH_B1_92D\n';
    writeFileSync(target, original);
    let markerProbes = 0;
    const onAtomicWriteRenamed = (path: string) => {
      if (path !== journalPath) return;
      nativeProbeHarness.afterAttributes = (paths) => {
        if (!paths.includes(journalPath)) return;
        markerProbes += 1;
        if (failureMode === 'persistent' || markerProbes === 1) {
          throw new Error(`injected post-rename committed journal probe failure (${failureMode})`);
        }
      };
    };

    const probeAttributes = (paths: string[]) => {
      nativeProbeHarness.afterAttributes?.(paths);
      return paths.map(() => 0);
    };
    let commitError: unknown;
    try { commitTruthBatch(dataDir, new Map([[target, committed]]), { probeAttributes, onAtomicWriteRenamed }); } catch (error) { commitError = error; }
    expect(commitError).toBeInstanceOf(Error);
    expect((commitError as Error).message).toContain('injected post-rename committed journal probe failure');
    expect(markerProbes).toBeGreaterThanOrEqual(1);
    expect(readFileSync(target, 'utf8')).toBe(committed);
    if (failureMode === 'persistent') {
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toEqual({ version: 1, files: [], committed: true });
      expect(readFileSync(backup, 'utf8')).toBe(original);
      expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
    } else {
      expect(existsSync(journalPath)).toBe(false);
      expect(existsSync(backup)).toBe(false);
    }

    nativeProbeHarness.afterAttributes = undefined;
    const recovery = recoverTruthBatch(dataDir);
    if (failureMode === 'persistent') {
      expect(recovery.join('\n')).toContain('写入阻断');
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toEqual({ version: 1, files: [], committed: true });
      expect(readFileSync(backup, 'utf8')).toBe(original);
      expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
    } else expect(recovery).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(committed);
  });

  it('R8 review truth round7 B2 rejects a source replaced during the last destination probe before recovery copy', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const backup = join(backups, '0.backup');
    const journal = join(dir, '.truth-batch-journal.json');
    const external = join(root, 'external-copy-source.txt');
    const partial = 'PARTIAL_TRUTH_B2_71C\n';
    const original = 'ORIGINAL_TRUTH_B2_92D\n';
    const externalBytes = 'EXTERNAL_COPY_SOURCE_SECRET_B2_83E\n';
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, partial);
    writeFileSync(backup, original);
    writeFileSync(external, externalBytes);
    writeFileSync(journal, JSON.stringify({
      version: 1,
      files: [{ target, backup, existed: true }],
    }));
    let destinationProbes = 0;
    let sourceProbedAfterDestination = false;
    let replaced = false;
    nativeProbeHarness.afterAttributes = (paths) => {
      if (paths.includes(target) || paths.includes(backup)) console.log('R8_DEBUG_PROBE', { paths, destinationProbes, sourceProbedAfterDestination });
      if (paths.includes(target)) {
        destinationProbes += 1;
        if (sourceProbedAfterDestination && !replaced) {
          replaced = true;
          rmSync(backup, { force: true });
          linkSync(external, backup);
        }
      } else if (destinationProbes >= 1 && paths.includes(backup)) {
        sourceProbedAfterDestination = true;
      }
    };

    const warnings = recoverTruthBatch(dataDir);
    console.log('R8_DEBUG_B2', { destinationProbes, sourceProbedAfterDestination, replaced, warnings });

    expect(replaced).toBe(true);
    expect(warnings.join('\n')).toContain('恢复失败');
    expect(warnings.join('\n')).toContain('包含硬链接');
    expect(readFileSync(target, 'utf8')).toBe(partial);
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    const savedBackups = readdirSync(dir).find((name) => name.startsWith('.truth-backups.corrupt-'));
    expect(savedBackups).toBeDefined();
    expect(readFileSync(join(dir, savedBackups!, '0.backup'), 'utf8')).toBe(externalBytes);
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-batch-journal.json.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
    expect(JSON.stringify(readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return existsSync(path) && path.endsWith('.json') ? [readFileSync(path, 'utf8')] : [];
    }))).not.toContain(externalBytes);
  });

  it('R8 review truth round7 B2 leaves destination bytes unchanged when verified copy source is replaced at the copy boundary', () => {
    const source = join(root, 'copy-source.txt');
    const destination = join(memoryDir(dataDir), '.truth-backups', '0.backup');
    const external = join(root, 'external-copy-victim.txt');
    const original = 'ORIGINAL_COPY_SOURCE_B2_71C\n';
    const destinationBytes = 'DESTINATION_BYTES_B2_92D\n';
    const externalBytes = 'EXTERNAL_COPY_BYTES_B2_83E\n';
    mkdirSync(join(memoryDir(dataDir), '.truth-backups'), { recursive: true });
    writeFileSync(source, original);
    writeFileSync(destination, destinationBytes);
    writeFileSync(external, externalBytes);
    let destinationProbes = 0;
    let sourceProbedAfterDestination = false;
    let replaced = false;
    nativeProbeHarness.afterAttributes = (paths) => {
      if (paths.includes(destination)) {
        destinationProbes += 1;
        if (sourceProbedAfterDestination && !replaced) {
          replaced = true;
          rmSync(source, { force: true });
          linkSync(external, source);
        }
      } else if (destinationProbes >= 1 && paths.includes(source)) {
        sourceProbedAfterDestination = true;
      }
    };

    expect(() => copyTruthFileVerified(source, destination)).toThrow('包含硬链接');
    expect(replaced).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(destinationBytes);
    expect(readFileSync(destination, 'utf8')).not.toContain(externalBytes.trim());
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
  });

  it('R8-P1-4 preserves rollback backups when the unverified journal cannot be removed', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(dir, '.truth-backups', '0.backup');
    const original = 'ORIGINAL_TRUTH_REMOVAL_FAILURE_71C\n';
    writeFileSync(target, original);

    expect(() => commitTruthBatch(dataDir, new Map([[target, 'NEW_TRUTH_92D']]), {
      onJournalWritten: () => {
        renameSync(journalPath, `${journalPath}.held`);
        mkdirSync(journalPath);
        throw new Error('injected journal verification failure');
      },
    })).toThrow('injected journal verification failure');

    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(readFileSync(backup, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(`${journalPath}.held`, 'utf8')).files[0].target).toBe(target);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('recovers an interrupted batch at startup before truth files are opened', () => {
    const a = userMemoryFile(dataDir);
    const b = episodeProposalFile(dataDir, 'new');
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(backups, '0.backup');
    mkdirSync(backups, { recursive: true });
    writeFileSync(a, 'partial-a');
    mkdirSync(join(memoryDir(dataDir), 'episode-proposals'), { recursive: true });
    writeFileSync(b, 'partial-b');
    writeFileSync(backup, 'old-a');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      files: [
        { target: a, backup, existed: true },
        { target: b, backup: join(backups, '1.backup'), existed: false },
      ],
    }));

    recoverTruthBatch(dataDir);

    expect(readFileSync(a, 'utf8')).toBe('old-a');
    expect(existsSync(b)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  });

  it('recovers a new project batch from the registry committed before its truth file', () => {
    const workspace = join(root, 'workspace-recovery');
    const target = projectMemoryFile(workspace);
    const registry = projectRegistryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'partial-project');
    writeFileSync(registry, JSON.stringify({
      version: 1,
      projects: [{ projectId: 'proj_recovery', workspacePath: workspace }],
    }));
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [
        { target: registry, backup: join(backups, '0.backup'), existed: false },
        { target, backup: join(backups, '1.backup'), existed: false },
      ],
    }));

    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(registry)).toBe(false);
  });

  it('R8 final review resumes a partially rolled-back new project with startup-injected authorization', () => {
    const workspace = join(root, 'workspace-partial-rollback');
    const target = projectMemoryFile(workspace);
    const registry = projectRegistryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'partial-project');
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [
        { target: registry, backup: join(backups, '0.backup'), existed: false },
        { target, backup: join(backups, '1.backup'), existed: false },
      ],
      projectFiles: [target],
    }));

    expect(recoverTruthBatch(dataDir, { projectFiles: [target] })).toEqual([]);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(registry)).toBe(false);
    expect(existsSync(join(dir, '.truth-batch-journal.json'))).toBe(false);
    expect(existsSync(backups)).toBe(false);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(false);
  });

  it('R8 final review keeps rollback backups when journal removal fails after truth restoration', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(backups, '0.backup');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'partial-new-truth');
    writeFileSync(backup, 'old-truth');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      files: [{ target, backup, existed: true }],
    }));
    const removePath = (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (path === journalPath) throw new Error('injected truth removal failure');
      rmSync(path, options);
    };

    expect(recoverTruthBatch(dataDir, { removePath }).join('\n')).toContain('恢复失败');
    expect(readFileSync(target, 'utf8')).toBe('old-truth');
    const saved = readdirSync(dir).find((name) => name.startsWith('.truth-backups.corrupt-'));
    expect(saved).toBeDefined();
    expect(readFileSync(join(dir, saved!, '0.backup'), 'utf8')).toBe('old-truth');
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
  });

  it('R8 final review does not roll back committed truth when post-commit backup cleanup fails', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    writeFileSync(target, 'old-truth');
    const removePath = (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (path === backups) throw new Error('injected post-commit cleanup failure');
      rmSync(path, options);
    };

    expect(() => commitTruthBatch(dataDir, new Map([[target, 'committed-new-truth']]), { removePath }))
      .toThrow('injected post-commit cleanup failure');

    expect(readFileSync(target, 'utf8')).toBe('committed-new-truth');
    expect(existsSync(join(dir, '.truth-batch-journal.json'))).toBe(false);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(false);
    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(existsSync(backups)).toBe(false);
  });

  it('R8 final review retries orphan backup cleanup without quarantining restored truth', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'already-restored-truth');
    writeFileSync(join(backups, '0.backup'), 'old-truth');
    const removePath = (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      if (path === backups) throw new Error('injected truth removal failure');
      rmSync(path, options);
    };

    expect(recoverTruthBatch(dataDir, { removePath }).join('\n')).toContain('备份清理失败');
    expect(readFileSync(target, 'utf8')).toBe('already-restored-truth');
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-backups.corrupt-'))).toBe(false);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(false);
    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(existsSync(backups)).toBe(false);
  });

  it('quarantines an unrecoverable journal without deleting partial truth when a backup is missing', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(backups, '0.backup');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'partial-new-truth');
    writeFileSync(backup, 'old-truth');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      files: [{ target, backup, existed: true }],
    }));
    renameSync(backup, `${backup}.missing`);

    const warnings = recoverTruthBatch(dataDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('备份缺失');
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith('user.json.truth-recovery-'))).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-batch-journal.json.corrupt-'))).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-backups.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
    expect(recoverTruthBatch(dataDir)[0]).toContain('写入阻断');
    expect(() => commitTruthBatch(dataDir, new Map([[userMemoryFile(dataDir), 'later-write']]))).toThrow('写入阻断');
    expect(existsSync(userMemoryFile(dataDir))).toBe(false);
  });

  it('rollback never recreates a missing project parent before path revalidation', () => {
    const workspace = join(root, 'missing-workspace');
    const target = projectMemoryFile(workspace);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const journalPath = join(dir, '.truth-batch-journal.json');
    mkdirSync(backups, { recursive: true });
    writeFileSync(projectRegistryFile(dataDir), JSON.stringify({
      version: 1,
      projects: [{ projectId: 'proj_missing_parent', workspacePath: workspace }],
    }));
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      files: [{ target, backup: join(backups, '0.backup'), existed: false }],
    }));

    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  it('does not write or quarantine outside a junctioned memory root during failed recovery', () => {
    const localMemory = memoryDir(dataDir);
    const outside = join(root, 'outside-memory');
    mkdirSync(outside, { recursive: true });
    rmSync(localMemory, { recursive: true });
    symlinkSync(outside, localMemory, process.platform === 'win32' ? 'junction' : 'dir');
    const journalPath = join(outside, '.truth-batch-journal.json');
    writeFileSync(journalPath, '{broken');

    const warnings = recoverTruthBatch(dataDir);

    expect(warnings.join('\n')).toContain('保持只读');
    expect(readFileSync(journalPath, 'utf8')).toBe('{broken');
    expect(existsSync(join(outside, '.truth-write-block.json'))).toBe(false);
    expect(readdirSync(outside)).toEqual(['.truth-batch-journal.json']);
    expect(recoverTruthBatch(dataDir).join('\n')).toContain('保持只读');
    expect(() => commitTruthBatch(dataDir, new Map([[userMemoryFile(dataDir), 'later']]))).toThrow('保持只读');
  });

  it('R8 final review rejects an empty uncommitted journal without deleting the only original backup', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const backup = join(backups, '0.backup');
    const journalPath = join(dir, '.truth-batch-journal.json');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'partial-new-truth');
    writeFileSync(backup, 'only-original-truth');
    writeFileSync(journalPath, JSON.stringify({ version: 1, files: [] }));

    expect(recoverTruthBatch(dataDir)[0]).toContain('日志损坏');
    expect(readFileSync(target, 'utf8')).toBe('partial-new-truth');
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-backups.corrupt-'))).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-batch-journal.json.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith('.truth-backups.corrupt-'))
      .some((name) => readFileSync(join(dir, name, '0.backup'), 'utf8') === 'only-original-truth')).toBe(true);
  });

  it('quarantines a malformed journal and reports a warning instead of blocking startup', () => {
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    writeFileSync(journalPath, '{broken');

    const warnings = recoverTruthBatch(dataDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('日志损坏');
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-batch-journal.json.corrupt-'))).toBe(true);
  });

  it('rejects journal paths outside memory truth and backup locations', () => {
    const victim = join(root, 'victim.txt');
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(victim, 'keep-me');
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target: victim, backup: join(backups, '0.backup'), existed: true }],
    }));

    expect(recoverTruthBatch(dataDir)[0]).toContain('日志损坏');
    expect(readFileSync(victim, 'utf8')).toBe('keep-me');
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
  });

  it('rejects a truthy non-boolean committed marker without deleting uncommitted truth', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    writeFileSync(target, 'NEW_UNCOMMITTED');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      committed: 'false',
      files: [{ target, backup: join(dir, '.truth-backups', '0.backup'), existed: false }],
    }));

    expect(recoverTruthBatch(dataDir)[0]).toContain('日志损坏');
    expect(readFileSync(target, 'utf8')).toBe('NEW_UNCOMMITTED');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('rejects a committed journal that still contains rollback file items', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    writeFileSync(target, 'KEEP');
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      committed: true,
      files: [{ target, backup: join(dir, '.truth-backups', '0.backup'), existed: true }],
    }));
    expect(recoverTruthBatch(dataDir)[0]).toContain('日志损坏');
    expect(readFileSync(target, 'utf8')).toBe('KEEP');
  });

  it('rejects an unregistered outside project truth target during commit and recovery', () => {
    const outside = join(root, 'outside', '.sparkii');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'memory.json');
    writeFileSync(victim, 'KEEP');
    expect(() => commitTruthBatch(dataDir, new Map([[victim, 'NEW']]))).toThrow('不是允许的记忆真相文件');
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');

    const backups = join(memoryDir(dataDir), '.truth-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(memoryDir(dataDir), '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target: victim, backup: join(backups, '0.backup'), existed: true }],
    }));
    expect(recoverTruthBatch(dataDir)[0]).toContain('日志损坏');
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
  });

  it('rejects a project truth target reached through a junction even when its workspace is registered', () => {
    const workspace = join(root, 'workspace-journal');
    const outside = join(root, 'outside-journal', '.sparkii');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'memory.json');
    writeFileSync(victim, 'KEEP');
    symlinkSync(outside, join(workspace, '.sparkii'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(projectRegistryFile(dataDir), JSON.stringify({
      version: 1,
      projects: [{ projectId: 'proj_journal', workspacePath: workspace }],
    }));

    expect(() => commitTruthBatch(dataDir, new Map([[projectMemoryFile(workspace), 'NEW']]))).toThrow('链接');
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
  });

  it('treats a dangling write-block junction as a persistent block', () => {
    const marker = join(memoryDir(dataDir), '.truth-write-block.json');
    symlinkSync(join(root, 'missing-marker-target'), marker, process.platform === 'win32' ? 'junction' : 'dir');
    expect(recoverTruthBatch(dataDir)[0]).toContain('写入阻断');
    expect(() => commitTruthBatch(dataDir, new Map([[userMemoryFile(dataDir), 'later']]))).toThrow('写入阻断');
    expect(existsSync(userMemoryFile(dataDir))).toBe(false);
  });

  it('keeps the only recovery evidence when the write-block marker cannot be persisted', () => {
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    const target = userMemoryFile(dataDir);
    writeFileSync(target, 'partial');
    writeFileSync(journalPath, '{broken');
    fault.failPath = join(dir, '.truth-write-block.json');

    expect(recoverTruthBatch(dataDir)[0]).toContain('无法持久化');
    expect(existsSync(journalPath)).toBe(true);
    fault.failPath = '';
    expect(recoverTruthBatch(dataDir)[0]).toContain('写入阻断');
    expect(() => commitTruthBatch(dataDir, new Map([[target, 'later']]))).toThrow('写入阻断');
    expect(readFileSync(target, 'utf8')).toBe('partial');
  });

  it('keeps a committed batch and removes its recovery journal', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backups = join(dir, '.truth-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'committed-new-truth');
    writeFileSync(journalPath, JSON.stringify({ version: 1, files: [], committed: true }));

    expect(recoverTruthBatch(dataDir)).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('committed-new-truth');
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  });

  it('rolls back the project registry when a later truth write fails', () => {
    const errors = new ErrorStore(join(dataDir, 'errors.db'));
    const service = new MemoryService({ dataDir, errors });
    try {
      const workspace = join(root, 'workspace');
      mkdirSync(workspace, { recursive: true });
      service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: '原有项目事实' });
      const registryBefore = readFileSync(projectRegistryFile(dataDir), 'utf8');
      const newWorkspace = join(root, 'new-workspace');
      mkdirSync(newWorkspace, { recursive: true });
      fault.failPath = projectRegistryFile(dataDir);

      expect(() => service.addMemoriesBatch([{
        scope: 'project', workspacePath: newWorkspace, workspaceKind: 'user', text: '不得残留的新事实',
      }])).toThrow('injected truth write failure');

      expect(existsSync(projectMemoryFile(newWorkspace))).toBe(false);
      expect(readFileSync(projectRegistryFile(dataDir), 'utf8')).toBe(registryBefore);
      expect(service.list().scopes.flatMap((scope) => scope.entries).some((entry) => entry.text === '不得残留的新事实')).toBe(false);
    } finally {
      service.close();
      errors.close();
    }
  });

  it('R8 truth round3 B1 rejects canonical duplicate change targets before journal creation', () => {
    const target = userMemoryFile(dataDir);
    const dir = memoryDir(dataDir);
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backups = join(dir, '.truth-backups');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(target, 'ORIGINAL_TRUTH_B1');
    const changes = new Map<string, string>([[target, 'FIRST_ALIAS_WRITE']]);
    changes.set(join(dir, 'agents', '..', 'user.json'), 'SECOND_ALIAS_WRITE');
    if (process.platform === 'win32') changes.set(join(dir, 'USER.JSON'), 'THIRD_CASE_ALIAS_WRITE');

    expect(() => commitTruthBatch(dataDir, changes)).toThrow(/重复目标/);
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL_TRUTH_B1');
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  });

  it('R8 truth round3 B1 merges canonical project aliases into one truth and index bucket', () => {
    const errors = new ErrorStore(join(dataDir, 'errors.db'));
    const service = new MemoryService({ dataDir, errors });
    try {
      const workspace = join(root, 'AliasWorkspace');
      mkdirSync(workspace, { recursive: true });
      const alias = process.platform === 'win32'
        ? join(root, 'aliasworkspace')
        : workspace;
      const result = service.addMemoriesBatch([
        { scope: 'project:proj_alias_bucket', workspacePath: workspace, workspaceKind: 'user', text: 'ALIAS_FIRST_71C' },
        { scope: 'project:proj_alias_bucket', workspacePath: alias, workspaceKind: 'user', text: 'ALIAS_SECOND_92D' },
      ]);
      const truth = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace));

      expect(result.ids).toHaveLength(2);
      expect(truth.entries.map((entry) => entry.id)).toEqual(result.ids);
      expect(truth.entries.map((entry) => entry.text)).toEqual(['ALIAS_FIRST_71C', 'ALIAS_SECOND_92D']);
      expect(service.searchMemory('ALIAS_FIRST_71C').map((hit) => hit.id)).toEqual([result.ids[0]]);
      expect(service.searchMemory('ALIAS_SECOND_92D').map((hit) => hit.id)).toEqual([result.ids[1]]);
      expect(readFileSync(projectRegistryFile(dataDir), 'utf8')).not.toContain('aliasworkspace');
    } finally {
      service.close();
      errors.close();
    }
  });

  it('R8 final review fences registered project reads and self-healing through an ancestor junction', () => {
    const errors = new ErrorStore(join(dataDir, 'errors.db'));
    const service = new MemoryService({ dataDir, errors });
    try {
      const workspace = join(root, 'junction-read-workspace');
      const outside = join(root, 'outside-truth');
      mkdirSync(join(workspace, '.sparkii'), { recursive: true });
      mkdirSync(outside, { recursive: true });
      service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: 'SAFE_REGISTERED_71C' });
      const target = projectMemoryFile(workspace);
      const original = readFileSync(target, 'utf8');
      renameSync(join(workspace, '.sparkii'), join(workspace, '.sparkii-held'));
      writeFileSync(join(outside, 'memory.json'), original.replace('SAFE_REGISTERED_71C', 'OUTSIDE_SECRET_92D'));
      symlinkSync(outside, join(workspace, '.sparkii'), process.platform === 'win32' ? 'junction' : 'dir');
      const registryBefore = readFileSync(projectRegistryFile(dataDir), 'utf8');

      expect(service.ensureProject(workspace, 'user')).toBeNull();
      expect(readFileSync(projectRegistryFile(dataDir), 'utf8')).toBe(registryBefore);
      expect(JSON.stringify(service.list())).not.toContain('OUTSIDE_SECRET_92D');
      expect(service.searchMemory('OUTSIDE_SECRET_92D')).toEqual([]);
      expect(service.rebuildIndex().corrupt).toContain(target);
    } finally {
      service.close();
      errors.close();
    }
  });

  it('R8 final review rejects unregistered duplicate project identity before single or batch commits', () => {
    const errors = new ErrorStore(join(dataDir, 'errors.db'));
    const service = new MemoryService({ dataDir, errors });
    try {
      const existing = service.addMemory({ scope: 'user', text: 'USER_ID_SOURCE_71C' });
      const workspace = join(root, 'unregistered-duplicate');
      const file = projectMemoryFile(workspace);
      mkdirSync(join(workspace, '.sparkii'), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, projectId: 'proj_duplicate', entries: [{
        id: existing.id, text: 'DUPLICATE_PROJECT_92D', status: 'active', pinned: false,
        importance: 2, createdAt: 1, updatedAt: 1, source: null, supersededBy: null, pendingOp: null,
      }] }));
      const before = readFileSync(file, 'utf8');

      expect(() => service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: 'MUST_NOT_COMMIT_71C' }))
        .toThrow(/记忆 id 跨文件重复/);
      expect(() => service.addMemoriesBatch([{ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: 'MUST_NOT_COMMIT_92D' }]))
        .toThrow(/记忆 id 跨文件重复/);
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(existsSync(projectRegistryFile(dataDir))).toBe(false);
      expect(service.searchMemory('MUST_NOT_COMMIT_71C')).toEqual([]);
      expect(service.searchMemory('MUST_NOT_COMMIT_92D')).toEqual([]);
    } finally {
      service.close();
      errors.close();
    }
  });

  it('R8 review truth B1 does not authorize auto-workspace truth from session discovery alone', () => {
    const workspace = join(root, 'auto-workspace-unregistered');
    const victim = projectMemoryFile(workspace);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(victim, 'AUTO_TRUTH_MUST_SURVIVE_71C');
    writeFileSync(join(backups, '0.backup'), 'ATTACKER_TRUTH_92D');
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target: victim, backup: join(backups, '0.backup'), existed: true }],
    }));
    const errors = new ErrorStore(join(dataDir, 'errors.db'));
    try {
      expect(() => new MemoryService({
        dataDir,
        errors,
        workspacePathsOf: () => [workspace],
      })).toThrow(/journal 目标不是允许的记忆真相文件/);
      expect(readFileSync(victim, 'utf8')).toBe('AUTO_TRUTH_MUST_SURVIVE_71C');
      const store = new MemoryStore({ dataDir });
      try {
        expect(() => store.search('ATTACKER_TRUTH_92D')).toThrow(/写入阻断|恢复/);
      } finally {
        store.close();
      }
    } finally {
      errors.close();
    }
  }, 20_000);

  it.each(['agents', 'episode-proposals'])('R8 review truth B2 rejects nested %s journal targets', (directory) => {
    const target = join(memoryDir(dataDir), directory, 'nested', 'victim.json');
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(join(dir, directory, 'nested'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'NESTED_TRUTH_MUST_SURVIVE_71C');
    writeFileSync(join(backups, '0.backup'), 'ATTACKER_TRUTH_92D');
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target, backup: join(backups, '0.backup'), existed: true }],
    }));

    expect(recoverTruthBatch(dataDir).join('\n')).toContain('不是允许的记忆真相文件');
    expect(readFileSync(target, 'utf8')).toBe('NESTED_TRUTH_MUST_SURVIVE_71C');
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('R8 review truth B3 rechecks attributes when a verified path becomes a reparse point', () => {
    const victim = join(dataDir, 'verified-directory');
    mkdirSync(victim);
    const safeAttributes = (paths: string[]) => paths.map(() => 0);
    (assertTruthPathSafe as any)(victim, safeAttributes);
    const convertedAttributes = (paths: string[]) => paths.map((path) => path === victim ? 16 : 0);
    expect(() => (assertTruthPathSafe as any)(victim, convertedAttributes)).toThrow(/重解析点/);
  });

  it('R8 truth round3 B2 ignores journal projectFiles as recovery authorization', () => {
    const workspace = join(root, 'untrusted-journal-workspace');
    const victim = projectMemoryFile(workspace);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const journalPath = join(dir, '.truth-batch-journal.json');
    const backup = join(backups, '0.backup');
    mkdirSync(join(workspace, '.sparkii'), { recursive: true });
    mkdirSync(backups, { recursive: true });
    writeFileSync(victim, 'EXTERNAL_TRUTH_MUST_SURVIVE_B2');
    writeFileSync(backup, 'ATTACKER_CONTROLLED_BACKUP');
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      files: [{ target: victim, backup, existed: true }],
      projectFiles: [victim],
    }));

    const warnings = recoverTruthBatch(dataDir);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('不是允许的记忆真相文件');
    expect(readFileSync(victim, 'utf8')).toBe('EXTERNAL_TRUTH_MUST_SURVIVE_B2');
    expect(readdirSync(dir).some((name) => name.startsWith('.truth-batch-journal.json.corrupt-'))).toBe(true);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
  });
});

function memoryText(id: string, text: string): string {
  return `${JSON.stringify({
    version: 1,
    entries: [{
      id, text, status: 'active', pinned: false, importance: 2,
      createdAt: 1, updatedAt: 1, source: null,
    }],
  }, null, 2)}\n`;
}

function externalSqlite(path: string): Buffer {
  const db = new Database(path);
  db.exec("CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel(value) VALUES ('EXTERNAL_SQLITE_SENTINEL')");
  db.close();
  return readFileSync(path);
}

function expectExternalSqlite(path: string, original: Buffer): void {
  expect(readFileSync(path)).toEqual(original);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    expect(db.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'EXTERNAL_SQLITE_SENTINEL' });
  } finally {
    db.close();
  }
}

describe('R8 truth round3 index snapshots', () => {
  it.each(['rebuild', 'reconcile', 'replaceScopeIndex'] as const)(
    'R8 truth round3 B3 %s fails closed when truth changes before index commit and then indexes one snapshot',
    (operation) => {
      const target = userMemoryFile(dataDir);
      const oldText = memoryText('mem_b3_snapshot', 'OLDALPHA91A');
      const newText = memoryText('mem_b3_snapshot', 'NEWBRAVO82B_LONGER');
      let armed = false;
      let reads = 0;
      let edited = false;
      const store = new MemoryStore({
        dataDir,
        readTruthFile: (path: string) => {
          const text = readFileSync(path, 'utf8');
          if (armed && path === target) {
            reads += 1;
            const editAt = operation === 'replaceScopeIndex' ? 1 : 2;
            if (reads === editAt && !edited) {
              edited = true;
              writeFileSync(target, newText);
            }
          }
          return text;
        },
      });
      try {
        writeFileSync(target, oldText);
        store.rebuild();
        const oldHash = createHash('sha256').update(oldText).digest('hex');
        expect(store.db.prepare('SELECT text FROM memories WHERE id = ?').get('mem_b3_snapshot')).toEqual({ text: 'OLDALPHA91A' });
        expect(store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(target)).toEqual({ content_hash: oldHash });

        armed = true;
        if (operation === 'reconcile') writeFileSync(target, memoryText('mem_b3_snapshot', 'TRIGGER_SNAPSHOT_TEXT_B3'));
        expect(() => {
          if (operation === 'rebuild') store.rebuild();
          else if (operation === 'reconcile') store.reconcileAll();
          else store.replaceScopeIndex({ scope: 'user', file: target }, parseMemoryFile(oldText, target).entries);
        }).toThrow(/索引提交前变化|身份已变化/);
        expect(store.db.prepare('SELECT text FROM memories WHERE id = ?').get('mem_b3_snapshot')).toEqual({ text: 'OLDALPHA91A' });
        expect(store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(target)).toEqual({ content_hash: oldHash });

        armed = false;
        store.reconcileAll();
        const currentText = readFileSync(target, 'utf8');
        const currentHash = createHash('sha256').update(currentText).digest('hex');
        expect(store.db.prepare('SELECT text FROM memories WHERE id = ?').get('mem_b3_snapshot')).toEqual({ text: 'NEWBRAVO82B_LONGER' });
        expect(store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(target)).toEqual({ content_hash: currentHash });
        expect(store.search('NEWBRAVO82B_LONGER').map((hit) => hit.text)).toContain('NEWBRAVO82B_LONGER');
        expect(store.search('OLDALPHA91A')).toEqual([]);
        if (store.ftsAvailable) {
          expect(store.db.prepare('SELECT text FROM memories_fts WHERE memories_fts MATCH ?').all('NEWBRAVO82B_LONGER'))
            .toEqual([{ text: 'NEWBRAVO82B_LONGER' }]);
        }
      } finally {
        store.close();
      }
    },
  );
});

describe('R8 truth round3 SQLite path fences', () => {
  it('R8 truth round3 B5 rejects a hard-linked main database without changing external SQLite', () => {
    const external = join(root, 'external-main.db');
    const original = externalSqlite(external);
    const path = memoryDbPath(dataDir);
    linkSync(external, path);
    let store: MemoryStore | undefined;
    try {
      expect(() => { store = new MemoryStore({ dataDir }); }).toThrow(/硬链接/);
      expectExternalSqlite(external, original);
      expect(existsSync(path)).toBe(true);
    } finally {
      store?.close();
    }
  });

  it.each(['-wal', '-shm', '-journal'])('R8 truth round3 B5 rejects a hard-linked %s sidecar before SQLite opens', (suffix) => {
    const initial = new MemoryStore({ dataDir });
    initial.close();
    const path = memoryDbPath(dataDir);
    const sidecar = `${path}${suffix}`;
    rmSync(sidecar, { force: true });
    const external = join(root, `external${suffix}.db`);
    const original = externalSqlite(external);
    linkSync(external, sidecar);
    let store: MemoryStore | undefined;
    try {
      expect(() => { store = new MemoryStore({ dataDir }); }).toThrow(/硬链接/);
      expectExternalSqlite(external, original);
      expect(existsSync(sidecar)).toBe(true);
    } finally {
      store?.close();
    }
  });

  it('R8 truth round3 B5 refuses corrupt-database isolation and fallback while a sidecar is hard-linked', () => {
    const path = memoryDbPath(dataDir);
    const sidecar = `${path}-wal`;
    const external = join(root, 'external-fallback.db');
    const original = externalSqlite(external);
    writeFileSync(path, 'CORRUPT_SQLITE_B5');
    linkSync(external, sidecar);
    let store: MemoryStore | undefined;
    try {
      expect(() => { store = new MemoryStore({ dataDir }); }).toThrow(/硬链接/);
      expect(readFileSync(path, 'utf8')).toBe('CORRUPT_SQLITE_B5');
      expect(readdirSync(dataDir).some((name) => name.startsWith('memory.db.corrupt-'))).toBe(false);
      expect(existsSync(sidecar)).toBe(true);
      expectExternalSqlite(external, original);
    } finally {
      store?.close();
    }
  });

  it('R8 truth round3 B5 rejects a main-database symlink and stays fail closed on Windows symlink EPERM', () => {
    const external = join(root, 'external-symlink.db');
    const original = externalSqlite(external);
    const linkedDataDir = join(root, 'linked-data');
    mkdirSync(linkedDataDir, { recursive: true });
    const path = memoryDbPath(linkedDataDir);
    let linked = false;
    try {
      symlinkSync(external, path, 'file');
      linked = true;
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    let store: MemoryStore | undefined;
    try {
      if (linked) {
        expect(() => { store = new MemoryStore({ dataDir: linkedDataDir }); }).toThrow(/链接|重解析/);
      } else {
        const outsideDataDir = join(root, 'outside-linked-data');
        mkdirSync(outsideDataDir, { recursive: true });
        copyFileSync(external, memoryDbPath(outsideDataDir));
        const outsideOriginal = readFileSync(memoryDbPath(outsideDataDir));
        const junctionDataDir = join(root, 'junction-data');
        symlinkSync(outsideDataDir, junctionDataDir, 'junction');
        expect(() => { store = new MemoryStore({ dataDir: junctionDataDir }); }).toThrow(/链接|重解析/);
        expect(readFileSync(memoryDbPath(outsideDataDir))).toEqual(outsideOriginal);
      }
      expectExternalSqlite(external, original);
    } finally {
      store?.close();
    }
  });
});

describe('R8 final-round5 B1 fresh-probe production boundaries', () => {
  it.runIf(process.platform === 'win32')('rejects a target converted to an external hardlink after the pre-backup probe', () => {
    const target = userMemoryFile(dataDir);
    const external = join(root, 'external-backup-victim.txt');
    const backups = join(memoryDir(dataDir), '.truth-backups');
    const externalBytes = 'EXTERNAL_BACKUP_VICTIM_71C';
    writeFileSync(target, 'ORIGINAL_TRUTH_71C');
    writeFileSync(external, externalBytes);
    let converted = false;
    nativeProbeHarness.afterAttributes = (paths) => {
      if (!converted && existsSync(backups) && paths.includes(target)) {
        converted = true;
        rmSync(target, { force: true });
        linkSync(external, target);
      }
    };

    expect(() => commitTruthBatch(dataDir, new Map([[target, 'NEW_TRUTH_92D']]))).toThrow(/硬链接|重解析/);
    expect(converted).toBe(true);
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    expect(existsSync(join(backups, '0.backup'))).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(externalBytes);
  });

  it.runIf(process.platform === 'win32')('rechecks restore identity after the rollback preflight and never overwrites an external hardlink', () => {
    const target = userMemoryFile(dataDir);
    const external = join(root, 'external-restore-victim.txt');
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    const backup = join(backups, '0.backup');
    const journal = join(dir, '.truth-batch-journal.json');
    const externalBytes = 'EXTERNAL_RESTORE_VICTIM_71C';
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'PARTIAL_TRUTH_92D');
    writeFileSync(backup, 'ORIGINAL_TRUTH_71C');
    writeFileSync(external, externalBytes);
    writeFileSync(journal, JSON.stringify({
      version: 1,
      files: [{ target, backup, existed: true }],
    }));
    let targetProbes = 0;
    nativeProbeHarness.afterAttributes = (paths) => {
      if (!paths.includes(target)) return;
      targetProbes += 1;
      if (targetProbes === 3) {
        rmSync(target, { force: true });
        linkSync(external, target);
      }
    };

    expect(recoverTruthBatch(dataDir).join('\n')).toContain('恢复失败');
    expect(targetProbes).toBeGreaterThanOrEqual(3);
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    expect(readFileSync(target, 'utf8')).toBe(externalBytes);
    expect(existsSync(join(dir, '.truth-write-block.json'))).toBe(true);
  });

  it.each(['reconcile', 'rebuild'] as const)('fails closed when %s observes a reparse conversion after its first safe per-file probe', (operation) => {
    const target = userMemoryFile(dataDir);
    const id = 'mem_fresh_probe_snapshot';
    writeFileSync(target, memoryText(id, 'LOCAL_SNAPSHOT_71C'));
    const store = new MemoryStore({
      dataDir,
      readTruthFile: (path) => {
        const text = readFileSync(path, 'utf8');
        if (path === target) nativeProbeHarness.reparseTarget = target;
        return text;
      },
    });
    try {
      nativeProbeHarness.reparseTarget = '';
      store.rebuild();
      if (operation === 'reconcile') {
        expect(() => store.reconcileAll()).not.toThrow();
        expect(store.db.prepare('SELECT id FROM memories WHERE id = ?').get(id)).toBeUndefined();
      } else {
        expect(store.rebuild()).toMatchObject({ corrupt: [target] });
        expect(store.db.prepare('SELECT id FROM memories WHERE id = ?').get(id)).toBeUndefined();
      }
      expect(JSON.stringify(store.db.prepare('SELECT text FROM memories').all())).not.toContain('EXTERNAL_SNAPSHOT');
    } finally {
      nativeProbeHarness.reparseTarget = '';
      store.close();
    }
  });

  it('viewOf freshly fences the row path and never returns external hardlink content', () => {
    const target = userMemoryFile(dataDir);
    const id = 'mem_fresh_view';
    writeFileSync(target, memoryText(id, 'LOCAL_VIEW_71C'));
    const store = new MemoryStore({ dataDir });
    try {
      store.rebuild();
      const row = store.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
      const external = join(root, 'external-view.json');
      writeFileSync(external, memoryText(id, 'EXTERNAL_VIEW_SECRET_92D'));
      rmSync(target, { force: true });
      linkSync(external, target);

      expect(() => store.viewOf(row, () => true)).toThrow(/硬链接|重解析|普通文件/);
      expect(readFileSync(external, 'utf8')).toContain('EXTERNAL_VIEW_SECRET_92D');
    } finally {
      store.close();
    }
  });

  it.each(['markSourcesDeleted', 'deleteMemoryEntriesBySession'] as const)('re-probes the second %s read after allScopeFiles', (operation) => {
    const target = userMemoryFile(dataDir);
    const id = 'mem_fresh_delete';
    writeFileSync(target, memoryText(id, 'LOCAL_DELETE_71C'));
    let injected = false;
    const store = new MemoryStore({
      dataDir,
      readTruthFile: (path) => {
        const text = readFileSync(path, 'utf8');
        if (!injected && path === target) {
          injected = true;
          nativeProbeHarness.reparseTarget = target;
        }
        return text;
      },
    });
    try {
      store.rebuild();
      nativeProbeHarness.reparseTarget = '';
      injected = false;
      expect(() => {
        if (operation === 'markSourcesDeleted') store.markSourcesDeleted('absent-session');
        else store.deleteMemoryEntriesBySession('absent-session');
      }).toThrow(/重解析|损坏/);
      expect(injected).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe(memoryText(id, 'LOCAL_DELETE_71C'));
    } finally {
      nativeProbeHarness.reparseTarget = '';
      store.close();
    }
  });
});
