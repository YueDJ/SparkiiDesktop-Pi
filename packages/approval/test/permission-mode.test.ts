import { describe, expect, it } from 'vitest';
import { resolvePermissionMode } from '../src/security/index.js';

describe('resolvePermissionMode', () => {
  it('defaults to ask and accepts only allowed modes', () => {
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('ask');
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      requestedMode: 'auto_review',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('auto_review');
    expect(() => resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      requestedMode: 'auto_review',
      allowedModes: ['ask'],
    })).toThrow(/not allowed/);
  });

  it('prefers the requested mode over the session and profile defaults', () => {
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      requestedMode: 'ask',
      sessionMode: 'auto_review',
      profileDefaultMode: 'auto_review',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('ask');
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      sessionMode: 'auto_review',
      profileDefaultMode: 'ask',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('auto_review');
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      profileDefaultMode: 'auto_review',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('auto_review');
  });

  it('refuses a profile policy that removes ask', () => {
    expect(() => resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      allowedModes: ['auto_review'],
    })).toThrow(/Ask must remain allowed/);
  });

  it('refuses a session mode that the profile no longer allows', () => {
    expect(() => resolvePermissionMode({
      sessionId: 's1',
      profileId: 'strict-agent',
      sessionMode: 'auto_review',
      allowedModes: ['ask'],
    })).toThrow(/not allowed/);
  });
});
