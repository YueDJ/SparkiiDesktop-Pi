import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCapabilityStatus } from '../src/trust/TaskCapabilityStatus.js';

describe('TaskCapabilityStatus', () => {
  it('shows host execution semantics instead of sandbox claims', () => {
    render(
      <TaskCapabilityStatus
        status={{
          active: true,
          planMode: 'execute',
          permissionMode: 'ask',
          workspaceRoot: 'C:/work/project',
          workspaceWrite: true,
          processExec: true,
          networkDomains: [],
          externalCapabilities: [],
          hostShell: 'available',
          hostShellVersion: 'host-job-v1',
          limitations: ['宿主执行，不是操作系统沙箱', '网络能力由宿主进程决定'],
        }}
      />,
    );
    expect(screen.getByText('工作区可写')).toBeTruthy();
    expect(screen.getByText('Host Git Bash')).toBeTruthy();
    expect(screen.getByText('宿主执行，非沙箱')).toBeTruthy();
    expect(screen.getByText('网络由宿主进程决定')).toBeTruthy();
    expect(screen.getByText('Ask')).toBeTruthy();
    expect(screen.getByText(/宿主执行，不是操作系统沙箱/)).toBeTruthy();
    expect(screen.queryByText('沙箱内命令')).toBeNull();
    expect(screen.queryByText('无网络')).toBeNull();
  });

  it('marks command execution unavailable without claiming a sandbox', () => {
    render(
      <TaskCapabilityStatus
        status={{
          active: true,
          permissionMode: 'auto_review',
          workspaceWrite: true,
          processExec: false,
          networkDomains: ['registry.npmjs.org'],
          externalCapabilities: ['report.export'],
          hostShell: 'unavailable',
        }}
      />,
    );
    expect(screen.getByText('命令执行未启用')).toBeTruthy();
    expect(screen.getByText('Auto review')).toBeTruthy();
    expect(screen.getByText(/registry\.npmjs\.org/)).toBeTruthy();
    expect(screen.getByText(/report\.export/)).toBeTruthy();
  });

  it('allows the user to revoke the whole task grant', () => {
    const onRevoke = vi.fn();
    render(
      <TaskCapabilityStatus
        status={{
          active: true,
          workspaceWrite: true,
          processExec: true,
          networkDomains: [],
          externalCapabilities: [],
          hostShell: 'available',
        }}
        onRevoke={onRevoke}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '撤销本任务权限' }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it('explains that permissions are established when a task starts', () => {
    render(<TaskCapabilityStatus status={{ active: false }} />);
    expect(screen.getByText(/发送消息后建立/)).toBeTruthy();
  });
});
