import { useEffect, useState } from 'react';

export interface ProviderEntry {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
  api?: 'openai-completions' | 'anthropic-messages';
}

interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
}

interface ModelState { label: string; status: string; cls: '' | 'ok' | 'fail' | 'wait'; }

export interface SettingsApi {
  getSettings?(): Promise<unknown>;
  saveSettings?(settings: unknown): Promise<unknown>;
  listProviders?(): Promise<ProviderEntry[]>;
  listModels?(provider: string): Promise<{ ok: boolean; models?: string[]; error?: string }>;
  testModel?(provider: string, modelId: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}

export interface SettingsViewProps { api?: SettingsApi; }

const PANES = ['llm', 'data', 'runtime', 'approval', 'appearance'] as const;
type Pane = (typeof PANES)[number];
const PANE_LABELS: Record<Pane, string> = {
  llm: '大模型连接', data: '数据与隐私', runtime: '智能体与运行', approval: '审批与安全', appearance: '外观与语言',
};

const ROUTE_TASKS = ['对话 chat', '抽取 extract', '报告 report', '默认 default'] as const;

export function SettingsView(props: SettingsViewProps) {
  const { api } = props;
  const [pane, setPane] = useState<Pane>('llm');
  const [entries, setEntries] = useState<ProviderEntry[]>([]);
  const [providerId, setProviderId] = useState('');
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApi, setCustomApi] = useState<'openai-completions' | 'anthropic-messages'>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [info, setInfo] = useState('尚未连接 IPC');
  const [models, setModels] = useState<Record<string, ModelState>>({});
  const [busy, setBusy] = useState(false);

  const active = entries.find((e) => e.id === providerId);

  useEffect(() => {
    if (!api?.getSettings || !api?.listProviders) return;
    Promise.all([api.getSettings(), api.listProviders()])
      .then(([raw, providerEntries]) => {
        setEntries(providerEntries);
        const s = (raw ?? {}) as Record<string, any>;
        setProviderId(typeof s.activeProviderId === 'string' ? s.activeProviderId : (providerEntries[0]?.id ?? ''));
        setCustomProviders(Array.isArray(s.providers) ? (s.providers as CustomProvider[]) : []);
        if (typeof s.apiKey === 'string') setApiKey(s.apiKey);
        if (typeof s.defaultModel === 'string') setDefaultModel(s.defaultModel);
        if (s.routes && typeof s.routes === 'object') setRoutes(s.routes as Record<string, string>);
        setInfo('已加载本机配置');
      })
      .catch(() => setInfo('配置加载失败'));
  }, [api]);

  const applyModels = (names: string[]) => {
    const source = active?.name ?? providerId;
    const out: Record<string, ModelState> = {};
    for (const m of names) out[m] = { label: `${m} · ${source}`, status: '未测试', cls: '' };
    setModels(out);
  };

  const switchProvider = (id: string) => {
    setProviderId(id);
    const next = entries.find((e) => e.id === id);
    if (next?.kind === 'custom') {
      setCustomBaseUrl(next.baseUrl);
      setCustomApi(next.api ?? 'openai-completions');
    }
    setModels({});
    setInfo(`当前节点:${id} · 未拉取`);
  };

  const fetchModels = async () => {
    if (!api?.listModels) { setInfo('IPC 未连接,无法拉取模型'); return; }
    setBusy(true);
    const r = await api.listModels(providerId);
    if (r.ok && r.models) {
      applyModels(r.models);
      setInfo(`当前节点:${providerId} · 已拉取 ${r.models.length} 个模型`);
    } else {
      setInfo(`拉取失败:${r.error ?? '未知错误'}`);
    }
    setBusy(false);
  };

