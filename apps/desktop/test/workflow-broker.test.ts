import { describe, it, expect, vi } from 'vitest';
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
    const rt = {
      profile: {
        manifest: { name: 'contract-review' },
        security: { approval: { timeoutMs: 50 } },
        agent: { workflow: { version: 1, engine: 'linear', steps: [{ id: 'review', type: 'human', inputs: { from: 'x' } }] } },
      },
      subject: { userId: 'admin' },
      gate: {
        submit: async (req: any) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
        expire: async (id: string) => ({ id, status: 'expired' }),
      },
    } as any;

    const broker = createBroker(rt, getWindow);
    const running = runWorkflow(rt, getWindow, { documents: [] }, broker);
    await new Promise((r) => setTimeout(r, 0));

    expect(send).toHaveBeenCalledWith('sparkii:event:approval', expect.objectContaining({ id: 'p1' }));
    broker.decide('p1', { approved: true, status: 'approved', result: undefined });
    await running;

    expect(send).toHaveBeenCalledWith('sparkii:event:state', expect.objectContaining({
      workflow: { result: expect.objectContaining({ review: { proposalId: 'p1', status: 'approved' } }) },
    }));
  });
});
