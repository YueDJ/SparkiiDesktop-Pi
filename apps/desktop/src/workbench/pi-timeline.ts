export type TimelineEventType =
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
  | 'shell_selected'
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
      result?: unknown;
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
    case 'shell_selected': return '执行 Shell';
    case 'runtime_error': return '运行时错误';
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
    case 'shell_selected': {
      const shell = raw.shell === 'powershell' ? 'PowerShell' : raw.shell === 'bash' ? 'Git Bash' : undefined;
      if (!shell) return undefined;
      return raw.degraded ? `${shell}（降级）` : shell;
    }
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
    case 'shell_selected':
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

export function shellSelectedEntry(shell: 'bash' | 'powershell', degraded?: boolean): ChatEntry {
  return timelineEntry('shell_selected', { shell, degraded: Boolean(degraded) });
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

export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[] {
  const raw = ev as Record<string, unknown>;
  const type = String(raw.type ?? '');
  if (type === 'message') {
    if (raw.role === 'user') return entries;
    const last = entries[entries.length - 1];
    const isActive = last?.kind === 'message' && last.role === 'assistant' && last.streaming;
    const base = isActive
      ? (last as Extract<ChatEntry, { kind: 'message' }>)
      : { kind: 'message' as const, id: id('m'), role: 'assistant' as const, text: '', streaming: true };

    if (typeof raw.thinkingDelta === 'string') {
      const next = { ...base, thinking: (base.thinking ?? '') + raw.thinkingDelta };
      return isActive ? [...entries.slice(0, -1), next] : [...entries, next];
    }

    const finalThinking = typeof raw.thinking === 'string' ? raw.thinking : undefined;
    const finalText = typeof raw.text === 'string' ? raw.text : undefined;
    const delta = typeof raw.delta === 'string' ? raw.delta : undefined;
    if (finalThinking === undefined && finalText === undefined && delta === undefined) return entries;

    const next = {
      ...base,
      thinking: finalThinking !== undefined ? finalThinking : base.thinking,
      text: finalText !== undefined ? finalText : delta !== undefined ? base.text + delta : base.text,
      streaming: delta !== undefined,
    };
    return isActive ? [...entries.slice(0, -1), next] : [...entries, next];
  }

  if (type === 'tool_call') {
    return [...entries, {
      kind: 'tool',
      id: id('t'),
      toolName: String(raw.toolName ?? ''),
      input: raw.input,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
    }];
  }
  if (type === 'tool_result') {
    const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined;
    const idx = findLastUnresolvedTool(entries, String(raw.toolName ?? ''), toolCallId);
    if (idx < 0) return entries;
    const next = [...entries];
    const target = next[idx] as Extract<ChatEntry, { kind: 'tool' }>;
    next[idx] = { ...target, result: raw.result, awaitingApproval: false };
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

  switch (type) {
    case 'agent_start':
    case 'agent_settled':
    case 'turn_start':
    case 'turn_end':
    case 'compaction_start':
    case 'compaction_end':
    case 'model_change':
    case 'thinking_level_change':
    case 'session_info':
    case 'custom_message':
    case 'branch_summary':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'runtime_error':
      return [...entries, timelineEntry(type as TimelineEventType, raw)];
    default:
      return entries;
  }
}
