import { describe, it, expect } from 'vitest';
import { knowledgeConnector } from '../src/knowledge/index.js';

describe('knowledge tools host', () => {
  it('declares search and fetch_document as main-hosted reads without datasetId param', () => {
    const names = knowledgeConnector.tools.map((t) => t.name);
    expect(names).toContain('knowledge.search');
    expect(names).toContain('knowledge.fetch_document');
    for (const t of knowledgeConnector.tools) {
      expect(t.host).toBe('main');
      expect(t.sideEffect).toBe('read');
    }
    const search = knowledgeConnector.tools.find((t) => t.name === 'knowledge.search')!;
    const props = (search.params as { properties: Record<string, unknown> }).properties;
    expect(props.datasetId).toBeUndefined();
    expect(props.query).toBeTruthy();
  });
});
