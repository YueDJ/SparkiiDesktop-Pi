import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore } from '@sparkii/approval';
import { ApprovalGate, type Proposal } from '@sparkii/approval';
import { Rbac } from '@sparkii/identity';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';
import { ErrorStore } from '../electron/main/error-store.js';
import { Logger } from '../electron/main/logger.js';
import { handleMemoryToolAction } from '../electron/main/memory/tools.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { memoryDbPath, projectMemoryFile, projectRegistryFile, removeProjectRef, userMemoryFile, episodesFile, workspacePathKey } from '../electron/main/memory/settings.js';
import { parseMemoryFile, parseProjectMemoryFile } from '../electron/main/memory/store.js';

let root: string;
let dataDir: string;
let service: MemoryService;
let errors: ErrorStore;
let audit: AuditStore;
let gate: ApprovalGate;
let sessions: ChatSessionStore;
let logger: Logger;
let events: Array<{ type: string; payload: Record<string, unknown> }>;
let failChatCleanup = false;

beforeEach(() => {
  failChatCleanup = false;
  root = mkdtempSync(join(tmpdir(), 'sparkii-r7-memory-'));
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
  service = new MemoryService({
    dataDir, errors, logger, audit, gate,
    sessionExists: (id) => Boolean(sessions.get(id)),
    sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
    workspacePathOf: (id) => sessions.get(id)?.workspacePath,
    workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
    probeAttributes: (paths) => paths.map(() => 0),
    deleteChatSession: (id, texts) => {
      if (failChatCleanup) throw new Error('injected chat cleanup failure');
      sessions.privacyDelete(id, texts);
    },
    emit: (type, payload) => events.push({ type, payload }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  service.close();
  sessions.close();
  audit.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function databaseBytes(path: string): string {
  return [path, `${path}-wal`, `${path}-shm`]
    .filter(existsSync)
    .map((file) => readFileSync(file).toString('utf8'))
    .join('\n');
}

function restartService(): void {
  service.close();
  service = new MemoryService({
    dataDir, errors, logger, audit, gate,
    sessionExists: (id) => Boolean(sessions.get(id)),
    sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
    workspacePathOf: (id) => sessions.get(id)?.workspacePath,
    workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
    probeAttributes: (paths) => paths.map(() => 0),
    deleteChatSession: (id, texts) => sessions.privacyDelete(id, texts),
    emit: (type, payload) => events.push({ type, payload }),
  });
}

function project(workspace: string, text: string, sessionId = 'source-session') {
  mkdirSync(workspace, { recursive: true });
  return service.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text, sessionId });
}

function seedTruthAuthorizationProjects(sessionId: string) {
  const autoWorkspace = join(root, 'truth-a-auto-workspace');
  const registeredWorkspace = join(root, 'truth-a-registered-workspace');
  const indexedWorkspace = join(root, 'truth-a-indexed-workspace');
  const autoId = 'mem_truth_a_auto_workspace';
  const autoText = 'UNTRUSTED_AUTO_WORKSPACE_TRUTH_71C';
  sessions.create({
    id: sessionId, profileId: 'general', workspaceKind: 'auto', workspacePath: autoWorkspace,
    inputs: JSON.stringify({ text: autoText }),
  });
  const registered = project(registeredWorkspace, 'REGISTERED_TRUTH_SOURCE_71C', sessionId);
  const indexed = project(indexedWorkspace, 'INDEXED_TRUTH_SOURCE_71C', sessionId);
  removeProjectRef(dataDir, indexedWorkspace);
  mkdirSync(join(autoWorkspace, '.sparkii'), { recursive: true });
  writeFileSync(projectMemoryFile(autoWorkspace), `${JSON.stringify({
    version: 1,
    projectId: 'proj_truth_a_auto_workspace',
    entries: [{
      id: autoId, text: autoText, status: 'active', pinned: false, importance: 2,
      createdAt: 1, updatedAt: 1,
      source: { sessionId, excerpt: autoText, kind: 'extracted' },
      supersededBy: null, pendingOp: null,
    }],
  }, null, 2)}\n`);
  expect(service.store.recoverableProjectWorkspaces()
    .some((workspace) => workspacePathKey(workspace) === workspacePathKey(autoWorkspace))).toBe(false);
  return { autoWorkspace, registeredWorkspace, indexedWorkspace, autoId, autoText, registered, indexed };
}

describe('R7 memory regressions', () => {
  it('R7-P1-1 privacy deletion scrubs every retained approval state, cross-session audit, JSONL and SQLite files', async () => {
    const memoryText = 'PRIVATE_MEMORY_92F3C';
    const excerptText = 'PRIVATE_EXCERPT_6E21A';
    const proposedText = 'PRIVATE_PROPOSED_B47D2';
    const queryText = memoryText;
    const active = service.addMemory({ scope: 'user', text: memoryText, sessionId: 'private-session', excerpt: excerptText });
    service.addMemory({
      scope: 'user', text: 'pending carrier', sessionId: 'private-session', excerpt: excerptText,
      status: 'pending', pendingOp: { op: 'ADD', proposedText },
    });
    service.addMemory({ scope: 'user', text: memoryText, sessionId: 'other-session', excerpt: proposedText });
    service.store.appendEpisode({
      sessionId: 'private-session', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: memoryText, topics: [excerptText],
    });
    service.store.appendEpisode({
      sessionId: 'other-session', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: queryText, topics: [proposedText],
    });
    errors.append({ id: 'private-error', message: `${memoryText} ${excerptText} ${proposedText}`, source: 'memory.test', createdAt: Date.now() });
    sessions.create({ id: 'private-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: proposedText }) });
    sessions.create({ id: 'other-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: memoryText }) });
    service.addMemory({
      scope: 'episode:other-session', text: 'surviving pending proposal', sessionId: 'other-session',
      status: 'pending', pendingOp: {
        op: 'EPISODE_UPDATE', targetId: 'other-session', proposedText: 'surviving pending proposal',
        idempotencyKey: `episode:other-session:${proposedText}`,
      },
    });
    const sessionFile = join(root, 'private-session.jsonl');
    writeFileSync(sessionFile, `${memoryText}\n`);
    sessions.update('private-session', { piSessionFile: sessionFile });
    await logger.log({ level: 'info', msg: memoryText, ctx: { sessionId: 'private-session', detail: proposedText } });
    await logger.log({ level: 'info', msg: 'other session diagnostic', ctx: { sessionId: 'other-session', detail: excerptText } });

    const proposals: Proposal[] = [];
    for (const status of ['pending', 'approved', 'denied', 'expired', 'executed', 'failed'] as const) {
      const proposal = await gate.submit({
        requestId: `request-${status}`, toolName: 'memory_forget', targetSystem: 'memory',
        summary: `${status} ${memoryText}`, preview: { kind: 'text', lines: [proposedText] },
        payload: { ids: [active.id], query: queryText, nested: { excerpt: excerptText } },
        risk: 'high-risk', executionMode: 'caller',
      }, { profileId: 'general', sessionId: status === 'pending' ? 'other-session' : 'private-session', actor: 'agent' });
      const retained = {
        ...proposal, status,
        decisionNote: proposedText,
        execution: { ok: status === 'executed', result: { text: memoryText }, error: excerptText },
      } as Proposal;
      (gate as unknown as { proposals: Map<string, Proposal> }).proposals.set(proposal.id, retained);
      proposals.push(retained);
    }
    await audit.append({ actor: 'other-actor', action: 'cross.session', resource: 'memory', payloadSummary: `${queryText} ${proposedText}`, sessionId: 'other-session' });
    const toolResult = await handleMemoryToolAction({
      requestId: 'forget-request', toolName: 'memory_forget', args: { query: queryText },
    }, {
      service, audit, actor: 'agent', sessionId: 'private-session', profileId: 'general',
      propose: async (request) => {
        const proposal = await gate.submit(request, { profileId: 'general', sessionId: 'private-session', actor: 'agent' });
        return { approved: false, proposalId: proposal.id, status: proposal.status };
      },
      proposalOf: (id) => gate.get(id),
      assertOwner: () => {},
    });
    expect(toolResult.status).toBe('executed');

    service.privacyDeleteBySession('private-session');

    const survivingEpisode = service.store.db.prepare('SELECT summary, topics FROM episodes WHERE session_id = ?').get('other-session');
    expect(JSON.stringify(survivingEpisode)).not.toContain(memoryText);
    expect(JSON.stringify(survivingEpisode)).not.toContain(proposedText);
    if (service.ftsAvailable) {
      const episodeFts = service.store.db.prepare('SELECT session_id, summary, topics FROM episodes_fts').all();
      expect(JSON.stringify(episodeFts)).not.toContain(memoryText);
      expect(JSON.stringify(episodeFts)).not.toContain(excerptText);
      expect(JSON.stringify(episodeFts)).not.toContain(proposedText);
    }
    expect(service.store.db.prepare("SELECT content_hash FROM scope_files WHERE file_ref = 'episodes'").get())
      .toEqual({ content_hash: createHash('sha256').update(readFileSync(episodesFile(dataDir))).digest('hex') });
    for (const path of [memoryDbPath(dataDir), join(dataDir, 'errors.db'), join(dataDir, 'sessions.db'), join(dataDir, 'audit.db')]) {
      const bytes = databaseBytes(path);
      expect(bytes, path).not.toContain(memoryText);
      expect(bytes, path).not.toContain(excerptText);
      expect(bytes, path).not.toContain(proposedText);
    }

    expect(service.searchMemory(memoryText, { includeHistory: true })).toEqual([]);
    expect(service.store.listEpisodes().map((episode) => episode.sessionId)).toEqual(['other-session']);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(memoryText);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(proposedText);
    expect(service.list().pending).toHaveLength(1);
    expect(service.list().pending[0]?.source?.sessionId).toBe('other-session');
    expect(service.list().pending[0]?.pendingOp?.idempotencyKey).not.toContain(proposedText);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(memoryText);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(excerptText);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(proposedText);
    expect(existsSync(sessionFile)).toBe(false);
    expect(sessions.get('private-session')).toBeUndefined();
    const auditRows = await audit.query({});
    expect(auditRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows)).not.toContain(queryText);
    expect(await audit.exportJsonl()).not.toContain(proposedText);
    for (const proposal of proposals) {
      const retained = gate.get(proposal.id)!;
      expect(retained.status).toBe(proposal.status);
      expect(JSON.stringify(retained)).not.toContain(memoryText);
      expect(JSON.stringify(retained)).not.toContain(excerptText);
      expect(JSON.stringify(retained)).not.toContain(proposedText);
    }
    expect(sessions.get('other-session')?.inputs).not.toContain(memoryText);
    expect(errors.list().map((event) => event.message).join('\n')).not.toContain(excerptText);
    expect(await logger.export()).not.toContain(proposedText);
    for (const path of [memoryDbPath(dataDir), join(dataDir, 'errors.db'), join(dataDir, 'sessions.db'), join(dataDir, 'audit.db')]) {
      const bytes = databaseBytes(path);
      expect(bytes, path).not.toContain(memoryText);
      expect(bytes, path).not.toContain(excerptText);
      expect(bytes, path).not.toContain(proposedText);
    }
  });

  it('R7 privacy retry recovers an empty episode topic after restart and completes chat cleanup', () => {
    const secret = 'EMPTY_TOPIC_CHAT_SECRET_47B9';
    const target = service.addMemory({ scope: 'user', text: 'delete me', sessionId: 'private-session' });
    service.addMemory({ scope: 'user', text: `surviving ${secret}`, sessionId: 'other-session' });
    service.store.appendEpisode({
      sessionId: 'private-session', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: 'episode', topics: ['', secret],
    });
    sessions.create({ id: 'private-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: secret });
    sessions.create({ id: 'other-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: secret });
    failChatCleanup = true;
    expect(() => service.deleteMemory(target.id, { mode: 'privacy' })).toThrow('injected chat cleanup failure');

    service.close();
    failChatCleanup = false;
    service = new MemoryService({
      dataDir, errors, logger, audit, gate,
      sessionExists: (id) => Boolean(sessions.get(id)),
      sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
      workspacePathOf: (id) => sessions.get(id)?.workspacePath,
      workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
      probeAttributes: (paths) => paths.map(() => 0),
      deleteChatSession: (id, texts) => sessions.privacyDelete(id, texts),
      emit: (type, payload) => events.push({ type, payload }),
    });
    expect(() => service.addMemory({ scope: 'user', text: 'blocked', sessionId: 'private-session' })).toThrow();
    expect(() => service.deleteMemory(target.id, { mode: 'privacy' })).not.toThrow();
    expect(sessions.get('private-session')).toBeUndefined();
    expect(sessions.get('other-session')?.inputs).not.toContain(secret);
    expect(databaseBytes(join(dataDir, 'sessions.db'))).not.toContain(secret);
    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('R7 privacy deletion discovers secrets nested only in pending operation extensions', () => {
    const secret = 'NESTED_PENDING_ONLY_SECRET_83C1';
    service.addMemory({
      scope: 'user', text: 'pending carrier', sessionId: 'private-session', status: 'pending',
      pendingOp: { op: 'ADD', proposedText: 'safe proposal', extension: { nested: [secret], targetId: secret } },
    });
    service.addMemory({ scope: 'user', text: `surviving ${secret}`, sessionId: 'other-session' });
    sessions.create({ id: 'other-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: secret });

    service.privacyDeleteBySession('private-session');

    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
    expect(sessions.get('other-session')?.inputs).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(databaseBytes(join(dataDir, 'sessions.db'))).not.toContain(secret);
  });

  it.each([
    ['targetId', { nested: ['STRUCTURAL_TARGET_SECRET_51D8'] }],
    ['projectId', { nested: ['STRUCTURAL_PROJECT_SECRET_51D8'] }],
    ['mergeIds', { nested: ['STRUCTURAL_MERGE_SECRET_51D8'] }],
  ])('R7 privacy deletion scrubs an invalid structural %s field', async (field, invalidValue) => {
    const secret = Array.isArray(invalidValue.nested) ? invalidValue.nested[0] : '';
    service.addMemory({
      scope: 'user', text: 'invalid pending carrier', sessionId: 'private-session', status: 'pending',
      pendingOp: { op: 'ADD', [field]: invalidValue } as any,
    });
    service.addMemory({ scope: 'user', text: `surviving ${secret}`, sessionId: 'other-session' });
    sessions.create({ id: 'other-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: secret });
    await audit.append({ actor: 'agent', action: 'invalid.structural', resource: 'memory', payloadSummary: secret, sessionId: 'other-session' });
    await gate.submit({
      requestId: `invalid-${field}`, toolName: 'memory_forget', targetSystem: 'memory',
      summary: secret, preview: { kind: 'text', lines: [secret] },
      payload: { nested: secret }, risk: 'high-risk', executionMode: 'caller',
    }, { profileId: 'general', sessionId: 'other-session', actor: 'agent' });

    service.privacyDeleteBySession('private-session');

    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
    expect(sessions.get('other-session')?.inputs).not.toContain(secret);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(JSON.stringify(gate.listPending())).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(databaseBytes(join(dataDir, 'sessions.db'))).not.toContain(secret);
    expect(databaseBytes(join(dataDir, 'audit.db'))).not.toContain(secret);
  });

  it('R7 privacy deletion ignores whitespace-only episode topics without corrupting retained content', async () => {
    const target = service.addMemory({ scope: 'user', text: 'delete me', sessionId: 'private-session' });
    const retainedText = 'keep these ordinary spaces unchanged';
    service.addMemory({ scope: 'user', text: retainedText, sessionId: 'other-session' });
    service.store.appendEpisode({
      sessionId: 'private-session', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: 'episode', topics: [' ', '\t', '\n'],
    });
    sessions.create({ id: 'other-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: retainedText });
    await audit.append({ actor: 'agent', action: 'whitespace.retained', resource: 'memory', payloadSummary: retainedText, sessionId: 'other-session' });

    expect(() => service.privacyDeleteBySession('private-session')).not.toThrow();

    expect(service.store.rowFor(target.id)).toBeUndefined();
    expect(service.list().scopes.flatMap((scope) => scope.entries).find((entry) => entry.text === retainedText)?.text).toBe(retainedText);
    expect(sessions.get('other-session')?.inputs).toBe(retainedText);
    expect((await audit.query({})).find((entry) => entry.action === 'whitespace.retained')?.payloadSummary).toBe(retainedText);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).toContain(retainedText);
  });

  it('R7 privacy deletion preserves pending UPDATE control fields when deleted text equals the op', () => {
    const target = service.addMemory({ scope: 'user', text: 'original target', sessionId: 'target-session' });
    service.addMemory({ scope: 'user', text: 'UPDATE', sessionId: 'private-session' });
    const pending = service.addMemory({
      scope: 'user', text: 'pending update', sessionId: 'other-session', status: 'pending',
      pendingOp: { op: 'UPDATE', targetId: target.id, proposedText: 'replacement text' },
    });

    service.privacyDeleteBySession('private-session');
    expect(service.list().pending.find((entry) => entry.id === pending.id)?.pendingOp?.op).toBe('UPDATE');
    service.resolvePending(pending.id, 'approve');

    expect(service.store.rowFor(target.id)?.text).toBe('replacement text');
    expect(service.store.rowFor(pending.id)).toBeUndefined();
  });

  it('R7 privacy retry after process restart retains the deleted text corpus until session cleanup succeeds', async () => {
    const secret = 'PRIVATE_RETRY_CORPUS_83D19';
    const otherSecret = 'PRIVATE_OTHER_CARRIER_27B4A';
    const target = service.addMemory({ scope: 'user', text: 'target memory body', sessionId: 'retry-session' });
    service.store.appendEpisode({
      sessionId: 'retry-session', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: secret, topics: [otherSecret],
    });
    sessions.create({ id: 'retry-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: secret }) });
    sessions.create({ id: 'other-retry', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: otherSecret }) });
    const sessionFile = join(root, 'retry-session.jsonl');
    writeFileSync(sessionFile, `${secret}\n`);
    sessions.update('retry-session', { piSessionFile: sessionFile });

    let failCleanup = true;
    const makeService = () => new MemoryService({
      dataDir, errors, logger, audit, gate,
      sessionExists: (id) => Boolean(sessions.get(id)),
      sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
      workspacePathOf: (id) => sessions.get(id)?.workspacePath,
      workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
      probeAttributes: (paths) => paths.map(() => 0),
      deleteChatSession: (id, texts) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('injected chat cleanup failure');
        }
        sessions.privacyDelete(id, texts);
      },
      emit: (type, payload) => events.push({ type, payload }),
    });
    service.close();
    service = makeService();

    expect(() => service.deleteMemory(target.id, { mode: 'privacy' })).toThrow(/injected chat cleanup failure/);
    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(existsSync(sessionFile)).toBe(false);
    expect(() => service.searchMemory(secret, { includeHistory: true })).toThrow('隐私删除尚未完成');
    expect(sessions.get('other-retry')?.inputs).toContain(otherSecret);

    service.close();
    service = makeService();
    expect(() => service.addMemory({ scope: 'user', text: 'must stay blocked', sessionId: 'retry-session' }))
      .toThrow('来源会话已删除，不能写入记忆');
    expect(service.deleteMemory(target.id, { mode: 'privacy' })).toMatchObject({ ok: true });

    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(sessions.get('retry-session')).toBeUndefined();
    expect(sessions.get('other-retry')?.inputs).not.toContain(otherSecret);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(await logger.export()).not.toContain(otherSecret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(otherSecret);
  });

  it('R7 privacy deletion includes superseded episode records in the global redaction corpus', async () => {
    const oldSecret = 'PRIVATE_OLD_EPISODE_64A2F';
    const oldTopic = 'PRIVATE_OLD_TOPIC_38B7D';
    const target = service.addMemory({ scope: 'user', text: 'unrelated target body', sessionId: 'old-episode-session' });
    service.store.appendEpisode({
      sessionId: 'old-episode-session', agentId: 'general', workspacePath: '', ts: 1,
      summary: oldSecret, topics: [oldTopic],
    });
    service.store.appendEpisode({
      sessionId: 'old-episode-session', agentId: 'general', workspacePath: '', ts: 2,
      summary: 'new episode without the old secret', topics: ['new topic'],
    });
    service.store.appendEpisode({
      sessionId: 'carrier-session', agentId: 'general', workspacePath: '', ts: 3,
      summary: oldSecret, topics: [oldTopic],
    });
    sessions.create({ id: 'carrier-session', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: oldSecret }) });
    const proposal = await gate.submit({
      requestId: 'old-episode-proposal', toolName: 'memory_forget', targetSystem: 'memory',
      summary: oldSecret, preview: { kind: 'text', lines: [oldTopic] },
      payload: { ids: [target.id], nested: { text: oldSecret } }, risk: 'high-risk', executionMode: 'caller',
    }, { profileId: 'general', sessionId: 'carrier-session', actor: 'agent' });
    await audit.append({ actor: 'agent', action: 'cross.session', resource: 'memory', payloadSummary: oldSecret, sessionId: 'carrier-session' });
    errors.append({ id: 'old-episode-error', message: oldTopic, source: 'memory.test', createdAt: Date.now() });
    await logger.log({ level: 'info', msg: 'carrier diagnostic', ctx: { sessionId: 'carrier-session', detail: oldSecret } });

    service.deleteMemory(target.id, { mode: 'privacy' });

    expect(JSON.stringify(gate.get(proposal.id))).not.toContain(oldSecret);
    expect(JSON.stringify(gate.get(proposal.id))).not.toContain(oldTopic);
    expect(JSON.stringify(await audit.query({}))).not.toContain(oldSecret);
    expect(errors.list().map((event) => event.message).join('\n')).not.toContain(oldTopic);
    expect(await logger.export()).not.toContain(oldSecret);
    expect(sessions.get('carrier-session')?.inputs).not.toContain(oldSecret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(oldSecret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(oldTopic);
    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(oldSecret);
    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(oldTopic);
  });

  it('R7 caller-mode memory deletion rechecks canonical approval after privacy redaction', async () => {
    const secret = 'PRIVATE_CALLER_APPROVAL_73E9B';
    const target = service.addMemory({ scope: 'user', text: secret, sessionId: 'caller-session' });
    let proposalId = '';
    const invalidated: string[] = [];
    gate.onProposalInvalidated((proposal) => invalidated.push(proposal.id));
    const out = await handleMemoryToolAction({
      requestId: 'caller-forget', toolName: 'memory_forget', args: { query: secret },
    }, {
      service, audit, actor: 'agent', sessionId: 'caller-session', profileId: 'general',
      propose: async (request) => {
        const proposal = await gate.submit(request, { profileId: 'general', sessionId: 'caller-session', actor: 'agent' });
        proposalId = proposal.id;
        await gate.decide(proposal.id, { userId: 'admin', roles: ['admin'] }, true);
        gate.redactTexts([secret]);
        return { approved: true, proposalId: proposal.id, status: 'approved' };
      },
      proposalOf: (id) => gate.get(id),
      assertOwner: () => {},
    });

    expect(out.result).toMatchObject({ ok: false });
    expect(service.store.rowFor(target.id)).toBeTruthy();
    expect(gate.get(proposalId)?.privacyRedacted).toBe(true);
    expect(invalidated).toEqual([proposalId]);
    expect((await audit.query({ action: 'memory.forget' })).map((event) => event.decision)).toContain('denied');
  });

  it('R7 production privacy retry succeeds in the same process after truth rows are gone', async () => {
    const secret = 'PRIVATE_SAME_PROCESS_RETRY_19C7A';
    const carrier = 'PRIVATE_SAME_PROCESS_CARRIER_62D8E';
    const target = service.addMemory({ scope: 'user', text: 'retry body', sessionId: 'same-process-retry', excerpt: secret });
    sessions.create({ id: 'same-process-retry', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: secret }) });
    sessions.create({ id: 'same-process-carrier', profileId: 'general', workspaceKind: 'auto', workspacePath: '', inputs: JSON.stringify({ text: carrier }) });
    service.store.appendEpisode({
      sessionId: 'same-process-retry', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: carrier, topics: [secret],
    });
    service.store.appendEpisode({
      sessionId: 'same-process-carrier', agentId: 'general', workspacePath: '', ts: Date.now(),
      summary: carrier, topics: [secret],
    });
    await audit.append({ actor: 'agent', action: 'cross.session', resource: 'memory', payloadSummary: secret, sessionId: 'same-process-carrier' });
    await logger.log({ level: 'info', msg: 'same process carrier', ctx: { sessionId: 'same-process-carrier', detail: carrier } });
    let failCleanup = true;
    const retryService = new MemoryService({
      dataDir, errors, logger, audit, gate,
      sessionExists: (id) => Boolean(sessions.get(id)),
      sessionFileOf: (id) => sessions.rawPiSessionFile(id, true),
      workspacePathOf: (id) => sessions.get(id)?.workspacePath,
      workspacePathsOf: () => sessions.list().map((session) => session.workspacePath),
      probeAttributes: (paths) => paths.map(() => 0),
      deleteChatSession: (id, texts) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error('injected same-process cleanup failure');
        }
        sessions.privacyDelete(id, texts);
      },
      emit: (type, payload) => events.push({ type, payload }),
    });
    service.close();
    service = retryService;

    expect(() => service.deleteMemory(target.id, { mode: 'privacy' })).toThrow(/injected same-process cleanup failure/);
    expect(() => service.store.indexedRowFor(target.id)).toThrow('隐私删除尚未完成');
    expect(() => service.store.privacyRecoveryFor(target.id)).toThrow('隐私删除尚未完成');
    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(service.deleteMemory(target.id, { mode: 'privacy' })).toMatchObject({ ok: true });
    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(sessions.get('same-process-retry')).toBeUndefined();
    expect(sessions.get('same-process-carrier')?.inputs).not.toContain(carrier);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(secret);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(await logger.export()).not.toContain(carrier);
    expect(() => service.addMemory({ scope: 'user', text: 'blocked', sessionId: 'same-process-retry' }))
      .toThrow('来源会话已删除，不能写入记忆');
  });

  it('R7-P1-1 future memory-tool audit summaries contain no raw query or memory body', async () => {
    const secret = 'RAW_QUERY_MUST_NOT_BE_AUDITED_51C8';
    service.addMemory({ scope: 'user', text: secret, sessionId: 'private-session' });
    await handleMemoryToolAction({ requestId: 'search-request', toolName: 'memory_search', args: { query: secret } }, {
      service, audit, actor: 'agent', sessionId: 'private-session', profileId: 'general',
      propose: async () => { throw new Error('not used'); },
      proposalOf: () => undefined,
      assertOwner: () => {},
    });
    await handleMemoryToolAction({ requestId: 'forget-request', toolName: 'memory_forget', args: { query: secret } }, {
      service, audit, actor: 'agent', sessionId: 'private-session', profileId: 'general',
      propose: async () => ({ approved: false, proposalId: 'denied', status: 'denied' }),
      proposalOf: () => undefined,
      assertOwner: () => {},
    });
    const summaries = (await audit.query({ action: 'memory.search' })).map((event) => event.payloadSummary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toContain(secret);
    expect(summaries[0]).toMatch(/length|sha256|count/i);
    expect(JSON.stringify(await audit.query({ action: 'memory.forget' }))).not.toContain(secret);
  });

  it('R7-P1-2 replacement repair rejects a duplicate memory id before changing corrupt truth bytes', () => {
    const workspace = join(root, 'repair-duplicate-id');
    project(workspace, 'original project fact');
    const originalProjectId = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).projectId;
    const userEntry = service.addMemory({ scope: 'user', text: 'existing user fact' });
    const broken = '{ corrupt truth\n';
    writeFileSync(projectMemoryFile(workspace), broken);
    const replacement = JSON.stringify({
      version: 1, projectId: originalProjectId,
      entries: [{ ...parseMemoryFile(readFileSync(userMemoryFile(dataDir), 'utf8'), userMemoryFile(dataDir)).entries[0], id: userEntry.id, text: 'replacement duplicate' }],
    });

    expect(() => service.repairProjectMemory(workspace, 'replace', replacement)).toThrow(/记忆 id/);
    expect(readFileSync(projectMemoryFile(workspace), 'utf8')).toBe(broken);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'repair')).toBe(false);
    expect(service.repairProjectMemory(workspace, 'empty')).toEqual({ ok: true });
    expect(service.repairProjectMemory(workspace, 'replace', JSON.stringify({
      version: 1, projectId: originalProjectId,
      entries: [{ ...parseMemoryFile(readFileSync(userMemoryFile(dataDir), 'utf8'), userMemoryFile(dataDir)).entries[0], id: 'mem_r7_unique_repair', text: 'valid replacement' }],
    }))).toEqual({ ok: true });
    expect(service.searchMemory('valid replacement').map((hit) => hit.id)).toContain('mem_r7_unique_repair');
  });

  it('R7-P1-2 replacement preflight sees an indexed project after its registry entry is removed', () => {
    const workspaceA = join(root, 'repair-indexed-unregistered-a');
    const workspaceB = join(root, 'repair-indexed-unregistered-b');
    project(workspaceA, 'project A before repair');
    const duplicate = project(workspaceB, 'indexed unregistered duplicate');
    const projectAId = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceA), 'utf8'), projectMemoryFile(workspaceA)).projectId;
    removeProjectRef(dataDir, workspaceB);
    expect(service.store.indexedRowFor(duplicate.id)).toBeTruthy();
    expect(service.store.recoverableProjectWorkspaces().some((path) => workspacePathKey(path) === workspacePathKey(workspaceB))).toBe(true);
    const broken = '{ corrupt indexed-unregistered truth\n';
    writeFileSync(projectMemoryFile(workspaceA), broken);
    const replacement = JSON.stringify({
      version: 1, projectId: projectAId,
      entries: [{ ...duplicate, text: 'must not commit' }],
    });

    expect(() => service.repairProjectMemory(workspaceA, 'replace', replacement)).toThrow(/记忆 id/);
    expect(readFileSync(projectMemoryFile(workspaceA), 'utf8')).toBe(broken);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'repair')).toBe(false);
  });

  it('R7-P1-2 replacement preflight derives zero-entry project identity from scope_files', () => {
    const workspaceA = join(root, 'repair-empty-indexed-a');
    const workspaceB = join(root, 'repair-empty-indexed-b');
    project(workspaceA, 'project A before identity repair');
    project(workspaceB, 'temporary indexed project');
    const empty = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceB), 'utf8'), projectMemoryFile(workspaceB));
    writeFileSync(projectMemoryFile(workspaceB), `${JSON.stringify({ ...empty, entries: [] }, null, 2)}\n`);
    service.synchronize();
    expect(service.store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(projectMemoryFile(workspaceB))).toBeTruthy();
    expect(service.store.db.prepare('SELECT id FROM memories WHERE file_ref = ?').all(projectMemoryFile(workspaceB))).toEqual([]);
    removeProjectRef(dataDir, workspaceA);
    removeProjectRef(dataDir, workspaceB);
    expect(service.store.recoverableProjectWorkspaces().some((path) => workspacePathKey(path) === workspacePathKey(workspaceB))).toBe(true);
    const originalA = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceA), 'utf8'), projectMemoryFile(workspaceA));
    const broken = '{ corrupt empty-project identity truth\n';
    writeFileSync(projectMemoryFile(workspaceA), broken);
    const replacement = JSON.stringify({
      ...empty,
      entries: [{ ...originalA.entries[0], id: 'mem_r7_empty_identity', text: 'must not commit' }],
    });

    expect(() => service.repairProjectMemory(workspaceA, 'replace', replacement)).toThrow(/projectId/);
    expect(readFileSync(projectMemoryFile(workspaceA), 'utf8')).toBe(broken);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'repair')).toBe(false);
  });

  it('R7-P1-3 source deletion detects indexed unregistered conflicts without an explicit workspace', () => {
    const workspaceA = join(root, 'source-delete-indexed-a');
    const workspaceB = join(root, 'source-delete-indexed-b');
    const a = project(workspaceA, 'A indexed source fact', 'indexed-delete-session');
    const b = project(workspaceB, 'B indexed source fact', 'indexed-delete-session');
    const parsedB = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceB), 'utf8'), projectMemoryFile(workspaceB));
    parsedB.entries[0].id = a.id;
    writeFileSync(projectMemoryFile(workspaceB), `${JSON.stringify(parsedB, null, 2)}\n`);
    removeProjectRef(dataDir, workspaceB);
    expect(service.store.indexedRowFor(a.id)).toBeTruthy();
    const beforeA = readFileSync(projectMemoryFile(workspaceA));
    const beforeB = readFileSync(projectMemoryFile(workspaceB));

    expect(() => service.markSourcesDeleted('indexed-delete-session')).toThrow(/记忆 id/);
    expect(readFileSync(projectMemoryFile(workspaceA))).toEqual(beforeA);
    expect(readFileSync(projectMemoryFile(workspaceB))).toEqual(beforeB);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'source-deleted')).toBe(false);
    expect(service.store.indexedRowFor(b.id)).toBeTruthy();
  });

  it('R7-P1-2 replacement repair rejects a duplicate project identity before changing corrupt truth bytes', () => {
    const workspaceA = join(root, 'repair-identity-a');
    const workspaceB = join(root, 'repair-identity-b');
    project(workspaceA, 'project A');
    project(workspaceB, 'project B');
    const projectB = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceB), 'utf8'), projectMemoryFile(workspaceB));
    removeProjectRef(dataDir, workspaceA);
    const broken = '{ corrupt identity truth\n';
    writeFileSync(projectMemoryFile(workspaceA), broken);
    const replacement = JSON.stringify({
      ...projectB,
      entries: [{ ...projectB.entries[0], id: 'mem_r7_identity_repair', text: 'duplicate identity replacement' }],
    });

    expect(() => service.repairProjectMemory(workspaceA, 'replace', replacement)).toThrow(/projectId/);
    expect(readFileSync(projectMemoryFile(workspaceA), 'utf8')).toBe(broken);
  });

  it('R7-P1-3 source deletion rejects cross-file identity conflicts without changing any truth file', () => {
    const workspaceA = join(root, 'source-delete-a');
    const workspaceB = join(root, 'source-delete-b');
    const a = project(workspaceA, 'A source fact', 'delete-session');
    const b = project(workspaceB, 'B source fact', 'delete-session');
    const parsedA = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceA), 'utf8'), projectMemoryFile(workspaceA));
    const parsedB = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceB), 'utf8'), projectMemoryFile(workspaceB));
    parsedB.entries[0].id = a.id;
    writeFileSync(projectMemoryFile(workspaceB), `${JSON.stringify(parsedB, null, 2)}\n`);
    removeProjectRef(dataDir, workspaceB);
    const beforeA = readFileSync(projectMemoryFile(workspaceA));
    const beforeB = readFileSync(projectMemoryFile(workspaceB));

    expect(() => service.markSourcesDeleted('delete-session', workspaceB)).toThrow(/记忆 id/);
    expect(readFileSync(projectMemoryFile(workspaceA))).toEqual(beforeA);
    expect(readFileSync(projectMemoryFile(workspaceB))).toEqual(beforeB);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'source-deleted')).toBe(false);
    expect(service.store.rowFor(b.id)).toBeUndefined();
  });

  it('R7-P1-3 valid source deletion updates unregistered project truth without reindexing it', () => {
    const workspace = join(root, 'source-delete-unregistered');
    const active = project(workspace, 'UNREGISTERED_SOURCE_FACT_71C', 'delete-session');
    const pending = service.addMemory({
      scope: 'project', workspacePath: workspace, workspaceKind: 'user',
      text: 'pending source carrier', sessionId: 'delete-session', status: 'pending',
      pendingOp: { op: 'ADD', proposedText: 'pending source proposal' },
    });
    expect(service.searchMemory('UNREGISTERED_SOURCE_FACT_71C').map((hit) => hit.id)).toContain(active.id);
    removeProjectRef(dataDir, workspace);

    expect(() => service.markSourcesDeleted('delete-session')).not.toThrow();
    const parsed = parseProjectMemoryFile(
      readFileSync(projectMemoryFile(workspace), 'utf8'),
      projectMemoryFile(workspace),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      id: active.id,
      source: { sessionId: 'delete-session', excerpt: '来源已删除' },
    });
    expect(parsed.entries.some((entry) => entry.id === pending.id)).toBe(false);
    expect(service.store.rowFor(active.id)).toBeUndefined();
    expect(service.store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(projectMemoryFile(workspace))).toBeUndefined();
    expect(service.searchMemory('UNREGISTERED_SOURCE_FACT_71C')).toEqual([]);
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'source-deleted')).toBe(true);
  });

  it('R8-REPAIR-MEMORY truth A1 source deletion ignores auto-list-only truth while updating registered and indexed projects', () => {
    const sessionId = 'truth-a-source-delete';
    const seeded = seedTruthAuthorizationProjects(sessionId);
    const autoBefore = readFileSync(projectMemoryFile(seeded.autoWorkspace));

    expect(() => service.markSourcesDeleted(sessionId)).not.toThrow();

    expect(readFileSync(projectMemoryFile(seeded.autoWorkspace))).toEqual(autoBefore);
    for (const workspace of [seeded.registeredWorkspace, seeded.indexedWorkspace]) {
      const parsed = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].source).toMatchObject({ sessionId, excerpt: '来源已删除' });
    }
    expect(service.store.rowFor(seeded.registered.id)?.text).toBe('REGISTERED_TRUTH_SOURCE_71C');
    expect(service.store.rowFor(seeded.indexed.id)).toBeUndefined();
    expect(events.some((event) => event.type === 'memory_changed' && event.payload.op === 'source-deleted')).toBe(true);
  });

  it('R8-REPAIR-MEMORY truth A2 privacy deletion ignores auto-list-only truth while deleting registered and indexed projects', () => {
    const sessionId = 'truth-a-privacy-delete';
    const seeded = seedTruthAuthorizationProjects(sessionId);
    const autoBefore = readFileSync(projectMemoryFile(seeded.autoWorkspace));

    const result = service.privacyDeleteBySession(sessionId);

    expect(result).toMatchObject({ ok: true });
    expect(result.removed).toEqual(expect.arrayContaining([seeded.registered.id, seeded.indexed.id]));
    expect(result.removed).not.toContain(seeded.autoId);
    expect(readFileSync(projectMemoryFile(seeded.autoWorkspace))).toEqual(autoBefore);
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(seeded.registeredWorkspace), 'utf8'), projectMemoryFile(seeded.registeredWorkspace)).entries).toEqual([]);
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(seeded.indexedWorkspace), 'utf8'), projectMemoryFile(seeded.indexedWorkspace)).entries).toEqual([]);
    expect(sessions.get(sessionId)).toBeUndefined();
    expect(readdirSync(join(dataDir, 'memory', 'privacy-pending')).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('R7-P1-4 privacy deletion discovers indexed unregistered truth before reconciliation', () => {
    const workspace = join(root, 'privacy-indexed-unregistered');
    const added = project(workspace, 'PRIVATE_INDEXED_UNREGISTERED_61D', 'private-indexed-unregistered');
    removeProjectRef(dataDir, workspace);
    expect(service.store.indexedRowFor(added.id)).toBeTruthy();
    expect(service.store.recoverableProjectWorkspaces().some((path) => workspacePathKey(path) === workspacePathKey(workspace))).toBe(true);

    expect(service.privacyDeleteBySession('private-indexed-unregistered')).toMatchObject({ ok: true, removed: [added.id] });
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).entries).toEqual([]);
    expect(service.store.indexedRowFor(added.id)).toBeUndefined();
    expect(readFileSync(projectMemoryFile(workspace), 'utf8')).not.toContain('PRIVATE_INDEXED_UNREGISTERED_61D');
  });

  it('R7-P1-4 unregistered project truth is not searchable but remains discoverable for privacy deletion', () => {
    const workspace = join(root, 'unregistered-r7');
    const added = project(workspace, 'UNREGISTERED_FACT_41A', 'private-unregistered');
    expect(service.searchMemory('UNREGISTERED_FACT_41A').map((hit) => hit.id)).toContain(added.id);
    const registry = JSON.stringify({ version: 1, projects: [] });
    writeFileSync(projectRegistryFile(dataDir), registry);

    expect(service.searchMemory('UNREGISTERED_FACT_41A')).toEqual([]);
    expect(service.list().scopes.some((scope) => scope.projectId === added.projectId)).toBe(false);
    service.deleteMemory(added.id, { mode: 'privacy' });
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).entries).toEqual([]);
  });

  it('R7-P1-4 conflict eviction invalidates the hash and unchanged truth is reindexed after resolution', () => {
    const workspaceA = join(root, 'conflict-index-a');
    const workspaceB = join(root, 'conflict-index-b');
    project(workspaceA, 'A duplicate carrier', 'session-a');
    const b = project(workspaceB, 'B_UNCHANGED_FACT_41A', 'session-b');
    expect(service.searchMemory('B_UNCHANGED_FACT_41A').map((hit) => hit.id)).toContain(b.id);
    const parsedA = parseProjectMemoryFile(readFileSync(projectMemoryFile(workspaceA), 'utf8'), projectMemoryFile(workspaceA));
    parsedA.entries[0].id = b.id;
    writeFileSync(projectMemoryFile(workspaceA), `${JSON.stringify(parsedA, null, 2)}\n`);
    const unchangedB = readFileSync(projectMemoryFile(workspaceB));

    expect(service.searchMemory('B_UNCHANGED_FACT_41A')).toEqual([]);
    expect(service.store.db.prepare('SELECT content_hash FROM scope_files WHERE file_ref = ?').get(projectMemoryFile(workspaceB))).toBeUndefined();
    rmSync(projectMemoryFile(workspaceA));
    removeProjectRef(dataDir, workspaceA);

    expect(readFileSync(projectMemoryFile(workspaceB))).toEqual(unchangedB);
    expect(service.searchMemory('B_UNCHANGED_FACT_41A').map((hit) => hit.id)).toContain(b.id);
    expect(service.list().scopes.flatMap((scope) => scope.entries).find((entry) => entry.id === b.id)?.text).toBe('B_UNCHANGED_FACT_41A');
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspaceB, workspaceKind: 'user' })).toContain('B_UNCHANGED_FACT_41A');
  });
});

