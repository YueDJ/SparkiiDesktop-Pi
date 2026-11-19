import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';
import { SettingsUpdatePane } from '../src/shell/SettingsUpdatePane.js';
import { UpdateDialog } from '../src/shell/UpdateDialog.js';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  localStorage.removeItem('sparkii-theme');
  vi.restoreAllMocks();
});

function baseApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      activeProviderId: 'deepseek',
      maxAgents: 4,
      queueEnabled: true,
      chatDetailLevel: 'standard',
      logLevel: 'info',
      documentParse: { idleMinutes: 5, keepResident: false },
      rag: { baseUrl: 'http://127.0.0.1:9380', hasApiKey: false, bindings: [], similarityThreshold: 0.2, vectorSimilarityWeight: 0.3 },
      sparkiionto: { baseUrl: 'http://127.0.0.1:9380', hasToken: false, bindings: [], similarityThreshold: 0.2 },
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
    ]),
    getApiKey: vi.fn().mockResolvedValue(''),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    diagnostics: vi.fn().mockResolvedValue({ logs: '' }),
    listDocumentParseModules: vi.fn().mockResolvedValue([]),
    getDocumentParse: vi.fn().mockResolvedValue({ status: 'stopped', waiting: [] }),
    retryDocumentParse: vi.fn().mockResolvedValue({ ok: true }),
    importDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    downloadDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    saveDocumentParseSettings: vi.fn().mockResolvedValue({ ok: true }),
    listAgents: vi.fn().mockResolvedValue([]),
    queryAudit: vi.fn().mockResolvedValue([]),
    getAppVersion: vi.fn().mockResolvedValue('0.1.4'),
    getUpdateState: vi.fn().mockResolvedValue({
      phase: 'idle', currentVersion: '0.1.4', baseUrl: 'http://localhost/sparkii-updates/',
      autoCheck: true, lastCheckedAt: null, lastSuccessAt: null, remote: null, local: null,
      progress: null, choiceRequired: false, errorCode: null, stateTampered: false,
      httpWarning: true, pendingApprovals: 0, activeSessions: 0,
    }),
    getUpdateSettings: vi.fn().mockResolvedValue({
      baseUrl: 'http://localhost/sparkii-updates/', autoCheck: true, checkIntervalHours: 24,
      checkOnStartup: true, startupDelaySeconds: 90, checkOnNetworkResume: true,
      checkOnSystemResume: true, remindIntervalHours: 24, requestTimeoutMs: 8000,
      autoDownload: false as const, isHttp: true,
    }),
    saveUpdateSettings: vi.fn().mockResolvedValue({ ok: true }),
    checkForUpdate: vi.fn().mockResolvedValue({ ok: true }),
    downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
    cancelDownload: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    clearDownloaded: vi.fn().mockResolvedValue({ ok: true }),
    deferUpdate: vi.fn().mockResolvedValue({ ok: true }),
    skipUpdate: vi.fn().mockResolvedValue({ ok: true }),
    resetInstallId: vi.fn().mockResolvedValue({ ok: true }),
    on: vi.fn(() => () => {}),
    ...over,
  } as any;
}

const FORBIDDEN_COPY = [
  /SmartScreen/,
  /未购买代码签名证书/,
  /由数字签名保证/,
  /静态清单/,
  /零身份信息/,
  /installId/,
  /二次比对/,
  /不会调用任何业务接口/,
  /记录一条审计/,
  /更新完整性/,
];

async function collectPaneText(api: any, pane: string): Promise<string> {
  render(<SettingsView api={api} />);
  await screen.findByText('已加载本机配置');
  fireEvent.click(screen.getByRole('button', { name: pane }));
  const text = document.body.textContent ?? '';
  cleanup();
  return text;
}

