import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

const ONTO_INFO = {
  product: 'sparkiionto',
  version: '0.6.8',
  api_version: 'v1',
  deployment_profile: 'on-prem',
  retrieval: { backend: 'sql-lexical', semantic_embeddings: false },
  capabilities: { document_fetch: true },
};

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
      sparkiionto: {
        baseUrl: 'http://127.0.0.1:9380',
        hasToken: false,
        bindings: [],
        similarityThreshold: 0.2,
        vectorSimilarityWeight: 0.3,
      },
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    saveRagSettings: vi.fn().mockResolvedValue({ ok: true }),
    testRagConnection: vi.fn().mockResolvedValue({ ok: true, datasets: [{ id: 'law', name: '法规' }] }),
    listRagDatasets: vi.fn().mockResolvedValue({ ok: true, datasets: [{ id: 'law', name: '法规' }] }),
    saveKnowledgeSettings: vi.fn().mockResolvedValue({ ok: true }),
    testKnowledgeConnection: vi.fn().mockResolvedValue({
      ok: true,
      backend: 'sparkiionto',
      baseUrl: 'http://127.0.0.1:9380',
      info: ONTO_INFO,
      datasets: [{ id: 'tech', name: '工艺要求' }],
    }),
    listKnowledgeDatasets: vi.fn().mockResolvedValue({
      ok: true,
      backend: 'sparkiionto',
      baseUrl: 'http://127.0.0.1:9380',
      info: ONTO_INFO,
      datasets: [{ id: 'tech', name: '工艺要求' }],
    }),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
    ]),
    listAgents: vi.fn().mockResolvedValue([
      { id: 'knowledge-qa', name: '企业知识问答', knowledge: { enabled: true } },
      { id: 'contract-review', name: '合同审核智能体', knowledge: { enabled: true, picker: 'hidden' } },
      { id: 'general', name: '通用智能体', knowledge: { enabled: false } },
    ]),
    getApiKey: vi.fn().mockResolvedValue('sk-should-not-be-used'),
    saveDocumentParseSettings: vi.fn().mockResolvedValue({ ok: true }),
    listDocumentParseModules: vi.fn().mockResolvedValue([]),
    retryDocumentParse: vi.fn().mockResolvedValue({ ok: true }),
    importDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    downloadDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    getDocumentParse: vi.fn().mockResolvedValue({ status: 'stopped', waiting: [] }),
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
    // 两块分组各有一个"保存"，按分组取 RAG 那个（既有点击目标不变）。
    fireEvent.click(within(screen.getByTestId('knowledge-rag-group')).getByText('保存'));
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

  it('uses an in-page menu for default-dataset rows including hidden pickers', async () => {
    const api = makeApi();
    render(<SettingsView api={api} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const qa = await screen.findByTestId('rag-default-dataset-knowledge-qa') as HTMLButtonElement;
    const contract = await screen.findByTestId('rag-default-dataset-contract-review') as HTMLButtonElement;
    await waitFor(() => expect(api.listRagDatasets).toHaveBeenCalled());
    expect(qa.tagName).toBe('BUTTON');
    expect(contract.tagName).toBe('BUTTON');
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByTestId('rag-default-dataset-general')).toBeNull();
    fireEvent.click(qa);
    expect(document.body.querySelector('.ui-menu--fixed')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '法规' }));
    expect(qa.value).toBe('law');
  });

  it('renders both knowledge groups and keeps the existing RAG testids', async () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    await screen.findByTestId('rag-base-url-input');
    for (const id of [
      'knowledge-rag-group',
      'knowledge-onto-group',
      'rag-base-url-input',
      'rag-api-key-input',
      'rag-similarity-threshold-input',
      'rag-vector-similarity-weight-input',
      'sparkiionto-base-url-input',
      'sparkiionto-api-token-input',
      'sparkiionto-similarity-threshold-input',
      'rag-default-dataset-knowledge-qa',
      'sparkiionto-default-domain-knowledge-qa',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // Onto 组不暴露向量权重（服务端忽略该字段）。
    expect(screen.queryByTestId('sparkiionto-vector-similarity-weight-input')).toBeNull();
  });

  it('saves the RAG thresholds from the RAG group', async () => {
    const saveRagSettings = vi.fn().mockResolvedValue({ ok: true });
    render(<SettingsView api={makeApi({ saveRagSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    fireEvent.change(await screen.findByTestId('rag-similarity-threshold-input'), { target: { value: '0.35' } });
    fireEvent.change(screen.getByTestId('rag-vector-similarity-weight-input'), { target: { value: '0.5' } });
    fireEvent.click(within(screen.getByTestId('knowledge-rag-group')).getByText('保存'));
    await waitFor(() => expect(saveRagSettings).toHaveBeenCalled());
    const arg = saveRagSettings.mock.calls[0][0];
    expect(arg.similarityThreshold).toBe(0.35);
    expect(arg.vectorSimilarityWeight).toBe(0.5);
  });

  it('saves the Onto threshold and never overwrites the token with an empty input', async () => {
    const saveKnowledgeSettings = vi.fn().mockResolvedValue({ ok: true });
    render(<SettingsView api={makeApi({ saveKnowledgeSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const token = await screen.findByTestId('sparkiionto-api-token-input') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    fireEvent.change(screen.getByTestId('sparkiionto-similarity-threshold-input'), { target: { value: '0.4' } });
    fireEvent.click(within(screen.getByTestId('knowledge-onto-group')).getByText('保存'));
    await waitFor(() => expect(saveKnowledgeSettings).toHaveBeenCalled());
    const [backend, arg] = saveKnowledgeSettings.mock.calls[0];
    expect(backend).toBe('sparkiionto');
    expect(arg.similarityThreshold).toBe(0.4);
    expect(arg.apiKey === '' || arg.apiKey == null).toBe(true);
  });

  it('flags out-of-range thresholds in place without clamping the input', async () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const input = await screen.findByTestId('sparkiionto-similarity-threshold-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(input.value).toBe('1.5');
    expect(await screen.findByText(/阈值必须落在/)).toBeTruthy();
  });

  it('notes thresholds below 0.05', async () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    fireEvent.change(await screen.findByTestId('rag-similarity-threshold-input'), { target: { value: '0.01' } });
    expect(await screen.findByText(/几乎不过滤，会把无关片段当命中/)).toBeTruthy();
  });

  it('warns about plaintext non-loopback HTTP addresses without blocking save', async () => {
    const saveRagSettings = vi.fn().mockResolvedValue({ ok: true });
    render(<SettingsView api={makeApi({ saveRagSettings })} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const baseUrl = await screen.findByTestId('rag-base-url-input');
    expect(screen.queryByText(/被同网段嗅探/)).toBeNull();
    fireEvent.change(baseUrl, { target: { value: 'http://10.0.0.8:9380' } });
    expect(await screen.findByText(/被同网段嗅探/)).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('knowledge-rag-group')).getByText('保存'));
    await waitFor(() => expect(saveRagSettings).toHaveBeenCalled());
  });

  it('shows the Onto copy and the /info capability negotiation after a test', async () => {
    render(<SettingsView api={makeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const group = await screen.findByTestId('knowledge-onto-group');
    expect(within(group).getByText(/词法检索：适合短查询\/引用式提问/)).toBeTruthy();
    expect(within(group).getByText(/默认 24 小时过期/)).toBeTruthy();
    expect(within(group).getByText(/仅适用于本机联调/)).toBeTruthy();
    fireEvent.click(within(group).getByText('测试连接'));
    expect(await screen.findByText(/检索后端 sql-lexical/)).toBeTruthy();
    expect(screen.getByText(/无语义嵌入/)).toBeTruthy();
    expect(screen.getByText(/可打开原文/)).toBeTruthy();
  });
});