describe('R8 privacy B1 invalidation retry integration', () => {
  it('retains the production privacy journal until a failed Gate listener succeeds on retry', async () => {
    const secret = 'R8_SERVICE_LISTENER_RETRY_SECRET_71C';
    const added = service.addMemory({ scope: 'user', text: secret, sessionId: 'private-listener-session' });
    const proposal = await gate.submit({
      requestId: 'memory-listener-retry', toolName: 'memory_forget', targetSystem: 'memory',
      summary: secret, payload: { query: secret }, risk: 'high-risk', executionMode: 'caller',
    }, { profileId: 'general', sessionId: 'private-listener-session', actor: 'agent' });
    let attempts = 0;
    const listener = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('injected listener failure');
    });
    gate.onProposalInvalidated(listener);
    const dir = join(dataDir, 'memory', 'privacy-pending');

    expect(() => service.privacyDeleteBySession('private-listener-session')).toThrow('隐私清理失败');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).toContain(secret);
    expect(() => gate.get(proposal.id)).toThrow(/approval privacy cleanup incomplete/);

    expect(service.privacyDeleteBySession('private-listener-session')).toMatchObject({ ok: true, removed: [added.id] });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
    expect(JSON.stringify(await audit.query({}))).not.toContain(secret);
    expect(gate.get(proposal.id)).toMatchObject({ id: proposal.id, privacyRedacted: true });
  });
});

