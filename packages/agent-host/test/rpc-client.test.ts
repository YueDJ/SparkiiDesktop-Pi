import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { PiRpcClient, normalizeEvent } from '../src/rpc-client.js';

describe('normalizeEvent', () => {
  it('passes message_update through with full message', () => {
    const raw = {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] },
      assistantMessageEvent: { type: 'text_delta', delta: '条' },
    };
    expect(normalizeEvent(raw)).toEqual(raw);
  });

  it('does not flatten tool_execution_* or user entry_appended', () => {
    const tool = { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', params: { path: 'a.md' } };
    expect(normalizeEvent(tool)).toEqual(tool);
    const user = {
      type: 'entry_appended',
      entry: { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '先检查' }] } },
    };
    expect(normalizeEvent(user)).toEqual(user);
  });

  it('forwards unknown types as-is (does not wrap as type:unknown)', () => {
    const raw = { type: 'future_thing', x: 1 };
    expect(normalizeEvent(raw)).toEqual(raw);
  });

  it('passes custom entry_appended through unchanged', () => {
    const raw = {
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'workflow_step_end', data: { stepId: 'review' }, id: 'e1' },
    };
    expect(normalizeEvent(raw)).toEqual(raw);
  });

  it('preserves lifecycle payloads for compaction, retries and session changes', () => {
    const compactionStart = { type: 'compaction_start', reason: 'threshold' };
    expect(normalizeEvent(compactionStart)).toEqual(compactionStart);
    const compactionEnd = {
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
      willRetry: false,
    };
    expect(normalizeEvent(compactionEnd)).toEqual(compactionEnd);
    const retry = { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' };
    expect(normalizeEvent(retry)).toEqual(retry);
    const thinking = { type: 'thinking_level_changed', level: 'high' };
    expect(normalizeEvent(thinking)).toEqual(thinking);
    const agentEnd = { type: 'agent_end', willRetry: true };
    expect(normalizeEvent(agentEnd)).toEqual(agentEnd);
  });

  it('wraps non-events as unknown', () => {
    expect(normalizeEvent(null)).toEqual({ type: 'unknown', raw: null });
    expect(normalizeEvent('x')).toEqual({ type: 'unknown', raw: 'x' });
  });
});

describe('PiRpcClient', () => {
  it('correlates responses by id and streams events', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const c = new PiRpcClient(stdin, stdout);
    const onEvent = vi.fn();
    c.onEvent(onEvent);
    const respP = c.send({ type: 'prompt', message: 'hi' }, 'req-1');
    stdout.write('{"id":"req-1","type":"response","command":"prompt","success":true}\n');
    stdout.write('{"type":"message_start","role":"assistant"}\n');
    const resp = await respP;
    expect(resp.success).toBe(true);
    expect(onEvent).toHaveBeenCalled();
    c.close();
  });
});
