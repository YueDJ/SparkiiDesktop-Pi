import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  atomicWrite,
  episodesFile,
  episodeProposalsDir,
  extractionStateFile,
  memoryDir,
  parseProjectRegistry,
  projectMemoryFile,
  projectRegistryFile,
  userMemoryFile,
} from './settings.js';
import {
  assertNoReparseOrHardlinks,
  assertTruthPathSafe,
  copyTruthFileVerified,
  flushPathInspection,
  inspectTruthFile,
  inspectTruthFiles,
  inspectTruthFileTwice,
  pathProbeContext,
  queuePathInspection,
  readTruthFileVerified,
  readTruthFileVerifiedResult,
  removeTruthPathVerified,
  removeTruthPathsVerified,
  renameTruthPathVerified,
  TruthPathSafetyError,
  type PathProbeContext,
  type TruthAttributeProbe,
} from './truth-path.js';
export { assertNoReparseOrHardlinks, assertTruthPathSafe, TruthPathSafetyError } from './truth-path.js';

interface JournalFile {
  target: string;
  backup: string;
  existed: boolean;
}

interface TruthBatchJournal {
  version: 1;
  files: JournalFile[];
  committed?: boolean;
}

export interface TruthBatchOptions {
  projectFiles?: string[];
  probeAttributes?: TruthAttributeProbe;
  onJournalWritten?: () => void;
  onCommittedJournalWritten?: () => void;
  onAtomicWriteRenamed?: (path: string) => void;
  removePath?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

const blockedDataDirs = new Map<string, string[]>();

function paths(dataDir: string) {
  const dir = memoryDir(dataDir);
  return {
    journal: join(dir, '.truth-batch-journal.json'),
    backups: join(dir, '.truth-backups'),
    writeBlock: join(dir, '.truth-write-block.json'),
  };
}

function dataDirKey(dataDir: string): string {
  return resolve(dataDir).toLowerCase();
}

export function truthPathKey(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function entryExists(path: string, probeAttributes?: TruthAttributeProbe): boolean {
  return inspectTruthFile(path, probeAttributes, { allowMissing: true }) !== undefined;
}

function markRegularFileVerified(path: string, probeAttributes?: TruthAttributeProbe): void {
  const current = probeAttributes ? inspectTruthFileTwice(path, probeAttributes) : inspectTruthFileTwice(path);
  if (!current?.stats.isFile()) {
    throw new Error(`记忆真相路径不是稳定的普通单链接文件：${path}`);
  }
}

function canonicalSafe(path: string, context: PathProbeContext): string {
  queuePathInspection(path, context);
  let current = path;
  const missing: string[] = [];
  while (true) {
    try {
      const nearest = realpathSync(current);
      return resolve(nearest, ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function registryFromChanges(
  dataDir: string,
  changes?: Map<string, string>,
  probeAttributes?: TruthAttributeProbe,
) {
  const path = projectRegistryFile(dataDir);
  const staged = changes?.get(path);
  if (staged !== undefined) return parseProjectRegistry(staged, path);
  const current = readTruthFileVerifiedResult(path, { allowMissing: true, probeAttributes });
  if (!current) return { version: 1 as const, projects: [] };
  return parseProjectRegistry(current.content.toString('utf8'), path);
}

interface TargetAuthorization {
  explicitProjects?: Set<string>;
  registryProjects?: Set<string>;
}

function authorizeProjectTarget(
  dataDir: string,
  canonical: string,
  options: TruthBatchOptions,
  context: PathProbeContext,
  authorization: TargetAuthorization,
  changes?: Map<string, string>,
): boolean {
  const key = truthPathKey(canonical);
  authorization.explicitProjects ??= new Set((options.projectFiles ?? [])
    .map((file) => truthPathKey(canonicalSafe(file, context))));
  if (authorization.explicitProjects.has(key)) return true;
  if (!authorization.registryProjects) {
    const files = registryFromChanges(dataDir, changes, options.probeAttributes).projects
      .map((project) => projectMemoryFile(project.workspacePath));
    authorization.registryProjects = new Set(files
      .map((file) => truthPathKey(canonicalSafe(file, context))));
  }
  return authorization.registryProjects.has(key);
}

function validateTarget(
  dataDir: string,
  target: string,
  options: TruthBatchOptions,
  context: PathProbeContext,
  authorization: TargetAuthorization,
  changes?: Map<string, string>,
): string {
  const canonical = canonicalSafe(target, context);
  const dir = memoryDir(dataDir);
  const exact = new Set([
    userMemoryFile(dataDir),
    projectRegistryFile(dataDir),
    episodesFile(dataDir),
    extractionStateFile(dataDir),
  ].map((file) => truthPathKey(canonicalSafe(file, context))));
  if (exact.has(truthPathKey(canonical))) return canonical;
  const agents = canonicalSafe(join(dir, 'agents'), context);
  if (truthPathKey(dirname(canonical)) === truthPathKey(agents) && basename(canonical).endsWith('.json')) return canonical;
  const proposals = canonicalSafe(episodeProposalsDir(dataDir), context);
  if (truthPathKey(dirname(canonical)) === truthPathKey(proposals) && basename(canonical).endsWith('.json')) return canonical;
  if (basename(canonical) === 'memory.json' && basename(dirname(canonical)) === '.sparkii'
    && authorizeProjectTarget(dataDir, canonical, options, context, authorization, changes)) {
    return canonical;
  }
  throw new Error('journal 目标不是允许的记忆真相文件');
}

function validateJournal(
  dataDir: string,
  journal: TruthBatchJournal,
  options: TruthBatchOptions,
  context: PathProbeContext,
): void {
  const backups = canonicalSafe(paths(dataDir).backups, context);
  const targets = new Set<string>();
  const backupPaths = new Set<string>();
  const authorization: TargetAuthorization = {};
  for (const file of journal.files) {
    const target = validateTarget(dataDir, file.target, options, context, authorization);
    if (targets.has(truthPathKey(target))) throw new Error('journal 包含重复目标');
    targets.add(truthPathKey(target));
    const backup = canonicalSafe(file.backup, context);
    if (!inside(backups, backup)) throw new Error('journal 备份路径非法');
    if (backupPaths.has(truthPathKey(backup))) throw new Error('journal 包含重复备份');
    backupPaths.add(truthPathKey(backup));
  }
  flushPathInspection(context);
}

function parseJournal(text: string): TruthBatchJournal {
  const value = JSON.parse(text) as Partial<TruthBatchJournal>;
  if (value.version !== 1 || !Array.isArray(value.files)) throw new Error('journal 结构非法');
  if (value.committed !== undefined && typeof value.committed !== 'boolean') throw new Error('journal committed 字段非法');
  if (value.committed === true && value.files.length) throw new Error('已提交 journal 不得保留文件项');
  if (value.committed !== true && value.files.length === 0) throw new Error('未提交 journal 不得为空');
  for (const file of value.files) {
    if (!file || typeof file.target !== 'string' || typeof file.backup !== 'string' || typeof file.existed !== 'boolean') {
      throw new Error('journal 文件项非法');
    }
  }
  return value as TruthBatchJournal;
}

function restore(journal: TruthBatchJournal, options: TruthBatchOptions): void {
  for (const file of [...journal.files].reverse()) {
    if (file.existed) copyTruthFileVerified(file.backup, file.target, { probeAttributes: options.probeAttributes });
    else removeTruthPathVerified(file.target, { removePath: options.removePath, probeAttributes: options.probeAttributes });
  }
}

function quarantine(path: string, label: string, probeAttributes?: TruthAttributeProbe): string | null {
  if (!entryExists(path, probeAttributes)) return null;
  const target = `${path}.${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  renameTruthPathVerified(path, target, { probeAttributes });
  return target;
}

function blockWrites(dataDir: string, warnings: string[], probeAttributes?: TruthAttributeProbe): boolean {
  try {
    assertNoReparseOrHardlinks([memoryDir(dataDir), paths(dataDir).writeBlock], probeAttributes);
    atomicWrite(paths(dataDir).writeBlock, JSON.stringify({ warnings }, null, 2), probeAttributes);
    blockedDataDirs.set(dataDirKey(dataDir), [...warnings]);
    return true;
  } catch {
    warnings.push('无法持久化记忆写入阻断标记；修复前不要继续写入');
    blockedDataDirs.set(dataDirKey(dataDir), [...warnings]);
    return false;
  }
}

function writeBlockWarnings(dataDir: string, probeAttributes?: TruthAttributeProbe): string[] {
  const memoryWarnings = blockedDataDirs.get(dataDirKey(dataDir));
  if (memoryWarnings) {
    return [`记忆真相批次仍处于写入阻断状态：${memoryWarnings.join('；')}`];
  }
  const path = paths(dataDir).writeBlock;
  try {
    if (!entryExists(path, probeAttributes)) return [];
    const parsed = JSON.parse(readTruthFileVerified(path, { probeAttributes }).toString('utf8')) as { warnings?: unknown };
    if (Array.isArray(parsed.warnings) && parsed.warnings.every((warning) => typeof warning === 'string')) {
      return [`记忆真相批次仍处于写入阻断状态：${parsed.warnings.join('；')}`];
    }
  } catch {
    return ['记忆真相批次写入阻断标记损坏；修复前不要继续写入'];
  }
  return ['记忆真相批次写入阻断标记非法；修复前不要继续写入'];
}

function cleanup(
  journalPath: string,
  backups: string,
  options: TruthBatchOptions,
): void {
  removeTruthPathsVerified([journalPath, backups], {
    removePath: options.removePath,
    recursive: true,
    probeAttributes: options.probeAttributes,
  });
}

function unrecoverable(
  dataDir: string,
  journalPath: string,
  backups: string,
  warnings: string[],
  probeAttributes?: TruthAttributeProbe,
): string[] {
  try {
    assertNoReparseOrHardlinks([memoryDir(dataDir), journalPath, backups, paths(dataDir).writeBlock], probeAttributes);
  } catch (error) {
    warnings.push(`记忆真相根路径不安全，保持只读：${error instanceof Error ? error.message : String(error)}`);
    blockedDataDirs.set(dataDirKey(dataDir), [...warnings]);
    return writeBlockWarnings(dataDir, probeAttributes);
  }
  if (blockWrites(dataDir, warnings, probeAttributes)) {
    try {
      const savedJournal = quarantine(journalPath, 'corrupt', probeAttributes);
      const savedBackups = quarantine(backups, 'corrupt', probeAttributes);
      warnings.push(`已隔离 ${savedJournal ?? journalPath} / ${savedBackups ?? backups}`);
    } catch (error) {
      warnings.push(`记忆批次证据隔离失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return writeBlockWarnings(dataDir, probeAttributes);
}

export function assertTruthRootSafe(dataDir: string, probeAttributes?: TruthAttributeProbe): void {
  assertTruthPathSafe(memoryDir(dataDir), probeAttributes);
}

export function assertTruthAvailable(dataDir: string, probeAttributes?: TruthAttributeProbe): void {
  const warnings = writeBlockWarnings(dataDir, probeAttributes);
  if (warnings.length) throw new Error(warnings.join('；'));
}

export function recoverTruthBatch(dataDir: string, options: TruthBatchOptions = {}): string[] {
  const { journal: journalPath, backups } = paths(dataDir);
  let writeBlock: ReturnType<typeof inspectTruthFile>;
  let journalEntry: ReturnType<typeof inspectTruthFile>;
  let backupEntry: ReturnType<typeof inspectTruthFile>;
  try {
    // Recovery's clean-state check is one logical boundary. Probe the root and
    // all recovery artifacts together; actual journal content still gets its
    // own verified-read boundary below.
    [, writeBlock, journalEntry, backupEntry] = inspectTruthFiles([
      { path: memoryDir(dataDir), options: { allowMissing: true } },
      { path: paths(dataDir).writeBlock, options: { allowMissing: true } },
      { path: journalPath, options: { allowMissing: true } },
      { path: backups, options: { allowMissing: true } },
    ], options.probeAttributes);
  } catch (error) {
    return unrecoverable(dataDir, journalPath, backups, [
      `记忆真相根路径不安全，保持只读：${error instanceof Error ? error.message : String(error)}`,
    ], options.probeAttributes);
  }
  if (writeBlock) return writeBlockWarnings(dataDir, options.probeAttributes);
  if (!journalEntry) {
    if (backupEntry) {
      try {
        cleanup(journalPath, backups, options);
      } catch (error) {
        return [`记忆批次备份清理失败，保留证据等待重试：${error instanceof Error ? error.message : String(error)}`];
      }
    }
    return [];
  }
  let journal: TruthBatchJournal;
  const context = pathProbeContext(options.probeAttributes);
  try {
    journal = parseJournal(readTruthFileVerified(journalPath, { probeAttributes: options.probeAttributes }).toString('utf8'));
    validateJournal(dataDir, journal, options, context);
  } catch (error) {
    return unrecoverable(dataDir, journalPath, backups, [
      `记忆批次日志损坏：${error instanceof Error ? error.message : String(error)}`,
    ], options.probeAttributes);
  }
  if (journal.committed === true) {
    cleanup(journalPath, backups, options);
    return [];
  }
  const missing = journal.files.filter((file) => file.existed && !entryExists(file.backup, options.probeAttributes));
  if (missing.length) {
    for (const file of [...journal.files].reverse()) {
      try {
        if (file.existed && entryExists(file.backup, options.probeAttributes)) {
          copyTruthFileVerified(file.backup, file.target, { probeAttributes: options.probeAttributes });
        } else if (!file.existed) {
          removeTruthPathVerified(file.target, { removePath: options.removePath, probeAttributes: options.probeAttributes });
        } else if (entryExists(file.target, options.probeAttributes)) {
          quarantine(file.target, 'truth-recovery', options.probeAttributes);
        }
      } catch {
        // Keep the original journal and backups when any rollback is uncertain.
      }
    }
    return unrecoverable(dataDir, journalPath, backups, [
      `记忆批次恢复失败，备份缺失：${missing.map((file) => file.backup).join('、')}`,
    ], options.probeAttributes);
  }
  try {
    restore(journal, options);
    cleanup(journalPath, backups, options);
    return [];
  } catch (error) {
    return unrecoverable(dataDir, journalPath, backups, [
      `记忆批次恢复失败：${error instanceof Error ? error.message : String(error)}`,
    ], options.probeAttributes);
  }
}

export function commitTruthBatch(
  dataDir: string,
  changes: Map<string, string>,
  options: TruthBatchOptions = {},
): Map<string, string> {
  const recoveryWarnings = recoverTruthBatch(dataDir, options);
  if (recoveryWarnings.length) throw new Error(recoveryWarnings.join('；'));
  const context: PathProbeContext = pathProbeContext(options.probeAttributes);
  const targets = new Set<string>();
  const authorization: TargetAuthorization = {};
  for (const target of changes.keys()) {
    const canonical = validateTarget(dataDir, target, options, context, authorization, changes);
    const key = truthPathKey(canonical);
    if (targets.has(key)) throw new Error(`truth 批次包含重复目标：${target}`);
    targets.add(key);
  }
  flushPathInspection(context);
  const pending = [...changes]
    .map(([file, content]) => {
      const current = readTruthFileVerifiedResult(file, { allowMissing: true, probeAttributes: options.probeAttributes });
      return { file, content, previousContent: current?.content, previousIdentity: current?.identity };
    })
    .filter(({ content, previousContent }) => !previousContent || !previousContent.equals(Buffer.from(content, 'utf8')))
    .sort((left, right) => Number(truthPathKey(right.file) === truthPathKey(projectRegistryFile(dataDir)))
      - Number(truthPathKey(left.file) === truthPathKey(projectRegistryFile(dataDir))));
  if (!pending.length) return new Map();
  const { journal: journalPath, backups } = paths(dataDir);
  assertNoReparseOrHardlinks([memoryDir(dataDir), journalPath, backups], options.probeAttributes);
  mkdirSync(backups, { recursive: true });
  const backupInfo = inspectTruthFile(backups, options.probeAttributes);
  if (!backupInfo?.stats.isDirectory()) throw new Error('记忆批次备份目录不是普通目录');
  const files: JournalFile[] = pending.map(({ file, previousContent, previousIdentity }, index) => {
    const existed = previousIdentity !== undefined;
    const backup = join(backups, `${index}.backup`);
    if (existed) copyTruthFileVerified(file, backup, {
      probeAttributes: options.probeAttributes,
      expectedSourceIdentity: previousIdentity,
      expectedSourceContent: previousContent,
    });
    return { target: file, backup, existed };
  });
  const journal: TruthBatchJournal = {
    version: 1,
    files,
  };
  try {
    atomicWrite(journalPath, JSON.stringify(journal), options.probeAttributes);
    options.onJournalWritten?.();
    markRegularFileVerified(journalPath, options.probeAttributes);
  } catch (error) {
    try {
      removeTruthPathVerified(journalPath, { removePath: options.removePath, probeAttributes: options.probeAttributes });
    } catch {
      throw error;
    }
    try { removeTruthPathVerified(backups, { removePath: options.removePath, recursive: true, probeAttributes: options.probeAttributes }); } catch { /* recovery removes orphan backups */ }
    throw error;
  }
  let committed = false;
  let commitWriteReturned = false;
  const writtenIdentities = new Map<string, string>();
  try {
    for (const { file: target } of pending) canonicalSafe(target, context);
    flushPathInspection(context);
    for (const { file: target, content } of pending) {
      writtenIdentities.set(target, atomicWrite(target, content, options.probeAttributes));
    }
    atomicWrite(journalPath, JSON.stringify({ version: 1, files: [], committed: true }), options.probeAttributes,
      () => {
        committed = true;
        options.onAtomicWriteRenamed?.(journalPath);
      });
    commitWriteReturned = true;
    options.onCommittedJournalWritten?.();
    markRegularFileVerified(journalPath, options.probeAttributes);
    cleanup(journalPath, backups, options);
  } catch (error) {
    if (committed) {
      if (!commitWriteReturned) {
        try {
          const persisted = parseJournal(readTruthFileVerified(journalPath, { probeAttributes: options.probeAttributes }).toString('utf8'));
          if (persisted.committed !== true) throw new Error('已提交 journal 内容不一致');
          cleanup(journalPath, backups, options);
        } catch (confirmationError) {
          const warning = `记忆批次已提交但状态确认或清理失败，保留证据并停止写入：${String(error)}；${String(confirmationError)}`;
          blockWrites(dataDir, [warning], options.probeAttributes);
          throw new Error(warning);
        }
        throw error;
      }
      throw new Error(`记忆批次已提交但清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      restore(journal, options);
      cleanup(journalPath, backups, options);
    } catch (rollbackError) {
      const warning = `记忆批次提交失败且回滚失败：${String(error)}；${String(rollbackError)}`;
      blockWrites(dataDir, [warning], options.probeAttributes);
      throw new Error(warning);
    }
    throw error;
  }
  return writtenIdentities;
}
