/**
 * 主 Agent 集成单测：状态栏更新 pill 与安装确认弹窗（§7.5 / §7.7 步骤 2 / D16）。
 * 关注「UI 是否真的把 Main 侧事实呈现出来、并且在没有确认前绝不安装」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { mapUpdateSummary } from '../src/App.js';
import { SettingsUpdatePane } from '../src/shell/SettingsUpdatePane.js';
import { StatusBar } from '@sparkii/ui';

afterEach(cleanup);

function stateOver(over: Record<string, unknown> = {}) {
  return {
    phase: 'idle',
    currentVersion: '0.1.0',
    baseUrl: 'http://127.0.0.1:8080/sparkii-updates/',
    autoCheck: true,
    lastCheckedAt: null,
    lastSuccessAt: null,
    remote: null,
    local: null,
    progress: null,
    choiceRequired: false,
    errorCode: null,
    stateTampered: false,
    httpWarning: false,
    pendingApprovals: 0,
    activeSessions: 0,
    ...over,
  };
}

describe('mapUpdateSummary（状态栏 pill 的唯一映射）', () => {
  it('available → 「有新版」+ 版本号；percent 为 null（不画进度条）', () => {
    const s = mapUpdateSummary(stateOver({
      phase: 'available', remote: { version: '0.3.0' },
    }));
    expect(s).toEqual({ phase: 'available', percent: null, label: '有新版', version: '0.3.0' });
  });

  it('choiceRequired → 「有 2 个可选版本」，不替用户决定', () => {
    const s = mapUpdateSummary(stateOver({
      phase: 'available', choiceRequired: true,
      remote: { version: '0.3.0' }, local: { version: '0.2.0' },
    }));
    expect(s?.label).toBe('有 2 个可选版本');
    expect(s?.version).toBe('0.3.0');
  });

  it('downloading → 百分比取自 progress，且钳制到 0..100', () => {
    const s = mapUpdateSummary(stateOver({
      phase: 'downloading', remote: { version: '0.3.0' }, progress: { percent: 34.7 },
    }));
    expect(s?.label).toBe('下载中');
    expect(s?.percent).toBe(35);
    const weird = mapUpdateSummary(stateOver({ phase: 'downloading', progress: { percent: 500 } }));
    expect(weird?.percent).toBe(100);
    const nan = mapUpdateSummary(stateOver({ phase: 'downloading', progress: { percent: 'x' } }));
    expect(nan?.percent).toBe(0);
  });

  it('readyToInstall → 「已下载完，可以安装」并显示本地版本', () => {
    const s = mapUpdateSummary(stateOver({
      phase: 'readyToInstall', local: { version: '0.2.0' },
    }));
    expect(s?.label).toBe('已下载完，可以安装');
    expect(s?.version).toBe('0.2.0');
  });

  it('其余阶段（idle / checking / installing / disabled / error / completed）一律不显示 pill', () => {
    for (const phase of ['idle', 'checking', 'installing', 'restarting', 'completed', 'rolledBack', 'error', 'disabled']) {
      expect(mapUpdateSummary(stateOver({ phase }))).toBe(null);
    }
  });

  it('脏输入（null / 非对象 / 缺 phase）不抛错，返回 null', () => {
    expect(mapUpdateSummary(null)).toBe(null);
    expect(mapUpdateSummary(undefined)).toBe(null);
    expect(mapUpdateSummary('boom')).toBe(null);
    expect(mapUpdateSummary({})).toBe(null);
  });
});

describe('StatusBar 的 update 属性（不传即完全保持现状）', () => {
  it('缺省时没有任何更新相关 DOM', () => {
    const { container } = render(<StatusBar statusText="" onOpenQueue={() => {}} />);
    expect(container.querySelector('[data-testid="statusbar-update"]')).toBe(null);
  });

  it('下载中渲染进度条与百分比', () => {
    render(<StatusBar
      statusText=""
      onOpenQueue={() => {}}
      update={{ phase: 'downloading', percent: 34, label: '下载中', version: '0.3.0' }}
    />);
    const pill = screen.getByTestId('statusbar-update');
    expect(pill.textContent).toContain('下载中');
    expect(pill.textContent).toContain('0.3.0');
    expect(pill.textContent).toContain('34%');
    expect(pill.querySelector('progress')).not.toBe(null);
  });

  it('给了 onUpdateClick 就是可聚焦按钮；没给就是纯展示 span（低打扰，不抢焦点）', () => {
    const on = vi.fn();
    const { unmount } = render(<StatusBar
      statusText=""
      onOpenQueue={() => {}}
      update={{ phase: 'readyToInstall', percent: null, label: '已下载完，可以安装', version: '0.3.0' }}
      onUpdateClick={on}
    />);
    const btn = screen.getByTestId('statusbar-update');
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    expect(on).toHaveBeenCalledTimes(1);
    unmount();

    render(<StatusBar
      statusText=""
      onOpenQueue={() => {}}
      update={{ phase: 'available', percent: null, label: '有新版', version: '0.3.0' }}
    />);
    expect(screen.getByTestId('statusbar-update').tagName).toBe('SPAN');
  });
});

function paneApi(over: Record<string, unknown> = {}) {
  return {
    getAppVersion: vi.fn().mockResolvedValue('0.1.0'),
    getUpdateState: vi.fn().mockResolvedValue(stateOver(over)),
    getUpdateSettings: vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8080/sparkii-updates/', autoCheck: true, checkIntervalHours: 24,
      checkOnStartup: true, startupDelaySeconds: 90, checkOnNetworkResume: true, checkOnSystemResume: true,
      remindIntervalHours: 24, requestTimeoutMs: 8000, autoDownload: false as const, isHttp: true,
    }),
    saveUpdateSettings: vi.fn().mockResolvedValue({ ok: true }),
    checkForUpdate: vi.fn().mockResolvedValue({ ok: true }),
    downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
    cancelDownload: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: false, reason: 'INSTALL_BLOCKED' }),
    clearDownloaded: vi.fn().mockResolvedValue({ ok: true }),
    deferUpdate: vi.fn().mockResolvedValue({ ok: true }),
    skipUpdate: vi.fn().mockResolvedValue({ ok: true }),
    resetInstallId: vi.fn().mockResolvedValue({ ok: true }),
    queryAudit: vi.fn().mockResolvedValue([]),
    on: vi.fn(() => () => {}),
    ...over,
  } as any;
}

describe('升级失败后的重启提示（§7.5「失败给明确提示 + 重试入口」）', () => {
  const failedState = () => stateOver({
    phase: 'error', errorCode: 'INSTALL_FAILED',
    local: { version: '0.3.0', bytes: 100, artifactPath: 'C:/pending/0.3.0/a.exe' },
  });

  it('显示可读告警与重试 / 删除两个入口', async () => {
    const api = paneApi({ getUpdateState: vi.fn().mockResolvedValue(failedState()) });
    render(<SettingsUpdatePane api={api} />);
    const alert = await screen.findByTestId('update-install-failed');
    expect(alert.textContent).toContain('上次升级没有成功完成');
    expect(screen.getByTestId('update-install-retry').textContent).toContain('0.3.0');
    expect(screen.getByTestId('update-install-discard')).not.toBe(null);
  });

  it('重试仍受活跃工作确认约束（不因是「重试」就跳过弹窗）', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue({ ...failedState(), activeSessions: 1 }),
    });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByTestId('update-install-retry'));
    expect(await screen.findByRole('dialog')).not.toBe(null);
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('其它 error 码（如 EXPIRED）不出「重试安装」入口，避免把坏包再推一次', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({ phase: 'error', errorCode: 'EXPIRED' })),
    });
    render(<SettingsUpdatePane api={api} />);
    expect(screen.queryByTestId('update-install-failed')).toBe(null);
    expect(screen.queryByTestId('update-install-retry')).toBe(null);
  });
});

describe('§6.6 三个设置页入口（地址 / 记录 / 重置 installId）', () => {
  it('改地址先弹二次确认；确认后才落盘并带上新值', async () => {
    const api = paneApi();
    render(<SettingsUpdatePane api={api} />);
    const input = await screen.findByLabelText('更新源地址');
    fireEvent.change(input, { target: { value: 'http://10.8.0.5/sparkii-updates/' } });
    fireEvent.click(screen.getByTestId('update-baseurl-save'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('http://10.8.0.5/sparkii-updates/');
    expect(api.saveUpdateSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('update-baseurl-confirm'));
    await waitFor(() => expect(api.saveUpdateSettings).toHaveBeenCalledWith({ baseUrl: 'http://10.8.0.5/sparkii-updates/' }));
  });

  it('取消二次确认 ⇒ 什么都不写', async () => {
    const api = paneApi();
    render(<SettingsUpdatePane api={api} />);
    fireEvent.change(await screen.findByLabelText('更新源地址'), { target: { value: 'http://1.2.3.4/x/' } });
    fireEvent.click(screen.getByTestId('update-baseurl-save'));
    fireEvent.click(await screen.findByTestId('update-baseurl-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    expect(api.saveUpdateSettings).not.toHaveBeenCalled();
  });

  it('地址未变化：给出提示且不发保存 IPC', async () => {
    const api = paneApi();
    render(<SettingsUpdatePane api={api} />);
    const input = await screen.findByLabelText('更新源地址');
    // draft 已用当前生效值播种，原样点保存即「未变化」
    expect((input as HTMLInputElement).value).toBe('http://127.0.0.1:8080/sparkii-updates/');
    fireEvent.click(screen.getByTestId('update-baseurl-save'));
    await waitFor(() => expect(api.saveUpdateSettings).not.toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('查看本地检查记录：按 resource=auto-update 查审计，并以纯文本渲染（不生成链接）', async () => {
    const api = paneApi({
      queryAudit: vi.fn().mockResolvedValue([
        { ts: 1730000000000, action: 'update.verify-failed', decision: 'deny', payloadSummary: '{"reason":"SIGNATURE_INVALID"}' },
        { ts: 1730000000001, action: 'update.available', decision: 'info', payloadSummary: '{"version":"0.3.0"}' },
      ]),
    });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByTestId('update-records-toggle'));
    await waitFor(() => expect(api.queryAudit).toHaveBeenCalledWith({ resource: 'auto-update' }));
    const box = await screen.findByTestId('update-records');
    expect(box.textContent).toContain('update.verify-failed');
    expect(box.textContent).toContain('update.available');
    // 审计内容一律纯文本：不得出现可点击链接 / iframe / 远程资源
    expect(box.querySelector('a')).toBe(null);
    expect(box.querySelector('iframe')).toBe(null);
    // 再点一次收起
    fireEvent.click(screen.getByTestId('update-records-toggle'));
    expect(screen.queryByTestId('update-records')).toBe(null);
  });

  it('记录为空也如实显示「暂无」，不伪造历史', async () => {
    const api = paneApi({ queryAudit: vi.fn().mockResolvedValue([]) });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByTestId('update-records-toggle'));
    expect((await screen.findByTestId('update-records')).textContent).toContain('暂无本地检查记录');
  });

  it('重置检查标识：调用 Main 侧方法（本地动作，不发网络检查）', async () => {
    const api = paneApi({ resetInstallId: vi.fn().mockResolvedValue({ ok: true, message: '已重置' }) });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByTestId('update-reset-installid'));
    await waitFor(() => expect(api.resetInstallId).toHaveBeenCalledTimes(1));
    expect(api.checkForUpdate).not.toHaveBeenCalled();
  });

  it('缺 resetInstallId / queryAudit 的老 mock：入口禁用而不是抛错', async () => {
    const api = paneApi();
    delete api.queryAudit;
    delete api.resetInstallId;
    render(<SettingsUpdatePane api={api} />);
    expect((await screen.findByTestId('update-reset-installid') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('update-records-toggle'));
    expect(screen.queryByRole('dialog')).toBe(null);
  });
});

describe('安装确认弹窗（§7.5 · B 关验收①）', () => {
  it('有活跃会话或待审批：点安装只弹确认，绝不直接发 installUpdate', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'readyToInstall',
        local: { version: '0.3.0', bytes: 401_196_487, artifactPath: 'C:/pending/0.3.0/a.exe' },
        activeSessions: 2,
        pendingApprovals: 3,
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    const install = await screen.findByRole('button', { name: '安装' });
    fireEvent.click(install);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('可能丢失未完成的工作');
    expect(dialog.textContent).toContain('2 个');
    expect(dialog.textContent).toContain('3 个');
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('取消：不发安装 IPC、包保留、弹窗关闭后仍可再点安装', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'readyToInstall', local: { version: '0.3.0' }, activeSessions: 1,
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    fireEvent.click(await screen.findByTestId('update-confirm-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(api.clearDownloaded).not.toHaveBeenCalled();
    // 状态未变，仍可安装（不丢包）
    expect(await screen.findByRole('button', { name: '安装' })).not.toBe(null);
  });

  it('确认继续：带上用户选定的版本号发一次 installUpdate', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'readyToInstall', local: { version: '0.3.0' }, activeSessions: 1,
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    fireEvent.click(await screen.findByTestId('update-confirm-ok'));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ version: '0.3.0' }));
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('无活跃工作：点安装直接开始，不额外弹窗（§7.5）', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'readyToInstall', local: { version: '0.3.0' },
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '安装' }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ version: '0.3.0' }));
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('二选一里的「安装已下载的 0.2」同样受确认约束，且选定后另一条按钮被禁用', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'available', choiceRequired: true,
        local: { version: '0.2.0' }, remote: { version: '0.3.0' },
        activeSessions: 1,
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    const localBtn = await screen.findByRole('button', { name: /安装已下载的 0.2/ });
    fireEvent.click(localBtn);
    // 弹确认，而不是直接安装
    expect(await screen.findByRole('dialog')).not.toBe(null);
    expect(api.installUpdate).not.toHaveBeenCalled();
    // 已选本地 → 远端下载按钮此时必须禁用（不得同时下载/安装两个版本）
    expect((screen.getByRole('button', { name: /跳过本地，升级到 0.3/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tampered 状态：所有动作禁用并给出「需手动恢复」提示，绝不静默放行', async () => {
    const api = paneApi({
      getUpdateState: vi.fn().mockResolvedValue(stateOver({
        phase: 'error', stateTampered: true, errorCode: 'STATE_TAMPERED',
        local: { version: '0.3.0' },
      })),
    });
    render(<SettingsUpdatePane api={api} />);
    expect((await screen.findByRole('alert')).textContent).toContain('需手动恢复');
    const install = screen.queryByRole('button', { name: '安装' });
    if (install) {
      fireEvent.click(install);
      expect(api.installUpdate).not.toHaveBeenCalled();
    }
  });
});
