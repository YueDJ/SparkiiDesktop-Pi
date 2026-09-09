import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

function makeApi(over: Record<string, unknown> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      activeProviderId: 'deepseek',
      rag: {
        baseUrl: 'http://127.0.0.1:9380',
        hasApiKey: true,
        bindings: [],
        similarityThreshold: 0.2,
        vectorSimilarityWeight: 0.3,
      },
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    saveRagSettings: vi.fn().mockResolvedValue({ ok: true }),
    testRagConnection: vi.fn().mockResolvedValue({ ok: true, datasets: [{ id: 'law', name: '法规' }] }),
    listRagDatasets: vi.fn().mockResolvedValue({ ok: true, datasets: [{ id: 'law', name: '法规' }] }),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
    ]),
    listAgents: vi.fn().mockResolvedValue([
      { id: 'knowledge-qa', name: '企业知识问答', knowledge: { enabled: true } },
      { id: 'general', name: '通用智能体', knowledge: { enabled: false } },
    ]),
    getApiKey: vi.fn().mockResolvedValue('sk-should-not-be-used'),
    ...over,
  } as any;
}

describe('Settings knowledge pane', () => {
  it('shows configured state without putting the stored key in the input', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const input = await screen.findByTestId('rag-api-key-input') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(await screen.findByText(/已配置/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /显示/ })).toBeNull();
    await waitFor(() => expect(api.listRagDatasets).toHaveBeenCalled());
  });

  it('save with empty key calls saveRagSettings with apiKey empty string or omitted', async () => {
    const saveRagSettings = vi.fn().mockResolvedValue({ ok: true });
    render(<SettingsView api={makeApi({ saveRagSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    await screen.findByTestId('rag-api-key-input');
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(saveRagSettings).toHaveBeenCalled());
    const arg = saveRagSettings.mock.calls[0][0];
    expect(arg.apiKey === '' || arg.apiKey == null).toBe(true);
    expect(arg.baseUrl).toBe('http://127.0.0.1:9380');
  });

  it('does not load the RAG key through getApiKey', async () => {
    const getApiKey = vi.fn().mockResolvedValue('rag-secret-please-hide');
    render(<SettingsView api={makeApi({ getApiKey })} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    await screen.findByTestId('rag-api-key-input');
    expect(getApiKey).not.toHaveBeenCalledWith('sparkiirag');
  });
});
