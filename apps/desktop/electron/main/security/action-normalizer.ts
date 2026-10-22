import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  hashPayload,
  type ActionApprovalClass,
  type CapabilityKind,
  type ProtectedRoot,
  type ResourceRef,
  type SecurityAction,
  type SecurityRisk,
  type TaskGrant,
  type WorkspacePathProbe,
} from '@sparkii/approval';
import type { RuntimeActionRequest } from '@sparkii/agent-host';

export interface NormalizedToolDescriptor {
  toolName: string;
  capability: CapabilityKind;
  /** Trusted classification of how permission must be obtained for this tool. */
  approvalClass: ActionApprovalClass;
  risk: SecurityRisk | ((args: Record<string, unknown>) => SecurityRisk);
  /** Path arguments selected by the trusted descriptor, never by Runtime metadata. */
  pathArgs?: string[];
  processName?: string;
  externalEffect?: string;
  reason: string;
}

export interface ActionNormalizerOptions {
  descriptors: NormalizedToolDescriptor[];
  protectedRoots: ProtectedRoot[];
  probe: WorkspacePathProbe;
  trustAnchors?: string[];
  now?: () => number;
}

export class ActionNormalizationError extends Error {
  constructor(
    public readonly code:
      | 'UNKNOWN_TOOL'
      | 'INVALID_TARGET'
      | 'PROBE_FAILED',
    message: string,
  ) {
    super(message);
  }
}

const HIGH_RISK_PROCESS =
  /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|\bmkfs\b|\bformat\s+/i;

/** A recursive-destructive `rm` invocation, for example `rm -rf`, `rm -fr`, `rm -r -f`. */
const RECURSIVE_FORCE_RM =
  /(^|[\s;|&])rm\s+(?:-[^\s|]*\s+)*-{1,2}[A-Za-z]*(?:[rR][A-Za-z]*[fF]|[fF][A-Za-z]*[rR])[A-Za-z]*(\s|$)/;

/** Deterministic disk destruction, independent of the target path. */
const DISK_DESTRUCTION =
  /(^|[\s;|&])mkfs(?:\.\w+)?(\s|$)|(^|[\s;|&])format\s+[A-Za-z]:(\s|$)|(^|[\s;|&])dd\s[^\n|;&]*\bof=\/dev\//i;

/** Any Git command that writes to a remote is a typed external write. */
const GIT_REMOTE_WRITE = /(^|[\s;|&])git\b[^\n]*\bpush\b/;

export const CATASTROPHIC_TARGET_RULE = 'platform.catastrophic-target';
export const HARD_DENY_POLICY_VERSION = 'hard-deny-v1';

/**
 * Matches a whole argument that names an OS root, a home root or a drive root.
 * Anchored on argument boundaries so `rm -rf src/` stays an ordinary workspace
 * delete while `rm -rf /`, `rm -rf ~/` and `rm -rf C:/` are recognised.
 */
const ROOT_ARGUMENT = new RegExp(
  '(?:^|[\\s"\'`])'
  + '(?:/\\*?|~/|~|\\$\\{?HOME\\}?|%USERPROFILE%|[A-Za-z]:[\\\\/]{0,2})'
  + '(?=$|[\\s"\'`;&|])',
);

/**
 * Deterministic Shell classification. This only ever *tightens* a decision: an
 * unrecognised command stays reviewable instead of being treated as safe.
 */
export function classifyShellCommand(command: string): {
  approvalClass: ActionApprovalClass;
  risk: SecurityRisk;
  hardDenyRule?: string;
} {
  const catastrophic = DISK_DESTRUCTION.test(command)
    || (RECURSIVE_FORCE_RM.test(command) && ROOT_ARGUMENT.test(command));
  if (catastrophic) {
    return { approvalClass: 'shell', risk: 'high-risk', hardDenyRule: CATASTROPHIC_TARGET_RULE };
  }
  if (GIT_REMOTE_WRITE.test(command)) {
    return { approvalClass: 'human_required', risk: 'high-risk' };
  }
  return {
    approvalClass: 'shell',
    risk: HIGH_RISK_PROCESS.test(command) ? 'high-risk' : 'write',
  };
}

const DEFAULT_TRUST_ANCHOR_NAMES = new Set([
  '.env',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.bashrc',
  '.profile',
  '.zshrc',
  '.mcp.json',
  'mcp.json',
  'id_rsa',
  'id_ed25519',
]);

export const DEFAULT_TOOL_DESCRIPTORS: NormalizedToolDescriptor[] = [
  {
    toolName: 'write',
    capability: 'fs.write',
    approvalClass: 'auto',
    risk: 'write',
    pathArgs: ['path'],
    reason: '工作区内文件写入',
  },
  {
    toolName: 'edit',
    capability: 'fs.write',
    approvalClass: 'auto',
    risk: 'write',
    pathArgs: ['path'],
    reason: '工作区内文件修改',
  },
  {
    toolName: 'delete',
    capability: 'fs.write',
    approvalClass: 'auto',
    risk: 'write',
    pathArgs: ['path'],
    reason: '工作区内文件或目录删除',
  },
  {
    toolName: 'move',
    capability: 'fs.write',
    approvalClass: 'auto',
    risk: 'write',
    pathArgs: ['from', 'to'],
    reason: '工作区内文件移动或重命名',
  },
  {
    toolName: 'bash',
    capability: 'process.exec',
    approvalClass: 'shell',
    risk: (args) => classifyShellCommand(String(args.command ?? '')).risk,
    processName: 'bash',
    externalEffect: 'local-process',
    reason: '以宿主 Git Bash 执行本地命令',
  },
  {
    toolName: 'report.export',
    capability: 'fs.write',
    approvalClass: 'human_required',
    risk: 'write',
    pathArgs: ['path'],
    reason: '导出报告文件',
  },
];

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathSegments(value: string): string[] {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).map((part) => part.toLowerCase());
}

