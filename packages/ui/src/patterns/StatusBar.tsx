import type { RuntimePoolSummary } from './RuntimeCenter.js';

export function StatusBar({ statusText, runtimePool, onOpenQueue }: { statusText: string; runtimePool?: RuntimePoolSummary; onOpenQueue(): void }) {
  const active = runtimePool?.active ?? 0;
  const queued = runtimePool?.queued ?? 0;
  const maxAgents = runtimePool?.maxAgents ?? 0;
  return <footer className="ui-statusbar"><span className="ui-statusbar-text">{statusText}</span><button type="button" className="ui-btn ui-btn--sm" onClick={onOpenQueue} aria-label={`打开运行中心，当前运行 ${active}/${maxAgents}，排队 ${queued}`}>运行 {active}/{maxAgents} · {queued} 排队</button></footer>;
}
