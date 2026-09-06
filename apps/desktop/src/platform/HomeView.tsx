import type { ShellAgent, ScreenId } from '../shell/Shell.js';
import type { ApprovalProposalLike } from '../trust/types.js';
import { Card, StatusBadge, RiskBadge, Countdown } from '@sparkii/ui';
import { present } from '../trust/present.js';

export interface HomeViewProps {
  userName: string;
  agents: ShellAgent[];
  pendingApprovals: ApprovalProposalLike[];
  timeoutMs?: number;
  onNavigate(screen: ScreenId): void;
}

export function HomeView(props: HomeViewProps) {
  const { userName, agents, pendingApprovals, timeoutMs = 120000, onNavigate } = props;
  return (
    <div className="home">
      <div className="home-greeting">工作台 · 上午好,{userName}</div>
      <div className="home-grid-2">
        <Card>
          <h3 className="home-card-title">待你处理</h3>
          {pendingApprovals.length === 0
            ? <div className="ui-muted">没有待确认的事项</div>
            : pendingApprovals.map((p) => {
              const vm = present(p);
              return (
                <button key={p.id} type="button" className="home-approval-item" onClick={() => onNavigate('approvals')}>
                  <span>{vm.title}</span>
                  {vm.chrome.showRisk && <RiskBadge risk={p.risk} />}
                  {vm.chrome.showCountdown && <Countdown until={p.createdAt + timeoutMs} className="ui-countdown" />}
                  <span className="ui-muted">查看 →</span>
                </button>
              );
            })}
        </Card>
      </div>
      <div className="home-label">智能体</div>
      <div className="home-agents">
        {agents.map((a) => (
          <button key={a.id} type="button" className="home-agent-card" data-testid={`agent-card-${a.id}`} onClick={() => onNavigate(a.id)}>
            <div className="home-agent-name">{a.name}</div>
            <div className="home-agent-status">
              {a.status === 'idle'
                ? <span className="ui-muted">空闲</span>
                : <StatusBadge status={a.status === 'running' ? 'running' : 'queued'} />}
            </div>
          </button>
        ))}
      </div>
      <div className="home-label">最近会话</div>
      <Card><div className="ui-muted">在左侧「会话历史」中查看与管理各智能体的会话</div></Card>
    </div>
  );
}
