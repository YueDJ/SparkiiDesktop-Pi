import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { probeFts5Trigram } from '../electron/main/memory/fts.js';
import { projectMemoryFile } from '../electron/main/memory/settings.js';
import { normalizeTextHash } from '../electron/main/memory/types.js';

let root: string;
let dataDir: string;
let errors: ErrorStore;
let sessions: Map<string, { workspacePath: string; workspaceKind: 'auto' | 'user'; piSessionFile?: string }>;
let events: Array<{ type: string; payload: Record<string, unknown> }>;
let service: MemoryService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-memory-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  sessions = new Map();
  events = [];
  service = new MemoryService({
    dataDir, errors,
    sessionExists: (id) => sessions.has(id),
    sessionFileOf: (id) => sessions.get(id)?.piSessionFile,
    deleteChatSession: (id) => { sessions.delete(id); },
    agents: () => [{ id: 'general', name: '通用' }],
    emit: (type, payload) => { events.push({ type, payload }); },
  });
});

afterEach(() => {
  service.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

describe('memory foundation', () => {
  it('M1 step 0: FTS5 trigram 运行时可用', () => {
    const probe = probeFts5Trigram();
    expect(probe.sqliteVersion).toBe('3.53.4');
    expect(probe.available, probe.reason ?? '').toBe(true);
    expect(service.ftsAvailable).toBe(true);
  });

  it('手动新增用户记忆 → 注入块真的含 <memory> 与文本；注入不重置时钟', () => {
    const added = service.addMemory({ scope: 'user', text: '用户要求汇报先给结论，正文不超过三句' });
    const block = service.buildBlock({ sessionId: 'sess-1', profileId: 'general' });
    expect(block).toContain('<memory>');
    expect(block).toContain(added.text);
    const usage = service.store.usageFor(added.id);
    expect(usage.accessCount).toBe(1);
    expect(usage.lastAccessedAt).toBeNull();
    const scoreBefore = service.store.db.prepare('SELECT last_accessed_at FROM memories WHERE id = ?').get(added.id) as { last_accessed_at: number | null };
    service.buildBlock({ sessionId: 'sess-2', profileId: 'general' });
    const scoreAfter = service.store.db.prepare('SELECT last_accessed_at FROM memories WHERE id = ?').get(added.id) as { last_accessed_at: number | null };
    expect(scoreAfter.last_accessed_at).toBe(scoreBefore.last_accessed_at);
    expect(service.store.usageFor(added.id).accessCount).toBe(2);
  });

  it('检索命中才重置时钟，且同一检索连跑两次命中与增量一致', () => {
    service.addMemory({ scope: 'user', text: '用户偏好先在开头给结论' });
    const first = service.searchMemory('开头给结论');
    expect(first).toHaveLength(1);
    const usage1 = service.store.usageFor(first[0].id);
    expect(usage1.lastAccessedAt).not.toBeNull();
    const second = service.searchMemory('开头给结论');
    expect(second.map((h) => h.id)).toEqual(first.map((h) => h.id));
    expect(service.store.usageFor(second[0].id).accessCount).toBe(usage1.accessCount + 1);
  });

  it('项目记忆只建在 user 工作区；auto 不建；归档停注入', () => {
    const workspace = join(root, 'project');
    const added = service.addMemory({
      scope: 'project', text: '本项目评标办法采用综合评分法', workspacePath: workspace, workspaceKind: 'user',
    });
    expect(existsSync(projectMemoryFile(workspace))).toBe(true);
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).toContain(added.text);
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'auto' })).not.toContain(added.text);
    expect(() => service.addMemory({ scope: 'project', text: '临时工作区不记', workspacePath: join(root, 'auto'), workspaceKind: 'auto' })).toThrow('临时工作区');
    service.archiveProject(workspace, true);
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).not.toContain(added.text);
  });

  it('项目搬迁：文件移动后按 projectId 自愈重索引', () => {
    const from = join(root, 'before');
    const to = join(root, 'after');
    service.addMemory({ scope: 'project', text: '搬迁前写下的项目事实', workspacePath: from, workspaceKind: 'user' });
    mkdirSync(join(to, '.sparkii'), { recursive: true });
    renameSync(projectMemoryFile(from), projectMemoryFile(to));
    service.ensureProject(to, 'user');
    expect(service.buildBlock({ profileId: 'general', workspacePath: to, workspaceKind: 'user' })).toContain('搬迁前写下的项目事实');
  });

  it('损坏文件停止该 scope 注入并出修复入口；修复后恢复', () => {
    const workspace = join(root, 'broken');
    service.addMemory({ scope: 'project', text: '这条在修复后应消失', workspacePath: workspace, workspaceKind: 'user' });
    writeFileSync(projectMemoryFile(workspace), '{ not json', 'utf8');
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).not.toContain('这条在修复后应消失');
    expect(events.some((e) => e.type === 'repair_needed')).toBe(true);
    const list = service.list();
    expect(list.scopes.find((s) => s.kind === 'project')?.corrupt).toBe(true);
    service.repairProjectMemory(workspace, 'empty');
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).not.toContain('这条在修复后应消失');
    service.addMemory({ scope: 'project', text: '修复后的新记忆', workspacePath: workspace, workspaceKind: 'user' });
    expect(service.buildBlock({ profileId: 'general', workspacePath: workspace, workspaceKind: 'user' })).toContain('修复后的新记忆');
  });

  it('置顶、编辑、删除、重建索引全通', () => {
    const added = service.addMemory({ scope: 'user', text: '置顶前的内容' });
    service.updateMemory(added.id, { pinned: true, text: '编辑后的置顶内容' });
    const pinnedView = service.list().scopes[0].entries.find((e) => e.id === added.id);
    expect(pinnedView?.pinned).toBe(true);
    expect(pinnedView?.text).toBe('编辑后的置顶内容');
    const rebuilt = service.rebuildIndex();
    expect(rebuilt.entries).toBe(1);
    expect(service.store.usageFor(added.id).accessCount).toBe(0);
    service.deleteMemory(added.id);
    expect(service.store.rowFor(added.id)).toBeUndefined();
    expect(service.searchMemory('编辑后的置顶内容')).toHaveLength(0);
    expect(readFileSync(join(dataDir, 'memory', 'user.json'), 'utf8')).not.toContain(added.id);
  });

  it('普通删除保留历史版本，includeHistory 才真删', () => {
    const old = service.addMemory({ scope: 'user', text: '旧口径' });
    const fresh = service.addMemory({
      scope: 'user', text: '新口径', status: 'pending',
      pendingOp: { op: 'SUPERSEDE', targetId: old.id, proposedText: '新口径' },
    });
    service.resolvePending(fresh.id, 'approve');
    expect(service.store.rowFor(old.id)?.status).toBe('superseded');
    service.deleteMemory(fresh.id);
    expect(service.store.rowFor(old.id)?.status).toBe('superseded');
    service.updateMemory(old.id, { status: 'superseded' });
    service.deleteMemory(old.id, { includeHistory: true });
    expect(service.store.rowFor(old.id)).toBeUndefined();
  });

  it('pending 出口：批准 ADD / 驳回进黑名单 / target 已删降级 ADD / 源会话删除失效', () => {
    const add = service.addMemory({
      scope: 'user', text: '待确认的用户偏好', status: 'pending', sessionId: 'sess-src',
      pendingOp: { op: 'ADD', proposedText: '待确认的用户偏好' },
    });
    expect(service.list().pending.some((e) => e.id === add.id)).toBe(true);
    expect(service.resolvePending(add.id, 'approve').entry?.status).toBe('active');

    const rejectText = '不要记录这条';
    const rejected = service.addMemory({
      scope: 'user', text: rejectText, status: 'pending', sessionId: 'sess-src',
      pendingOp: { op: 'ADD', proposedText: rejectText },
    });
    service.resolvePending(rejected.id, 'reject');
    expect(service.store.hasRejectedHash(normalizeTextHash(rejectText))).toBe(true);
    expect(service.store.rowFor(rejected.id)).toBeUndefined();

    const target = service.addMemory({ scope: 'user', text: '将被删除的目标' });
    service.deleteMemory(target.id);
    const update = service.addMemory({
      scope: 'user', text: '更新已删目标', status: 'pending',
      pendingOp: { op: 'UPDATE', targetId: target.id, proposedText: '更新已删目标' },
    });
    const degraded = service.resolvePending(update.id, 'approve');
    expect(degraded.message).toContain('原目标已变化');
    expect(service.store.rowFor(update.id)?.status).toBe('pending');

    const fromSource = service.addMemory({
      scope: 'user', text: '来自将被删会话', status: 'pending', sessionId: 'sess-gone',
      pendingOp: { op: 'ADD', proposedText: '来自将被删会话' },
    });
    sessions.set('sess-gone', { workspacePath: join(root, 'gone'), workspaceKind: 'user', piSessionFile: join(root, 'gone.jsonl') });
    writeFileSync(join(root, 'gone.jsonl'), '{"type":"message"}\n', 'utf8');
    service.store.appendEpisode({
      sessionId: 'sess-gone', agentId: 'general', workspacePath: join(root, 'gone'), ts: Date.now(),
      summary: '来自被删会话的摘要', topics: ['测试'],
    });
    service.privacyDeleteBySession('sess-gone');
    expect(service.store.rowFor(fromSource.id)).toBeUndefined();
    expect(existsSync(join(root, 'gone.jsonl'))).toBe(false);
    expect(events.some((e) => e.type === 'memory_changed' && e.payload.op === 'privacy-delete')).toBe(true);
  });
});
