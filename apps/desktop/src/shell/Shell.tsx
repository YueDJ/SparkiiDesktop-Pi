import { useState, type ReactNode } from 'react';
import { setTheme } from './theme.js';
import {
  SessionsIcon, PlusIcon, GearIcon, MoonIcon, SunIcon, UserIcon, ShieldIcon, AuditIcon,
} from './icons.js';

export type ScreenId = 'home' | 'contract' | 'chat' | 'dashboard' | 'approvals' | 'audit' | 'settings';
export type AgentStatus = 'running' | 'idle' | 'queued';

export interface ShellAgent {
  id: ScreenId;
  name: string;
  status: AgentStatus;
  queuePosition?: number;
}

export interface ShellSession {
  id: string;
  name: string;
  state: string;
  time: string;
  active?: boolean;
}

export interface ShellProps {
  active: ScreenId;
  agents: ShellAgent[];
  sessions: Record<string, ShellSession[]>;
  pendingApprovals: number;
  statusText: string;
  surfaceTitle?: string;
  surfaceActions?: ReactNode;
  onNavigate(screen: ScreenId): void;
  onNewSession(agentId: string): void;
  children?: ReactNode;
}

const MAX_AGENTS = 4;
const TITLES: Partial<Record<ScreenId, string>> = {
  home: '工作台',
  approvals: '审批中心',
  audit: '审计',
  settings: '系统设置',
};

type DrawerKind = 'session' | 'queue' | 'account' | null;

export function Shell(props: ShellProps) {
  const { active, agents, sessions, pendingApprovals, statusText, surfaceTitle, surfaceActions, onNavigate, onNewSession, children } = props;
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const activeAgent = agents.find((a) => a.id === active);
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const queueCount = agents.filter((a) => a.status === 'queued').length;
  const title = activeAgent?.name ?? TITLES[active] ?? '工作台';
  const activeSessions = sessions[active] ?? [];

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    setTheme(next);
  };

  const closeDrawer = () => setDrawer(null);
  const openDrawer = (kind: Exclude<DrawerKind, null>) => setDrawer((cur) => (cur === kind ? null : kind));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="logo" onClick={() => onNavigate('home')}>Sparkii</button>
          <span className="topbar-title">{title}</span>
        </div>
        <div className="topbar-right">
          <span className="trust-line"><span className="dot dot-ok" />本机运行 · 审计✓</span>
          <button type="button" className="pill" onClick={() => onNavigate('approvals')}>
            <ShieldIcon /> 审批 {pendingApprovals > 0 && <b className="pill-count">{pendingApprovals}</b>}
          </button>
          <button type="button" className="icon-btn" title="账号" onClick={() => openDrawer('account')}>
            <UserIcon />
          </button>
          <button type="button" className="icon-btn" title="深色/浅色" onClick={toggleTheme}>
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" className="icon-btn" title="设置" onClick={() => onNavigate('settings')}>
            <GearIcon />
          </button>
        </div>
      </header>

      <div className="mid">
        <aside className="rail">
          <nav className="rail-group" aria-label="智能体">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className={`agent ${active === agent.id ? 'on' : ''}`}
                onClick={() => onNavigate(agent.id)}
              >
                <span className={`dot dot-${agent.status}`} />
                <span>{agent.name}</span>
                {agent.status === 'queued' && <span className="q-badge">排队{agent.queuePosition ?? 1}</span>}
              </button>
            ))}
            <button type="button" className="agent ghost" title="安装智能体(即将开放)">
              <span className="dot dot-idle" />+ 安装
            </button>
          </nav>
          <nav className="rail-group" aria-label="全局">
            <button type="button" className={`agent ${active === 'approvals' ? 'on' : ''}`} onClick={() => onNavigate('approvals')}>
              <span className="dot dot-idle" />审批中心 {pendingApprovals > 0 && <span className="q-badge">{pendingApprovals}</span>}
            </button>
            <button type="button" className={`agent ${active === 'audit' ? 'on' : ''}`} onClick={() => onNavigate('audit')}>
              <span className="dot dot-idle" /><AuditIcon />审计
            </button>
          </nav>
        </aside>
        <main className="surface">
          {surfaceTitle && (
            <div className="surface-head">
              <b>{surfaceTitle}</b>
              <button type="button" className="btn sm ic" title="会话" onClick={() => openDrawer('session')}><SessionsIcon /></button>
              <button type="button" className="btn sm ic" title="新会话" onClick={() => onNewSession(active)}><PlusIcon /></button>
              {surfaceActions && <span className="surface-head-right">{surfaceActions}</span>}
            </div>
          )}
          {children}
        </main>
      </div>

      <footer className="statusbar">
        <span className="status-text">{statusText}</span>
        <button type="button" className="queue-entry" onClick={() => openDrawer('queue')}>
          运行 {runningCount}/{MAX_AGENTS} · {queueCount} 排队
        </button>
        <span className="tech">本机 · deepseek-chat</span>
      </footer>

      {drawer && <button type="button" className="drawer-backdrop" data-testid="drawer-backdrop" aria-label="关闭面板" onClick={closeDrawer} />}

      <aside className={`drawer ${drawer === 'session' ? 'open' : ''}`} aria-label="会话">
        <div className="drawer-head">
          <span>会话</span>
          <button type="button" className="icon-btn" title="关闭" onClick={closeDrawer}>✕</button>
        </div>
        <div className="drawer-body">
          <button type="button" className="btn primary block" onClick={() => onNewSession(active)}>+ 新会话</button>
          <div className="appr-list">
            {activeSessions.map((s) => (
              <button key={s.id} type="button" className="item" onClick={() => onNavigate(active)}>
                <span className={`dot ${s.active ? 'dot-run' : 'dot-idle'}`} />
                <span>{s.name} {s.state}</span>
                <span className="muted">{s.time}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <aside className={`drawer ${drawer === 'queue' ? 'open' : ''}`} aria-label="运行队列">
        <div className="drawer-head">
          <span>运行队列</span>
          <button type="button" className="icon-btn" title="关闭" onClick={closeDrawer}>✕</button>
        </div>
        <div className="drawer-body">
          <div className="rail-label">运行中</div>
          {agents.filter((a) => a.status === 'running').map((a) => (
            <div key={a.id} className="item"><span className="dot dot-run" />{a.name}</div>
          ))}
          <div className="rail-label">排队中</div>
          {agents.filter((a) => a.status === 'queued').map((a) => (
            <div key={a.id} className="item">
              <span className="dot dot-wait" />
              <span>{a.name} · 第 {a.queuePosition ?? 1} 位</span>
              <span className="muted">取消</span>
            </div>
          ))}
          <p className="muted">轮到时会通知你</p>
        </div>
      </aside>

      <aside className={`drawer ${drawer === 'account' ? 'open' : ''}`} aria-label="账号">
        <div className="drawer-head">
          <span>账号</span>
          <button type="button" className="icon-btn" title="关闭" onClick={closeDrawer}>✕</button>
        </div>
        <div className="drawer-body">
          <div className="kv">用户名:<b>admin</b></div>
          <div className="kv">角色:<b>审核员</b></div>
          <div className="kv">数据目录:<b>本机 · 已加密</b></div>
          <div className="appr-list" style={{ marginTop: 12 }}>
            <div className="item">修改密码</div>
            <div className="item">导出审计记录</div>
          </div>
        </div>
      </aside>
    </div>
  );
}
