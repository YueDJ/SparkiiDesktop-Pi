import { describe, it, expect } from 'vitest';
import { firstProfileWithKnowledge } from '../electron/main/profile-catalog.js';

describe('firstProfileWithKnowledge', () => {
  it('returns the first profile that declares knowledge', () => {
    const profiles = [
      { id: 'general', profile: { agent: { knowledge: [] } } },
      { id: 'contract-review', profile: { agent: { knowledge: [{ id: 'law-1', text: '法规' }] } } },
    ];

    expect(firstProfileWithKnowledge(profiles)?.id).toBe('contract-review');
  });

  it('returns undefined when no profile declares knowledge', () => {
    const profiles = [
      { id: 'general', profile: { agent: { knowledge: [] } } },
    ];

    expect(firstProfileWithKnowledge(profiles)).toBeUndefined();
  });
});
