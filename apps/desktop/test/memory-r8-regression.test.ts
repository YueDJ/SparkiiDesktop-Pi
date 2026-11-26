import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore, ApprovalGate } from '@sparkii/approval';
import { Rbac } from '@sparkii/identity';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';
import { ErrorStore } from '../electron/main/error-store.js';
import { Logger } from '../electron/main/logger.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { assertTruthPathSafe, commitTruthBatch, TruthPathSafetyError } from '../electron/main/memory/truth-batch.js';
import { parseProjectMemoryFile } from '../electron/main/memory/store.js';
import { memoryDbPath, memoryDir, projectMemoryFile, projectRegistryFile, userMemoryFile } from '../electron/main/memory/settings.js';

const nativeProbeHarness = vi.hoisted(() => ({
  reparseTarget: '',
  defaultAssertTruthPathSafe: undefined as ((path: string, probeAttributes?: (paths: string[]) => number[]) => void) | undefined,
  postReadMutation: undefined as ((path: string, content: Buffer) => void) | undefined,
}));

vi.mock('../electron/main/memory/truth-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/main/memory/truth-path.js')>();
  nativeProbeHarness.defaultAssertTruthPathSafe = actual.assertTruthPathSafe;
  return {
    ...actual,
    assertTruthPathSafe: (path: string, probeAttributes?: (paths: string[]) => number[]) => {
      if (probeAttributes) return actual.assertTruthPathSafe(path, probeAttributes);
      const target = nativeProbeHarness.reparseTarget;
      return actual.assertTruthPathSafe(path, target
        ? (paths) => paths.map((candidate) => candidate === target ? 16 : 0)
        : (paths) => paths.map(() => 0));
    },
    inspectTruthFile: (path: string, probe?: (paths: string[]) => number[], options?: { allowMissing?: boolean; regularFile?: boolean }) =>
      actual.inspectTruthFile(path, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      )), options),
    inspectTruthFileTwice: (path: string, probe?: (paths: string[]) => number[], options?: { allowMissing?: boolean; regularFile?: boolean; expectedIdentity?: string }) =>
      actual.inspectTruthFileTwice(path, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      )), options),
    inspectTruthFiles: (inspections: Parameters<typeof actual.inspectTruthFiles>[0], probe?: (paths: string[]) => number[]) =>
      actual.inspectTruthFiles(inspections, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      ))),
    inspectTruthFilesTwice: (inspections: Parameters<typeof actual.inspectTruthFilesTwice>[0], probe?: (paths: string[]) => number[]) =>
      actual.inspectTruthFilesTwice(inspections, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      ))),
    readTruthDirectoriesVerified: (paths: string[], probe?: (paths: string[]) => number[]) =>
      actual.readTruthDirectoriesVerified(paths, probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      ))),
    readTruthFilesVerified: (requests: Parameters<typeof actual.readTruthFilesVerified>[0], probe?: (paths: string[]) => number[], preceding?: Parameters<typeof actual.readTruthFilesVerified>[2]) =>
      actual.readTruthFilesVerified(requests.map((request) => {
        const read = request.read;
        return {
          ...request,
          read: (file: string) => {
            const bytes = read ? read(file) : readFileSync(file);
            nativeProbeHarness.postReadMutation?.(request.path, bytes);
            return bytes;
          },
        };
      }), probe ?? ((paths) => paths.map((candidate) =>
        nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
      )), preceding),
    readTruthFileVerifiedResult: (path: string, options?: Parameters<typeof actual.readTruthFileVerifiedResult>[1]) => {
      const read = options?.read;
      return actual.readTruthFileVerifiedResult(path, {
        ...options,
        read: (file) => {
          const bytes = read ? read(file) : readFileSync(file);
          nativeProbeHarness.postReadMutation?.(path, bytes);
          return bytes;
        },
        probeAttributes: options?.probeAttributes ?? ((paths) => paths.map((candidate) =>
          nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
        )),
      });
    },
    readTruthFileVerified: (path: string, options?: Parameters<typeof actual.readTruthFileVerified>[1]) => {
      const read = options?.read;
      const content = actual.readTruthFileVerified(path, {
        ...options,
        read: (file) => {
          const bytes = read ? read(file) : readFileSync(file);
          nativeProbeHarness.postReadMutation?.(path, bytes);
          return bytes;
        },
        probeAttributes: options?.probeAttributes ?? ((paths) => paths.map((candidate) =>
          nativeProbeHarness.reparseTarget && candidate === nativeProbeHarness.reparseTarget ? 16 : 0
        )),
      });
      return content;
    },
  };
});

