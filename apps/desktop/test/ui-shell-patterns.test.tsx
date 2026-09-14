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
    const { container } = render(
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
    expect(container.querySelectorAll('.ui-runtime-meter .is-run')).toHaveLength(1);
    expect(container.querySelectorAll('.ui-runtime-meter .is-wait')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '运行 1，排队 1，空闲 3' })).toBeTruthy();
    expect(screen.queryByText('运行 1/4 · 排队 1 · 空闲 3')).toBeNull();
    expect(screen.queryByText('运行中')).toBeNull();
    expect(screen.queryByText('排队中')).toBeNull();
    expect(screen.queryByText('暂无运行中的智能体')).toBeNull();
    fireEvent.click(screen.getByText('停止'));
    fireEvent.click(screen.getByText('确认停止'));
    expect(onStop).toHaveBeenCalledWith('s1');
    expect(screen.getByRole('button', { name: '释放线程' })).toBeTruthy();
    expect(screen.getByLabelText('第 1 位')).toBeTruthy();
    expect(screen.queryByText('第 1 位')).toBeNull();
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

  it('keeps agent slot counts when document parse is busy', () => {
    render(
      <StatusBar
        statusText="就绪"
        runtimePool={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
        documentParse={{ status: 'parsing', fileName: 'scan.pdf', agentDisplayName: '合同审核智能体', page: 3, total: 12, waiting: [] }}
        onOpenQueue={vi.fn()}
      />,
    );
    expect(screen.getByText(/运行 1\/4/)).toBeTruthy();
    expect(screen.getByText(/文档解析进行中/)).toBeTruthy();
    expect(screen.queryByText(/运行 2\/4/)).toBeNull();
    expect(screen.queryByText(/worker/i)).toBeNull();
  });

  it('keeps agent 释放线程 distinct from parse 释放', () => {
    const idleSnap = { status: 'idle' as const, idleRemainingSec: 120, waiting: [] };
    const { rerender } = render(
      <RuntimeCenter
        snapshot={{ active: 0, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
        documentParse={idleSnap}
        onStop={vi.fn()}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
        onStopParse={vi.fn()}
        onReleaseParse={vi.fn()}
        onCancelLoad={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '文档解析' })).toBeTruthy();
    expect(screen.getByText('暂无智能体占用')).toBeTruthy();
    expect(screen.getByText('空闲')).toBeTruthy();
    expect(screen.getByText('2分钟后释放')).toBeTruthy();
    expect(screen.getByRole('button', { name: '释放' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '释放线程' })).toBeNull();

    rerender(
      <RuntimeCenter
        snapshot={{
          active: 1, queued: 0, maxAgents: 4,
          sessions: [{ sessionId: 's1', profileId: 'general', profileName: '通用智能体', label: '会话#1', status: 'running' }],
          queue: [],
        }}
        documentParse={{ status: 'starting', waiting: [] }}
        onStop={vi.fn()}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
        onStopParse={vi.fn()}
        onReleaseParse={vi.fn()}
        onCancelLoad={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '释放线程' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消加载' })).toBeTruthy();
    expect(screen.getByText('正在加载')).toBeTruthy();
  });

  it('does not show parse-in-progress on the status bar when idle', () => {
    render(
      <StatusBar
        statusText="就绪"
        runtimePool={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
        documentParse={{ status: 'idle', idleRemainingSec: 120, waiting: [] }}
        onOpenQueue={vi.fn()}
      />,
    );
    expect(screen.getByText(/运行 1\/4 · 0 排队/)).toBeTruthy();
    expect(screen.queryByText(/文档解析进行中/)).toBeNull();
  });

  it('shows parsing progress and waiting files without internal names', () => {
    const parse = {
      status: 'parsing' as const,
      fileName: 'scan.pdf',
      agentDisplayName: '合同审核智能体',
      page: 3,
      total: 12,
      waiting: [{ sessionId: 's2', agentDisplayName: '通用智能体', fileName: 'invoice.jpg' }],
    };
    const { container } = render(
      <RuntimeCenter
        snapshot={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
        documentParse={parse}
        onStop={vi.fn()}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
        onStopParse={vi.fn()}
        onReleaseParse={vi.fn()}
        onCancelLoad={vi.fn()}
      />,
    );
    expect(screen.getByText('scan.pdf')).toBeTruthy();
    expect(screen.getByText('正在解析')).toBeTruthy();
    expect(screen.getByText('第 3/12 页')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '解析进度' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止解析' })).toBeTruthy();
    expect(screen.queryByText('等待中的文件')).toBeNull();
    expect(screen.getByText('invoice.jpg')).toBeTruthy();
    expect(screen.getByText('通用智能体')).toBeTruthy();
    expect(container.textContent).not.toMatch(/worker|sidecar|OCR|Paddle|JSON-RPC|两套占用|单独一路/i);
  });

  it('covers stopped, resident, and overflow queue on the meter', () => {
    const { rerender } = render(
      <RuntimeCenter
        snapshot={{ active: 0, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
        documentParse={{ status: 'stopped', waiting: [] }}
        onStop={vi.fn()}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
      />,
    );
    expect(screen.getByText('未启动')).toBeTruthy();

    rerender(
      <RuntimeCenter
        snapshot={{
          active: 4,
          queued: 2,
          maxAgents: 4,
          sessions: [
            { sessionId: 's1', profileId: 'a', profileName: 'A', label: '1', status: 'running' },
            { sessionId: 's2', profileId: 'b', profileName: 'B', label: '2', status: 'running' },
            { sessionId: 's3', profileId: 'c', profileName: 'C', label: '3', status: 'running' },
            { sessionId: 's4', profileId: 'd', profileName: 'D', label: '4', status: 'running' },
          ],
          queue: [
            { queueId: 'q1', profileId: 'e', profileName: 'E', label: '5', position: 1 },
            { queueId: 'q2', profileId: 'f', profileName: 'F', label: '6', position: 2 },
          ],
        }}
        documentParse={{ status: 'resident', waiting: [] }}
        onStop={vi.fn()}
        onRelease={vi.fn()}
        onCancelQueue={vi.fn()}
      />,
    );
    expect(screen.getByText('常驻')).toBeTruthy();
    expect(screen.getByRole('img', { name: '运行 4，排队 2，空闲 0' })).toBeTruthy();
    expect(document.querySelectorAll('.ui-runtime-meter span')).toHaveLength(4);
  });
});