describe('R8 privacy B2 dynamic pending-operation keys', () => {
  it('collects deleted, survivor and nested dynamic keys, preserves controls, and scrubs later writes after restart', () => {
    const secret = 'DYNAMIC_PENDING_KEY_SECRET_83C1';
    const target = service.addMemory({ scope: 'user', text: 'control target', sessionId: 'target-session' });
    service.addMemory({
      scope: 'user', text: 'deleted key carrier', sessionId: 'private-session', status: 'pending',
      pendingOp: { op: 'ADD', envelope: { [secret]: { payload: 'nested value' } } },
    });
    const survivor = service.addMemory({
      scope: 'user', text: 'surviving key carrier', sessionId: 'other-session', status: 'pending',
      pendingOp: {
        op: 'UPDATE', targetId: target.id, projectId: 'proj_control', proposedText: 'safe proposal',
        [secret]: 'top-level value', nested: { [secret]: 'nested value' },
      },
    });
    vi.spyOn(logger, 'redactSession').mockImplementationOnce(() => { throw new Error('injected dynamic-key retry'); });

    expect(() => service.privacyDeleteBySession('private-session')).toThrow('隐私清理失败');
    const dir = join(dataDir, 'memory', 'privacy-pending');
    const journalName = readdirSync(dir).find((name) => name.endsWith('.json'))!;
    const journal = JSON.parse(readFileSync(join(dir, journalName), 'utf8'));
    expect(journal.texts).toContain(secret);

    restartService();

    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
    const retained = service.list().pending.find((entry) => entry.id === survivor.id)!;
    expect(retained.pendingOp).toMatchObject({
      op: 'UPDATE', targetId: target.id, projectId: 'proj_control', proposedText: 'safe proposal',
    });
    expect(Object.keys(retained.pendingOp!)).not.toContain(secret);
    expect(JSON.stringify(retained.pendingOp)).not.toContain(secret);

    service.addMemory({
      scope: 'user', text: 'future dynamic key', sessionId: 'future-session', status: 'pending',
      pendingOp: { op: 'ADD', [secret]: 'future value', nested: { [secret]: 'future nested' } },
    });
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    restartService();
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
  });

  it('fails closed instead of overwriting two dynamic keys that redact to the same marker', () => {
    const first = 'DYNAMIC_COLLISION_FIRST_83C1';
    const second = 'DYNAMIC_COLLISION_SECOND_92D2';
    service.addMemory({ scope: 'user', text: first, sessionId: 'private-session' });
    service.addMemory({ scope: 'user', text: second, sessionId: 'private-session' });
    service.addMemory({
      scope: 'user', text: 'collision survivor', sessionId: 'other-session', status: 'pending',
      pendingOp: { op: 'ADD', [first]: 'first value', [second]: 'second value' },
    });
    const before = readFileSync(userMemoryFile(dataDir));

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/碰撞|冲突/);
    expect(readFileSync(userMemoryFile(dataDir))).toEqual(before);
    const dir = join(dataDir, 'memory', 'privacy-pending');
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(() => service.list()).toThrow(/隐私删除尚未完成/);
  });
});

