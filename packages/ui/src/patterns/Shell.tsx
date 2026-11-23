import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { Badge } from '../primitives/Badge.js';
import { Drawer } from '../primitives/Drawer.js';
import { AgentNav } from './AgentNav.js';
import { SessionList, type SessionGroup, type SessionListItem } from './SessionList.js';
import { StatusBar, type UpdateStatusSummary } from './StatusBar.js';
import { EMPTY_DOCUMENT_PARSE, RuntimeCenter, type DocumentParseSnapshot, type RuntimePoolSummary } from './RuntimeCenter.js';
import { ErrorCenterPanel, useErrors } from './ErrorCenter.js';
import { TextField } from '../primitives/TextField.js';
import { GearIcon, MoonIcon, SunIcon, UserIcon, ShieldIcon, ChevronRightIcon, SearchIcon, CloseIcon, MinimizeIcon, MaximizeIcon, WindowRestoreIcon, BellIcon, SparkiiMark } from '../icons/index.js';

export type PlatformScreen = 'home' | 'approvals' | 'audit' | 'settings';
export type ScreenId = PlatformScreen | string;
export type AgentStatus = 'running' | 'idle' | 'queued';

export interface ShellAgent {
  id: string;
  name: string;
  status: AgentStatus;
  surfaceType?: string;
  /** Sessions sharing a workspace collapse into one project row. */
  projectScoped?: boolean;
  queuePosition?: number;
  knowledge?: {
    enabled: boolean;
    picker: 'hidden' | 'session';
    backend: 'bm25' | 'sparkiirag';
  };
}

export interface ShellSession {
  id: string;
  name: string;
  state: string;
  time?: string;
  active?: boolean;
  pinned?: boolean;
  archived?: boolean;
  updatedAt?: number;
  sortOrder?: number | null;
  /** Workspace root from listChatSessions; used to derive project groups. */
  workspacePath?: string;
  /** Read-only project.json.name for project-scoped surfaces (group label). */
  workspaceName?: string;
}

export interface ShellProps {
  active: ScreenId;
  agents: ShellAgent[];
  sessions: Record<string, ShellSession[]>;
  pendingApprovals: number;
  statusText: string;
  runtimePool?: RuntimePoolSummary;
  documentParse?: DocumentParseSnapshot;
  userName?: string;
  userRole?: string;
  onNavigate(screen: ScreenId): void;
  onNewSession(agentId: string): void;
  onOpenSession?(agentId: string, sessionId: string): void;
  onRenameSession?(agentId: string, sessionId: string, title: string): void;
  onDeleteSession?(agentId: string, sessionId: string): void;
  onPinSession?(agentId: string, sessionId: string, pinned: boolean): void;
  onArchiveSession?(agentId: string, sessionId: string, archived: boolean): void;
  onReorderSession?(agentId: string, orderedSessionIds: string[]): void;
  onStopSession?(sessionId: string): Promise<void> | void;
  onReleaseSession?(sessionId: string): Promise<void> | void;
  onCancelQueuedSession?(queueId: string): Promise<void> | void;
  onStopParse?(): Promise<void> | void;
  onReleaseParse?(): Promise<void> | void;
  onCancelLoad?(): Promise<void> | void;
  /** 状态栏更新 pill（§7.5）：宿主给数据才显示，缺省时 StatusBar 完全保持现状。 */
  update?: UpdateStatusSummary;
  onUpdateClick?(): void;
  children?: ReactNode;
}

const MAX_AGENTS = 4;
const TITLES: Partial<Record<ScreenId, string>> = {
  home: '工作台',
  approvals: '审批中心',
  audit: '审计',
  settings: '系统设置',
};

type DrawerKind = 'queue' | 'account' | 'errors' | null;

function setTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('sparkii-theme', dark ? 'dark' : 'light');
  } catch {
    /* storage unavailable */
  }
}

function isRunningStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'waiting-approval' || status === 'streaming' || status === 'starting';
}

