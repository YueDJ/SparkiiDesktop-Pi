/**
 * Platform contract for executing Shell on the host. Windows runs the packaged
 * Portable Git Bash under a Job Object; there is no OS sandbox, and nothing in
 * this contract may claim otherwise.
 */
export const HOST_SHELL_BACKEND = 'host-git-bash';
export const HOST_SHELL_VERSION = 'host-job-v1';
export const HOST_SHELL_MAX_OUTPUT_BYTES = 128 * 1024;

export interface HostShellProbeReport {
  backend: typeof HOST_SHELL_BACKEND;
  status: 'available' | 'unavailable';
  executionBoundary: 'host';
  version: typeof HOST_SHELL_VERSION;
  limitations: string[];
}

export interface HostShellRunRequest {
  taskId: string;
  workspaceRoot: string;
  scratchRoot: string;
  command: string;
  timeoutMs: number;
}

export interface HostShellRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface HostShellAdapter {
  probe(): Promise<HostShellProbeReport>;
  run(request: HostShellRunRequest): Promise<HostShellRunResult>;
  terminate(taskId: string): Promise<void>;
}

export const HOST_SHELL_LIMITATIONS = [
  '宿主执行，不是操作系统沙箱',
  '网络能力由宿主进程决定',
  '动态脚本可能在审查后访问宿主可访问的对象',
] as const;

export const HOST_SHELL_UNAVAILABLE = '未找到宿主 Git Bash 或 Job Object 执行器';
