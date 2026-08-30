import { useEffect, useState } from 'react';
import { Button, Select, SettingsLayout, SettingsRow, Switch, TextField, useErrors } from '@sparkii/ui';
import { THINKING_LEVELS, thinkingLevelLabel } from '../workbench/thinking-levels.js';
import {
  CHAT_DETAIL_LEVELS,
  chatDetailLevelLabel,
  isChatDetailLevel,
  type ChatDetailLevel,
} from '../workbench/chat-detail-level.js';
import { AuditView } from '../audit/AuditView.js';

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

export interface SettingsApi {
  getSettings?(): Promise<unknown>;
  saveSettings?(settings: unknown): Promise<unknown>;
  getApiKey?(provider: string): Promise<string | null>;
  listProviders?(): Promise<ProviderEntry[]>;
  listModels?(provider: string, apiKey?: string | null): Promise<{ ok: boolean; models?: string[]; httpStatus?: number; reason?: string; error?: string }>;
  testConnection?(provider: string, apiKey?: string | null): Promise<{ ok: boolean; latencyMs?: number; httpStatus?: number; reason?: string; error?: string }>;
  queryAudit?(filter: object): Promise<unknown[]>;
}

export interface SettingsViewProps { api?: SettingsApi; onExportAudit?(jsonl: string): void; }

const PANES = ['llm', 'data', 'runtime', 'approval', 'appearance', 'audit'] as const;
type Pane = (typeof PANES)[number];
const PANE_LABELS: Record<Pane, string> = {
  llm: '大模型连接', data: '数据与隐私', runtime: '智能体与运行', approval: '审批与安全', appearance: '外观与语言', audit: '审计',
};

const ROUTE_TASKS = [
  { key: 'chat', label: '对话' },
  { key: 'extract', label: '抽取' },
  { key: 'report', label: '报告' },
  { key: 'default', label: '默认' },
] as const;

type ConnStatus = { cls: '' | 'ok' | 'fail' | 'wait'; text: string };

function probeError(r: { reason?: string; error?: string }): string {
  if (r.reason === 'unauthorized') return r.error ?? 'API Key 无效或未授权';
  if (r.reason === 'unreachable') return `网络不可达：${r.error ?? '未知错误'}`;
  if (r.reason === 'unsupported') return r.error ?? '该服务商未提供 /models 端点';
  return r.error ?? '连接失败';
}

