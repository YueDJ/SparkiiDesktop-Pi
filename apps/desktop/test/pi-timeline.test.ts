import { describe, it, expect } from 'vitest';
import { applyChatEvent, normalizeSessionEntries } from '../src/workbench/pi-timeline.js';

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

describe('applyChatEvent', () => {
  it('turns compaction events into timeline cards while preserving messages', () => {
    let entries = applyChatEvent([], { type: 'message', role: 'assistant', delta: '你好' });
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

  it('pairs tool events by toolCallId before falling back to toolName', () => {
    let entries = applyChatEvent([], { type: 'tool_call', toolCallId: 'call_1', toolName: 'write', input: { path: 'a.ts' } });
    entries = applyChatEvent(entries, { type: 'tool_call', toolName: 'write', input: { path: 'b.ts' } });
    entries = applyChatEvent(entries, { type: 'tool_result', toolCallId: 'call_1', toolName: 'write', result: { ok: true } });
    expect(entries[0]).toMatchObject({ result: { ok: true } });
    expect(entries[1]).not.toHaveProperty('result');
  });

  it('renders a live thinking level change event', () => {
    const entries = applyChatEvent([], { type: 'thinking_level_changed', level: 'off' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'event', event: 'thinking_level_change', detail: 'off' });
  });
});