let root: string;
let dataDir: string;
let errors: ErrorStore;
let audit: AuditStore;
let gate: ApprovalGate;
let sessions: ChatSessionStore;
let logger: Logger;
let service: MemoryService;
let events: Array<{ type: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  nativeProbeHarness.reparseTarget = '';
  nativeProbeHarness.postReadMutation = undefined;
  root = mkdtempSync(join(tmpdir(), 'sparkii-r8-memory-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  audit = new AuditStore(join(dataDir, 'audit.db'));
  gate = new ApprovalGate({
    audit,
    policy: { requireApproval: ['memory_forget'], timeoutMs: 60_000, highRiskDoubleConfirm: true },
    rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
  });
  sessions = new ChatSessionStore(join(dataDir, 'sessions.db'));
  logger = new Logger(join(dataDir, 'logs'), false);
  events = [];
  service = makeService();
});

afterEach(() => {
  vi.restoreAllMocks();
  service?.close();
  sessions.close();
  audit.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function makeService(overrides: Partial<ConstructorParameters<typeof MemoryService>[0]> = {}): MemoryService {
  return new MemoryService({
    dataDir, errors, logger, audit, gate,
    sessionExists: (id) => Boolean(sessions.get(id)),
    sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
    workspacePathOf: (id) => sessions.get(id)?.workspacePath,
    workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
    registerChatSessionRedactions: (texts) => sessions.registerRedactions(texts),
    deleteChatSession: (id, texts) => sessions.privacyDelete(id, texts),
    probeAttributes: (paths) => paths.map((path) => nativeProbeHarness.reparseTarget && path === nativeProbeHarness.reparseTarget ? 16 : 0),
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
  });
}

function restart(): void {
  service.close();
  service = makeService();
}

type RegistryReplacement = 'symlink' | 'hardlink' | 'non-symlink-reparse';

function replaceProjectRegistry(kind: RegistryReplacement): { registry: string; externalRegistry: string; externalTruth: string; externalText: string } {
  const registry = projectRegistryFile(dataDir);
  const externalRegistryDir = join(root, `external-${kind}-registry`);
  const externalRegistry = join(externalRegistryDir, 'projects.json');
  const externalWorkspace = join(root, `external-${kind}-workspace`);
  const externalTruth = projectMemoryFile(externalWorkspace);
  const externalText = `EXTERNAL_REGISTRY_TRUTH_${kind.replace(/-/g, '_')}_71C`;
  mkdirSync(join(externalWorkspace, '.sparkii'), { recursive: true });
  mkdirSync(externalRegistryDir, { recursive: true });
  writeFileSync(externalTruth, `${JSON.stringify({
    version: 1,
    projectId: `proj_external_${kind.replace(/-/g, '_')}`,
    entries: [{
      id: `mem_external_${kind.replace(/-/g, '_')}`,
      text: externalText, status: 'active', pinned: false, importance: 2,
      createdAt: 1, updatedAt: 1,
      source: { sessionId: 'external-session', excerpt: externalText, kind: 'extracted' },
      supersededBy: null, pendingOp: null,
    }],
  }, null, 2)}\n`);
  writeFileSync(externalRegistry, JSON.stringify({
    version: 1,
    projects: [{ projectId: `proj_external_${kind.replace(/-/g, '_')}`, workspacePath: externalWorkspace }],
  }, null, 2));
  rmSync(registry, { force: true });
  if (kind === 'symlink') {
    symlinkSync(externalRegistryDir, registry, 'junction');
  } else if (kind === 'hardlink') {
    linkSync(externalRegistry, registry);
  } else {
    writeFileSync(registry, readFileSync(externalRegistry));
    nativeProbeHarness.reparseTarget = registry;
  }
  return { registry, externalRegistry, externalTruth, externalText };
}

function databaseBytes(path: string): string {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
    .filter(existsSync)
    .map((file) => readFileSync(file).toString('utf8'))
    .join('\n');
}

function pendingJournals(): string[] {
  const dir = join(memoryDir(dataDir), 'privacy-pending');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

function replaceScopeDirectory(kind: 'junction' | 'non-symlink-reparse', directory: 'agents' | 'episode-proposals') {
  const dir = directory === 'agents' ? join(memoryDir(dataDir), 'agents') : join(memoryDir(dataDir), 'episode-proposals');
  const externalDir = join(root, `external-${directory}-${kind}`);
  const externalName = 'EXTERNAL_SECRET_AGENT.json';
  const externalFile = join(externalDir, externalName);
  const payload = JSON.stringify({ version: 1, entries: [] });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(externalFile, payload);
  if (kind === 'junction') {
    symlinkSync(externalDir, dir, 'junction');
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, externalName), payload);
    nativeProbeHarness.reparseTarget = dir;
  }
  return { dir, externalDir, externalFile, externalName, payload };
}

async function seedPrivacy(sessionId = 'private-session', workspace = join(root, 'workspace')) {
  const secret = `R8_PRIVATE_${sessionId}_71C`;
  const excerpt = `R8_EXCERPT_${sessionId}_92D`;
  mkdirSync(workspace, { recursive: true });
  sessions.create({ id: sessionId, profileId: 'general', workspaceKind: 'user', workspacePath: workspace, inputs: JSON.stringify({ text: secret }) });
  const user = service.addMemory({ scope: 'user', text: secret, sessionId, excerpt });
  const project = service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: `project ${secret}`, sessionId, excerpt });
  service.addMemory({ scope: 'user', text: `cross-session ${excerpt}`, sessionId: 'carrier-session' });
  service.store.appendEpisode({ sessionId, agentId: 'general', workspacePath: workspace, ts: Date.now(), summary: secret, topics: [excerpt] });
  errors.append({ id: `error-${sessionId}`, message: `${secret} ${excerpt}`, source: 'memory.test', createdAt: Date.now() });
  await Promise.all([
    logger.log({ level: 'info', msg: secret, ctx: { sessionId, detail: excerpt } }),
    audit.append({ actor: 'agent', action: 'carrier.audit', resource: 'memory', payloadSummary: `${secret} ${excerpt}`, sessionId: 'carrier-session' }),
  ]);
  return { secret, excerpt, user, project, workspace };
}

async function expectPrivateGone(secret: string, excerpt: string, sessionId = 'private-session'): Promise<void> {
  const initialLogs = logger.export();
  expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
  expect(service.list().scopes.flatMap((scope) => scope.entries).map((entry) => entry.text).join('\n')).not.toContain(secret);
  expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
  expect(service.searchMemory(excerpt, { includeHistory: true })).toEqual([]);
  expect(await initialLogs).not.toContain(secret);
  await logger.log({ level: 'warn', msg: `future ${secret}`, ctx: { detail: excerpt } });
  const futureLogs = logger.export();
  const futureAudit = audit.query({});
  expect(await futureLogs).not.toContain(secret);
  expect(await futureLogs).not.toContain(excerpt);
  expect(JSON.stringify(await futureAudit)).not.toContain(secret);
  expect(errors.list().map((event) => event.message).join('\n')).not.toContain(excerpt);
  expect(sessions.get(sessionId)).toBeUndefined();
  for (const path of [memoryDbPath(dataDir), join(dataDir, 'audit.db'), join(dataDir, 'errors.db'), join(dataDir, 'sessions.db')]) {
    const bytes = databaseBytes(path);
    expect(bytes, path).not.toContain(secret);
    expect(bytes, path).not.toContain(excerpt);
  }
}

describe('R8 truth registry path regressions', () => {
  const cases = (['symlink', 'hardlink', 'non-symlink-reparse'] as const)
    .flatMap((kind) => (['list', 'search', 'rebuild'] as const).map((operation) => [kind, operation] as const));

  it.each(cases)('R8-REPAIR-MEMORY truth B %s replacement makes production %s fail closed', (kind, operation) => {
    service.addMemory({ scope: 'user', text: 'LOCAL_REGISTRY_BASELINE_71C' });
    const replaced = replaceProjectRegistry(kind);
    const registryBefore = readFileSync(replaced.externalRegistry);
    const truthBefore = readFileSync(replaced.externalTruth);
    if (kind === 'non-symlink-reparse') {
      const info = lstatSync(replaced.registry, { bigint: true });
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.nlink).toBe(1n);
    }

    const invoke = () => {
      if (operation === 'list') return service.list();
      if (operation === 'search') return service.searchMemory(replaced.externalText);
      return service.rebuildIndex();
    };
    expect(invoke).toThrow(/链接|硬链接|重解析点/);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(replaced.externalText);
    expect(readFileSync(replaced.externalRegistry)).toEqual(registryBefore);
    expect(readFileSync(replaced.externalTruth)).toEqual(truthBefore);
  });

  it.runIf(process.platform === 'win32')('R8-REPAIR-MEMORY truth C default fence and rebuilt SandboxProbe batch mode stay integrated', async () => {
    service.addMemory({ scope: 'user', text: 'DEFAULT_NATIVE_PROBE_71C' });
    const file = userMemoryFile(dataDir);
    const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const helper = join(import.meta.dirname, '..', 'native', 'windows-sandbox', 'bin', 'SandboxProbe.exe');

    expect(() => nativeProbeHarness.defaultAssertTruthPathSafe!(file)).not.toThrow();
    expect(execFileSync(helper, ['reparse-attributes', file], { encoding: 'utf8', windowsHide: true }).trim()).toBe('0');
  });
});

