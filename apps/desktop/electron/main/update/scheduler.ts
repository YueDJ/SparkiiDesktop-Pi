// 统一闸门 shouldCheck() + 抖动 + 指数退避（契约 §5 / 设计 §7.10）。

import { createHash } from 'node:crypto';

/** §7.10「活跃任务推迟 15min」的固定窗口；调度层（update-bootstrap）按它重排下一次检查。 */
export const ACTIVE_WORK_DEFER_MS = 15 * 60_000;

export interface ShouldCheckOptions {
  autoCheck: boolean;
  baseUrl: string;
  now: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  failureCount: number;
  deferredUntil: number | null;
  startupAt: number;
  startupDelaySeconds: number;
  checkIntervalHours: number;
  /** 预计算的抖动秒数（来自 jitterDelay），已叠加到开机延迟与周期窗口。 */
  jitterSeconds: number;
  /** 手动强制：绕过调度闸门（但绝不绕过验签）。 */
  force?: boolean;
  /** 网络恢复 / 系统恢复 / 解锁屏补检触发。 */
  resumeTrigger?: 'network' | 'system' | null;
  /** 有活跃任务（Agent 会话 / 待审批提案）：按 §7.10 推迟，不发网络请求。 */
  activeWork?: boolean;
  /** 离线（由调用方注入 net.online 等真实信号）。 */
  networkOffline?: boolean;
}

export type ShouldCheckResult = { ok: true; reason: string } | { ok: false; reason: string };

/** 失败退避：30s → 5min → 30min → 2h → 24h（设计 §7.10）。 */
export function backoffMs(failureCount: number): number {
  const steps = [30_000, 300_000, 1_800_000, 7_200_000, 86_400_000];
  const n = Math.max(0, Math.floor(failureCount) - 1);
  return steps[Math.min(n, steps.length - 1)];
}

/**
 * 本地抖动：由 installId + 当天 dayBucket 派生，范围 baseSeconds × [0.85, 1.15]。
 * installId 仅本地使用，永不出网；同机同日稳定、跨机分散。
 * 返回秒数（可含小数）。
 */
export function jitterDelay(installId: string, baseSeconds: number): number {
  const day = new Date().toISOString().slice(0, 10);
  const digest = createHash('sha256').update(`${installId}|${day}`).digest();
  const ratio = digest.readUInt16BE(0) / 0xffff; // 0..1
  return baseSeconds * (0.85 + ratio * 0.3);    // 0.85..1.15
}

/** 统一闸门：按序判定所有抑制条件，全部通过才允许网络检查。 */
export function shouldCheck(opts: ShouldCheckOptions): ShouldCheckResult {
  if (opts.force) return { ok: true, reason: 'FORCE' };
  if (!opts.autoCheck) return { ok: false, reason: 'DISABLED' };
  if (!opts.baseUrl) return { ok: false, reason: 'NO_BASE_URL' };
  if (opts.deferredUntil != null && opts.now < opts.deferredUntil) {
    return { ok: false, reason: 'DEFERRED' };
  }
  // 离线判定提到最前面执行（设计 §7.10 把它列在末位，但那是叙述顺序不是判定顺序）：
  // 后面的 RESUME 分支是「提前放行」通道，若排在离线之后，resume / 网络边沿触发会在
  // net.online === false 时照样发出请求 ⇒ 直接违反「网络离线不发请求」。
  if (opts.networkOffline) return { ok: false, reason: 'NETWORK_OFFLINE' };
  // §7.10：有活跃任务时推迟（调度层按 ACTIVE_WORK_DEFER_MS 重排），绝不打断正在跑的工作。
  if (opts.activeWork) return { ok: false, reason: 'ACTIVE_WORK' };
  if (opts.failureCount > 0 && opts.lastCheckedAt != null &&
      opts.now < opts.lastCheckedAt + backoffMs(opts.failureCount)) {
    return { ok: false, reason: 'BACKOFF' };
  }
  const startupMs = (opts.startupDelaySeconds + opts.jitterSeconds) * 1000;
  if (opts.lastCheckedAt == null && opts.now < opts.startupAt + startupMs) {
    return { ok: false, reason: 'STARTUP_DELAY' };
  }
  // 网络 / 系统恢复补检：距上次检查 > 1h 才允许，避免与正常周期叠加刷请求。
  if (opts.resumeTrigger && opts.lastCheckedAt != null &&
      opts.now - opts.lastCheckedAt > 3_600_000) {
    return { ok: true, reason: 'RESUME' };
  }
  if (opts.checkIntervalHours <= 0) {
    // 0 = 仅手动：无 force 时不自动检查。
    return { ok: false, reason: 'MANUAL_ONLY' };
  }
  if (opts.lastSuccessAt != null) {
    const periodMs = opts.checkIntervalHours * 3_600_000;
    const jitterMs = opts.jitterSeconds * 1000;
    // 周期 × (1 ± 15%) 的窗口下界，抖动用同一派生值。
    const nextCheckAt = opts.lastSuccessAt + periodMs - Math.abs(jitterMs);
    if (opts.now < nextCheckAt) return { ok: false, reason: 'TOO_SOON' };
  }
  return { ok: true, reason: 'OK' };
}
