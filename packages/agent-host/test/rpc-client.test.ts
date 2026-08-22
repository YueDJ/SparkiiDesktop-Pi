import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { PiRpcClient, normalizeEvent } from '../src/rpc-client.js';

describe('normalizeEvent', () => {
  it('maps assistant message delta', () => {
    const e = normalizeEvent({ type: 'message_update', role: 'assistant', textDelta: 'hi' });
    expect(e).toEqual({ type: 'message', role: 'assistant', delta: 'hi' });
  });
  it('keeps unknown events as unknown', () => {
    expect(normalizeEvent({ type: 'future_thing', x: 1 }).type).toBe('unknown');
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
