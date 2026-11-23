import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorStore } from '../electron/main/error-store.js';
import { MemoryService } from '../electron/main/memory/service.js';
import { ExtractionScheduler } from '../electron/main/memory/extraction.js';
import { parseExtraction, trigramSimilarity } from '../electron/main/memory/ops.js';
import { materialFromTurns } from '../electron/main/memory/material.js';
import { userMemoryFile } from '../electron/main/memory/settings.js';
import { PiRuntimePool } from '../../../packages/agent-host/src/pi-runtime-pool.ts';

let root: string;
let dataDir: string;
let errors: ErrorStore;
let service: MemoryService;

const TURNS = [
  { role: 'user' as const, text: '以后所有汇报先给结论，正文不超过三句' },
  { role: 'assistant' as const, text: '好的，我会按这个格式。' },
  { role: 'user' as const, text: '另外项目周报也要这样写' },
  { role: 'assistant' as const, text: '收到。' },
  { role: 'user' as const, text: '记住我的格式偏好' },
];

const VALID = JSON.stringify({
  sessionSummary: '用户明确了汇报格式偏好',
  topics: ['汇报格式'],
  ops: [{
    op: 'ADD', scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句',
    importance: 3, excerpt: '以后所有汇报先给结论',
  }],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sparkii-extract-'));
  dataDir = join(root, 'data');
  errors = new ErrorStore(join(dataDir, 'errors.db'));
  service = new MemoryService({ dataDir, errors, sessionExists: () => true });
});

afterEach(() => {
  service.close();
  errors.close();
  rmSync(root, { recursive: true, force: true });
});

function scheduler(complete: (prompt: string) => Promise<string>, overrides: Partial<ConstructorParameters<typeof ExtractionScheduler>[0]> = {}) {
  return new ExtractionScheduler({
    service, errors,
    contextOf: (sessionId) => ({ sessionId, profileId: 'general', workspaceKind: 'auto', piSessionFile: '' }),
    target: () => ({ provider: 'p', modelId: 'm' }),
    complete: async (prompt) => complete(prompt),
    materialOf: () => materialFromTurns(TURNS),
    ...overrides,
  });
}

