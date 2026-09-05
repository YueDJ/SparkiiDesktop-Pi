/**
 * Pi 的事件与条目类型是开放集合：管道整包透传，未知 `type` 也要留在列表里（详情级默认 debug）。
 * 已知值列出来只是为了让标签/状态映射有补全，不是允许名单。
 */
export type TimelineEventType =
  | (string & {})
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'turn_start'
  | 'turn_end'
  | 'compaction_start'
  | 'compaction_end'
  | 'compaction'
  | 'model_change'
  | 'thinking_level_change'
  | 'session_info'
  | 'custom_message'
  | 'branch_summary'
  | 'custom'
  | 'label'
  | 'auto_retry_start'
  | 'auto_retry_end'
  | 'summarization_retry_scheduled'
  | 'summarization_retry_attempt_start'
  | 'summarization_retry_finished'
  | 'runtime_error';

export type TimelineStatus = 'info' | 'running' | 'ok' | 'warn' | 'error';

export type ChatEntry =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'assistant';
      text: string;
      thinking?: string;
      streaming: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      input: unknown;
      /** `tool_execution_update` 的中途结果；`result` 到达前才有值。 */
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
      awaitingApproval?: boolean;
      toolCallId?: string;
    }
  | {
      kind: 'event';
      id: string;
      event: TimelineEventType;
      label: string;
      detail?: string;
      status?: TimelineStatus;
      timestamp?: number;
      payload?: unknown;
    };

