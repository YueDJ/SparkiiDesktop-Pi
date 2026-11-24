import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { IdleConsolidator, CONSOLIDATION_MAX_CALLS } from '../electron/main/memory/consolidation.js';

let root: string;
let dataDir: string;
let errors: ErrorStore;
let service: MemoryService;
let clock: number;

const DAY = 86_400_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-consolidate-'));
  dataDir = join(root, 'data');
  clock = Date.UTC(2026, 10, 23);
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  service = new MemoryService({ dataDir, errors, sessionExists: () => true, now: () => clock });
});

afterEach(() => {
  service.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function consolidator(
  complete: (prompt: string) => Promise<string>,
  overrides: Partial<ConstructorParameters<typeof IdleConsolidator>[0]> = {},
) {
  return new IdleConsolidator({
    service,
    errors,
    now: () => clock,
    target: () => ({ provider: 'p', modelId: 'm' }),
    complete: async (prompt) => complete(prompt),
    ...overrides,
  });
}

/** 让「应用已空闲足够久、且距上次整合足够久」成立。 */
function makeIdle(c: IdleConsolidator): void {
  clock += 20 * 60_000;
  c.noteActivity();
  clock += 20 * 60_000;
}

describe('idle consolidation', () => {
  it('相似记忆只产出 pending 提案，绝不自动改 active', async () => {
    const a = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    const b = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const payload = { merges: [{ keepId: a.id, dropId: b.id, text: '用户要求汇报先给结论且不超过三句' }] };
    const c = consolidator(async () => JSON.stringify(payload));
    makeIdle(c);
    const result = await c.runOnce();
    expect(result.proposals).toBe(1);
    // active 未被改动
    const active = service.list().scopes.flatMap((s) => s.entries).filter((e) => e.status === 'active');
    expect(active.map((e) => e.text).sort()).toEqual([
      '用户要求所有汇报先给结论，正文不超过三句',
      '用户要求所有汇报先给结论，正文不超过三句话',
    ]);
    // 提案在 pending，且带 mergeIds 与来源说明
    const pending = service.list().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].pendingOp?.op).toBe('SUPERSEDE');
    expect(pending[0].pendingOp?.targetId).toBe(a.id);
    expect(pending[0].pendingOp?.mergeIds).toEqual([b.id]);
    expect(pending[0].source?.kind).toBe('consolidated');
  });

  it('批准合并提案后：保留条作废、被合并条作废、新条生效', async () => {
    const a = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    const b = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const payload = { merges: [{ keepId: a.id, dropId: b.id, text: '用户要求汇报先给结论且不超过三句' }] };
    const c = consolidator(async () => JSON.stringify(payload));
    makeIdle(c);
    await c.runOnce();
    const proposal = service.list().pending[0];
    service.resolvePending(proposal.id, 'approve');
    const entries = service.list().scopes.flatMap((s) => s.entries);
    const live = entries.filter((e) => e.status === 'active');
    expect(live).toHaveLength(1);
    expect(live[0].text).toBe('用户要求汇报先给结论且不超过三句');
    expect(entries.find((e) => e.id === a.id)?.status).toBe('superseded');
    expect(entries.find((e) => e.id === b.id)?.status).toBe('superseded');
  });

  it('一次整合的模型调用不超过 3 次', async () => {
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const calls: string[] = [];
    const c = consolidator(async (prompt) => {
      calls.push(prompt.slice(0, 8));
      return '{"merges":[],"digests":[],"ops":[]}';
    });
    makeIdle(c);
    const result = await c.runOnce();
    expect(calls.length).toBeLessThanOrEqual(CONSOLIDATION_MAX_CALLS);
    expect(result.calls).toBe(calls.length);
  });

  it('三个阶段全都有活时仍然 ≤3 次调用，第四件事顺延', async () => {
    const project = service.addMemory({
      scope: 'project', text: '本项目报价为 2024 年报价单口径',
      workspacePath: join(root, 'ws'), workspaceKind: 'user',
    });
    clock += 200 * DAY;
    const a = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    const b = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    // 40 天前的情景摘要
    service.store.appendEpisode({
      sessionId: 'sess-old', agentId: 'general', workspacePath: '/w', ts: clock - 40 * DAY,
      summary: '很长的旧摘要'.repeat(20), topics: ['旧'],
    });
    const calls: string[] = [];
    const c = consolidator(async (prompt) => {
      calls.push(prompt);
      if (prompt.includes('整理器')) return JSON.stringify({ merges: [{ keepId: a.id, dropId: b.id, text: '合并后的陈述' }] });
      if (prompt.includes('压缩器')) return JSON.stringify({ digests: [{ sessionId: 'sess-old', summary: '旧项目：报价已确认' }] });
      return JSON.stringify({ ops: [{ targetId: project.id, replacementText: '本项目 2024 年报价口径，已过期，需重新确认' }] });
    });
    makeIdle(c);
    const result = await c.runOnce();
    expect(result.calls).toBe(3);
    expect(calls.length).toBe(3);
    expect(result.proposals).toBe(2);
    expect(result.digests).toBe(1);
    const digest = service.store.listEpisodes().find((e) => e.sessionId === 'sess-old');
    expect(digest?.summary).toBe('旧项目：报价已确认');
    // 三轮全走 pending，active 一条没被自动改
    const projectRow = service.list().scopes.find((s) => s.kind === 'project')?.entries.find((e) => e.id === project.id);
    expect(projectRow?.status).toBe('active');
    expect(service.list().pending).toHaveLength(2);
  });

  it('空闲不足或距上次整合不足：不调用模型', async () => {
    const complete = vi.fn(async () => '{}');
    const c = consolidator(complete);
    // 刚活动过
    expect((await c.runOnce()).skipped).toBe('not-idle');
    // 空闲够了但今天刚整合过
    clock += 20 * 60_000;
    c.noteActivity();
    clock += 20 * 60_000;
    service.store.setConsolidationLastRun(clock - 3600_000);
    expect((await c.runOnce()).skipped).toBe('interval');
    expect(complete).not.toHaveBeenCalled();
  });

  it('开关关闭或有交互会话在跑：不整合', async () => {
    const complete = vi.fn(async () => '{}');
    service.saveSettings({ idleConsolidation: false });
    const off = consolidator(complete);
    makeIdle(off);
    expect((await off.runOnce()).skipped).toBe('disabled');

    service.saveSettings({ idleConsolidation: true });
    const busy = consolidator(complete, { isBusy: () => true });
    makeIdle(busy);
    expect((await busy.runOnce()).skipped).toBe('busy');
    expect(complete).not.toHaveBeenCalled();
  });

  it('没有空闲槽：跳过并顺延，不排队、不做任何写入', async () => {
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const logs: string[] = [];
    const c = consolidator(async () => '{"merges":[]}', {
      acquireInternalSlot: async () => null,
      logger: { log: (entry: { msg: string }) => { logs.push(entry.msg); return Promise.resolve(); } } as never,
    });
    makeIdle(c);
    const result = await c.runOnce();
    expect(result.skipped).toBe('no-idle-slot');
    expect(result.calls).toBe(0);
    expect(service.list().pending).toHaveLength(0);
    expect(service.store.getConsolidationLastRun()).toBe(0);
    expect(logs).toContain('memory consolidation skipped: no idle slot');
  });

  it('整合输出畸形：该阶段整批丢弃 + errors.db 记录 + 不产生提案', async () => {
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const c = consolidator(async () => '好的，我合并如下：{...}');
    makeIdle(c);
    const result = await c.runOnce();
    expect(result.proposals).toBe(0);
    expect(service.list().pending).toHaveLength(0);
    expect(errors.list().some((e) => e.source === 'memory.consolidate-parse')).toBe(true);
  });

  it('没有可用模型，或确实无事可做：不调模型、不写库，各自返回对应出口', async () => {
    const complete = vi.fn(async () => '{}');
    const noModel = consolidator(complete, { target: () => null });
    makeIdle(noModel);
    expect((await noModel.runOnce()).skipped).toBe('no-model');
    expect(complete).not.toHaveBeenCalled();

    // 没有任何相似对、旧情景、过期项目事实 → 一次都不该调
    const idle = consolidator(complete);
    makeIdle(idle);
    const result = await idle.runOnce();
    expect(result.skipped).toBe('nothing-to-do');
    expect(result.calls).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(service.list().pending).toHaveLength(0);
  });

  it('模型给不存在的 targetId 或越界文本：忽略该条，不落提案', async () => {
    const a = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    const b = service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句话' });
    const payload = {
      merges: [
        { keepId: 'mem_not_exist', dropId: b.id, text: '编造的合并' },
        { keepId: a.id, dropId: b.id, text: 'x'.repeat(260) },
      ],
    };
    const c = consolidator(async () => JSON.stringify(payload));
    makeIdle(c);
    const result = await c.runOnce();
    expect(result.proposals).toBe(0);
    expect(service.list().pending).toHaveLength(0);
  });
});
