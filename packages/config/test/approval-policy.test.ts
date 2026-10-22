import { describe, expect, it } from 'vitest';
import { parseApprovalPolicy } from '../src/schema.js';

describe('approval permission config', () => {
  it('defaults legacy profiles to Ask with both modes available', () => {
    expect(parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
    })).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
    });
  });

  it('makes legacy strict profiles Ask-only', () => {
    expect(parseApprovalPolicy({
      mode: 'strict',
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
    })).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
    });
  });

  it('keeps legacy fields intact while adding the mode fields', () => {
    expect(parseApprovalPolicy({
      autoApprove: ['fs.read'],
      requireApproval: ['report.export'],
      timeoutMs: 120000,
      highRiskDoubleConfirm: false,
      defaultPermissionMode: 'auto_review',
      allowedPermissionModes: ['ask', 'auto_review'],
    })).toEqual({
      autoApprove: ['fs.read'],
      requireApproval: ['report.export'],
      timeoutMs: 120000,
      highRiskDoubleConfirm: false,
      defaultPermissionMode: 'auto_review',
      allowedPermissionModes: ['ask', 'auto_review'],
      mode: undefined,
    });
  });

  it('refuses to drop ask or default to a disallowed mode', () => {
    expect(() => parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
      allowedPermissionModes: ['auto_review'],
    })).toThrow(/must include ask/);
    expect(() => parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
      allowedPermissionModes: ['ask'],
      defaultPermissionMode: 'auto_review',
    })).toThrow(/must be allowed/);
  });

  it('refuses platform modes the product does not offer', () => {
    expect(() => parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
      allowedPermissionModes: ['ask', 'full'],
    })).toThrow();
    expect(() => parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
      defaultPermissionMode: 'yolo',
    })).toThrow();
  });

  it('rejects a non-positive approval timeout', () => {
    expect(() => parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 0,
      highRiskDoubleConfirm: true,
    })).toThrow();
  });
});