describe('R8 privacy recovery regressions', () => {
  it('R8 review privacy B5 zeroes a plaintext journal temp file before a failed removal', async () => {
    const { secret } = await seedPrivacy();
    const digest = createHash('sha256').update('private-session').digest('hex');
    const journal = join(memoryDir(dataDir), 'privacy-pending', `${digest}.json`);
    service.close();
    let observed: Buffer | undefined;
    service = makeService({
      removePath: (path, options) => {
        if (path.endsWith('.tmp')) {
          observed = readFileSync(path);
          throw new Error('injected privacy temp removal failure');
        }
        rmSync(path, options);
      },
    });
    mkdirSync(journal, { recursive: true });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/无法持久化/);
    const dir = join(memoryDir(dataDir), 'privacy-pending');
    const temp = readdirSync(dir).find((name) => name.endsWith('.tmp'));
    expect(temp).toBeDefined();
    expect(observed).toBeDefined();
    expect(observed!.includes(Buffer.from(secret))).toBe(false);
    expect(observed!.every((byte) => byte === 0)).toBe(true);
    expect(readFileSync(join(dir, temp!)).equals(observed!)).toBe(true);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
    expect(() => service.searchMemory(secret)).toThrow(/隐私删除恢复日志无法持久化/);
  }, 60_000);

  it('R8 final review fences same-process and restarted reads when the privacy journal cannot be persisted', async () => {
    const { secret, excerpt, workspace } = await seedPrivacy();
    const pendingDir = join(memoryDir(dataDir), 'privacy-pending');
    rmSync(pendingDir, { recursive: true, force: true });
    writeFileSync(pendingDir, 'not-a-directory');

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/无法持久化/);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
    expect(() => service.searchMemory(secret)).toThrow(/无法持久化/);
    expect(() => service.list()).toThrow(/无法持久化/);
    expect(() => service.synchronize()).toThrow(/无法持久化/);
    expect(() => service.repairProjectMemory(workspace, 'empty')).toThrow(/无法持久化/);
    errors.append({ id: `future-${secret}`, message: secret, source: excerpt, createdAt: Date.now() });
    await logger.log({ level: 'warn', msg: secret, ctx: { detail: excerpt } });
    expect(JSON.stringify(errors.list())).not.toContain(secret);
    expect(await logger.export()).not.toContain(secret);

    restart();
    expect(() => service.searchMemory(secret)).toThrow(/无法持久化|阻断/);
    expect(() => service.list()).toThrow(/无法持久化|阻断/);
    expect(() => service.synchronize()).toThrow(/无法持久化|阻断/);
  });

  it.each(['logger', 'audit', 'gate', 'errors'] as const)('R8-P0-1 resumes privacy deletion after %s cleanup fails and never exposes restored plaintext', async (sink) => {
    const { secret, excerpt, workspace } = await seedPrivacy();
    const target = join(memoryDir(dataDir), '.truth-backups', '0.backup');
    if (sink === 'logger') vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger cleanup failure'); });
    if (sink === 'audit') vi.spyOn(audit, 'redactTexts').mockImplementationOnce(() => { throw new Error('injected audit cleanup failure'); });
    if (sink === 'gate') vi.spyOn(gate, 'redactTexts').mockImplementationOnce(() => { throw new Error('injected gate cleanup failure'); });
    if (sink === 'errors') vi.spyOn(errors, 'redactTexts').mockImplementationOnce(() => { throw new Error('injected error cleanup failure'); });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    expect(pendingJournals()).toHaveLength(1);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).toContain(secret);
    mkdirSync(join(memoryDir(dataDir), '.truth-backups'), { recursive: true });
    writeFileSync(target, readFileSync(userMemoryFile(dataDir)));
    writeFileSync(userMemoryFile(dataDir), '{"version":1,"entries":[]}\n');
    writeFileSync(join(memoryDir(dataDir), '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target: userMemoryFile(dataDir), backup: target, existed: true }],
    }));
    expect(workspace).toBeTruthy();

    restart();

    expect(pendingJournals()).toEqual([]);
    expect(readFileSync(projectMemoryFile(workspace), 'utf8')).not.toContain(secret);
    await expectPrivateGone(secret, excerpt);
  });

  it('R8-P0-1 resumes from journal context after the chat row and Pi file are already gone', async () => {
    const { secret, excerpt, workspace } = await seedPrivacy();
    const piFile = join(root, 'private.jsonl');
    writeFileSync(piFile, `${secret}\n`);
    sessions.update('private-session', { piSessionFile: piFile });
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger crash'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    expect(existsSync(piFile)).toBe(true);
    sessions.privacyDelete('private-session', []);
    rmSync(piFile, { force: true });

    restart();

    expect(pendingJournals()).toEqual([]);
    expect(readFileSync(projectMemoryFile(workspace), 'utf8')).not.toContain(secret);
    await expectPrivateGone(secret, excerpt);
  });

  it('R8-P0-1 keeps a failed privacy cleanup fenced after restart and retries when chat cleanup recovers', async () => {
    const { secret, excerpt } = await seedPrivacy();
    let failChat = true;
    vi.spyOn((service as any).deps, 'deleteChatSession').mockImplementation(() => {
      throw new Error('injected chat cleanup failure');
    });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    service.close();
    service = makeService({ deleteChatSession: (id, texts) => {
      if (failChat) throw new Error('injected chat cleanup failure');
      sessions.privacyDelete(id, texts);
    } });
    expect(() => service.searchMemory(secret)).toThrow(/隐私删除尚未完成/);
    service.close();
    failChat = false;
    service = makeService();
    expect(pendingJournals()).toEqual([]);
    await expectPrivateGone(secret, excerpt);
  });

  it('R8-P0-1 releases the in-memory privacy fence when the completed recovery journal is already absent', async () => {
    const { secret, excerpt } = await seedPrivacy();
    service.close();
    service = makeService({ deleteChatSession: (id, texts) => {
      sessions.privacyDelete(id, texts);
      const dir = join(memoryDir(dataDir), 'privacy-pending');
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
    } });

    service.privacyDeleteBySession('private-session');

    expect(pendingJournals()).toEqual([]);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
    await expectPrivateGone(secret, excerpt);
  });

  it('R8 review B3 registers chat secrets before sink cleanup and protects later chat writes after failure', async () => {
    const { secret } = await seedPrivacy();
    const register = vi.spyOn(sessions, 'registerRedactions');
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger failure'); });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    expect(register).toHaveBeenCalled();
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(logger.redactSession).mock.invocationCallOrder[0]);
    sessions.create({ id: 'future-chat', profileId: 'general', workspaceKind: 'user', workspacePath: join(root, 'future'), inputs: JSON.stringify({ text: secret }) });
    expect(sessions.get('future-chat')?.inputs).not.toContain(secret);

    restart();
    sessions.create({ id: 'restarted-chat', profileId: 'general', workspaceKind: 'user', workspacePath: join(root, 'restarted'), inputs: JSON.stringify({ text: secret }) });
    expect(sessions.get('restarted-chat')?.inputs).not.toContain(secret);
  });

  it('R8-P0-1 restores privacy sink fences before truth recovery can restore plaintext', async () => {
    const { secret } = await seedPrivacy();
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger failure'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    service.close();
    const target = userMemoryFile(dataDir);
    const original = readFileSync(target);
    const dir = memoryDir(dataDir);
    const backups = join(dir, '.truth-backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(target, 'PARTIAL_PRIVATE_TRUTH_71C');
    writeFileSync(join(backups, '0.backup'), original);
    writeFileSync(join(dir, '.truth-batch-journal.json'), JSON.stringify({
      version: 1,
      files: [{ target, backup: join(backups, '0.backup'), existed: true }],
    }));
    const observed: string[] = [];
    const redactTexts = gate.redactTexts.bind(gate);
    vi.spyOn(gate, 'redactTexts').mockImplementation((texts) => {
      observed.push(readFileSync(target, 'utf8'));
      return redactTexts(texts);
    });

    service = makeService();

    expect(observed[0]).toContain('PARTIAL_PRIVATE_TRUTH_71C');
    expect(observed[0]).not.toContain(secret);
    await expectPrivateGone(secret, 'R8_EXCERPT_private-session_92D');
  });

  it('R8 review B3 cleans Pi and chat carriers before a safe-root truth write-block aborts startup', async () => {
    const { secret } = await seedPrivacy();
    const piFile = join(root, 'blocked-private.jsonl');
    writeFileSync(piFile, `${secret}\n`);
    sessions.update('private-session', { piSessionFile: piFile });
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger failure'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    service.close();
    writeFileSync(join(memoryDir(dataDir), '.truth-write-block.json'), JSON.stringify({ version: 1, warnings: ['injected rollback failure'] }));
    const registerChatSessionRedactions = vi.fn((texts: string[]) => sessions.registerRedactions(texts));
    const deleteChatSession = vi.fn((id: string, texts?: string[]) => sessions.privacyDelete(id, texts));

    expect(() => makeService({ registerChatSessionRedactions, deleteChatSession })).toThrow(/写入阻断/);
    expect(registerChatSessionRedactions).toHaveBeenCalled();
    expect(deleteChatSession).toHaveBeenCalledWith('private-session', expect.arrayContaining([secret]));
    expect(existsSync(piFile)).toBe(false);
    expect(sessions.get('private-session')).toBeUndefined();
    expect(pendingJournals()).toHaveLength(1);
  });

  it('R8 review B5 rejects dangling privacy journal directory and file links without reading targets', () => {
    const pendingDir = join(memoryDir(dataDir), 'privacy-pending');
    const outside = join(root, 'journal-link-target');
    mkdirSync(outside, { recursive: true });
    try { symlinkSync(outside, pendingDir, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkSync(outside, pendingDir, 'junction');
    }
    service.close();
    service = makeService();
    expect(lstatSync(pendingDir).isSymbolicLink()).toBe(true);
    expect(() => service.list()).toThrow(/恢复日志损坏/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(pendingDir);

    mkdirSync(pendingDir);
    const missing = join(outside, 'missing-journal.json');
    const journal = join(pendingDir, 'dangling.json');
    try { symlinkSync(missing, journal, 'file'); } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkSync(missing, journal, 'junction');
    }
    service.close();
    service = makeService();
    expect(lstatSync(journal).isSymbolicLink()).toBe(true);
    expect(() => service.searchMemory('anything')).toThrow(/恢复日志损坏/);
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses to clear a privacy journal whose identity changed during cleanup', async () => {
    const { secret } = await seedPrivacy();
    service.close();
    service = makeService({ deleteChatSession: (id, texts) => {
      sessions.privacyDelete(id, texts);
      const file = join(memoryDir(dataDir), 'privacy-pending', pendingJournals()[0]);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify(parsed));
    } });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/身份已变化/);
    expect(pendingJournals()).toHaveLength(1);
    expect(sessions.get('private-session')).toBeUndefined();
    expect(readFileSync(join(memoryDir(dataDir), 'privacy-pending', pendingJournals()[0]), 'utf8')).toContain(secret);
  });

  it('fences the journal read source identity before accepting parsed privacy content', async () => {
    const { secret } = await seedPrivacy();
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected pending journal'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    const journal = join(memoryDir(dataDir), 'privacy-pending', pendingJournals()[0]);
    const replacement = join(root, 'replacement-journal.json');
    const identity = (service as any).privacyJournalIdentity(journal);
    let injected = false;
    nativeProbeHarness.postReadMutation = (path) => {
      if (path === journal && !injected) {
        renameSync(journal, replacement);
        injected = true;
      }
    };

    expect(() => (service as any).readPrivacyJournal(journal, identity)).toThrow(TruthPathSafetyError);
    expect(injected).toBe(true);
    expect(existsSync(journal)).toBe(false);
    expect(readFileSync(replacement, 'utf8')).toContain(secret);
  });

  it('R8-REPAIR-MEMORY refuses to delete a journal when the zero-write readback contains a nonzero byte', async () => {
    const { secret } = await seedPrivacy();
    service.close();
    const journal = join(memoryDir(dataDir), 'privacy-pending', `${createHash('sha256').update('private-session').digest('hex')}.json`);
    let removalAttempts = 0;
    let injected = 0;
    service = makeService({ removePath: (path, options) => {
      if (path.endsWith('.tmp')) {
        removalAttempts += 1;
        throw new Error('injected privacy temp removal failure');
      }
      rmSync(path, options);
    } });
    mkdirSync(journal, { recursive: true });
    (service as any).assertPrivacyPathSafe = (path: string) => {
      assertTruthPathSafe(path);
      if (path.endsWith('.tmp') && existsSync(path)) {
        const bytes = readFileSync(path);
        if (bytes.length && bytes.every((byte) => byte === 0)) {
          bytes[bytes.length - 1] = 1;
          writeFileSync(path, bytes);
          injected += 1;
        }
      }
    };

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/清零回读校验失败/);

    expect(injected).toBe(1);
    expect(removalAttempts).toBe(0);
    const tempName = readdirSync(join(memoryDir(dataDir), 'privacy-pending')).find((name) => name.endsWith('.tmp'));
    expect(tempName).toBeTruthy();
    const temp = join(memoryDir(dataDir), 'privacy-pending', tempName!);
    expect(existsSync(temp)).toBe(true);
    expect(readFileSync(temp).every((byte) => byte === 0)).toBe(false);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
    expect(() => service.searchMemory(secret)).toThrow(/隐私删除恢复文件清理失败/);
  });

  it.each([
    ['digest-mismatch', 'other-session'],
    ['session-mismatch', 'private-session'],
    ['malformed', 'private-session'],
  ] as const)('R8-REPAIR-MEMORY %s startup temp evidence persists a privacy write-block without deleting context', async (kind, sessionId) => {
    const { secret } = await seedPrivacy();
    service.close();
    const dir = join(memoryDir(dataDir), 'privacy-pending');
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update(kind === 'digest-mismatch' ? 'wrong-session' : sessionId).digest('hex');
    const temp = join(dir, `${digest}.json.11111111-1111-4111-8111-111111111111.tmp`);
    const payload = kind === 'malformed' ? '{broken' : JSON.stringify({
      version: 1,
      sessionId: kind === 'session-mismatch' ? 'wrong-session' : sessionId,
      texts: [secret], memoryIds: [], workspacePaths: [],
    });
    writeFileSync(temp, payload);

    (service as any).loadPendingPrivacyJournals();

    expect(existsSync(temp)).toBe(true);
    expect(readFileSync(temp, 'utf8')).toBe(payload);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(memoryDir(dataDir), '.privacy-write-block.json'), 'utf8'))).toMatchObject({ version: 1 });
  });

  it('R8-REPAIR-MEMORY promotes a valid startup temp journal and automatically resumes its privacy deletion', async () => {
    const { secret, excerpt } = await seedPrivacy();
    service.close();
    const dir = join(memoryDir(dataDir), 'privacy-pending');
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('private-session').digest('hex');
    const temp = join(dir, `${digest}.json.11111111-1111-4111-8111-111111111111.tmp`);
    writeFileSync(temp, JSON.stringify({
      version: 1, sessionId: 'private-session', texts: [secret, excerpt],
      memoryIds: [], workspacePaths: [join(root, 'workspace')],
    }));

    service = makeService();

    expect(existsSync(temp)).toBe(false);
    expect(pendingJournals(), JSON.stringify((service as any).recoveryWarnings)).toEqual([]);
    await expectPrivateGone(secret, excerpt);
  });

  it.runIf(process.platform === 'win32').each(['directory', 'file'] as const)('R8-REPAIR-MEMORY fences Windows non-symlink reparse attributes on the privacy %s before temp reads and cleanup', async (where) => {
    const { secret } = await seedPrivacy();
    service.close();
    const dir = join(memoryDir(dataDir), 'privacy-pending');
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('private-session').digest('hex');
    const temp = join(dir, `${digest}.json.11111111-1111-4111-8111-111111111111.tmp`);
    const payload = JSON.stringify({ version: 1, sessionId: 'private-session', texts: [secret] });
    writeFileSync(temp, payload);
    const attributesRead: string[] = [];
    const reparseTarget = where === 'directory' ? dir : temp;
    (service as any).assertPrivacyPathSafe = (path: string) => assertTruthPathSafe(path, (paths) => {
      attributesRead.push(...paths);
      return paths.map((candidate) => candidate === reparseTarget ? 16 : 0);
    });

    (service as any).loadPendingPrivacyJournals();

    expect(attributesRead).toContain(dir);
    expect(attributesRead).toContain(reparseTarget);
    expect(readFileSync(temp, 'utf8')).toBe(payload);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
  });

  it('R8-REPAIR-MEMORY continues Gate Audit Error Logger cleanup when store privacy registration fails', async () => {
    const { secret } = await seedPrivacy();
    const register = vi.spyOn(service.store, 'registerPrivacyTexts').mockImplementationOnce(() => {
      throw new Error('injected store privacy registration failure');
    });
    const gateCleanup = vi.spyOn(gate, 'redactTexts');
    const auditCleanup = vi.spyOn(audit, 'redactTexts');
    const errorCleanup = vi.spyOn(errors, 'redactTexts');
    const loggerCleanup = vi.spyOn(logger, 'redactSession');

    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');

    expect(register).toHaveBeenCalledWith(expect.arrayContaining([secret]));
    expect(gateCleanup).toHaveBeenCalledWith(expect.arrayContaining([secret]));
    expect(auditCleanup).toHaveBeenCalledWith(expect.arrayContaining([secret]));
    expect(errorCleanup).toHaveBeenCalledWith(expect.arrayContaining([secret]));
    expect(loggerCleanup).toHaveBeenCalledWith('private-session', expect.arrayContaining([secret]));
    expect(pendingJournals()).toHaveLength(1);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(errors.list().map((event) => event.message).join('\n')).not.toContain(secret);
    expect(await logger.export()).not.toContain(secret);
    expect(() => service.list()).toThrow(/隐私删除尚未完成/);
  });

  it('R8 review B4 rotates memory markers when the deleted text collides with %s', async (secret) => {
    service.addMemory({ scope: 'user', text: `private ${secret} tail`, sessionId: 'marker-private', excerpt: secret });
    service.addMemory({ scope: 'user', text: `survivor ${secret} tail`, sessionId: 'marker-other', excerpt: 'other' });
    sessions.create({ id: 'marker-private', profileId: 'general', workspaceKind: 'user', workspacePath: join(root, 'marker') });

    service.privacyDeleteBySession('marker-private');

    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(service.list().scopes.flatMap((scope) => scope.entries).map((entry) => entry.text).join('\n')).not.toContain(secret);
  });

  it('R8-P1-6 future and concurrent audit writes cannot reintroduce a privacy-deleted secret', async () => {
    const { secret, excerpt } = await seedPrivacy();
    service.privacyDeleteBySession('private-session');
    const appending = audit.append({ actor: 'agent', action: 'gateway.failed', resource: 'memory', payloadSummary: `${secret} ${excerpt}` });
    service.privacyDeleteBySession('private-session');
    await appending;

    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(await audit.exportJsonl()).not.toContain(excerpt);
    expect(databaseBytes(join(dataDir, 'audit.db'))).not.toContain(secret);
    restart();
    await audit.append({ actor: secret, action: `future.${excerpt}`, resource: 'memory', payloadSummary: secret });
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(databaseBytes(join(dataDir, 'audit.db'))).not.toContain(secret);
  });
});

