import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, resolveWorkflowTemplates, runTool, runWorkflow, workflowRuntimeTools } from '../electron/main/workflow.js';
import { TaskGrantRegistry } from '@sparkii/approval';
import { TaskLifecycle, type TaskAdmissionToken } from '../electron/main/security/task-lifecycle.js';

const TEST_DOCUMENTS = mkdtempSync(join(tmpdir(), 'wf-docs-'));

function runWf(
  rt: Parameters<typeof runWorkflow>[0],
  getWindow: Parameters<typeof runWorkflow>[1],
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
  profileId: string,
  opts?: Parameters<typeof runWorkflow>[5],
) {
  return runWorkflow(rt, getWindow, input, broker, profileId, opts, TEST_DOCUMENTS);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeHarness(opts: {
  steps: Array<Record<string, unknown>>;
  sessionId?: string;
  timeoutMs?: number;
  profileId?: string;
}) {
  const send = vi.fn();
  const getWindow = () => ({ webContents: { send } }) as any;
  const appends: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const release = vi.fn(async () => {});
  let client: any;
  const sessionId = opts.sessionId ?? 'wf-session';
  const profileId = opts.profileId ?? 'contract-review';
  const rt = {
    dataDir: mkdtempSync(join(tmpdir(), 'wf-harness-')),
    profileOf: () => ({
      dir: join(rt.dataDir, 'profiles', profileId),
      profile: {
        manifest: { name: profileId, displayName: profileId === 'contract-review' ? '合同审核' : profileId },
        security: { approval: { timeoutMs: opts.timeoutMs ?? 50 } },
        agent: {
          tools: ['read'],
          prompts: { system: `你是 ${profileId}。` },
          workflow: { version: 1, engine: 'linear', steps: opts.steps },
        },
      },
    }),
    agentOf: () => ({
      id: profileId,
      tools: ['read'],
      dir: join(rt.dataDir, 'profiles', profileId),
      skillsDir: join(rt.dataDir, 'profiles', profileId, 'agent', 'skills'),
      systemPrompt: `你是 ${profileId}。`,
    }),
    subject: { userId: 'admin' },
    gate: {
      submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
      expire: async (id: string) => ({ id, status: 'expired' }),
    },
    pool: {
      acquire: async () => {
        client = {
          send: async (cmd: any) => {
            if (cmd.type === 'new_session') return { success: true };
            if (cmd.type === 'get_state') {
              return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
            }
            if (cmd.type === 'append_workflow_entry') {
              appends.push({ customType: cmd.customType, data: cmd.data });
            }
            return { success: true };
          },
        };
        return {
          client,
          supervisor: { onProposal: () => {} },
          lease: 1,
          getSessionId: () => sessionId,
        };
      },
      renameSession: vi.fn(),
      get: () => client,
      getBinding: () => ({ client, lease: 1 }),
      release,
    },
    chatSessions: { create: vi.fn(), update: vi.fn() },
    errors: { append: vi.fn((rec: unknown) => rec) },
  } as any;
  return { rt, getWindow, send, appends, release, sessionId, profileId };
}

it.each(['task-a', 'task-b'])('R8 review runtime B6 keeps the original workflow admission when Task becomes %s', async (replacementTaskId) => {
  const { rt, getWindow, send, release, appends, sessionId, profileId } = makeHarness({
    steps: [
      { id: 'first', type: 'human', inputs: { from: 'x' } },
      { id: 'second', type: 'human', inputs: { from: 'first' } },
    ],
    timeoutMs: 60_000,
  });
  const registry = new TaskGrantRegistry();
  const lifecycle = new TaskLifecycle(registry);
  rt.security = { taskLifecycle: lifecycle };
  const submitted: any[] = [];
  rt.gate.submit = async (request: any, meta: any) => {
    submitted.push({ ...request, ...meta });
    return { id: `p-${submitted.length}`, ...request, ...meta, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
  };
  const grant = (taskId: string) => ({
    taskId, sessionId, agentId: profileId, profileId, actorId: 'admin', unattended: false,
    planMode: 'execute', permissionMode: 'ask', workspaceRoot: rt.dataDir, workspaceIdentity: rt.dataDir,
    inputRoots: [], scratchRoot: rt.dataDir, networkDomains: [], externalCapabilities: [],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  }) as any;
  let originalAdmission: TaskAdmissionToken | undefined;
  const beforeRelease = vi.fn(async (_sessionId: string, _lease: number, admission?: TaskAdmissionToken) => {
    expect(admission).toBe(originalAdmission);
  });
  const broker = createBroker(rt, getWindow);
  const running = runWf(rt, getWindow, { documents: [] }, broker, profileId, {
    async onReady() {
      await lifecycle.start(async () => grant('task-a'), (token) => { originalAdmission = token; }, undefined, sessionId);
      return originalAdmission;
    },
    beforeRelease,
  });
  await waitUntil(() => submitted.length === 1);
  const replacement = lifecycle.start(async () => grant(replacementTaskId), undefined, undefined, sessionId)
    .then(() => ({ status: 'fulfilled' as const }), (error: unknown) => ({ status: 'rejected' as const, error }));
  const replacementOutcome = await replacement;
  broker.decide('p-1', { approved: true, status: 'approved', result: undefined });
  if (replacementTaskId === 'task-a') {
    await waitUntil(() => submitted.length === 2);
    broker.decide('p-2', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => appends.filter((entry) => entry.customType === 'workflow_step_end').length === 2);
  } else {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await running;

  expect(submitted).toHaveLength(replacementTaskId === 'task-a' ? 2 : 1);
  expect(submitted.every((proposal) => proposal.taskId === 'task-a')).toBe(true);
  expect(send.mock.calls.filter((call) => call[0] === 'sparkii:event:approval')).toHaveLength(submitted.length);
  if (replacementTaskId === 'task-a') {
    expect(replacementOutcome.status).toBe('rejected');
    expect(lifecycle.active(sessionId)?.taskId).toBe('task-a');
    expect(beforeRelease).toHaveBeenCalledWith(sessionId, expect.any(Number), originalAdmission);
    expect(release).toHaveBeenCalledWith(sessionId, 1);
  } else {
    expect(replacementOutcome.status).toBe('fulfilled');
    expect(lifecycle.active(sessionId)?.taskId).toBe('task-b');
    // A no longer owns either the admission or the cleanup side effect. The
    // replacement's binding must remain intact rather than being released by A.
    expect(beforeRelease).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(rt.pool.getBinding(sessionId)).toEqual({ client: expect.anything(), lease: 1 });
  }
});

it('R8 round5 r1 rejects workflow proposals when no admission can be proven', async () => {
  const { rt, getWindow, sessionId, profileId } = makeHarness({
    steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }],
    timeoutMs: 1000,
  });
  let proposalHandler: ((request: any) => Promise<any>) | undefined;
  const acquire = rt.pool.acquire;
  rt.pool.acquire = async (...args: any[]) => {
    const slot = await acquire(...args);
    slot.supervisor.onProposal = (handler: (request: any) => Promise<any>) => { proposalHandler = handler; };
    return slot;
  };
  const submit = vi.fn(rt.gate.submit);
  rt.gate.submit = submit;
  const broker = createBroker(rt, getWindow);
  const running = runWf(rt, getWindow, { documents: [] }, broker, profileId, {
    async onReady() { return undefined; },
  });
  const outcome = running.then(() => undefined, (error: unknown) => error);
  try {
    await waitUntil(() => submit.mock.calls.length === 1 && proposalHandler !== undefined);
    await expect(proposalHandler!({
      requestId: 'unowned-proposal', toolName: 'memory_forget', targetSystem: 'memory',
      summary: 'forget', payload: {}, risk: 'high-risk', executionMode: 'caller',
    })).rejects.toThrow(/admission is not ready/i);
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    broker.decide('p1', { approved: false, status: 'denied' });
    await outcome;
  }
});

it('R8 round5 blocker2 does not release a lease replaced while beforeRelease awaits', async () => {
  const { rt, getWindow, release, sessionId, profileId } = makeHarness({ steps: [], timeoutMs: 1000 });
  const lifecycle = new TaskLifecycle(new TaskGrantRegistry());
  rt.security = { taskLifecycle: lifecycle };
  const grant = (taskId: string) => ({
    taskId, sessionId, agentId: profileId, profileId, actorId: 'admin', unattended: false,
    planMode: 'execute', permissionMode: 'ask', workspaceRoot: rt.dataDir, workspaceIdentity: rt.dataDir,
    inputRoots: [], scratchRoot: rt.dataDir, networkDomains: [], externalCapabilities: [],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  }) as any;
  let originalAdmission: TaskAdmissionToken | undefined;
  let cleanupDone = false;
  const beforeRelease = vi.fn(async (_sessionId: string, _lease: number, admission?: TaskAdmissionToken) => {
    expect(admission).toBe(originalAdmission);
    try {
      await lifecycle.start(async () => grant('replacement-task'), undefined, undefined, sessionId);
    } finally {
      cleanupDone = true;
    }
  });
  const running = runWf(rt, getWindow, { documents: [] }, createBroker(rt, getWindow), profileId, {
    async onReady() {
      await lifecycle.start(async () => grant('original-task'), (token) => { originalAdmission = token; }, undefined, sessionId);
      return originalAdmission;
    },
    beforeRelease,
  });
  await running;
  await waitUntil(() => cleanupDone);

  expect(beforeRelease).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(lifecycle.active(sessionId)?.taskId).toBe('replacement-task');
  expect(rt.pool.getBinding(sessionId)).toEqual({ client: expect.anything(), lease: 1 });
});

it('R8 round5 blocker2 does not fall back to a replacement when onReady fails before returning an admission', async () => {
  const { rt, getWindow, release, sessionId, profileId } = makeHarness({ steps: [], timeoutMs: 1000 });
  const lifecycle = new TaskLifecycle(new TaskGrantRegistry());
  rt.security = { taskLifecycle: lifecycle };
  const grant = {
    taskId: 'replacement-task', sessionId, agentId: profileId, profileId, actorId: 'admin', unattended: false,
    planMode: 'execute', permissionMode: 'ask', workspaceRoot: rt.dataDir, workspaceIdentity: rt.dataDir,
    inputRoots: [], scratchRoot: rt.dataDir, networkDomains: [], externalCapabilities: [],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  } as any;
  const beforeRelease = vi.fn(async () => {});
  const running = runWf(rt, getWindow, { documents: [] }, createBroker(rt, getWindow), profileId, {
    async onReady() {
      await lifecycle.start(async () => grant, undefined, undefined, sessionId);
      throw new Error('onReady failed after replacement');
    },
    beforeRelease,
  });

  await expect(running).rejects.toThrow('onReady failed after replacement');
  expect(beforeRelease).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(lifecycle.active(sessionId)?.taskId).toBe('replacement-task');
  expect(rt.pool.getBinding(sessionId)).toEqual({ client: expect.anything(), lease: 1 });
});

it('R8 round5 r2 cleans its own binding after onReady fails without an admission or replacement', async () => {
  const { rt, getWindow, release, sessionId, profileId } = makeHarness({ steps: [], timeoutMs: 1000 });
  const lifecycle = new TaskLifecycle(new TaskGrantRegistry());
  rt.security = { taskLifecycle: lifecycle };
  const end = vi.spyOn(lifecycle, 'end');
  const beforeRelease = vi.fn(async () => true);
  const running = runWf(rt, getWindow, { documents: [] }, createBroker(rt, getWindow), profileId, {
    async onReady() { throw new Error('onReady failed before admission'); },
    beforeRelease,
  });

  await expect(running).rejects.toThrow('onReady failed before admission');
  expect(beforeRelease).toHaveBeenCalledWith(sessionId, 1, undefined);
  expect(end).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledWith(sessionId, 1);
  expect(lifecycle.currentAdmission(sessionId)).toBeUndefined();
});

it('settles a caller waiter as denied when privacy redaction invalidates its proposal', async () => {
  const { rt, getWindow } = makeHarness({ steps: [], timeoutMs: 1000 });
  const proposals = new Map<string, any>();
  let invalidate: ((proposal: any) => void) | undefined;
  rt.gate = {
    submit: async (req: any) => {
      const proposal = { id: 'privacy-p1', ...req, status: 'pending', createdAt: Date.now() };
      proposals.set(proposal.id, proposal);
      return proposal;
    },
    expire: async (id: string) => proposals.get(id),
    get: (id: string) => proposals.get(id),
    onProposalInvalidated: (listener: (proposal: any) => void) => { invalidate = listener; return () => {}; },
  };
  const broker = createBroker(rt, getWindow);
  const pending = broker.request({
    requestId: 'privacy-request', toolName: 'memory_forget', targetSystem: 'memory',
    summary: 'forget', payload: {}, risk: 'high-risk', executionMode: 'caller',
  }, { sessionId: 'wf-session', profileId: 'contract-review' });
  await waitUntil(() => invalidate !== undefined);
  const proposal = proposals.get('privacy-p1');
  proposal.status = 'approved';
  proposal.privacyRedacted = true;
  invalidate!(proposal);

  await expect(pending).resolves.toEqual({ approved: false, proposalId: 'privacy-p1', status: 'denied' });
});

it('canonicalizes a stale approved broker completion against privacy-redacted gate state', async () => {
  const { rt, getWindow, send } = makeHarness({ steps: [], timeoutMs: 1000 });
  const proposal: any = { id: 'privacy-p2', status: 'approved', privacyRedacted: true };
  rt.gate = {
    submit: async (req: any) => ({ ...proposal, ...req, status: 'pending', createdAt: Date.now() }),
    expire: async () => proposal,
    get: () => proposal,
  };
  const broker = createBroker(rt, getWindow);
  const pending = broker.request({
    requestId: 'privacy-request-2', toolName: 'memory_forget', targetSystem: 'memory',
    summary: 'forget', payload: {}, risk: 'high-risk', executionMode: 'caller',
  }, { sessionId: 'wf-session', profileId: 'contract-review' });
  await waitUntil(() => send.mock.calls.length > 0);
  broker.decide('privacy-p2', { approved: true, status: 'approved' });

  await expect(pending).resolves.toEqual({ approved: false, proposalId: 'privacy-p2', status: 'denied' });
});

it('acquires the workflow slot with the agent display name, not the session id', async () => {
  const { rt, getWindow } = makeHarness({ steps: [] });
  const acquire = rt.pool.acquire;
  const metas: unknown[] = [];
  rt.pool.acquire = async (key: string, opts?: { meta?: unknown }) => {
    metas.push(opts?.meta);
    return acquire(key, opts);
  };
  const broker = createBroker(rt, getWindow);
  await runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
  expect(metas[0]).toEqual({
    profileId: 'contract-review',
    profileName: '合同审核',
    label: '新会话',
  });
});

it('uses the runtime session id for the workflow session record', async () => {
  const send = vi.fn();
  const getWindow = () => ({ webContents: { send } }) as any;
  let client: any;
  const rt = {
    dataDir: mkdtempSync(join(tmpdir(), 'wf-identity-')),
    profileOf: () => ({
      profile: {
        manifest: { name: 'contract-review' },
        security: { approval: { timeoutMs: 50 } },
        agent: {
          tools: ['read'],
          prompts: { system: 'sys' },
          workflow: { version: 1, engine: 'linear', steps: [] },
        },
      },
    }),
    agentOf: () => ({
      id: 'contract-review',
      tools: ['read'],
      dir: 'C:/x',
      skillsDir: 'C:/x/skills',
      systemPrompt: 'sys',
    }),
    subject: { userId: 'admin' },
    gate: {
      submit: async () => ({ id: 'p1', status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
      expire: async (id: string) => ({ id, status: 'expired' }),
    },
    pool: {
      acquire: async () => {
        client = {
          send: async (cmd: any) => {
            if (cmd.type === 'new_session') return { success: true };
            if (cmd.type === 'get_state') {
              return { success: true, data: { sessionId: 'pi-workflow-1', sessionFile: 'C:/pi/sessions/pi-workflow-1.jsonl' } };
            }
            return { success: true };
          },
        };
        return { client, supervisor: { onProposal: () => {} } };
      },
      renameSession: vi.fn(),
      get: () => client,
      getBinding: () => ({ client, lease: 1 }),
      release: async () => {},
    },
    chatSessions: {
      create: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const broker = createBroker(rt, getWindow);
  const id = await runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');

  expect(id).toBe('pi-workflow-1');
  expect(rt.pool.renameSession).toHaveBeenCalledWith(expect.stringContaining('new:'), 'pi-workflow-1');
  expect(rt.chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
    id: 'pi-workflow-1',
    profileId: 'contract-review',
    piSessionFile: 'C:/pi/sessions/pi-workflow-1.jsonl',
  }));
});

it('keeps only workflow tool-step tools plus read on the runtime saddle', () => {
  expect(workflowRuntimeTools(
    ['document.read', 'knowledge.search', 'report.export', 'read'],
    {
      version: 1,
      engine: 'linear',
      steps: [
        { id: 'load', type: 'tool', ref: 'document.read' },
        { id: 'search', type: 'tool', ref: 'knowledge.search' },
        { id: 'review', type: 'skill', ref: 'contract_risk_review' },
      ],
    } as any,
  )).toEqual(['document.read', 'knowledge.search', 'read']);
});

it('persists the caller workspace and model on the workflow session', async () => {
  const { rt, getWindow, sessionId } = makeHarness({ steps: [] });
  const acquire = rt.pool.acquire;
  const saddles: unknown[] = [];
  rt.pool.acquire = async (key: string, opts?: { saddle?: unknown }) => {
    saddles.push(opts?.saddle);
    return acquire(key, opts);
  };
  const broker = createBroker(rt, getWindow);
  await runWf(rt, getWindow, {
    documents: [],
    workspacePath: 'C:/ws/contract',
    model: 'deepseek/deepseek-v4-pro',
  }, broker, 'contract-review');
  expect(rt.chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
    id: sessionId,
    workspacePath: 'C:/ws/contract',
    workspaceKind: 'auto',
    model: 'deepseek/deepseek-v4-pro',
  }));
  expect(saddles[0]).toMatchObject({
    workspaceRoot: 'C:/ws/contract',
    model: { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
  });
});

it('resolves skill ref and llm template to prompt content', () => {
  const def = {
    version: 1, engine: 'linear',
    steps: [
      { id: 'extract', type: 'skill', ref: 'clause_extract', inputs: { from: 'load' } },
      { id: 'report', type: 'llm', template: 'report', inputs: { from: ['extract', 'compare'] } },
    ],
  } as any;
  const resolved = resolveWorkflowTemplates(def);
  const extract = resolved.steps.find((s) => s.id === 'extract');
  const report = resolved.steps.find((s) => s.id === 'report');
  expect(extract?.template).toBe('/skill:clause_extract');
  expect(extract?.template).not.toContain('\n');
  expect(extract?.template).not.toContain('抽取条款');
  expect(report?.template).toBe('/skill:report');
});

it('resolves the two visible business skills plus hidden tools', () => {
  const def = {
    version: 1,
    engine: 'linear',
    steps: [
      { id: 'load', type: 'tool', ref: 'document.read', map: { documents: 'documents' } },
      { id: 'search', type: 'tool', ref: 'knowledge.search', map: { query: 'load.text' } },
      { id: 'review', type: 'skill', ref: 'contract_risk_review', inputs: { from: ['load', 'search'] } },
      { id: 'report', type: 'skill', ref: 'contract_report', inputs: { from: 'review' } },
    ],
  } as any;
  const resolved = resolveWorkflowTemplates(def);
  expect(resolved.steps.map((s) => s.id)).toEqual(['load', 'search', 'review', 'report']);
  expect(resolved.steps.find((s) => s.id === 'review')?.template).toContain('contract_risk_review');
  expect(resolved.steps.find((s) => s.id === 'report')?.template).toContain('contract_report');
});

describe('runWorkflow broker sharing', () => {
  it('rejects forged legacy coding proposals before they reach ApprovalGate', async () => {
    const { rt, getWindow } = makeHarness({ steps: [] });
    const submit = vi.fn(async () => {
      throw new Error('must not submit');
    });
    rt.gate.submit = submit;
    const broker = createBroker(rt, getWindow);
    const result = await broker.route({
      requestId: 'legacy-write',
      toolName: 'write',
      targetSystem: 'general',
      summary: 'forged',
      payload: { path: 'C:/ws/a.txt', content: 'x' },
      risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });
    expect(result).toMatchObject({
      approved: false,
      status: 'denied',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('completes the human step when the shared broker decides approval', async () => {
    const send = vi.fn();
    const getWindow = () => ({ webContents: { send } }) as any;
    const acquiredSaddles: any[] = [];
    const appends: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const release = vi.fn(async (_sessionId: string) => {});
    let client: any;
    const rt = {
      dataDir: mkdtempSync(join(tmpdir(), 'wf-')),
      profileOf: (_id: string) => ({
        dir: join(rt.dataDir, 'profiles', 'contract-review'),
        profile: {
          manifest: { name: 'contract-review' },
          security: { approval: { timeoutMs: 50 } },
          agent: {
            tools: ['document.read', 'knowledge.search', 'report.export', 'read'],
            prompts: { system: '你是 Sparkii Desktop 的合同审核智能体。' },
            workflow: { version: 1, engine: 'linear', steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }] },
          },
        },
      }),
      agentOf: () => ({
        id: 'contract-review',
        manifest: {
          id: 'contract-review',
          version: '1.0.0',
          surface: { type: 'workflow', entry: 'surface/index.tsx' },
          capabilities: { tools: ['document.read', 'knowledge.search', 'report.export', 'read'] },
        },
        tools: ['document.read', 'knowledge.search', 'report.export', 'read'],
        dir: join(rt.dataDir, 'profiles', 'contract-review'),
        skillsDir: join(rt.dataDir, 'profiles', 'contract-review', 'agent', 'skills'),
        systemPrompt: '你是 Sparkii Desktop 的合同审核智能体。',
      }),
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
      pool: {
        acquire: async (_sessionId: string, opts?: { saddle?: unknown }) => {
          acquiredSaddles.push(opts?.saddle);
          client = {
            send: async (cmd: any) => {
              if (cmd.type === 'new_session') return { success: true };
              if (cmd.type === 'get_state') {
                return { success: true, data: { sessionId: 'wf-session', sessionFile: 'C:/wf/session.jsonl' } };
              }
              if (cmd.type === 'append_workflow_entry') {
                appends.push({ customType: cmd.customType, data: cmd.data });
              }
              return { success: true };
            },
          };
          return {
            client,
            supervisor: { onProposal: () => {} },
          };
        },
        renameSession: vi.fn(),
        get: (_sessionId: string) => client,
        getBinding: () => ({ client, lease: 1 }),
        release,
      },
      chatSessions: {
        create: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));

    expect(acquiredSaddles).toHaveLength(1);
    expect(acquiredSaddles[0]).toMatchObject({
      tools: ['read'],
      systemPrompt: expect.stringContaining('合同审核智能体'),
    });
    expect(acquiredSaddles[0]?.skillsDir?.split(/[\\/]/).slice(-2).join('/')).toBe('agent/skills');
    const cwd: string = acquiredSaddles[0]?.cwd;
    expect(cwd.startsWith(join(rt.dataDir, 'sessions'))).toBe(true);
    expect(cwd).not.toBe(join(rt.dataDir, 'sessions'));
    expect(String(acquiredSaddles[0]?.workspaceRoot).replace(/\\/g, '/')).toMatch(
      /Sparkii\/workspaces\/contract-review\/[a-z]+-[a-z]+-[a-z2-9]{3}$/i,
    );

    expect(send).toHaveBeenCalledWith('sparkii:event:approval', expect.objectContaining({ id: 'p1' }));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => appends.some((a) => a.customType === 'workflow_step_end'));
    await running;

    expect(send.mock.calls.some((c) => c[0] === 'sparkii:event:workflow')).toBe(false);
    expect(send.mock.calls.some((c) => c[0] === 'sparkii:event:state' && (c[1] as { workflow?: unknown })?.workflow)).toBe(false);
    expect(release).toHaveBeenCalled();
  });

  it('runs the workflow for the requested profile instead of contract-review', async () => {
    const send = vi.fn();
    const getWindow = () => ({ webContents: { send } }) as any;
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-general-'));
    const profileOf = vi.fn((id: string) => ({
      dir: join(dataDir, 'profiles', id),
      profile: {
        manifest: { name: id },
        security: { approval: { timeoutMs: 50 } },
        agent: {
          tools: ['read'],
          prompts: { system: `你是 ${id}。` },
          workflow: { version: 1, engine: 'linear', steps: [] },
        },
      },
    }));
    let client: any;
    const rt = {
      dataDir,
      profileOf,
      agentOf: (id: string) => ({
        id,
        manifest: {
          id,
          version: '1.0.0',
          surface: { type: 'chat' },
          capabilities: { tools: ['read'] },
        },
        tools: ['read'],
        dir: join(dataDir, 'profiles', id),
        skillsDir: join(dataDir, 'profiles', id, 'agent', 'skills'),
        systemPrompt: `你是 ${id}。`,
      }),
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
      pool: {
        acquire: async () => {
          client = {
            send: async (cmd: any) => {
              if (cmd.type === 'new_session') return { success: true };
              if (cmd.type === 'get_state') {
                return { success: true, data: { sessionId: 'wf-session', sessionFile: 'C:/wf/session.jsonl' } };
              }
              return { success: true };
            },
          };
          return { client, supervisor: { onProposal: () => {} } };
        },
        renameSession: vi.fn(),
        get: () => client,
        getBinding: () => ({ client, lease: 1 }),
        release: async () => {},
      },
      chatSessions: {
        create: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    await runWf(rt, getWindow, {}, broker, 'general');

    expect(profileOf).toHaveBeenCalledWith('general');
  });
});

describe('runWorkflow session id and JSONL', () => {
  it('returns the session id before the runner finishes', async () => {
    const { rt, getWindow, send, release } = makeHarness({
      steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }],
      sessionId: 'pi-workflow-1',
      timeoutMs: 60_000,
    });
    const broker = createBroker(rt, getWindow);
    const started = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    const id = await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('runWorkflow did not return session id before the runner finished')), 1000);
      }),
    ]);

    expect(id).toBe('pi-workflow-1');
    expect(release).not.toHaveBeenCalled();
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => release.mock.calls.length > 0);
  });

  it('persists step output on workflow_step_end and does not write a report-named result blob', async () => {
    const { rt, getWindow, send, appends } = makeHarness({
      steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }],
    });
    const broker = createBroker(rt, getWindow);
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => appends.some((a) => a.customType === 'workflow_step_end'));
    await running;

    expect(appends.some((a) => a.customType === 'workflow_step_end' && (a.data as { output?: unknown }).output)).toBe(true);
    const end = appends.find((a) => a.customType === 'workflow_step_end');
    expect(end?.data).toMatchObject({
      stepId: 'review',
      status: 'completed',
      output: { proposalId: 'p1', status: 'approved' },
    });
    expect(typeof end?.data.finishedAt).toBe('string');
    expect(appends.some((a) => a.customType === 'workflow_state' && (a.data as { stepId?: string }).stepId === 'report')).toBe(false);
    expect(send.mock.calls.some((c) => c[0] === 'sparkii:event:workflow')).toBe(false);
  });

  it('persists workflow_step_end failed status when a step throws', async () => {
    const { rt, getWindow, appends, release } = makeHarness({
      steps: [{ id: 'load', type: 'tool', ref: 'not.a.tool' }],
    });
    const broker = createBroker(rt, getWindow);
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => appends.some((a) => a.customType === 'workflow_step_end'));
    await running;

    const end = appends.find((a) => a.customType === 'workflow_step_end');
    expect(end?.data).toMatchObject({
      stepId: 'load',
      status: 'failed',
      error: expect.objectContaining({ code: 'WORKFLOW_STEP_FAILED', message: expect.stringContaining('UNKNOWN_TOOL') }),
    });
    expect(typeof end?.data.finishedAt).toBe('string');
    expect(release).toHaveBeenCalled();
  });

  it('stops the workflow and reports when a step_end append fails', async () => {
    const { rt, getWindow, send, appends, release, sessionId } = makeHarness({
      steps: [
        { id: 'review', type: 'human', inputs: { from: 'x' } },
        { id: 'report', type: 'human', inputs: { from: 'review' } },
      ],
    });
    const logs: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];
    const logger = { log: vi.fn(async (entry: any) => { logs.push(entry); }) };
    const errorRows: Array<{ id: string; message: string; source: string; createdAt: number }> = [];
    rt.errors = { append: vi.fn((rec: any) => { errorRows.push(rec); return rec; }) };
    const client = {
      send: async (cmd: any) => {
        if (cmd.type === 'new_session') return { success: true };
        if (cmd.type === 'get_state') {
          return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
        }
        if (cmd.type === 'append_workflow_entry') {
          appends.push({ customType: cmd.customType, data: cmd.data });
          if (cmd.customType === 'workflow_step_end' && cmd.data?.status === 'completed') {
            return { success: false, error: 'disk full' };
          }
        }
        return { success: true };
      },
    };
    rt.pool.acquire = async () => ({
      client,
      supervisor: { onProposal: () => {} },
      lease: 1,
      getSessionId: () => sessionId,
    });
    rt.pool.get = () => client;
    rt.pool.getBinding = () => ({ client, lease: 1 });

    const broker = createBroker(rt, getWindow);
    await runWf(rt, getWindow, { documents: [] }, broker, 'contract-review', { logger });
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));
    broker.decide('p1', { approved: true, status: 'approved', result: { findings: ['第3条存在期限不对齐'] } });
    await waitUntil(() => release.mock.calls.length > 0);

    // 这一步没记下，就不能跑下一步
    expect(appends.filter((a) => a.customType === 'workflow_step_start').map((a) => a.data.stepId)).toEqual(['review']);

    const errLog = logs.find((l) => l.level === 'error');
    expect(errLog?.ctx).toMatchObject({ sessionId, stepId: 'review', customType: 'workflow_step_end' });
    expect(typeof errLog?.ctx?.outputBytes).toBe('number');
    expect(errLog?.ctx).not.toHaveProperty('output');
    expect(JSON.stringify(errLog)).not.toContain('期限不对齐');

    // 错误中心恰好一行，窗口那条带同一个 errorId
    expect(rt.errors.append).toHaveBeenCalledTimes(1);
    expect(errorRows[0].source).toBe('合同审核');
    const runtimeError = send.mock.calls.find(
      (c) => c[0] === 'sparkii:event:chat-event' && (c[1] as { type?: string })?.type === 'runtime_error',
    );
    expect(runtimeError?.[1]).toMatchObject({
      type: 'runtime_error',
      sessionId,
      errorId: errorRows[0].id,
      source: '合同审核',
    });

    // 补一条很小的 failed end：不带那份巨大 output
    const failedEnds = appends.filter((a) => a.customType === 'workflow_step_end' && a.data.status === 'failed');
    expect(failedEnds).toHaveLength(1);
    expect(failedEnds[0].data).not.toHaveProperty('output');
    expect(release).toHaveBeenCalled();
  });

  it('stops the workflow when even the small failed end cannot be appended', async () => {
    const { rt, getWindow, send, appends, release, sessionId } = makeHarness({
      steps: [
        { id: 'review', type: 'human', inputs: { from: 'x' } },
        { id: 'report', type: 'human', inputs: { from: 'review' } },
      ],
    });
    const errorRows: unknown[] = [];
    rt.errors = { append: vi.fn((rec: any) => { errorRows.push(rec); return rec; }) };
    const client = {
      send: async (cmd: any) => {
        if (cmd.type === 'new_session') return { success: true };
        if (cmd.type === 'get_state') {
          return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
        }
        if (cmd.type === 'append_workflow_entry') {
          appends.push({ customType: cmd.customType, data: cmd.data });
          if (cmd.customType === 'workflow_step_end') return { success: false, error: 'disk full' };
        }
        return { success: true };
      },
    };
    rt.pool.acquire = async () => ({
      client,
      supervisor: { onProposal: () => {} },
      lease: 1,
      getSessionId: () => sessionId,
    });
    rt.pool.get = () => client;
    rt.pool.getBinding = () => ({ client, lease: 1 });

    const broker = createBroker(rt, getWindow);
    await runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => release.mock.calls.length > 0);

    expect(appends.filter((a) => a.customType === 'workflow_step_start').map((a) => a.data.stepId)).toEqual(['review']);
    expect(errorRows).toHaveLength(1);
  });

  it('R8-P1-1 rejects a workflow whose original lease is replaced during new_session', async () => {
  const { rt, getWindow, sessionId } = makeHarness({ steps: [] });
  let binding: { client: unknown; lease: number } | undefined;
  const commands: string[] = [];
  const client = {
    send: async (command: any) => {
      commands.push(command.type);
      if (command.type === 'new_session') {
        binding = { client, lease: 2 };
        return { success: true };
      }
      if (command.type === 'get_state') return { success: true, data: { sessionId, sessionFile: null } };
      return { success: true };
    },
  };
  binding = { client, lease: 1 };
  rt.pool.get = () => binding?.client;
  rt.pool.getBinding = () => binding;
  rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
  const onReady = vi.fn();
  const broker = createBroker(rt, getWindow);

  await expect(runWf(rt, getWindow, { documents: [] }, broker, 'contract-review', { onReady })).rejects.toThrow('no longer bound');
  expect(commands).toEqual(['new_session']);
  expect(rt.pool.renameSession).not.toHaveBeenCalled();
  expect(rt.chatSessions.create).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();
});

