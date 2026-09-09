import { useEffect, useState } from 'react';
import { Button, Select, SettingsRow, TextField, useErrors } from '@sparkii/ui';

export type RagPaneApi = {
  getSettings?(): Promise<unknown>;
  saveRagSettings?(partial: {
    baseUrl?: string;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
    apiKey?: string;
  }): Promise<{ ok: true }>;
  testRagConnection?(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  listRagDatasets?(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  listAgents?(): Promise<Array<{ id: string; name: string; displayName?: string; knowledge?: { enabled?: boolean } }>>;
};

type RagState = {
  baseUrl: string;
  similarityThreshold: number;
  vectorSimilarityWeight: number;
  bindings: Array<{ agentId: string; defaultDatasetId: string }>;
  hasApiKey: boolean;
};

const DEFAULT_RAG: RagState = {
  baseUrl: 'http://127.0.0.1:9380',
  similarityThreshold: 0.2,
  vectorSimilarityWeight: 0.3,
  bindings: [],
  hasApiKey: false,
};

function readRag(raw: unknown): RagState {
  const rag = ((raw ?? {}) as { rag?: Partial<RagState> }).rag ?? {};
  return {
    baseUrl: typeof rag.baseUrl === 'string' && rag.baseUrl ? rag.baseUrl : DEFAULT_RAG.baseUrl,
    similarityThreshold: typeof rag.similarityThreshold === 'number' ? rag.similarityThreshold : 0.2,
    vectorSimilarityWeight: typeof rag.vectorSimilarityWeight === 'number' ? rag.vectorSimilarityWeight : 0.3,
    bindings: Array.isArray(rag.bindings) ? rag.bindings : [],
    hasApiKey: rag.hasApiKey === true,
  };
}

export function SettingsKnowledgePane({ api }: { api?: RagPaneApi }) {
  const { reportError } = useErrors();
  const [rag, setRag] = useState<RagState>(DEFAULT_RAG);
  const [apiKey, setApiKey] = useState('');
  const [info, setInfo] = useState('');
  const [testing, setTesting] = useState(false);
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; displayName?: string }>>([]);

  const load = async () => {
    if (!api?.getSettings) return;
    try {
      const raw = await api.getSettings();
      const next = readRag(raw);
      setRag(next);
      setApiKey('');
      if (next.hasApiKey && api.listRagDatasets) {
        const listed = await api.listRagDatasets();
        if (listed.ok) setDatasets(listed.datasets ?? []);
      }
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  useEffect(() => {
    void load();
    void api?.listAgents?.().then((list) => {
      setAgents(list.filter((a) => a.knowledge?.enabled === true).map((a) => ({
        id: a.id,
        name: a.displayName ?? a.name,
      })));
    }).catch(() => setAgents([]));
  }, [api]);

  const test = async () => {
    if (!api?.testRagConnection) return;
    setTesting(true);
    try {
      const r = await api.testRagConnection(apiKey.trim() || null);
      if (r.ok) {
        setDatasets(r.datasets ?? []);
        setInfo(`已连接，可见 ${r.datasets?.length ?? 0} 个知识库`);
      } else {
        setDatasets([]);
        setInfo(r.error ?? '连接失败');
        reportError(r.error ?? '连接失败', { source: '系统设置' });
      }
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!api?.saveRagSettings) return;
    try {
      await api.saveRagSettings({
        baseUrl: rag.baseUrl,
        similarityThreshold: rag.similarityThreshold,
        vectorSimilarityWeight: rag.vectorSimilarityWeight,
        bindings: rag.bindings,
        apiKey: apiKey.trim() ? apiKey : '',
      });
      setApiKey('');
      setInfo('设置已保存');
      await load();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const setBinding = (agentId: string, defaultDatasetId: string) => {
    setRag((prev) => {
      const bindings = prev.bindings.filter((b) => b.agentId !== agentId);
      if (defaultDatasetId) bindings.push({ agentId, defaultDatasetId });
      return { ...prev, bindings };
    });
  };

  return (
    <>
      <h3 className="settings-section-title">知识库</h3>
      <div className="ui-muted settings-hint">连接 SparkiiRAG，仅检索与打开出处；入库在引擎网页完成</div>
      <SettingsRow label="引擎地址">
        <TextField
          data-testid="rag-base-url-input"
          value={rag.baseUrl}
          onChange={(e) => setRag((prev) => ({ ...prev, baseUrl: e.target.value }))}
        />
      </SettingsRow>
      <SettingsRow label="API Key">
        <TextField
          data-testid="rag-api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={rag.hasApiKey ? '留空则保持' : '粘贴 API Key'}
          autoComplete="off"
        />
      </SettingsRow>
      <div className="ui-muted settings-hint">{rag.hasApiKey ? '已配置，留空则保持' : '未配置'}</div>
      <div className="settings-actions">
        <Button onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连接'}</Button>
        <Button variant="primary" onClick={save}>保存</Button>
      </div>
      {info && <div className="ui-muted settings-hint">{info}</div>}
      {agents.length > 0 && (
        <>
          <h3 className="settings-section-title settings-title-mt">智能体默认库</h3>
          {agents.map((agent) => {
            const value = rag.bindings.find((b) => b.agentId === agent.id)?.defaultDatasetId ?? '';
            return (
              <SettingsRow key={agent.id} label={agent.name}>
                <Select
                  data-testid={`rag-default-dataset-${agent.id}`}
                  value={value}
                  onChange={(e) => setBinding(agent.id, e.target.value)}
                >
                  <option value="">未指定（连通后用列表第一项）</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </Select>
              </SettingsRow>
            );
          })}
        </>
      )}
    </>
  );
}
