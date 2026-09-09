import { describe, it, expect, vi } from 'vitest';
import { knowledgeConnector } from '@sparkii/connectors';
import { buildPiRuntimeTools } from '../src/pi-runtime-tools.js';

describe('main-hosted knowledge.search', () => {
  it('does not call the local BM25 handler', async () => {
    const connectorRead = vi.fn(async () => ({ ok: true, data: { chunks: [] } }));
    const search = knowledgeConnector.tools.find((t) => t.name === 'knowledge.search')!;
    const spy = vi.spyOn(search, 'handler');
    const [tool] = buildPiRuntimeTools({
      tools: [search],
      propose: async () => ({ approved: false, proposalId: 'x', status: 'denied' }),
      connectorRead,
    });
    const out = await tool.execute('c1', { query: '高温' });
    expect(spy).not.toHaveBeenCalled();
    expect(connectorRead).toHaveBeenCalledWith({
      requestId: 'c1',
      toolName: 'knowledge.search',
      args: { query: '高温' },
    });
    expect(JSON.parse(out.content[0].text)).toMatchObject({ ok: true });
  });

  it('denies main-hosted tools when connectorRead is missing', async () => {
    const search = knowledgeConnector.tools.find((t) => t.name === 'knowledge.search')!;
    const spy = vi.spyOn(search, 'handler');
    const [tool] = buildPiRuntimeTools({
      tools: [search],
      propose: async () => ({ approved: false, proposalId: 'x', status: 'denied' }),
    });
    const out = await tool.execute('c1', { query: '高温' });
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toMatchObject({
      ok: false,
      error: { code: 'CONNECTOR_DENIED' },
    });
  });
});