describe('R8 round7 privacy structural-field fence', () => {
  it('scrubs legal-looking nested structural fields in survivor and future pending operations', () => {
    const secret = 'NESTED_STRUCTURAL_FIELD_SECRET_94D3';
    service.addMemory({
      scope: 'user', text: 'deleted nested structure', sessionId: 'private-session', status: 'pending',
      pendingOp: { op: 'ADD', extension: { nested: { targetId: secret } } },
    });
    service.addMemory({
      scope: 'user', text: 'surviving nested structure', sessionId: 'other-session', status: 'pending',
      pendingOp: { op: 'ADD', extension: { nested: { targetId: secret } } },
    });

    expect(() => service.privacyDeleteBySession('private-session')).not.toThrow();
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);

    service.addMemory({
      scope: 'user', text: 'future nested structure', sessionId: 'future-session', status: 'pending',
      pendingOp: { op: 'ADD', extension: { nested: { targetId: secret } } },
    });
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    restartService();
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
  });

  it('registers deleted-only top-level structural IDs and scrubs the same value in survivor text', () => {
    const secret = 'DELETED_TOP_LEVEL_STRUCTURAL_SECRET_94D3';
    service.addMemory({
      scope: 'user', text: 'deleted structural carrier', sessionId: 'private-session', status: 'pending',
      pendingOp: { op: 'ADD', targetId: secret },
    });
    service.addMemory({ scope: 'user', text: `survivor repeats ${secret}`, sessionId: 'other-session' });

    expect(() => service.privacyDeleteBySession('private-session')).not.toThrow();
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(service.list())).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
  });

  it('fails closed when a retained or future top-level structural ID matches a registered secret', () => {
    const secret = 'RETAINED_STRUCTURAL_ID_SECRET_94D3';
    service.addMemory({ scope: 'user', text: secret, sessionId: 'private-session' });
    service.addMemory({
      scope: 'user', text: 'surviving structural collision', sessionId: 'other-session', status: 'pending',
      pendingOp: { op: 'ADD', targetId: secret },
    });
    const before = readFileSync(userMemoryFile(dataDir));

    expect(() => service.privacyDeleteBySession('private-session')).toThrow(/结构字段|登记模式/);
    expect(readFileSync(userMemoryFile(dataDir))).toEqual(before);
    const dir = join(dataDir, 'memory', 'privacy-pending');
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(() => service.list()).toThrow(/隐私删除尚未完成/);
  });

  it('rejects a future top-level structural ID that matches an already registered secret', () => {
    const secret = 'FUTURE_STRUCTURAL_ID_SECRET_94D3';
    service.addMemory({ scope: 'user', text: secret, sessionId: 'private-session' });
    service.privacyDeleteBySession('private-session');
    const before = readFileSync(userMemoryFile(dataDir));

    expect(() => service.addMemory({
      scope: 'user', text: 'future structural collision', sessionId: 'future-session', status: 'pending',
      pendingOp: { op: 'ADD', targetId: secret },
    })).toThrow(/结构字段|登记模式/);
    expect(readFileSync(userMemoryFile(dataDir))).toEqual(before);
    expect(JSON.stringify(service.list())).not.toContain(secret);
  });
});

