import {
  resolvePermissionMode,
  type PlatformPermissionMode,
  type PlatformProfilePolicy,
} from '@sparkii/approval';

/**
 * Resolves the permission mode a session runs under. The Profile decides which
 * modes exist at all; a stored or requested mode outside that set is an error
 * rather than a silent downgrade.
 */
export function resolveSessionPermissionMode(
  sessionId: string,
  profileId: string,
  policy: Pick<PlatformProfilePolicy, 'defaultPermissionMode' | 'allowedPermissionModes'>,
  requestedMode?: PlatformPermissionMode,
): PlatformPermissionMode {
  return resolvePermissionMode({
    sessionId,
    profileId,
    requestedMode,
    profileDefaultMode: policy.defaultPermissionMode,
    allowedModes: policy.allowedPermissionModes,
  });
}
