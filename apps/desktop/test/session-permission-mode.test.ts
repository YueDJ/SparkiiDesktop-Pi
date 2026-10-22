import { describe, expect, it } from 'vitest';
import { resolveSessionPermissionMode } from '../electron/main/security/session-permission-mode.js';

const policy = {
  defaultPermissionMode: 'ask' as const,
  allowedPermissionModes: ['ask', 'auto_review'] as const,
};

describe('resolveSessionPermissionMode', () => {
  it('uses stored mode and rejects disallowed overrides', () => {
    expect(resolveSessionPermissionMode('s1', 'general', policy, 'auto_review'))
      .toBe('auto_review');
    expect(() => resolveSessionPermissionMode(
      's1',
      'strict-agent',
      { ...policy, allowedPermissionModes: ['ask'] },
      'auto_review',
    )).toThrow(/not allowed/);
  });

  it('defaults to ask when the session never chose', () => {
    expect(resolveSessionPermissionMode('s1', 'general', policy)).toBe('ask');
  });

  it('honours a profile default that the profile also allows', () => {
    expect(resolveSessionPermissionMode(
      's1',
      'general',
      { defaultPermissionMode: 'auto_review', allowedPermissionModes: ['ask', 'auto_review'] },
    )).toBe('auto_review');
  });

  it('refuses a profile that would remove the human path', () => {
    expect(() => resolveSessionPermissionMode(
      's1',
      'general',
      { defaultPermissionMode: 'auto_review', allowedPermissionModes: ['auto_review'] },
    )).toThrow(/Ask must remain allowed/);
  });
});
