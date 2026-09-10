import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      activeProviderId: 'deepseek',
      documentParse: { idleMinutes: 5, keepResident: false },
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    saveDocumentParseSettings: vi.fn().mockResolvedValue({ ok: true }),
    listDocumentParseModules: vi.fn().mockResolvedValue([
      { id: 'baseline', label: '基础解析', bundled: true, installed: true, canDownload: false },
      { id: 'seal', label: '印章', bundled: false, installed: false, canDownload: false },
      { id: 'formula', label: '公式', bundled: false, installed: false, canDownload: false },
      { id: 'chart', label: '图表', bundled: false, installed: false, canDownload: false },
    ]),
    retryDocumentParse: vi.fn().mockResolvedValue({ ok: true }),
    importDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    downloadDocumentParseModule: vi.fn().mockResolvedValue({ ok: false, error: '网络不可达，请改用导入离线包。' }),
    getDocumentParse: vi.fn().mockResolvedValue({ status: 'stopped', waiting: [] }),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
    ]),
    getApiKey: vi.fn().mockResolvedValue(''),
    ...over,
  } as any;
}

async function openPane(over: Record<string, unknown> = {}) {
  const api = makeApi(over);
  render(<SettingsView api={api} />);
  fireEvent.click(screen.getByRole('button', { name: '文档解析' }));
  await screen.findByRole('heading', { name: '文档解析' });
  return api;
}

describe('Settings document parse pane', () => {
  it('has a nav button 文档解析', () => {
    render(<SettingsView api={makeApi()} />);
    expect(screen.getByRole('button', { name: '文档解析' })).toBeTruthy();
  });

  it('shows idle, resident, reload, and module names', async () => {
    await openPane();
    expect(screen.getByText(/空闲/)).toBeTruthy();
    expect(screen.getByText(/常驻/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
    expect(screen.getByText('基础解析')).toBeTruthy();
    expect(screen.getByText('印章')).toBeTruthy();
  });

  it('saves via saveDocumentParseSettings not saveSettings', async () => {
    const api = await openPane();
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(api.saveDocumentParseSettings).toHaveBeenCalled());
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.saveDocumentParseSettings).toHaveBeenCalledWith({ idleMinutes: 5, keepResident: false });
  });

  it('has no 关掉文档解析 switch', async () => {
    await openPane();
    expect(screen.queryByText('关掉文档解析')).toBeNull();
  });

  it('does not mention worker, OCR, Paddle, or JSON-RPC', async () => {
    await openPane();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/worker|sidecar|OCR|Paddle|JSON-RPC/i);
  });
});