it('R8-P1-1 does not send model commands to a stale lease after an awaited key lookup', async () => {
  const { rt, getWindow, sessionId } = makeHarness({ steps: [{ id: 'review', type: 'llm', template: '请审核' }] });
  let binding: { client: unknown; lease: number } | undefined;
  const commands: string[] = [];
  const client = {
    send: async (command: any) => {
      commands.push(command.type);
      if (command.type === 'new_session') return { success: true };
      if (command.type === 'get_state') return { success: true, data: { sessionId, sessionFile: null } };
      if (command.type === 'set_api_key') binding = { client, lease: 2 };
      return { success: true };
    },
  };
  binding = { client, lease: 1 };
  rt.pool.get = () => binding?.client;
  rt.pool.getBinding = () => binding;
  rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
  rt.chatSessions.get = () => ({ model: 'deepseek/deepseek-chat' });
  rt.keyFor = async () => 'sk-r8';
  const broker = createBroker(rt, getWindow);
  await runWf(rt, getWindow, { documents: [], model: 'deepseek/deepseek-chat' }, broker, 'contract-review');
  await waitUntil(() => commands.includes('set_api_key'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(commands).not.toContain('set_model');
  expect(commands).not.toContain('prompt');
  expect(binding).toMatchObject({ lease: 2 });
  expect(rt.pool.release).not.toHaveBeenCalled();
});

it.each(['set_model', 'set_thinking_level'] as const)(
  'R8-P1-1 stops before prompt when the original lease is replaced during %s',
  async (replacedCommand) => {
    const { rt, getWindow, sessionId } = makeHarness({ steps: [{ id: 'review', type: 'llm', template: '请审核' }] });
    let binding: { client: unknown; lease: number } | undefined;
    const commands: string[] = [];
    const client = {
      send: async (command: any) => {
        commands.push(command.type);
        if (command.type === 'new_session') return { success: true };
        if (command.type === 'get_state') return { success: true, data: { sessionId, sessionFile: null } };
        if (command.type === replacedCommand) binding = { client, lease: 2 };
        return { success: true };
      },
    };
    binding = { client, lease: 1 };
    rt.pool.get = () => binding?.client;
    rt.pool.getBinding = () => binding;
    rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
    rt.chatSessions.get = () => ({ model: 'deepseek/deepseek-chat', thinkingLevel: 'high' });
    rt.keyFor = async () => null;
    const broker = createBroker(rt, getWindow);
    await runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => commands.includes(replacedCommand));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(commands).toContain(replacedCommand);
    expect(commands).not.toContain('prompt');
    expect(binding).toMatchObject({ lease: 2 });
    expect(rt.pool.release).not.toHaveBeenCalled();
  },
);

it('R8-P1-1 does not start the next workflow step after an between-step rebind', async () => {
  const listeners = new Set<(event: unknown) => void>();
  const { rt, getWindow, appends, sessionId } = makeHarness({
    steps: [
      { id: 'first', type: 'llm', template: '第一步' },
      { id: 'second', type: 'llm', template: '第二步' },
    ],
  });
  let binding: { client: unknown; lease: number } | undefined;
  const prompts: string[] = [];
  const client = {
    send: async (command: any) => {
      if (command.type === 'new_session') return { success: true };
      if (command.type === 'get_state') return { success: true, data: { sessionId, sessionFile: null } };
      if (command.type === 'prompt') {
        prompts.push(command.message);
        queueMicrotask(() => {
          const message = { role: 'assistant', content: [{ type: 'text', text: command.message }] };
          for (const listener of listeners) listener({ type: 'message_end', message });
          for (const listener of listeners) listener({ type: 'agent_end' });
        });
      }
      if (command.type === 'append_workflow_entry') appends.push({ customType: command.customType, data: command.data });
      return { success: true };
    },
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  binding = { client, lease: 1 };
  rt.pool.get = () => binding?.client;
  rt.pool.getBinding = () => binding;
  rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
  rt.keyFor = async () => null;
  rt.chatSessions.update = (_id: string, patch: { currentStep?: string }) => {
    if (patch.currentStep === 'second') binding = { client, lease: 2 };
  };
  const broker = createBroker(rt, getWindow);
  const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
  await waitUntil(() => rt.pool.release.mock.calls.length > 0);
  await running;

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatch(/^\/skill:第一步(?:\s|$)/);
  expect(appends.filter((entry) => entry.customType === 'workflow_step_end').map((entry) => entry.data.stepId)).toEqual(['first']);
  expect(rt.pool.release).toHaveBeenLastCalledWith(sessionId, 1);
  expect(binding).toMatchObject({ lease: 2 });
});

it('R8-P1-1 denies a tool approval completed after the original lease is replaced', async () => {
  const { rt, getWindow, send, sessionId } = makeHarness({ steps: [] });
  let binding: { client: unknown; lease: number } | undefined = { client: {}, lease: 1 };
  rt.gate.submit = async (request: any) => ({
    id: 'approval-stale', ...request, status: 'pending', payloadHash: 'h', createdAt: Date.now(),
  });
  const broker = createBroker(rt, getWindow);
  const route = vi.spyOn(broker, 'route');
  const assertBinding = (): void => {
    if (binding?.lease !== 1) throw new Error('stale binding');
  };
  const pending = runTool(rt, broker, 'report.export', { title: '旧绑定报告', sections: [] }, sessionId, 'contract-review', assertBinding);
  await waitUntil(() => send.mock.calls.some((call) => call[0] === 'sparkii:event:approval'));
  binding = { client: {}, lease: 2 };
  broker.decide('approval-stale', { approved: true, status: 'approved', result: { path: 'must-not-return' } });

  await expect(pending).rejects.toThrow('stale binding');
  await expect(route.mock.results[0].value).resolves.toMatchObject({ approved: false, status: 'denied' });
  expect(binding).toMatchObject({ lease: 2 });
});

it('does not swallow start/end append failures with empty catch', async () => {
    const src = await readFile(join(__dirname, '../electron/main/workflow.ts'), 'utf8');
    expect(src).not.toMatch(/catch\(\(\) => \{\}\)/);
    expect(src).not.toMatch(/acc \+=/);
  });

  it('does not let a rebound session consume the previous workflow prompt', async () => {
    const listeners = new Set<(e: unknown) => void>();
    const { rt, getWindow, appends, release, sessionId } = makeHarness({
      steps: [{ id: 'review', type: 'llm', template: '请审核' }],
    });
    const client = {
      send: async (cmd: any) => {
        if (cmd.type === 'new_session') return { success: true };
        if (cmd.type === 'get_state') {
          return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
        }
        if (cmd.type === 'prompt') {
          rt.pool.get = () => ({ send: async () => ({ success: true }) });
          queueMicrotask(() => {
            const message = { role: 'assistant', content: [{ type: 'text', text: '属于新会话的输出' }] };
            for (const cb of listeners) cb({ type: 'message_end', message });
            for (const cb of listeners) cb({ type: 'agent_end' });
          });
          return { success: true };
        }
        if (cmd.type === 'append_workflow_entry') appends.push({ customType: cmd.customType, data: cmd.data });
        return { success: true };
      },
      onEvent: (cb: (e: unknown) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    let lease = 1;
    rt.pool.get = () => client;
    rt.pool.getBinding = () => ({ client: rt.pool.get(sessionId), lease });
    rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
    rt.keyFor = async () => null;
    const broker = createBroker(rt, getWindow);
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => release.mock.calls.length > 0);
    await running;

    expect(appends.some((a) => a.customType === 'workflow_step_end' && a.data.stepId === 'review')).toBe(false);
    expect(JSON.stringify(appends)).not.toContain('属于新会话的输出');
  });

  it('does not let a same-client same-id rebinding consume the previous workflow prompt', async () => {
    const listeners = new Set<(e: unknown) => void>();
    const { rt, getWindow, appends, release, sessionId } = makeHarness({
      steps: [{ id: 'review', type: 'llm', template: '请审核' }],
    });
    let binding: { client: unknown; lease: number } | undefined;
    const client = {
      send: async (cmd: any) => {
        if (cmd.type === 'new_session') return { success: true };
        if (cmd.type === 'get_state') {
          return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
        }
        if (cmd.type === 'prompt') {
          // Release and reacquire the same id on the same reused facade. Identity
          // comparison alone still succeeds; only the per-binding lease changes.
          binding = undefined;
          binding = { client, lease: 2 };
          queueMicrotask(() => {
            const message = { role: 'assistant', content: [{ type: 'text', text: 'NEW-BINDING-OUTPUT' }] };
            for (const cb of listeners) cb({ type: 'message_end', message });
            for (const cb of listeners) cb({ type: 'agent_end' });
          });
          return { success: true };
        }
        if (cmd.type === 'append_workflow_entry') appends.push({ customType: cmd.customType, data: cmd.data });
        return { success: true };
      },
      onEvent: (cb: (e: unknown) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    binding = { client, lease: 1 };
    rt.pool.get = () => binding?.client;
    rt.pool.getBinding = () => binding;
    rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
    rt.keyFor = async () => null;
    const broker = createBroker(rt, getWindow);
    const beforeRelease = vi.fn(async () => {});
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review', { beforeRelease });
    await waitUntil(() => release.mock.calls.length > 0);
    await running;

    expect(appends.some((a) => a.customType === 'workflow_step_end' && a.data.stepId === 'review')).toBe(false);
    expect(JSON.stringify(appends)).not.toContain('NEW-BINDING-OUTPUT');
    expect(beforeRelease).not.toHaveBeenCalled();
    expect(rt.pool.release).toHaveBeenLastCalledWith(sessionId, 1);
    expect(binding).toMatchObject({ lease: 2 });
  });

  it('stores full assistant text from message_update/message_end in step output', async () => {
    const listeners = new Set<(e: unknown) => void>();
    const { rt, getWindow, appends, sessionId } = makeHarness({
      steps: [{ id: 'review', type: 'llm', template: '请审核' }],
    });
    const client = {
      send: async (cmd: any) => {
        if (cmd.type === 'new_session') return { success: true };
        if (cmd.type === 'get_state') {
          return { success: true, data: { sessionId, sessionFile: 'C:/wf/session.jsonl' } };
        }
        if (cmd.type === 'prompt') {
          queueMicrotask(() => {
            const message = { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] };
            for (const cb of listeners) cb({ type: 'message_start', message: { role: 'assistant', content: [] } });
            for (const cb of listeners) cb({ type: 'message_update', message });
            for (const cb of listeners) cb({ type: 'message_end', message });
            for (const cb of listeners) cb({ type: 'agent_end' });
          });
          return { success: true };
        }
        if (cmd.type === 'append_workflow_entry') {
          appends.push({ customType: cmd.customType, data: cmd.data });
        }
        return { success: true };
      },
      onEvent: (cb: (e: unknown) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    rt.pool.get = () => client;
    rt.pool.getBinding = () => ({ client, lease: 1 });
    rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} }, lease: 1, getSessionId: () => sessionId });
    rt.keyFor = async () => null;
    const broker = createBroker(rt, getWindow);
    const running = runWf(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => appends.some((a) => a.customType === 'workflow_step_end' && a.data.stepId === 'review'));
    await running;
    const end = appends.find((a) => a.customType === 'workflow_step_end' && a.data.stepId === 'review');
    expect(end?.data).toMatchObject({
      stepId: 'review',
      status: 'completed',
      output: '第3条存在期限不对齐',
    });
    expect(sessionId).toBeTruthy();
  });
});

