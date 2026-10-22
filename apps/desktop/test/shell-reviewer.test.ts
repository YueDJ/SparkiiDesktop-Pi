import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellReviewInput } from '@sparkii/approval';
import { createPiShellReviewer } from '../electron/main/security/shell-reviewer.js';
import {
  REVIEWER_LOG_EVENTS,
  SHELL_REVIEWER_POLICY_VERSION,
  SHELL_REVIEWER_SYSTEM_PROMPT,
  redactReviewerCommand,
} from '../electron/main/security/reviewer-policy.js';

afterEach(() => {
  vi.useRealTimers();
});

function input(patch: Partial<ShellReviewInput> = {}): ShellReviewInput {
  return {
    taskId: 't1',
    sessionId: 's1',
    actionId: 'a1',
    userTask: '运行测试',
    toolName: 'bash',
    capability: 'process.exec',
    risk: 'write',
    command: 'pnpm test',
    cwd: 'C:/ws',
    workspaceRoot: 'C:/ws',
    targets: [],
    recentEvidence: [],
    hardDenyPolicyVersion: 'hard-deny-v1',
    payloadHash: 'h',
    unattended: false,
    ...patch,
  };
}

function fakeClient(options: {
  replies?: Array<{ success: boolean; data?: string; error?: string }>;
  sendImpl?: (command: unknown) => Promise<{ success: boolean; data?: string }>;
} = {}) {
  const replies = options.replies ?? [
    { success: true, data: '{"decision":"allow","risk":"low","reason":"普通测试命令"}' },
  ];
  const calls: unknown[] = [];
  const stop = vi.fn(async () => {});
  const completeSend = options.sendImpl ?? (async () => {
    const reply = replies.shift()
      ?? { success: true, data: '{"decision":"allow","risk":"low","reason":"ok"}' };
    return reply;
  });
  const send = vi.fn(async (command: unknown) => {
    if ((command as { type?: string }).type !== 'complete') return { success: true };
    calls.push(command);
    return completeSend(command);
  });
  return { calls, stop, makeClient: vi.fn(async () => ({ send, stop })), send };
}

async function waitForComplete(client: ReturnType<typeof fakeClient>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (client.send.mock.calls.some(([command]) =>
      (command as { type?: string }).type === 'complete')) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('reviewer never issued a complete request');
}

function reviewerFor(
  client: ReturnType<typeof fakeClient>,
  opts: { timeoutMs?: number; idleMs?: number; keyFor?: (p: string) => Promise<string | null> } = {},
) {
  const logs: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
  const reviewer = createPiShellReviewer({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    timeoutMs: opts.timeoutMs ?? 1_000,
    idleMs: opts.idleMs ?? 300_000,
    keyFor: opts.keyFor ?? (async () => 'test-key'),
    logger: { log: async (entry) => { logs.push(entry as never); } },
    makeClient: client.makeClient,
  });
  return { reviewer, logs };
}

describe('redactReviewerCommand', () => {
  it('redacts obvious command secrets before debug logging', () => {
    expect(redactReviewerCommand('API_KEY=secret npm test')).not.toContain('secret');
    expect(redactReviewerCommand('curl -H "Authorization: Bearer abc.def" x'))
      .not.toContain('abc.def');
    expect(redactReviewerCommand('MYSQL_PASSWORD=hunter2 mysql'))
      .not.toContain('hunter2');
    expect(redactReviewerCommand('pnpm test')).toBe('pnpm test');
  });
});