describe('R8 truth write-block regressions', () => {
  it('R8-P1-3 refuses to construct MemoryService through an unsafe memory-root junction', () => {
    const unsafeData = join(root, 'unsafe-data');
    const outside = join(root, 'outside-memory');
    const privacyDir = join(outside, 'privacy-pending');
    mkdirSync(join(unsafeData, '.sparkii'), { recursive: true });
    mkdirSync(privacyDir, { recursive: true });
    symlinkSync(outside, memoryDir(unsafeData), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(outside, '.truth-batch-journal.json'), '{broken');
    writeFileSync(join(privacyDir, 'pending.json'), JSON.stringify({
      version: 1, sessionId: 'unsafe-private', texts: ['UNSAFE_PRIVATE_SECRET'], memoryIds: [], workspacePaths: [],
    }));
    const truthBefore = readFileSync(join(outside, '.truth-batch-journal.json'));
    const privacyBefore = readFileSync(join(privacyDir, 'pending.json'));
    const redactTexts = vi.fn();
    const redactSession = vi.fn();
    const redactMemoryPromptLogs = vi.fn();

    expect(() => new MemoryService({
      dataDir: unsafeData,
      gate: { redactTexts }, audit: { redactTexts }, errors: { redactTexts } as any,
      logger: { redactSession, redactMemoryPromptLogs } as any,
    })).toThrow(/链接|写入阻断|保持只读/);
    expect(redactTexts).not.toHaveBeenCalled();
    expect(redactSession).not.toHaveBeenCalled();
    expect(redactMemoryPromptLogs).not.toHaveBeenCalled();
    expect(readdirSync(outside).sort()).toEqual(['.truth-batch-journal.json', 'privacy-pending']);
    expect(readdirSync(privacyDir)).toEqual(['pending.json']);
    expect(readFileSync(join(outside, '.truth-batch-journal.json'))).toEqual(truthBefore);
    expect(readFileSync(join(privacyDir, 'pending.json'))).toEqual(privacyBefore);
  });

  it('R8-P1-3 fences project repair before registry or truth reads', () => {
    const workspace = join(root, 'repair-blocked-workspace');
    mkdirSync(workspace, { recursive: true });
    service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: 'retained project fact' });
    const marker = join(memoryDir(dataDir), '.truth-write-block.json');
    const registry = projectRegistryFile(dataDir);
    const projectBefore = readFileSync(projectMemoryFile(workspace));
    writeFileSync(marker, JSON.stringify({ warnings: ['injected rollback failure'] }));
    writeFileSync(registry, '{broken');

    expect(() => service.repairProjectMemory(workspace, 'empty')).toThrow(/写入阻断/);
    expect(readFileSync(registry, 'utf8')).toBe('{broken');
    expect(readFileSync(projectMemoryFile(workspace))).toEqual(projectBefore);
  });

  it('R8-P1-3 blocks search/list/row/rebuild in-process and after restart, including a damaged marker', () => {
    const added = service.addMemory({ scope: 'user', text: 'R8_PARTIAL_TRUTH_71C' });
    const workspace = join(root, 'blocked-workspace');
    mkdirSync(workspace, { recursive: true });
    service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: 'blocked project fact' });
    const marker = join(memoryDir(dataDir), '.truth-write-block.json');
    writeFileSync(marker, JSON.stringify({ warnings: ['injected rollback failure'] }));
    writeFileSync(userMemoryFile(dataDir), JSON.stringify({ version: 1, entries: [{ ...added, text: 'R8_PARTIAL_TRUTH_71C' }] }, null, 2));

    expect(() => service.searchMemory('R8_PARTIAL_TRUTH_71C')).toThrow(/写入阻断/);
    expect(() => service.list()).toThrow(/写入阻断/);
    expect(() => service.store.rowFor(added.id)).toThrow(/写入阻断/);
    expect(() => service.rebuildIndex()).toThrow(/写入阻断/);
    expect(() => service.ensureProject(workspace, 'user')).toThrow(/写入阻断/);
    expect(() => service.previewScope({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' }, 'project')).toThrow(/写入阻断/);
    expect(() => service.archiveProject(workspace, true)).toThrow(/写入阻断/);
    expect(events.some((event) => event.type === 'repair_needed' && String(event.payload.detail).includes('写入阻断'))).toBe(true);

    service.close();
    expect(() => makeService()).toThrow(/写入阻断/);
    writeFileSync(marker, '{broken');
    expect(() => makeService()).toThrow(/写入阻断/);
    rmSync(marker);
    service = makeService();
    expect(service.rebuildIndex().entries).toBe(2);
    expect(service.searchMemory('R8_PARTIAL_TRUTH_71C').map((hit) => hit.id)).toEqual([added.id]);
  });
  it('R8 privacy review reads the raw Pi path before chat redaction can alter it', async () => {
    const { secret } = await seedPrivacy();
    const piFile = join(root, `${secret}.jsonl`);
    writeFileSync(piFile, `${secret}\n`);
    sessions.update('private-session', { piSessionFile: piFile });

    service.privacyDeleteBySession('private-session');

    expect(existsSync(piFile)).toBe(false);
    expect(pendingJournals()).toEqual([]);
    expect(sessions.get('private-session')).toBeUndefined();
  });

  it('R8 privacy review resumes a secret-named Pi carrier after restart', async () => {
    const { secret } = await seedPrivacy();
    const piFile = join(root, `${secret}.jsonl`);
    writeFileSync(piFile, `${secret}\n`);
    sessions.update('private-session', { piSessionFile: piFile });
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => {
      throw new Error('injected restart carrier failure');
    });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    expect(existsSync(piFile)).toBe(true);
    expect(pendingJournals()).toHaveLength(1);

    restart();

    expect(existsSync(piFile)).toBe(false);
    expect(sessions.get('private-session')).toBeUndefined();
    expect(pendingJournals()).toEqual([]);
    await expectPrivateGone(secret, `R8_EXCERPT_private-session_92D`);
  });

  it('R8 privacy review retries independent carriers after a same-process truth rollback block', async () => {
    const { secret } = await seedPrivacy();
    const piFile = join(root, 'blocked-private.jsonl');
    writeFileSync(piFile, `${secret}\n`);
    sessions.update('private-session', { piSessionFile: piFile });
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected logger failure'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');

    const target = userMemoryFile(dataDir);
    const backups = join(memoryDir(dataDir), '.truth-backups');
    expect(() => commitTruthBatch(dataDir, new Map([[target, '{"version":1,"entries":[]}\n']]), {
      onJournalWritten: () => {
        rmSync(target, { force: true });
        mkdirSync(target);
      },
      removePath: (path, options) => {
        if (path === backups) throw new Error('injected rollback cleanup failure');
        rmSync(path, options);
      },
    })).toThrow(/回滚失败/);
    expect(existsSync(join(memoryDir(dataDir), '.truth-write-block.json'))).toBe(true);

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/写入阻断/);
    expect(existsSync(piFile)).toBe(false);
    expect(sessions.get('private-session')).toBeUndefined();
    expect(pendingJournals()).toHaveLength(1);
    expect(() => service.searchMemory(secret)).toThrow(/写入阻断/);
  });

  it('R8 privacy review removes a plaintext journal temp file left before rename', async () => {
    const { secret } = await seedPrivacy();
    const dir = join(memoryDir(dataDir), 'privacy-pending');
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update('private-session').digest('hex');
    const temp = join(dir, `${digest}.json.11111111-1111-4111-8111-111111111111.tmp`);
    writeFileSync(temp, JSON.stringify({ version: 1, sessionId: 'private-session', texts: [secret] }));

    restart();

    expect(existsSync(temp)).toBe(false);
    expect(readdirSync(dir).join('\n')).not.toContain(secret);
  });
});

