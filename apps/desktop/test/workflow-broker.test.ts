import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, resolveWorkflowTemplates, runWorkflow } from '../electron/main/workflow.js';

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
  expect(extract?.template).toContain('clause_extract');
  expect(extract?.template).not.toContain('抽取条款');
  expect(report?.template).toContain('report');
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
                return { success: true };
              },
            },
            supervisor: { onProposal: () => {} },
          };
        },
        renameSession: vi.fn(),
        get: (_sessionId: string) => undefined,
        release: async (_sessionId: string) => {},
      },
      chatSessions: {
        create: vi.fn(),
        update: vi.fn(),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');
    await new Promise((r) => setTimeout(r, 0));

    expect(acquiredSaddles).toHaveLength(1);
    expect(acquiredSaddles[0]).toMatchObject({
      tools: ['document.read', 'knowledge.search', 'report.export', 'read'],
      systemPrompt: expect.stringContaining('合同审核智能体'),
    });
    expect(acquiredSaddles[0]?.skillsDir?.split(/[\\/]/).slice(-2).join('/')).toBe('agent/skills');
    const cwd: string = acquiredSaddles[0]?.cwd;
    expect(cwd.startsWith(join(rt.dataDir, 'sessions'))).toBe(true);
    expect(cwd).not.toBe(join(rt.dataDir, 'sessions'));
    expect(acquiredSaddles[0]?.workspaceRoot).toBeUndefined();

    expect(send).toHaveBeenCalledWith('sparkii:event:approval', expect.objectContaining({ id: 'p1' }));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await running;

    expect(send).toHaveBeenCalledWith('sparkii:event:state', expect.objectContaining({
      workflow: { result: expect.objectContaining({ review: { proposalId: 'p1', status: 'approved' } }) },
    }));
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
