import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({ provider: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' }),
    saveSettings: vi.fn().mockResolvedValue({}),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: ['qwen2.5', 'llama3.1'] }),
    testModel: vi.fn().mockResolvedValue({ ok: true, latencyMs: 86 }),
    ...over,
  } as any;
}

describe('SettingsView', () => {
  it('renders the LLM pane by default', () => {
    render(<SettingsView api={makeApi()} />);
    expect(screen.getAllByText('大模型连接').length).toBeGreaterThan(0);
    expect(screen.getByText('模型状态')).toBeTruthy();
  });

  it('switches to the data and privacy pane', () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByText('数据与隐私'));
    expect(screen.getByText('数据目录')).toBeTruthy();
  });

  it('fetches models from the configured endpoint via IPC', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    fireEvent.click(screen.getByText('拉取模型列表'));
    await screen.findByText(/已拉取 2 个模型/);
    expect(screen.getByText('qwen2.5 · 本地')).toBeTruthy();
    expect(api.listModels).toHaveBeenCalledWith('本地 Ollama');
  });

  it('tests the connection and marks model states', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    fireEvent.click(screen.getByText('拉取模型列表'));
    await screen.findByText(/已拉取 2 个模型/);
    fireEvent.click(screen.getByText('测试连接'));
    await screen.findAllByText(/已连接 · 86ms/);
    expect(api.testModel).toHaveBeenCalledWith('本地 Ollama', 'qwen2.5');
  });

  it('saves settings via IPC', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    fireEvent.click(screen.getByText('保存'));
    await screen.findByText('设置已保存');
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ provider: '本地 Ollama' }));
  });
});
