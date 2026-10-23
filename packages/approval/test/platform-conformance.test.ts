import { describe, expect, it } from 'vitest';
import {
  PlatformAdapterRegistry,
  sandboxCapabilityDecision,
  type PlatformAdapter,
  type PlatformSecurityReport,
} from '../src/security/index.js';

const report = (
  platform: 'windows' | 'macos' | 'linux',
  status: PlatformSecurityReport['status'],
): PlatformSecurityReport => ({
  platform,
  status,
  version: 'contract-v1',
  capabilities: {
    filesystemBoundary: status === 'available',
    privateScratch: status === 'available',
    networkIsolation: status === 'available',
    ipcIsolation: status === 'available',
    processTreeControl: status === 'available',
    environmentScrubbing: status === 'available',
  },
  limitations: status === 'available' ? [] : ['native adapter not implemented'],
});

function adapter(platform: 'windows' | 'macos' | 'linux', status: PlatformSecurityReport['status']): PlatformAdapter {
  return {
    platform,
    pathProbe: {
      inspect: async () => ({
        displayPath: '',
        canonicalPath: '',
        identity: '',
        nearestExistingAncestor: '',
        isDirectory: true,
        isReparsePoint: false,
      }),
      isSameOrDescendant: async () => false,
      isSameObject: async () => false,
    },
    sandbox: {
      probe: async () => report(platform, status),
      run: async () => { throw new Error('not implemented'); },
      terminate: async () => {},
    },
  };
}

describe('PlatformAdapterRegistry', () => {
  it('selects adapters without OS branches in policy', () => {
    const registry = new PlatformAdapterRegistry();
    const windows = adapter('windows', 'available');
    registry.register(windows);
    expect(registry.get('windows')).toBe(windows);
    expect(registry.get('linux')).toBeUndefined();
  });

  it('rejects duplicate adapters and unknown platform selection', () => {
    const registry = new PlatformAdapterRegistry();
    registry.register(adapter('windows', 'available'));
    expect(() => registry.register(adapter('windows', 'available'))).toThrow(/already/i);
    expect(() => registry.select('linux')).toThrow(/unsupported/i);
  });

  it('applies the same fail-closed conformance rule to macOS and Linux fixtures', async () => {
    for (const platform of ['macos', 'linux'] as const) {
      const candidate = adapter(platform, 'unavailable');
      const conformance = await candidate.sandbox.probe();
      expect(sandboxCapabilityDecision(conformance)).toEqual({
        decision: 'deny',
        missing: [
          'filesystemBoundary',
          'privateScratch',
          'networkIsolation',
          'ipcIsolation',
          'processTreeControl',
          'environmentScrubbing',
        ],
      });
    }
  });
});
