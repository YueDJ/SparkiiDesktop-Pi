import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { PiRpcClient, normalizeEvent } from '../src/rpc-client.js';

describe('normalizeEvent', () => {
  it('maps assistant message delta', () => {
    const e = normalizeEvent({ type: 'message_update', role: 'assistant', textDelta: 'hi' });
    expect(e).toEqual({ type: 'message', role: 'assistant', delta: 'hi' });
  });
  it('maps thinking deltas and extracts thinking from message_end', () => {
    expect(normalizeEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '让我想想' } }))
      .toEqual({ type: 'message', role: 'assistant', thinkingDelta: '让我想想' });
    expect(normalizeEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先分析' },
          { type: 'text', text: '答案是 42' },
        ],
      },
    })).toEqual({ type: 'message', role: 'assistant', text: '答案是 42', thinking: '先分析' });
  });
  it('keeps unknown events as unknown', () => {
    expect(normalizeEvent({ type: 'future_thing', x: 1 }).type).toBe('unknown');
  });
  it("maps SDK tool execution events", () => {
    expect(normalizeEvent({ type: "tool_execution_start", toolName: "read", params: { path: "a.md" } }))
      .toEqual({ type: "tool_call", toolName: "read", input: { path: "a.md" } });
    expect(normalizeEvent({ type: "tool_execution_end", toolName: "read", details: { ok: true } }))
      .toEqual({ type: "tool_result", toolName: "read", result: { ok: true } });
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
