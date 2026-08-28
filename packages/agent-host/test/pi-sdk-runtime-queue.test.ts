import { describe, it, expect, vi } from 'vitest';
import { clearSessionQueue, readQueueSnapshot, startPromptWithoutBlocking } from '../src/pi-sdk-runtime.js';

describe('pi-sdk-runtime queue adapters', () => {
  it('reads the native steering and follow-up message getters', () => {
    const session = {
      getSteeringMessages: vi.fn(() => ['先做这个']),
      getFollowUpMessages: vi.fn(() => ['做完后整理']),
    };

    expect(readQueueSnapshot(session as any)).toEqual({
      steering: ['先做这个'],
      followUp: ['做完后整理'],
    });
    expect(session.getSteeringMessages).toHaveBeenCalled();
    expect(session.getFollowUpMessages).toHaveBeenCalled();
  });

  it('clears queues through the native clearQueue method', () => {
    const session = {
      clearQueue: vi.fn(() => ({
        steering: ['先做这个'],
        followUp: ['做完后整理'],
      })),
    };

    expect(clearSessionQueue(session as any)).toEqual({
      steering: ['先做这个'],
      followUp: ['做完后整理'],
    });
    expect(session.clearQueue).toHaveBeenCalled();
  });

  it('starts a prompt without waiting for the full agent turn to finish', async () => {
    let resolvePrompt: () => void = () => {};
    const session = {
      prompt: vi.fn(() => new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      })),
    };

    const started = startPromptWithoutBlocking(session as any, '开始一个长任务', { streamingBehavior: undefined });
    await expect(started).resolves.toBeUndefined();
    expect(session.prompt).toHaveBeenCalledWith('开始一个长任务', { streamingBehavior: undefined });
    resolvePrompt();
  });

  it('routes late prompt rejections to the runtime error handler', async () => {
    const onError = vi.fn();
    const session = {
      prompt: vi.fn(() => Promise.reject(new Error('api rate limit'))),
    };

    await startPromptWithoutBlocking(session as any, '触发错误', undefined, onError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'api rate limit' }), 'prompt');
  });
});