export function Shell(props: ShellProps) {
  const { active, agents, sessions, pendingApprovals, statusText, runtimePool, documentParse = EMPTY_DOCUMENT_PARSE, userName = 'admin', userRole = '审核员', onNavigate, onNewSession, onOpenSession, children } = props;
  const { unreadCount, toast, dismissToast } = useErrors();
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [renaming, setRenaming] = useState<{ agentId: string; sessionId: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [maximized, setMaximized] = useState(false);
  const windowApi = (globalThis as any).window?.sparkii as
    | {
        windowMinimize?: () => Promise<boolean>;
        windowToggleMaximize?: () => Promise<boolean>;
        windowClose?: () => Promise<boolean>;
        windowIsMaximized?: () => Promise<boolean>;
        on?: (channel: string, cb: (payload: unknown) => void) => () => void;
      }
    | undefined;

  useEffect(() => {
    if (!windowApi?.windowIsMaximized) return;
    const off = windowApi.on?.('window-maximized', (v) => setMaximized(!!v));
    windowApi.windowIsMaximized().then((v) => setMaximized(!!v)).catch(() => {});
    return () => off?.();
  }, [windowApi]);

  // 主题可能由设置页改写（同一个 document 上的 dark class），顶栏图标必须跟着变。
  useEffect(() => {
    const target = document.documentElement;
    const sync = () => setDark(target.classList.contains('dark'));
    const observer = new MutationObserver(sync);
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const activeAgent = agents.find((a) => a.id === active);
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const queueCount = agents.filter((a) => a.status === 'queued').length;
  const title = activeAgent?.name ?? TITLES[active] ?? '工作台';
  const fallbackRuntimePool: RuntimePoolSummary = runtimePool ?? {
    active: runningCount,
    queued: queueCount,
    maxAgents: MAX_AGENTS,
    sessions: agents
      .filter((a) => a.status === 'running')
      .map((a) => ({ sessionId: a.id, profileId: a.id, profileName: a.name, label: a.name, status: 'running' as const })),
    queue: agents
      .filter((a) => a.status === 'queued')
      .map((a, i) => ({ queueId: a.id, profileId: a.id, profileName: a.name, label: a.name, position: a.queuePosition ?? i + 1 })),
  };

  // 每个会话的运行状态：idle 不显示，running 显示旋转圆环
  const runningSessionIds = useMemo(() => {
    const pool = runtimePool ?? fallbackRuntimePool;
    return new Set((pool.sessions ?? []).filter((s) => isRunningStatus(s.status)).map((s) => s.sessionId));
  }, [runtimePool, fallbackRuntimePool]);

  // 按智能体分组会话历史；没有历史记录的智能体不显示分组。
  // projectScoped 智能体按 workspacePath 派生项目行：一个项目一行，组名固定取
  // project.json.name（不随单条会话改名漂移）；点击行打开 updatedAt 最新会话。
  const groups = useMemo<SessionGroup[]>(() => {
    const agentIds = [...agents.map((a) => a.id), ...Object.keys(sessions).filter((id) => !agents.some((a) => a.id === id))];
    const built: SessionGroup[] = [];
    for (const agentId of agentIds.filter((id, i, arr) => arr.indexOf(id) === i)) {
      const agent = agents.find((a) => a.id === agentId);
      const rows = sessions[agentId] ?? [];
      if (agent?.projectScoped) {
        const byWorkspace = new Map<string, ShellSession[]>();
        for (const row of rows) {
          const key = row.workspacePath || row.id;
          byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), row]);
        }
        for (const [workspaceKey, bucket] of byWorkspace) {
          const ordered = [...bucket].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          const live = ordered.filter((s) => !s.archived);
          const latest = (live.length ? live : ordered)[0];
          const projectName = bucket.find((s) => s.workspaceName)?.workspaceName ?? latest.name;
          built.push({
            agentId,
            groupKey: `${agentId}::${workspaceKey}`,
            agentName: projectName,
            hideHeader: true,
            noReorder: true,
            sessions: [{
              id: latest.id,
              name: projectName,
              active: bucket.some((s) => s.active),
              pinned: bucket.some((s) => s.pinned),
              archived: live.length === 0,
              running: runningSessionIds.has(latest.id),
              updatedAt: latest.updatedAt,
              sortOrder: latest.sortOrder,
            }],
          });
        }
        continue;
      }
      const list: SessionListItem[] = rows.map((s) => ({
        id: s.id,
        name: s.name,
        active: s.active,
        pinned: s.pinned,
        archived: s.archived,
        running: runningSessionIds.has(s.id),
        updatedAt: s.updatedAt,
        sortOrder: s.sortOrder,
      }));
      built.push({ agentId, agentName: agent?.name ?? agentId, sessions: list });
    }
    return built.filter((group) => group.sessions.length > 0);
  }, [agents, sessions, runningSessionIds]);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    setTheme(next);
  };

  const closeDrawer = () => setDrawer(null);
  const openDrawer = (kind: Exclude<DrawerKind, null>) => {
    setDrawer((cur) => (cur === kind ? null : kind));
    if (toast) dismissToast(toast.id);
  };

  const startNewSession = (agentId: string) => {
    onNewSession(agentId);
    if (agents.some((a) => a.id === agentId)) onNavigate(agentId);
  };

  const startRename = (agentId: string, sessionId: string) => {
    const session = (sessions[agentId] ?? []).find((s) => s.id === sessionId);
    setRenaming({ agentId, sessionId });
    setRenameDraft(session?.name ?? '');
  };

  const commitRename = (agentId: string, sessionId: string) => {
    const title = renameDraft.trim();
    setRenaming(null);
    if (title) props.onRenameSession?.(agentId, sessionId, title);
  };

  return (
    <div className="ui-shell">
      <header
        className="ui-topbar"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          windowApi?.windowToggleMaximize?.();
        }}
      >
        <div className="ui-topbar-left">
          <Button variant="ghost" onClick={() => onNavigate('home')} icon={<SparkiiMark />}>Sparkii</Button>
          <span className="ui-topbar-title">{title}</span>
        </div>
        <div className="ui-topbar-right">
          <Button variant="ghost" size="sm" onClick={() => onNavigate('approvals')}><ShieldIcon /> 审批 {pendingApprovals > 0 && <Badge>{pendingApprovals}</Badge>}</Button>
          <IconButton label="账号" onClick={() => openDrawer('account')}><UserIcon /></IconButton>
          <IconButton label="深色/浅色" onClick={toggleTheme}>{dark ? <SunIcon /> : <MoonIcon />}</IconButton>
          <Button
            variant="ghost"
            size="sm"
            className="ui-error-trigger"
            aria-label={`报错中心${unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}`}
            title={`报错中心${unreadCount > 0 ? ` · ${unreadCount} 条未读` : ''}`}
            onClick={() => openDrawer('errors')}
          >
            <span className="ui-error-trigger-icon">
              <BellIcon />
              {unreadCount > 0 && <span className="ui-error-trigger-badge">{unreadCount}</span>}
            </span>
          </Button>
          <IconButton label="设置" onClick={() => onNavigate('settings')}><GearIcon /></IconButton>
          <span className="ui-topbar-divider" aria-hidden="true" />
          <div className="ui-window-controls">
            <button type="button" className="ui-window-btn" aria-label="最小化" onClick={() => windowApi?.windowMinimize?.()}><MinimizeIcon /></button>
            <button type="button" className="ui-window-btn" aria-label={maximized ? '还原' : '最大化'} onClick={() => windowApi?.windowToggleMaximize?.()}>{maximized ? <WindowRestoreIcon /> : <MaximizeIcon />}</button>
            <button type="button" className="ui-window-btn ui-window-btn--close" aria-label="关闭" onClick={() => windowApi?.windowClose?.()}><CloseIcon /></button>
          </div>
        </div>
      </header>

      <div className="ui-shell-main">
        <aside className="ui-rail">
          <nav className="ui-rail-group" aria-label="智能体">
            <AgentNav agents={agents} active={active} onNavigate={(id) => startNewSession(id)} />
          </nav>
          {groups.length > 0 && (
            <>
              <div className="ui-rail-section-row">
                <span className="ui-rail-section-label">会话历史</span>
                <IconButton label="搜索会话" size="sm" onClick={() => {
                  if (searchOpen) { setSearch(''); setSearchOpen(false); }
                  else setSearchOpen(true);
                }}><SearchIcon /></IconButton>
              </div>
              {searchOpen && (
                <div className="ui-rail-search-field">
                  <TextField
                    autoFocus
                    value={search}
                    placeholder="搜索会话…"
                    onChange={(e) => setSearch(e.target.value)}
                    onBlur={() => { if (!search.trim()) setSearchOpen(false); }}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); } }}
                  />
                </div>
              )}
              <div className="ui-rail-sessions">
                <SessionList
                  groups={groups}
                  filter={search}
                  onOpen={(agentId, id) => (onOpenSession ? onOpenSession(agentId, id) : onNavigate(agentId))}
                  onRename={props.onRenameSession ? (agentId, id) => startRename(agentId, id) : undefined}
                  onDelete={props.onDeleteSession ? (agentId, id) => props.onDeleteSession!(agentId, id) : undefined}
                  onPin={props.onPinSession ? (agentId, id, pinned) => props.onPinSession!(agentId, id, pinned) : undefined}
                  onArchive={props.onArchiveSession ? (agentId, id, archived) => props.onArchiveSession!(agentId, id, archived) : undefined}
                  onReorder={props.onReorderSession ? (agentId, ids) => props.onReorderSession!(agentId, ids) : undefined}
                  onStop={props.onStopSession ? (id) => props.onStopSession!(id) : undefined}
                  onRelease={props.onReleaseSession ? (id) => props.onReleaseSession!(id) : undefined}
                  renaming={renaming}
                  renameDraft={renameDraft}
                  onRenameChange={setRenameDraft}
                  onRenameCommit={commitRename}
                  onRenameCancel={() => setRenaming(null)}
                />
              </div>
            </>
          )}
        </aside>
        <main className="ui-surface">
          <div className="ui-surface-body">{children}</div>
        </main>
      </div>

      <StatusBar statusText={statusText} runtimePool={fallbackRuntimePool} documentParse={documentParse} onOpenQueue={() => openDrawer('queue')} update={props.update} onUpdateClick={props.onUpdateClick} />

      <Drawer open={drawer === 'queue'} title="运行中心" onClose={closeDrawer}>
        <RuntimeCenter
          snapshot={fallbackRuntimePool}
          documentParse={documentParse}
          onStop={(id) => props.onStopSession?.(id) ?? Promise.resolve()}
          onRelease={(id) => props.onReleaseSession?.(id) ?? Promise.resolve()}
          onCancelQueue={(id) => props.onCancelQueuedSession?.(id) ?? Promise.resolve()}
          onStopParse={() => props.onStopParse?.() ?? Promise.resolve()}
          onReleaseParse={() => props.onReleaseParse?.() ?? Promise.resolve()}
          onCancelLoad={() => props.onCancelLoad?.() ?? Promise.resolve()}
        />
      </Drawer>

      <Drawer open={drawer === 'account'} title="账号" size="sm" onClose={closeDrawer}>
        <div className="ui-account">
          <div className="ui-account-identity">
            <div className="ui-account-avatar" aria-hidden="true">{userName.trim().slice(0, 1) || '?'}</div>
            <div>
              <div className="ui-account-name">{userName}</div>
              <span className="ui-account-role">{userRole}</span>
            </div>
          </div>
          <div className="ui-account-trust">
            <ShieldIcon />
            <div>
              <div>数据目录</div>
              <b>本机 · 已加密</b>
            </div>
          </div>
          <button type="button" className="ui-account-action">修改密码<ChevronRightIcon /></button>
          <button type="button" className="ui-account-action">导出审计记录<ChevronRightIcon /></button>
        </div>
      </Drawer>

      <Drawer open={drawer === 'errors'} title="报错中心" onClose={closeDrawer}>
        <ErrorCenterPanel />
      </Drawer>
    </div>
  );
}
