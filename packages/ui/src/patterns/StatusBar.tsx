export function StatusBar({ statusText, runningCount, queueCount, maxAgents, onOpenQueue }: { statusText: string; runningCount: number; queueCount: number; maxAgents: number; onOpenQueue(): void }) {
  return <footer className="ui-statusbar"><span className="ui-statusbar-text">{statusText}</span><button type="button" className="ui-btn ui-btn--sm" onClick={onOpenQueue}>运行 {runningCount}/{maxAgents} · {queueCount} 排队</button><span className="ui-statusbar-tech">本机运行</span></footer>;
}
