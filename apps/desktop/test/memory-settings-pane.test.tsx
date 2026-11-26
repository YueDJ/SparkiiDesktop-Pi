import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SETTINGS = {
  enabled: true,
  autoExtract: true,
  idleConsolidation: true,
  halfLifeDays: { user: 180, agent: 90, project: 60, episode: 14 },
  budgets: { user: 500, agent: 300, project: 800 },
  extractionDebounceMs: 90_000,
  minUserTurns: 3,
  consolidateIdleMinutes: 10,
  consolidateIntervalHours: 24,
};

function makeApi() {
  let call = 0;
  const api = {
    getSettings: vi.fn().mockResolvedValue({}),
    listAgents: vi.fn().mockResolvedValue([{ id: 'general', name: '通用' }]),
    listMemories: vi.fn().mockImplementation(async () => ({
      scopes: call++ === 0 ? [] : [{
        scope: 'user', kind: 'user', label: '用户记忆', entries: [{
          id: 'mem_1', text: '用户要求先给结论', status: 'active', pinned: false,
          importance: 2, createdAt: Date.now(), updatedAt: Date.now(), source: null,
          supersededBy: null, pendingOp: null, scope: 'user',
          usage: { lastAccessedAt: null, accessCount: 1 }, sourceDeleted: false,
        }],
      }],
      pending: [], agents: [{ id: 'general', name: '通用' }], projects: [],
      settings: SETTINGS, ftsAvailable: true, warnings: [],
    })),
    addMemory: vi.fn().mockResolvedValue({}),
    saveMemorySettings: vi.fn().mockImplementation(async (partial) => ({ ...SETTINGS, ...partial })),
    searchMemory: vi.fn().mockResolvedValue([]),
  };
  return api;
}

describe('settings — memory pane', () => {
  it('导航有「记忆」；显示隐私明示；手动新增走 IPC', async () => {    const api = makeApi();
    render(<SettingsView api={api as never} initialPane="memory" />);
    expect(screen.getAllByText('记忆').length).toBeGreaterThan(0);
    await waitFor(() => expect(api.listMemories).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByText('自动提炼会将对话内容发送给你配置的大模型。关闭后仅手动记忆可用。'),
    ).toBeTruthy());
    fireEvent.change(screen.getByLabelText('记忆内容'), { target: { value: '用户要求先给结论' } });
    fireEvent.click(screen.getByRole('button', { name: '添加记忆' }));
    await waitFor(() => expect(api.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user', text: '用户要求先给结论',
    })));
    await waitFor(() => expect(screen.getAllByText('用户要求先给结论').length).toBeGreaterThan(0));
  });

  it('损坏项目的修复草稿、空重建和覆盖修复按各自工作区隔离且需确认', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const repairProjectMemory = vi.fn().mockResolvedValue({ ok: true });
    const scopes = ['/ws/a', '/ws/b'].map((workspacePath, index) => ({
      scope: `project:proj_${index}`, kind: 'project', label: `项目 ${index}`, projectId: `proj_${index}`,
      workspacePath, corrupt: true, entries: [],
    }));
    const api = {
      ...makeApi(),
      listMemories: vi.fn().mockResolvedValue({
        scopes, pending: [], agents: [{ id: 'general', name: '通用' }], projects: [],
        settings: SETTINGS, ftsAvailable: true, warnings: [],
      }),
      repairProjectMemory,
    };
    render(<SettingsView api={api as never} initialPane="memory" />);
    await waitFor(() => expect(screen.getAllByText('该项目的记忆内容无法读取，已暂停使用。确认后可重新整理。')).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: '重新整理' })[0]);
    expect(confirm).toHaveBeenCalled();
    expect(repairProjectMemory).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: '重新整理' })[0]);
    await waitFor(() => expect(repairProjectMemory).toHaveBeenCalledWith('/ws/a', 'empty'));
    await screen.findByText('已重新整理');
    repairProjectMemory.mockClear();
    confirm.mockClear();

    const areas = screen.getAllByLabelText('修复内容');
    fireEvent.change(areas[1], { target: { value: 'B 的修复内容' } });
    confirm.mockReturnValue(false);
    fireEvent.click(screen.getAllByRole('button', { name: '按提供内容修复' })[1]);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('覆盖'));
    expect(repairProjectMemory).not.toHaveBeenCalled();

    fireEvent.change(areas[0], { target: { value: 'A 的修复草稿' } });
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: '按提供内容修复' })[0]);
    await waitFor(() => expect(repairProjectMemory).toHaveBeenCalledWith('/ws/a', 'replace', 'A 的修复草稿'));
    expect(repairProjectMemory).toHaveBeenCalledTimes(1);
    await screen.findByText('已按提供内容修复');
    expect(screen.getAllByLabelText('修复内容').map((area) => (area as HTMLTextAreaElement).value)).toEqual([
      'A 的修复草稿', 'B 的修复内容',
    ]);
  });

  it('面板开着时收到 pending_added 事件：当场重新拉取，新候选立刻出现在待确认区', async () => {
    const handlers: Array<(payload: unknown) => void> = [];
    let round = 0;
    const pendingEntry = {
      id: 'mem_p1', text: '用户要求报价单只给总价', status: 'pending', pinned: false,
      importance: 2, createdAt: Date.now(), updatedAt: Date.now(), source: null,
      supersededBy: null, pendingOp: { op: 'ADD', proposedText: '用户要求报价单只给总价' },
      scope: 'user', usage: { lastAccessedAt: null, accessCount: 0 }, sourceDeleted: false,
    };
    const api = {
      ...makeApi(),
      on: vi.fn((channel: string, cb: (payload: unknown) => void) => {
        if (channel === 'memory-event') handlers.push(cb);
        return () => {};
      }),
      listMemories: vi.fn().mockImplementation(async () => ({
        scopes: [],
        pending: round++ === 0 ? [] : [pendingEntry],
        agents: [{ id: 'general', name: '通用' }],
        projects: [],
        settings: SETTINGS,
        ftsAvailable: true,
        warnings: [],
      })),
    };
    render(<SettingsView api={api as never} initialPane="memory" />);
    await waitFor(() => expect(api.listMemories).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('用户要求报价单只给总价')).toBeNull();

    act(() => { handlers.forEach((h) => h({ type: 'pending_added', id: 'mem_p1', scope: 'user' })); });

    await waitFor(() => expect(screen.getByText('用户要求报价单只给总价')).toBeTruthy());
    expect(api.listMemories.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
