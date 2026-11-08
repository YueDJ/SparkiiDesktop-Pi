// 更新审计写入（契约 §5 / 设计 §7.9）。
// 本模块自包含，避免与 service.ts 形成运行时循环依赖。

import type { AuditLike, LoggerLike } from './types.js';

/** 设计 §7.9 / 契约 §1.10 的审计事件名（去重）。 */
export const UPDATE_EVENTS: readonly string[] = [
  'update.available',
  'update.download-start',
  'update.download-complete',
  'update.verify-failed',
  'update.check-failed',
  'update.install-start',
  'update.install-cancelled',
  'update.install-abort',
  'update.completed',
  'update.failed',
  'update.rolledBack',
  'update.cleanup',
  // R16 · Major-1：设置变更（baseUrl / 重置检查标识）原先走**裸 `deps.audit.append`**，
  // 绕开了本模块的 try/catch 与限流 ⇒ 盘满 / `SQLITE_BUSY` 时 `EPERM` 原文抛穿 IPC 显示到设置面板。
  // 加进白名单后这两处统一走 `logUpdateEvent`，与其余事件同一条"写失败不阻断、但不外抛"的口径。
  'update.settings-changed',
];

// 「类型 + 天」限流状态（进程内）。key 含 reason，使不同失败原因各自留痕。
const seen = new Set<string>();
let throttleNow: () => number = () => Date.now();

function dayBucket(): string {
  return new Date(throttleNow()).toISOString().slice(0, 10);
}

/** 测试辅助：重置限流状态与可注入时钟，保证每个用例独立。 */
export function resetAuditThrottle(now: () => number = () => Date.now()): void {
  seen.clear();
  throttleNow = now;
}

/**
 * 写一条 update.* 审计。
 * - 「已是最新」不写（fields.alreadyLatest 或 action 非 update.*）。
 * - 其余按「类型 + 天 + reason」限流，防 MITM 持续喂垃圾清单刷库。
 * - update.verify-failed 同时镜像到 logger。
 */
export async function logUpdateEvent(
  audit: AuditLike | undefined,
  action: string,
  fields?: Record<string, unknown>,
  logger?: LoggerLike,
): Promise<void> {
  if (!audit) return;
  if (fields?.alreadyLatest === true) return; // 已是最新不写
  if (!UPDATE_EVENTS.includes(action)) {
    // 未知 action 不静默放行到审计库，但仍镜像安全事件到日志。
    if (action === 'update.verify-failed' && logger) {
      logger.warn(`[${action}] ${String(fields?.reason ?? '')}`);
    }
    return;
  }
  const reason = fields?.reason == null ? '' : String(fields.reason);
  // 同一个 reason 下的**不同现场**要能各自留痕（R5 · Minor-1：四种 STATE_TAMPERED 现场曾被压成一条，
  // 运维手册据此区分根因就失效了）。只接受有限的大写标识，绝不把 detail 原文放进键里——
  // 那等于给攻击者一个「每来一次就换个键」的刷库通道，限流本身就会被绕过。
  const subRaw = fields?.subreason == null ? '' : String(fields.subreason);
  const subKey = /^[A-Z][A-Z0-9_]{0,31}$/.test(subRaw) ? subRaw : '';
  const key = `${action}|${dayBucket()}|${reason}|${subKey}`;
  if (seen.has(key)) return;
  let written = false;
  try {
    await audit.append({
      actor: 'update-service',
      action,
      resource: 'auto-update',
      decision: action === 'update.verify-failed' ? 'deny' : 'info',
      payloadSummary: fields ? JSON.stringify(fields) : undefined,
    });
    written = true;
  } catch {
    // 审计写盘失败不阻断主流程（fail closed 由调用方负责，不依赖本返回值）。
    // ⚠ 但**绝不能顺手把它记成"今天这条已经留过痕"**：原先 `seen.add(key)` 排在 append 之前，
    // 于是一次瞬时失败就让这条现场当天永久静默（R13 · Major-3 实测：两次同现场只试过 1 次，
    // 库里零条、界面无感）。不记键 ⇒ 同类事件下次仍会重试；代价只是持续失败时每个事件多试一次，
    // 并不会写脏库（键的含义是"已成功留痕"，不是"已经试过")。
    try {
      logger?.warn(`[update.audit] 审计写入失败（本次未留痕，同类事件会重试）：${action} ${reason}`);
    } catch { /* 日志失败不改变判定 */ }
  }
  if (written) seen.add(key);
  if (action === 'update.verify-failed' && logger) {
    logger.warn(`[update.verify-failed] ${reason}`);
  }
}
