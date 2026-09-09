import { describe, it, expect, vi } from 'vitest';
import { executeKnowledgeSearch } from '../electron/main/rag-search.js';

const datasets = [{ id: 'law', name: '法规' }, { id: 'hr', name: '制度' }];

describe('executeKnowledgeSearch', () => {
  it('ignores model-supplied datasetId and uses default', async () => {
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law']);
      return { chunks: [{ id: 'c', content: 'x', documentId: 'd', documentName: 'f', datasetId: 'law', similarity: 1 }], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q', datasetId: 'hack' },
      profileId: 'any',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      defaultDatasetId: 'law',
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to bm25 when sparkiirag is selected', async () => {
    const bm25 = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' }, profileId: 'a', sessionId: 's',
      backend: 'sparkiirag', picker: 'session', selection: null, configured: false,
      listDatasets: async () => [],
      retrieve: async () => { throw new Error('no'); },
      bm25,
    });
    expect(out.ok).toBe(false);
    expect(bm25).not.toHaveBeenCalled();
  });

  it('uses bm25 only when backend is bm25', async () => {
    const retrieve = vi.fn();
    const bm25 = vi.fn(async () => [{ id: 'chunk-0', text: 'hit', score: 1 }]);
    const out = await executeKnowledgeSearch({
      args: { query: 'q', dataset_ids: ['hack'] },
      profileId: 'a',
      sessionId: 's',
      backend: 'bm25',
      picker: 'hidden',
      selection: null,
      configured: false,
      listDatasets: async () => datasets,
      retrieve,
      bm25,
    });
    expect(out.ok).toBe(true);
    expect(bm25).toHaveBeenCalledWith('q', 6);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('replaces a stale default with the first listed dataset and persists it', async () => {
    const persistDefault = vi.fn(async () => {});
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law']);
      return { chunks: [], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      defaultDatasetId: 'gone',
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
      persistDefault,
    });
    expect(out.ok).toBe(true);
    expect(persistDefault).toHaveBeenCalledWith('law');
  });

  it('denies a session selection that is not in the current list', async () => {
    const retrieve = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'session',
      selection: { mode: 'ids', datasetIds: ['gone'] },
      configured: true,
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('CONNECTOR_DENIED');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('uses every listed dataset when session selection is all', async () => {
    const retrieve = vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['law', 'hr']);
      return { chunks: [], documents: [] };
    });
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'session',
      selection: { mode: 'all' },
      configured: true,
      listDatasets: async () => datasets,
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('denies when the key can list no datasets', async () => {
    const retrieve = vi.fn();
    const out = await executeKnowledgeSearch({
      args: { query: 'q' },
      profileId: 'a',
      sessionId: 's',
      backend: 'sparkiirag',
      picker: 'hidden',
      selection: null,
      configured: true,
      listDatasets: async () => [],
      retrieve,
      bm25: async () => { throw new Error('no bm25'); },
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/建库/);
    expect(retrieve).not.toHaveBeenCalled();
  });
});
