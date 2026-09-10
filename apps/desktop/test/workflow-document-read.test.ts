import { describe, expect, it, vi } from 'vitest';
import { executeDocumentRead } from '../electron/main/document-read.js';
import { runTool } from '../electron/main/workflow.js';

vi.mock('../electron/main/document-read.js', () => ({
  executeDocumentRead: vi.fn(async () => ({ ok: true, data: { text: 'x', engine: 'native' } })),
}));

describe('workflow document.read', () => {
  it('routes runTool document.read to executeDocumentRead', async () => {
    const rt = {
      profileOf: () => ({ profile: { manifest: { name: 'contract-review', displayName: '合同审核' } } }),
      subject: { userId: 'tester' },
    };
    const out = await runTool(
      rt as any,
      {} as any,
      'document.read',
      { documents: ['/tmp/a.docx'] },
      's1',
      'contract-review',
    );
    expect(executeDocumentRead).toHaveBeenCalledWith(
      { documents: ['/tmp/a.docx'] },
      expect.objectContaining({
        profileId: 'contract-review',
        sessionId: 's1',
        actor: 'tester',
        agentDisplayName: '合同审核',
      }),
    );
    expect(out).toEqual({ ok: true, data: { text: 'x', engine: 'native' } });
  });
});