describe('settings redesign', () => {
  it('主题在设置页真实生效并持久化（与顶栏共用同一份状态）', async () => {
    render(<SettingsView api={baseApi()} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    fireEvent.click(screen.getByLabelText('主题'));
    fireEvent.click(screen.getByRole('menuitem', { name: '深色' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('sparkii-theme')).toBe('dark');
  });

  it('删除假控件：没有崩溃自动恢复 / 界面语言 / 数据与隐私 / 审批与安全', async () => {
    render(<SettingsView api={baseApi()} />);
    await screen.findByText('已加载本机配置');
    for (const name of ['数据与隐私', '审批与安全']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: '智能体与运行' }));
    expect(screen.queryByText('崩溃自动恢复')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    expect(screen.queryByText('界面语言')).toBeNull();
  });

  it('底部保存栏：改动后显示未保存，保存成功后归零', async () => {
    const api = baseApi();
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');

    fireEvent.click(screen.getByTestId('default-thinking-select'));
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    expect(screen.getByText('有未保存的更改')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(await screen.findByText('设置已保存')).toBeTruthy();
  });

  it('切换页面时拦截未保存改动；取消则留在原页', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsView api={baseApi()} />);
    await screen.findByText('已加载本机配置');

    fireEvent.click(screen.getByTestId('default-thinking-select'));
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));

    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '大模型连接' })).toBeTruthy();
  });

  it('设置页不再出现签名 / 静态清单 / 身份信息 / 审计机制说明', async () => {
    for (const pane of ['关于', '软件更新', '智能体与运行', '文档解析']) {
      const text = await collectPaneText(baseApi(), pane);
      for (const pattern of FORBIDDEN_COPY) {
        expect(text, `${pane} 命中 ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('更新对话框不再解释 HTTP 与签名机制', () => {
    render(<UpdateDialog
      open
      state={{
        phase: 'available', currentVersion: '0.1.4', baseUrl: 'http://localhost/sparkii-updates/',
        autoCheck: true, lastCheckedAt: null, lastSuccessAt: null,
        remote: { version: '0.1.5', summary: 's', highlights: [], bytes: 1, sequence: 6, minSupportedVersion: '0.1.0', allowDowngrade: false, publishedAt: '', expiresAt: '', nonce: 'n' },
        local: null, progress: null, choiceRequired: false, errorCode: null,
        stateTampered: false, httpWarning: true, pendingApprovals: 0, activeSessions: 0,
      } as any}
      api={baseApi()}
      onClose={() => {}}
    />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/数字签名/);
    expect(text).not.toMatch(/HTTP 更新源/);
    expect(text).not.toMatch(/签名校验/);
  });
});

describe('software update dev-mode state', () => {
  it('未打包的 NOT_READY 显示“仅安装版可用”，不再显示“更新异常”', async () => {
    const api = baseApi({
      getUpdateState: vi.fn().mockResolvedValue({
        phase: 'error', currentVersion: '0.1.6', baseUrl: 'http://localhost/sparkii-updates/',
        autoCheck: false, lastCheckedAt: null, lastSuccessAt: null, remote: null, local: null,
        progress: null, choiceRequired: false, errorCode: 'NOT_READY', stateTampered: false,
        httpWarning: false, pendingApprovals: 0, activeSessions: 0,
      }),
    });
    render(<SettingsUpdatePane api={api} />);
    expect(await screen.findByText('仅安装版可用')).toBeTruthy();
    expect(screen.queryByText('更新异常')).toBeNull();
  });
});

describe('software update save model', () => {
  it('自动检查纳入底部保存栏：开关只改草稿，保存时才落盘', async () => {
    const api = baseApi();
    render(<SettingsUpdatePane api={api} />);
    const toggle = await screen.findByRole('switch', { name: '自动检查' });

    fireEvent.click(toggle);
    expect(api.saveUpdateSettings).not.toHaveBeenCalled();
    expect(screen.getByText('有未保存的更改')).toBeTruthy();

    fireEvent.click(screen.getByTestId('update-baseurl-save'));
    await waitFor(() => expect(api.saveUpdateSettings).toHaveBeenCalledWith({ autoCheck: false }));
  });

  it('失败原因用一句人话，不直接暴露代码', async () => {
    const api = baseApi({ checkForUpdate: vi.fn().mockResolvedValue({ ok: false, reason: 'BACKOFF' }) });
    render(<SettingsUpdatePane api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '立即检查更新' }));
    expect(await screen.findByText('刚刚检查过，请稍后再试')).toBeTruthy();
  });
});
