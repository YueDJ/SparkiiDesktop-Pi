import type { SessionEntry } from './contract.js';
import { applySurfaceEvent, normalizeSessionEntries } from './normalize.js';

export interface SessionSnapshot {
  /** 已提交条目：进程活着时是 `getBranch()`，已释放时是 JSONL 正文。 */
  entries?: unknown[];
  /** 未入树的那句 assistant 全文；进程已释放时为 null。 */
  streamingMessage?: unknown | null;
  /** 来自 `get_state.isStreaming`；转圈只看这个字段。 */
  streaming?: boolean;
}

/**
 * 一次铺底：快照先落地，未入树的那句折成流式槽，然后按顺序回放订阅期间缓冲的事件。
 *
 * 顺序不能反。先把事件画上再等快照，会让晚到的快照整表覆盖已画内容；晚到快照按 id 并集补洞
 * 又会把压缩掉的旧枝补回来。
 */
export function applySnapshotThenBuffer(
  snapshot: SessionSnapshot,
  buffer: readonly unknown[],
  apply: typeof applySurfaceEvent = applySurfaceEvent,
): SessionEntry[] {
  let entries = normalizeSessionEntries(Array.isArray(snapshot?.entries) ? snapshot.entries : []);
  const inFlight = snapshot?.streamingMessage;
  if (inFlight && typeof inFlight === 'object') {
    // 走同一条 message_* 投影，缓冲里后到的那一拍才会换到同一格，而不是另开一条气泡。
    entries = apply(entries, {
      type: snapshot.streaming === false ? 'message_end' : 'message_update',
      message: inFlight,
    });
  }
  for (const ev of buffer) entries = apply(entries, ev);
  return entries;
}

/** 压缩成功才换树；中止、失败、还要重试的都不动已画内容。 */
export function shouldRebuildOnCompaction(ev: unknown): boolean {
  const rec = ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : {};
  if (String(rec.type ?? '') !== 'compaction_end') return false;
  if (rec.aborted === true) return false;
  if (rec.willRetry === true) return false;
  if (typeof rec.errorMessage === 'string' && rec.errorMessage) return false;
  return true;
}
