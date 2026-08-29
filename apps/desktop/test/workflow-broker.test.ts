import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker, resolveWorkflowTemplates, runWorkflow } from '../electron/main/workflow.js';

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
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
      pool: {
        acquire: async (_sessionId: string, opts?: { saddle?: unknown }) => {
          acquiredSaddles.push(opts?.saddle);
          return { client: {}, supervisor: { onProposal: () => {} } };
        },
        get: (_sessionId: string) => undefined,
        release: async (_sessionId: string) => {},
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
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
      pool: {
        acquire: async () => ({ client: {}, supervisor: { onProposal: () => {} } }),
        get: () => undefined,
        release: async () => {},
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    await runWorkflow(rt, getWindow, {}, broker, 'general');

    expect(profileOf).toHaveBeenCalledWith('general');
  });
});
