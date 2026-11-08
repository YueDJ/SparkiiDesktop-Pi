/**
 * 主 Agent 集成层单测：update-bootstrap.ts（§7.7 关机协议装配 + §7.10 调度）。
 * 全部零 Electron、零网络：定时器与 powerMonitor/net 均以结构化对象注入。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logUpdateEvent, resetAuditThrottle } from '../electron/main/update/audit.js';
import {
  SEQ_MIRROR_KEY_NAME, UNAVAILABLE_DOWNGRADE_MS, UPDATE_HMAC_KEY_NAME,
  createShutdownController, createShutdownHooks, createUpdateAuditSink, createUpdateQuitGuard, resolveUpdateHmacKey, startUpdateScheduling,
} from '../electron/main/update-bootstrap.js';
import { runShutdownSequence, type ShutdownHooks } from '../electron/main/shutdown.js';
import type { UpdateActionResult } from '../electron/main/update/types.js';

const ok: UpdateActionResult = { ok: true };
const gateBad = (reason: string): UpdateActionResult => ({ ok: false, reason });

function fakeKeyring(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (name: string) => (store.has(name) ? store.get(name)! : null),
    set: async (name: string, value: string) => { store.set(name, value); },
  };
}

describe('resolveUpdateHmacKey（§6.3 第 4 条）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sparkii-hmac-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('首次生成 32 字节密钥并回读一致', async () => {
    const kr = fakeKeyring();
    const secret = await resolveUpdateHmacKey(kr);
    expect(secret.length).toBe(32);
    expect(kr.store.get(UPDATE_HMAC_KEY_NAME)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('第二次调用复用同一密钥（否则每次启动状态都对不上）', async () => {
    const kr = fakeKeyring();
    const a = await resolveUpdateHmacKey(kr);
    const b = await resolveUpdateHmacKey(kr);
    expect(b.equals(a)).toBe(true);
  });

  it('写不进 keyring（DPAPI 不可用）即抛错，绝不返回内存随机密钥', async () => {
    const kr = {
      get: async () => null,
      set: async () => { throw new Error('safeStorage unavailable'); },
    };
    await expect(resolveUpdateHmacKey(kr)).rejects.toThrow(/could not be persisted|safeStorage/);
  });

  it('存了非十六进制的脏值 → 重新生成而不是拿来用', async () => {
    const kr = fakeKeyring({ [UPDATE_HMAC_KEY_NAME]: 'not-hex-at-all' });
    const secret = await resolveUpdateHmacKey(kr);
    expect(secret.length).toBe(32);
    expect(/^[0-9a-f]{64}$/.test(kr.store.get(UPDATE_HMAC_KEY_NAME) ?? '')).toBe(true);
  });

  it('随机性：两次全新装配的密钥不同', async () => {
    const a = await resolveUpdateHmacKey(fakeKeyring());
    const b = await resolveUpdateHmacKey(fakeKeyring());
    expect(a.equals(b)).toBe(false);
  });
});

describe('createShutdownHooks（§7.7 句柄接线 + §7.9 install-abort 留痕）', () => {
  // update.* 审计按「类型 + 天 + reason」限流（§7.9 防 MITM 刷库）；
  // 本组用同一 action/reason 多次断言，必须逐例重置限流表，否则后一例会被合法地去重掉。
  beforeEach(() => { resetAuditThrottle(); });

  function rtFixture(opts: { aborted?: number; snapshot?: { ok: boolean; reason?: string } } = {}) {
    const order: string[] = [];
    const audit = {
      append: vi.fn(async () => { order.push('audit.append'); }),
      close: vi.fn(() => { order.push('audit.close'); }),
    };
    const rt = {
      pool: { stopAll: async () => { order.push('stopPool'); } },
      audit,
      chatSessions: { close: () => { order.push('chatSessions.close'); } },
      errors: { close: () => { order.push('errors.close'); } },
      gate: { abortPendingForQuit: async (reason: string) => { order.push(`gate:${reason}`); return opts.aborted ?? 0; } },
      reviewer: { dispose: async () => { order.push('reviewer.dispose'); } },
      documentParseSupervisor: { beginQuit: async () => { order.push('docParse.beginQuit'); } },
    };
    const snapshot = vi.fn(async () => opts.snapshot ?? { ok: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hooks = createShutdownHooks(rt as never, '/tmp/fake-data', { audit, logger, snapshot });
    return { hooks, order, audit, snapshot, logger };
  }

  it('有待审批被放弃 ⇒ 按 §7.9 事件名补写 update.install-abort（gate 自己只写 proposal.expired）', async () => {
    const f = rtFixture({ aborted: 3 });
    const n = await f.hooks.abortPendingApprovals('update-install');
    expect(n).toBe(3);
    const written = f.audit.append.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(written.some((r) => r.action === 'update.install-abort'
      && String(r.payloadSummary).includes('"aborted":3'))).toBe(true);
  });

  it('没有被放弃的提案 ⇒ 不写空事件（避免审计噪音）', async () => {
    const f = rtFixture({ aborted: 0 });
    await f.hooks.abortPendingApprovals('update-install');
    expect(f.audit.append).not.toHaveBeenCalled();
  });

  it('六个钩子各自接到正确的 Runtime 句柄，且 closeStores 顺序固定 audit→chatSessions→errors', async () => {
    const f = rtFixture({ aborted: 1 });
    await runShutdownSequence(f.hooks);
    expect(f.order).toEqual([
      'gate:update-install', 'audit.append',
      'stopPool', 'docParse.beginQuit', 'reviewer.dispose',
      'audit.close', 'chatSessions.close', 'errors.close',
    ]);
    expect(f.snapshot).toHaveBeenCalledWith('/tmp/fake-data', expect.stringMatching(/^shutdown-\d+$/), ['updates']);
  });

  it('快照失败 ⇒ 抛错中止（不带着未快照的现场进入安装）', async () => {
    const f = rtFixture({ snapshot: { ok: false, reason: 'REQUIRES_UNMET' } });
    await expect(runShutdownSequence(f.hooks)).rejects.toThrow(/REQUIRES_UNMET/);
  });

  it('占位快照语义（INSTALL_BLOCKED）按「本轮不做快照」跳过而不是失败', async () => {
    const f = rtFixture({ snapshot: { ok: false, reason: 'INSTALL_BLOCKED' } });
    await expect(runShutdownSequence(f.hooks)).resolves.toHaveLength(6);
  });
});

function hookRecorder(): ShutdownHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    abortPendingApprovals: async (reason) => { calls.push(`abort:${reason}`); return 2; },
    stopPool: async () => { calls.push('stopPool'); },
    stopDocumentParse: async () => { calls.push('stopDocumentParse'); },
    disposeReviewer: async () => { calls.push('disposeReviewer'); },
    closeStores: async () => { calls.push('closeStores'); },
    snapshotData: async () => { calls.push('snapshotData'); },
    now: () => 1000,
  };
}

describe('createUpdateAuditSink（§7.9 verify-failed 镜像到 errors）', () => {
  const rec = (action: string, payloadSummary?: string) => ({
    actor: 'update-service', action, resource: 'auto-update', decision: 'deny', payloadSummary,
  });

  it('verify-failed 同时进 audit 与 errors，且消息带上失败原因', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const errors = { append: vi.fn() };
    const sink = createUpdateAuditSink(audit, errors, () => 1_700_000_000_000);
    await sink.append(rec('update.verify-failed', JSON.stringify({ reason: 'SIGNATURE_INVALID' })));
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(errors.append).toHaveBeenCalledTimes(1);
    const pushed = errors.append.mock.calls[0][0] as Record<string, unknown>;
    expect(pushed.source).toBe('update');
    expect(String(pushed.message)).toContain('SIGNATURE_INVALID');
    expect(String(pushed.id)).toBe('update-verify-failed-1700000000000');
  });

  it('普通 update.* 事件（有新版 / 下载完成）绝不进 errors —— 更新提示不是错误（§7.5）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const errors = { append: vi.fn() };
    const sink = createUpdateAuditSink(audit, errors);
    await sink.append(rec('update.available', '{"version":"0.3.0"}'));
    await sink.append(rec('update.download-complete', '{"version":"0.3.0"}'));
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(errors.append).not.toHaveBeenCalled();
  });

  it('没有 errors store / payloadSummary 畸形都不抛错，审计主链路不受影响', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const sinkNoErrors = createUpdateAuditSink(audit, undefined);
    await expect(sinkNoErrors.append(rec('update.verify-failed', 'not-json'))).resolves.toBeUndefined();
    const errors = { append: vi.fn() };
    const sink = createUpdateAuditSink(audit, errors);
    await sink.append(rec('update.verify-failed', 'not-json'));
    expect(errors.append).toHaveBeenCalledTimes(1);
    expect(String(errors.append.mock.calls[0][0].message)).not.toContain('undefined');
  });

  it('errors 镜像写抛错时不抛穿，且「已成功留痕」仍被记账（I-77① 复合条件 / R20 表4）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const sink = createUpdateAuditSink(audit, {
      append: () => { throw new Error('errors.db locked'); },
    }, () => 1_700_000_000_000);
    await expect(sink.append(rec('update.verify-failed', '{"reason":"SIGNATURE_INVALID"}'))).resolves.toBeUndefined();
    expect(audit.append).toHaveBeenCalledTimes(1);
    // 复合条件：若 errors.append 抛穿，logUpdateEvent 会把这次当成「没留痕」而不记限流键，
    // 于是同一条现场当天被反复重新提交（§7.9 防刷库被旁路）。删掉那段 try/catch ⇒ 下面这条必红。
    resetAuditThrottle(() => Date.UTC(2026, 10, 9, 12));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const fields = { reason: 'STATE_TAMPERED', subreason: 'STATE_MAC_BROKEN' };
    await logUpdateEvent(sink, 'update.verify-failed', fields, logger);
    await logUpdateEvent(sink, 'update.verify-failed', fields, logger);
    expect(audit.append, '两次同现场只应落库一次（首次直调 + 限流后那次）').toHaveBeenCalledTimes(2);
  });

  it('同一毫秒重复镜像也不会被 INSERT OR IGNORE 吞掉（id 仍按时间戳，重复由上层限流挡）', async () => {
    const audit = { append: vi.fn(async () => ({})) };
    const ids: string[] = [];
    const errors = { append: vi.fn((r: { id: string }) => { ids.push(r.id); }) };
    let t = 1_700_000_000_000;
    const sink = createUpdateAuditSink(audit, errors, () => t);
    await sink.append(rec('update.verify-failed', '{"reason":"EXPIRED"}'));
    t += 1;
    await sink.append(rec('update.verify-failed', '{"reason":"EXPIRED"}'));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('createShutdownController（§7.7 幂等）', () => {  it('runOnce 只跑一遍，顺序严格为 abort→pool→docparse→reviewer→stores→snapshot', async () => {
    const hooks = hookRecorder();
    const c = createShutdownController(hooks);
    expect(c.hasRun()).toBe(false);
    await c.runOnce();
    await c.runOnce();
    expect(hooks.calls).toEqual([
      'abort:update-install', 'stopPool', 'stopDocumentParse', 'disposeReviewer', 'closeStores', 'snapshotData',
    ]);
    expect(c.hasRun()).toBe(true);
    expect(c.steps().map((s) => s.name)).toHaveLength(6);
  });

  it('并发调用共享同一趟执行（不重复关库）', async () => {
    const hooks = hookRecorder();
    const c = createShutdownController(hooks);
    const [a, b] = await Promise.all([c.runOnce(), c.runOnce()]);
    expect(a.map((s) => s.name)).toEqual(b.map((s) => s.name));
    expect(hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(1);
  });

  it('某步失败：中止后续步骤、hasRun 仍为 false、onError 被调用', async () => {
    const hooks = hookRecorder();
    hooks.stopPool = async () => { throw new Error('pool refused'); };
    const onError = vi.fn();
    const c = createShutdownController(hooks, { onError });
    await expect(c.runOnce()).rejects.toThrow('pool refused');
    expect(hooks.calls.some((x) => x === 'closeStores')).toBe(false);
    expect(c.hasRun()).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('拆过现场之后再进来 ⇒ runOnce 拒绝第二遍，一步都不重复执行（I-40：立刻再点「安装」是另一扇门）', async () => {
    const hooks = hookRecorder();
    hooks.snapshotData = async () => { throw new Error('snapshot failed'); };
    const c = createShutdownController(hooks);
    await expect(c.runOnce()).rejects.toThrow('snapshot failed');
    const afterFirst = hooks.calls.length;
    expect(c.dismantled()).toBe(true);
    await expect(c.runOnce()).rejects.toThrow(/already dismantled/);
    expect(hooks.calls).toHaveLength(afterFirst);        // 第二次连一步都没有执行
    expect(c.hasRun()).toBe(false);                       // 也没有被伪装成「已完成」
  });

  it('只有「审批门显式过期」进去过时不算拆掉现场 ⇒ 仍可正常重跑（拒绝重跑不得变成永久封锁）', async () => {
    const hooks = hookRecorder();
    hooks.abortPendingApprovals = async () => { throw new Error('gate down'); };
    const c = createShutdownController(hooks);
    await expect(c.runOnce()).rejects.toThrow('gate down');
    expect(c.dismantled()).toBe(false);
    expect(c.progress()).toEqual(['abortPendingApprovals']);
    hooks.abortPendingApprovals = async () => 0;          // 审批门恢复
    await c.runOnce();
    expect(c.hasRun()).toBe(true);
    expect(hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(1);
  });
});

function guardFixture(opts: { updating?: boolean; runFails?: boolean } = {}) {
  const hooks = hookRecorder();
  if (opts.runFails) hooks.snapshotData = async () => { throw new Error('snapshot failed'); };
  const controller = createShutdownController(hooks);
  const isUpdatingRef = { value: opts.updating ?? false };
  const quit = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const serviceOnBeforeQuit = vi.fn(() => controller.hasRun());
  const guard = createUpdateQuitGuard({
    service: { onBeforeQuit: serviceOnBeforeQuit },
    controller,
    app: { quit },
    isUpdatingRef,
    logger,
  });
  const preventDefault = vi.fn();
  return { guard, hooks, quit, isUpdatingRef, preventDefault, controller, logger };
}

describe('createUpdateQuitGuard（§7.7 步骤 1 与 document-parse 钩子的分工）', () => {
  it('普通退出：不 preventDefault、不跑关机序列（保持既有退出语义）', async () => {
    const f = guardFixture({ updating: false });
    f.guard({ preventDefault: f.preventDefault });
    await Promise.resolve();
    expect(f.preventDefault).not.toHaveBeenCalled();
    expect(f.hooks.calls).toEqual([]);
    expect(f.quit).not.toHaveBeenCalled();
  });

  it('更新退出且序列未跑：先 preventDefault，跑完序列再 quit', async () => {
    const f = guardFixture({ updating: true });
    f.guard({ preventDefault: f.preventDefault });
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledTimes(1));
    expect(f.preventDefault).toHaveBeenCalledTimes(1);
    expect(f.hooks.calls).toHaveLength(6);
    expect(f.isUpdatingRef.value).toBe(true); // 更新标志保留到真正退出
  });

  it('更新退出但序列已完成：直接放行（不 preventDefault，避免二次 quit 竞争）', async () => {
    const f = guardFixture({ updating: true });
    await f.controller.runOnce();
    f.preventDefault.mockClear();
    f.guard({ preventDefault: f.preventDefault });
    await Promise.resolve();
    expect(f.preventDefault).not.toHaveBeenCalled();
    expect(f.hooks.calls).toHaveLength(6); // 没有第二遍
  });

  it('序列**正在进行**时到来的第二次退出 ⇒ 必须继续拦着退出，而不是放行（R4 · Major-1）', async () => {
    const f = guardFixture({ updating: true });
    let releaseCloseStores: () => void = () => {};
    f.hooks.closeStores = () => new Promise<void>((resolve) => {
      f.hooks.calls.push('closeStores');
      releaseCloseStores = resolve;
    });
    f.guard({ preventDefault: f.preventDefault });                 // 第一次：拦下并开跑
    // 等到拆机真的推进到 closeStores（序列逐步 await，一次微任务还不够）
    await vi.waitFor(() => expect(f.hooks.calls).toContain('closeStores'));
    expect(f.controller.running()).toBe(true);
    expect(f.preventDefault).toHaveBeenCalledTimes(1);
    expect(f.quit).not.toHaveBeenCalled();

    f.guard({ preventDefault: f.preventDefault });                 // 第二次：仍在拆机中
    expect(f.preventDefault).toHaveBeenCalledTimes(2);             // 绝不能放行
    expect(f.hooks.calls.filter((x) => x === 'stopPool')).toHaveLength(1);   // 也没有拆第二遍
    expect(f.quit).not.toHaveBeenCalled();

    releaseCloseStores();
    // 两个等待者各自请求一次退出：`app.quit()` 可重入，重复请求只会再派一次 before-quit，
    // 而那时序列已完成 ⇒ 守卫直接放行（R7 · N-1：以前这里用一次性闩锁去重，反而把退出永久锁死）。
    await vi.waitFor(() => expect(f.quit.mock.calls.length).toBeGreaterThanOrEqual(1));
    expect(f.hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(1);
    expect(f.hooks.calls.filter((x) => x === 'stopPool')).toHaveLength(1);
    expect(f.controller.hasRun()).toBe(true);
  });

  it('在飞的那趟失败之后再请求退出 ⇒ 不能出现「六步全做完却没人退出」的死区（R7 · N-1）', async () => {
    // 现场建模：安装事务自己已经开了 `runOnce()`（在飞），此刻用户关窗 ⇒ 守卫挂在同一趟上；
    // 那趟在**第一步（审批门显式过期）**就失败 ⇒ 现场其实没被拆过。
    // 旧实现的两处叠加导致僵尸态：①在飞分支的 reject 不撤销 `isUpdating`；
    // ②`doQuit()` 的一次性闩锁已在第一次 reject 时立死 ⇒ 随后重跑成功也没人再请求退出，
    // 进程带着已关闭的库常驻（正是 I-33 禁止的形态）。
    const f = guardFixture({ updating: true });
    let attempt = 0;
    f.hooks.abortPendingApprovals = async () => {
      f.hooks.calls.push('abort:attempt');
      attempt += 1;
      if (attempt === 1) throw new Error('gate busy');
      return 0;
    };
    // 用「quit() 再派一次 before-quit」建模 Electron 的退出重入
    f.quit.mockImplementation(() => { f.guard({ preventDefault: f.preventDefault }); });

    const inFlight = f.controller.runOnce().catch(() => undefined);   // 事务那趟（会失败）
    f.guard({ preventDefault: f.preventDefault });                    // 用户关窗 ⇒ 走「在飞」分支
    expect(f.preventDefault).toHaveBeenCalledTimes(1);
    await inFlight;
    await vi.waitFor(() => expect(f.quit.mock.calls.length).toBeGreaterThanOrEqual(1));
    // 关键：这一次退出必须**真的能走通**，不能又被拦一次去重跑（拦两次 = 旧实现的死区）
    expect(f.preventDefault, '在飞分支失败后的退出不得再被拦下重跑').toHaveBeenCalledTimes(1);
    expect(f.isUpdatingRef.value).toBe(false);                        // 现场未拆 ⇒ 退回普通退出语义
    expect(f.hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(0);
  });

  it('序列失败：撤销 isUpdating 回到普通退出语义，并记日志（绝不带着半关机状态继续安装）', async () => {
    const f = guardFixture({ updating: true, runFails: true });
    f.guard({ preventDefault: f.preventDefault });
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledTimes(1));
    expect(f.isUpdatingRef.value).toBe(false);
    expect(f.logger.error).toHaveBeenCalled();
  });

  it('现场已进入过但序列没跑完 ⇒ 守卫绝不二次 runOnce（R3 · Blocker-2：closeStores / 整盘快照不能被跑两遍）', async () => {
    const f = guardFixture({ updating: true, runFails: true });
    // 模拟安装侧的不可逆失败：blocked() 保持 isUpdating=true 并 requestQuit ⇒ 触发第一次守卫。
    // 第一次尝试已经把六步全部「进入」过（snapshotData 在最后抛），所以现场已不可逆。
    f.guard({ preventDefault: f.preventDefault });
    await vi.waitFor(() => expect(f.hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(1));
    // 安装侧的失败路径不会撤销 isUpdating ⇒ 第二次 before-quit 仍然进得来守卫，这里钉住不重跑。
    f.isUpdatingRef.value = true;
    f.preventDefault.mockClear();
    f.guard({ preventDefault: f.preventDefault });
    await Promise.resolve();
    expect(f.preventDefault).not.toHaveBeenCalled();                     // 直接放行退出
    expect(f.hooks.calls.filter((x) => x === 'closeStores')).toHaveLength(1);
    // snapshotData 在 fixture 里被换成「抛错版本」（不写 calls），所以它的痕迹只在 progress() 里
    expect(f.controller.progress()).toContain('closeStores');            // 判据本身有真实记录
    expect(f.controller.progress()).toContain('snapshotData');
    expect(f.logger.warn).toHaveBeenCalled();
  });
});

interface SchedFixtureOptions {
  results: UpdateActionResult[];
  settings?: Record<string, unknown>;
  net?: { online: boolean };
  hasActiveWork?: () => boolean;
  /** 注入抖动种子（m4 要验证不同 install 的排期确实不同）。缺省 'unit-test-seed'。 */
  jitterSeed?: string;
}