export function isTrustAnchorPath(
  value: string,
  extraNames: string[] = [],
): boolean {
  const segments = pathSegments(value);
  const names = new Set([
    ...DEFAULT_TRUST_ANCHOR_NAMES,
    ...extraNames.map((entry) => entry.toLowerCase()),
  ]);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (names.has(segment) || segment.startsWith('.env.')) return true;
    if (segment === '.git') {
      const child = segments[index + 1];
      if (child === 'hooks' || child === 'config') return true;
    }
    if (
      segment === '.codex'
      || segment === '.cursor'
      || segment === '.claude'
    ) return true;
  }
  return false;
}

function freezePayload(value: unknown): unknown {
  const clone = structuredClone(value);
  const deepFreeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) deepFreeze(child);
  };
  deepFreeze(clone);
  return clone;
}

function isSameOrParent(left: string, right: string): boolean {
  const a = pathKey(left);
  const b = pathKey(right);
  return a === b || a === pathKey(dirname(b));
}

async function classifyPath(
  rawTarget: string,
  grant: TaskGrant,
  options: ActionNormalizerOptions,
): Promise<ResourceRef> {
  const absolute = isAbsolute(rawTarget)
    ? rawTarget
    : resolve(grant.workspaceRoot, rawTarget);
  let inspected;
  try {
    inspected = await options.probe.inspect(absolute);
  } catch (error) {
    throw new ActionNormalizationError(
      'PROBE_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }

  const canonical = inspected.canonicalPath;
  const parent = await options.probe.inspect(dirname(canonical));
  let critical = isSameOrParent(canonical, grant.workspaceRoot);
  if (!critical) {
    for (const root of options.protectedRoots) {
      if (await options.probe.isSameObject(root.path, canonical)) {
        critical = true;
        break;
      }
      if (
        root.policy === 'closure'
        && await options.probe.isSameOrDescendant(root.path, canonical)
      ) {
        critical = true;
        break;
      }
    }
  }

  let scope: ResourceRef['scope'] = 'external';
  if (critical) scope = 'critical';
  else if (await options.probe.isSameOrDescendant(grant.workspaceRoot, canonical)) {
    scope = 'workspace';
  } else if (await options.probe.isSameOrDescendant(grant.scratchRoot, canonical)) {
    scope = 'scratch';
  } else {
    for (const input of grant.inputRoots) {
      if (await options.probe.isSameOrDescendant(input.path, canonical)) {
        scope = 'input';
        break;
      }
    }
  }

  return {
    kind: 'path',
    value: canonical,
    identity: inspected.identity,
    parentIdentity: parent.identity,
    scope,
    ...(scope !== 'critical' && isTrustAnchorPath(canonical, options.trustAnchors ?? [])
      ? { trustAnchor: true }
      : {}),
  };
}

export interface ActionNormalizer {
  normalize(
    request: RuntimeActionRequest,
    grant: TaskGrant,
  ): Promise<SecurityAction>;
}

export function createActionNormalizer(
  options: ActionNormalizerOptions,
): ActionNormalizer {
  const descriptors = new Map(
    options.descriptors.map((descriptor) => [
      descriptor.toolName.toLowerCase(),
      descriptor,
    ]),
  );
  return {
    async normalize(request, grant) {
      const descriptor = descriptors.get(request.toolName.toLowerCase());
      if (!descriptor) {
        throw new ActionNormalizationError(
          'UNKNOWN_TOOL',
          `unknown trusted tool: ${request.toolName}`,
        );
      }
      if (!request.requestId.trim()) {
        throw new ActionNormalizationError('INVALID_TARGET', 'requestId is required');
      }

      const args = request.args ?? {};
      const resources: ResourceRef[] = [];
      for (const name of descriptor.pathArgs ?? []) {
        const value = args[name];
        if (typeof value !== 'string' || !value.trim()) {
          throw new ActionNormalizationError(
            'INVALID_TARGET',
            `missing path argument: ${name}`,
          );
        }
        resources.push(await classifyPath(value, grant, options));
      }
      let approvalClass = descriptor.approvalClass;
      let hardDenyRule: string | undefined;
      if (descriptor.capability === 'process.exec') {
        const shell = classifyShellCommand(String(args.command ?? ''));
        approvalClass = shell.approvalClass;
        hardDenyRule = shell.hardDenyRule;
        resources.push({
          kind: 'process',
          value: descriptor.processName ?? descriptor.toolName,
          identity: `${descriptor.processName ?? descriptor.toolName}:host`,
          scope: 'workspace',
        });
      }

      const risk = typeof descriptor.risk === 'function'
        ? descriptor.risk(args)
        : descriptor.risk;
      return {
        id: randomUUID(),
        subjectId: grant.actorId,
        taskId: grant.taskId,
        sessionId: grant.sessionId,
        agentId: grant.agentId,
        profileId: grant.profileId,
        toolName: descriptor.toolName,
        capability: descriptor.capability,
        approvalClass,
        resources,
        payload: freezePayload(args),
        payloadHash: hashPayload(args),
        risk,
        reason: descriptor.reason,
        ...(descriptor.externalEffect
          ? { externalEffect: descriptor.externalEffect }
          : {}),
        ...(hardDenyRule ? { hardDenyRule } : {}),
      };
    },
  };
}