describe('R8 truth review B3 database cleanup identity fence', () => {
  it.each(['corrupt', 'journal'] as const)('refuses to zero or remove an externally linked %s file after the fresh probe', (kind) => {
    const external = join(root, `external-${kind}.bin`);
    const originalBytes = Buffer.from(`EXTERNAL_${kind.toUpperCase()}_BYTES_71C`);
    writeFileSync(external, originalBytes);
    const path = memoryDbPath(dataDir);
    const file = kind === 'journal' ? `${path}-journal` : `${path}.corrupt-71c`;
    if (kind === 'corrupt') writeFileSync(file, Buffer.from('SAFE_INITIAL_BYTES'));
    let injected = 0;
    const probe = (paths: string[]) => {
      const result = paths.map(() => 0);
      const index = paths.indexOf(file);
      if (index >= 0 && !injected) {
        rmSync(file);
        linkSync(external, file);
        injected += 1;
      }
      return result;
    };
    service.store.compact = ((compact: () => void) => function (this: unknown) {
      const originalProbe = (service.store as any).probeAttributes;
      const originalPragma = service.store.db.pragma.bind(service.store.db);
      let checkpoints = 0;
      (service.store as any).probeAttributes = probe;
      (service.store.db as any).pragma = (sql: string, ...args: unknown[]) => {
        const result = originalPragma(sql, ...args);
        if (sql === 'wal_checkpoint(TRUNCATE)' && ++checkpoints === 2 && kind === 'journal') {
          writeFileSync(file, Buffer.from('SAFE_INITIAL_BYTES'));
        }
        return result;
      };
      try { return compact.call(this); } finally {
        (service.store as any).probeAttributes = originalProbe;
        (service.store.db as any).pragma = originalPragma;
      }
    })(service.store.compact.bind(service.store));

    expect(() => service.store.compact()).toThrow(/硬链接|只有一个|普通|单链接/);
    expect(injected).toBe(1);
    expect(readFileSync(external)).toEqual(originalBytes);
    expect(existsSync(file)).toBe(true);
  });
});

