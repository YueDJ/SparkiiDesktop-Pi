/**
 * 更新详情对话框：状态栏徽标的落点。只验证「呈现 Main 侧事实 + 动作确实发出」，
 * 不模拟安装结果（安装由 Main 侧与 watchdog 负责）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { UpdateDialog } from '../src/shell/UpdateDialog.js';

afterEach(cleanup);

function stateOver(over: Record<string, unknown> = {}) {
  return {
    phase: 'available',
    currentVersion: '0.1.1',
    baseUrl: 'http://127.0.0.1:8080/sparkii-updates/',
    autoCheck: true,
    lastCheckedAt: null,
    lastSuccessAt: null,
    remote: {
      version: '0.1.2',
      sequence: 3,
      nonce: 'nonce',
      publishedAt: '2026-11-09T00:00:00Z',
      expiresAt: '2026-12-09T00:00:00Z',
      summary: '内部测试版：更新界面重构',
      highlights: ['状态栏更新徽标', '更宽的更新源地址'],
      bytes: 430_618_928,
      minSupportedVersion: '0.1.0',
      allowDowngrade: false,
    },
    local: null,
    progress: null,
    choiceRequired: false,
    errorCode: null,
    stateTampered: false,
    httpWarning: false,
    pendingApprovals: 0,
    activeSessions: 0,
    ...over,
  } as any;
}

function makeApi(over: Record<string, unknown> = {}) {
  return {
    checkForUpdate: vi.fn().mockResolvedValue({ ok: true }),
    downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
    cancelDownload: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    clearDownloaded: vi.fn().mockResolvedValue({ ok: true }),
    deferUpdate: vi.fn().mockResolvedValue({ ok: true }),
    skipUpdate: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as any;
}

describe('UpdateDialog', () => {
  it('available：展示版本与发布说明，点「立即下载」发一次 downloadUpdate', async () => {
    const api = makeApi();
    render(<UpdateDialog open state={stateOver()} api={api} onClose={() => {}} />);
    expect(screen.getByText('发现新版本 0.1.2')).not.toBe(null);
    expect(screen.getByText('状态栏更新徽标')).not.toBe(null);
    expect(screen.getByText('更宽的更新源地址')).not.toBe(null);
    fireEvent.click(screen.getByRole('button', { name: '立即下载' }));
    await waitFor(() => expect(api.downloadUpdate).toHaveBeenCalledWith({ version: '0.1.2' }));
  });

  it('downloading：进度条与百分比来自 Main 侧 progress，「取消下载」发 cancelDownload', async () => {
    const api = makeApi();
    render(<UpdateDialog open state={stateOver({
      phase: 'downloading',
      progress: { percent: 42, bytesDownloaded: 42 * 1024 * 1024, bytesTotal: 100 * 1024 * 1024, savePath: null },
    })} api={api} onClose={() => {}} />);
    const bar = screen.getByRole('progressbar', { name: '更新下载进度' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).not.toBe(null);
    expect(screen.getByText('42.0 MB / 100.0 MB')).not.toBe(null);
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }));
    await waitFor(() => expect(api.cancelDownload).toHaveBeenCalledTimes(1));
  });

  it('下载中「取消下载」始终可点，不因下载请求仍在进行而被禁用', async () => {
    const api = makeApi({ downloadUpdate: vi.fn(() => new Promise(() => {})) });
    const { rerender } = render(<UpdateDialog open state={stateOver()} api={api} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '立即下载' }));
    rerender(<UpdateDialog open state={stateOver({
      phase: 'downloading',
      progress: { percent: 10, bytesDownloaded: 10, bytesTotal: 100, savePath: null },
    })} api={api} onClose={() => {}} />);
    const cancel = screen.getByRole('button', { name: '取消下载' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
  });

  it('readyToInstall：安装前明确告知会重启；无活跃工作时一次点击即安装', async () => {
    const api = makeApi();
    render(<UpdateDialog open state={stateOver({
      phase: 'readyToInstall', remote: null,
      local: { version: '0.1.2', sequence: 3, nonce: 'n', artifactPath: 'C:/pending/a.exe', bytes: 1, sha512: 'x', expiresAt: '', valid: true },
    })} api={api} onClose={() => {}} />);
    expect(screen.getByText('新版本 0.1.2 已就绪')).not.toBe(null);
    expect(screen.getByText('安装后 Sparkii 会自动重启')).not.toBe(null);
    fireEvent.click(screen.getByRole('button', { name: '立即安装并重启' }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ version: '0.1.2' }));
  });

  it('有活跃会话：第一次点击只展开风险提示，第二次点击才安装', async () => {
    const api = makeApi();
    render(<UpdateDialog open state={stateOver({
      phase: 'readyToInstall', remote: null, activeSessions: 2, pendingApprovals: 1,
      local: { version: '0.1.2', sequence: 3, nonce: 'n', artifactPath: 'C:/pending/a.exe', bytes: 1, sha512: 'x', expiresAt: '', valid: true },
    })} api={api} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '立即安装并重启' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('活跃会话：2 个');
    expect(alert.textContent).toContain('待审批项：1 个');
    expect(api.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '仍要安装并重启' }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledWith({ version: '0.1.2' }));
  });

  it('安装被 Main 侧拒绝：如实显示原因，不假装成功', async () => {
    const api = makeApi({ installUpdate: vi.fn().mockResolvedValue({ ok: false, reason: 'INSTALL_BLOCKED' }) });
    render(<UpdateDialog open state={stateOver({
      phase: 'readyToInstall', remote: null,
      local: { version: '0.1.2', sequence: 3, nonce: 'n', artifactPath: 'C:/pending/a.exe', bytes: 1, sha512: 'x', expiresAt: '', valid: true },
    })} api={api} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '立即安装并重启' }));
    expect((await screen.findByRole('status')).textContent).toContain('INSTALL_BLOCKED');
  });

  it('tampered：只提供关闭，不出现任何安装/下载入口', async () => {
    render(<UpdateDialog open state={stateOver({ stateTampered: true })} api={makeApi()} onClose={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('需手动恢复');
    expect(screen.queryByRole('button', { name: '立即下载' })).toBe(null);
    expect(screen.queryByRole('button', { name: '立即安装并重启' })).toBe(null);
  });
});