describe('memory extraction', () => {
  it('JSON 协议 fail closed：畸形/越界/非法 op 整批抛错', () => {
    expect(() => parseExtraction(VALID)).not.toThrow();
    expect(() => parseExtraction('{not json')).toThrow();
    expect(() => parseExtraction(JSON.stringify({ sessionSummary: 'x', topics: [], ops: [{ op: 'ADD', text: '' }] }))).toThrow();
    expect(() => parseExtraction(JSON.stringify({ sessionSummary: 'x', topics: [], ops: Array(6).fill({ op: 'NOOP' }) }))).toThrow();
    expect(() => parseExtraction(JSON.stringify({ sessionSummary: 'x', topics: [], ops: [{ op: 'DELETE' }] }))).toThrow();
    expect(trigramSimilarity('用户要求汇报先给结论', '用户要求汇报先给结论')).toBe(1);
  });

  it('端到端：对话增量 → pending（含来源 excerpt）→ 批准 → 下一条会话注入', async () => {
    const s = scheduler(async () => VALID);
    const result = await s.flush('sess-1');
    expect(result.opsApplied).toBe(1);
    const pending = service.list().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].source?.excerpt).toContain('以后所有汇报先给结论');
    expect(service.buildBlock({ sessionId: 'sess-2', profileId: 'general' })).not.toContain('先给结论');
    service.resolvePending(pending[0].id, 'approve');
    expect(service.buildBlock({ sessionId: 'sess-3', profileId: 'general' })).toContain('先给结论');
    expect(service.store.listEpisodes()).toHaveLength(1);
    expect(service.store.getExtractionState('sess-1').lastRunAt).toBeGreaterThan(0);
  });

  it('驳回后进黑名单，同候选不再提案', async () => {
    const s = scheduler(async () => VALID);
    await s.flush('sess-1');
    const pending = service.list().pending[0];
    service.resolvePending(pending.id, 'reject');
    const second = scheduler(async () => VALID);
    await second.flush('sess-1');
    expect(service.list().pending).toHaveLength(0);
    expect(service.store.listEpisodes()).toHaveLength(1);
  });

  it('同 scope 高相似 ADD 降级为 UPDATE 候选', async () => {
    service.addMemory({ scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句' });
    const s = scheduler(async () => VALID);
    await s.flush('sess-1');
    const pending = service.list().pending[0];
    expect(pending.pendingOp?.op).toBe('UPDATE');
    expect(pending.pendingOp?.targetId).toBeTruthy();
  });

  it('畸形输出：整批丢弃 + errors.db 有记录 + 真相源无半批写入', async () => {
    const s = scheduler(async () => '{oops');
    const result = await s.flush('sess-1');
    expect(result.skipped).toBe('parse-failed');
    expect(service.list().pending).toHaveLength(0);
    expect(service.store.listEpisodes()).toHaveLength(0);
    expect(service.store.getExtractionState('sess-1').lastRunAt).toBe(0);
    expect(errors.list().some((e) => e.source === 'memory.extract-parse')).toBe(true);
    expect(existsSync(userMemoryFile(dataDir))).toBe(false);
  });

  it('auto 工作区的项目候选只落用户层', async () => {
    const payload = {
      sessionSummary: '临时工作区的偏好', topics: [],
      ops: [{ op: 'ADD', scope: 'project', text: '临时目录里形成的通用偏好', importance: 2 }],
    };
    const s = scheduler(async () => JSON.stringify(payload), {
      contextOf: (sessionId) => ({
        sessionId, profileId: 'general', workspacePath: join(root, 'auto'), workspaceKind: 'auto', piSessionFile: '',
      }),
    });
    await s.flush('sess-auto');
    const pending = service.list().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].scope).toBe('user');
  });

  it('user 工作区的首条项目候选：项目文件尚不存在也能落 pending 并生成 projectId', async () => {
    const workspacePath = join(root, 'ws');
    mkdirSync(workspacePath, { recursive: true });
    const payload = {
      sessionSummary: '项目口径', topics: ['报价'],
      ops: [{ op: 'ADD', scope: 'project', text: '本项目报价一律使用人民币', importance: 2 }],
    };
    const s = scheduler(async () => JSON.stringify(payload), {
      contextOf: (sessionId) => ({
        sessionId, profileId: 'general', workspacePath, workspaceKind: 'user', piSessionFile: '',
      }),
    });
    await s.flush('sess-proj');
    const pending = service.list().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].scope).toMatch(/^project:proj_/);
    expect(pending[0].workspacePath).toBe(workspacePath.replace(/\\/g, '/'));
    // 真相源文件由这次 pending 写入创建，projectId 与候选一致
    const file = join(workspacePath, '.sparkii', 'memory.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projectId: string; entries: Array<{ id: string }> };
    expect(`project:${parsed.projectId}`).toBe(pending[0].scope);
    expect(parsed.entries.map((e) => e.id)).toContain(pending[0].id);
  });

  it('同一候选重复提炼：已有高相似 pending 时不再重复提案', async () => {
    const payload = {
      sessionSummary: '重复提炼', topics: [],
      ops: [{ op: 'ADD', scope: 'user', text: '用户要求所有汇报先给结论，正文不超过三句', importance: 3 }],
    };
    const s = scheduler(async () => JSON.stringify(payload));
    await s.flush('sess-1');
    expect(service.list().pending).toHaveLength(1);
    await s.flush('sess-2');
    expect(service.list().pending).toHaveLength(1);
  });

  it('开关关闭：零模型调用', async () => {
    service.saveSettings({ autoExtract: false });
    const complete = vi.fn(async () => VALID);
    const s = scheduler(complete);
    const result = await s.flush('sess-1');
    expect(result.skipped).toBe('disabled');
    expect(complete).not.toHaveBeenCalled();
  });

  it('槽位礼让：池满跳过、无排队；交互 acquire 不受影响', async () => {
    const pool = new PiRuntimePool({
      maxAgents: 1,
      makeSupervisor: () => {
        let onMessage: (e: Record<string, unknown>) => void = () => {};
        const handle = {
          postMessage: (envelope: Record<string, unknown>) => {
            if (envelope.command) {
              onMessage({
                direction: 'runtime-to-main',
                id: envelope.id,
                response: { success: true, data: {} },
              });
            }
          },
          onMessage: (cb: (e: Record<string, unknown>) => void) => {
            onMessage = cb;
            cb({ direction: 'runtime-to-main', ready: true });
            return () => {};
          },
          onExit: () => () => {},
          kill: () => {},
        };
        return handle as never;
      },
    });
    const busy = await pool.acquire('interactive');
    expect(busy).toBeTruthy();
    const complete = vi.fn(async () => VALID);
    const logs: Array<{ msg: string }> = [];
    let released = false;
    const s = scheduler(complete, {
      logger: { log: async (entry: { msg: string }) => { logs.push(entry); } } as never,
      acquireInternalSlot: async () => {
        const slot = await pool.acquireIfIdle('memory:test', { meta: { profileId: 'internal', internal: true } });
        return slot ? { release: async () => { released = true; await pool.release('memory:test'); } } : null;
      },
    });
    const result = await s.flush('sess-1');
    expect(result.skipped).toBe('no-idle-slot');
    expect(complete).not.toHaveBeenCalled();
    expect(pool.snapshot().queued).toBe(0);
    expect(pool.snapshot().queue).toEqual([]);
    expect(logs.some((entry) => entry.msg.includes('no idle slot'))).toBe(true);
    expect(released).toBe(false);
    await pool.release('interactive');
  });
});