describe('R8 truth review B4 privacy journal rename fence', () => {
  it('freshly probes and validates journal content after rename before privacy truth cleanup', async () => {
    const { secret } = await seedPrivacy();
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected pending journal'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    let postRenameReads = 0;
    const registerMemory = vi.spyOn(service.store, 'registerPrivacyTexts');
    const deleteTruth = vi.spyOn(service.store, 'deleteMemoryEntriesBySession');
    const probes: string[] = [];
    const journalDir = join(memoryDir(dataDir), 'privacy-pending');
    const journal = join(journalDir, `${createHash('sha256').update('private-session').digest('hex')}.json`);
    nativeProbeHarness.postReadMutation = (path) => {
      if (path === journal) writeFileSync(journal, '{corrupt');
    };
    const deps = (service as any).deps;
    const originalProbe = deps.probeAttributes;
    deps.probeAttributes = (paths: string[]) => {
      probes.push(...paths);
      if (paths.includes(journal) && existsSync(journal)) postRenameReads += 1;
      return originalProbe(paths);
    };
    const originalTruth = readFileSync(userMemoryFile(dataDir));
    const chatBefore = sessions.get('private-session');

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/恢复日志/);

    expect(postRenameReads).toBeGreaterThan(0);
    expect(pendingJournals()).toHaveLength(1);
    expect(readFileSync(join(memoryDir(dataDir), 'privacy-pending', pendingJournals()[0]), 'utf8')).toBe('{corrupt');
    expect(readFileSync(userMemoryFile(dataDir))).toEqual(originalTruth);
    expect(await audit.exportJsonl()).not.toContain(secret);
    expect(await logger.export()).not.toContain(secret);
    expect(sessions.get('private-session')).toEqual(chatBefore);
    expect(registerMemory).not.toHaveBeenCalled();
    expect(deleteTruth).not.toHaveBeenCalled();
  });

  it('rejects a post-rename reparse journal before privacy truth cleanup', async () => {
    const { secret } = await seedPrivacy();
    const probes: string[] = [];
    const file = join(memoryDir(dataDir), 'privacy-pending', `${createHash('sha256').update('private-session').digest('hex')}.json`);
    const deps = (service as any).deps;
    const originalProbe = deps.probeAttributes;
    deps.probeAttributes = (paths: string[]) => {
      probes.push(...paths);
      return originalProbe(paths).map((value: number, index: number) =>
        paths[index] === file && existsSync(file) ? 16 : value
      );
    };
    const registerMemory = vi.spyOn(service.store, 'registerPrivacyTexts');
    const deleteTruth = vi.spyOn(service.store, 'deleteMemoryEntriesBySession');

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/重解析点|恢复日志/);

    expect(probes.filter((path) => path === file).length).toBeGreaterThanOrEqual(1);
    expect(registerMemory).not.toHaveBeenCalled();
    expect(deleteTruth).not.toHaveBeenCalled();
    expect(sessions.get('private-session')).toBeTruthy();
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).toContain(secret);
  });
});

