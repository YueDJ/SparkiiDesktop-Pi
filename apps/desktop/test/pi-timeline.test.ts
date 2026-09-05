import { describe, it, expect } from 'vitest';
import { applyChatEvent, normalizeHistoricalSessionEntries, normalizeSessionEntries } from '../src/workbench/pi-timeline.js';
import { shouldShowEntry } from '../src/workbench/chat-detail-level.js';

describe('normalizeSessionEntries', () => {
  it('rebuilds messages, tool calls and lifecycle events from persisted entries', () => {
    const entries = normalizeSessionEntries([
      { type: 'message', message: { role: 'user', content: 'hi' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先分析' },
            { type: 'text', text: '答案是 42' },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
      },
      { type: 'compaction', summary: '已压缩较早内容', firstKeptEntryId: 'm2', tokensBefore: 150000 },
      { type: 'model_change', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
    ]);

    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ kind: 'message', role: 'user', text: 'hi' });
    expect(entries[1]).toMatchObject({ kind: 'message', role: 'assistant', text: '答案是 42', thinking: '先分析' });
    expect(entries[2]).toMatchObject({ kind: 'tool', toolName: 'bash', toolCallId: 'call_1', input: { command: 'ls' } });
    expect(entries[2]).toMatchObject({ result: expect.objectContaining({ role: 'toolResult', toolCallId: 'call_1' }) });
    expect(entries[3]).toMatchObject({ kind: 'event', event: 'compaction' });
    expect(entries[3]).toMatchObject({ detail: expect.stringContaining('150000') });
    expect(entries[4]).toMatchObject({ kind: 'event', event: 'model_change' });
    expect(entries[5]).toMatchObject({ kind: 'event', event: 'thinking_level_change' });
  });

});

describe('normalizeHistoricalSessionEntries', () => {
  it('adds Pi start, end, and settled lifecycle cards around persisted entries', () => {
    const entries = normalizeHistoricalSessionEntries([
      { type: 'message', message: { role: 'user', content: 'hi' } },
    ]);

    expect(entries.map((entry) => entry.kind === 'event' ? entry.event : entry.kind))
      .toEqual(['agent_start', 'message', 'agent_end', 'agent_settled']);
    expect(entries[0]).toMatchObject({ event: 'agent_start' });
    expect(entries[2]).toMatchObject({ event: 'agent_end' });
    expect(entries[3]).toMatchObject({ event: 'agent_settled' });
  });
});

const assistant = (text: string, extra: unknown[] = []) => ({
  role: 'assistant',
  content: [...extra, { type: 'text', text }],
});

