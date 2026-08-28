import { useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { Badge } from '../primitives/Badge.js';
import { Drawer } from '../primitives/Drawer.js';
import { AgentNav } from './AgentNav.js';
import { SessionList, type SessionListItem } from './SessionList.js';
import { StatusBar } from './StatusBar.js';
import { SessionsIcon, PlusIcon, GearIcon, MoonIcon, SunIcon, UserIcon, ShieldIcon, AuditIcon } from '../icons/index.js';

export type ScreenId = 'home' | 'contract' | 'chat' | 'dashboard' | 'general' | 'approvals' | 'audit' | 'settings';
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
  userName?: string;
  userRole?: string;
  surfaceTitle?: string;
  surfaceActions?: ReactNode;
  onNavigate(screen: ScreenId): void;
  onNewSession(agentId: string): void;
  onOpenSession?(agentId: string, sessionId: string): void;
  onRenameSession?(agentId: string, sessionId: string, title: string): void;
  onDeleteSession?(agentId: string, sessionId: string): void;
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

function setTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('sparkii-theme', dark ? 'dark' : 'light');
  } catch {
    /* storage unavailable */
  }
}

export function Shell(props: ShellProps) {
  const { active, agents, sessions, pendingApprovals, statusText, userName = 'admin', userRole = '审核员', surfaceTitle, surfaceActions, onNavigate, onNewSession, onOpenSession, children } = props;
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

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

  const startNewSession = (agentId: string) => {
    setDrawer(null);
    onNewSession(agentId);
  };

  const startRename = (s: SessionListItem) => {
    setRenamingId(s.id);
    setRenameDraft(s.name);
  };

  const commitRename = (agentId: string, s: SessionListItem) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title && title !== s.name) props.onRenameSession?.(agentId, s.id, title);
  };

  return (
    <div className="ui-shell">
      <header className="ui-topbar">
        <div className="ui-topbar-left">
          <Button variant="ghost" onClick={() => onNavigate('home')}>Sparkii</Button>
          <span className="ui-topbar-title">{title}</span>
        </div>
        <div className="ui-topbar-right">
          <span className="ui-trust-line">本机运行 · 审计✓</span>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('approvals')}><ShieldIcon /> 审批 {pendingApprovals > 0 && <Badge>{pendingApprovals}</Badge>}</Button>
          <IconButton label="账号" onClick={() => openDrawer('account')}><UserIcon /></IconButton>
          <IconButton label="深色/浅色" onClick={toggleTheme}>{dark ? <SunIcon /> : <MoonIcon />}</IconButton>
          <IconButton label="设置" onClick={() => onNavigate('settings')}><GearIcon /></IconButton>
        </div>
      </header>

      <div className="ui-shell-main">
        <aside className="ui-rail">
          <AgentNav agents={agents} active={active} onNavigate={onNavigate} />
          <Button variant="ghost" className="ui-btn--block" title="安装智能体(即将开放)">+ 安装</Button>
          <nav className="ui-rail-group" aria-label="全局">
            <Button variant="ghost" className="ui-btn--block" onClick={() => onNavigate('approvals')}>审批中心 {pendingApprovals > 0 && <Badge>{pendingApprovals}</Badge>}</Button>
            <Button variant="ghost" className="ui-btn--block" onClick={() => onNavigate('audit')}><AuditIcon />审计</Button>
          </nav>
        </aside>
        <main className="ui-surface">
          {surfaceTitle && (
            <div className="ui-surface-head">
              <b>{surfaceTitle}</b>
              <IconButton label="会话" onClick={() => openDrawer('session')}><SessionsIcon /></IconButton>
              <IconButton label="新会话" onClick={() => startNewSession(active)}><PlusIcon /></IconButton>
              {surfaceActions && <span className="ui-surface-head-right">{surfaceActions}</span>}
            </div>
          )}
          <div className="ui-surface-body">{children}</div>
        </main>
      </div>

      <StatusBar statusText={statusText} runningCount={runningCount} queueCount={queueCount} maxAgents={MAX_AGENTS} onOpenQueue={() => openDrawer('queue')} />

      <Drawer open={drawer === 'session'} title="会话" onClose={closeDrawer}>
        <SessionList
          sessions={activeSessions}
          onNew={() => startNewSession(active)}
          onOpen={(id) => (onOpenSession ? onOpenSession(active, id) : onNavigate(active))}
          onRename={props.onRenameSession ? (id) => startRename(activeSessions.find((s) => s.id === id)!) : undefined}
          onDelete={props.onDeleteSession ? (id) => props.onDeleteSession!(active, id) : undefined}
          renamingId={renamingId}
          renameDraft={renameDraft}
          onRenameChange={setRenameDraft}
          onRenameCommit={(id) => commitRename(active, activeSessions.find((s) => s.id === id)!)}
          onRenameCancel={() => setRenamingId(null)}
        />
      </Drawer>

      <Drawer open={drawer === 'queue'} title="运行队列" onClose={closeDrawer}>
        <div className="ui-rail-label">运行中</div>
        {runningCount === 0
          ? <div className="ui-muted">暂无运行中的智能体</div>
          : agents.filter((a) => a.status === 'running').map((a) => (
            <div key={a.id} className="ui-item"><span className="ui-dot ui-dot--running" />{a.name}</div>
          ))}
        <div className="ui-rail-label">排队中</div>
        {queueCount === 0
          ? <div className="ui-muted">暂无排队任务</div>
          : agents.filter((a) => a.status === 'queued').map((a) => (
            <div key={a.id} className="ui-item">
              <span className="ui-dot ui-dot--queued" />
              <span>{a.name} · 第 {a.queuePosition ?? 1} 位</span>
              <span className="ui-muted">取消</span>
            </div>
          ))}
        <p className="ui-muted">轮到时会通知你</p>
      </Drawer>

      <Drawer open={drawer === 'account'} title="账号" onClose={closeDrawer}>
        <div className="ui-kv">用户名:<b>{userName}</b></div>
        <div className="ui-kv">角色:<b>{userRole}</b></div>
        <div className="ui-kv">数据目录:<b>本机 · 已加密</b></div>
        <div className="ui-session-list ui-mt-sm">
          <div className="ui-item">修改密码</div>
          <div className="ui-item">导出审计记录</div>
        </div>
      </Drawer>
    </div>
  );
}
