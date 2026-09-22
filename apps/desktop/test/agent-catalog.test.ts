import { describe, it, expect } from 'vitest';
import { sortAgents } from '../electron/main/agent-catalog.js';

describe('sortAgents', () => {
  it('orders agents by sortOrder and falls back to displayName', () => {
    const out = sortAgents([
      { id: 'contract-review', name: 'contract-review', displayName: '合同审核智能体', sortOrder: 20 },
      { id: 'general', name: 'general', displayName: '通用智能体', sortOrder: 10 },
    ]);

    expect(out).toEqual([
      { id: 'general', name: '通用智能体', declaresOntologyTools: false },
      { id: 'contract-review', name: '合同审核智能体', declaresOntologyTools: false },
    ]);
  });

  it('keeps optional knowledge on listed agents', () => {
    const knowledge = { enabled: true, picker: 'session' as const, backend: 'sparkiirag' as const };
    const out = sortAgents([
      { id: 'knowledge-qa', name: 'knowledge-qa', displayName: '企业知识问答', sortOrder: 15, knowledge },
    ]);
    expect(out[0].knowledge).toEqual(knowledge);
  });

  it('puts unspecified sortOrder after explicit ones and sorts ties by id', () => {
    const out = sortAgents([
      { id: 'zeta', name: 'zeta' },
      { id: 'general', name: 'general', displayName: '通用智能体', sortOrder: 10 },
      { id: 'alpha', name: 'alpha' },
    ]);

    expect(out).toEqual([
      { id: 'general', name: '通用智能体', declaresOntologyTools: false },
      { id: 'alpha', name: 'alpha', declaresOntologyTools: false },
      { id: 'zeta', name: 'zeta', declaresOntologyTools: false },
    ]);
  });

  it('derives declaresOntologyTools from tool declarations', () => {
    const out = sortAgents([
      { id: 'contract-review', name: 'contract-review', capabilities: { tools: ['document.read', 'knowledge.search', 'report.export'] } },
      { id: 'procurement-review', name: 'procurement-review', capabilities: { tools: ['document.read', 'knowledge.search', 'report.export'] } },
      { id: 'knowledge-qa', name: 'knowledge-qa', capabilities: { tools: ['knowledge.search', 'knowledge.fetch_document'] } },
      { id: 'general', name: 'general', capabilities: { tools: ['read', 'ls', 'grep', 'find', 'bash', 'edit', 'write'] } },
      { id: 'onto-qa', name: 'onto-qa', capabilities: { tools: ['ontology.search_documents', 'ontology.search_nodes'] } },
    ]);
    for (const id of ['contract-review', 'procurement-review', 'knowledge-qa', 'general']) {
      expect(out.find((x) => x.id === id)?.declaresOntologyTools).toBe(false);
    }
    expect(out.find((x) => x.id === 'onto-qa')?.declaresOntologyTools).toBe(true);
  });
});