describe('applyChatEvent', () => {
  it('replaces the streaming slot with the full message on message_update', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [] } });
    entries = applyChatEvent(entries, { type: 'message_update', message: assistant('第3条') });
    entries = applyChatEvent(entries, { type: 'message_update', message: assistant('第3条存在期限不对齐') });
    expect(entries.filter((e) => e.kind === 'message')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ kind: 'message', text: '第3条存在期限不对齐', streaming: true });
  });

  it('finalizes on message_end without waiting for a tree id', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: assistant('完') });
    entries = applyChatEvent(entries, { type: 'message_end', message: assistant('完') });
    expect(entries.filter((e) => e.kind === 'message')).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ kind: 'message', streaming: false, text: '完' });
  });

  it('does not stitch deltas onto the slot', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [] } });
    entries = applyChatEvent(entries, { type: 'message_update', delta: '第3', message: assistant('第3') });
    entries = applyChatEvent(entries, { type: 'message_update', delta: '条', message: assistant('第3条') });
    expect(entries.at(-1)).toMatchObject({ kind: 'message', text: '第3条' });
  });

  it('carries thinking blocks into the streaming slot', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [] } });
    entries = applyChatEvent(entries, {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '让我想想' }] },
    });
    expect(entries.at(-1)).toMatchObject({ kind: 'message', role: 'assistant', thinking: '让我想想', streaming: true });
  });

  it('appends a user bubble on message_start user', () => {
    const entries = applyChatEvent([], {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: '请审核' }] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'message', role: 'user', text: '请审核', streaming: false });
  });

  it('updates the streaming slot even when a tool block is last', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: assistant('a') });
    entries = applyChatEvent(entries, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read' });
    entries = applyChatEvent(entries, { type: 'message_update', message: assistant('ab') });
    expect(entries.at(-1)).toMatchObject({ kind: 'tool', toolName: 'read' });
    const msg = entries.find((e) => e.kind === 'message' && e.role === 'assistant');
    expect(msg).toMatchObject({ text: 'ab', streaming: true });
  });

  it('opens a fresh slot for the next assistant turn after message_end', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: assistant('一') });
    entries = applyChatEvent(entries, { type: 'message_end', message: assistant('一') });
    entries = applyChatEvent(entries, { type: 'message_start', message: assistant('二') });
    entries = applyChatEvent(entries, { type: 'message_update', message: assistant('二三') });
    expect(entries.filter((e) => e.kind === 'message')).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: '一', streaming: false });
    expect(entries[1]).toMatchObject({ text: '二三', streaming: true });
  });

  it('pairs the tool execution triple by toolCallId', () => {
    let entries = applyChatEvent([], { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'write', args: { path: 'a.ts' } });
    entries = applyChatEvent(entries, { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'write', params: { path: 'b.ts' } });
    entries = applyChatEvent(entries, { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'write', partialResult: { lines: 1 } });
    expect(entries[0]).toMatchObject({ kind: 'tool', input: { path: 'a.ts' }, partialResult: { lines: 1 } });
    expect(entries[0]).not.toHaveProperty('result');
    entries = applyChatEvent(entries, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'write', result: { ok: true } });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'tool', result: { ok: true }, awaitingApproval: false });
    expect(entries[1]).toMatchObject({ kind: 'tool', input: { path: 'b.ts' } });
    expect(entries[1]).not.toHaveProperty('result');
  });

  it('marks a failed tool execution as an error', () => {
    let entries = applyChatEvent([], { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
    entries = applyChatEvent(entries, { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { error: 'nope' }, isError: true });
    expect(entries[0]).toMatchObject({ kind: 'tool', isError: true, result: { error: 'nope' } });
    expect(shouldShowEntry(entries[0], 'minimal')).toBe(true);
  });

  it('records a tool_execution_end that arrives without a start', () => {
    const entries = applyChatEvent([], { type: 'tool_execution_end', toolCallId: 'c9', toolName: 'read', result: { ok: true } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', toolName: 'read', toolCallId: 'c9', result: { ok: true } });
  });

  it('keeps unknown event types in the list as debug events', () => {
    const entries = applyChatEvent([], { type: 'future_thing', x: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'event',
      event: 'future_thing',
      label: 'future_thing',
      payload: expect.objectContaining({ type: 'future_thing', x: 1 }),
    });
    expect(shouldShowEntry(entries[0], 'standard')).toBe(false);
    expect(shouldShowEntry(entries[0], 'debug')).toBe(true);
  });

  it('turns compaction events into timeline cards while preserving messages', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: assistant('你好') });
    entries = applyChatEvent(entries, { type: 'message_end', message: assistant('你好') });
    entries = applyChatEvent(entries, { type: 'compaction_start', reason: 'threshold' });
    entries = applyChatEvent(entries, {
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
      willRetry: false,
    });

    expect(entries[0]).toMatchObject({ kind: 'message', text: '你好' });
    expect(entries[1]).toMatchObject({ kind: 'event', event: 'compaction_start', detail: expect.stringContaining('threshold') });
    expect(entries[2]).toMatchObject({ kind: 'event', event: 'compaction_end' });
  });

  it('renders a live thinking level change event', () => {
    const entries = applyChatEvent([], { type: 'thinking_level_changed', level: 'off' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'event', event: 'thinking_level_change', detail: 'off' });
  });

  it('finalizes a still-streaming slot on agent_end', () => {
    let entries = applyChatEvent([], { type: 'message_start', message: assistant('半句') });
    entries = applyChatEvent(entries, { type: 'agent_end' });
    expect(entries[0]).toMatchObject({ kind: 'message', streaming: false, text: '半句' });
    expect(entries[1]).toMatchObject({ kind: 'event', event: 'agent_end' });
  });
});
