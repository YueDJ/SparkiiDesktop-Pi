import type { PlatformPermissionMode } from './types.js';

/**
 * Resolves which permission mode governs a session. Ask is the default and can
 * never be removed by a Profile, because AutoReview must always have a human
 * fallback.
 */
export function resolvePermissionMode(input: {
  sessionId: string;
  profileId: string;
  requestedMode?: PlatformPermissionMode;
  sessionMode?: PlatformPermissionMode;
  profileDefaultMode?: PlatformPermissionMode;
  allowedModes: readonly PlatformPermissionMode[];
}): PlatformPermissionMode {
  if (!input.allowedModes.includes('ask')) {
    throw new Error('Ask must remain allowed');
  }
  const mode = input.requestedMode
    ?? input.sessionMode
    ?? input.profileDefaultMode
    ?? 'ask';
  if (!input.allowedModes.includes(mode)) {
    throw new Error(`permission mode ${mode} is not allowed`);
  }
  return mode;
}
