import { useEffect, useState } from 'react';
import {
  Button,
  SelectMenu,
  SettingsLayout,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsPageHeader,
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
  Switch,
  TextArea,
  TextField,
  useErrors,
} from '@sparkii/ui';
import { THINKING_LEVELS, thinkingLevelLabel } from '../workbench/thinking-levels.js';
import {
  CHAT_DETAIL_LEVELS,
  chatDetailLevelLabel,
  isChatDetailLevel,
  type ChatDetailLevel,
} from '../workbench/chat-detail-level.js';
import { AuditView } from '../audit/AuditView.js';
import { SettingsSkillsPane, type SkillsPaneApi } from './SettingsSkillsPane.js';
import { SettingsKnowledgePane } from './SettingsKnowledgePane.js';
import { SettingsDocumentParsePane } from './SettingsDocumentParsePane.js';
import { SettingsAppearancePane } from './SettingsAppearancePane.js';
import { COMPANY_NAME, PRODUCT_NAME, RELEASE_CHANNEL } from '../branding.js';
import { SettingsUpdatePane } from './SettingsUpdatePane.js';
import type {
  KnowledgeBackendId,
  KnowledgeProbeOverride,
  KnowledgeProbeResult,
  KnowledgeSettingsPartial,
  SparkiiApi,
} from '../../electron/preload/api-types.js';

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
  saveRagSettings?(partial: {
    baseUrl?: string;
    similarityThreshold?: number;
    vectorSimilarityWeight?: number;
    bindings?: Array<{ agentId: string; defaultDatasetId: string }>;
    apiKey?: string;
  }): Promise<{ ok: true }>;
  saveKnowledgeSettings?(backend: KnowledgeBackendId, partial: KnowledgeSettingsPartial): Promise<{ ok: boolean; error?: string }>;
  testRagConnection?(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  listRagDatasets?(apiKey?: string | null): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>;
  testKnowledgeConnection?(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  listKnowledgeDatasets?(backend: KnowledgeBackendId, override?: KnowledgeProbeOverride): Promise<KnowledgeProbeResult>;
  listAgents?(): Promise<Array<{ id: string; name: string; displayName?: string; knowledge?: { enabled?: boolean } }>>;
  getApiKey?(provider: string): Promise<string | null>;
  listProviders?(): Promise<ProviderEntry[]>;
  listModels?(provider: string, apiKey?: string | null): Promise<{ ok: boolean; models?: string[]; httpStatus?: number; reason?: string; error?: string }>;
  testConnection?(provider: string, apiKey?: string | null): Promise<{ ok: boolean; latencyMs?: number; httpStatus?: number; reason?: string; error?: string }>;
  queryAudit?(filter: object): Promise<unknown[]>;
  diagnostics?(): Promise<{ logs: string }>;
  listUserSkills?: SkillsPaneApi['listUserSkills'];
  previewUserSkill?: SkillsPaneApi['previewUserSkill'];
  chooseSkillFolder?: SkillsPaneApi['chooseSkillFolder'];
  importUserSkill?: SkillsPaneApi['importUserSkill'];
  uninstallUserSkill?: SkillsPaneApi['uninstallUserSkill'];
  openUserSkillsDir?: SkillsPaneApi['openUserSkillsDir'];
  saveDocumentParseSettings?(partial: { idleMinutes: number; keepResident: boolean }): Promise<{ ok: true }>;
  listDocumentParseModules?(): Promise<Array<{
    id: string;
    label: string;
    bundled?: boolean;
    installed: boolean;
    canDownload: boolean;
  }>>;
  retryDocumentParse?(): Promise<{ ok: true }>;
  importDocumentParseModule?(path?: string): Promise<{ ok: boolean; error?: string }>;
  downloadDocumentParseModule?(id: string): Promise<{ ok: boolean; error?: string }>;
  getDocumentParse?(): Promise<{
    status: 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';
    waiting: unknown[];
  }>;
  // 自动更新：全部可选，避免破坏既有调用方与测试 mock。
  getAppVersion?: SparkiiApi['getAppVersion'];
  getUpdateState?: SparkiiApi['getUpdateState'];
  checkForUpdate?: SparkiiApi['checkForUpdate'];
  downloadUpdate?: SparkiiApi['downloadUpdate'];
  cancelDownload?: SparkiiApi['cancelDownload'];
  installUpdate?: SparkiiApi['installUpdate'];
  clearDownloaded?: SparkiiApi['clearDownloaded'];
  deferUpdate?: SparkiiApi['deferUpdate'];
  skipUpdate?: SparkiiApi['skipUpdate'];
  getUpdateSettings?: SparkiiApi['getUpdateSettings'];
  saveUpdateSettings?: SparkiiApi['saveUpdateSettings'];
  resetInstallId?: SparkiiApi['resetInstallId'];
  on?: SparkiiApi['on'];
}

export interface SettingsViewProps {
  api?: SettingsApi;
  onExportAudit?(jsonl: string): void;
  /**
   * 首次挂载时落在哪个 pane。状态栏更新徽标的落点是「软件更新」，
   * 若只是跳到设置页却停在「大模型连接」，用户还得自己找一遍。
   * 非法值一律忽略并回到默认 pane，绝不因为外部传了个怪字符串就白屏。
   */
  initialPane?: string;
}

const PANE_GROUPS = [
  { label: '模型与知识', panes: ['llm', 'knowledge', 'documentParse'] as const },
  { label: '运行', panes: ['runtime', 'skills'] as const },
  { label: '记录与更新', panes: ['audit', 'update'] as const },
  { label: '偏好与关于', panes: ['appearance', 'about'] as const },
];

const PANES = PANE_GROUPS.flatMap((group) => group.panes);
type Pane = (typeof PANES)[number];

const PANE_LABELS: Record<Pane, string> = {
  llm: '大模型连接',
  knowledge: '知识库',
  documentParse: '文档解析',
  runtime: '智能体与运行',
  skills: '技能',
  audit: '审计',
  update: '软件更新',
  appearance: '外观',
  about: '关于',
};

const DEFAULT_PANE: Pane = 'llm';
const isKnownPane = (v: unknown): v is Pane =>
  typeof v === 'string' && (PANES as readonly string[]).includes(v);

const ROUTE_TASKS = [
  { key: 'chat', label: '对话' },
  { key: 'extract', label: '抽取' },
  { key: 'report', label: '报告' },
  { key: 'default', label: '默认' },
] as const;

type ConnStatus = { cls: '' | 'ok' | 'fail' | 'wait'; text: string };
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LlmState {
  providerId: string;
  customProviders: CustomProvider[];
  customBaseUrl: string;
  customApi: 'openai-completions' | 'anthropic-messages';
  apiKey: string;
  defaultModel: string;
  defaultThinkingLevel: string;
  routes: Record<string, string>;
}

const EMPTY_LLM: LlmState = {
  providerId: '',
  customProviders: [],
  customBaseUrl: '',
  customApi: 'openai-completions',
  apiKey: '',
  defaultModel: '',
  defaultThinkingLevel: '',
  routes: {},
};

interface RuntimeState {
  maxAgents: number;
  queueEnabled: boolean;
  chatDetailLevel: ChatDetailLevel;
  logLevel: LogLevel;
}

const DEFAULT_RUNTIME: RuntimeState = {
  maxAgents: 4,
  queueEnabled: true,
  chatDetailLevel: 'standard',
  logLevel: 'info',
};

function probeError(r: { reason?: string; error?: string }): string {
  if (r.reason === 'unauthorized') return r.error ?? 'API Key 无效或未授权';
  if (r.reason === 'unreachable') return `网络不可达：${r.error ?? '未知错误'}`;
  if (r.reason === 'unsupported') return r.error ?? '该服务商未提供 /models 端点';
  return r.error ?? '连接失败';
}

export function SettingsView(props: SettingsViewProps) {
  const { api, onExportAudit } = props;
  const { reportError } = useErrors();
  const [pane, setPane] = useState<Pane>(isKnownPane(props.initialPane) ? props.initialPane : DEFAULT_PANE);
  const [entries, setEntries] = useState<ProviderEntry[]>([]);
  const [llm, setLlm] = useState<LlmState>(EMPTY_LLM);
  const [llmSaved, setLlmSaved] = useState<LlmState>(EMPTY_LLM);
  const [llmDirty, setLlmDirty] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [info, setInfo] = useState('尚未连接 IPC');
  const [connStatus, setConnStatus] = useState<ConnStatus>({ cls: '', text: '未测试' });
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeState>(DEFAULT_RUNTIME);
  const [runtimeSaved, setRuntimeSaved] = useState<RuntimeState>(DEFAULT_RUNTIME);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeInfo, setRuntimeInfo] = useState('');
  const [logRows, setLogRows] = useState<Array<{ ts: number; level: string; msg: string; ctx?: unknown }>>([]);
  const [appVersion, setAppVersion] = useState('');
  const [childDirty, setChildDirty] = useState<Record<string, boolean>>({});

  const active = entries.find((e) => e.id === llm.providerId);

  useEffect(() => {
    if (!api?.getSettings || !api?.listProviders) return;
    Promise.all([api.getSettings(), api.listProviders(), api.getAppVersion?.()])
      .then(([raw, providerEntries, version]) => {
        setEntries(providerEntries);
        const s = (raw ?? {}) as Record<string, unknown>;
        const providerId = typeof s.activeProviderId === 'string' ? s.activeProviderId : (providerEntries[0]?.id ?? '');
        const activeEntry = providerEntries.find((e) => e.id === providerId);
        const nextLlm: LlmState = {
          providerId,
          customProviders: Array.isArray(s.providers) ? (s.providers as CustomProvider[]) : [],
          customBaseUrl: activeEntry?.kind === 'custom' ? activeEntry.baseUrl : '',
          customApi: activeEntry?.api ?? 'openai-completions',
          apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
          defaultModel: typeof s.defaultModel === 'string' ? s.defaultModel : '',
          defaultThinkingLevel: typeof s.defaultThinkingLevel === 'string' ? s.defaultThinkingLevel : '',
          routes: s.routes && typeof s.routes === 'object' ? (s.routes as Record<string, string>) : {},
        };
        setLlm(nextLlm);
        setLlmSaved(nextLlm);
        setLlmDirty(false);
        const rawMaxAgents = typeof s.maxAgents === 'number' && Number.isFinite(s.maxAgents) ? s.maxAgents : 4;
        const nextRuntime: RuntimeState = {
          maxAgents: rawMaxAgents,
          queueEnabled: typeof s.queueEnabled === 'boolean' ? s.queueEnabled : true,
          chatDetailLevel: isChatDetailLevel(s.chatDetailLevel) ? s.chatDetailLevel : 'standard',
          logLevel: typeof s.logLevel === 'string' && ['debug', 'info', 'warn', 'error'].includes(s.logLevel)
            ? s.logLevel as LogLevel
            : 'info',
        };
        setRuntime(nextRuntime);
        setRuntimeSaved(nextRuntime);
        setRuntimeDirty(false);
        if (typeof version === 'string') setAppVersion(version);
        setInfo('已加载本机配置');
      })
      .catch(() => {
        setInfo('配置加载失败');
        reportError('配置加载失败', { source: '系统设置' });
      });
  }, [api]);

  const patchLlm = (patch: Partial<LlmState>) => {
    setLlm((prev) => ({ ...prev, ...patch }));
    setLlmDirty(true);
    setLlmError('');
  };

  const patchRuntime = (patch: Partial<RuntimeState>) => {
    setRuntime((prev) => ({ ...prev, ...patch }));
    setRuntimeDirty(true);
    setRuntimeError('');
  };

  const switchProvider = (id: string) => {
    const next = entries.find((e) => e.id === id);
    setLlm((prev) => ({
      ...prev,
      providerId: id,
      apiKey: '',
      ...(next?.kind === 'custom' ? { customBaseUrl: next.baseUrl, customApi: next.api ?? 'openai-completions' } : {}),
    }));
    setLlmDirty(true);
    setLlmError('');
    setModels([]);
    setConnStatus({ cls: '', text: '未测试' });
    setInfo(`当前节点：${id}`);
    api?.getApiKey?.(id)
      .then((k) => setLlm((prev) => (prev.providerId === id ? { ...prev, apiKey: k ?? '' } : prev)))
      .catch(() => setLlm((prev) => (prev.providerId === id ? { ...prev, apiKey: '' } : prev)));
  };

  const fetchModels = async () => {
    if (!api?.listModels) { setInfo('IPC 未连接，无法拉取模型'); reportError('IPC 未连接，无法拉取模型', { source: '系统设置' }); return; }
    setFetching(true);
    setModels([]);
    setConnStatus({ cls: '', text: '未测试' });
    const r = await api.listModels(llm.providerId, llm.apiKey);
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
    const r = await api.testConnection(llm.providerId, llm.apiKey);
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

  const saveLlm = async () => {
    if (!api?.saveSettings) { setLlmError('IPC 未连接，无法保存'); reportError('IPC 未连接，无法保存', { source: '系统设置' }); return; }
    const nextCustom = active?.kind === 'custom'
      ? [...llm.customProviders.filter((p) => p.id !== llm.providerId), { id: llm.providerId, name: active.name, baseUrl: llm.customBaseUrl, api: llm.customApi }]
      : llm.customProviders;
    setLlmSaving(true);
    setLlmError('');
    try {
      const result = await api.saveSettings({
        activeProviderId: llm.providerId,
        providers: nextCustom,
        defaultModel: llm.defaultModel,
        defaultThinkingLevel: llm.defaultThinkingLevel,
        routes: llm.routes,
        apiKey: llm.apiKey,
      }) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) {
        setLlmError(result.error ?? '设置未保存');
        setInfo('设置未保存');
        reportError(result.error ?? '设置未保存', { source: '系统设置' });
        return;
      }
      const saved: LlmState = { ...llm, customProviders: nextCustom };
      setLlm(saved);
      setLlmSaved(saved);
      setLlmDirty(false);
      setInfo('设置已保存');
    } catch (e) {
      setLlmError('保存失败，请稍后重试');
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    } finally {
      setLlmSaving(false);
    }
  };

  const saveRuntime = async () => {
    if (!api?.saveSettings) { setRuntimeError('IPC 未连接，无法保存'); reportError('IPC 未连接，无法保存', { source: '系统设置' }); return; }
    setRuntimeSaving(true);
    setRuntimeError('');
    try {
      const result = await api.saveSettings({
        maxAgents: runtime.maxAgents,
        queueEnabled: runtime.queueEnabled,
        chatDetailLevel: runtime.chatDetailLevel,
        logLevel: runtime.logLevel,
      }) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) {
        setRuntimeError(result.error ?? '设置未保存');
        setRuntimeInfo('设置未保存');
        reportError(result.error ?? '设置未保存', { source: '系统设置' });
        return;
      }
      setRuntimeSaved(runtime);
      setRuntimeDirty(false);
      setRuntimeInfo('设置已保存');
    } catch (e) {
      setRuntimeError('保存失败，请稍后重试');
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    } finally {
      setRuntimeSaving(false);
    }
  };

  const refreshLogs = async () => {
    const d = await api?.diagnostics?.();
    if (!d?.logs) return;
    const rows: Array<{ ts: number; level: string; msg: string; ctx?: unknown }> = [];
    for (const line of d.logs.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.ts === 'number' && typeof parsed.level === 'string' && typeof parsed.msg === 'string') {
          rows.push({ ts: parsed.ts, level: parsed.level, msg: parsed.msg, ctx: parsed.ctx });
        }
      } catch {
        // 跳过损坏行
      }
    }
    setLogRows(rows.slice(-100));
  };

  const paneDirty = (p: Pane): boolean => {
    if (p === 'llm') return llmDirty;
    if (p === 'runtime') return runtimeDirty;
    return childDirty[p] === true;
  };

  const goPane = (next: Pane) => {
    if (next === pane) return;
    if (paneDirty(pane)) {
      if (!window.confirm('当前页面有未保存的更改，离开将丢弃这些更改。')) return;
      if (pane === 'llm') { setLlm(llmSaved); setLlmDirty(false); setLlmError(''); }
      if (pane === 'runtime') { setRuntime(runtimeSaved); setRuntimeDirty(false); setRuntimeError(''); }
      setChildDirty((prev) => ({ ...prev, [pane]: false }));
    }
    setPane(next);
  };

  const nav = (
    <>
      {PANE_GROUPS.map((group) => (
        <SettingsNavGroup key={group.label} label={group.label}>
          {group.panes.map((p) => (
            <SettingsNavItem key={p} label={PANE_LABELS[p]} active={pane === p} onClick={() => goPane(p)} />
          ))}
        </SettingsNavGroup>
      ))}
    </>
  );

  return (
    <SettingsLayout nav={nav}>
      {pane === 'llm' && (
        <>
          <SettingsPageHeader title="大模型连接" />
          <SettingsSection title="连接">
            <SettingsRow label="服务商">
              <SelectMenu
                data-testid="provider-select"
                aria-label="服务商"
                value={llm.providerId}
                options={entries.map((e) => ({ value: e.id, label: e.name }))}
                onChange={switchProvider}
              />
            </SettingsRow>
            {active?.kind === 'custom' && (
              <>
                <SettingsRow label="接口地址(Base URL)">
                  <TextArea data-testid="base-url-input" className="settings-url" rows={2} spellCheck={false} value={llm.customBaseUrl} onChange={(e) => patchLlm({ customBaseUrl: e.target.value })} />
                </SettingsRow>
                <SettingsRow label="API 类型">
                  <SelectMenu
                    aria-label="API 类型"
                    value={llm.customApi}
                    options={[
                      { value: 'openai-completions', label: 'openai-completions' },
                      { value: 'anthropic-messages', label: 'anthropic-messages' },
                    ]}
                    onChange={(next) => patchLlm({ customApi: next as LlmState['customApi'] })}
                  />
                </SettingsRow>
              </>
            )}
            <SettingsRow label="API Key">
              <TextField
                data-testid="api-key-input"
                type="password"
                value={llm.apiKey}
                onChange={(e) => patchLlm({ apiKey: e.target.value })}
                placeholder="本地端点可留空"
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="模型与路由">
            <SettingsRow label="默认模型">
              <SelectMenu
                data-testid="default-model-select"
                aria-label="默认模型"
                value={llm.defaultModel}
                options={[
                  { value: '', label: '未设置（使用路由“默认”）' },
                  ...(llm.defaultModel && !models.includes(llm.defaultModel) ? [{ value: llm.defaultModel, label: llm.defaultModel }] : []),
                  ...models.map((m) => ({ value: m, label: m })),
                ]}
                onChange={(next) => patchLlm({ defaultModel: next })}
              />
            </SettingsRow>
            <SettingsRow label="默认思考强度">
              <SelectMenu
                data-testid="default-thinking-select"
                aria-label="默认思考强度"
                value={llm.defaultThinkingLevel}
                options={[
                  { value: '', label: '跟随 SDK 默认（中）' },
                  ...THINKING_LEVELS.map((l) => ({ value: l, label: thinkingLevelLabel(l) })),
                ]}
                onChange={(next) => patchLlm({ defaultThinkingLevel: next })}
              />
            </SettingsRow>
            <SettingsRow label="任务路由" description="未指定的任务跟随默认模型。">
              <div className="settings-routes">
                {ROUTE_TASKS.map(({ key, label }) => (
                  <div key={key} className="settings-route-row">
                    <span className="settings-route-label">{label}</span>
                    <SelectMenu
                      className="route-select"
                      data-testid={`route-select-${key}`}
                      aria-label={label}
                      value={llm.routes[key] ?? ''}
                      options={[
                        { value: '', label: '跟随默认模型' },
                        ...models.map((m) => ({ value: m, label: m })),
                      ]}
                      onChange={(next) => patchLlm({ routes: { ...llm.routes, [key]: next } })}
                    />
                  </div>
                ))}
              </div>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="连接状态">
            <div className="settings-diagnostic-row">
              <div className="settings-actions">
                <Button onClick={testConnection} disabled={testing || fetching}>{testing ? '测试中…' : '测试连接'}</Button>
                <Button onClick={fetchModels} disabled={fetching || testing}>{fetching ? '拉取中…' : '拉取模型列表（联网）'}</Button>
              </div>
              <span className={`settings-conn settings-conn-${connStatus.cls || 'muted'}`}>{connStatus.text}</span>
            </div>
          </SettingsSection>

          <SettingsSection title="模型列表">
            <div className="settings-models">
              {models.length === 0 && <div className="ui-muted">尚未拉取模型</div>}
              {models.map((m) => <div key={m} className="settings-model">{m}</div>)}
            </div>
          </SettingsSection>

          <SettingsSaveBar
            dirty={llmDirty}
            saving={llmSaving}
            status={info}
            error={llmError}
            onSave={() => void saveLlm()}
          />
        </>
      )}

      {pane === 'knowledge' && (
        <SettingsKnowledgePane
          api={api}
          onDirtyChange={(dirty) => setChildDirty((prev) => (prev.knowledge === dirty ? prev : { ...prev, knowledge: dirty }))}
        />
      )}
      {pane === 'documentParse' && (
        <SettingsDocumentParsePane
          api={api}
          onDirtyChange={(dirty) => setChildDirty((prev) => (prev.documentParse === dirty ? prev : { ...prev, documentParse: dirty }))}
        />
      )}

      {pane === 'runtime' && (
        <>
          <SettingsPageHeader title="智能体与运行" />
          <SettingsSection title="并发">
            <SettingsRow label="并行智能体上限" description="只约束智能体，不约束文档解析。">
              <SelectMenu
                className="settings-compact"
                aria-label="并行智能体上限"
                value={String(runtime.maxAgents)}
                options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(next) => patchRuntime({ maxAgents: Number(next) })}
              />
            </SettingsRow>
            <SettingsRow label="超出上限时排队">
              <Switch
                checked={runtime.queueEnabled}
                onCheckedChange={(next) => patchRuntime({ queueEnabled: next })}
                label="超出上限时排队"
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="对话">
            <SettingsRow label="聊天信息详细程度">
              <SelectMenu
                data-testid="chat-detail-level-select"
                aria-label="聊天信息详细程度"
                value={runtime.chatDetailLevel}
                options={CHAT_DETAIL_LEVELS.map((level) => ({ value: level, label: chatDetailLevelLabel(level) }))}
                onChange={(next) => patchRuntime({ chatDetailLevel: next as ChatDetailLevel })}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="诊断">
            <SettingsRow label="日志级别">
              <SelectMenu
                data-testid="log-level-select"
                aria-label="日志级别"
                value={runtime.logLevel}
                options={[
                  { value: 'debug', label: '调试' },
                  { value: 'info', label: '信息' },
                  { value: 'warn', label: '警告' },
                  { value: 'error', label: '错误' },
                ]}
                onChange={(next) => patchRuntime({ logLevel: next as LogLevel })}
              />
            </SettingsRow>
            <details className="settings-advanced">
              <summary>高级选项</summary>
              <div className="settings-advanced-body">
                <div className="settings-actions">
                  <Button onClick={refreshLogs}>刷新运行日志</Button>
                </div>
                <div className="settings-logs">
                  {logRows.length === 0 && <div className="ui-muted">暂无日志</div>}
                  {logRows.map((r, i) => (
                    <div key={i} className="settings-log-row">
                      <span className="settings-log-time">{new Date(r.ts).toLocaleString('zh-CN')}</span>
                      <span className={`settings-log-level settings-log-level-${r.level}`}>{r.level}</span>
                      <span className="settings-log-msg">{r.msg}</span>
                      {r.ctx != null && <span className="settings-log-ctx">{JSON.stringify(r.ctx)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </SettingsSection>

          <SettingsSaveBar
            dirty={runtimeDirty}
            saving={runtimeSaving}
            status={runtimeInfo}
            error={runtimeError}
            onSave={() => void saveRuntime()}
          />
        </>
      )}

      {pane === 'skills' && <SettingsSkillsPane api={api} />}

      {pane === 'appearance' && <SettingsAppearancePane />}

      {pane === 'audit' && (
        <>
          <SettingsPageHeader title="审计" />
          {(() => {
            const queryAudit = api?.queryAudit;
            return queryAudit
              ? <AuditView api={{ queryAudit }} onExport={onExportAudit} />
              : <div className="ui-muted">审计接口不可用</div>;
          })()}
        </>
      )}

      {pane === 'update' && (
        <SettingsUpdatePane
          api={api}
          onDirtyChange={(dirty) => setChildDirty((prev) => (prev.update === dirty ? prev : { ...prev, update: dirty }))}
        />
      )}

      {pane === 'about' && (
        <>
          <SettingsPageHeader title="关于" />
          <SettingsSection>
            <SettingsRow label="产品"><span className="ui-kv">{PRODUCT_NAME}</span></SettingsRow>
            <SettingsRow label="公司"><span className="ui-kv">{COMPANY_NAME}</span></SettingsRow>
            <SettingsRow label="发布渠道"><span className="ui-kv">{RELEASE_CHANNEL}</span></SettingsRow>
            <SettingsRow label="版本"><span className="ui-kv">{appVersion || '—'}</span></SettingsRow>
          </SettingsSection>
        </>
      )}
    </SettingsLayout>
  );
}