describe('reviewer policy', () => {
  it('is a fixed, injection-aware prompt with no execution rights', () => {
    expect(SHELL_REVIEWER_POLICY_VERSION).toBe('shell-review-v1');
    expect(SHELL_REVIEWER_SYSTEM_PROMPT).toContain('Return one JSON object');
    expect(SHELL_REVIEWER_SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(SHELL_REVIEWER_SYSTEM_PROMPT).toMatch(/inject/i);
    expect(SHELL_REVIEWER_SYSTEM_PROMPT).toMatch(/allow/i);
    expect(SHELL_REVIEWER_SYSTEM_PROMPT).toMatch(/deny/i);
    expect(Object.values(REVIEWER_LOG_EVENTS)).toContain('reviewer.worker.started');
  });
});

describe('createPiShellReviewer', () => {
  it('lazy-starts one worker, reuses it, and sends a fresh single-turn request', async () => {
    const client = fakeClient({
      replies: [
        { success: true, data: '{"decision":"allow","risk":"low","reason":"普通测试命令"}' },
        { success: true, data: '{"decision":"deny","risk":"critical","reason":"危险"}' },
      ],
    });
    const { reviewer, logs } = reviewerFor(client);

    await expect(reviewer.review(input())).resolves.toEqual({
      decision: 'allow',
      risk: 'low',
      reason: '普通测试命令',
    });
    expect(client.makeClient).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      msg: 'reviewer.worker.started',
    }));

    await expect(reviewer.review(input({ actionId: 'a2', command: 'pnpm lint' })))
      .resolves.toEqual({ decision: 'deny', risk: 'critical', reason: '危险' });
    // Process reuse must not become context reuse.
    expect(client.makeClient).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      msg: 'reviewer.worker.reused',
    }));

    const completes = client.calls.filter(
      (call) => (call as { type?: string }).type === 'complete',
    );
    expect(completes).toHaveLength(2);
    expect(client.calls.every(
      (call) => ['set_api_key', 'complete'].includes((call as { type?: string }).type ?? ''),
    )).toBe(true);
    const second = completes[1] as { text: string; system: string };
    expect(second.system).toContain('Return one JSON object');
    expect(second.text).toContain('pnpm lint');
    expect(second.text).not.toContain('pnpm test');
    await reviewer.dispose();
  });

  it('serializes concurrent reviews onto one worker', async () => {
    let active = 0;
    let peak = 0;
    const client = fakeClient({
      sendImpl: async (command) => {
        const isComplete = (command as { type?: string }).type === 'complete';
        if (isComplete) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((done) => setTimeout(done, 5));
          active -= 1;
        }
        return { success: true, data: '{"decision":"allow","risk":"low","reason":"ok"}' };
      },
    });
    const { reviewer } = reviewerFor(client, { timeoutMs: 5_000 });
    await Promise.all([
      reviewer.review(input({ actionId: 'a1' })),
      reviewer.review(input({ actionId: 'a2' })),
      reviewer.review(input({ actionId: 'a3' })),
    ]);
    expect(peak).toBe(1);
    await reviewer.dispose();
  });

  it('fails closed on an illegal reply instead of granting permission', async () => {
    for (const data of ['not json at all', '', '{"decision":"allow","risk":"high","reason":"x"}']) {
      const client = fakeClient({ replies: [{ success: true, data }] });
      const { reviewer, logs } = reviewerFor(client);
      await expect(reviewer.review(input())).rejects.toThrow();
      expect(logs).toContainEqual(expect.objectContaining({
        level: 'warn',
        msg: 'reviewer.request.failed',
      }));
      await reviewer.dispose();
    }
  });

  it('kills the worker after a timeout', async () => {
    const client = fakeClient({
      sendImpl: () => new Promise(() => {}),
    });
    const { reviewer, logs } = reviewerFor(client, { timeoutMs: 1 });
    await expect(reviewer.review(input())).rejects.toThrow(/timed out/);
    expect(client.stop).toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      msg: 'reviewer.worker.timeout',
    }));
    await reviewer.dispose();
  });

  it('includes slow worker startup in the review timeout', async () => {
    const reviewer = createPiShellReviewer({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      timeoutMs: 20,
      idleMs: 300_000,
      keyFor: async () => 'test-key',
      logger: { log: async () => {} },
      makeClient: () => new Promise(() => {}),
    });
    await expect(reviewer.review(input())).rejects.toThrow(/timed out/i);
    await reviewer.dispose();
  });

  it('cancels immediately while the worker is still starting', async () => {
    let started!: () => void;
    const makeStarted = new Promise<void>((resolve) => { started = resolve; });
    const reviewer = createPiShellReviewer({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      timeoutMs: 10_000,
      idleMs: 300_000,
      keyFor: async () => 'test-key',
      logger: { log: async () => {} },
      makeClient: () => {
        started();
        return new Promise(() => {});
      },
    });
    const pending = reviewer.review(input());
    await makeStarted;
    await reviewer.cancel('t1');
    await expect(Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('cancel waited for startup')), 100);
      }),
    ])).rejects.toThrow(/canceled/i);
    await reviewer.dispose();
  });

  it('stops the idle worker and logs at the expected levels', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const { reviewer, logs } = reviewerFor(client, { idleMs: 100 });
    await reviewer.review(input());
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      msg: 'reviewer.request.completed',
      ctx: expect.objectContaining({
        policyVersion: 'shell-review-v1',
        payloadHash: 'h',
        decision: 'allow',
        sessionId: 's1',
        taskId: 't1',
        actionId: 'a1',
      }),
    }));
    // Debug diagnostics must carry no credential material.
    const completed = logs.find((entry) => entry.msg === 'reviewer.request.completed');
    expect(JSON.stringify(completed?.ctx ?? {})).not.toMatch(/test-key|api-?key/);
    expect(client.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.stop).toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      msg: 'reviewer.worker.stopped',
    }));
    vi.useRealTimers();
  });

  it('cancels a queued review when its task is revoked', async () => {
    let release!: () => void;
    const client = fakeClient({
      sendImpl: (command) => {
        if ((command as { type?: string }).type === 'complete') {
          return new Promise<{ success: boolean; data: string }>((resolve) => {
            release = () => resolve({
              success: true,
              data: '{"decision":"allow","risk":"low","reason":"ok"}',
            });
          });
        }
        return Promise.resolve({ success: true });
      },
    });
    const { reviewer } = reviewerFor(client, { timeoutMs: 10_000 });
    const first = reviewer.review(input({ actionId: 'a1' }));
    const queued = reviewer.review(input({ actionId: 'a2', taskId: 't2' }));
    await waitForComplete(client);
    await reviewer.cancel('t2');
    release();
    await expect(first).resolves.toMatchObject({ decision: 'allow' });
    await expect(queued).rejects.toThrow(/canceled/i);
    await reviewer.dispose();
  });

  it('stops the worker when the in-flight task is revoked', async () => {
    let release!: () => void;
    const client = fakeClient({
      sendImpl: (command) => {
        if ((command as { type?: string }).type === 'complete') {
          return new Promise<{ success: boolean; data: string }>((resolve) => {
            release = () => resolve({
              success: true,
              data: '{"decision":"allow","risk":"low","reason":"太迟了"}',
            });
          });
        }
        return Promise.resolve({ success: true });
      },
    });
    const { reviewer } = reviewerFor(client, { timeoutMs: 10_000 });
    const first = reviewer.review(input({ actionId: 'a1' }));
    await waitForComplete(client);
    await reviewer.cancel('t1');
    release();
    // A verdict that arrives after the Task died must never reach the executor.
    await expect(first).rejects.toThrow(/canceled/i);
    expect(client.stop).toHaveBeenCalled();
    await reviewer.dispose();
  });

  it('logs an error and fails closed when no provider key exists', async () => {
    const client = fakeClient();
    const { reviewer, logs } = reviewerFor(client, { keyFor: async () => null });
    await expect(reviewer.review(input())).rejects.toThrow(/key/i);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error' }));
    expect(client.makeClient).not.toHaveBeenCalled();
    await reviewer.dispose();
  });

  it('logs an error when the worker cannot start', async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const reviewer = createPiShellReviewer({
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      timeoutMs: 1_000,
      idleMs: 300_000,
      keyFor: async () => 'test-key',
      logger: { log: async (entry) => { logs.push(entry as never); } },
      makeClient: async () => { throw new Error('runtime exited'); },
    });
    await expect(reviewer.review(input())).rejects.toThrow(/runtime exited/);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'reviewer.worker.start-failed',
    }));
    await reviewer.dispose();
  });
});
