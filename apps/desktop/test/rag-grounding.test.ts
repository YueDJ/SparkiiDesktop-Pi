import { describe, it, expect } from 'vitest';
import {
  RAG_REFUSE_TEXT,
  isVisibleAssistantEnd,
  knowledgeTurnPayload,
  markSearchResult,
  resetTurn,
  sealTurn,
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
      citations: [],
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

  it('merges later searches and does not abort after a prior hit', () => {
    let turn = resetTurn();
    turn = markSearchResult(turn, {
      chunks: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
      documents: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
    });
    turn = markSearchResult(turn, { chunks: [], documents: [] });
    expect(shouldAbortGeneration(turn)).toBe(false);
    turn = markSearchResult(turn, {
      chunks: [{ documentId: 'd2', documentName: '制度.pdf', datasetId: 'hr' }],
      documents: [{ documentId: 'd2', documentName: '制度.pdf', datasetId: 'hr' }],
    });
    expect(knowledgeTurnPayload(turn).documents.map((d) => d.documentId)).toEqual(['d1', 'd2']);
    expect(knowledgeTurnPayload(turn).citations.map((c) => c.index)).toEqual([1, 2]);
    expect(knowledgeTurnPayload(turn).citations.map((c) => c.documentId)).toEqual(['d1', 'd2']);
  });

  it('numbers every chunk even when they share a document', () => {
    let turn = resetTurn();
    turn = markSearchResult(turn, {
      chunks: [
        { documentId: 'd1', documentName: 'TJ5.docx', datasetId: 'law', content: '汕梅高速改扩建 TJ5 标段' },
        { documentId: 'd1', documentName: 'TJ5.docx', datasetId: 'law', content: '墩柱共 490 根' },
        { documentId: 'd1', documentName: 'TJ5.docx', datasetId: 'law', content: '桥梁 3189.4m/17 座' },
        { documentId: 'd1', documentName: 'TJ5.docx', datasetId: 'law', content: '编制依据' },
      ],
      documents: [{ documentId: 'd1', documentName: 'TJ5.docx', datasetId: 'law' }],
    });
    const payload = knowledgeTurnPayload(turn);
    expect(payload.documents).toHaveLength(1);
    expect(payload.citations.map((c) => ({ index: c.index, snippet: c.snippet }))).toEqual([
      { index: 1, snippet: '汕梅高速改扩建 TJ5 标段' },
      { index: 2, snippet: '墩柱共 490 根' },
      { index: 3, snippet: '桥梁 3189.4m/17 座' },
      { index: 4, snippet: '编制依据' },
    ]);
  });

  it('starts a new turn after the previous one is sealed', () => {
    let turn = resetTurn();
    turn = markSearchResult(turn, {
      chunks: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
      documents: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
    });
    turn = sealTurn(turn);
    turn = markSearchResult(turn, { chunks: [], documents: [] });
    expect(shouldAbortGeneration(turn)).toBe(true);
    expect(knowledgeTurnPayload(turn).documents).toEqual([]);
  });

  it('toolCall-only message_end is not visible', () => {
    expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'knowledge.search' }] } })).toBe(false);
    expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: '根据办法' } })).toBe(true);
    expect(isVisibleAssistantEnd({
      message: { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: '根据办法' }] },
    })).toBe(true);
    expect(isVisibleAssistantEnd({
      message: { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }] },
    })).toBe(false);
    expect(isVisibleAssistantEnd({ message: { role: 'user', content: '津贴怎么发' } })).toBe(false);
  });
});
