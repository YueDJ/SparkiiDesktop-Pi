import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TaskGrantRegistry,
  type PlatformProfilePolicy,
  type ReviewerDecision,
  type SecurityAction,
  type ShellReviewInput,
  type TaskGrant,
  type WorkspacePathProbe,
} from '@sparkii/approval';
import {
  DEFAULT_TOOL_DESCRIPTORS,
  createActionNormalizer,
} from '../electron/main/security/action-normalizer.js';
import { TaskLifecycle } from '../electron/main/security/task-lifecycle.js';
import { ShellGrantStore } from '../electron/main/security/shell-grant-store.js';
import { createRuntimeActionRouter } from '../electron/main/security/runtime-action-router.js';

function key(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const probe: WorkspacePathProbe = {
  inspect: async (target) => ({
    displayPath: target,
    canonicalPath: target,
    identity: `object:${key(target)}`,
    nearestExistingAncestor: target,
    isDirectory: true,
    isReparsePoint: false,
    exists: true,
  }),
  isSameOrDescendant: async (root, target) => {
    const r = key(root);
    const t = key(target);
    return t === r || t.startsWith(`${r}/`);
  },
  isSameObject: async (left, right) => key(left) === key(right),
};

function grant(patch: Partial<TaskGrant> = {}): TaskGrant {
  return {
    taskId: 't1',
    sessionId: 's1',
    agentId: 'general',
    profileId: 'general',
    actorId: 'u1',
    unattended: false,
    planMode: 'execute',
    permissionMode: 'ask',
    workspaceRoot: 'C:/ws',
    workspaceIdentity: 'object:c:/ws',
    inputRoots: [],
    scratchRoot: 'C:/scratch/t1',
    networkDomains: [],
    externalCapabilities: [],
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    ...patch,
  };
}

interface HarnessOptions {
  platformReady?: (action: SecurityAction) => boolean;
  profilePolicy?: Partial<PlatformProfilePolicy>;
  permissionMode?: 'ask' | 'auto_review';
  unattended?: boolean;
  taskId?: string;
  approval?: { choice: 'once' | 'task' | 'deny' };
  review?: ReviewerDecision | Error;
}

const allowReview: ReviewerDecision = { decision: 'allow', risk: 'low', reason: '普通测试命令' };

async function harness(options: HarnessOptions = {}) {
  const registry = new TaskGrantRegistry();
  const lifecycle = new TaskLifecycle(registry);
  const shellGrants = new ShellGrantStore();
  const baseGrant = grant({
    permissionMode: options.permissionMode ?? 'ask',
    unattended: options.unattended ?? false,
    taskId: options.taskId ?? 't1',
  });
  await lifecycle.start(async () => baseGrant);
  const auditEvents: Array<Record<string, unknown>> = [];
  const execute = vi.fn(async (_action: SecurityAction, _grant: TaskGrant) => ({
    result: { ok: true },
  }));
  const requestApproval = vi.fn(async () => ({ choice: options.approval?.choice ?? 'once' }));
  const review = vi.fn(async (_input: ShellReviewInput) => {
    if (options.review instanceof Error) throw options.review;
    return (options.review ?? allowReview) as ReviewerDecision;
  });
  const revalidate = vi.fn(async () => true);
  const userTasks = new Map<string, string>([['s1', '把测试跑通并整理报告']]);
  const router = createRuntimeActionRouter({
    lifecycle,
    normalizer: createActionNormalizer({
      descriptors: DEFAULT_TOOL_DESCRIPTORS,
      protectedRoots: [
        { path: 'C:/Users/me', policy: 'boundary' },
        { path: 'C:/Windows', policy: 'closure' },
      ],
      probe,
    }),
    profilePolicyOf: () => ({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
      ...options.profilePolicy,
    }),
    platformReady: options.platformReady ?? (() => true),
    execute,
    requestApproval,
    revalidate,
    shellGrants,
    reviewerModel: 'deepseek-v4-flash',
    reviewerPolicyVersion: 'shell-review-v1',
    userTaskOf: (sessionId) => userTasks.get(sessionId) ?? '',
    reviewShell: review,
    audit: {
      append: async (event) => {
        auditEvents.push(event as Record<string, unknown>);
      },
    },
  });
  const startTask = async (patch: Partial<TaskGrant> = {}) => {
    await lifecycle.end(baseGrant.sessionId, 'replaced');
    const next = grant({ ...baseGrant, ...patch });
    await lifecycle.start(async () => next);
    return next;
  };
  return {
    registry,
    lifecycle,
    router,
    execute,
    requestApproval,
    revalidate,
    review,
    shellGrants,
    auditEvents,
    startTask,
    userTasks,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const write = (args: Record<string, unknown>, toolName = 'write') => ({
  requestId: 'r1',
  toolCallId: 'call-1',
  toolName,
  args,
});

const bash = (requestId: string, command: string) => ({
  requestId,
  toolName: 'bash',
  args: { command },
});

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

describe('workspace CRUD passthrough', () => {
  it('executes an ordinary workspace write without requesting approval', async () => {
    const result = await h.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x', risk: 'read', summary: 'safe' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'workspace.crud' },
      result: { ok: true },
    });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.review).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'fs.write',
      approvalClass: 'auto',
      risk: 'write',
      resources: [expect.objectContaining({ scope: 'workspace' })],
    }), expect.objectContaining({ taskId: 't1' }));
    expect(h.auditEvents.map((event) => event.action)).toEqual([
      'action.allowed',
      'action.executed',
    ]);
  });

  it('executes delete and move inside the workspace with no proposal', async () => {
    for (const request of [
      write({ path: 'C:/ws/a.txt' }, 'delete'),
      { requestId: 'r2', toolName: 'move', args: { from: 'C:/ws/a.txt', to: 'C:/ws/b.txt' } },
    ]) {
      const result = await h.router.route(request, 's1');
      expect(result).toMatchObject({
        status: 'executed',
        decision: { decision: 'allow', ruleId: 'workspace.crud' },
      });
    }
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.auditEvents.some((event) => event.action === 'action.ask')).toBe(false);
  });

  it('passes workspace CRUD straight through in auto_review as well', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    const result = await auto.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({ status: 'executed', decision: { ruleId: 'workspace.crud' } });
    expect(auto.review).not.toHaveBeenCalled();
  });

  it('denies a structured write outside the workspace without asking', async () => {
    const result = await h.router.route(
      write({ path: 'C:/outside/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'workspace.write-outside' },
    });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('hard-denies critical targets before approval or execution', async () => {
    const result = await h.router.route(
      write({ path: 'C:/Windows/System32/drivers/etc/hosts', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'platform.critical-target' },
    });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('denies process execution when the platform is not ready', async () => {
    const notReady = await harness({
      platformReady: (action) => action.capability !== 'process.exec',
    });
    const result = await notReady.router.route(bash('bash-1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'platform.not-ready' },
    });
    expect(notReady.requestApproval).not.toHaveBeenCalled();
  });
});

describe('ask mode', () => {
  it('asks a human for shell and never starts the Reviewer', async () => {
    const ask = await harness({ profilePolicy: { autoApprove: ['process.exec'] } });
    const result = await ask.router.route(bash('bash-1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'user.approved' },
    });
    expect(ask.requestApproval).toHaveBeenCalledTimes(1);
    expect(ask.review).not.toHaveBeenCalled();
  });

  it('denies Ask mode shell when no human can approve', async () => {
    const ask = await harness({ unattended: true });
    const result = await ask.router.route(bash('bash-1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'HUMAN_APPROVAL_UNAVAILABLE' },
    });
    expect(ask.requestApproval).not.toHaveBeenCalled();
    expect(ask.review).not.toHaveBeenCalled();
  });

  it('asks a human for an external write', async () => {
    const result = await h.router.route(
      write({ path: 'C:/ws/report.docx' }, 'report.export'),
      's1',
    );
    expect(result).toMatchObject({ status: 'executed' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not execute when the user denies', async () => {
    const denied = await harness({ approval: { choice: 'deny' } });
    const result = await denied.router.route(bash('bash-1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'USER_DENIED' },
    });
    expect(denied.execute).not.toHaveBeenCalled();
  });

  it('grants ordinary shell for the rest of the task after a task-scoped approval', async () => {
    const task = await harness({ approval: { choice: 'task' } });
    await task.router.route(bash('bash-1', 'pnpm test'), 's1');
    expect(task.requestApproval).toHaveBeenCalledTimes(1);
    task.requestApproval.mockClear();
    const second = await task.router.route(bash('bash-2', 'pnpm lint'), 's1');
    expect(task.requestApproval).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'task-shell-grant' },
    });
    expect(task.execute).toHaveBeenCalledTimes(2);
  });

  it('still asks again for a high-risk command under a task grant', async () => {
    const task = await harness({ approval: { choice: 'task' } });
    await task.router.route(bash('bash-1', 'pnpm test'), 's1');
    task.requestApproval.mockClear();
    await task.router.route(bash('bash-2', 'git reset --hard'), 's1');
    expect(task.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('refuses a task scope for anything that is not ordinary shell', async () => {
    const task = await harness({ approval: { choice: 'task' } });
    const result = await task.router.route(
      write({ path: 'C:/ws/report.docx' }, 'report.export'),
      's1',
    );
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'INVALID_APPROVAL_SCOPE' },
    });
    expect(task.execute).not.toHaveBeenCalled();
  });

  it('drops the task grant for a new task', async () => {
    const task = await harness({ approval: { choice: 'task' } });
    await task.router.route(bash('bash-1', 'pnpm test'), 's1');
    task.requestApproval.mockClear();
    await task.startTask({ taskId: 't2' });
    await task.router.route(bash('bash-2', 'pnpm lint'), 's1');
    expect(task.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('rejects execution when the task is revoked while approval is pending', async () => {
    h.requestApproval.mockImplementationOnce(async () => {
      await h.lifecycle.end('s1', 'user');
      return { choice: 'once' };
    });
    const result = await h.router.route(
      write({ path: 'C:/ws/report.docx' }, 'report.export'),
      's1',
    );
    expect(result).toMatchObject({ status: 'denied', error: { code: 'TASK_REVOKED' } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('rejects execution when the target identity changes after approval', async () => {
    h.revalidate.mockResolvedValueOnce(false);
    const result = await h.router.route(
      write({ path: 'C:/ws/report.docx' }, 'report.export'),
      's1',
    );
    expect(result).toMatchObject({ status: 'denied', error: { code: 'TARGET_CHANGED' } });
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('auto_review mode', () => {
  it('uses the Reviewer for shell and still re-checks before executing', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    const result = await auto.router.route(bash('r1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'executed',
      decision: { decision: 'allow', ruleId: 'reviewer.allow' },
    });
    expect(auto.requestApproval).not.toHaveBeenCalled();
    expect(auto.review).toHaveBeenCalledTimes(1);
    expect(auto.revalidate).toHaveBeenCalledTimes(1);
    expect(auto.execute).toHaveBeenCalledTimes(1);
  });

  it('sends only the minimal review context', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    await auto.router.route(bash('r1', 'pnpm test'), 's1');
    const input = auto.review.mock.calls[0][0] as ShellReviewInput;
    expect(input).toMatchObject({
      taskId: 't1',
      sessionId: 's1',
      userTask: '把测试跑通并整理报告',
      toolName: 'bash',
      capability: 'process.exec',
      command: 'pnpm test',
      cwd: 'C:/ws',
      workspaceRoot: 'C:/ws',
      hardDenyPolicyVersion: 'hard-deny-v1',
      payloadHash: expect.any(String),
      unattended: false,
    });
    expect(Object.keys(input).sort()).toEqual([
      'actionId', 'capability', 'command', 'cwd', 'hardDenyPolicyVersion', 'payloadHash',
      'recentEvidence', 'risk', 'sessionId', 'targets', 'taskId', 'toolName', 'unattended',
      'userTask', 'workspaceRoot',
    ]);
    expect(JSON.stringify(input)).not.toMatch(/api-?key|authorization|secret/i);
  });

  it('carries at most four compact tool evidence entries', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    for (let index = 0; index < 6; index += 1) {
      await auto.router.route(bash(`r${index}`, `echo step-${index}`), 's1');
    }
    const last = auto.review.mock.calls.at(-1)![0] as ShellReviewInput;
    expect(last.recentEvidence).toHaveLength(4);
    expect(last.recentEvidence.every((entry) => entry.summary.length <= 256)).toBe(true);
  });

  it('escalates a reviewer ask to a high-risk human approval', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'ask', risk: 'high', reason: '上下文不足' },
    });
    const result = await auto.router.route(bash('r1', 'pnpm test'), 's1');
    expect(result).toMatchObject({ status: 'executed', decision: { ruleId: 'reviewer.ask-approved' } });
    expect(auto.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'bash' }),
      expect.objectContaining({ taskId: 't1' }),
      'high-risk',
    );
  });

  it('rejects task scope when Reviewer requested high-risk confirmation', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      approval: { choice: 'task' },
      review: { decision: 'ask', risk: 'high', reason: '上下文不足' },
    });
    const result = await auto.router.route(bash('r1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'INVALID_APPROVAL_SCOPE' },
    });
    expect(auto.execute).not.toHaveBeenCalled();
  });

  it('does not execute on a reviewer deny', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: '灾难目标' },
    });
    const result = await auto.router.route(bash('r1', 'pnpm test'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      decision: { decision: 'deny', ruleId: 'reviewer.deny' },
      error: { message: '灾难目标' },
    });
    expect(auto.execute).not.toHaveBeenCalled();
    expect(auto.auditEvents).toContainEqual(expect.objectContaining({
      action: 'reviewer.decision',
      decision: 'deny',
    }));
  });

  it('opens the circuit breaker after three consecutive denials', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: '持续拒绝' },
    });
    await auto.router.route(bash('r1', 'echo one'), 's1');
    await auto.router.route(bash('r2', 'echo two'), 's1');
    await auto.router.route(bash('r3', 'echo three'), 's1');
    expect(auto.lifecycle.active('s1')).toBeUndefined();
    expect(auto.auditEvents).toContainEqual(expect.objectContaining({
      action: 'reviewer.circuit-open',
    }));
  });

  it('resets the denial counter after one allow', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: 'no' },
    });
    await auto.router.route(bash('r1', 'echo one'), 's1');
    await auto.router.route(bash('r2', 'echo two'), 's1');
    auto.review.mockResolvedValueOnce(allowReview);
    await auto.router.route(bash('r3', 'echo three'), 's1');
    await auto.router.route(bash('r4', 'echo four'), 's1');
    expect(auto.lifecycle.active('s1')).toBeDefined();
  });

  it('refuses an identical denied action without asking the Reviewer again', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: '不允许' },
    });
    const request = bash('r1', 'pnpm test');
    await auto.router.route(request, 's1');
    const repeated = await auto.router.route({ ...request, requestId: 'r2' }, 's1');
    expect(auto.review).toHaveBeenCalledTimes(1);
    expect(repeated).toMatchObject({
      status: 'denied',
      decision: { ruleId: 'reviewer.replay-denied' },
    });
  });

  it('falls back to human approval when the Reviewer is unavailable', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: new Error('Reviewer timed out'),
    });
    const result = await auto.router.route(bash('r1', 'pnpm build'), 's1');
    expect(result.status).toBe('executed');
    expect(auto.requestApproval).toHaveBeenCalledTimes(1);
    expect(auto.auditEvents).toContainEqual(expect.objectContaining({
      action: 'reviewer.fallback',
      decision: 'ask',
    }));
  });

  it('denies an unattended task when the Reviewer is unavailable', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      unattended: true,
      review: new Error('Reviewer provider API key is missing'),
    });
    const result = await auto.router.route(bash('r1', 'pnpm build'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      error: { message: 'Reviewer unavailable for unattended task' },
    });
    expect(auto.requestApproval).not.toHaveBeenCalled();
  });

  it('denies an unattended Reviewer ask instead of opening human approval', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      unattended: true,
      review: { decision: 'ask', risk: 'high', reason: '需要人工判断' },
    });
    const result = await auto.router.route(bash('r1', 'pnpm build'), 's1');
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'HUMAN_APPROVAL_UNAVAILABLE' },
    });
    expect(auto.requestApproval).not.toHaveBeenCalled();
  });

  it('does not fall back to approval when the Reviewer is canceled by Task revoke', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    let rejectReview!: (error: Error) => void;
    auto.review.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectReview = reject;
    }));
    const routing = auto.router.route(bash('r1', 'pnpm test'), 's1');
    await new Promise((done) => setTimeout(done, 0));
    await auto.lifecycle.end('s1', 'user');
    rejectReview(new Error('Reviewer canceled'));
    const result = await routing;
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'TASK_REVOKED' },
    });
    expect(auto.requestApproval).not.toHaveBeenCalled();
  });

  it('never sends an external write or a remote push to the Reviewer', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    await auto.router.route(
      write({ path: 'C:/ws/report.docx' }, 'report.export'),
      's1',
    );
    await auto.router.route(bash('p1', 'git push origin main'), 's1');
    expect(auto.review).not.toHaveBeenCalled();
    expect(auto.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('records the policy version and timing in the audit summary', async () => {
    const auto = await harness({ permissionMode: 'auto_review' });
    await auto.router.route(bash('r1', 'pnpm test'), 's1');
    const decision = auto.auditEvents.find((event) => event.action === 'reviewer.decision');
    expect(decision).toMatchObject({
      actor: 'reviewer:deepseek-v4-flash',
      payloadHash: expect.any(String),
      ruleId: 'reviewer.allow',
    });
    const summary = JSON.parse(String(decision!.payloadSummary));
    expect(summary).toMatchObject({
      policyVersion: 'shell-review-v1',
      risk: 'low',
      reason: '普通测试命令',
      fallback: false,
    });
    expect(typeof summary.durationMs).toBe('number');
  });

  it('keeps denials and evidence inside one task only', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: 'no' },
    });
    await auto.router.route(bash('r1', 'pnpm test'), 's1');
    await auto.startTask({ taskId: 't2' });
    auto.review.mockResolvedValue(allowReview);
    const result = await auto.router.route(bash('r2', 'pnpm test'), 's1');
    expect(result).toMatchObject({ status: 'executed', decision: { ruleId: 'reviewer.allow' } });
    const input = auto.review.mock.calls.at(-1)![0] as ShellReviewInput;
    expect(input.taskId).toBe('t2');
    expect(input.recentEvidence).toEqual([]);
  });

  it('clears task state when the task is revoked', async () => {
    const auto = await harness({
      permissionMode: 'auto_review',
      review: { decision: 'deny', risk: 'critical', reason: 'no' },
    });
    const request = bash('r1', 'pnpm test');
    await auto.router.route(request, 's1');
    const replay = await auto.router.route({ ...request, requestId: 'r2' }, 's1');
    expect(auto.review).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({ decision: { ruleId: 'reviewer.replay-denied' } });
    auto.router.clearTask('t1');
    auto.review.mockResolvedValue(allowReview);
    const result = await auto.router.route({ ...request, requestId: 'r3' }, 's1');
    expect(auto.review).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'executed', decision: { ruleId: 'reviewer.allow' } });
  });
});

describe('execution plane', () => {
  it('returns a failed result when the execution plane throws', async () => {
    h.execute.mockRejectedValueOnce(new Error('disk unavailable'));
    const result = await h.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'ACTION_EXECUTION_FAILED', message: 'disk unavailable' },
    });
  });

  it('denies when the runtime action belongs to no live task', async () => {
    await h.lifecycle.end('s1', 'user');
    const result = await h.router.route(
      write({ path: 'C:/ws/a.txt', content: 'x' }),
      's1',
    );
    expect(result).toMatchObject({ status: 'denied', error: { code: 'TASK_REVOKED' } });
  });
});
