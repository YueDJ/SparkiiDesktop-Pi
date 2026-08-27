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
    testModel: vi.fn().mockResolvedValue({ ok: true, latencyMs: 86 }),
    ...over,
  } as any;
}

describe('SettingsView provider rendering', () => {
  it('renders the provider dropdown from listProviders without non-whitelisted builtins', async () => {
    render(<SettingsView api={makeApi()} />);
    await screen.findByText('已加载本机配置');

    const optionTexts = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionTexts).toContain('DeepSeek');
    expect(optionTexts).toContain('本地 Ollama');
    expect(optionTexts).not.toContain('Google');
  });

  it('hides the base URL field for builtin providers and shows it for custom providers', async () => {
    render(<SettingsView api={makeApi()} />);
    await screen.findByText('已加载本机配置');

    expect(screen.queryByText('接口地址(Base URL)')).toBeNull();

    const providerSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });
    expect(await screen.findByDisplayValue('http://127.0.0.1:11434/v1')).toBeTruthy();
    expect(screen.getByText('接口地址(Base URL)')).toBeTruthy();
  });
});
