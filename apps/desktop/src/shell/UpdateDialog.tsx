import { useEffect, useState } from 'react';
import { Modal } from '@sparkii/ui';
import { CheckIcon, DownloadIcon, SparkIcon } from '@sparkii/ui';
import type {
  SparkiiApi,
  UpdateActionResult,
  UpdateState,
} from '../../electron/preload/api-types.js';

/** 只依赖更新相关的 IPC；未接线的 mock 一律当「不可用」，不抛错。 */
export type UpdateDialogApi = Partial<Pick<SparkiiApi,
  'checkForUpdate' | 'downloadUpdate' | 'cancelDownload' | 'installUpdate'
  | 'clearDownloaded' | 'deferUpdate' | 'skipUpdate'>>;

const clampPercent = (p: unknown): number =>
  typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;

const formatMb = (bytes: unknown): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/**
 * 状态栏更新徽标的详情对话框（§7.5）。状态栏只负责「有变化」这一个事实，
 * 发布说明、进度和所有动作都在这里出现；安装会重启应用，因此必须用户显式确认。
 */
export function UpdateDialog({ open, state, api, onClose }: {
  open: boolean;
  state: UpdateState | null;
  api: UpdateDialogApi;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmWork, setConfirmWork] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const phase = state?.phase ?? 'idle';

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setMessage('');
      setConfirmWork(false);
      setInstalling(null);
    }
  }, [open]);

  // 状态被外部推进（下载完成 / 用户取消）后，不再停留在「确认关闭智能体」那一屏。
  useEffect(() => {
    if (phase !== 'readyToInstall') setConfirmWork(false);
  }, [phase]);

  const tampered = state?.stateTampered === true;
  const locked = busy || tampered || installing !== null;
  const remoteVersion = state?.remote?.version ?? '';
  const localVersion = state?.local?.version ?? '';
  const targetVersion = phase === 'readyToInstall' ? localVersion : remoteVersion;
  const activeSessions = state?.activeSessions ?? 0;
  const pendingApprovals = state?.pendingApprovals ?? 0;
  const hasActiveWork = activeSessions > 0 || pendingApprovals > 0;
  const pct = clampPercent(state?.progress?.percent);
  const bytesDownloaded = state?.progress?.bytesDownloaded ?? 0;
  const bytesTotal = state?.progress?.bytesTotal ?? 0;

  const run = async (
    label: string,
    fn?: () => Promise<UpdateActionResult> | undefined,
  ): Promise<UpdateActionResult | null> => {
    if (!fn) { setMessage(`${label}不可用`); return null; }
    const pending = fn();
    if (!pending) { setMessage(`${label}不可用`); return null; }
    setBusy(true);
    setMessage('');
    try {
      const result = await pending;
      if (result && !result.ok) setMessage(result.message ?? result.reason ?? `${label}未完成`);
      return result;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startDownload = () => {
    void run('下载', () => api.downloadUpdate?.({ version: remoteVersion }));
  };

  const startInstall = async (version: string, bypassConfirm = false) => {
    if (!version || !api.installUpdate) return;
    if (hasActiveWork && !confirmWork && !bypassConfirm) { setConfirmWork(true); return; }
    setInstalling(version);
    const result = await run('安装', () => api.installUpdate?.({ version }));
    if (!result || !result.ok) setInstalling(null);
  };

  const clearPackage = (version: string) => {
    void run('删除', () => api.clearDownloaded?.({ version }));
  };

  const defer = async () => {
    await run('稍后', () => api.deferUpdate?.());
    onClose();
  };

  const skip = async () => {
    await run('跳过', () => api.skipUpdate?.({ version: remoteVersion }));
    onClose();
  };

  const notes = state?.remote;
  const showNotes = (phase === 'available' || phase === 'readyToInstall' || phase === 'downloading')
    && (notes?.summary || (notes?.highlights?.length ?? 0) > 0);

  const hero = (() => {
    if (installing !== null) {
      return { tone: 'primary' as const, icon: <span className="ui-spinner" />, title: `正在安装 ${installing}`, subtitle: 'Sparkii 将退出并自动重启，请稍候' };
    }
    if (state?.choiceRequired === true) {
      return { tone: 'warn' as const, icon: <SparkIcon width={18} height={18} />, title: '有两个版本可选', subtitle: '本地已有下载包，服务器也有新版本' };
    }
    switch (phase) {
      case 'available':
        return { tone: 'warn' as const, icon: <SparkIcon width={18} height={18} />, title: `发现新版本 ${remoteVersion}`, subtitle: state?.currentVersion ? `当前版本 ${state.currentVersion}` : '已通过签名校验' };
      case 'downloading':
        return { tone: 'primary' as const, icon: <DownloadIcon width={18} height={18} />, title: `正在下载 ${remoteVersion}`, subtitle: '下载完成后可选择立即安装' };
      case 'readyToInstall':
        return { tone: 'ok' as const, icon: <CheckIcon width={18} height={18} />, title: `新版本 ${localVersion} 已就绪`, subtitle: '安装后 Sparkii 会自动重启' };
      case 'error':
        return { tone: 'risk' as const, icon: <DownloadIcon width={18} height={18} />, title: state?.errorCode === 'INSTALL_FAILED' ? '上次升级未完成' : '更新没有完成', subtitle: state?.errorCode === 'INSTALL_FAILED' ? '你的本地数据未受影响，可以重试' : '可稍后重试或更换更新源' };
      default:
        return { tone: 'primary' as const, icon: <SparkIcon width={18} height={18} />, title: '软件更新', subtitle: '检查是否有新版本可用' };
    }
  })();

  const actions = (() => {
    if (installing !== null) return null;
    if (tampered) {
      return (
        <div className="update-dialog-actions">
          <button type="button" className="ui-btn ui-btn--sm" onClick={onClose}>关闭</button>
        </div>
      );
    }
    if (state?.choiceRequired === true) {
      return (
        <div className="update-dialog-actions">
          <button type="button" className="ui-btn ui-btn--sm" disabled={locked || !localVersion || !api.installUpdate} onClick={() => void startInstall(localVersion)}>
            安装已下载的 {localVersion}
          </button>
          <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={locked || !remoteVersion || !api.downloadUpdate} onClick={startDownload}>
            升级到 {remoteVersion}
          </button>
        </div>
      );
    }
    switch (phase) {
      case 'available':
        return (
          <div className="update-dialog-actions">
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={locked || !api.skipUpdate} onClick={() => void skip()}>跳过此版本</button>
            <button type="button" className="ui-btn ui-btn--sm" disabled={locked || !api.deferUpdate} onClick={() => void defer()}>稍后提醒</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={locked || !api.downloadUpdate || !remoteVersion} onClick={startDownload}>立即下载</button>
          </div>
        );
      case 'downloading':
        return (
          <div className="update-dialog-actions">
            {/* busy 会持续到整包下载完；取消必须始终可用，否则下载中只剩一个灰按钮。 */}
            <button type="button" className="ui-btn ui-btn--sm" disabled={tampered || !api.cancelDownload} onClick={() => void run('取消下载', () => api.cancelDownload?.())}>
              取消下载
            </button>
          </div>
        );
      case 'readyToInstall':
        return (
          <div className="update-dialog-actions">
            <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={locked || !localVersion || !api.clearDownloaded} onClick={() => clearPackage(localVersion)}>删除已下载包</button>
            <button type="button" className="ui-btn ui-btn--sm" disabled={locked || !api.deferUpdate} onClick={() => void defer()}>稍后</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={locked || !localVersion || !api.installUpdate} onClick={() => void startInstall(localVersion)}>
              {confirmWork ? '仍要安装并重启' : '立即安装并重启'}
            </button>
          </div>
        );
      case 'error':
        if (state?.errorCode === 'INSTALL_FAILED') {
          return (
            <div className="update-dialog-actions">
              <button type="button" className="ui-btn ui-btn--sm" disabled={locked || !targetVersion || !api.clearDownloaded} onClick={() => clearPackage(targetVersion)}>删除已下载包</button>
              <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={locked || !targetVersion || !api.installUpdate} onClick={() => void startInstall(targetVersion, true)}>重试安装</button>
            </div>
          );
        }
        return (
          <div className="update-dialog-actions">
            <button type="button" className="ui-btn ui-btn--sm" onClick={onClose}>关闭</button>
          </div>
        );
      default:
        return (
          <div className="update-dialog-actions">
            <button type="button" className="ui-btn ui-btn--sm" onClick={onClose}>关闭</button>
            <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={busy || !api.checkForUpdate} onClick={() => void run('检查更新', () => api.checkForUpdate?.(true))}>立即检查更新</button>
          </div>
        );
    }
  })();

  return (
    <Modal open={open} title="软件更新" onClose={onClose} className="ui-modal--update">
      <div className="update-dialog" data-testid="update-dialog">
        {tampered && <div className="settings-update-alert" role="alert">更新状态异常，需手动恢复</div>}
        <div className={`update-dialog-hero update-dialog-hero--${hero.tone}`}>
          <span className="update-dialog-hero-icon">{hero.icon}</span>
          <div className="update-dialog-hero-text">
            <div className="update-dialog-title">{hero.title}</div>
            <div className="update-dialog-subtitle">{hero.subtitle}</div>
          </div>
        </div>

        {phase === 'downloading' && (
          <div className="update-dialog-progress" data-testid="update-dialog-progress">
            <div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <span className="update-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="update-dialog-progress-meta">
              <span className="update-dialog-percent">{pct}%</span>
              {bytesTotal > 0 && <span className="ui-muted">{formatMb(bytesDownloaded)} / {formatMb(bytesTotal)}</span>}
            </div>
          </div>
        )}

        {showNotes && (
          <div className="update-dialog-notes">
            <div className="update-dialog-notes-title">更新内容</div>
            {notes?.summary && <p className="update-dialog-summary">{notes.summary}</p>}
            {Array.isArray(notes?.highlights) && notes.highlights.length > 0 && (
              <ul className="update-dialog-highlights">
                {notes.highlights.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            )}
          </div>
        )}

        {phase === 'readyToInstall' && confirmWork && (
          <div className="update-dialog-warning" role="alert">
            <div className="update-dialog-warning-title">安装会关闭正在运行的智能体</div>
            <div className="update-dialog-warning-body">
              活跃会话：{activeSessions} 个 · 将被放弃的待审批项：{pendingApprovals} 个
            </div>
          </div>
        )}

        {(confirmWork || installing !== null) && (
          <div className="update-dialog-note">
            {installing !== null ? '安装开始后应用会自动退出；未完成的工作请提前保存。' : '取消则保留已下载的包，不会丢失任何文件。'}
          </div>
        )}

        {state?.httpWarning === true && (
          <div className="update-dialog-hint">当前使用 HTTP 更新源，安装包完整性由数字签名保证。</div>
        )}

        {message && <div className="update-dialog-message" role="status">{message}</div>}

        {actions}
      </div>
    </Modal>
  );
}
