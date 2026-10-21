import type { ApprovalPolicy } from '@sparkii/config';
import type {
  CapabilityKind,
  PlatformProfilePolicy,
  RunMode,
} from '@sparkii/approval';
import type { NormalizedToolDescriptor } from './action-normalizer.js';

const CAPABILITIES = new Set<CapabilityKind>([
  'fs.read',
  'fs.write',
  'process.exec',
  'net.connect',
  'connector.invoke',
  'task.delegate',
]);

export class ProfilePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfilePolicyError';
  }
}

function normalizeEntries(
  entries: string[] | undefined,
  field: string,
  tools: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const raw of entries ?? []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    if (CAPABILITIES.has(value as CapabilityKind)) {
      if (!out.includes(value)) out.push(value);
      continue;
    }
    const toolName = tools.get(value.toLowerCase());
    if (!toolName) {
      throw new ProfilePolicyError(
        `unknown ${field} entry: ${value}`,
      );
    }
    if (!out.includes(toolName)) out.push(toolName);
  }
  return out;
}

export function normalizeProfilePolicy(
  policy: ApprovalPolicy & { mode?: RunMode },
  descriptors: NormalizedToolDescriptor[],
): PlatformProfilePolicy {
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) {
    throw new ProfilePolicyError('approval timeout must be positive');
  }
  const tools = new Map(
    descriptors.map((descriptor) => [
      descriptor.toolName.toLowerCase(),
      descriptor.toolName,
    ]),
  );
  return {
    mode: policy.mode ?? 'standard',
    requireApproval: normalizeEntries(
      policy.requireApproval,
      'requireApproval',
      tools,
    ),
    autoApprove: normalizeEntries(
      policy.autoApprove,
      'autoApprove',
      tools,
    ),
    timeoutMs: policy.timeoutMs,
    highRiskDoubleConfirm: policy.highRiskDoubleConfirm === true,
  };
}
