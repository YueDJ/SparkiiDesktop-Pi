import { z } from 'zod';
import type { ApprovalPolicy, PermissionModeId, ProfileManifest } from './types.js';

const modelTarget = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  displayName: z.string().optional(),
  sortOrder: z.number().optional(),
  extends: z.string().optional(),
  surface: z.object({
    type: z.enum(['chat', 'workflow', 'dashboard', 'custom']),
    entry: z.string().optional(),
  }).optional(),
  capabilities: z.object({
    entry: z.string().optional(),
    tools: z.array(z.string()).optional(),
  }).optional(),
  modelRequirements: z.object({
    requires: z.array(z.string()),
    prefers: z.array(z.string()).optional(),
  }).optional(),
  modelRouting: z.object({
    tasks: z.record(z.string(), z.array(modelTarget)),
  }),
  integrity: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  skillLibrary: z.enum(['package', 'user']).optional(),
  knowledge: z.object({
    enabled: z.boolean(),
    picker: z.enum(['hidden', 'session']),
    backend: z.enum(['bm25', 'sparkiirag']),
  }).optional(),
});

export function parseProfileManifest(raw: unknown): ProfileManifest {
  return manifestSchema.parse(raw);
}

const permissionModeSchema = z.enum(['ask', 'auto_review']);

export const approvalPolicySchema = z.object({
  autoApprove: z.array(z.string()).optional(),
  requireApproval: z.array(z.string()),
  timeoutMs: z.number().positive(),
  highRiskDoubleConfirm: z.boolean(),
  defaultPermissionMode: permissionModeSchema.optional(),
  allowedPermissionModes: z.array(permissionModeSchema).optional(),
  mode: z.enum(['standard', 'strict']).optional(),
});

/**
 * Normalizes an approval policy, including legacy profiles that predate
 * permission modes: they default to Ask and keep AutoReview available unless
 * the legacy `strict` hint restricted them.
 */
export function parseApprovalPolicy(raw: unknown): ApprovalPolicy {
  const value = approvalPolicySchema.parse(raw);
  const allowedPermissionModes: PermissionModeId[] = value.allowedPermissionModes
    ?? (value.mode === 'strict' ? ['ask'] : ['ask', 'auto_review']);
  const defaultPermissionMode: PermissionModeId = value.defaultPermissionMode ?? 'ask';
  if (!allowedPermissionModes.includes('ask')) {
    throw new Error('allowedPermissionModes must include ask');
  }
  if (!allowedPermissionModes.includes(defaultPermissionMode)) {
    throw new Error('defaultPermissionMode must be allowed');
  }
  return {
    ...value,
    allowedPermissionModes,
    defaultPermissionMode,
  };
}