describe('R8 truth review B5 scope directory enumeration fence', () => {
  it.each(['agents', 'episode-proposals'] as const)('rejects a pre-existing %s junction before list, search or rebuild can enumerate it', (directory) => {
    const { externalFile, externalName } = replaceScopeDirectory('junction', directory);
    const operations = [
      () => service.list(),
      () => service.searchMemory(externalName),
      () => service.rebuildIndex(),
    ];

    for (const operation of operations) expect(operation).toThrow(/链接|重解析点|目录/);

    expect(readFileSync(externalFile, 'utf8')).toBe(JSON.stringify({ version: 1, entries: [] }));
    expect(events.flatMap((event) => JSON.stringify(event.payload))).not.toContain(externalName);
  });

  it.each(['agents', 'episode-proposals'] as const)('rejects a pre-existing %s non-symlink reparse directory before list, search or rebuild can enumerate it', (directory) => {
    const { externalFile, externalName } = replaceScopeDirectory('non-symlink-reparse', directory);
    const operations = [
      () => service.list(),
      () => service.searchMemory(externalName),
      () => service.rebuildIndex(),
    ];

    for (const operation of operations) expect(operation).toThrow(/重解析点|目录/);

    expect(existsSync(externalFile)).toBe(true);
    expect(events.flatMap((event) => JSON.stringify(event.payload))).not.toContain(externalName);
  });
});

describe('R8 privacy preflight regressions', () => {
  it.each(['identity', 'project', 'corrupt'] as const)('R8-P1-5 %s preflight failure changes no truth, journal, audit, logger or chat state', async (kind) => {
    const { secret, excerpt, workspace } = await seedPrivacy();
    const second = join(root, `second-${kind}`);
    mkdirSync(second, { recursive: true });
    const other = service.addMemory({ scope: 'project', workspacePath: second, workspaceKind: 'user', text: 'second project fact', sessionId: 'other-session' });
    if (kind === 'identity' || kind === 'project') {
      const file = projectMemoryFile(second);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (kind === 'identity') parsed.entries[0].id = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).entries[0].id;
      else parsed.projectId = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).projectId;
      writeFileSync(file, JSON.stringify(parsed, null, 2));
    } else {
      writeFileSync(projectMemoryFile(second), '{corrupt');
    }
    const userBefore = readFileSync(userMemoryFile(dataDir));
    const projectBefore = readFileSync(projectMemoryFile(workspace));
    const secondBefore = readFileSync(projectMemoryFile(second));
    const auditBefore = await audit.exportJsonl();
    const logBefore = await logger.export();
    const chatBefore = sessions.get('private-session');
    expect(other.id).toBeTruthy();

    expect(() => service.privacyDeleteBySession('private-session')).toThrow();

    expect(readFileSync(userMemoryFile(dataDir))).toEqual(userBefore);
    expect(readFileSync(projectMemoryFile(workspace))).toEqual(projectBefore);
    expect(readFileSync(projectMemoryFile(second))).toEqual(secondBefore);
    expect(await audit.exportJsonl()).toBe(auditBefore);
    expect(await logger.export()).toBe(logBefore);
    expect(sessions.get('private-session')).toEqual(chatBefore);
    expect(pendingJournals()).toEqual([]);
    expect(JSON.stringify(await audit.query({}))).toContain(secret);
    expect(await logger.export()).toContain(excerpt);
  });
});

