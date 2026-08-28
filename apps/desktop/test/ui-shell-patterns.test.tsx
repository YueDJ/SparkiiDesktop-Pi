import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AgentNav, RuntimeCenter, StatusBar, Shell } from '@sparkii/ui';

afterEach(cleanup);

describe('ui shell patterns', () => {
  it('agent nav has no idle dot', () => {
    render(<AgentNav agents={[{ id: 'contract', name: '合同审核', status: 'idle' }]} active="contract" onNavigate={vi.fn()} />);
    expect(screen.queryByText('●')).toBeNull();
    expect(screen.getByText('合同审核')).toBeTruthy();
  });

  it('status bar shows running and queued counts', () => {
    render(<StatusBar statusText="就绪" runtimePool={{ active: 1, queued: 2, maxAgents: 4, sessions: [], queue: [] }} onOpenQueue={vi.fn()} />);
    expect(screen.getByText(/运行 1\/4 · 2 排队/)).toBeTruthy();
  });

  it('runtime center renders running and queued items and invokes actions', () => {
    const onStop = vi.fn();
    render(
      <RuntimeCenter
        snapshot={{
          active: 1,
          queued: 1,
          maxAgents: 4,
          sessions: [{ sessionId: 's1', profileId: 'general', profileName: '通用智能体', label: '会话#1', status: 'running' }],
          queue: [{ queueId: 'q1', profileId: 'contract-review', profileName: '合同审核', label: '新会话', position: 1 }],
        }}
        onStop={onStop}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
      />,
    );
    expect(screen.getByText('运行 1/4 · 排队 1 · 空闲 3')).toBeTruthy();
    fireEvent.click(screen.getByText('停止'));
    fireEvent.click(screen.getByText('确认停止'));
    expect(onStop).toHaveBeenCalledWith('s1');
    expect(screen.getByText('合同审核 · 新会话 · 第 1 位')).toBeTruthy();
  });

  it('shell renders topbar, rail, status bar and surface', () => {
    render(
      <Shell
        active="contract"
        agents={[{ id: 'contract', name: '合同审核', status: 'running' }]}
        sessions={{ contract: [{ id: 's1', name: '会话#1', state: '比对中', time: '今天' }] }}
        pendingApprovals={0}
        statusText="正在比对 12 条"
        onNavigate={vi.fn()}
        onNewSession={vi.fn()}
      >
        <div data-testid="surface">surface</div>
      </Shell>
    );
    expect(screen.getByText('Sparkii')).toBeTruthy();
    expect(screen.getByText('正在比对 12 条')).toBeTruthy();
    expect(screen.getByTestId('surface')).toBeTruthy();
  });
});
