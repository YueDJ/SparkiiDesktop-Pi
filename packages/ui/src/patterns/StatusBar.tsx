import { EMPTY_DOCUMENT_PARSE, type DocumentParseSnapshot, type RuntimePoolSummary } from './RuntimeCenter.js';
import { CheckIcon, DownloadIcon, SparkIcon } from '../icons/index.js';

/** 状态栏更新状态的本地等价类型：不 import 主进程模块，字段与契约 §3 逐字一致。 */
export type StatusBarUpdatePhase =
  | 'disabled' | 'idle' | 'checking' | 'available' | 'downloading'
  | 'readyToInstall' | 'installing' | 'restarting' | 'completed'
  | 'rolledBack' | 'error';

export interface UpdateStatusSummary {
  phase: StatusBarUpdatePhase;
  percent: number | null;
  label: string;
  version: string | null;
}

const clampPercent = (p: number): number =>
  Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;

/**
 * 更新入口在状态栏里只占一个 24px 的彩色徽标（§7.5）：
 * 有新版本 = 橙色星标，可安装 = 绿色对勾；下载中才展开成一条细进度胶囊。
 * 详情与操作全部交给宿主弹出的对话框，状态栏不堆文案。
 */
function chipIcon(phase: StatusBarUpdatePhase) {
  if (phase === 'readyToInstall') return <CheckIcon width={13} height={13} />;
  if (phase === 'available') return <SparkIcon width={13} height={13} />;
  return <DownloadIcon width={13} height={13} />;
}

function chipTip(update: UpdateStatusSummary, pct: number | null): string {
  const version = update.version ? ` ${update.version}` : '';
  if (update.phase === 'available') return `发现新版本${version}，点击查看`;
  if (update.phase === 'readyToInstall') return `新版本${version} 已下载完成，点击安装`;
  if (update.phase === 'downloading') return `正在下载${version}${pct !== null ? ` · ${pct}%` : ''}，点击查看`;
  return update.label;
}

export function StatusBar({
  statusText,
  runtimePool,
  documentParse = EMPTY_DOCUMENT_PARSE,
  onOpenQueue,
  update,
  onUpdateClick,
}: {
  statusText: string;
  runtimePool?: RuntimePoolSummary;
  documentParse?: DocumentParseSnapshot;
  onOpenQueue(): void;
  update?: UpdateStatusSummary;
  /** 徽标点击后由宿主弹出更新详情对话框（§7.5）；不传则保持纯展示。 */
  onUpdateClick?(): void;
}) {
  const active = runtimePool?.active ?? 0;
  const queued = runtimePool?.queued ?? 0;
  const maxAgents = runtimePool?.maxAgents ?? 0;
  const parseBusy = documentParse.status === 'starting' || documentParse.status === 'parsing';
  const queueLabel = `运行 ${active}/${maxAgents} · ${queued} 排队${parseBusy ? ' · 文档解析进行中' : ''}`;
  const pct = update && update.percent !== null ? clampPercent(update.percent) : null;
  const showUpdate = update !== undefined
    && (update.phase === 'downloading' || update.phase === 'available' || update.phase === 'readyToInstall');
  return (
    <footer className="ui-statusbar">
      <span className="ui-statusbar-text">{statusText}</span>
      {showUpdate && (() => {
        const tip = chipTip(update, pct);
        const chipClass = `ui-update-chip ui-update-chip--${update.phase}${onUpdateClick ? ' ui-update-chip--action' : ''}`;
        const inner = (
          <>
            <span className="ui-update-chip-icon" aria-hidden>{chipIcon(update.phase)}</span>
            {pct !== null && (
              <span className="ui-update-chip-meter" aria-hidden>
                <span className="ui-update-chip-track">
                  <span className="ui-update-chip-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="ui-update-chip-pct">{pct}%</span>
              </span>
            )}
            {pct !== null && (
              <progress className="ui-sr-only" value={pct} max={100} aria-label="更新下载进度" />
            )}
            <span className="ui-sr-only">
              {update.label}{update.version ? ` ${update.version}` : ''}{pct !== null ? ` ${pct}%` : ''}
            </span>
          </>
        );
        const ariaLabel = `${update.label}${update.version ? ` ${update.version}` : ''}，打开更新详情`;
        // 有宿主入口时用 button（可键盘聚焦、可读标签）；没有时保持非交互展示。
        if (!onUpdateClick) {
          return <span className={chipClass} data-tip={tip} data-testid="statusbar-update">{inner}</span>;
        }
        return (
          <button
            type="button"
            className={chipClass}
            data-tip={tip}
            data-testid="statusbar-update"
            onClick={onUpdateClick}
            aria-label={ariaLabel}
          >
            {inner}
          </button>
        );
      })()}
      <button
        type="button"
        className="ui-btn ui-btn--sm"
        onClick={onOpenQueue}
        aria-label={`打开运行中心，当前运行 ${active}/${maxAgents}，排队 ${queued}`}
      >
        {queueLabel}
      </button>
    </footer>
  );
}