describe('R8 final-round5 privacy B2/B3 production fences', () => {
  it('re-fences a privacy journal before zeroing even when cleanup already verified its identity', async () => {
    const { secret } = await seedPrivacy();
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected pending journal'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    const journal = join(memoryDir(dataDir), 'privacy-pending', pendingJournals()[0]);
    const external = join(root, 'external-zero-victim.txt');
    const externalBytes = 'EXTERNAL_ZERO_VICTIM_71C';
    writeFileSync(external, externalBytes);
    const actual = (service as any).assertPrivacyPathSafe.bind(service);
    let journalFences = 0;
    let journalZeroedBeforeReplacement = false;
    (service as any).assertPrivacyPathSafe = (path: string) => {
      if (path === journal) {
        journalFences += 1;
        if (journalFences === 2) {
          journalZeroedBeforeReplacement = readFileSync(journal).every((byte) => byte === 0);
          rmSync(journal, { force: true });
          linkSync(external, journal);
        }
      }
      return actual(path);
    };

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/清理失败|链接|重解析/);
    expect(journalFences).toBeGreaterThanOrEqual(2);
    expect(journalZeroedBeforeReplacement).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    expect(lstatSync(journal, { bigint: true }).nlink).toBe(2n);
    expect(pendingJournals()).toHaveLength(1);
    expect(existsSync(join(memoryDir(dataDir), '.privacy-write-block.json'))).toBe(true);
  });

  it('zeroizes an existing privacy journal immediately before replacing it on retry', async () => {
    const { secret } = await seedPrivacy();
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected retry fence'); });
    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    const pendingBefore = pendingJournals();
    expect(pendingBefore).toHaveLength(1);
    const journal = join(memoryDir(dataDir), 'privacy-pending', pendingBefore[0]);
    expect(existsSync(journal)).toBe(true);

    let destinationZeroedBeforeRemove = false;
    let destinationRemoveCalls = 0;
    service.close();
    service = makeService({
      removePath: (path, options) => {
        if (path === journal) {
          const bytes = readFileSync(path);
          destinationZeroedBeforeRemove = bytes.length > 0 && bytes.every((byte) => byte === 0);
          destinationRemoveCalls += 1;
        }
        rmSync(path, options);
      },
    });

    expect(destinationZeroedBeforeRemove).toBe(true);
    expect(destinationRemoveCalls).toBeGreaterThanOrEqual(1);
    expect(pendingJournals()).toEqual([]);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
  });

  it('fences a real ancestor junction before Pi carrier deletion and retries normally after it is removed', async () => {
    const { secret } = await seedPrivacy();
    const localDir = join(root, 'carrier-junction');
    const carrierDir = join(root, 'carrier-junction-backing');
    const externalDir = join(root, 'carrier-external');
    mkdirSync(localDir);
    const piFile = join(localDir, 'session.jsonl');
    writeFileSync(piFile, `${secret}\n`);
    mkdirSync(externalDir, { recursive: true });
    const victim = join(externalDir, 'session.jsonl');
    const victimBytes = 'EXTERNAL_PI_JUNCTION_VICTIM_71C';
    writeFileSync(victim, victimBytes);
    renameSync(localDir, carrierDir);
    symlinkSync(externalDir, localDir, 'junction');
    sessions.update('private-session', { piSessionFile: piFile });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/链接|重解析/);
    expect(readFileSync(victim, 'utf8')).toBe(victimBytes);
    expect(existsSync(piFile)).toBe(true);
    expect(pendingJournals()).toHaveLength(1);
    expect(sessions.get('private-session')).toBeTruthy();

    rmSync(localDir, { recursive: true });
    mkdirSync(localDir);
    writeFileSync(piFile, `${secret}\n`);
    expect(() => service.privacyDeleteBySession('private-session')).not.toThrow();
    expect(existsSync(piFile)).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe(victimBytes);
    expect(pendingJournals()).toEqual([]);
  });

  it.runIf(process.platform === 'win32').each(['directory', 'file'] as const)('fences a non-symlink reparse Pi carrier %s before rmSync', async (where) => {
    const { secret } = await seedPrivacy();
    const carrierDir = join(root, `carrier-reparse-${where}`);
    mkdirSync(carrierDir);
    const piFile = join(carrierDir, 'session.jsonl');
    const carrierBytes = `LOCAL_PI_CARRIER_${where}_71C`;
    writeFileSync(piFile, carrierBytes);
    sessions.update('private-session', { piSessionFile: piFile });
    nativeProbeHarness.reparseTarget = where === 'directory' ? carrierDir : piFile;

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/重解析/);
    expect(readFileSync(piFile, 'utf8')).toBe(carrierBytes);
    expect(pendingJournals()).toHaveLength(1);
    expect(sessions.get('private-session')).toBeTruthy();
  });

  it.each(['retry', 'restart'] as const)('detects Pi carrier identity replacement before deletion and preserves external bytes across %s', async (recovery) => {
    const { secret } = await seedPrivacy();
    const piFile = join(root, `identity-carrier-${recovery}.jsonl`);
    const external = join(root, `external-identity-carrier-${recovery}.txt`);
    const externalBytes = `EXTERNAL_PI_IDENTITY_VICTIM_${recovery}_71C`;
    writeFileSync(piFile, `${secret}\n`);
    writeFileSync(external, externalBytes);
    sessions.update('private-session', { piSessionFile: piFile });
    const actual = (service as any).assertPrivacyPathSafe.bind(service);
    let carrierFences = 0;
    (service as any).assertPrivacyPathSafe = (path: string) => {
      if (path === piFile) {
        carrierFences += 1;
        if (carrierFences === 2) {
          rmSync(piFile, { force: true });
          linkSync(external, piFile);
        }
      }
      return actual(path);
    };

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/硬链接|身份|清理失败/);
    expect(carrierFences).toBeGreaterThanOrEqual(2);
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    expect(pendingJournals()).toHaveLength(1);
    expect(sessions.get('private-session')).toBeTruthy();

    if (recovery === 'restart') {
      service.close();
      service = makeService();
      expect(readFileSync(external, 'utf8')).toBe(externalBytes);
      expect(pendingJournals()).toHaveLength(1);
      expect(sessions.get('private-session')).toBeTruthy();
    }
    rmSync(piFile, { force: true });
    writeFileSync(piFile, `${secret}\n`);
    if (recovery === 'restart') {
      service.close();
      service = makeService();
    } else {
      expect(() => service.privacyDeleteBySession('private-session')).not.toThrow();
    }
    expect(readFileSync(external, 'utf8')).toBe(externalBytes);
    expect(existsSync(piFile)).toBe(false);
    expect(pendingJournals()).toEqual([]);
    expect(sessions.get('private-session')).toBeUndefined();
  });
});
