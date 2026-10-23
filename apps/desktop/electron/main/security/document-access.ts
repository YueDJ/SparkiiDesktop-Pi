import type { TaskGrant } from '@sparkii/approval';
import type { ActionNormalizer } from './action-normalizer.js';

export type DocumentReadAuthorization =
  | { ok: true; paths: string[] }
  | { ok: false; code: 'SCOPE_DENIED' | 'TRUST_ANCHOR'; message: string };

/**
 * Documents are readable only from the current Workspace or a Main-bound Input
 * Resource. This closes the previous arbitrary-path `document.read` entry.
 */
export async function authorizeDocumentReadPaths(
  paths: string[],
  grant: TaskGrant,
  normalizer: Pick<ActionNormalizer, 'authorizeRead'>,
): Promise<DocumentReadAuthorization> {
  const canonical: string[] = [];
  for (const path of paths) {
    const resource = await normalizer.authorizeRead(path, grant);
    if (resource.trustAnchor) {
      return {
        ok: false,
        code: 'TRUST_ANCHOR',
        message: `document.read is denied for a trust anchor: ${resource.value}`,
      };
    }
    if (
      resource.scope !== 'workspace'
      && resource.scope !== 'input'
      && resource.scope !== 'scratch'
    ) {
      return {
        ok: false,
        code: 'SCOPE_DENIED',
        message: `document.read target is outside the current task: ${resource.value}`,
      };
    }
    canonical.push(resource.value);
  }
  return { ok: true, paths: canonical };
}
