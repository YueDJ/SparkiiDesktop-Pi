// G3 · decision 单测：0.2 本地 + 0.3 远端 → choiceRequired；二选一只能选一个；
// 跳过/稍后；minSupportedVersion 硬拦截；compareVersions / assertMinSupportedVersion。

import { describe, expect, it } from 'vitest';

import {
  assertMinSupportedVersion, chooseVersion, compareVersions, decide,
} from '../../electron/main/update/decision.js';
import type { LocalUpdateInfo, ReleaseJson, RemoteUpdateInfo } from '../../electron/main/update/types.js';

const remote = (version: string, over: Partial<RemoteUpdateInfo> = {}): RemoteUpdateInfo => ({
  version, sequence: 10, nonce: 'n', publishedAt: '', expiresAt: '',
  summary: '', highlights: [], bytes: 100,
  minSupportedVersion: '0.1.0', allowDowngrade: false, ...over,
});
const local = (version: string, over: Partial<LocalUpdateInfo> = {}): LocalUpdateInfo => ({
  version, sequence: 9, nonce: 'n', artifactPath: 'C:/p/x.exe', bytes: 100,
  sha512: 'sha', expiresAt: '', valid: true, ...over,
});
const baseOpts = {
  currentVersion: '0.1.0',
  skippedVersions: [] as string[],
  deferredUntil: null,
  now: 1_700_000_000_000,
};

describe('compareVersions', () => {
  it('三段比较', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('assertMinSupportedVersion', () => {
  const release = (min: string): ReleaseJson =>
    ({ minSupportedVersion: min } as ReleaseJson);
  it('当前版本 ≥ 下限 → 放行', () => {
    expect(assertMinSupportedVersion('0.3.0', release('0.2.0'))).toEqual({ ok: true });
  });
  it('当前版本 < 下限 → MIN_SUPPORTED 硬拦截', () => {
    expect(assertMinSupportedVersion('0.1.0', release('0.2.0'))).toEqual({ ok: false, reason: 'MIN_SUPPORTED' });
  });
});

describe('decide 二选一', () => {
  it('0.2 本地 + 0.3 远端 → choiceRequired', () => {
    const r = decide({ ...baseOpts, remoteVerified: remote('0.3.0'), localValid: local('0.2.0') });
    expect(r.choiceRequired).toBe(true);
    expect(r.remote?.version).toBe('0.3.0');
    expect(r.local?.version).toBe('0.2.0');
  });

  it('二选一只能选一个：chooseVersion 精确解析到唯一动作源', () => {
    const r = decide({ ...baseOpts, remoteVerified: remote('0.3.0'), localValid: local('0.2.0') });
    expect(chooseVersion(r, '0.2.0')).toEqual({ ok: true, source: 'local', version: '0.2.0', action: 'install' });
    expect(chooseVersion(r, '0.3.0')).toEqual({ ok: true, source: 'remote', version: '0.3.0', action: 'download' });
    // 未命中 / 歧义 → fail closed
    expect(chooseVersion(r, '9.9.9')).toEqual({ ok: false, reason: 'CHOICE_REQUIRED' });
    // 选一个不会同时返回两个源
    const one = chooseVersion(r, '0.2.0');
    expect(one.ok && one.source).toBe('local');
  });

  it('仅本地 → 不二选一，直接可安装', () => {
    const r = decide({ ...baseOpts, remoteVerified: null, localValid: local('0.2.0') });
    expect(r.choiceRequired).toBe(false);
    expect(r.local?.version).toBe('0.2.0');
  });

  it('仅远端 → 不二选一', () => {
    const r = decide({ ...baseOpts, remoteVerified: remote('0.3.0'), localValid: null });
    expect(r.choiceRequired).toBe(false);
    expect(r.remote?.version).toBe('0.3.0');
  });

  it('同版本（本地=远端）→ 不二选一', () => {
    const r = decide({ ...baseOpts, remoteVerified: remote('0.3.0'), localValid: local('0.3.0') });
    expect(r.choiceRequired).toBe(false);
  });
});

describe('decide 跳过 / 稍后 / 硬拦截', () => {
  it('skip 远端版本 → 该远端被过滤', () => {
    const r = decide({ ...baseOpts, skippedVersions: ['0.3.0'], remoteVerified: remote('0.3.0'), localValid: null });
    expect(r.remote).toBeNull();
    expect(r.blockedReason).toBe('SKIPPED');
  });

  it('skip 本地版本 → 该本地被过滤', () => {
    const r = decide({ ...baseOpts, skippedVersions: ['0.2.0'], remoteVerified: remote('0.3.0'), localValid: local('0.2.0') });
    expect(r.local).toBeNull();
    expect(r.choiceRequired).toBe(false);
  });

  it('稍后（deferredUntil 未到）→ 远端被抑制', () => {
    const r = decide({ ...baseOpts, deferredUntil: baseOpts.now + 1000, remoteVerified: remote('0.3.0'), localValid: null });
    expect(r.remote).toBeNull();
    expect(r.blockedReason).toBe('DEFERRED');
  });

  it('稍后到期 → 恢复远端', () => {
    const r = decide({ ...baseOpts, deferredUntil: baseOpts.now - 1, remoteVerified: remote('0.3.0'), localValid: null });
    expect(r.remote?.version).toBe('0.3.0');
  });

  it('minSupportedVersion 硬闸门：当前版本低于下限 → 远端被拦截，绝不进入下载', () => {
    const r = decide({ ...baseOpts, remoteVerified: remote('0.3.0', { minSupportedVersion: '0.5.0' }), localValid: null });
    expect(r.remote).toBeNull();
    expect(r.blockedReason).toBe('MIN_SUPPORTED');
  });

  it('allowDowngrade 仅打二次确认标记，不自动放行', () => {
    const r = decide({
      ...baseOpts, currentVersion: '0.5.0',
      remoteVerified: remote('0.3.0', { allowDowngrade: true }), localValid: null,
    });
    expect(r.requiresDowngradeConfirm).toBe(true);
    expect(r.remote?.version).toBe('0.3.0'); // 由调用方逐次二次确认，decide 不静默放行
  });
});
