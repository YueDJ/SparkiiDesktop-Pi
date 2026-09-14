import type { RuntimeAcquireMeta } from '@sparkii/agent-host';

export function poolMeta(
  profileId: string,
  displayName?: string | null,
  label?: string | null,
): RuntimeAcquireMeta {
  const name = displayName?.trim();
  const text = label?.trim();
  return {
    profileId,
    profileName: name || profileId,
    label: text || '新会话',
  };
}

export function profilePoolMeta(
  rt: { profileOf(id: string): { profile: { manifest?: { displayName?: string } } } },
  profileId: string,
  label?: string | null,
): RuntimeAcquireMeta {
  return poolMeta(profileId, rt.profileOf(profileId)?.profile?.manifest?.displayName, label);
}
