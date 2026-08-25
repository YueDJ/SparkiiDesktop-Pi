import type { ShellAgent, ScreenId } from '../shell/Shell.js';
import { riskInfo, type ApprovalProposalLike } from '../trust/types.js';

export interface HomeViewProps {
  userName: string;
  agents: ShellAgent[];
  pendingApprovals: ApprovalProposalLike[];
  onNavigate(screen: ScreenId): void;
}

export function HomeView(props: HomeViewProps) {
  const { userName, agents, pendingApprovals, onNavigate } = props;
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>工作台 · 上午好,{userName}</div>
      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>待你处理</h3>
          {pendingApprovals.length === 0
            ? <div className="muted">没有待审批事项</div>
            : pendingApprovals.map((p) => (
              <div key={p.id} className="item" onClick={() => onNavigate('approvals')}>
                <span className="dot dot-wait" />
                <span>{p.summary}</span>
                <span className={`risk-b ${riskInfo(p.risk).cls}`}>{riskInfo(p.risk).label}</span>
                <span className="muted">查看 →</span>
              </div>
            ))}
        </div>
        <div className="card">
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>系统状态</h3>
          <div className="kv">
            <span className="ok-t">●</span> 本机运行<br />
            <span className="ok-t">●</span> 审计已开启<br />
            <span className="muted">○ 模型:未测试(设置 → 大模型连接)</span>
          </div>
        </div>
      </div>
      <div className="rail-label" style={{ margin: '0 0 8px' }}>智能体</div>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        {agents.map((a) => (
          <button key={a.id} type="button" className="agent-card" data-testid={`agent-card-${a.id}`} onClick={() => onNavigate(a.id)}>
            <div className="nm">{a.name}</div>
            <div className="muted">{a.status === 'running' ? '运行中' : a.status === 'queued' ? `排队 ${a.queuePosition}` : '空闲'}</div>
          </button>
        ))}
      </div>
      <div className="rail-label" style={{ margin: '0 0 8px' }}>最近会话</div>
      <div className="card">
        <div className="muted">暂无会话记录(会话历史接口待后端提供)</div>
      </div>
    </div>
  );
}
