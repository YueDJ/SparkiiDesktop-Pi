import { useEffect, useState } from 'react';
import {
  Modal,
  SettingsPageHeader,
  SettingsRow,
  SettingsSaveBar,
  SettingsSection,
  Switch,
  TextArea,
} from '@sparkii/ui';
import type {
  SparkiiApi,
  UpdateActionResult,
  UpdateProgress,
  UpdateSettingsPatch,
  UpdateSettingsPublic,
  UpdateState,
} from '../../electron/preload/api-types.js';
import { updateFailureText } from './update-failure.js';

/** 更新 pane 只经 IPC 拿结构化数据；全部字段可选 + guard，兼容未接线的 mock api。 */
export type SettingsUpdatePaneApi = Partial<Pick<SparkiiApi,
  | 'getAppVersion' | 'getUpdateState' | 'getUpdateSettings' | 'saveUpdateSettings'
  | 'checkForUpdate' | 'downloadUpdate' | 'cancelDownload' | 'installUpdate'
  | 'clearDownloaded' | 'deferUpdate' | 'skipUpdate' | 'resetInstallId' | 'queryAudit'>> & {
  on?(channel: string, cb: (payload: unknown) => void): (() => void) | void;
};

/** §6.6 记录入口：审计行按原样展示为纯文本，绝不拼成链接或加载远程内容（C4）。 */
interface AuditRowLike {
  ts?: number;
  action?: string;
  decision?: string;
  payloadSummary?: string;
}

const RECORDS_LIMIT = 30;

const formatAuditTime = (ts?: number): string =>
  typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts).toLocaleString('zh-CN') : '—';

// 契约 §7.3 事件全名；preload 的 on() 会自行补 'sparkii:event:' 前缀，
// 故同时订阅短通道名，保证与真实 preload 行为一致（两种形态都无害）。
const STATE_CHANNELS = ['sparkii:event:update-state', 'update-state'];
const PROGRESS_CHANNELS = ['sparkii:event:update-progress', 'update-progress'];

const clampPercent = (p: number): number =>
  Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;

function phaseBadge(state: UpdateState | null, baseUrl: string): { text: string; tone: string } {
  if (state?.stateTampered) return { text: '状态异常', tone: 'risk' };
  // 未打包的开发态不支持自动更新：这是环境限制，不该显示成“更新异常”。
  if (state?.phase === 'error' && state.errorCode === 'NOT_READY') return { text: '仅安装版可用', tone: 'muted' };
  switch (state?.phase) {
    case 'available': return { text: '有新版本', tone: 'warn' };
    case 'downloading': return { text: '下载中', tone: 'primary' };
    case 'readyToInstall': return { text: '可安装', tone: 'ok' };
    case 'installing':
    case 'restarting': return { text: '安装中', tone: 'primary' };
    case 'error': return { text: '更新异常', tone: 'risk' };
    default: return { text: baseUrl ? '已是最新' : '未配置', tone: 'muted' };
  }
}

async function maybe<T>(p: Promise<T> | undefined | null): Promise<T | null> {
  if (!p) return null;
  try { return await p; } catch { return null; }
}

