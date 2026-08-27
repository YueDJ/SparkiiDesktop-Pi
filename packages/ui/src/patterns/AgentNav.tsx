export type AgentNavStatus = 'running' | 'idle' | 'queued';

export function AgentNav({ agents, active, onNavigate }: { agents: Array<{ id: string; name: string; status: AgentNavStatus; queuePosition?: number }>; active: string; onNavigate(id: string): void }) {
  return (
    <nav className="ui-agent-nav" aria-label="智能体">
      {agents.map((a) => (
        <button key={a.id} type="button" className={`ui-agent ${active === a.id ? 'on' : ''}`} onClick={() => onNavigate(a.id)}>
          <span>{a.name}</span>
          {a.status === 'queued' && <span className="ui-badge">排队{a.queuePosition ?? 1}</span>}
        </button>
      ))}
    </nav>
  );
}