const id = (prefix: string) => `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (asRecord(block).type === 'text' ? String(asRecord(block).text ?? '') : ''))
    .join('');
}

function contentThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter((block) => asRecord(block).type === 'thinking')
    .map((block) => String(asRecord(block).thinking ?? ''))
    .join('');
  return thinking || undefined;
}

export function findLastUnresolvedTool(entries: ChatEntry[], toolName: string, toolCallId?: string): number {
  if (toolCallId) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === 'tool' && entry.result === undefined && entry.toolCallId === toolCallId) return i;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === 'tool' && entry.result === undefined && entry.toolName === toolName) return i;
  }
  return -1;
}

function eventLabel(type: TimelineEventType, _raw: Record<string, unknown>): string {
  switch (type) {
    case 'agent_start': return 'Pi 开始处理';
    case 'agent_end': return 'Pi 处理完成';
    case 'agent_settled': return 'Pi 已就绪';
    case 'turn_start': return '新一轮开始';
    case 'turn_end': return '新一轮结束';
    case 'compaction_start': return '开始压缩上下文';
    case 'compaction_end': return '上下文压缩完成';
    case 'compaction': return '上下文压缩';
    case 'model_change': return '模型切换';
    case 'thinking_level_change': return '思考强度调整';
    case 'session_info': return '会话信息';
    case 'custom_message': return '自定义消息';
    case 'branch_summary': return '分支摘要';
    case 'custom': return '自定义记录';
    case 'label': return '会话标记';
    case 'auto_retry_start': return '自动重试开始';
    case 'auto_retry_end': return '自动重试结束';
    case 'summarization_retry_scheduled': return '摘要重试已安排';
    case 'summarization_retry_attempt_start': return '摘要重试开始';
    case 'summarization_retry_finished': return '摘要重试完成';
    case 'runtime_error': return '运行时错误';
    default: return type;
  }
}

function eventDetail(type: TimelineEventType, raw: Record<string, unknown>): string | undefined {
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  switch (type) {
    case 'agent_end':
      return raw.willRetry ? '将自动重试' : undefined;
    case 'compaction_start':
      return reason || undefined;
    case 'compaction_end': {
      const result = asRecord(raw.result);
      const before = result.tokensBefore ?? raw.tokensBefore;
      const after = result.estimatedTokensAfter ?? raw.estimatedTokensAfter;
      if (before === undefined && after === undefined) return raw.errorMessage ? String(raw.errorMessage) : undefined;
      const parts = [`${String(before ?? '?')} tokens`];
      if (after !== undefined) parts.push(`压缩后约 ${after} tokens`);
      return parts.join(' · ');
    }
    case 'compaction': {
      const before = raw.tokensBefore;
      const summary = typeof raw.summary === 'string' ? raw.summary : '';
      if (before === undefined) return summary || undefined;
      return `${summary ? `${summary} · ` : ''}${before} tokens`;
    }
    case 'model_change':
      return `${raw.provider ?? 'unknown'}/${raw.modelId ?? ''}`;
    case 'thinking_level_change':
      return raw.thinkingLevel ? String(raw.thinkingLevel) : raw.level ? String(raw.level) : undefined;
    case 'session_info':
      return raw.name ? `名称: ${String(raw.name)}` : undefined;
    case 'custom_message':
      return contentText(raw.content);
    case 'branch_summary':
      return typeof raw.summary === 'string' ? raw.summary : undefined;
    case 'label':
      return raw.label ? String(raw.label) : undefined;
    case 'auto_retry_start':
      return `第 ${raw.attempt}/${raw.maxAttempts} 次 · ${raw.delayMs}ms`;
    case 'auto_retry_end':
      return raw.success ? `第 ${raw.attempt} 次成功` : `第 ${raw.attempt} 次失败${raw.finalError ? `: ${raw.finalError}` : ''}`;
    case 'summarization_retry_scheduled':
      return `第 ${raw.attempt}/${raw.maxAttempts} 次 · ${raw.delayMs}ms`;
    case 'summarization_retry_attempt_start':
      return raw.source ? String(raw.source) : undefined;
    case 'runtime_error':
      return typeof raw.message === 'string' ? raw.message : undefined;
    default:
      return undefined;
  }
}

function eventStatus(type: TimelineEventType, _raw: Record<string, unknown>): TimelineStatus | undefined {
  switch (type) {
    case 'agent_start':
    case 'turn_start':
    case 'compaction_start':
    case 'auto_retry_start':
    case 'summarization_retry_attempt_start':
      return 'running';
    case 'agent_end':
    case 'agent_settled':
    case 'turn_end':
    case 'compaction_end':
    case 'auto_retry_end':
    case 'summarization_retry_finished':
      return 'ok';
    case 'runtime_error':
      return 'error';
    case 'compaction':
    case 'model_change':
    case 'thinking_level_change':
    case 'session_info':
    case 'custom_message':
    case 'branch_summary':
    case 'custom':
    case 'label':
      return 'info';
    default:
      return undefined;
  }
}

function timelineEntry(type: TimelineEventType, raw: unknown): ChatEntry {
  const record = asRecord(raw);
  return {
    kind: 'event',
    id: id('ev'),
    event: type,
    label: eventLabel(type, record),
    detail: eventDetail(type, record),
    status: eventStatus(type, record),
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : undefined,
    payload: raw,
  };
}

function pushMessage(out: ChatEntry[], role: 'user' | 'assistant', text: string, thinking?: string) {
  if (!text && !thinking) return;
  out.push({ kind: 'message', id: id('m'), role, text, thinking, streaming: false });
}

function normalizeSessionEntry(raw: unknown, out: ChatEntry[]): void {
  const record = asRecord(raw);
  const type = String(record.type ?? '');
  if (type === 'message') {
    const message = asRecord(record.message);
    const role = String(message.role ?? '');
    const content = message.content;
    const text = typeof message.text === 'string' ? message.text : contentText(content);
    const thinking = typeof message.thinking === 'string' ? message.thinking : contentThinking(content);
    if (role === 'user') {
      pushMessage(out, 'user', text);
      return;
    }
    if (role === 'assistant') {
      pushMessage(out, 'assistant', text, thinking);
      if (Array.isArray(content)) {
        for (const block of content) {
          const blockRec = asRecord(block);
          if (blockRec.type !== 'toolCall') continue;
          const toolCallId = typeof blockRec.id === 'string' ? blockRec.id : undefined;
          const toolName = String(blockRec.name ?? '');
          out.push({ kind: 'tool', id: id('t'), toolName, input: blockRec.arguments ?? {}, toolCallId });
        }
      }
      return;
    }
    if (role === 'toolResult') {
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
      const toolName = String(message.toolName ?? '');
      const idx = findLastUnresolvedTool(out, toolName, toolCallId);
      if (idx >= 0) {
        const target = out[idx] as Extract<ChatEntry, { kind: 'tool' }>;
        out[idx] = { ...target, result: message, awaitingApproval: false };
      } else {
        out.push({ kind: 'tool', id: id('t'), toolName, input: {}, result: message, toolCallId });
      }
      return;
    }
    if (role === 'bashExecution') {
      out.push({
        kind: 'tool',
        id: id('t'),
        toolName: 'bash',
        input: { command: message.command },
        result: { output: message.output, exitCode: message.exitCode, truncated: message.truncated },
      });
      return;
    }
    if (role === 'custom') {
      out.push(timelineEntry('custom_message', message));
      return;
    }
    if (role === 'branchSummary') {
      out.push(timelineEntry('branch_summary', message));
      return;
    }
    if (role === 'compactionSummary') {
      out.push(timelineEntry('compaction', message));
      return;
    }
    return;
  }

  switch (type) {
    case 'compaction':
      out.push(timelineEntry('compaction', record));
      return;
    case 'model_change':
      out.push(timelineEntry('model_change', record));
      return;
    case 'thinking_level_change':
      out.push(timelineEntry('thinking_level_change', record));
      return;
    case 'session_info':
      out.push(timelineEntry('session_info', record));
      return;
    case 'branch_summary':
      out.push(timelineEntry('branch_summary', record));
      return;
    case 'custom':
      out.push(timelineEntry('custom', record));
      return;
    case 'custom_message':
      out.push(timelineEntry('custom_message', record));
      return;
    case 'label':
      out.push(timelineEntry('label', record));
      return;
    default:
      return;
  }
}

export function normalizeSessionEntries(entries: unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const entry of entries) normalizeSessionEntry(entry, out);
  return out;
}

export function normalizeHistoricalSessionEntries(entries: unknown[]): ChatEntry[] {
  const body = normalizeSessionEntries(entries);
  if (body.length === 0) return body;
  return [
    timelineEntry('agent_start', {}),
    ...body,
    timelineEntry('agent_end', {}),
    timelineEntry('agent_settled', {}),
  ];
}

export function normalizeMessages(messages: unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let n = 0;
  for (const message of messages) {
    const record = asRecord(message);
    const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : null;
    const text = typeof record.text === 'string' ? record.text : contentText(record.content);
    const thinking = typeof record.thinking === 'string' ? record.thinking : contentThinking(record.content);
    if (role && (text || thinking)) {
      out.push({ kind: 'message', id: `m${n++}`, role, text, thinking, streaming: false });
    }
  }
  return out;
}

type MessageEntry = Extract<ChatEntry, { kind: 'message' }>;
type ToolEntry = Extract<ChatEntry, { kind: 'tool' }>;

/** 流式槽是「`streaming === true` 的那条 assistant」，不是 `entries.at(-1)`：中间可能插了工具块或步骤行。 */
function streamingSlotIndex(entries: ChatEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === 'message' && entry.role === 'assistant' && entry.streaming) return i;
  }
  return -1;
}

function messageText(message: Record<string, unknown>): { text: string; thinking?: string } {
  return {
    text: typeof message.text === 'string' ? message.text : contentText(message.content),
    thinking: typeof message.thinking === 'string' ? message.thinking : contentThinking(message.content),
  };
}

/** 末条已是相同文本的同角色气泡则跳过，其余追加（`appendMessage` 不发 `entry_appended`，两条路都要能画）。 */
function appendUniqueMessage(entries: ChatEntry[], role: 'user' | 'assistant', text: string, thinking?: string): ChatEntry[] {
  if (!text && !thinking) return entries;
  const last = entries[entries.length - 1];
  if (last?.kind === 'message' && last.role === role && last.text === text) return entries;
  return [...entries, { kind: 'message', id: id('m'), role, text, thinking, streaming: false }];
}

function replaceStreamingSlot(entries: ChatEntry[], message: Record<string, unknown>, streaming: boolean): ChatEntry[] {
  const { text, thinking } = messageText(message);
  const idx = streamingSlotIndex(entries);
  if (idx < 0) {
    if (!streaming && !text && !thinking) return entries;
    return [...entries, { kind: 'message', id: id('m'), role: 'assistant', text, thinking, streaming }];
  }
  const next = [...entries];
  const slot = next[idx] as MessageEntry;
  next[idx] = { ...slot, text, thinking, streaming };
  return next;
}

function findToolByCallId(entries: ChatEntry[], toolCallId: string | undefined, toolName: string): number {
  if (toolCallId) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === 'tool' && entry.toolCallId === toolCallId) return i;
    }
    return -1;
  }
  return findLastUnresolvedTool(entries, toolName);
}

export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[] {
  const raw = asRecord(ev);
  const type = String(raw.type ?? '');

  if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
    const message = asRecord(raw.message);
    const role = String(message.role ?? 'assistant');
    if (role === 'user') {
      const { text } = messageText(message);
      return appendUniqueMessage(entries, 'user', text);
    }
    if (role !== 'assistant') return entries;
    // 全文换槽。`delta` 是 Pi 内部「这一 tick 新字」，不当合成规则用。
    if (type === 'message_start' && streamingSlotIndex(entries) < 0) {
      const { text, thinking } = messageText(message);
      return [...entries, { kind: 'message', id: id('m'), role: 'assistant', text, thinking, streaming: true }];
    }
    return replaceStreamingSlot(entries, message, type !== 'message_end');
  }

  if (type === 'entry_appended') {
    const entry = asRecord(raw.entry);
    if (String(entry.type) === 'message') {
      const message = asRecord(entry.message);
      const role = String(message.role ?? '');
      if (role !== 'user' && role !== 'assistant') {
        const out: ChatEntry[] = [];
        normalizeSessionEntry(entry, out);
        return out.length ? [...entries, ...out] : entries;
      }
      const { text, thinking } = messageText(message);
      return appendUniqueMessage(entries, role, text, thinking);
    }
    const out: ChatEntry[] = [];
    normalizeSessionEntry(entry, out);
    return out.length ? [...entries, ...out] : entries;
  }

  if (type === 'tool_execution_start') {
    return [...entries, {
      kind: 'tool',
      id: id('t'),
      toolName: String(raw.toolName ?? ''),
      input: raw.args ?? raw.params ?? raw.input ?? {},
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
    }];
  }

  if (type === 'tool_execution_update') {
    const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined;
    const idx = findToolByCallId(entries, toolCallId, String(raw.toolName ?? ''));
    if (idx < 0) return entries;
    const next = [...entries];
    const target = next[idx] as ToolEntry;
    next[idx] = { ...target, partialResult: raw.partialResult };
    return next;
  }

  if (type === 'tool_execution_end') {
    const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined;
    const toolName = String(raw.toolName ?? '');
    const idx = findToolByCallId(entries, toolCallId, toolName);
    const isError = raw.isError === true ? true : undefined;
    if (idx < 0) {
      return [...entries, {
        kind: 'tool',
        id: id('t'),
        toolName,
        input: raw.args ?? raw.params ?? {},
        result: raw.result,
        isError,
        toolCallId,
      }];
    }
    const next = [...entries];
    const target = next[idx] as ToolEntry;
    const { partialResult: _dropped, ...rest } = target;
    next[idx] = { ...rest, result: raw.result, isError, awaitingApproval: false };
    return next;
  }

  if (type === 'agent_end') {
    const finalized = entries.map((entry) =>
      entry.kind === 'message' && entry.role === 'assistant' && entry.streaming
        ? { ...entry, streaming: false }
        : entry,
    );
    return [...finalized, timelineEntry('agent_end', raw)];
  }

  if (type === 'thinking_level_changed') {
    return [...entries, timelineEntry('thinking_level_change', raw)];
  }
  if (type === 'session_info_changed') {
    return [...entries, timelineEntry('session_info', raw)];
  }

  if (!type) return entries;
  // 未知 `type` 留在列表里（`kind:'event'`、label 就是原 type）。详情级默认 debug，聊天不会被生命周期卡刷屏。
  return [...entries, timelineEntry(type, raw)];
}
