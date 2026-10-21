import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskCapabilityStatus } from '../src/trust/TaskCapabilityStatus.js';

describe('TaskCapabilityStatus', () => {
  it('shows concise active capability state and sandbox limitation', () => {
    render(
      <TaskCapabilityStatus
        status={{
          active: true,
          mode: 'standard',
          workspaceRoot: 'C:/work/project',
          workspaceWrite: true,
          processExec: false,
          networkDomains: [],
          externalCapabilities: [],
          sandbox: 'partial',
          sandboxVersion: 'appcontainer-v1',
          limitations: ['Git Bash cannot start'],
        }}
      />,
    );
    expect(screen.getByText('工作区可写')).toBeTruthy();
    expect(screen.getByText('命令执行未启用')).toBeTruthy();
    expect(screen.getByText('无网络')).toBeTruthy();
    expect(screen.getByText('外部系统未授权')).toBeTruthy();
    expect(screen.getByText(/Git Bash cannot start/)).toBeTruthy();
  });

  it('allows the user to revoke the whole task grant', () => {
    const onRevoke = vi.fn();
    render(
      <TaskCapabilityStatus
        status={{
          active: true,
          workspaceWrite: true,
          processExec: true,
          networkDomains: ['registry.npmjs.org'],
          externalCapabilities: [],
          sandbox: 'available',
        }}
        onRevoke={onRevoke}
      />,
    );
    expect(screen.getByText(/registry\.npmjs\.org/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销本任务权限' }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it('explains that permissions are established when a task starts', () => {
    render(<TaskCapabilityStatus status={{ active: false }} />);
    expect(screen.getByText(/发送消息后建立/)).toBeTruthy();
  });
});
