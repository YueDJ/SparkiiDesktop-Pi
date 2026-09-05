import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, resolveWorkflowTemplates, runWorkflow, workflowRuntimeTools } from '../electron/main/workflow.js';

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
      acquire: async () => ({
        client: {
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
        },
        supervisor: { onProposal: () => {} },
        getSessionId: () => sessionId,
      }),
      renameSession: vi.fn(),
      get: () => undefined,
      release,
    },
    chatSessions: { create: vi.fn(), update: vi.fn() },
    errors: { append: vi.fn((rec: unknown) => rec) },
  } as any;
  return { rt, getWindow, send, appends, release, sessionId, profileId };
}

it('uses the runtime session id for the workflow session record', async () => {
  const send = vi.fn();
  const getWindow = () => ({ webContents: { send } }) as any;
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
      acquire: async () => ({
        client: {
          send: async (cmd: any) => {
            if (cmd.type === 'new_session') return { success: true };
            if (cmd.type === 'get_state') {
              return { success: true, data: { sessionId: 'pi-workflow-1', sessionFile: 'C:/pi/sessions/pi-workflow-1.jsonl' } };
            }
            return { success: true };
          },
        },
        supervisor: { onProposal: () => {} },
      }),
      renameSession: vi.fn(),
      get: () => undefined,
      release: async () => {},
    },
    chatSessions: {
      create: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const broker = createBroker(rt, getWindow);
  const id = await runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');

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
  await runWorkflow(rt, getWindow, {
    documents: [],
    workspacePath: 'C:/ws/contract',
    model: 'deepseek/deepseek-v4-pro',
  }, broker, 'contract-review');
  expect(rt.chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
    id: sessionId,
    workspacePath: 'C:/ws/contract',
    workspaceKind: 'user',
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
  it('completes the human step when the shared broker decides approval', async () => {
    const send = vi.fn();
    const getWindow = () => ({ webContents: { send } }) as any;
    const acquiredSaddles: any[] = [];
    const appends: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const release = vi.fn(async (_sessionId: string) => {});
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
          return {
            client: {
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
            },
            supervisor: { onProposal: () => {} },
          };
        },
        renameSession: vi.fn(),
        get: (_sessionId: string) => undefined,
        release,
      },
      chatSessions: {
        create: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
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
    expect(acquiredSaddles[0]?.workspaceRoot).toBeUndefined();

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
        acquire: async () => ({
          client: {
            send: async (cmd: any) => {
              if (cmd.type === 'new_session') return { success: true };
              if (cmd.type === 'get_state') {
                return { success: true, data: { sessionId: 'wf-session', sessionFile: 'C:/wf/session.jsonl' } };
              }
              return { success: true };
            },
          },
          supervisor: { onProposal: () => {} },
        }),
        renameSession: vi.fn(),
        get: () => undefined,
        release: async () => {},
      },
      chatSessions: {
        create: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    await runWorkflow(rt, getWindow, {}, broker, 'general');

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
    const started = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
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
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
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
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
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
      getSessionId: () => sessionId,
    });

    const broker = createBroker(rt, getWindow);
    await runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review', { logger });
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
      getSessionId: () => sessionId,
    });

    const broker = createBroker(rt, getWindow);
    await runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await waitUntil(() => send.mock.calls.some((c) => c[0] === 'sparkii:event:approval'));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await waitUntil(() => release.mock.calls.length > 0);

    expect(appends.filter((a) => a.customType === 'workflow_step_start').map((a) => a.data.stepId)).toEqual(['review']);
    expect(errorRows).toHaveLength(1);
  });

  it('does not swallow start/end append failures with empty catch', async () => {
    const src = await readFile(join(__dirname, '../electron/main/workflow.ts'), 'utf8');
    expect(src).not.toMatch(/catch\(\(\) => \{\}\)/);
    expect(src).not.toMatch(/acc \+=/);
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
    rt.pool.acquire = async () => ({ client, supervisor: { onProposal: () => {} } });
    rt.keyFor = async () => null;
    const broker = createBroker(rt, getWindow);
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
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
