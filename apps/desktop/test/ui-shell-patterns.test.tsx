import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AgentNav, StatusBar, Shell } from '@sparkii/ui';

afterEach(cleanup);

describe('ui shell patterns', () => {
  it('agent nav has no idle dot', () => {
    render(<AgentNav agents={[{ id: 'contract', name: '合同审核', status: 'idle' }]} active="contract" onNavigate={vi.fn()} />);
    expect(screen.queryByText('●')).toBeNull();
    expect(screen.getByText('合同审核')).toBeTruthy();
  });

  it('status bar shows running and queued counts', () => {
    render(<StatusBar statusText="就绪" runningCount={1} queueCount={2} maxAgents={4} onOpenQueue={vi.fn()} />);
    expect(screen.getByText(/运行 1\/4 · 2 排队/)).toBeTruthy();
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
