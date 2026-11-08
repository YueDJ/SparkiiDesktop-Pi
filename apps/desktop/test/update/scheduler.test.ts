// G3 · scheduler 单测：24h 周期 + 抖动 + 退避 + autoCheck=false / baseUrl 空 / defer / skip。

import { describe, expect, it } from 'vitest';

import { backoffMs, jitterDelay, shouldCheck, type ShouldCheckOptions } from '../../electron/main/update/scheduler.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function opts(over: Partial<ShouldCheckOptions> = {}): ShouldCheckOptions {
  return {
    autoCheck: true,
    baseUrl: 'http://127.0.0.1:8080/',
    now: NOW,
    lastCheckedAt: null,
    lastSuccessAt: NOW - 25 * HOUR, // 25h 前，已过 24h 周期
    failureCount: 0,
    deferredUntil: null,
    startupAt: NOW - 1000 * HOUR,
    startupDelaySeconds: 90,
    checkIntervalHours: 24,
    jitterSeconds: 0,
    ...over,
  };
}

describe('backoffMs', () => {
  it('指数退避阶梯，且钳制上限', () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(300_000);
    expect(backoffMs(3)).toBe(1_800_000);
    expect(backoffMs(4)).toBe(7_200_000);
    expect(backoffMs(5)).toBe(86_400_000);
    expect(backoffMs(99)).toBe(86_400_000);
  });
});

describe('jitterDelay', () => {
  it('范围 0.85..1.15 倍，且同机同日稳定、永不出网', () => {
    const d = jitterDelay('install-id-A', 1000);
    expect(d).toBeGreaterThanOrEqual(850);
    expect(d).toBeLessThanOrEqual(1150);
    expect(jitterDelay('install-id-A', 1000)).toBe(d); // 确定性
    const other = jitterDelay('install-id-B', 1000);
    expect(other).toBeGreaterThanOrEqual(850);
    expect(other).toBeLessThanOrEqual(1150);
    // 不同 installId 通常不同（本地派生，跨机分散）
    expect(typeof other).toBe('number');
  });
});

describe('shouldCheck 统一闸门', () => {
  it('满足全部条件 → OK', () => {
    expect(shouldCheck(opts())).toEqual({ ok: true, reason: 'OK' });
  });

  it('24h 周期未到 → TOO_SOON（抖动窗口内）', () => {
    const r = shouldCheck(opts({ lastSuccessAt: NOW - 23 * HOUR, jitterSeconds: 0 }));
    expect(r).toEqual({ ok: false, reason: 'TOO_SOON' });
  });

  it('24h 周期已过（含抖动下界）→ OK', () => {
    const r = shouldCheck(opts({ lastSuccessAt: NOW - 25 * HOUR, jitterSeconds: 3600 }));
    expect(r).toEqual({ ok: true, reason: 'OK' });
  });

  it('autoCheck=false → DISABLED', () => {
    expect(shouldCheck(opts({ autoCheck: false }))).toEqual({ ok: false, reason: 'DISABLED' });
  });

  it('baseUrl 为空 → NO_BASE_URL', () => {
    expect(shouldCheck(opts({ baseUrl: '' }))).toEqual({ ok: false, reason: 'NO_BASE_URL' });
  });

  it('defer 未到 → DEFERRED', () => {
    expect(shouldCheck(opts({ deferredUntil: NOW + 1000 }))).toEqual({ ok: false, reason: 'DEFERRED' });
  });

  it('skip（checkIntervalHours=0 仅手动）→ MANUAL_ONLY', () => {
    // skip 版本由 decision 处理；这里 0 周期 = 仅手动，等价于「跳过自动检查」闸门。
    expect(shouldCheck(opts({ checkIntervalHours: 0 }))).toEqual({ ok: false, reason: 'MANUAL_ONLY' });
  });

  it('失败退避期内 → BACKOFF', () => {
    const r = shouldCheck(opts({ failureCount: 3, lastCheckedAt: NOW - 1000 }));
    expect(r).toEqual({ ok: false, reason: 'BACKOFF' });
  });

  it('退避期已过 → OK', () => {
    const r = shouldCheck(opts({ failureCount: 2, lastCheckedAt: NOW - 400_000 }));
    expect(r).toEqual({ ok: true, reason: 'OK' });
  });

  it('开机延迟内（首次检查）→ STARTUP_DELAY', () => {
    const r = shouldCheck(opts({ lastCheckedAt: null, startupAt: NOW - 1000, startupDelaySeconds: 90, jitterSeconds: 0 }));
    expect(r).toEqual({ ok: false, reason: 'STARTUP_DELAY' });
  });

  it('force 绕过调度闸门（但不绕过验签，由服务层保证）', () => {
    expect(shouldCheck(opts({ force: true, autoCheck: false, baseUrl: '' }))).toEqual({ ok: true, reason: 'FORCE' });
  });

  it('网络/系统恢复触发且距上次 >1h → RESUME', () => {
    const r = shouldCheck(opts({ resumeTrigger: 'network', lastCheckedAt: NOW - 2 * HOUR, lastSuccessAt: NOW - 2 * HOUR }));
    expect(r).toEqual({ ok: true, reason: 'RESUME' });
  });

  it('恢复触发但距上次 <1h → 不额外补检', () => {
    const r = shouldCheck(opts({ resumeTrigger: 'system', lastCheckedAt: NOW - 1000, lastSuccessAt: NOW - 25 * HOUR }));
    expect(r).toEqual({ ok: true, reason: 'OK' }); // 走正常周期
  });
});