export function SettingsUpdatePane({ api, onDirtyChange }: {
  api?: SettingsUpdatePaneApi;
  onDirtyChange?(dirty: boolean): void;
}) {
  const [appVersion, setAppVersion] = useState('');
  const [state, setState] = useState<UpdateState | null>(null);
  const [settings, setSettings] = useState<UpdateSettingsPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<'local' | 'remote' | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  // §6.6 三个入口：地址（可改 + 变更二次确认）/ 本地检查记录 / 重置 installId。
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [autoCheckDraft, setAutoCheckDraft] = useState(false);
  const [confirmBaseUrl, setConfirmBaseUrl] = useState<string | null>(null);
  const [records, setRecords] = useState<AuditRowLike[] | null>(null);
  const [recordsError, setRecordsError] = useState('');
  const [message, setMessage] = useState('');

  const seedDrafts = (cfg: UpdateSettingsPublic, nextState: UpdateState | null) => {
    setSettings(cfg);
    setBaseUrlDraft(cfg.baseUrl);
    setAutoCheckDraft(cfg.autoCheck ?? nextState?.autoCheck ?? false);
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const [v, s, cfg] = await Promise.all([
        maybe(api?.getAppVersion?.()),
        maybe(api?.getUpdateState?.()),
        maybe(api?.getUpdateSettings?.()),
      ]);
      if (!active) return;
      if (v !== null) setAppVersion(v);
      if (s !== null) setState(s);
      if (cfg !== null) seedDrafts(cfg, s);
    })();
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!api?.on) return;
    const offs: Array<() => void> = [];
    const subscribe = (channels: string[], handler: (payload: unknown) => void) => {
      for (const ch of channels) {
        const off = api.on?.(ch, handler);
        if (typeof off === 'function') offs.push(off);
      }
    };
    subscribe(STATE_CHANNELS, (payload) => {
      if (payload && typeof payload === 'object') {
        setState(payload as UpdateState);
        setChoice(null); // 状态刷新后解除二选一互斥
      }
    });
    subscribe(PROGRESS_CHANNELS, (payload) => {
      if (payload && typeof payload === 'object') {
        const progress = payload as UpdateProgress;
        setState((prev) => (prev ? { ...prev, progress } : prev));
      }
    });
    return () => { for (const off of offs) off(); };
  }, [api]);

  const savedBaseUrl = settings?.baseUrl ?? '';
  const savedAutoCheck = settings?.autoCheck ?? state?.autoCheck ?? false;
  const baseChanged = baseUrlDraft.trim() !== savedBaseUrl;
  const autoChanged = autoCheckDraft !== savedAutoCheck;
  const dirty = baseChanged || autoChanged;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const refresh = async () => {
    const s = await maybe(api?.getUpdateState?.());
    if (s) { setState(s); setChoice(null); }
    const cfg = await maybe(api?.getUpdateSettings?.());
    if (cfg) seedDrafts(cfg, s);
  };

  /** 地址改动一律先确认再落盘：写审计与「校验 host / 拒绝非法 scheme」在 Main 侧完成。 */
  const requestSave = () => {
    if (!baseChanged && !autoChanged) { setMessage('没有需要保存的更改'); return; }
    if (baseChanged) { setConfirmBaseUrl(baseUrlDraft.trim()); return; }
    void commitSave(false);
  };

  const commitSave = async (confirmedBaseChange: boolean) => {
    const patch: UpdateSettingsPatch = {};
    if (confirmedBaseChange) patch.baseUrl = (confirmBaseUrl ?? '').trim();
    if (autoChanged) patch.autoCheck = autoCheckDraft;
    setConfirmBaseUrl(null);
    await run('保存', () => api?.saveUpdateSettings?.(patch));
  };

  const loadRecords = async () => {
    if (!api?.queryAudit) { setRecordsError('本地检查记录不可用'); return; }
    setRecordsError('');
    try {
      // resource='auto-update' 是 Main 侧所有 update.* 事件的固定归属（update/audit.ts）。
      const rows = await api.queryAudit({ resource: 'auto-update' });
      setRecords(Array.isArray(rows) ? rows.slice(0, RECORDS_LIMIT) as AuditRowLike[] : []);
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : String(e));
      setRecords(null);
    }
  };

  const resetInstallIdNow = async () => {
    await run('重置检查标识', () => api?.resetInstallId?.());
  };

  const run = async (label: string, fn?: () => Promise<UpdateActionResult> | undefined) => {
    if (!fn) { setMessage(`${label}不可用`); return; }
    const p = fn();
    if (!p) { setMessage(`${label}不可用`); return; }
    setBusy(true);
    try {
      const r = await p;
      setMessage(r && !r.ok ? (r.message ?? updateFailureText(r.reason) ?? `${label}未完成`) : '');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const tampered = state?.stateTampered === true;
  const locked = busy || choice !== null || tampered;
  const baseUrl = settings?.baseUrl ?? state?.baseUrl ?? '';
  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const versionFor = (): string => state?.local?.version ?? state?.remote?.version ?? '';
  // §7.5「点安装 · 有活跃进程 ⇒ 居中确认」：判定源全在 Main 侧（待审批数 + 活跃会话数），
  // Renderer 只展示数字，不自行推断。
  const approvals = state?.pendingApprovals ?? 0;
  const activeSessions = state?.activeSessions ?? 0;
  const hasActiveWork = approvals > 0 || activeSessions > 0;
  const badge = phaseBadge(state, baseUrl);
  const pct = state?.progress ? clampPercent(state.progress.percent) : null;

  /** 安装入口统一走这里：有活跃工作先弹确认，取消即回「可安装」且包完好（不发任何 IPC）。 */
  const requestInstall = (version: string) => {
    if (!version || !api?.installUpdate) return;
    if (hasActiveWork) { setConfirmVersion(version); return; }
    void run('安装', () => api.installUpdate?.({ version }));
  };

  const confirmInstall = () => {
    const version = confirmVersion;
    setConfirmVersion(null);
    if (!version) return;
    void run('安装', () => api?.installUpdate?.({ version }));
  };

  return (
    <>
      <SettingsPageHeader title="软件更新" />

      {tampered && (
        <div className="settings-update-alert" role="alert">更新状态异常，需手动恢复</div>
      )}
      {/* §7.5「重启后失败给明确提示 + 重试 / 回滚入口」：只有 Main 侧确认上次安装未收尾才显示。 */}
      {!tampered && state?.phase === 'error' && state.errorCode === 'INSTALL_FAILED' && (
        <div className="settings-update-alert" role="alert" data-testid="update-install-failed">
          <div>上次升级没有成功完成，你的本地数据未受影响。</div>
          <div className="settings-actions">
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              data-testid="update-install-retry"
              disabled={busy || !versionFor() || !api?.installUpdate}
              onClick={() => requestInstall(versionFor())}
            >
              重试安装{state.local?.version ? ` ${state.local.version}` : ''}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              data-testid="update-install-discard"
              disabled={busy || !versionFor() || !api?.clearDownloaded}
              onClick={() => void run('删除', () => api?.clearDownloaded?.({ version: versionFor() }))}
            >
              删除已下载包
            </button>
          </div>
        </div>
      )}

      <SettingsSection>
        <div className="settings-update-head">
          <div className="settings-update-version">
            <span className="settings-update-version-label">当前版本</span>
            <span className="settings-update-version-value">{appVersion || '—'}</span>
          </div>
          <span className={`settings-update-badge settings-update-badge--${badge.tone}`}>{badge.text}</span>
        </div>

        <SettingsRow label="更新源地址" htmlFor="sparkii-update-baseurl" description="留空表示关闭自动检查。">
          <TextArea
            id="sparkii-update-baseurl"
            className="settings-update-url"
            rows={2}
            inputMode="url"
            spellCheck={false}
            value={baseUrlDraft}
            disabled={!api?.saveUpdateSettings || tampered}
            placeholder="http://<内网地址>/sparkii-updates/"
            onChange={(e) => { setBaseUrlDraft(e.target.value); setMessage(''); }}
          />
        </SettingsRow>

        <SettingsRow label="自动检查">
          <Switch
            label="自动检查"
            checked={autoCheckDraft}
            disabled={!api?.saveUpdateSettings || tampered}
            onCheckedChange={(next) => { setAutoCheckDraft(next); setMessage(''); }}
          />
        </SettingsRow>

        <SettingsRow label="上次成功检查">
          <span className="ui-muted">{lastSuccessAt ? new Date(lastSuccessAt).toLocaleString('zh-CN') : '尚无记录'}</span>
        </SettingsRow>

        <div className="settings-update-check-row">
          <button
            type="button"
            className="ui-btn ui-btn--md"
            disabled={locked || !api?.checkForUpdate}
            onClick={() => void run('检查更新', () => api?.checkForUpdate?.(true))}
          >
            立即检查更新
          </button>
        </div>
      </SettingsSection>

      {/* 发布说明一律结构化纯文本渲染；禁止 dangerouslySetInnerHTML / 远程 HTML。 */}
      {(state?.remote?.summary || (state?.remote?.highlights?.length ?? 0) > 0) && (
        <SettingsSection title={`更新内容${state?.remote?.version ? ` · ${state.remote.version}` : ''}`}>
          {state?.remote?.summary && <p className="settings-update-summary">{state.remote.summary}</p>}
          {Array.isArray(state?.remote?.highlights) && state.remote.highlights.length > 0 && (
            <ul className="settings-update-highlights">
              {state.remote.highlights.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          )}
        </SettingsSection>
      )}

      {/* 0.2 / 0.3 二选一：两个按钮互斥，任一点击后禁用另一个直到状态刷新。 */}
      {state?.choiceRequired === true && (
        <div className="settings-update-choice">
          <div className="ui-muted settings-hint">检测到本地已下载版本与服务器新版本，请选择其一：</div>
          <div className="settings-actions">
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              disabled={locked || !state.local?.version || !api?.installUpdate}
              onClick={() => {
                const v = state.local?.version ?? '';
                setChoice('local');
                requestInstall(v);
              }}
            >
              安装已下载的 {state.local?.version}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn--sm ui-btn--primary"
              disabled={locked || !state.remote?.version || !api?.downloadUpdate}
              onClick={() => {
                const v = state.remote?.version ?? '';
                setChoice('remote');
                void run('下载', () => api?.downloadUpdate?.({ version: v }));
              }}
            >
              跳过本地，升级到 {state.remote?.version}
            </button>
          </div>
        </div>
      )}

      {state?.phase === 'downloading' && (
        <div className="settings-update-progress">
          <div className="settings-update-progress-head">
            <span className="ui-muted">下载中{pct !== null ? ` · ${pct}%` : ''}</span>
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              disabled={tampered || !api?.cancelDownload}
              onClick={() => void run('取消下载', () => api?.cancelDownload?.())}
            >
              取消下载
            </button>
          </div>
          <div
            className="update-progress"
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? 0}
          >
            <span className="update-progress-fill" style={{ width: `${pct ?? 0}%` }} />
          </div>
        </div>
      )}

      {state?.phase === 'readyToInstall' && (
        <div className="settings-update-footer-actions">
          <button
            type="button"
            className="ui-btn ui-btn--md ui-btn--primary"
            disabled={locked || !versionFor() || !api?.installUpdate}
            onClick={() => requestInstall(versionFor())}
          >
            安装
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--sm"
            disabled={locked || !versionFor() || !api?.clearDownloaded}
            onClick={() => void run('删除', () => api?.clearDownloaded?.({ version: versionFor() }))}
          >
            删除已下载包
          </button>
        </div>
      )}

      {state?.phase === 'available' && (
        <div className="settings-update-footer-actions">
          <button
            type="button"
            className="ui-btn ui-btn--md ui-btn--primary"
            disabled={locked || !state.remote?.version || !api?.downloadUpdate}
            onClick={() => {
              const v = state.remote?.version ?? '';
              void run('下载', () => api?.downloadUpdate?.({ version: v }));
            }}
          >
            下载
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--sm"
            disabled={locked || !api?.deferUpdate}
            onClick={() => void run('稍后', () => api?.deferUpdate?.())}
          >
            稍后
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--sm ui-btn--ghost"
            disabled={locked || !state.remote?.version || !api?.skipUpdate}
            onClick={() => {
              const v = state.remote?.version ?? '';
              void run('跳过', () => api?.skipUpdate?.({ version: v }));
            }}
          >
            跳过此版本
          </button>
        </div>
      )}

      {/* §6.6 另外两个入口是诊断性质：默认折叠在「高级选项」里，普通用户不需要看到。 */}
      <SettingsSection>
      <details className="settings-update-advanced">
        <summary>高级选项</summary>
        <div className="settings-update-advanced-body">
          <div className="settings-actions settings-update-privacy-actions">
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              data-testid="update-records-toggle"
              disabled={!api?.queryAudit}
              onClick={() => (records === null ? void loadRecords() : setRecords(null))}
            >
              {records === null ? '查看本地检查记录' : '收起本地检查记录'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              data-testid="update-reset-installid"
              disabled={locked || !api?.resetInstallId}
              onClick={() => void resetInstallIdNow()}
            >
              重置检查标识
            </button>
          </div>
          {recordsError && <div className="ui-muted settings-hint">{recordsError}</div>}
          {records !== null && (
            <div className="settings-update-records" data-testid="update-records">
              {records.length === 0 ? (
                <div className="ui-muted settings-hint">暂无本地检查记录</div>
              ) : (
                <ul className="settings-update-records-list">
                  {records.map((r, i) => (
                    <li key={`${r.ts ?? 0}-${i}`}>
                      <span className="settings-update-records-time">{formatAuditTime(r.ts)}</span>
                      <span className="settings-update-records-action">{r.action ?? '—'}</span>
                      <span className="settings-update-records-detail">{r.payloadSummary ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </details>
      </SettingsSection>

      <SettingsSaveBar
        dirty={dirty && !tampered}
        saving={busy}
        status={message}
        error={tampered ? '更新状态异常，需手动恢复' : ''}
        onSave={requestSave}
        saveTestId="update-baseurl-save"
      />

      {/* §6.6：baseUrl 变更需二次确认，并由 Main 侧严格校验 + 写审计（非法 scheme 会被拒绝）。 */}
      <Modal
        open={confirmBaseUrl !== null}
        title="更换更新源地址"
        onClose={() => setConfirmBaseUrl(null)}
      >
        <p className="settings-update-confirm-body">
          新地址将写入设置；留空表示关闭自动检查。
        </p>
        <ul className="settings-update-confirm-list">
          <li>当前：{savedBaseUrl || '未配置'}</li>
          <li>新地址：{confirmBaseUrl || '（留空 = 关闭自动检查）'}</li>
        </ul>
        <div className="settings-actions">
          <button
            type="button"
            className="ui-btn ui-btn--sm"
            data-testid="update-baseurl-cancel"
            onClick={() => setConfirmBaseUrl(null)}
          >
            取消
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--sm ui-btn--primary"
            data-testid="update-baseurl-confirm"
            onClick={() => void commitSave(true)}
          >
            确认更换
          </button>
        </div>
      </Modal>

      {/* §7.5 / §7.7 步骤 2：安装会中断活跃工作，必须先取得显式确认；取消 = 回到可安装且不丢包。 */}
      <Modal
        open={confirmVersion !== null}
        title="安装会关闭正在运行的智能体"
        onClose={() => setConfirmVersion(null)}
      >
        <p className="settings-update-confirm-body">
          安装会关闭正在运行的智能体，可能丢失未完成的工作，是否继续？
        </p>
        <ul className="settings-update-confirm-list">
          <li>活跃会话：{activeSessions} 个</li>
          <li>将被放弃的待审批项：{approvals} 个</li>
          <li>目标版本：{confirmVersion ?? ''}</li>
        </ul>
        <div className="settings-actions">
          <button
            type="button"
            className="ui-btn ui-btn--sm"
            data-testid="update-confirm-cancel"
            onClick={() => setConfirmVersion(null)}
          >
            取消（保留已下载的包）
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--sm ui-btn--primary"
            data-testid="update-confirm-ok"
            onClick={confirmInstall}
          >
            继续安装
          </button>
        </div>
      </Modal>
    </>
  );
}
