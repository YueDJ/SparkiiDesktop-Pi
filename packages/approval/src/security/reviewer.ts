import type { ReviewerDecision } from './types.js';

const ALLOWED_KEYS = ['decision', 'reason', 'risk'];
const MAX_REASON_LENGTH = 500;

/**
 * The only context a Reviewer may see. Main builds this per request; it never
 * contains the conversation, file contents, credentials or reasoning traces.
 */
export interface ShellReviewInput {
  taskId: string;
  sessionId: string;
  actionId: string;
  userTask: string;
  toolName: string;
  capability: string;
  risk: string;
  command: string;
  cwd: string;
  workspaceRoot: string;
  targets: string[];
  recentEvidence: Array<{
    toolName: string;
    status: 'executed' | 'denied' | 'failed';
    summary: string;
    exitCode?: number | null;
  }>;
  hardDenyPolicyVersion: string;
  payloadHash: string;
  unattended: boolean;
}

/**
 * Parses the Reviewer's reply into the fixed decision set. Anything that is not
 * exactly one of `allow+low|medium`, `ask+high` or `deny+critical` throws, so a
 * malformed or free-text answer can never be read as permission to execute.
 */
export function parseReviewerDecision(raw: string): ReviewerDecision {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Reviewer output is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid reviewer output');
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== ALLOWED_KEYS.length
    || keys.join(',') !== [...ALLOWED_KEYS].sort().join(',')
  ) {
    throw new Error('reviewer fields are invalid');
  }
  if (typeof row.reason !== 'string' || !row.reason.trim()) {
    throw new Error('reviewer reason is required');
  }
  const reason = row.reason.trim().slice(0, MAX_REASON_LENGTH);
  if (row.decision === 'allow' && (row.risk === 'low' || row.risk === 'medium')) {
    return { decision: 'allow', risk: row.risk, reason };
  }
  if (row.decision === 'ask' && row.risk === 'high') {
    return { decision: 'ask', risk: 'high', reason };
  }
  if (row.decision === 'deny' && row.risk === 'critical') {
    return { decision: 'deny', risk: 'critical', reason };
  }
  throw new Error('reviewer decision/risk pair is invalid');
}
