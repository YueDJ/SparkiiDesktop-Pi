import { describe, it, expect } from 'vitest';
import {
  RAG_REFUSE_TEXT,
  isVisibleAssistantEnd,
  knowledgeTurnPayload,
  markSearchResult,
  resetTurn,
  shouldAbortGeneration,
} from '../electron/main/rag-grounding.js';

describe('rag grounding', () => {
  it('empty chunks mark miss and refuse payload has no documents', () => {
    let turn = resetTurn();
    turn = markSearchResult(turn, { chunks: [], documents: [] });
    expect(shouldAbortGeneration(turn)).toBe(true);
    expect(knowledgeTurnPayload(turn)).toEqual({
      refused: true,
      text: RAG_REFUSE_TEXT,
      documents: [],
    });
  });

  it('fills datasetId from chunks when doc_aggs omit it', () => {
    let turn = resetTurn();
    turn = markSearchResult(turn, {
      chunks: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
      documents: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: '' }],
    });
    expect(knowledgeTurnPayload(turn).documents[0].datasetId).toBe('law');
  });

  it('toolCall-only message_end is not visible', () => {
    expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'knowledge.search' }] } })).toBe(false);
    expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: '根据办法' } })).toBe(true);
  });
});
