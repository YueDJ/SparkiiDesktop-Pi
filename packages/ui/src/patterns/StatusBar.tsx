import { EMPTY_DOCUMENT_PARSE, type DocumentParseSnapshot, type RuntimePoolSummary } from './RuntimeCenter.js';

export function StatusBar({
  statusText,
  runtimePool,
  documentParse = EMPTY_DOCUMENT_PARSE,
  onOpenQueue,
}: {
  statusText: string;
  runtimePool?: RuntimePoolSummary;
  documentParse?: DocumentParseSnapshot;
  onOpenQueue(): void;
}) {
  const active = runtimePool?.active ?? 0;
  const queued = runtimePool?.queued ?? 0;
  const maxAgents = runtimePool?.maxAgents ?? 0;
  const parseBusy = documentParse.status === 'starting' || documentParse.status === 'parsing';
  const queueLabel = `运行 ${active}/${maxAgents} · ${queued} 排队${parseBusy ? ' · 文档解析进行中' : ''}`;
  return (
    <footer className="ui-statusbar">
      <span className="ui-statusbar-text">{statusText}</span>
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