export function SettingsView(props: SettingsViewProps) {
  const { api, onExportAudit } = props;
  const { reportError } = useErrors();
  const [pane, setPane] = useState<Pane>('llm');
  const [entries, setEntries] = useState<ProviderEntry[]>([]);
  const [providerId, setProviderId] = useState('');
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApi, setCustomApi] = useState<'openai-completions' | 'anthropic-messages'>('openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState('');
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [info, setInfo] = useState('尚未连接 IPC');
  const [connStatus, setConnStatus] = useState<ConnStatus>({ cls: '', text: '未测试' });
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [maxAgents, setMaxAgents] = useState(4);
  const [queueEnabled, setQueueEnabled] = useState(true);
  const [chatDetailLevel, setChatDetailLevel] = useState<ChatDetailLevel>('standard');

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
        if (typeof s.defaultThinkingLevel === 'string') setDefaultThinkingLevel(s.defaultThinkingLevel);
        if (typeof s.maxAgents === 'number' && Number.isFinite(s.maxAgents)) setMaxAgents(s.maxAgents);
        if (typeof s.queueEnabled === 'boolean') setQueueEnabled(s.queueEnabled);
        if (isChatDetailLevel(s.chatDetailLevel)) setChatDetailLevel(s.chatDetailLevel);
        if (s.routes && typeof s.routes === 'object') setRoutes(s.routes as Record<string, string>);
        setInfo('已加载本机配置');
      })
      .catch(() => {
        setInfo('配置加载失败');
        reportError('配置加载失败', { source: '系统设置' });
      });
  }, [api]);

  const switchProvider = (id: string) => {
    setProviderId(id);
    const next = entries.find((e) => e.id === id);
    if (next?.kind === 'custom') {
      setCustomBaseUrl(next.baseUrl);
      setCustomApi(next.api ?? 'openai-completions');
    }
    setApiKey('');
    api?.getApiKey?.(id).then((k) => setApiKey(k ?? '')).catch(() => setApiKey(''));
    setModels([]);
    setConnStatus({ cls: '', text: '未测试' });
    setInfo(`当前节点:${id} · 未拉取`);
  };

  const fetchModels = async () => {
    if (!api?.listModels) { setInfo('IPC 未连接，无法拉取模型'); reportError('IPC 未连接，无法拉取模型', { source: '系统设置' }); return; }
    setFetching(true);
    setModels([]);
    setConnStatus({ cls: '', text: '未测试' });
    const r = await api.listModels(providerId, apiKey);
    if (r.ok && r.models) {
      setModels(r.models);
      setInfo(`已联网拉取 ${r.models.length} 个模型`);
    } else {
      setModels([]);
      setInfo(`拉取失败：${probeError(r)}`);
      reportError(`拉取失败：${probeError(r)}`, { source: '系统设置' });
    }
    setFetching(false);
  };

  const testConnection = async () => {
    if (!api?.testConnection) { setInfo('IPC 未连接，无法测试'); reportError('IPC 未连接，无法测试', { source: '系统设置' }); return; }
    setTesting(true);
    setConnStatus({ cls: 'wait', text: '连接中…' });
    const r = await api.testConnection(providerId, apiKey);
    if (r.ok) {
      setConnStatus({ cls: 'ok', text: `已连接 · ${r.latencyMs ?? 0}ms` });
      setInfo('测试完成：端点可达，Key 有效');
    } else {
      setConnStatus({ cls: 'fail', text: probeError(r) });
      setInfo('测试失败');
      reportError(probeError(r), { source: '系统设置' });
    }
    setTesting(false);
  };

  const save = async () => {
    if (!api?.saveSettings) { setInfo('IPC 未连接，无法保存'); reportError('IPC 未连接，无法保存', { source: '系统设置' }); return; }
    const nextCustom = active?.kind === 'custom'
      ? [...customProviders.filter((p) => p.id !== providerId), { id: providerId, name: active.name, baseUrl: customBaseUrl, api: customApi }]
      : customProviders;
    try {
      await api.saveSettings({
        activeProviderId: providerId,
        providers: nextCustom,
        defaultModel,
        defaultThinkingLevel,
        routes,
        apiKey,
        maxAgents,
        queueEnabled,
        chatDetailLevel,
      });
      setCustomProviders(nextCustom);
      setInfo('设置已保存');
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const nav = (
    <>
      {PANES.map((p) => (
        <button key={p} type="button" className={`ui-agent ${pane === p ? 'on' : ''}`} onClick={() => setPane(p)}>{PANE_LABELS[p]}</button>
      ))}
    </>
  );

  return (
    <SettingsLayout nav={nav}>
      {pane === 'llm' && (
        <>
          <h3 className="settings-section-title">大模型连接</h3>
          <div className="ui-muted settings-hint">配置模型端点与任务路由；数据默认不出本机</div>
          <SettingsRow label="服务商">
            <Select data-testid="provider-select" value={providerId} onChange={(e) => switchProvider(e.target.value)}>
              {entries.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </Select>
          </SettingsRow>
          {active?.kind === 'custom' && (
            <>
              <SettingsRow label="接口地址(Base URL)">
                <TextField data-testid="base-url-input" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
              </SettingsRow>
              <SettingsRow label="API 类型">
                <Select value={customApi} onChange={(e) => setCustomApi(e.target.value as 'openai-completions' | 'anthropic-messages')}>
                  <option value="openai-completions">openai-completions</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                </Select>
              </SettingsRow>
            </>
          )}
          <SettingsRow label="API Key">
            <TextField data-testid="api-key-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="本地端点可留空" />
          </SettingsRow>
          <SettingsRow label="默认模型">
            <Select data-testid="default-model-select" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
              <option value="">未设置（使用路由“默认”）</option>
              {defaultModel && !models.includes(defaultModel) && <option value={defaultModel}>{defaultModel}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </SettingsRow>
          <SettingsRow label="默认思考强度">
            <Select data-testid="default-thinking-select" value={defaultThinkingLevel} onChange={(e) => setDefaultThinkingLevel(e.target.value)}>
              <option value="">跟随 SDK 默认（中）</option>
              {THINKING_LEVELS.map((l) => <option key={l} value={l}>{thinkingLevelLabel(l)}</option>)}
            </Select>
          </SettingsRow>
          <SettingsRow label="任务路由(按任务选模型)">
            <div className="settings-routes">
              {ROUTE_TASKS.map(({ key, label }) => (
                <div key={key} className="settings-route-row">
                  <span className="settings-route-label">{label}</span>
                  <Select className="route-select" data-testid={`route-select-${key}`} value={routes[key] ?? ''} onChange={(e) => setRoutes((r) => ({ ...r, [key]: e.target.value }))}>
                    <option value="">跟随默认模型</option>
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          </SettingsRow>
          <div className="settings-actions">
            <Button onClick={fetchModels} disabled={fetching || testing}>{fetching ? '拉取中…' : '拉取模型列表（联网）'}</Button>
            <Button onClick={testConnection} disabled={testing || fetching}>{testing ? '测试中…' : '测试连接'}</Button>
            <Button variant="primary" onClick={save}>保存</Button>
          </div>
          <h3 className="settings-section-title settings-title-mt">连接状态 <span className={`ui-muted settings-conn-${connStatus.cls || 'muted'}`}>{connStatus.text}</span></h3>
          <div className="ui-muted settings-hint">测试连接会请求服务商 /models 端点，验证网络与 Key，不消耗 token</div>
          <h3 className="settings-section-title settings-title-mt">模型列表 <span className="ui-muted settings-info">{info}</span></h3>
          <div className="ui-muted settings-hint">拉取模型列表会联网读取服务商当前可用模型</div>
          <div className="settings-models">
            {models.map((m) => (
              <div key={m} className="settings-model">{m}</div>
            ))}
          </div>
        </>
      )}
      {pane === 'data' && (
        <>
          <h3 className="settings-section-title">数据与隐私</h3>
          <SettingsRow label="数据目录"><TextField placeholder="本机数据目录" readOnly /></SettingsRow>
          <SettingsRow label="本地加密落盘"><Switch checked onCheckedChange={() => {}} label="本地加密落盘" /></SettingsRow>
          <SettingsRow label="审计记录(只追加)"><Switch checked onCheckedChange={() => {}} label="审计记录(只追加)" /></SettingsRow>
        </>
      )}
      {pane === 'runtime' && (
        <>
          <h3 className="settings-section-title">智能体与运行</h3>
          <SettingsRow label="并行智能体上限">
            <Select value={String(maxAgents)} onChange={(e) => setMaxAgents(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </SettingsRow>
          <SettingsRow label="超出上限时排队"><Switch checked={queueEnabled} onCheckedChange={setQueueEnabled} label="超出上限时排队" /></SettingsRow>
          <SettingsRow label="聊天信息详细程度">
            <Select
              data-testid="chat-detail-level-select"
              value={chatDetailLevel}
              onChange={(e) => setChatDetailLevel(e.target.value as ChatDetailLevel)}
            >
              {CHAT_DETAIL_LEVELS.map((level) => (
                <option key={level} value={level}>{chatDetailLevelLabel(level)}</option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsRow label="崩溃自动恢复"><Switch checked onCheckedChange={() => {}} label="崩溃自动恢复" /></SettingsRow>
          <SettingsRow label="日志级别">
            <Select defaultValue="信息"><option>信息</option><option>调试</option><option>警告</option></Select>
          </SettingsRow>
          <div className="settings-actions">
            <Button variant="primary" onClick={save}>保存</Button>
          </div>
        </>
      )}
      {pane === 'approval' && (
        <>
          <h3 className="settings-section-title">审批与安全</h3>
          <SettingsRow label="审批默认超时(秒)"><TextField className="settings-timeout" defaultValue="120" /></SettingsRow>
          <SettingsRow label="高风险操作二次确认"><Switch checked onCheckedChange={() => {}} label="高风险操作二次确认" /></SettingsRow>
          <SettingsRow label="超时自动拒绝"><Switch checked onCheckedChange={() => {}} label="超时自动拒绝" /></SettingsRow>
          <SettingsRow label="当前角色"><span className="ui-kv">审核员(可批准:合同审核导出、状态变更)</span></SettingsRow>
        </>
      )}
      {pane === 'appearance' && (
        <>
          <h3 className="settings-section-title">外观与语言</h3>
          <SettingsRow label="主题"><Select><option>浅色</option><option>深色</option></Select></SettingsRow>
          <SettingsRow label="界面语言"><Select><option>简体中文</option><option>English</option></Select></SettingsRow>
        </>
      )}
      {pane === 'audit' && (
        <>
          <h3 className="settings-section-title">审计</h3>
          {(() => {
            const queryAudit = api?.queryAudit;
            return queryAudit
              ? <AuditView api={{ queryAudit }} onExport={onExportAudit} />
              : <div className="ui-muted">审计接口不可用</div>;
          })()}
        </>
      )}
    </SettingsLayout>
  );
}