  const testAll = async () => {
    if (!api?.testModel) { setInfo('IPC 未连接,无法测试'); return; }
    setBusy(true);
    setModels((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) next[k] = { ...next[k], status: '连接中…', cls: 'wait' };
      return next;
    });
    const modelId = modelNames[0] ?? defaultModel;
    if (!modelId) { setInfo('请先拉取模型或设置默认模型'); setBusy(false); return; }
    const r = await api.testModel(providerId, modelId);
    setModels((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        next[k] = r.ok
          ? { ...next[k], status: `已连接 · ${r.latencyMs ?? 0}ms`, cls: 'ok' }
          : { ...next[k], status: '连接失败', cls: 'fail' };
      }
      return next;
    });
    setInfo(r.ok ? `测试完成:端点可达 · ${r.latencyMs ?? 0}ms` : `测试失败:${r.error ?? '未知错误'}`);
    setBusy(false);
  };

  const save = async () => {
    if (!api?.saveSettings) { setInfo('IPC 未连接,无法保存'); return; }
    const nextCustom = active?.kind === 'custom'
      ? [...customProviders.filter((p) => p.id !== providerId), { id: providerId, name: active.name, baseUrl: customBaseUrl, api: customApi }]
      : customProviders;
    await api.saveSettings({ activeProviderId: providerId, providers: nextCustom, defaultModel, routes, apiKey });
    setCustomProviders(nextCustom);
    setInfo('设置已保存');
  };

  const modelNames = Object.keys(models);

  return (
    <div className="grid-2" style={{ gridTemplateColumns: '200px 1fr', alignItems: 'start' }}>
      <div className="card" style={{ padding: 10 }}>
        {PANES.map((p) => (
          <button key={p} type="button" className={`agent ${pane === p ? 'on' : ''}`} onClick={() => setPane(p)}>
            <span className="dot dot-idle" />{PANE_LABELS[p]}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: '18px 20px' }}>
        {pane === 'llm' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>大模型连接</h3>
            <div className="muted" style={{ marginBottom: 6 }}>配置模型端点与任务路由;数据默认不出本机</div>
            <div className="set-row">
              <span>服务商</span>
              <select className="set-field" value={providerId} onChange={(e) => switchProvider(e.target.value)}>
                {entries.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            {active?.kind === 'custom' && (
              <>
                <div className="set-row"><span>接口地址(Base URL)</span><input className="set-field" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} /></div>
                <div className="set-row">
                  <span>API 类型</span>
                  <select className="set-field" value={customApi} onChange={(e) => setCustomApi(e.target.value as 'openai-completions' | 'anthropic-messages')}>
                    <option value="openai-completions">openai-completions</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                  </select>
                </div>
              </>
            )}
            <div className="set-row"><span>API Key</span><input className="set-field" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="本地端点可留空" /></div>
            <div className="set-row"><span>默认模型</span><input className="set-field" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="拉取模型后选择" /></div>
            <div className="set-row">
              <span>任务路由(按任务选模型)</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
                {ROUTE_TASKS.map((label) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="kv" style={{ width: 84 }}>{label}</span>
                    <select className="set-field route-select" style={{ flex: 1 }} value={routes[label] ?? defaultModel ?? ''} onChange={(e) => setRoutes((r) => ({ ...r, [label]: e.target.value }))}>
                      {modelNames.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={fetchModels} disabled={busy}>{busy ? '处理中…' : '拉取模型列表'}</button>
              <button type="button" className="btn" onClick={testAll} disabled={busy || modelNames.length === 0}>{busy ? '测试中…' : '测试连接'}</button>
              <button type="button" className="btn primary" onClick={save}>保存</button>
            </div>
            <h3 style={{ margin: '18px 0 4px' }}>模型状态 <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>{info}</span></h3>
            <div className="muted" style={{ marginBottom: 6 }}>拉取后展示当前节点模型;测试连接验证端点可达</div>
            {modelNames.map((m) => (
              <div key={m} className="set-row">
                <span>{models[m].label}</span>
                <span className={`mstat ${models[m].cls}`}>{models[m].status}</span>
              </div>
            ))}
          </>
        )}
        {pane === 'data' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>数据与隐私</h3>
            <div className="set-row"><span>数据目录</span><input className="set-field" placeholder="本机数据目录" readOnly /></div>
            <div className="set-row"><span>本地加密落盘</span><span className="switch on" /></div>
            <div className="set-row"><span>审计记录(只追加)</span><span className="switch on" /></div>
          </>
        )}
        {pane === 'runtime' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>智能体与运行</h3>
            <div className="set-row"><span>并行智能体上限</span><select className="set-field" defaultValue="4"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
            <div className="set-row"><span>超出上限时排队</span><span className="switch on" /></div>
            <div className="set-row"><span>崩溃自动恢复</span><span className="switch on" /></div>
            <div className="set-row"><span>日志级别</span><select className="set-field" defaultValue="信息"><option>信息</option><option>调试</option><option>警告</option></select></div>
          </>
        )}
        {pane === 'approval' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>审批与安全</h3>
            <div className="set-row"><span>审批默认超时(秒)</span><input className="set-field" style={{ width: 120 }} defaultValue="120" /></div>
            <div className="set-row"><span>高风险操作二次确认</span><span className="switch on" /></div>
            <div className="set-row"><span>超时自动拒绝</span><span className="switch on" /></div>
            <div className="set-row"><span>当前角色</span><span className="kv">审核员(可批准:合同审核导出、状态变更)</span></div>
          </>
        )}
        {pane === 'appearance' && (
          <>
            <h3 style={{ margin: '0 0 4px' }}>外观与语言</h3>
            <div className="set-row"><span>主题</span><select className="set-field"><option>浅色</option><option>深色</option></select></div>
            <div className="set-row"><span>界面语言</span><select className="set-field"><option>简体中文</option><option>English</option></select></div>
          </>
        )}
      </div>
    </div>
  );
}
