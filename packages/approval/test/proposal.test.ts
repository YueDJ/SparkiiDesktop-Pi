import { describe, it, expect } from 'vitest';
import { createProposal, transition, canonicalJson, hashPayload } from '../src/proposal.js';

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
});
