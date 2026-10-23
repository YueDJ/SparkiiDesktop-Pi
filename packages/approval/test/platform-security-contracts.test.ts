import { describe, expect, it } from 'vitest';
import {
  sandboxCapabilityDecision,
  type PlatformSecurityReport,
} from '../src/security/index.js';

function report(
  patch: Partial<PlatformSecurityReport['capabilities']> = {},
): PlatformSecurityReport {
  return {
    platform: 'windows',
    status: 'available',
    version: 'appcontainer-v1',
    limitations: [],
    capabilities: {
      filesystemBoundary: true,
      privateScratch: true,
      networkIsolation: true,
      ipcIsolation: true,
      processTreeControl: true,
      environmentScrubbing: true,
      ...patch,
    },
  };
}

describe('sandbox capability decision', () => {
  it('allows process execution only when every mandatory proof is available', () => {
    expect(sandboxCapabilityDecision(report())).toEqual({
      decision: 'allow',
      missing: [],
    });
  });

  it('fails closed when any required isolation proof is missing', () => {
    expect(sandboxCapabilityDecision(report({
      networkIsolation: false,
      ipcIsolation: false,
    }))).toEqual({
      decision: 'deny',
      missing: ['networkIsolation', 'ipcIsolation'],
    });
  });
});
