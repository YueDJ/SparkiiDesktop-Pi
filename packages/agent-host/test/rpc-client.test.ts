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
    expect(normalizeEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", params: { path: "a.md" } }))
      .toEqual({ type: "tool_call", toolCallId: "call_1", toolName: "read", input: { path: "a.md" } });
    expect(normalizeEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", details: { ok: true } }))
      .toEqual({ type: "tool_result", toolCallId: "call_1", toolName: "read", result: { ok: true } });
  });
  it("maps queue_update events", () => {
    expect(normalizeEvent({ type: "queue_update", steering: ["先做这个"], followUp: ["做完后整理"] }))
      .toEqual({ type: "queue_update", steering: ["先做这个"], followUp: ["做完后整理"] });
  });
  it("maps user entry_appended events into user messages", () => {
    expect(normalizeEvent({
      type: "entry_appended",
      entry: {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "先检查一下结果" },
          ],
        },
      },
    })).toEqual({ type: "message", role: "user", text: "先检查一下结果" });
  });

  it("passes through custom entry_appended rows", () => {
    expect(normalizeEvent({
      type: "entry_appended",
      entry: { type: "custom", customType: "workflow_step_end", data: { stepId: "review", status: "completed" }, id: "e1" },
    })).toEqual({
      type: "entry_appended",
      entry: { type: "custom", customType: "workflow_step_end", data: { stepId: "review", status: "completed" }, id: "e1" },
    });
  });

  it("preserves lifecycle payloads for compaction, retries and session changes", () => {
    expect(normalizeEvent({ type: "compaction_start", reason: "threshold" }))
      .toEqual({ type: "compaction_start", reason: "threshold" });
    expect(normalizeEvent({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
      willRetry: false,
    })).toEqual({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 150000, estimatedTokensAfter: 32000 },
      aborted: false,
      willRetry: false,
    });
    expect(normalizeEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" }))
      .toEqual({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
    expect(normalizeEvent({ type: "thinking_level_changed", level: "high" }))
      .toEqual({ type: "thinking_level_changed", level: "high" });
    expect(normalizeEvent({ type: "agent_end", willRetry: true }))
      .toEqual({ type: "agent_end", willRetry: true });
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
