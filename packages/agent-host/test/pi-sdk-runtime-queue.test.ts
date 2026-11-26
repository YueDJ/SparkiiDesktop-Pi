import { describe, it, expect, vi } from 'vitest';
import { clearSessionQueue, currentPromptOriginToken, readQueueSnapshot, runWithPromptOrigin, startPromptWithoutBlocking } from '../src/pi-sdk-runtime.js';

describe('pi-sdk-runtime queue adapters', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }

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

  it('R8 B1 keeps overlapping SDK prompt origins isolated across awaits and queued follow-up work', async () => {
    const releaseA = deferred();
    const releaseB = deferred();
    const observed: string[] = [];
    const run = (origin: string, gate: Promise<void>) => runWithPromptOrigin(origin, async () => {
      await Promise.resolve();
      observed.push(`${origin}:${currentPromptOriginToken()}`);
      await gate;
      await Promise.resolve();
      observed.push(`${origin}:${currentPromptOriginToken()}`);
    });
    const a = run('origin-A', releaseA.promise);
    const b = run('origin-B', releaseB.promise);
    await Promise.resolve();
    releaseB.resolve();
    await b;
    releaseA.resolve();
    await a;
    expect(observed).toEqual(['origin-A:origin-A', 'origin-B:origin-B', 'origin-B:origin-B', 'origin-A:origin-A']);
    expect(currentPromptOriginToken()).toBeUndefined();
  });

  it('R8 round7 B2 marks a deterministic pre-run rejection as a correlated terminal prompt error', async () => {
    const onError = vi.fn();
    const session = {
      prompt: vi.fn(() => Promise.reject(new Error('No model selected'))),
    };

    await startPromptWithoutBlocking(session as any, 'A', { promptId: 'prompt-a' } as any, onError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'No model selected',
      command: 'prompt',
      promptId: 'prompt-a',
      terminal: true,
    }), 'prompt');
  });

  it('R8 round7 B2 keeps a started prompt rejection correlated to its own terminal signal', async () => {
    const onError = vi.fn();
    const session = {
      prompt: vi.fn((_text: string, options: any) => {
        options?.preflightResult?.('started');
        return Promise.reject(new Error('prepare rejected'));
      }),
    };

    await startPromptWithoutBlocking(session as any, 'A', { promptId: 'prompt-a' } as any, onError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'prepare rejected',
      promptId: 'prompt-a',
      terminal: true,
    }), 'prompt');
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
