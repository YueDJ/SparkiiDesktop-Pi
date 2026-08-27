import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({ activeProviderId: 'deepseek' }),
    saveSettings: vi.fn().mockResolvedValue({}),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
      { id: 'ollama', name: '本地 Ollama', kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyAuth: false, oauthAuth: false, api: 'openai-completions' },
    ]),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: ['qwen2.5', 'llama3.1'] }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 86 }),
    ...over,
  } as any;
}

describe('SettingsView', () => {
  it('renders the LLM pane with model list and connection status sections', () => {
    render(<SettingsView api={makeApi()} />);
    expect(screen.getAllByText('大模型连接').length).toBeGreaterThan(0);
    expect(screen.getByText('连接状态')).toBeTruthy();
    expect(screen.getByText('模型列表')).toBeTruthy();
  });

  it('switches to the data and privacy pane', () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByText('数据与隐私'));
    expect(screen.getByText('数据目录')).toBeTruthy();
  });

  it('fetches models over the network and populates the default-model dropdown', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('拉取模型列表（联网）'));
    await screen.findByText(/已联网拉取 2 个模型/);

    expect(screen.getAllByText('qwen2.5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('llama3.1').length).toBeGreaterThan(0);
    expect(api.listModels).toHaveBeenCalledWith('deepseek', '');

    const select = screen.getByTestId('default-model-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('qwen2.5');
    expect(optionValues).toContain('llama3.1');
  });

  it('tests the connection and reports reachability', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('测试连接'));
    await screen.findByText('已连接 · 86ms');
    expect(api.testConnection).toHaveBeenCalledWith('deepseek', '');
  });

  it('saves settings including canonical route keys via IPC', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');

    fireEvent.click(screen.getByText('拉取模型列表（联网）'));
    await screen.findByText(/已联网拉取 2 个模型/);
    fireEvent.change(screen.getByTestId('default-model-select'), { target: { value: 'qwen2.5' } });
    fireEvent.click(screen.getByText('保存'));
    await screen.findByText('设置已保存');

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeProviderId: 'deepseek', defaultModel: 'qwen2.5', routes: {} }),
    );
  });
});