describe('R8 round7 future episode privacy ingress', () => {
  it('redacts addMemoriesBatch episode truth, index, FTS, search and restart reads', () => {
    const secret = 'FUTURE_BATCH_EPISODE_SECRET_94D3';
    service.addMemory({ scope: 'user', text: secret, sessionId: 'private-session' });
    service.privacyDeleteBySession('private-session');

    service.addMemoriesBatch([], {
      episode: {
        sessionId: 'future-batch-episode', agentId: 'general', workspacePath: '', ts: 2,
        summary: secret, topics: [secret],
      },
    });

    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(secret);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
    if (service.ftsAvailable) {
      expect(JSON.stringify(service.store.db.prepare('SELECT summary, topics FROM episodes_fts').all())).not.toContain(secret);
    }
    restartService();
    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(secret);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
  });

  it('redacts direct appendEpisode and updateEpisodeSummary ingress after privacy deletion', () => {
    const secret = 'FUTURE_DIRECT_EPISODE_SECRET_94D3';
    service.addMemory({ scope: 'user', text: secret, sessionId: 'private-session' });
    service.privacyDeleteBySession('private-session');

    service.store.appendEpisode({
      sessionId: 'future-direct-episode', agentId: 'general', workspacePath: '', ts: 3,
      summary: 'safe initial summary', topics: ['safe topic'],
    });
    service.store.updateEpisodeSummary('future-direct-episode', secret);
    service.store.appendEpisode({
      sessionId: 'future-direct-topics', agentId: 'general', workspacePath: '', ts: 4,
      summary: 'safe summary', topics: [secret],
    });

    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(secret);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
    restartService();
    expect(readFileSync(episodesFile(dataDir), 'utf8')).not.toContain(secret);
    expect(databaseBytes(memoryDbPath(dataDir))).not.toContain(secret);
    expect(JSON.stringify(service.store.listEpisodes())).not.toContain(secret);
    expect(service.searchMemory(secret, { includeHistory: true })).toEqual([]);
  });
});
