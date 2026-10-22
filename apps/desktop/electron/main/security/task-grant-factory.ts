import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  admitWorkspace,
  type PlatformPermissionMode,
  type PlanMode,
  type ProtectedRoot,
  type TaskGrant,
  type WorkspaceAdmissionResult,
  type WorkspacePathProbe,
} from '@sparkii/approval';

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1_000;

export class TaskGrantAdmissionError extends Error {
  constructor(
    public readonly admission: WorkspaceAdmissionResult | {
      ok: false;
      ruleId: string;
      reason: string;
    },
  ) {
    super(admission.reason ?? 'Workspace admission failed');
  }
}

export interface CreateTaskGrantInput {
  sessionId: string;
  agentId: string;
  profileId: string;
  actorId: string;
  unattended: boolean;
  planMode: PlanMode;
  permissionMode: PlatformPermissionMode;
  workspacePath: string;
  scratchParent: string;
  inputRoots?: string[];
  protectedRoots: ProtectedRoot[];
  probe: WorkspacePathProbe;
  now?: () => number;
  ttlMs?: number;
}

async function inspectInputRoot(
  path: string,
  protectedRoots: ProtectedRoot[],
  probe: WorkspacePathProbe,
): Promise<{ path: string; identity: string }> {
  let inspected;
  try {
    inspected = await probe.inspect(path);
  } catch (error) {
    throw new TaskGrantAdmissionError({
      ok: false,
      ruleId: 'input.probe-failed',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  for (const root of protectedRoots) {
    if (await probe.isSameObject(root.path, inspected.canonicalPath)) {
      throw new TaskGrantAdmissionError({
        ok: false,
        ruleId: 'input.protected-root',
        reason: 'Input resource cannot be a protected root',
      });
    }
    if (
      root.policy === 'closure'
      && await probe.isSameOrDescendant(root.path, inspected.canonicalPath)
    ) {
      throw new TaskGrantAdmissionError({
        ok: false,
        ruleId: 'input.closure-root',
        reason: 'Input resource is inside a protected closure root',
      });
    }
  }
  return {
    path: inspected.canonicalPath,
    identity: inspected.identity,
  };
}

export async function createTaskGrant(
  input: CreateTaskGrantInput,
): Promise<TaskGrant> {
  const admission = await admitWorkspace({
    target: input.workspacePath,
    protectedRoots: input.protectedRoots,
    probe: input.probe,
  });
  if (!admission.ok || !admission.canonicalPath || !admission.identity) {
    throw new TaskGrantAdmissionError(admission);
  }

  const workspaceKey = admission.canonicalPath
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  const scratchParentKey = resolve(input.scratchParent)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (
    scratchParentKey === workspaceKey
    || scratchParentKey.startsWith(`${workspaceKey}/`)
  ) {
    throw new TaskGrantAdmissionError({
      ok: false,
      ruleId: 'task.scratch-overlaps-workspace',
      reason: 'Task scratch must be outside the writable workspace',
    });
  }

  const now = input.now ?? Date.now;
  const createdAt = now();
  const taskId = `task-${randomUUID()}`;
  const inputRoots = [];
  for (const path of input.inputRoots ?? []) {
    inputRoots.push(await inspectInputRoot(path, input.protectedRoots, input.probe));
  }
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('task grant ttl must be positive');
  }

  return {
    taskId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    profileId: input.profileId,
    actorId: input.actorId,
    unattended: input.unattended,
    planMode: input.planMode,
    permissionMode: input.permissionMode,
    workspaceRoot: admission.canonicalPath,
    workspaceIdentity: admission.identity,
    inputRoots,
    scratchRoot: join(resolve(input.scratchParent), taskId, 'scratch'),
    networkDomains: [],
    externalCapabilities: [],
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
}
