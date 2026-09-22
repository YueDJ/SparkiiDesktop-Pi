import { useEffect, useState } from 'react';
import { Button, SelectMenu, SettingsRow, TextField, useErrors } from '@sparkii/ui';
import type {
  KnowledgeBackendId,
  KnowledgeProbeOverride,
  KnowledgeProbeResult,
  KnowledgeSettingsPartial,
} from '../../electron/preload/api-types.js';

/** “知识库”两块分组（SparkiiRAG + SparkiiOnto）共用的 IPC 面。 */
export type KnowledgePaneApi = {
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
  saveKnowledgeSettings?(backend: KnowledgeBackendId, partial: KnowledgeSettingsPartial): Promise<{ ok: boolean; error?: string }>;
  testKnowledgeConnection?(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  listKnowledgeDatasets?(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  listAgents?(): Promise<AgentSummary[]>;
};

/** 兼容旧导出名（RAG 单组时期），调用点无需改名。 */
export type RagPaneApi = KnowledgePaneApi;

/** `listAgents` 的 renderer 侧视图：`knowledge.backend` 决定该智能体归哪一组。 */
export type AgentSummary = {
  id: string;
  name: string;
  displayName?: string;
  knowledge?: { enabled?: boolean; backend?: string };
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:9380';
const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_VECTOR_WEIGHT = 0.3;
const DEFAULT_URL_NOTE = '默认地址仅适用于本机联调';
const LOW_THRESHOLD_NOTE = '几乎不过滤，会把无关片段当命中';
const PLAINTEXT_WARNING = '明文 HTTP 地址：凭据与内容可能被同网段嗅探或篡改；建议放在终止 TLS 的反向代理之后。';
const TOKEN_LIFETIME_NOTE = 'API Token 默认 24 小时过期；需要更长寿命请让管理员上调站点策略（SPARKIIONTO_TOKEN_LIFETIME_SECONDS）。';

type KnowledgeBinding = { agentId: string; defaultDatasetId: string };
type DatasetOption = { id: string; name: string };

type RagState = {
  baseUrl: string;
  /** 阈值/权重在 UI 里保持用户输入的原文（不 clamp、不静默改写），保存时才转成数字。 */
  similarityThreshold: string;
  vectorSimilarityWeight: string;
  bindings: KnowledgeBinding[];
  hasApiKey: boolean;
};

const DEFAULT_RAG: RagState = {
  baseUrl: DEFAULT_BASE_URL,
  similarityThreshold: String(DEFAULT_THRESHOLD),
  vectorSimilarityWeight: String(DEFAULT_VECTOR_WEIGHT),
  bindings: [],
  hasApiKey: false,
};

type OntoState = {
  baseUrl: string;
  /** Onto 只暴露 similarityThreshold（向量权重对该后端是死参数，不展示）。 */
  similarityThreshold: string;
  bindings: KnowledgeBinding[];
  hasToken: boolean;
  /** 读配置宽容：地址缺失/空白/非法都会置位——这**不是**报错，只表示"未配置，正在用默认地址"。 */
  unconfigured: boolean;
};

const DEFAULT_ONTO: OntoState = {
  baseUrl: DEFAULT_BASE_URL,
  similarityThreshold: String(DEFAULT_THRESHOLD),
  bindings: [],
  hasToken: false,
  unconfigured: false,
};

/** 阈值文案：输入必须落在 [0,1]，越界就地提示（不 clamp、不静默改写）。 */
function thresholdIssue(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return '阈值不能为空，请输入 0–1 之间的数字';
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return `请输入 0–1 之间的数字（当前「${trimmed}」）`;
  if (value < 0 || value > 1) return `阈值必须落在 0–1 之间（当前 ${trimmed}），越界请求会被服务端拒绝`;
  return null;
}

function isLowThreshold(text: string): boolean {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value < 0.05;
}

/** 保存时把用户原文转成数字：空/非数字返回 undefined（表示"未提供"，沿用已存值）。 */
function parseThreshold(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\./.test(host);
}

/** 非 loopback 的 `http://` 给出明文警告（只提示，不阻止保存）。 */
function plaintextWarning(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  return isLoopbackHost(url.hostname) ? null : PLAINTEXT_WARNING;
}

/** `/info` 协商结果文案：检索后端、是否语义嵌入、是否可打开原文。 */
function capabilityText(info: KnowledgeProbeResult['info'] | undefined): string {
  if (!info) return '未返回 /info 能力协商结果';
  const backend = info.retrieval?.backend || '未知';
  const semantic = info.retrieval?.semantic_embeddings === true;
  const canOpen = info.capabilities?.document_fetch === true;
  return [
    `检索后端 ${backend}`,
    semantic ? '有语义嵌入' : '无语义嵌入（词法检索）',
    canOpen ? '可打开原文' : '不可打开原文',
  ].join(' · ');
}

/** 阈值旁注：越界就地标红；值 < 0.05 旁注"几乎不过滤"。 */
function ThresholdHints({ text }: { text: string }) {
  const issue = thresholdIssue(text);
  if (issue) return <div className="settings-invalid settings-hint">{issue}</div>;
  if (isLowThreshold(text)) return <div className="settings-warning settings-hint">{LOW_THRESHOLD_NOTE}</div>;
  return null;
}

function readRag(raw: unknown): RagState {
  const rag = ((raw ?? {}) as { rag?: Partial<RagState> }).rag ?? {};
  return {
    baseUrl: typeof rag.baseUrl === 'string' && rag.baseUrl ? rag.baseUrl : DEFAULT_RAG.baseUrl,
    similarityThreshold: typeof rag.similarityThreshold === 'number' ? String(rag.similarityThreshold) : DEFAULT_RAG.similarityThreshold,
    vectorSimilarityWeight: typeof rag.vectorSimilarityWeight === 'number' ? String(rag.vectorSimilarityWeight) : DEFAULT_RAG.vectorSimilarityWeight,
    bindings: Array.isArray(rag.bindings) ? rag.bindings as KnowledgeBinding[] : [],
    hasApiKey: rag.hasApiKey === true,
  };
}

function readOnto(raw: unknown): OntoState {
  const onto = ((raw ?? {}) as { sparkiionto?: Partial<OntoState> & { invalidBaseUrl?: boolean } }).sparkiionto ?? {};
  return {
    baseUrl: typeof onto.baseUrl === 'string' && onto.baseUrl ? onto.baseUrl : DEFAULT_ONTO.baseUrl,
    similarityThreshold: typeof onto.similarityThreshold === 'number' ? String(onto.similarityThreshold) : DEFAULT_ONTO.similarityThreshold,
    bindings: Array.isArray(onto.bindings) ? onto.bindings as KnowledgeBinding[] : [],
    hasToken: onto.hasToken === true,
    // Main 的读宽容语义：地址缺失/空白/非法都置 `invalidBaseUrl` —— 对 UI 是"未配置、用默认地址"，不是报错。
    unconfigured: onto.invalidBaseUrl === true,
  };
}

export function SettingsKnowledgePane({ api }: { api?: KnowledgePaneApi }) {
  const { reportError } = useErrors();
  const [rag, setRag] = useState<RagState>(DEFAULT_RAG);
  const [apiKey, setApiKey] = useState('');
  const [info, setInfo] = useState('');
  const [testing, setTesting] = useState(false);
  const [datasets, setDatasets] = useState<DatasetOption[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [onto, setOnto] = useState<OntoState>(DEFAULT_ONTO);
  const [ontoToken, setOntoToken] = useState('');
  const [ontoInfo, setOntoInfo] = useState('');
  const [ontoTesting, setOntoTesting] = useState(false);
  const [ontoDatasets, setOntoDatasets] = useState<DatasetOption[]>([]);

  const load = async () => {
    if (!api?.getSettings) return;
    try {
      const raw = await api.getSettings();
      const next = readRag(raw);
      const nextOnto = readOnto(raw);
      setRag(next);
      setApiKey('');
      setOnto(nextOnto);
      setOntoToken('');
      if (next.hasApiKey && api.listRagDatasets) {
        const listed = await api.listRagDatasets();
        if (listed.ok) setDatasets(listed.datasets ?? []);
      }
      if (nextOnto.hasToken && api.listKnowledgeDatasets) {
        const listed = await api.listKnowledgeDatasets('sparkiionto');
        if (listed.ok) setOntoDatasets(listed.datasets ?? []);
      }
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  useEffect(() => {
    void load();
    void api?.listAgents?.().then((list) => {
      setAgents(list
        .filter((a) => a.knowledge?.enabled === true)
        .map((a) => ({ id: a.id, name: a.displayName ?? a.name, knowledge: a.knowledge })));
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

  const testOnto = async () => {
    if (!api?.testKnowledgeConnection) return;
    setOntoTesting(true);
    try {
      const r = await api.testKnowledgeConnection('sparkiionto', {
        baseUrl: onto.baseUrl,
        apiKey: ontoToken.trim() || null,
      });
      if (r.ok) {
        setOntoDatasets(r.datasets ?? []);
        setOntoInfo(`已连接：${capabilityText(r.info)}（可见 ${r.datasets?.length ?? 0} 个知识域）`);
      } else {
        setOntoDatasets([]);
        const message = r.error?.message ?? '连接失败';
        setOntoInfo(message);
        reportError(message, { source: '系统设置' });
      }
    } finally {
      setOntoTesting(false);
    }
  };

  const save = async () => {
    if (!api?.saveRagSettings) return;
    try {
      await api.saveRagSettings({
        baseUrl: rag.baseUrl,
        similarityThreshold: parseThreshold(rag.similarityThreshold),
        vectorSimilarityWeight: parseThreshold(rag.vectorSimilarityWeight),
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

  const saveOnto = async () => {
    if (!api?.saveKnowledgeSettings) return;
    try {
      const result = await api.saveKnowledgeSettings('sparkiionto', {
        baseUrl: onto.baseUrl,
        similarityThreshold: parseThreshold(onto.similarityThreshold),
        bindings: onto.bindings,
        apiKey: ontoToken.trim() ? ontoToken : '',
      });
      // URL 非法等写入失败由 Main 回 { ok: false, error } —— 不能静默丢弃。
      if (result && result.ok === false) {
        setOntoInfo(result.error ?? '设置未保存');
        reportError(result.error ?? '设置未保存', { source: '系统设置' });
        return;
      }
      setOntoToken('');
      setOntoInfo('设置已保存');
      await load();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const setRagBinding = (agentId: string, defaultDatasetId: string) => {
    setRag((prev) => {
      const bindings = prev.bindings.filter((b) => b.agentId !== agentId);
      if (defaultDatasetId) bindings.push({ agentId, defaultDatasetId });
      return { ...prev, bindings };
    });
  };

  const setOntoBinding = (agentId: string, defaultDatasetId: string) => {
    setOnto((prev) => {
      const bindings = prev.bindings.filter((b) => b.agentId !== agentId);
      if (defaultDatasetId) bindings.push({ agentId, defaultDatasetId });
      return { ...prev, bindings };
    });
  };

  const ragPlaintext = plaintextWarning(rag.baseUrl);
  const ontoPlaintext = plaintextWarning(onto.baseUrl);
  /**
   * Onto 组只列**真正用 Onto 后端**的智能体（今天是零个：现存智能体都是 RAG-only/BM25）。
   * RAG 组保持既有行为——列全部启用知识的智能体——故两组故意不对称。
   */
  const ontoAgents = agents.filter((agent) => agent.knowledge?.backend === 'sparkiionto');

  return (
    <>
      <section data-testid="knowledge-rag-group">
        <h3 className="settings-section-title">知识库</h3>
        <div className="ui-muted settings-hint">连接 SparkiiRAG，仅检索与打开出处；入库在引擎网页完成</div>
        <SettingsRow label="引擎地址">
          <TextField
            data-testid="rag-base-url-input"
            value={rag.baseUrl}
            onChange={(e) => setRag((prev) => ({ ...prev, baseUrl: e.target.value }))}
          />
        </SettingsRow>
        {rag.baseUrl.trim() === DEFAULT_BASE_URL && (
          <div className="ui-muted settings-hint">{DEFAULT_URL_NOTE}</div>
        )}
        {ragPlaintext && <div className="settings-warning settings-hint">{ragPlaintext}</div>}
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
        <SettingsRow label="相似度阈值">
          <TextField
            data-testid="rag-similarity-threshold-input"
            type="number"
            step="0.05"
            value={rag.similarityThreshold}
            onChange={(e) => setRag((prev) => ({ ...prev, similarityThreshold: e.target.value }))}
          />
        </SettingsRow>
        <ThresholdHints text={rag.similarityThreshold} />
        <SettingsRow label="向量相似度权重">
          <TextField
            data-testid="rag-vector-similarity-weight-input"
            type="number"
            step="0.05"
            value={rag.vectorSimilarityWeight}
            onChange={(e) => setRag((prev) => ({ ...prev, vectorSimilarityWeight: e.target.value }))}
          />
        </SettingsRow>
        <ThresholdHints text={rag.vectorSimilarityWeight} />
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
                  <SelectMenu
                    data-testid={`rag-default-dataset-${agent.id}`}
                    aria-label={`${agent.name}默认库`}
                    value={value}
                    options={[
                      { value: '', label: '未指定（连通后用列表第一项）' },
                      ...datasets.map((d) => ({ value: d.id, label: d.name })),
                    ]}
                    onChange={(next) => setRagBinding(agent.id, next)}
                  />
                </SettingsRow>
              );
            })}
          </>
        )}
      </section>
      <section data-testid="knowledge-onto-group">
        <h3 className="settings-section-title settings-title-mt">本体（SparkiiOnto）</h3>
        <div className="ui-muted settings-hint">连接 SparkiiOnto；词法检索：适合短查询/引用式提问，不适合自然语言长问句</div>
        <SettingsRow label="引擎地址">
          <TextField
            data-testid="sparkiionto-base-url-input"
            value={onto.baseUrl}
            onChange={(e) => setOnto((prev) => ({ ...prev, baseUrl: e.target.value }))}
          />
        </SettingsRow>
        {onto.baseUrl.trim() === DEFAULT_BASE_URL && (
          <div className="ui-muted settings-hint">{DEFAULT_URL_NOTE}（两个后端的默认地址相同，具体产品以 /info 的 product 为准）</div>
        )}
        {onto.unconfigured && (
          <div className="ui-muted settings-hint">未配置，正在使用默认地址；填好地址与 API Token 后点"测试连接"</div>
        )}
        {ontoPlaintext && <div className="settings-warning settings-hint">{ontoPlaintext}</div>}
        <SettingsRow label="API Token">
          <TextField
            data-testid="sparkiionto-api-token-input"
            type="password"
            value={ontoToken}
            onChange={(e) => setOntoToken(e.target.value)}
            placeholder={onto.hasToken ? '留空则保持' : '粘贴 API Token'}
            autoComplete="off"
          />
        </SettingsRow>
        <div className="ui-muted settings-hint">Token 写后不可读回；{onto.hasToken ? '已配置，留空则保持' : '未配置'}</div>
        <div className="ui-muted settings-hint">{TOKEN_LIFETIME_NOTE}</div>
        <SettingsRow label="相似度阈值">
          <TextField
            data-testid="sparkiionto-similarity-threshold-input"
            type="number"
            step="0.05"
            value={onto.similarityThreshold}
            onChange={(e) => setOnto((prev) => ({ ...prev, similarityThreshold: e.target.value }))}
          />
        </SettingsRow>
        <ThresholdHints text={onto.similarityThreshold} />
        <div className="settings-actions">
          <Button onClick={testOnto} disabled={ontoTesting}>{ontoTesting ? '测试中…' : '测试连接'}</Button>
          <Button variant="primary" onClick={saveOnto}>保存</Button>
        </div>
        {ontoInfo && <div className="ui-muted settings-hint">{ontoInfo}</div>}
        {ontoAgents.length > 0 && (
          <>
            <h3 className="settings-section-title settings-title-mt">智能体默认域</h3>
            {ontoAgents.map((agent) => {
              const value = onto.bindings.find((b) => b.agentId === agent.id)?.defaultDatasetId ?? '';
              return (
                <SettingsRow key={agent.id} label={agent.name}>
                  <SelectMenu
                    data-testid={`sparkiionto-default-domain-${agent.id}`}
                    aria-label={`${agent.name}默认域`}
                    value={value}
                    options={[
                      { value: '', label: '未指定（连通后用列表第一项）' },
                      ...ontoDatasets.map((d) => ({ value: d.id, label: d.name })),
                    ]}
                    onChange={(next) => setOntoBinding(agent.id, next)}
                  />
                </SettingsRow>
              );
            })}
          </>
        )}
      </section>
    </>
  );
}
