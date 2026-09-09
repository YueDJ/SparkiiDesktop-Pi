import { describe, it, expect } from 'vitest';
import { ragFromSettings, DEFAULT_RAG_BASE_URL } from '../electron/main/rag-settings.js';

describe('ragFromSettings', () => {
  it('fills defaults when rag is missing', () => {
    expect(ragFromSettings({})).toEqual({
      baseUrl: DEFAULT_RAG_BASE_URL,
      similarityThreshold: 0.2,
      vectorSimilarityWeight: 0.3,
      bindings: [],
    });
  });

  it('does not copy apiKey from the stored rag block', () => {
    const out = ragFromSettings({
      rag: {
        baseUrl: 'http://rag.example',
        similarityThreshold: 0.4,
        vectorSimilarityWeight: 0.5,
        bindings: [{ agentId: 'a', defaultDatasetId: 'ds' }],
        apiKey: 'should-not-leak',
      } as never,
    });
    expect(out).toEqual({
      baseUrl: 'http://rag.example',
      similarityThreshold: 0.4,
      vectorSimilarityWeight: 0.5,
      bindings: [{ agentId: 'a', defaultDatasetId: 'ds' }],
    });
    expect(out).not.toHaveProperty('apiKey');
  });
});
