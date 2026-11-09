// settings.update 解析、归一化、默认值与校验（契约 §5）。
// 注意：本文件本地定义 AppSettingsLike，绝不 import settings.ts（归 G4，避免循环依赖）。

import type { PublicKeyMap, UpdateSettingsPublic } from './types.js';

/** 本地结构类型：只描述 AppSettings.update 子树，不与 settings.ts 耦合。 */
export interface AppSettingsLike {
  update?: {
    baseUrl?: string;
    autoCheck?: boolean;
    checkIntervalHours?: number;
    checkOnStartup?: boolean;
    startupDelaySeconds?: number;
    checkOnNetworkResume?: boolean;
    checkOnSystemResume?: boolean;
    remindIntervalHours?: number;
    requestTimeoutMs?: number;
    autoDownload?: false;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * 构建期由 `build:main` 的 esbuild define 注入 `SPARKII_UPDATE_URL`。
 * 未注入（单测 / 未配置）时为空串 = 关闭自动检查，设置页可手填。
 * typeof 守卫避免未注入时 ReferenceError。
 */
export const DEFAULT_UPDATE_URL: string =
  typeof __SPARKII_UPDATE_URL__ !== 'undefined' ? (__SPARKII_UPDATE_URL__ as string) : '';

export type NormalizeResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * baseUrl 归一化：只接受 http / https；无 query/hash/用户名密码；路径以 / 结尾。
 * 任何其它 scheme、凭据、query、hash 一律拒绝（fail closed）。
 */
export function normalizeBaseUrl(raw: string): NormalizeResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'INVALID_BASE_URL' };
  if (!/^https?:\/\//i.test(trimmed)) return { ok: false, reason: 'INVALID_BASE_URL' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'INVALID_BASE_URL' };
  }
  if (u.username || u.password) return { ok: false, reason: 'INVALID_BASE_URL' };
  if (u.search || u.hash) return { ok: false, reason: 'INVALID_BASE_URL' };
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return { ok: true, url: u.href };
}

export function isHttpUrl(url: string): boolean {
  return /^http:\/\//i.test(url);
}

/** 解析后的完整设置（含派生 isHttp 与写死的 autoDownload）。 */
export interface ResolvedUpdateSettings extends UpdateSettingsPublic {
  /** 原始（未归一化）baseUrl，留空表示关闭自动检查。 */
  baseUrlRaw: string;
}

const positiveInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

/**
 * 解析 AppSettingsLike.update，给出 §7.4 全部默认值。
 * - autoDownload 恒写死 false（硬约束，不接受配置覆盖）。
 * - baseUrl 缺省用 DEFAULT_UPDATE_URL；留空 = 关闭自动检查。
 * - 非空但非法的 baseUrl 归一化为 ''（关闭自动检查）并标记，绝不退化放行到非法 scheme。
 */
export function resolveUpdateSettings(s: AppSettingsLike): ResolvedUpdateSettings {
  const u = s?.update ?? {};
  const raw = typeof u.baseUrl === 'string' ? u.baseUrl.trim() : DEFAULT_UPDATE_URL;
  let baseUrl = '';
  if (raw) {
    const n = normalizeBaseUrl(raw);
    if (n.ok) baseUrl = n.url;
  }
  const autoDownload = false as const; // 恒 false，写死
  return {
    baseUrl,
    baseUrlRaw: raw,
    autoCheck: bool(u.autoCheck, true),
    checkIntervalHours: positiveInt(u.checkIntervalHours, 24),
    checkOnStartup: bool(u.checkOnStartup, true),
    startupDelaySeconds: positiveInt(u.startupDelaySeconds, 90),
    checkOnNetworkResume: bool(u.checkOnNetworkResume, true),
    checkOnSystemResume: bool(u.checkOnSystemResume, true),
    remindIntervalHours: positiveInt(u.remindIntervalHours, 24),
    requestTimeoutMs: positiveInt(u.requestTimeoutMs, 8000) || 8000,
    autoDownload,
    isHttp: isHttpUrl(baseUrl),
  };
}

/**
 * 发布公钥（编译期常量对象，§5.4 / §6.3 / §8.3）。
 *
 * 两个来源，二者都空即 fail closed：
 *  1. 构建期 define：`build:main` 把 `SPARKII_RELEASE_KEYS_FILE` 指向的公钥清单原文内联为
 *     `__SPARKII_RELEASE_PUBLIC_KEYS__`（私钥永不进仓库，也不进构建机环境变量之外的地方）。
 *  2. `registerPublicKeys()`：单测 / 内部工具运行时注入。
 *
 * 空对象时 verifySignatureEnvelope 一律失败（拒绝一切更新），绝不允许「无公钥 ⇒ 放行未签名」。
 */
const KID_RE = /^[A-Za-z0-9._-]+$/;

export const RELEASE_PUBLIC_KEYS: PublicKeyMap = parseReleasePublicKeys(
  typeof __SPARKII_RELEASE_PUBLIC_KEYS__ !== 'undefined' ? __SPARKII_RELEASE_PUBLIC_KEYS__ : '',
);

/**
 * 解析注入的公钥清单文本。接受三种形态（G1 的 release-keys.mjs 产出第 1 种）：
 *   { kid, notBefore, notAfter, publicKeyPem }            // 单条
 *   { <kid>: { pem | publicKeyPem, notBefore, notAfter } } // 映射
 *   [ { kid, ... }, … ]                                    // 数组
 * 任一条目非法（kid 形态 / 空 PEM / 日期不可解析）即整批丢弃并返回空表（fail closed）。
 */
export function parseReleasePublicKeys(text: string): PublicKeyMap {
  const raw = (text ?? '').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (typeof (parsed as { kid?: unknown }).kid === 'string'
        ? [parsed]                                  // 单条形态
        : Object.entries(parsed as Record<string, unknown>).map(([kid, v]) => ({ kid, ...(v as object) })))
      : [];
  const out: PublicKeyMap = {};
  for (const item of entries) {
    const e = item as {
      kid?: unknown; pem?: unknown; publicKeyPem?: unknown; notBefore?: unknown; notAfter?: unknown;
    };
    const kid = typeof e.kid === 'string' ? e.kid : '';
    const pem = typeof e.pem === 'string' ? e.pem : typeof e.publicKeyPem === 'string' ? e.publicKeyPem : '';
    const notBefore = typeof e.notBefore === 'string' ? e.notBefore : '';
    const notAfter = typeof e.notAfter === 'string' ? e.notAfter : '';
    if (!KID_RE.test(kid) || !pem.trim() || Number.isNaN(Date.parse(notBefore)) ||
        Number.isNaN(Date.parse(notAfter))) {
      return {}; // 一批里任一条目不可信 ⇒ 全批丢弃，避免「半套公钥表」放行
    }
    out[kid] = { pem, notBefore, notAfter };
  }
  return out;
}

/** 供测试 / 主 Agent 注入公钥（合并，不覆盖已有键之外的语义）。 */
export function registerPublicKeys(keys: PublicKeyMap): void {
  for (const kid of Object.keys(keys)) {
    RELEASE_PUBLIC_KEYS[kid] = keys[kid];
  }
}
