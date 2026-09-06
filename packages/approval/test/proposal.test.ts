import { describe, it, expect } from 'vitest';
import { createProposal, transition, canonicalJson, hashPayload, toPreviewLines } from '../src/proposal.js';

describe('proposal', () => {
  it('freezes payload hash at creation', () => {
    const p = createProposal({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: { title: 'r' }, risk: 'write' }, { profileId: 'p1', sessionId: 's1' });
    expect(p.status).toBe('pending');
    expect(p.payloadHash).toBe(hashPayload({ title: 'r' }));
  });
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it('rejects illegal transition denied→executed', () => {
    const p = transition(createProposal({ toolName: 't', targetSystem: 's', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'denied');
    expect(() => transition(p, 'executed')).toThrow();
  });
  it('copies preview from the request and keeps it out of the payload hash', () => {
    const payload = { path: 'a.txt', content: 'hi' };
    const preview = { kind: 'diff' as const, lines: ['+hi'] };
    const withPreview = createProposal(
      { toolName: 'write', targetSystem: 'general', summary: '写入 a.txt', preview, payload, risk: 'write' },
      { profileId: 'p', sessionId: 's' },
    );
    const otherPreview = createProposal(
      { toolName: 'write', targetSystem: 'general', summary: '写入 a.txt', preview: { kind: 'text', lines: ['other'] }, payload, risk: 'write' },
      { profileId: 'p', sessionId: 's' },
    );
    expect(withPreview.preview).toEqual(preview);
    expect(withPreview.payload).toEqual(payload);
    expect(withPreview.payloadHash).toBe(hashPayload(payload));
    expect(withPreview.payloadHash).toBe(otherPreview.payloadHash);
  });
  it('splits preview text and drops a trailing empty line', () => {
    expect(toPreviewLines('a\nb\n')).toEqual(['a', 'b']);
  });
});