describe('broker presentation contract', () => {
  it('does not revive proposal-first edit/write semantics from Runtime requests', async () => {
    const { rt, getWindow } = makeHarness({ steps: [] });
    const submitted: any[] = [];
    rt.gate.submit = async (req: any) => {
      submitted.push(req);
      return { id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
    };
    const broker = createBroker(rt, getWindow);
    const file = join(rt.dataDir, 'a.txt');
    await writeFile(file, 'old\n');

    const first = await broker.route({
      requestId: 'r1',
      toolName: 'edit',
      targetSystem: 'general',
      summary: '修改 a.txt',
      payload: { path: file, content: 'new\n' },
      risk: 'write',
    }, { sessionId: 's1', profileId: 'contract-review' });
    expect(first).toMatchObject({ approved: false, status: 'denied' });

    const second = await broker.route({
      requestId: 'r2',
      toolName: 'write',
      targetSystem: 'general',
      summary: '写入 a.txt',
      preview: { kind: 'diff', lines: ['custom'] },
      payload: { path: file, content: 'other\n' },
      risk: 'write',
    }, { sessionId: 's1', profileId: 'contract-review' });
    expect(second).toMatchObject({ approved: false, status: 'denied' });
    expect(submitted).toEqual([]);
  });

  it('does not scan payload.diff to invent preview for other tools', async () => {
    const { rt, getWindow } = makeHarness({ steps: [] });
    const submitted: any[] = [];
    rt.gate.submit = async (req: any) => {
      submitted.push(req);
      return { id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
    };
    const broker = createBroker(rt, getWindow);
    const pending = broker.route({
      requestId: 'r3',
      toolName: 'report.export',
      targetSystem: 'report',
      summary: '导出报告',
      payload: { title: 'x', diff: '--- a\n+foo', sections: [{ heading: '摘要' }] },
      risk: 'write',
    }, { sessionId: 's1', profileId: 'contract-review' });
    await waitUntil(() => submitted.length === 1);
    expect(submitted[0].preview).toBeUndefined();
    broker.decide('p1', { approved: false, status: 'denied' });
    await pending;
  });
});

describe('broker approval timeout vs long-running execution', () => {
  function gateHarness(timeoutMs: number, getWindow: () => any = () => null) {
    const proposals = new Map<string, any>();
    const gate = {
      submit: async (req: any) => {
        const p = { id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() };
        proposals.set(p.id, p);
        return p;
      },
      decide: async (id: string, _by: unknown, approved: boolean) => {
        const p = proposals.get(id);
        if (!p) return p;
        const out = { ...p, status: approved ? 'approved' : 'denied' };
        proposals.set(id, out);
        return out;
      },
      // 与真实 gate.expire 语义一致：仅 pending 且到期才转 expired，否则原样返回当前提案
      expire: async (id: string) => {
        const p = proposals.get(id);
        if (!p || p.status !== 'pending') return p;
        const out = { ...p, status: 'expired' };
        proposals.set(id, out);
        return out;
      },
      proposals,
    };
    const rt = {
      subject: { userId: 'admin' },
      profileOf: () => ({ profile: { security: { approval: { timeoutMs } } } }),
      gate,
    } as any;
    return { rt, gate, broker: createBroker(rt, getWindow) };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('does not resolve an approved write as 操作未执行:approved when the timeout elapses mid-execution', async () => {
    const timeoutMs = 30;
    const { rt, gate, broker } = gateHarness(timeoutMs);

    const decision = broker.request({
      requestId: 'r1', toolName: 'bash', targetSystem: 'general', summary: 'docker compose pull',
      payload: { command: 'wsl.exe -d Ubuntu-26.04 -- bash -c "docker compose pull"' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });

    // 用户立刻点了「批准」，Main 开始执行；但命令耗时长于审批超时，期间提案保持 approved
    await gate.decide('p1', rt.subject, true);

    const before = await Promise.race([
      decision.then((d) => ({ tag: 'resolved' as const, d })),
      sleep(timeoutMs + 40).then(() => ({ tag: 'pending' as const })),
    ]);
    // 修复前：超时回调会抢先 resolve 成 {approved:false, status:'approved'}（对应「操作未执行:approved」）
    expect(before.tag).toBe('pending');

    // 执行完成后 decideApproval 才调 broker.decide 回真实结果
    broker.decide('p1', { approved: true, status: 'executed', result: { exitCode: 0, output: 'ok' } });
    await expect(decision).resolves.toEqual({
      approved: true, proposalId: 'p1', status: 'executed', result: { exitCode: 0, output: 'ok' },
    });
  });

  it('still resolves an untouched pending proposal as expired after the timeout', async () => {
    const { broker } = gateHarness(30);

    const decision = broker.request({
      requestId: 'r2', toolName: 'bash', targetSystem: 'general', summary: 'long sleep',
      payload: { command: 'sleep 1' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });

    await expect(decision).resolves.toEqual({ approved: false, proposalId: 'p1', status: 'expired' });
  });

  it('pushes the expired proposal to the renderer only when truly expired', async () => {
    const sent: unknown[] = [];
    const { broker } = gateHarness(30, () => ({ webContents: { send: (_c: string, p: unknown) => sent.push(p) } }));

    const decision = broker.request({
      requestId: 'r3', toolName: 'bash', targetSystem: 'general', summary: 'sleep',
      payload: { command: 'sleep 1' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });

    await expect(decision).resolves.toEqual({ approved: false, proposalId: 'p1', status: 'expired' });
    expect(sent.filter((s: any) => s.status === 'expired')).toHaveLength(1);
    expect((sent.find((s: any) => s.status === 'expired') as any).id).toBe('p1');
  });

  it('does not push expired while an approved write is still executing', async () => {
    const timeoutMs = 30;
    const sent: unknown[] = [];
    const { rt, gate, broker } = gateHarness(timeoutMs, () => ({ webContents: { send: (_c: string, p: unknown) => sent.push(p) } }));

    const decision = broker.request({
      requestId: 'r4', toolName: 'bash', targetSystem: 'general', summary: 'pull',
      payload: { command: 'docker compose pull' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });

    await gate.decide('p1', rt.subject, true);
    await sleep(timeoutMs + 40);
    expect(sent.filter((s: any) => s.status === 'expired')).toHaveLength(0);
    expect(sent.some((s: any) => s.status === 'pending')).toBe(true);

    broker.decide('p1', { approved: true, status: 'executed', result: { exitCode: 0 } });
    await expect(decision).resolves.toEqual({ approved: true, proposalId: 'p1', status: 'executed', result: { exitCode: 0 } });
  });

  it('carries the approval scope back to the awaiting action router', async () => {
    const { broker } = gateHarness(30_000);

    const decision = broker.request({
      requestId: 'r5', toolName: 'bash', targetSystem: 'platform:process.exec', summary: 'pnpm test',
      payload: { command: 'pnpm test' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });

    // request() registers its resolver only after the gate submit resolves.
    await sleep(5);
    broker.decide('p1', { approved: true, status: 'approved', approvalScope: 'task' });
    await expect(decision).resolves.toEqual({
      approved: true, proposalId: 'p1', status: 'approved', approvalScope: 'task',
    });

    const scoped = broker.request({
      requestId: 'r6', toolName: 'bash', targetSystem: 'platform:process.exec', summary: 'pnpm lint',
      payload: { command: 'pnpm lint' }, risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });
    await sleep(5);
    broker.decide('p1', { approved: true, status: 'approved' });
    await expect(scoped).resolves.toEqual({ approved: true, proposalId: 'p1', status: 'approved' });
  });

  it('cancels pending broker waits for one session', async () => {
    const { broker } = gateHarness(30_000);
    const pending = broker.request({
      requestId: 'r7',
      toolName: 'bash',
      targetSystem: 'platform:process.exec',
      summary: 'pnpm test',
      payload: { command: 'pnpm test' },
      risk: 'write',
    }, { sessionId: 's1', profileId: 'general' });
    await sleep(5);
    broker.cancelSession('s1', 'task-revoked');
    await expect(pending).resolves.toMatchObject({
      approved: false,
      status: 'denied',
    });
  });
});