function schedFixture(o: SchedFixtureOptions) {
  const timers: Array<{ ms: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const results = [...o.results];
  const calls: Array<{ force?: boolean; trigger?: string | null }> = [];
  const service = {
    async checkForUpdate(force?: boolean, trigger?: 'network' | 'system' | null) {
      calls.push({ force, trigger });
      return results.length > 1 ? results.shift()! : results[0]!;
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: 1_700_000_000_000 };
  const handle = startUpdateScheduling({
    service,
    settings: async () => ({ update: { startupDelaySeconds: 0, ...o.settings } }) as never,
    logger,
    now: () => clock.now,
    hasActiveWork: o.hasActiveWork,
    net: o.net,
    jitterSeed: o.jitterSeed ?? 'unit-test-seed',
    setTimer: (ms, fn) => { const t = { ms, fn, id: nextId++ }; timers.push(t); return t; },
    clearTimer: (h) => {
      const idx = timers.findIndex((t) => t === h);
      if (idx >= 0) timers.splice(idx, 1);
    },
  });
  const fireNext = () => {
    const t = timers.shift();
    t?.fn();
    return t?.ms ?? null;
  };
  /** 推进注入时钟（m6 的降级按累计不可用时长判定，用例需要让时间流逝）。 */
  const advance = (ms: number): void => { clock.now += ms; };
  return { handle, timers, calls, logger, fireNext, nowMs: () => clock.now, advance };
}

describe('startUpdateScheduling（§7.10）', () => {
  it('配好更新源后：启动即刻检查（startupDelay=0），首轮 ok 后排到 24h 周期窗口', async () => {
    const f = schedFixture({
      results: [ok],
      settings: { baseUrl: 'http://127.0.0.1:8080/sparkii-updates/', checkIntervalHours: 24 },
    });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    const first = f.timers.shift()!;
    expect(first.ms).toBeLessThanOrEqual(180_000); // 0s 延迟 × 抖动仍在分钟级
    first.fn();
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(0));
    expect(f.calls[0]?.force).toBe(false);         // 自动检查绝不 force
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    const ms = f.timers[0]!.ms;
    // 周期心跳落在 [24h×0.8, 24h×1.2] 窗口内（±15% 抖动）
    expect(ms).toBeGreaterThanOrEqual(24 * 3_600_000 * 0.8);
    expect(ms).toBeLessThanOrEqual(24 * 3_600_000 * 1.2);
  });

  it('未配更新源（baseUrl 空）：不做启动检查，只留闸门心跳', async () => {
    const f = schedFixture({ results: [gateBad('NO_BASE_URL')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    expect(f.timers[0]!.ms).toBe(15 * 60_000);
    expect(f.calls).toHaveLength(0);
  });

  it('ACTIVE_WORK → 固定推迟 15min，且**越过降级阈值后**仍不计入不可用（R14 · Major-1）', async () => {
    const f = schedFixture({ results: [gateBad('ACTIVE_WORK')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    // 第一轮：必须是 15min 的固定推迟，而不是退避阶梯的第一档（30s）。
    expect(f.timers.map((t) => t.ms), '首轮只应排一个 15min 窗口').toEqual([15 * 60_000]);
    // ⚠ 只跑几轮拦不住 R14 指出的那一格：窗仍排 15min、但 `unavailableStreak += 1` 的实现
    // 在前几轮里逐轮断言全绿，直到阈值后才**静默停止自动排期**。所以必须跑到阈值之后再续两轮，
    // 并显式断言"降级为仅手动"的那条告警从未发生（那才是误计入不可用的可观察后果）。
    const rounds = 9;
    for (let i = 0; i < rounds; i++) {
      const fired = f.fireNext();
      expect(fired, `第 ${i + 2} 轮排到的窗口`).toBe(15 * 60_000);
      await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    }
    expect(f.timers.every((t) => t.ms === 15 * 60_000), JSON.stringify(f.timers)).toBe(true);
    // 每一轮 fire 都真的调了一次检查（15min 心跳不是"不检查"，是"检查了但被闸门推迟"）；
    // 计数恰好等于 fire 的次数：首个窗口是启动时排的，还没有调用过检查。
    expect(f.calls.length).toBe(rounds);
    // 关键一条：越过阈值仍在排 15min ⇒ 绝不能出现"降级为仅手动"的告警，也不能停止排期。
    const warned = f.logger.warn.mock.calls as Array<[string]>;
    expect(warned.filter((w) => /manual-only|不可用/.test(String(w[0]))), JSON.stringify(warned)).toHaveLength(0);
  });

  it('闸门抑制（TOO_SOON）→ 15min 心跳，不计入不可用', async () => {
    const f = schedFixture({ results: [gateBad('TOO_SOON')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    expect(f.timers.every((x) => x.ms === 15 * 60_000)).toBe(true);
  });

  it('可自愈的本地 IO 故障不计入不可用：连喂到阈值之后仍排 15min 心跳（I-84 / R20 · Major）', async () => {
    const f = schedFixture({ results: [gateBad('STATE_WRITE_FAILED')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    const rounds = 9;
    for (let i = 0; i < rounds; i += 1) {
      const fired = f.fireNext();
      expect(fired, `第 ${i + 1} 轮`).toBe(15 * 60_000);
      await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    }
    expect(f.timers.every((t) => t.ms === 15 * 60_000), JSON.stringify(f.timers)).toBe(true);
    const warned = f.logger.warn.mock.calls as Array<[string]>;
    expect(warned.filter((w) => /manual-only|不可用/.test(String(w[0]))), JSON.stringify(warned)).toHaveLength(0);
    // 对照：by-design 拒绝（STATE_TAMPERED）**仍计入**不可用 ⇒ 证明只排除了可自愈的那一类，
    // 没有把「拒绝」与「不可用」两个语义混起来（R18 · Minor-3 的登记维持不改）。
    const g = schedFixture({ results: [gateBad('STATE_TAMPERED')] });
    await vi.waitFor(() => expect(g.timers.length).toBeGreaterThan(0));
    // 夹具未配 baseUrl ⇒ 首个定时器是启动时的 15min 闸门心跳，不是 outcome 的结果；
    // 必须先触发它，再看 afterOutcome 排出的下一档（同文件「阶梯退避」用例的取法）。
    expect(g.fireNext()).toBe(15 * 60_000);
    await vi.waitFor(() => expect(g.timers.length).toBeGreaterThan(0));
    expect(g.timers[0]!.ms, 'STATE_TAMPERED 仍计入不可用 ⇒ 第一档 30s').toBe(30_000);
  });

  it('真实失败按阶梯退避（30s→5min→30min→2h→12h→24h）', async () => {
    const f = schedFixture({ results: [gateBad('NETWORK')] });
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
      const t = f.timers.shift()!;
      t.fn();                      // 只触发一次检查，退避档位由连续失败数决定
      await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
      seen.push(f.timers[0]!.ms);
    }
    expect(seen).toEqual([30_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
  });

  it('m6：累计不可用满 7 天 ⇒ 停止自动排期并只告警一次（不是「7 轮」）', async () => {
    expect(UNAVAILABLE_DOWNGRADE_MS).toBe(7 * 24 * 3_600_000);   // 决策：7 天，不是 7 轮
    const f = schedFixture({ results: [gateBad('NETWORK')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    let fired = 0;
    // 按排期窗口推进时钟：30s→5m→30m→2h→12h→24h… 累计到 7 天即应降级。
    for (let i = 0; i < 40; i += 1) {
      const t = f.timers.shift();
      if (!t) break;                    // 排期已停：正是「降级为仅手动」的终态
      fired += 1;
      f.advance(t.ms);                  // 让「累计不可用时长」真的增长
      t.fn();
      await vi.waitFor(() => expect(
        f.timers.length > 0 || f.logger.warn.mock.calls.length > 0,
      ).toBe(true));
    }
    expect(f.timers).toHaveLength(0);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(String((f.logger.warn.mock.calls[0] as [string])[0])).toContain('7 days');
    // 6 轮只有约 1.6–2.7 天 ⇒ 若仍按轮次降级会提前停；必须真的跑过 7 天。
    expect(fired).toBeGreaterThan(7);
    const before = f.calls.length;
    await Promise.resolve();
    expect(f.calls.length).toBe(before); // 再无自动检查
    // m6 配套：降级后 tickNow() 也不得再进入（否则同进程会重复告警、且"仅手动"没兑现）
    const warnsBefore = f.logger.warn.mock.calls.length;
    f.handle.tickNow();
    await Promise.resolve();
    expect(f.calls.length).toBe(before);
    expect(f.logger.warn.mock.calls.length).toBe(warnsBefore);
  });

  it('m6：累计不可用未满 7 天不降级；一次成功会清零计时', async () => {
    const f = schedFixture({ results: [gateBad('NETWORK'), gateBad('NETWORK'), ok, gateBad('NETWORK')] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    const fire = async (): Promise<void> => {
      const t = f.timers.shift()!;
      f.advance(t.ms);
      t.fn();
      await vi.waitFor(() => expect(f.timers.length > 0 || f.logger.warn.mock.calls.length > 0).toBe(true));
    };
    await fire();                                   // 失败 1 → 30s
    await fire();                                   // 失败 2 → 5min
    await fire();                                   // 成功 ⇒ 计时清零
    await fire();                                   // 失败 1 → 30s（重新计时）
    expect(f.logger.warn).not.toHaveBeenCalled();
    expect(f.timers[0]!.ms).toBe(30_000);
  });

  it('m4：启动首检排在闸门最迟放行时刻（delay + 9s）之后，且加性正散布确实存在', async () => {
    const settings = {
      baseUrl: 'http://127.0.0.1:8080/u/',
      startupDelaySeconds: 90,
      checkOnStartup: true,
      checkIntervalHours: 24,
    };
    // 单看一个 seed 只能断区间；把 positiveSpreadMs 删掉后 ms 恒为 100_000，仍在区间内 ⇒ 抓不到。
    // 多个 seed 一起看：全部 ≥ 闸门上界，且**至少一个严格大于** 100_000（散布存在）。
    const values: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const f = schedFixture({ results: [ok], settings, jitterSeed: `spread-${i}` });
      await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
      values.push(f.timers[0]!.ms);
      f.handle.stop();
    }
    // 闸门真实窗口 = delay + [-9,+9]s（加性）⇒ 最迟 (90+9)s。排期必须 ≥ 它 + 1s 余量。
    expect(Math.min(...values)).toBeGreaterThanOrEqual(100_000);
    // 上界 = 90 + 9（闸门抖动上界）+ 1s 余量 + 9s 正散布 = 109s。
    expect(Math.max(...values)).toBeLessThanOrEqual(109_000);
    expect(values.some((ms) => ms > 100_000), `所有 seed 都无散布：${JSON.stringify(values)}`).toBe(true);
    expect(new Set(values).size, `不同 seed 应得到不同排期：${JSON.stringify(values)}`).toBeGreaterThan(1);
  });

  it('checkIntervalHours=0（仅手动）：不再自动排期', async () => {
    const timers: Array<{ ms: number; fn: () => void }> = [];
    let checked = 0;
    startUpdateScheduling({
      service: {
        async checkForUpdate() { checked += 1; return gateBad('MANUAL_ONLY'); },
      },
      settings: async () => ({ update: { startupDelaySeconds: 0, checkIntervalHours: 0 } }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => 1,
      jitterSeed: 'unit-test-seed',
      setTimer: (ms, fn) => { const t = { ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as { ms: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    timers.shift()!.fn();                 // 首轮检查被闸门判为仅手动
    await vi.waitFor(() => expect(checked).toBe(1));
    await Promise.resolve();
    expect(timers).toHaveLength(0);       // 不再排任何后续自动检查
  });

  it('powerMonitor resume / unlock-screen 走带 trigger 的补检（非 force）', async () => {
    const handlers = new Map<string, () => void>();
    const powerMonitor = {
      on: (name: 'resume' | 'unlock-screen', cb: () => void) => { handlers.set(name, cb); },
      removeListener: (name: 'resume' | 'unlock-screen') => { handlers.delete(name); },
    };
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const calls: Array<{ force?: boolean; trigger?: string | null }> = [];
    const handle = startUpdateScheduling({
      service: {
        async checkForUpdate(force?: boolean, trigger?: 'network' | 'system' | null) {
          calls.push({ force, trigger });
          return ok;
        },
      },
      settings: async () => ({ update: { startupDelaySeconds: 0 } }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => 1,
      powerMonitor,
      setTimer: (ms, fn) => { const t = { ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as { ms: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    await vi.waitFor(() => expect(handlers.size).toBe(2));
    handlers.get('resume')!();
    handlers.get('unlock-screen')!();
    await vi.waitFor(() => expect(calls.some((c) => c.trigger === 'system')).toBe(true));
    expect(calls.every((c) => c.force === false)).toBe(true); // 补检绝不绕过闸门

    const resumeCb = handlers.get('resume')!;
    handle.stop();
    expect(handlers.size).toBe(0);
    const before = calls.length;
    resumeCb(); // 已解绑的引用再调也被 stopped 拦住
    await Promise.resolve();
    expect(calls.length).toBe(before);
  });

  it('网络 offline→online 边沿触发一次补检，稳态在线不再重复', async () => {
    const net = { online: false };
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const triggers: Array<string | null | undefined> = [];
    const handle = startUpdateScheduling({
      service: {
        async checkForUpdate(_force?: boolean, trigger?: 'network' | 'system' | null) {
          triggers.push(trigger);
          return ok;
        },
      },
      settings: async () => ({ update: { startupDelaySeconds: 0 } }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => 1,
      net,
      setTimer: (ms, fn) => { const t = { ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as { ms: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    net.online = true;
    // 依次触发：启动延迟 tick 与网络轮询各自排期，轮询回调必须捕捉到边沿
    for (let i = 0; i < 6 && !triggers.includes('network'); i += 1) {
      const t = timers.shift();
      if (!t) break;
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(triggers).toContain('network');
    handle.stop();
  });

  it('触发源叠加不并发跑两次检查（统一闸门要求单一执行窗口）', async () => {
    const timers: Array<{ ms: number; fn: () => void }> = [];
    let calls = 0;
    let release: (() => void) | null = null;
    const handle = startUpdateScheduling({
      service: {
        async checkForUpdate() {
          calls += 1;
          return new Promise((resolve) => {
            release = () => resolve({ ok: true } as UpdateActionResult);
          });
        },
      },
      settings: async () => ({ update: { startupDelaySeconds: 0, baseUrl: 'http://127.0.0.1:8080/u/' } }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => 1,
      jitterSeed: 'unit-test-seed',
      setTimer: (ms, fn) => { const t = { ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as { ms: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    const t = timers.shift()!;
    t.fn();                       // 第一次检查挂起未返回
    t.fn();                       // 立即重复触发
    handle.tickNow('network');    // 网络恢复补检也撞进来
    handle.tickNow('system');     // 系统恢复补检
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
    release!();
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    handle.stop();
  });

  it('stop() 后不再触发任何检查', async () => {
    const f = schedFixture({ results: [ok] });
    await vi.waitFor(() => expect(f.timers.length).toBeGreaterThan(0));
    f.handle.stop();
    const callsBefore = f.calls.length;
    f.fireNext();
    await Promise.resolve();
    expect(f.calls.length).toBe(callsBefore);
  });

  it('checkForUpdate 抛异常也按不可用处理，不留死循环', async () => {
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let thrown = 0;
    startUpdateScheduling({
      service: {
        async checkForUpdate() { thrown += 1; throw new Error('boom'); },
      },
      settings: async () => ({ update: { startupDelaySeconds: 0 } }) as never,
      logger,
      now: () => 1,
      setTimer: (ms, fn) => { const t = { ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as { ms: number; fn: () => void }); if (i >= 0) timers.splice(i, 1); },
    });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    const t = timers.shift()!;
    t.fn();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(thrown).toBe(1);
    // 异常按不可用处理：排到了退避的第一档（30s），并继续下一次检查
    const next = timers.shift();
    expect(next?.ms).toBe(30_000);
    next?.fn();
    await vi.waitFor(() => expect(thrown).toBe(2));
  });
});

describe('keyring 名必须是合法 Windows 文件名（§1.4 第 10 条：ADS 陷阱）', () => {
  it('两个更新密钥名都不含冒号，也没有其它保留字符', () => {
    for (const name of [UPDATE_HMAC_KEY_NAME, SEQ_MIRROR_KEY_NAME]) {
      expect(name).not.toContain(':');
      expect(name).not.toMatch(/[<>:"/\|?*]/);
      expect(name.endsWith('.')).toBe(false);
      expect(name.length).toBeLessThan(64);
    }
  });

  it('按 Keyring.file() 的形状拼出的路径，Windows 上会落成独立文件而不是某个基名的数据流', async () => {
    // Keyring.file(name) = join(dir, `${name}.enc`)。若 name 含冒号，写盘会创建
    // 「基名文件 + ADS」，readdir 只见基名 ⇒ 快照 / 备份 / 逐文件哈希都会漏掉它。
    const dir = mkdtempSync(join(tmpdir(), 'sparkii-keyring-name-'));
    try {
      for (const name of [UPDATE_HMAC_KEY_NAME, SEQ_MIRROR_KEY_NAME]) {
        writeFileSync(join(dir, `${name}.enc`), 'cipher', 'utf8');
      }
      expect(readdirSync(dir).sort()).toEqual([
        `${SEQ_MIRROR_KEY_NAME}.enc`, `${UPDATE_HMAC_KEY_NAME}.enc`,
      ].sort());
      expect(existsSync(join(dir, 'update'))).toBe(false);   // 不得退化成 ADS 基名
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
