// 二选一、跳过/稍后、minSupportedVersion 硬闸门（契约 §5 / 设计 §7.6）。

import type { LocalUpdateInfo, ReleaseJson, RemoteUpdateInfo } from './types.js';

/**
 * 版本优先级的**唯一权威判据**（不引入新依赖）。返回 -1 / 0 / 1。
 * 三段数字为核心；忽略前导 'v'、缺失段补 0；`+build` 元数据不参与优先级；
 * 三段相同时按 semver 的预发布规则比（无预发布 > 有预发布，标识符逐个比，
 * 数字标识符按数值且优先级低于非数字标识符）。
 *
 * R22 · Maj-3：原先只比三段数字，`0.3.0-beta.1` 与 `0.3.0` 判等 ⇒ 运行 beta 时
 * 正式版被 `pickBestLocal` 当成「同版本」过滤掉，升不上去；而 `0.3.0+build.2` 与
 * `0.3.0` 判等又是**对的**（build metadata 不改变优先级）。补上预发布语义后，
 * 「版本是否相同」与「版本谁更高」是同一个判据，不再另造平行函数。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string[] } => {
    const s = String(v ?? '').replace(/^v/i, '');
    const plus = s.indexOf('+');
    const withoutBuild = plus >= 0 ? s.slice(0, plus) : s;
    const dash = withoutBuild.indexOf('-');
    const main = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
    const preRaw = dash >= 0 ? withoutBuild.slice(dash + 1) : '';
    const nums = main.split('.').slice(0, 3).map((seg) => {
      const m = /^(\d+)/.exec(seg);
      return m ? Number(m[1]) : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: preRaw ? preRaw.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const l = x.nums[i] ?? 0;
    const r = y.nums[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;   // 含 `+build` 差异也判等
  if (x.pre.length === 0) return 1;                          // 正式版 > 预发布
  if (y.pre.length === 0) return -1;
  const len = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < len; i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) > Number(q) ? 1 : -1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** minSupportedVersion 硬闸门：当前版本低于下限直接拒绝，绝不调用 updater 下载。 */
export function assertMinSupportedVersion(
  current: string,
  release: ReleaseJson,
): { ok: true } | { ok: false; reason: string } {
  if (compareVersions(current, release.minSupportedVersion) < 0) {
    return { ok: false, reason: 'MIN_SUPPORTED' };
  }
  return { ok: true };
}

export interface DecideOptions {
  currentVersion: string;
  /** 已验签的远端版本（来自 verifier）。 */
  remoteVerified: RemoteUpdateInfo | null;
  /** 本地 pending 中已通过伴生清单校验的可安装版本（来自 local-artifacts）。 */
  localValid: LocalUpdateInfo | null;
  skippedVersions: string[];
  deferredUntil: number | null;
  now: number;
}

export interface DecideOutcome {
  choiceRequired: boolean;
  remote: RemoteUpdateInfo | null;
  local: LocalUpdateInfo | null;
  /** 远端被拦截的原因：'MIN_SUPPORTED' | 'DEFERRED' | 'SKIPPED' | null。 */
  blockedReason: string | null;
  /** allowDowngrade 远端需要用户逐次二次确认。 */
  requiresDowngradeConfirm: boolean;
}

export type ChooseResult =
  | { ok: true; source: 'local'; version: string; action: 'install' }
  | { ok: true; source: 'remote'; version: string; action: 'download' }
  | { ok: false; reason: string };

/**
 * 合并「远端已验签版本」与「本地 pending 可安装版本」。
 * - choiceRequired：两者版本不同且都有效。
 * - 跳过 / 稍后：过滤对应版本 / 该次远端。
 * - minSupportedVersion 硬闸门：当前版本低于远端下限时远端被硬拦截，绝不进入下载。
 * - 远端版本 == 当前版本：不是更新（也不是 blocked），直接过滤。
 * - allowDowngrade 仅打二次确认标记，不在此处放行。
 */
export function decide(opts: DecideOptions): DecideOutcome {
  const skipped = new Set(opts.skippedVersions ?? []);
  let blockedReason: string | null = null;
  let remote = opts.remoteVerified;
  let local = opts.localValid;

  if (local && skipped.has(local.version)) local = null;

  if (remote) {
    if (skipped.has(remote.version)) {
      remote = null;
      blockedReason = 'SKIPPED';
    } else if (opts.deferredUntil != null && opts.now < opts.deferredUntil) {
      remote = null;
      blockedReason = 'DEFERRED';
    } else if (compareVersions(opts.currentVersion, remote.minSupportedVersion) < 0) {
      remote = null;
      blockedReason = 'MIN_SUPPORTED';
    } else if (compareVersions(remote.version, opts.currentVersion) === 0) {
      // 同版本清单在验签层是合法的（用于推进 sequence），但「版本相同」不是新版本：
      // 不过滤就会让调用方把 available 重新报给 UI。blockedReason 保持 null，不新增联合类型。
      remote = null;
    }
  }

  const requiresDowngradeConfirm =
    remote != null && remote.allowDowngrade === true &&
    compareVersions(remote.version, opts.currentVersion) < 0;

  // R22 · Maj-3：与版本高低用同一个判据，不再拿字符串相等另判「是否同一个版本」。
  const choiceRequired = remote != null && local != null &&
    compareVersions(remote.version, local.version) !== 0;

  return { choiceRequired, remote, local, blockedReason, requiresDowngradeConfirm };
}

/**
 * 二选一时把「用户选中的版本」解析为唯一一个动作源，绝不返回两个。
 * 未命中 / 被拦截 / 歧义一律 fail closed 返回 ok:false。
 */
export function chooseVersion(outcome: DecideOutcome, version: string): ChooseResult {
  if (outcome.local && outcome.local.version === version) {
    return { ok: true, source: 'local', version, action: 'install' };
  }
  if (outcome.remote && outcome.remote.version === version) {
    return { ok: true, source: 'remote', version, action: 'download' };
  }
  return { ok: false, reason: 'CHOICE_REQUIRED' };
}
