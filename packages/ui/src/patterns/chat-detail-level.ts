import type { ChatEntry } from './pi-timeline.js';

export type ChatDetailLevel = 'minimal' | 'standard' | 'debug';

export const CHAT_DETAIL_LEVELS: readonly ChatDetailLevel[] = ['minimal', 'standard', 'debug'] as const;
export const DEFAULT_CHAT_DETAIL_LEVEL: ChatDetailLevel = 'standard';

export function isChatDetailLevel(value: unknown): value is ChatDetailLevel {
  return value === 'minimal' || value === 'standard' || value === 'debug';
}

export function chatDetailLevelLabel(level: ChatDetailLevel): string {
  switch (level) {
    case 'minimal':
      return '简洁';
    case 'standard':
      return '标准';
    case 'debug':
      return '调试';
  }
}

const LEVEL_RANK: Record<ChatDetailLevel, number> = {
  minimal: 0,
  standard: 1,
  debug: 2,
};

/** 只列已知事件；查不到的（Pi 新加的、我们还没认的）落到 `?? 'debug'`，留在列表但不刷标准视图。 */
const EVENT_MIN_LEVEL: Record<string, ChatDetailLevel | undefined> = {
  runtime_error: 'minimal',
  compaction_start: 'standard',
  compaction_end: 'standard',
  compaction: 'standard',
  custom_message: 'standard',
  branch_summary: 'standard',
  session_info: 'standard',
  custom: 'standard',
  label: 'standard',
  agent_start: 'debug',
  agent_end: 'debug',
  agent_settled: 'debug',
  turn_start: 'debug',
  turn_end: 'debug',
  model_change: 'debug',
  thinking_level_change: 'debug',
  auto_retry_start: 'debug',
  auto_retry_end: 'debug',
  summarization_retry_scheduled: 'debug',
  summarization_retry_attempt_start: 'debug',
  summarization_retry_finished: 'debug',
};

function toolResultIsImportant(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const rec = result as Record<string, unknown>;
  const exitCode = rec.exitCode;
  if ((typeof exitCode === 'number' && exitCode !== 0) || (typeof exitCode === 'string' && exitCode !== '0')) {
    return true;
  }
  return rec.ok === false || rec.success === false || rec.error !== undefined;
}

export function shouldShowEntry(entry: ChatEntry, level: ChatDetailLevel): boolean {
  if (entry.kind === 'message') return true;

  if (entry.kind === 'tool') {
    if (level === 'minimal') {
      return Boolean(entry.awaitingApproval) || entry.isError === true || toolResultIsImportant(entry.result);
    }
    return true;
  }

  const min = EVENT_MIN_LEVEL[entry.event] ?? 'debug';
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}
