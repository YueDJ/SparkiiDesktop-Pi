import { describe, it, expect, vi } from 'vitest';
import { runShutdownSequence, type ShutdownHooks } from '../electron/main/shutdown.js';
import { PiRuntimePool } from '@sparkii/agent-host';

/** §7.7 固定顺序，逐字与 shutdown.ts 的 STEPS 对齐。 */
const NAMES = [
  'abortPendingApprovals',
  'stopPool',
  'stopDocumentParse',
  'disposeReviewer',
  'closeStores',
  'snapshotData',
] as const;

function makeHooks() {
  const order: string[] = [];
  const recorded: { abortedCount?: number; reason?: string } = {};
  let tick = 0;
  const hooks: ShutdownHooks = {
    abortPendingApprovals: vi.fn(async (reason: string) => {
      order.push('abortPendingApprovals');
      recorded.reason = reason;
      recorded.abortedCount = 3;
      return 3;
    }),
    stopPool: vi.fn(async () => { order.push('stopPool'); }),
    stopDocumentParse: vi.fn(async () => { order.push('stopDocumentParse'); }),
    disposeReviewer: vi.fn(async () => { order.push('disposeReviewer'); }),
    closeStores: vi.fn(async () => { order.push('closeStores'); }),
    snapshotData: vi.fn(async () => { order.push('snapshotData'); }),
    now: vi.fn(() => ++tick),
  };
  return { hooks, order, recorded };
}

describe('runShutdownSequence（§7.7 关机顺序）', () => {
  it('runs the six steps in the fixed order with monotonic timestamps', async () => {
    const { hooks, order } = makeHooks();
    const steps = await runShutdownSequence(hooks);

    expect(steps.map((s) => s.name)).toEqual([...NAMES]);
    expect(order).toEqual([...NAMES]);
    expect(steps).toHaveLength(6);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].at).toBeGreaterThanOrEqual(steps[i - 1].at);
    }
    expect(steps[0].at).toBeGreaterThanOrEqual(1);
  });

  it('records the count returned by the approval gate and awaits it before later steps', async () => {
    const { hooks, order, recorded } = makeHooks();
    await runShutdownSequence(hooks);

    expect(hooks.abortPendingApprovals).toHaveBeenCalledTimes(1);
    expect(hooks.abortPendingApprovals).toHaveBeenCalledWith(expect.any(String));
    expect(recorded.reason).not.toBe('');
    expect(recorded.abortedCount).toBe(3); // 审批门返回数量被记录
    expect(order[0]).toBe('abortPendingApprovals'); // 先清空审批门，后才停池
    expect(order).toEqual([...NAMES]);
  });

  it.each(NAMES)('aborts all later steps when %s throws (fail closed)', async (failAt) => {
    const { hooks, order } = makeHooks();
    const boom = new Error(`boom:${failAt}`);
    Object.assign(hooks, {
      [failAt]: vi.fn(async () => {
        order.push(failAt);
        throw boom;
      }),
    });

    await expect(runShutdownSequence(hooks)).rejects.toThrow(`boom:${failAt}`);
    const idx = NAMES.indexOf(failAt);
    expect(order).toEqual([...NAMES.slice(0, idx + 1)]);
  });
});

describe('PiRuntimePool stopped 闸门（§0.7 P0-1，复用 stopAll，不新增 stop()）', () => {
  it('stopAll() is idempotent and acquire() rejects new sessions afterwards', async () => {
    const makeSupervisor = vi.fn(() => {
      throw new Error('must not start a runtime after stopAll');
    });
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor });

    await expect(pool.stopAll()).resolves.toBeUndefined();
    await expect(pool.stopAll()).resolves.toBeUndefined(); // 幂等：重复调用不抛错
    await expect(pool.acquire('after-stop')).rejects.toThrow('pool stopped');
    expect(makeSupervisor).not.toHaveBeenCalled();

    // 既有行为保持不变：snapshot / setMaxAgents 仍可用
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, maxAgents: 1 });
    pool.setMaxAgents(2);
    expect(pool.snapshot().maxAgents).toBe(2);
  });
});
