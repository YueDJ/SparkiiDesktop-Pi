export type PlatformName = 'windows' | 'macos' | 'linux';
export type SandboxStatus = 'available' | 'partial' | 'unavailable';

export interface PlatformSecurityCapabilities {
  filesystemBoundary: boolean;
  privateScratch: boolean;
  networkIsolation: boolean;
  ipcIsolation: boolean;
  processTreeControl: boolean;
  environmentScrubbing: boolean;
}

export interface PlatformSecurityReport {
  platform: PlatformName;
  status: SandboxStatus;
  version: string;
  capabilities: PlatformSecurityCapabilities;
  limitations: string[];
  failure?: string;
}

export interface SandboxRunRequest {
  taskId: string;
  workspaceRoot: string;
  scratchRoot: string;
  runtimeRoot: string;
  executable: string;
  cwd: string;
  command: string;
  timeoutMs: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sandboxSid?: string;
  trustAnchorChanges?: string[];
}

export interface WorkspaceSandboxAdapter {
  probe(): Promise<PlatformSecurityReport>;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  terminate(taskId: string): Promise<void>;
}

export interface ProcessController {
  terminateTree(processId: number): Promise<void>;
}

export interface PlatformAdapter {
  platform: PlatformName;
  pathProbe: import('./types.js').WorkspacePathProbe;
  sandbox: WorkspaceSandboxAdapter;
}

export class PlatformAdapterRegistry {
  private adapters = new Map<PlatformName, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`platform adapter already registered: ${adapter.platform}`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: PlatformName): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  select(platform: string): PlatformAdapter {
    if (platform !== 'windows' && platform !== 'macos' && platform !== 'linux') {
      throw new Error(`unsupported platform: ${platform}`);
    }
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`unsupported platform adapter: ${platform}`);
    return adapter;
  }
}

const REQUIRED_CAPABILITIES = [
  'filesystemBoundary',
  'privateScratch',
  'networkIsolation',
  'ipcIsolation',
  'processTreeControl',
  'environmentScrubbing',
] as const;

export function sandboxCapabilityDecision(
  report: PlatformSecurityReport,
): {
  decision: 'allow' | 'deny';
  missing: string[];
} {
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) =>
      report.status !== 'available' || !report.capabilities[capability],
  );
  return {
    decision: missing.length === 0 ? 'allow' : 'deny',
    missing,
  };
}
