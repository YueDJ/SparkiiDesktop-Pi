import { hashPayload } from '../proposal.js';
import type { SecurityAction } from './types.js';

/**
 * Hash the security-bearing facts of a Main-normalized action. Display-only
 * fields and mutable transport identifiers are intentionally excluded.
 */
export function actionFingerprint(action: SecurityAction): string {
  const resources = action.resources
    .map((resource) => ({
      kind: resource.kind,
      value: resource.value,
      identity: resource.identity ?? null,
      parentIdentity: resource.parentIdentity ?? null,
      scope: resource.scope,
      trustAnchor: resource.trustAnchor === true,
    }))
    .sort((a, b) =>
      `${a.kind}\0${a.value}\0${a.identity}\0${a.parentIdentity}\0${a.scope}`
        .localeCompare(`${b.kind}\0${b.value}\0${b.identity}\0${b.parentIdentity}\0${b.scope}`),
    );

  return hashPayload({
    taskId: action.taskId,
    sessionId: action.sessionId,
    agentId: action.agentId,
    profileId: action.profileId,
    toolName: action.toolName,
    capability: action.capability,
    resources,
    payloadHash: action.payloadHash,
    risk: action.risk,
    externalEffect: action.externalEffect ?? null,
  });
}
