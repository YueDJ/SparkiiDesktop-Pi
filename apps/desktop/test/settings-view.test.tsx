import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({ activeProviderId: 'deepseek' }),
    saveSettings: vi.fn().mockResolvedValue({}),
    getApiKey: vi.fn().mockResolvedValue(''),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
      { id: 'ollama', name: '本地 Ollama', kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyAuth: false, oauthAuth: false, api: 'openai-completions' },
    ]),
    listModels: vi.fn().mockResolvedValue({ ok: true, models: ['qwen2.5', 'llama3.1'] }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 86 }),
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
    expect(document.querySelector('.dot')).toBeNull();
    expect(screen.queryByText('●')).toBeNull();
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

  it('reloads the api key when switching providers', async () => {
    const getApiKey = vi.fn((provider: string) => Promise.resolve(provider === 'ollama' ? 'sk-ollama' : ''));
    render(<SettingsView api={makeApi({ getApiKey })} />);
    await screen.findByText('已加载本机配置');

    const providerSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });

    expect(await screen.findByDisplayValue('sk-ollama')).toBeTruthy();
    expect(getApiKey).toHaveBeenCalledWith('ollama');
  });

  it('saves the default thinking level', async () => {
    const saveSettings = vi.fn().mockResolvedValue({});
    render(<SettingsView api={makeApi({ saveSettings })} />);
    await screen.findByText('已加载本机配置');
    fireEvent.change(screen.getByTestId('default-thinking-select'), { target: { value: 'high' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    const arg = saveSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.defaultThinkingLevel).toBe('high');
  });

  it('saves the chat detail level from the runtime pane', async () => {
    const saveSettings = vi.fn().mockResolvedValue({});
    render(<SettingsView api={makeApi({ saveSettings })} />);
    await screen.findByText('已加载本机配置');

    fireEvent.click(screen.getByText('智能体与运行'));
    fireEvent.change(screen.getByTestId('chat-detail-level-select'), { target: { value: 'debug' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    const arg = saveSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.chatDetailLevel).toBe('debug');
  });
});

describe('SettingsView skills pane', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function skillsApi(over: Record<string, unknown> = {}) {
    return makeApi({
      listUserSkills: vi.fn().mockResolvedValue({
        agent: { id: 'writer', name: '写作助手' },
        skills: [],
      }),
      previewUserSkill: vi.fn().mockResolvedValue({
        ok: true,
        skill: { name: 'summarize', description: 'Summarize text.', hasScripts: false, warnings: [] },
        destName: 'summarize',
      }),
      chooseSkillFolder: vi.fn().mockResolvedValue({ path: '/tmp/summarize' }),
      importUserSkill: vi.fn().mockResolvedValue({ ok: true, name: 'summarize' }),
      uninstallUserSkill: vi.fn().mockResolvedValue({ ok: true }),
      openUserSkillsDir: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/skills' }),
      ...over,
    });
  }

  it('shows the user-library hint and empty copy', async () => {
    render(<SettingsView api={skillsApi()} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    expect(await screen.findByText(/仅用于「写作助手」/)).toBeTruthy();
    expect(screen.getByText('还没有安装技能。')).toBeTruthy();
  });

  it('lists installed skill names', async () => {
    render(<SettingsView api={skillsApi({
      listUserSkills: vi.fn().mockResolvedValue({
        agent: { id: 'writer', name: '写作助手' },
        skills: [
          { name: 'summarize', description: 'Summarize text.', hasScripts: false, warnings: [] },
          { name: 'outline', description: 'Make an outline.', hasScripts: true, warnings: [] },
        ],
      }),
    })} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    expect(await screen.findByText('summarize')).toBeTruthy();
    expect(screen.getByText('outline')).toBeTruthy();
    expect(screen.getByText('其中的命令仍要审批。')).toBeTruthy();
  });

  it('imports a chosen folder after preview confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = skillsApi({
      previewUserSkill: vi.fn().mockResolvedValue({
        ok: true,
        skill: { name: 'summarize', description: 'Summarize text.', hasScripts: true, warnings: [] },
        destName: 'summarize',
      }),
    });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText(/仅用于/);
    fireEvent.click(screen.getByText('导入文件夹'));
    await waitFor(() => expect(api.chooseSkillFolder).toHaveBeenCalled());
    await waitFor(() => expect(api.previewUserSkill).toHaveBeenCalledWith('/tmp/summarize'));
    await waitFor(() => expect(api.importUserSkill).toHaveBeenCalledWith({ sourceDir: '/tmp/summarize' }));
    expect(api.importUserSkill).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain('summarize');
    expect(confirm.mock.calls[0]?.[0]).toContain('其中的命令仍要审批。');
  });

  it('confirms a skill pack import with pack wording', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = skillsApi({
      chooseSkillFolder: vi.fn().mockResolvedValue({ path: '/tmp/superpowers' }),
      previewUserSkill: vi.fn().mockResolvedValue({
        ok: true,
        destName: 'superpowers',
        skill: {
          name: 'superpowers',
          description: 'Superpowers skills',
          hasScripts: false,
          warnings: [],
          kind: 'pack',
          skillCount: 2,
        },
      }),
      importUserSkill: vi.fn().mockResolvedValue({ ok: true, name: 'superpowers' }),
    });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText(/仅用于/);
    fireEvent.click(screen.getByText('导入文件夹'));
    await waitFor(() => expect(api.importUserSkill).toHaveBeenCalledWith({ sourceDir: '/tmp/superpowers' }));
    expect(confirm.mock.calls[0]?.[0]).toContain('技能包');
    expect(confirm.mock.calls[0]?.[0]).toContain('superpowers');
    expect(confirm.mock.calls[0]?.[0]).toContain('2 个技能');
  });

  it('does not import when preview fails on pack destNames', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = skillsApi({
      previewUserSkill: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'bad-name',
        diagnostics: ['子技能安装名冲突：my-skill'],
      }),
    });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText(/仅用于/);
    fireEvent.click(screen.getByText('导入文件夹'));
    await waitFor(() => expect(api.previewUserSkill).toHaveBeenCalledWith('/tmp/summarize'));
    expect(api.importUserSkill).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks for overwrite when import returns exists', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const importUserSkill = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'exists', name: 'summarize' })
      .mockResolvedValueOnce({ ok: true, name: 'summarize' });
    const api = skillsApi({ importUserSkill });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText(/仅用于/);
    fireEvent.click(screen.getByText('导入文件夹'));
    await waitFor(() => expect(importUserSkill).toHaveBeenCalledTimes(2));
    expect(importUserSkill).toHaveBeenNthCalledWith(1, { sourceDir: '/tmp/summarize' });
    expect(importUserSkill).toHaveBeenNthCalledWith(2, { sourceDir: '/tmp/summarize', overwrite: true });
  });

  it('uninstalls a destName after confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const uninstallUserSkill = vi.fn().mockResolvedValue({ ok: true });
    const api = skillsApi({
      listUserSkills: vi.fn().mockResolvedValue({
        agent: { id: 'writer', name: '写作助手' },
        skills: [{ name: 'summarize', description: 'Summarize text.', hasScripts: false, warnings: [] }],
      }),
      uninstallUserSkill,
    });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText('summarize');
    fireEvent.click(screen.getByText('卸载'));
    await waitFor(() => expect(uninstallUserSkill).toHaveBeenCalledWith({ name: 'summarize' }));
  });

  it('opens the skills folder', async () => {
    const api = skillsApi();
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    await screen.findByText(/仅用于/);
    fireEvent.click(screen.getByText('打开技能文件夹'));
    await waitFor(() => expect(api.openUserSkillsDir).toHaveBeenCalled());
  });

  it('shows the no-user-library empty state and disables actions', async () => {
    const api = skillsApi({
      listUserSkills: vi.fn().mockResolvedValue({ agent: null, skills: [] }),
    });
    render(<SettingsView api={api} />);
    await screen.findByText('已加载本机配置');
    fireEvent.click(screen.getByText('技能'));
    expect(await screen.findByText('未配置用户技能库')).toBeTruthy();
    expect((screen.getByText('导入文件夹') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('打开技能文件夹') as HTMLButtonElement).disabled).toBe(true);
  });
});
