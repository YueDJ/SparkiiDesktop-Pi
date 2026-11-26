import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { Logger } from '../electron/main/logger.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { ExtractionScheduler } from '../electron/main/memory/extraction.js';
import { IdleConsolidator } from '../electron/main/memory/consolidation.js';
import { materialFromTurns, readSessionMaterial } from '../electron/main/memory/material.js';
import { parseExtraction } from '../electron/main/memory/ops.js';
import { agentMemoryFile, episodeProposalFile, memoryDbPath, projectMemoryFile, projectRegistryFile, removeProjectRef, userMemoryFile } from '../electron/main/memory/settings.js';
import { parseMemoryFile, parseProjectMemoryFile } from '../electron/main/memory/store.js';

let root: string;
let dataDir: string;
let errors: ErrorStore;
let service: MemoryService | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-audit-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  service = new MemoryService({ dataDir, errors, sessionExists: () => true });
});

afterEach(() => {
  service?.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function turns(...texts: string[]) {
  return texts.map((text) => ({ role: 'user' as const, text }));
}

function extraction(complete: (prompt: string) => Promise<string>, ctx: Record<string, unknown> = {}) {
  return new ExtractionScheduler({
    service: service!,
    errors,
    contextOf: (sessionId) => ({ sessionId, profileId: 'general', workspaceKind: 'auto', ...ctx }),
    target: () => ({ provider: 'p', modelId: 'm' }),
    complete,
    materialOf: () => materialFromTurns(turns('用户要求先给结论', '汇报要短', '项目使用人民币')),
  });
}

describe('memory audit regressions', () => {
  it('P1-2 LIKE fallback supports CRUD, search and rebuild', async () => {
    service!.close();
    service = new MemoryService({ dataDir, errors, forceLike: true, sessionExists: () => true });
    const added = service!.addMemory({ scope: 'user', text: '用户要求先给结论' });
    service!.updateMemory(added.id, { text: '用户要求先给结论再说理由' });
    expect(service!.searchMemory('先给结论').map((h) => h.id)).toContain(added.id);
    expect(service!.rebuildIndex().entries).toBe(1);
    expect(service!.list().scopes.flatMap((s) => s.entries).map((e) => e.id)).toContain(added.id);
    service!.deleteMemory(added.id);
    expect(service!.searchMemory('先给结论')).toEqual([]);
  });

  it('P1-2 corrupt SQLite is quarantined and rebuilt from truth without blocking startup', () => {
    service!.addMemory({ scope: 'user', text: '真相源里的记忆' });
    service!.close();
    service = undefined;
    writeFileSync(memoryDbPath(dataDir), 'not a sqlite database');
    service = new MemoryService({ dataDir, errors, sessionExists: () => true });
    expect(service!.searchMemory('真相源').map((h) => h.text)).toContain('真相源里的记忆');
    expect(existsSync(memoryDbPath(dataDir))).toBe(true);
  });

  it('P1-3 copied workspace with the same projectId fails closed and preserves the first truth source', () => {
    const a = join(root, 'workspace-a');
    const b = join(root, 'workspace-b');
    mkdirSync(join(a, '.sparkii'), { recursive: true });
    mkdirSync(join(b, '.sparkii'), { recursive: true });
    service!.addMemory({ scope: 'project', workspacePath: a, workspaceKind: 'user', text: 'A 项目事实' });
    copyFileSync(projectMemoryFile(a), projectMemoryFile(b));
    const events: Array<Record<string, unknown>> = [];
    service!.setEmitter((type, payload) => { if (type === 'repair_needed') events.push(payload); });
    expect(service!.ensureProject(b, 'user')).toBeNull();
    expect(events.some((e) => e.workspacePath === b.replace(/\\/g, '/'))).toBe(true);
    expect(service!.list().scopes.flatMap((s) => s.entries).filter((e) => e.text === 'A 项目事实')).toHaveLength(1);
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(a), 'utf8'), projectMemoryFile(a)).entries).toHaveLength(1);
    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(b), 'utf8'), projectMemoryFile(b)).entries).toHaveLength(1);
  });

  it('P1-4 default search and includeHistory never expose pending memories', () => {
    service!.addMemory({ scope: 'user', text: '待确认隐私内容', status: 'pending', pendingOp: { op: 'ADD', proposedText: '待确认隐私内容' } });
    expect(service!.searchMemory('待确认隐私内容')).toEqual([]);
    expect(service!.searchMemory('待确认隐私内容', { includeHistory: true })).toEqual([]);
  });

  it('P2 external truth edits reconcile list, injection and search', () => {
    const added = service!.addMemory({ scope: 'user', text: '外部修改前' });
    const parsed = parseMemoryFile(readFileSync(userMemoryFile(dataDir), 'utf8'), userMemoryFile(dataDir));
    parsed.entries[0].text = '外部修改后的新事实';
    parsed.entries[0].updatedAt += 1;
    writeFileSync(userMemoryFile(dataDir), `${JSON.stringify(parsed, null, 2)}\n`);
    expect(service!.list().scopes.flatMap((s) => s.entries).find((e) => e.id === added.id)?.text).toBe('外部修改后的新事实');
    expect(service!.buildBlock({ profileId: 'general' })).toContain('外部修改后的新事实');
    expect(service!.searchMemory('新事实').map((h) => h.id)).toContain(added.id);
  });

  it('P2 master switch rejects manual add while disabled', () => {
    service!.saveSettings({ enabled: false });
    expect(() => service!.addMemory({ scope: 'user', text: '关闭后不应写入' })).toThrow('记忆功能已关闭');
    expect(existsSync(userMemoryFile(dataDir))).toBe(false);
  });

  it('P2 project archived state survives derived index rebuild', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    service!.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: '归档项目事实' });
    service!.archiveProject(workspace, true);
    service!.rebuildIndex();
    expect(service!.list().scopes.find((s) => s.scope.startsWith('project:'))?.archived).toBe(true);
    expect(service!.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).not.toContain('归档项目事实');
  });

  it('P1-6 a missing cursor is rejected and truncation advances only through included messages', () => {
    const file = join(root, 'session.jsonl');
    const entries = [
      { id: 'e1', type: 'message', parentId: null, role: 'user', text: '第一条' },
      { id: 'e2', type: 'message', parentId: 'e1', role: 'assistant', text: '第二条' },
      { id: 'e3', type: 'message', parentId: 'e2', role: 'user', text: '第三条' },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
    expect(() => readSessionMaterial(file, 'missing', 6000)).toThrow(/stale-cursor|material-unreadable/);
    const limited = readSessionMaterial(file, 'e1', 8);
    expect(limited.text).toContain('第二条');
    expect(limited.text).not.toContain('第三条');
    expect(limited.lastEntryId).toBe('e2');
    expect(readSessionMaterial(file, limited.lastEntryId, 6000).text).toContain('第三条');
  });

  it('P1-6 rejects an intra-entry cursor beyond the actual entry text', () => {
    const file = join(root, 'session-offset.jsonl');
    writeFileSync(file, [
      { id: 'e1', type: 'message', parentId: null, role: 'user', message: { role: 'user', content: [{ type: 'text', text: 'abcdefghij' }] } },
      { id: 'e2', type: 'message', parentId: 'e1', role: 'user', text: '后续消息' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    expect(() => readSessionMaterial(file, 'e1@11', 6000)).toThrow('material-unreadable: stale-cursor e1@11');
    expect(readSessionMaterial(file, 'e1@7', 6000).text).toContain('用户：hij');
  });

  it('P1-5 one invalid project UPDATE rejects the whole extraction batch', async () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const raw = JSON.stringify({
      sessionSummary: '整批应回滚', topics: [],
      ops: [
        { op: 'ADD', scope: 'project', text: '这条也不能留下', importance: 2 },
        { op: 'UPDATE', targetId: 'mem_missing', text: '目标不存在' },
      ],
    });
    const result = await extraction(async () => raw, { workspacePath: workspace, workspaceKind: 'user' }).flush('sess-atomic');
    expect(result.opsApplied).toBe(0);
    expect(service!.list().pending).toEqual([]);
    expect(service!.store.listEpisodes()).toEqual([]);
    expect(service!.store.getExtractionState('sess-atomic').lastRunAt).toBe(0);
    expect(existsSync(projectMemoryFile(workspace))).toBe(false);
  });

  it('P1-1 privacy deletion wins over an in-flight model response and redacts diagnostics', async () => {
    let release!: (value: string) => void;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => { started = resolve; });
    const modelResult = new Promise<string>((resolve) => { release = resolve; });
    const logger = new Logger(join(dataDir, 'logs'));
    service!.close();
    let sessionExists = true;
    service = new MemoryService({
      dataDir, errors, logger, sessionExists: () => sessionExists,
      deleteChatSession: () => { sessionExists = false; },
    });
    const s = extraction(() => { started(); return modelResult; });
    const running = s.flush('sess-private');
    await modelStarted;
    service!.privacyDeleteBySession('sess-private');
    release(JSON.stringify({
      sessionSummary: '不得复活', topics: [],
      ops: [{ op: 'ADD', scope: 'user', text: '隐私删除后不得复活', importance: 2 }],
    }));
    await running;
    expect(service!.list().pending).toEqual([]);
    expect(service!.store.listEpisodes()).toEqual([]);
    expect(service!.store.getExtractionState('sess-private').lastRunAt).toBe(0);
    expect(await logger.export()).not.toContain('隐私删除后不得复活');
  });

  it('P1-1 privacy deletion while target resolution is pending prevents the model send', async () => {
    let resolveTarget!: (target: { provider: string; modelId: string }) => void;
    const target = new Promise<{ provider: string; modelId: string }>((resolve) => { resolveTarget = resolve; });
    const complete = vi.fn(async () => JSON.stringify({ sessionSummary: '不得复活', topics: [], ops: [] }));
    const scheduler = new ExtractionScheduler({
      service: service!, errors,
      contextOf: (sessionId) => ({ sessionId, profileId: 'general', workspaceKind: 'auto' }),
      target: () => target,
      complete,
      materialOf: () => materialFromTurns(turns('删除前读取的会话内容', '继续提供足够上下文', '满足三轮提炼门槛')),
    });

    const running = scheduler.flush('sess-target-private');
    service!.privacyDeleteBySession('sess-target-private');
    resolveTarget({ provider: 'p', modelId: 'm' });
    const result = await running;

    expect(result.skipped).toBe('session-invalidated');
    expect(complete).not.toHaveBeenCalled();
    expect(service!.store.getExtractionState('sess-target-private').lastRunAt).toBe(0);
  });

  it('P1-1 corrupt project registry makes privacy deletion fail closed', () => {
    const workspace = join(root, 'workspace-private');
    mkdirSync(workspace, { recursive: true });
    service!.addMemory({
      scope: 'project', workspacePath: workspace, workspaceKind: 'user',
      text: '不得残留的项目隐私', sessionId: 'sess-project-private',
    });
    writeFileSync(projectRegistryFile(dataDir), '{broken');

    expect(() => service!.privacyDeleteBySession('sess-project-private')).toThrow();
    expect(readFileSync(projectMemoryFile(workspace), 'utf8')).toContain('不得残留的项目隐私');
  });

  it('P1-1 duplicate ids corrupt the whole truth file instead of exposing both rows', () => {
    const added = service!.addMemory({ scope: 'user', text: '原始条目' });
    service!.close();
    service = undefined;
    const parsed = parseMemoryFile(readFileSync(userMemoryFile(dataDir), 'utf8'), userMemoryFile(dataDir));
    parsed.entries.push({ ...parsed.entries[0], text: '同 id 的隐私副本' });
    writeFileSync(userMemoryFile(dataDir), `${JSON.stringify(parsed, null, 2)}\n`);
    service = new MemoryService({ dataDir, errors, sessionExists: () => true });

    expect(service!.list().scopes.some((scope) => scope.corrupt)).toBe(true);
    expect(service!.list().scopes.flatMap((scope) => scope.entries).some((entry) => entry.id === added.id)).toBe(false);
    expect(service!.searchMemory('隐私副本')).toEqual([]);
    expect(() => service!.privacyDeleteBySession('missing-session')).toThrow();
  });

  it('P1-1 privacy deletion discovers the indexed workspace even when the registry omits it', () => {
    const workspace = join(root, 'workspace-unregistered');
    mkdirSync(workspace, { recursive: true });
    const added = service!.addMemory({
      scope: 'project', workspacePath: workspace, workspaceKind: 'user',
      text: '注册表遗漏后仍须删除的项目隐私', sessionId: 'sess-unregistered-private',
    });
    writeFileSync(projectRegistryFile(dataDir), JSON.stringify({ version: 1, projects: [] }));

    service!.deleteMemory(added.id, { mode: 'privacy' });

    expect(parseProjectMemoryFile(readFileSync(projectMemoryFile(workspace), 'utf8'), projectMemoryFile(workspace)).entries).toEqual([]);
  });

  it('P1-3 privacy deletion fails closed when a copied project duplicates identity', () => {
    const workspaceA = join(root, 'workspace-a-private');
    const workspaceB = join(root, 'workspace-b-private');
    mkdirSync(workspaceA, { recursive: true });
    mkdirSync(join(workspaceB, '.sparkii'), { recursive: true });
    const added = service!.addMemory({
      scope: 'project', workspacePath: workspaceA, workspaceKind: 'user',
      text: '复制项目不得被跨工作区删除', sessionId: 'sess-copied-private',
    });
    copyFileSync(projectMemoryFile(workspaceA), projectMemoryFile(workspaceB));
    const beforeA = readFileSync(projectMemoryFile(workspaceA), 'utf8');
    const beforeB = readFileSync(projectMemoryFile(workspaceB), 'utf8');
    service!.close();
    service = new MemoryService({
      dataDir, errors, sessionExists: () => true,
      workspacePathOf: (sessionId) => sessionId === 'sess-copied-private' ? workspaceB : undefined,
    });

    expect(() => service!.deleteMemory(added.id, { mode: 'privacy' })).toThrow('projectId 重复');
    expect(readFileSync(projectMemoryFile(workspaceA), 'utf8')).toBe(beforeA);
    expect(readFileSync(projectMemoryFile(workspaceB), 'utf8')).toBe(beforeB);
  });

  it('P1-1 privacy deletion redacts retained diagnostic messages', () => {
    const secret = '诊断里不得保留的隐私正文';
    service!.addMemory({ scope: 'user', text: secret, sessionId: 'sess-diagnostic-private' });
    errors.append({ id: 'diagnostic-private', message: `模型错误回显：${secret}`, source: 'memory.test', createdAt: Date.now() });

    service!.privacyDeleteBySession('sess-diagnostic-private');

    expect(errors.list().find((event) => event.id === 'diagnostic-private')?.message).not.toContain(secret);
  });

  it('P1-1 model and parse failures do not copy session content into diagnostics', async () => {
    const secret = '不得进入诊断的会话片段';
    const material = () => materialFromTurns(turns(secret, '第二轮上下文', '第三轮上下文'));
    const failed = new ExtractionScheduler({
      service: service!, errors,
      contextOf: (sessionId) => ({ sessionId, profileId: 'general', workspaceKind: 'auto' }),
      target: () => ({ provider: 'p', modelId: 'm' }),
      complete: async () => { throw new Error(`provider echoed ${secret}`); },
      materialOf: material,
    });
    expect((await failed.flush('sess-safe-errors')).skipped).toBe('model-failed');

    const malformed = new ExtractionScheduler({
      service: service!, errors,
      contextOf: (sessionId) => ({ sessionId, profileId: 'general', workspaceKind: 'auto' }),
      target: () => ({ provider: 'p', modelId: 'm' }),
      complete: async () => `{"sessionSummary":"${secret}"`,
      materialOf: material,
    });
    expect((await malformed.flush('sess-safe-errors')).skipped).toBe('parse-failed');
    expect(errors.list().map((event) => event.message).join('\n')).not.toContain(secret);
    expect(() => parseExtraction(JSON.stringify({ sessionSummary: '摘要', topics: [], ops: [{ op: secret }] }))).toThrow('未知 op');
    expect(() => parseExtraction(JSON.stringify({ sessionSummary: '摘要', topics: [], ops: [{ op: 'ADD', text: '事实', scope: secret }] }))).toThrow('未知 scope');
    try {
      parseExtraction(JSON.stringify({ sessionSummary: '摘要', topics: [], ops: [{ op: secret }] }));
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('P1-1 old prompt-log cleanup failures surface as repair warnings', () => {
    const logger = new Logger(join(dataDir, 'logs'));
    mkdirSync(join(dataDir, 'logs', 'sparkii.log.jsonl'), { recursive: true });
    service!.close();
    service = undefined;

    expect(() => {
      service = new MemoryService({ dataDir, errors, logger, sessionExists: () => true });
    }).not.toThrow();
    expect(service!.list().warnings.join('\n')).toContain('旧记忆提示日志清理失败');
  });

  it('P1-8 consolidation is single-flight across the first await', async () => {
    service!.saveSettings({ consolidateIdleMinutes: 0, consolidateIntervalHours: 0 });
    service!.addMemory({ scope: 'user', text: '用户喜欢先给结论再说明理由' });
    service!.addMemory({ scope: 'user', text: '用户喜欢先给结论再说明理由' });
    const complete = vi.fn(async () => JSON.stringify({ merges: [] }));
    const c = new IdleConsolidator({
      service: service!, errors, complete,
      target: async () => ({ provider: 'p', modelId: 'm' }),
    });
    const results = await Promise.all([c.runOnce(), c.runOnce()]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.calls > 0)).toHaveLength(1);
  });

  it('P1-8 a malformed consolidation element rejects the entire merge phase', async () => {
    service!.saveSettings({ consolidateIdleMinutes: 0, consolidateIntervalHours: 0 });
    const keep = service!.addMemory({ scope: 'user', text: '用户喜欢先给结论再说明理由' });
    const drop = service!.addMemory({ scope: 'user', text: '用户喜欢先给结论再说明理由' });
    const complete = vi.fn(async () => JSON.stringify({
      merges: [
        { keepId: keep.id, dropId: drop.id, text: '用户偏好先给结论' },
        null,
      ],
    }));
    const consolidator = new IdleConsolidator({
      service: service!, errors, complete,
      target: async () => ({ provider: 'p', modelId: 'm' }),
    });

    const result = await consolidator.runOnce();

    expect(result.proposals).toBe(0);
    expect(service!.list().pending).toEqual([]);
    expect(service!.list().scopes.flatMap((scope) => scope.entries).filter((entry) => [keep.id, drop.id].includes(entry.id)).every((entry) => entry.status === 'active')).toBe(true);
  });

  it.each(['id', 'text'] as const)('truth parser rejects object-valued %s instead of stringifying it', (field) => {
    const file = userMemoryFile(dataDir);
    const entry: Record<string, unknown> = {
      id: 'mem_strict', text: '严格字符串字段', status: 'active', pinned: false,
      importance: 2, createdAt: 1, updatedAt: 1,
    };
    entry[field] = {};
    expect(() => parseMemoryFile(JSON.stringify({ version: 1, entries: [entry] }), file)).toThrow('字段非法');
  });

  it('cross-file duplicate ids are excluded from listing and injection until repaired', () => {
    const original = service!.addMemory({ scope: 'user', text: '跨文件隐私正文' });
    const duplicate = service!.addMemory({ scope: 'agent', agentId: 'general', text: '重复 id 不得暴露' });
    const agentFile = agentMemoryFile(dataDir, 'general');
    const parsed = parseMemoryFile(readFileSync(agentFile, 'utf8'), agentFile);
    parsed.entries[0].id = original.id;
    writeFileSync(agentFile, `${JSON.stringify(parsed, null, 2)}\n`);
    service!.close();
    service = new MemoryService({ dataDir, errors, sessionExists: () => true });

    expect(service!.list().warnings.join('\n')).toContain('记忆 id 跨文件重复');
    expect(service!.list().scopes.flatMap((s) => s.entries).map((entry) => entry.id)).not.toContain(original.id);
    expect(service!.list().scopes.flatMap((s) => s.entries).map((entry) => entry.id)).not.toContain(duplicate.id);
    expect(service!.buildBlock({ profileId: 'general' })).not.toContain('跨文件隐私正文');
    expect(service!.buildBlock({ profileId: 'general' })).not.toContain('重复 id 不得暴露');
    expect(() => service!.addMemory({ scope: 'user', text: '冲突期间不得继续写入' })).toThrow('记忆 id 跨文件重复');
  });

  it('batch writes fail closed while a cross-file duplicate identity exists', () => {
    const original = service!.addMemory({ scope: 'user', text: '批次写入冲突原文' });
    service!.addMemory({ scope: 'agent', agentId: 'general', text: '另一文件的重复身份' });
    const agentFile = agentMemoryFile(dataDir, 'general');
    const parsed = parseMemoryFile(readFileSync(agentFile, 'utf8'), agentFile);
    parsed.entries[0].id = original.id;
    writeFileSync(agentFile, `${JSON.stringify(parsed, null, 2)}\n`);
    const before = readFileSync(userMemoryFile(dataDir), 'utf8');

    expect(() => service!.addMemoriesBatch([{ scope: 'user', text: '冲突期间批量也不得写入' }])).toThrow('记忆 id 跨文件重复');
    expect(readFileSync(userMemoryFile(dataDir), 'utf8')).toBe(before);
    expect(service!.list().pending).toEqual([]);
  });

  it('removing a project truth file and registry reference clears its searchable index', () => {
    const workspace = join(root, 'deleted-project');
    mkdirSync(workspace, { recursive: true });
    service!.addMemory({ scope: 'project', workspacePath: workspace, workspaceKind: 'user', text: '已删除项目敏感正文' });
    expect(service!.searchMemory('敏感正文').map((hit) => hit.text)).toContain('已删除项目敏感正文');

    rmSync(projectMemoryFile(workspace));
    removeProjectRef(dataDir, workspace);

    expect(service!.searchMemory('敏感正文')).toEqual([]);
    expect(service!.list().scopes.flatMap((scope) => scope.entries).map((entry) => entry.text)).not.toContain('已删除项目敏感正文');
  });

  it('episode approval rejects malformed mergeIds before changing episode or proposal state', () => {
    service!.store.appendEpisode({
      sessionId: 'sess-malformed-episode', agentId: 'general', workspacePath: '/w', ts: Date.now(),
      summary: '原会话摘要', topics: [],
    });
    const proposal = service!.addMemory({
      scope: 'episode:sess-malformed-episode', sessionId: 'sess-malformed-episode', text: '候选会话摘要',
      status: 'pending', sourceKind: 'consolidated',
      pendingOp: {
        op: 'EPISODE_UPDATE', targetId: 'sess-malformed-episode', proposedText: '候选会话摘要', mergeIds: [42],
      } as never,
    });

    expect(() => service!.resolvePending(proposal.id, 'approve')).toThrow('合并目标列表非法');
    expect(service!.store.listEpisodes().find((episode) => episode.sessionId === 'sess-malformed-episode')?.summary).toBe('原会话摘要');
    expect(service!.list().pending.map((entry) => entry.id)).toEqual([proposal.id]);
  });

  it('privacy deletion removes both current and legacy episode proposals', () => {
    const current = service!.addEpisodeProposal('sess-current-episode', '当前会话摘要');
    const legacy = service!.addEpisodeProposal('sess-legacy-episode', '旧版会话摘要');
    const legacyFile = episodeProposalFile(dataDir, 'sess-legacy-episode');
    const parsed = parseMemoryFile(readFileSync(legacyFile, 'utf8'), legacyFile);
    delete parsed.entries[0].source;
    writeFileSync(legacyFile, `${JSON.stringify(parsed, null, 2)}\n`);
    service!.close();
    service = new MemoryService({ dataDir, errors, sessionExists: () => true });

    expect(service!.privacyDeleteBySession('sess-current-episode').removed).toContain(current.id);
    expect(service!.privacyDeleteBySession('sess-legacy-episode').removed).toContain(legacy.id);
    expect(service!.list().pending).toEqual([]);
    expect(parseMemoryFile(readFileSync(episodeProposalFile(dataDir, 'sess-current-episode'), 'utf8'), episodeProposalFile(dataDir, 'sess-current-episode')).entries).toEqual([]);
    expect(parseMemoryFile(readFileSync(legacyFile, 'utf8'), legacyFile).entries).toEqual([]);
    expect(() => service!.addEpisodeProposal('sess-current-episode', '删除后不得重建')).toThrow('来源会话已删除');
    service!.close();
    service = new MemoryService({ dataDir, errors, sessionExists: () => false });
    expect(() => service!.addEpisodeProposal('sess-current-episode', '重启后也不得重建')).toThrow('来源会话已删除');
    expect(service!.list().pending).toEqual([]);
  });

  it('ordinary source deletion removes legacy pending episode proposals and repairs active source metadata', () => {
    const pending = service!.addEpisodeProposal('sess-ordinary-pending', '待确认摘要');
    const active = service!.addMemory({ scope: 'episode:sess-ordinary-active', text: '已确认摘要', sessionId: 'sess-ordinary-active' });
    const activeFile = episodeProposalFile(dataDir, 'sess-ordinary-active');
    const parsed = parseMemoryFile(readFileSync(activeFile, 'utf8'), activeFile);
    delete parsed.entries[0].source;
    writeFileSync(activeFile, `${JSON.stringify(parsed, null, 2)}\n`);
    service!.close();
    service = new MemoryService({ dataDir, errors, sessionExists: () => true });

    service!.markSourcesDeleted('sess-ordinary-pending');
    service!.markSourcesDeleted('sess-ordinary-active');

    expect(service!.list().pending.map((entry) => entry.id)).not.toContain(pending.id);
    expect(parseMemoryFile(readFileSync(activeFile, 'utf8'), activeFile).entries.find((entry) => entry.id === active.id)?.source).toMatchObject({
      sessionId: 'sess-ordinary-active', kind: 'consolidated', excerpt: '来源已删除',
    });
  });

  it('malformed mergeIds are rejected before any pending or target mutation', () => {
    const keep = service!.addMemory({ scope: 'user', text: '原目标' });
    const proposal = service!.addMemory({
      scope: 'user', text: '候选内容', status: 'pending', sourceKind: 'consolidated',
      pendingOp: { op: 'SUPERSEDE', targetId: keep.id, proposedText: '候选内容', mergeIds: [42] } as never,
    });
    expect(() => service!.resolvePending(proposal.id, 'approve')).toThrow('合并目标列表非法');
    expect(service!.list().pending.map((entry) => entry.id)).toEqual([proposal.id]);
    expect(service!.list().scopes.flatMap((s) => s.entries).find((entry) => entry.id === keep.id)).toMatchObject({
      status: 'active', text: '原目标', supersededBy: null,
    });

    const missingTarget = service!.addMemory({
      scope: 'user', text: '失效目标候选', status: 'pending',
      pendingOp: { op: 'SUPERSEDE', targetId: 'mem_missing', proposedText: '失效目标候选', mergeIds: [42] } as never,
    });
    expect(() => service!.resolvePending(missingTarget.id, 'approve')).toThrow('合并目标列表非法');
    expect(service!.list().pending.map((entry) => entry.id)).toEqual([proposal.id, missingTarget.id]);
    expect(service!.list().pending.find((entry) => entry.id === missingTarget.id)?.pendingOp?.op).toBe('SUPERSEDE');
  });

  it('P1-8 mergeIds approval is all-or-nothing', () => {
    const keep = service!.addMemory({ scope: 'user', text: '保留结论' });
    const drop = service!.addMemory({ scope: 'user', text: '合并重复' });
    const proposal = service!.addMemory({
      scope: 'user', text: '合并后的结论', status: 'pending', sourceKind: 'consolidated',
      pendingOp: { op: 'SUPERSEDE', targetId: keep.id, proposedText: '合并后的结论', mergeIds: [drop.id, 'mem_missing'] },
    });
    expect(() => service!.resolvePending(proposal.id, 'approve')).toThrow();
    expect(service!.list().scopes.flatMap((s) => s.entries).find((e) => e.id === keep.id)?.status).toBe('active');
    expect(service!.list().scopes.flatMap((s) => s.entries).find((e) => e.id === drop.id)?.status).toBe('active');
    expect(service!.list().pending.map((e) => e.id)).toContain(proposal.id);
  });
});
