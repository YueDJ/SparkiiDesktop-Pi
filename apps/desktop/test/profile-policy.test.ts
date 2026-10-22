import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_DESCRIPTORS } from '../electron/main/security/action-normalizer.js';
import {
  ProfilePolicyError,
  normalizeProfilePolicy,
} from '../electron/main/security/profile-policy.js';

describe('normalizeProfilePolicy', () => {
  it('preserves the general profile as Ask with both platform modes', () => {
    expect(normalizeProfilePolicy({
      requireApproval: [],
      timeoutMs: 300_000,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toEqual({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
      requireApproval: [],
      autoApprove: [],
      timeoutMs: 300_000,
      highRiskDoubleConfirm: true,
    });
  });

  it('keeps a known tool requirement scoped to that tool instead of all fs.write', () => {
    expect(normalizeProfilePolicy({
      requireApproval: ['report.export'],
      timeoutMs: 60_000,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toMatchObject({
      requireApproval: ['report.export'],
    });
  });

  it('accepts capability-level requirements and auto approvals', () => {
    expect(normalizeProfilePolicy({
      mode: 'strict',
      requireApproval: ['fs.write', 'net.connect'],
      autoApprove: ['connector.invoke'],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toEqual({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
      requireApproval: ['fs.write', 'net.connect'],
      autoApprove: ['connector.invoke'],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
    });
  });

  it('honours an explicit Ask-only default', () => {
    expect(normalizeProfilePolicy({
      requireApproval: [],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
    }, DEFAULT_TOOL_DESCRIPTORS)).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
    });
  });

  it('refuses a policy that removes Ask or defaults to a disallowed mode', () => {
    expect(() => normalizeProfilePolicy({
      requireApproval: [],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
      allowedPermissionModes: ['auto_review'],
    }, DEFAULT_TOOL_DESCRIPTORS)).toThrow(/must include ask/);
    expect(() => normalizeProfilePolicy({
      requireApproval: [],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
      allowedPermissionModes: ['ask'],
      defaultPermissionMode: 'auto_review',
    }, DEFAULT_TOOL_DESCRIPTORS)).toThrow(/must be an allowed mode/);
  });

  it('fails closed on unknown approval entries', () => {
    expect(() => normalizeProfilePolicy({
      requireApproval: ['unknown.tool'],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toThrow(ProfilePolicyError);
    expect(() => normalizeProfilePolicy({
      autoApprove: ['unknown.capability'],
      requireApproval: [],
      timeoutMs: 10_000,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toThrow(ProfilePolicyError);
  });

  it('rejects non-positive approval timeouts', () => {
    expect(() => normalizeProfilePolicy({
      requireApproval: [],
      timeoutMs: 0,
      highRiskDoubleConfirm: true,
    }, DEFAULT_TOOL_DESCRIPTORS)).toThrow(/timeout/i);
  });
});
