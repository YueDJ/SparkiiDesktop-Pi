import { EMPTY_DOCUMENT_PARSE, type DocumentParseSnapshot, type RuntimePoolSummary } from './RuntimeCenter.js';

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
  /** pill 的展开入口（§7.5「点击展开小面板」）；不传则保持纯展示的非交互 span。 */
  onUpdateClick?(): void;
}) {
  const active = runtimePool?.active ?? 0;
  const queued = runtimePool?.queued ?? 0;
  const maxAgents = runtimePool?.maxAgents ?? 0;
  const parseBusy = documentParse.status === 'starting' || documentParse.status === 'parsing';
  const queueLabel = `运行 ${active}/${maxAgents} · ${queued} 排队${parseBusy ? ' · 文档解析进行中' : ''}`;
  const pct = update && update.percent !== null ? clampPercent(update.percent) : null;
  return (
    <footer className="ui-statusbar">
      <span className="ui-statusbar-text">{statusText}</span>
      {update && (
        update.phase === 'downloading' || update.phase === 'available' || update.phase === 'readyToInstall'
      ) && (() => {
        const inner = (
          <>
            <span className="ui-statusbar-update-label">{update.label}</span>
            {update.version !== null && <span className="ui-statusbar-update-version">{update.version}</span>}
            {pct !== null && (
              <>
                <progress
                  className="ui-statusbar-update-progress"
                  value={pct}
                  max={100}
                  aria-label="更新下载进度"
                  aria-valuenow={pct}
                />
                {update.phase === 'downloading' && (
                  <span className="ui-statusbar-update-percent">{pct}%</span>
                )}
              </>
            )}
          </>
        );
        // 有展开入口时用 button（可键盘聚焦、可读标签），没有时保持非交互展示。
        if (!onUpdateClick) {
          return <span className="ui-statusbar-update" data-testid="statusbar-update">{inner}</span>;
        }
        return (
          <button
            type="button"
            className="ui-statusbar-update ui-statusbar-update--action"
            data-testid="statusbar-update"
            onClick={onUpdateClick}
            aria-label={`${update.label}${update.version ? ` ${update.version}` : ''}，打开更新详情`}
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
