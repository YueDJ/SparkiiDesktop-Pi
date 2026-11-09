import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession, type UpdateStatusSummary } from './shell/Shell.js';
import { UpdateDialog } from './shell/UpdateDialog.js';
import { ErrorProvider, useErrors, type ErrorStoreAdapter, type RuntimePoolSummary, type DocumentParseSnapshot } from '@sparkii/ui';
import type { SparkiiApi, UpdateProgress, UpdateState } from './types/sparkii-api.js';
import { SettingsView } from './shell/SettingsView.js';
import { ApprovalCenter } from './trust/ApprovalCenter.js';
import { ApprovalDrawer } from './trust/ApprovalDrawer.js';
import { HighRiskApprovalDialog } from './trust/HighRiskApprovalDialog.js';
import { ApprovalInboxProvider, useApprovalInbox } from './trust/ApprovalInbox.js';
import { PermissionModeProvider } from './trust/PermissionModeSelect.js';
import { AuditView } from './audit/AuditView.js';
import { HomeView } from './platform/HomeView.js';
import { useAgentSurface } from './platform/surface-registry.js';
import {
  bindSession,
  clearCurrentSession,
  highlightedSessionId,
  isSession,
  openHistory,
  openNew,
  openPage,
  shellActive,
  withDerivedActive,
  type CurrentWork,
} from './platform/current-work.js';
import { useAgentSession } from './surface/use-agent-session.js';
import type { AgentSession, AgentSurfaceActions } from './surface/contract.js';

export function sessionDisplayName(s: { title?: string; firstMessage?: string; updatedAt?: number }): string {
  if (s.title) return s.title;
  if (s.firstMessage) return String(s.firstMessage).slice(0, 20);
  return s.updatedAt
    ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '会话';
}

// 仅用于“首次构建 / 新出现会话”的默认排序：
// 置顶会话固定在最前，其余未手动排序的(含新会话)按时间最新在前，手动拖拽的按自定义顺序在后。
// 之后的顺序完全由 sessions 数组本身决定（数组即真相源）。
export function orderSessions(sessions: ShellSession[]): ShellSession[] {
  const vis = sessions.filter((s) => !s.archived);
  const arch = sessions.filter((s) => s.archived);
  const byDefault = (a: ShellSession, b: ShellSession) => {
    const aManual = a.sortOrder != null;
    const bManual = b.sortOrder != null;
    if (aManual !== bManual) return aManual ? 1 : -1;
    if (aManual && bManual) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  };
  const pinned = vis.filter((s) => s.pinned).sort(byDefault);
  const unpinned = vis.filter((s) => !s.pinned).sort(byDefault);
  return [...pinned, ...unpinned, ...arch];
}

// 稳定地把置顶会话挪到最前（保持各组内相对顺序），用于刷新/拖拽后维持“sticky 置顶”。
function stickyOrder(sessions: ShellSession[]): ShellSession[] {
  const arch = sessions.filter((s) => s.archived);
  const vis = sessions.filter((s) => !s.archived);
  return [...vis.filter((s) => s.pinned), ...vis.filter((s) => !s.pinned), ...arch];
}

export function mapRuntimePool(raw: any, pendingApprovals: any[]): RuntimePoolSummary {
  const pendingSessionIds = new Set(pendingApprovals.map((p: any) => p.sessionId));
  return {
    active: Number(raw?.active ?? 0),
    queued: Number(raw?.queued ?? 0),
    maxAgents: Number(raw?.maxAgents ?? 4),
    sessions: (raw?.slots ?? []).map((s: any) => ({
      sessionId: s.sessionId,
      profileId: s.profileId,
      profileName: s.profileName || s.profileId,
      label: s.label || '新会话',
      status: pendingSessionIds.has(s.sessionId)
        ? 'waiting-approval'
        : s.status === 'streaming' || s.status === 'starting'
          ? 'running'
          : 'idle',
    })),
    queue: (raw?.queue ?? []).map((q: any) => ({
      queueId: q.queueId,
      profileId: q.profileId,
      profileName: q.profileName || q.profileId,
      label: q.label || '新会话',
      position: q.position,
    })),
  };
}

/**
 * 状态栏更新 pill 的最小映射（§7.5）：只在 available / downloading / readyToInstall 出内容，
 * 其余阶段返回 null ⇒ StatusBar 完全不渲染，不抢焦点、不弹模态。
 * 文案里的版本号只来自已验签清单（Main 侧 state），绝不自己拼 URL 或加载远程内容。
 */
export function mapUpdateSummary(state: unknown): UpdateStatusSummary | null {
  const s = state as {
    phase?: string; percent?: number | null; version?: string | null;
    progress?: { percent?: number | null } | null;
    remote?: { version?: string } | null;
    local?: { version?: string } | null;
    choiceRequired?: boolean;
  } | null;
  if (!s || typeof s.phase !== 'string') return null;
  if (s.phase === 'available') {
    return {
      phase: 'available',
      percent: null,
      label: s.choiceRequired === true ? '有 2 个可选版本' : '有新版',
      version: s.remote?.version ?? s.version ?? null,
    };
  }
  if (s.phase === 'downloading') {
    const pct = Number(s.progress?.percent ?? s.percent ?? 0);
    return {
      phase: 'downloading',
      percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
      label: '下载中',
      version: s.remote?.version ?? s.version ?? null,
    };
  }
  if (s.phase === 'readyToInstall') {
    return {
      phase: 'readyToInstall',
      percent: null,
      label: '已下载完，可以安装',
      version: s.local?.version ?? s.version ?? null,
    };
  }
  return null;
}

function makeErrorStore(api: SparkiiApi): ErrorStoreAdapter {
  return {
    load: () => api.listErrors(),
    append: (rec) => api.appendError(rec),
    clearOne: (id) => api.clearError(id).then(() => {}),
    clearAll: () => api.clearErrors().then(() => {}),
    markAllRead: () => api.markAllErrorsRead().then(() => {}),
  };
}

export function App() {
  const api = window.sparkii;
  const store = useMemo(() => makeErrorStore(api), [api]);
  return (
    <ErrorProvider store={store}>
      <ApprovalInboxProvider api={api}>
        <AppShell />
      </ApprovalInboxProvider>
    </ErrorProvider>
  );
}

/** One frame per agent. Only the current session's agent receives a sessionId; the others
 *  stay unbound. The surface renders only while this agent is the current work. */
function AgentFrame(props: {
  agent: ShellAgent;
  active: boolean;
  draft: boolean;
  sessionId: string | null;
  mode: 'live' | 'history';
  buildActions: (agentId: string, session: AgentSession) => AgentSurfaceActions;
  title?: string;
}) {
  const { agent, active, draft, sessionId, mode, buildActions, title } = props;
  const session = useAgentSession(agent.id, sessionId, mode);
  const { Surface } = useAgentSurface(agent.id);
  if (!Surface) return null;
  return (
    <div style={{ display: active ? 'block' : 'none', height: active ? '100%' : 'auto' }}>
      {active && (
        <PermissionModeProvider api={window.sparkii} agentId={agent.id} sessionId={sessionId}>
          <Surface
            agent={agent}
            sessionId={sessionId}
            mode={mode}
            session={session}
            actions={buildActions(agent.id, session)}
            title={title}
            draft={draft}
            active
          />
        </PermissionModeProvider>
      )}
    </div>
  );
}

function AppShell() {
  const api = window.sparkii;
  const { reportError } = useErrors();
  const [userName, setUserName] = useState('');
  const [auditVersion, setAuditVersion] = useState(0);
  const [current, setCurrent] = useState<CurrentWork>(() => openPage('home'));
  const [roles, setRoles] = useState<string[]>([]);
  const [agents, setAgents] = useState<ShellAgent[]>([]);
  const [sessions, setSessions] = useState<Record<string, ShellSession[]>>({});
  const [drawerDismissed, setDrawerDismissed] = useState(false);
  const { proposals, claimed, onDecided } = useApprovalInbox();
  const [runtimePool, setRuntimePool] = useState<RuntimePoolSummary>({
    active: 0,
    queued: 0,
    maxAgents: 4,
    sessions: [],
    queue: [],
  });
  const [documentParse, setDocumentParse] = useState<DocumentParseSnapshot>({ status: 'stopped', waiting: [] });
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const updateSummary = useMemo(() => mapUpdateSummary(updateState), [updateState]);
  /**
   * 进入设置页时落在哪个 pane。状态栏更新 pill 要直达「关于」（R1 · B-2：
   * 只跳设置页会停在「大模型连接」，§7.5 的入口等于没做完）；
   * 其它方式进设置则回到默认 pane，不让这个落点粘住。
   */
  const [settingsPane, setSettingsPane] = useState<string | undefined>(undefined);
  // 本地尚未被后端确认的会话状态（名称 / 最近活动时间 / 所属智能体）。
  // 新会话、重命名、正在运行的会话在刷新时用这份覆盖值穿透滞后的后端快照，
  // 一旦后端确认(名称与时间一致/会话出现)即清除，避免多个各自为政的缓存。
  const sessionOverridesRef = useRef<Map<string, { name?: string; updatedAt?: number; agentId?: string }>>(new Map());
  const currentRef = useRef<CurrentWork>(current);
  const commitCurrent = (next: CurrentWork) => {
    currentRef.current = next;
    setCurrent(next);
  };
  const stampSessionOwner = (sessionId: string, agentId: string) => {
    const prev = sessionOverridesRef.current.get(sessionId) ?? {};
    sessionOverridesRef.current.set(sessionId, { ...prev, agentId, updatedAt: Date.now() });
  };
  const bindCurrentSession = (agentId: string, sessionId: string) => {
    stampSessionOwner(sessionId, agentId);
    const work = currentRef.current;
    if (isSession(work) && work.agentId === agentId) commitCurrent(bindSession(work, sessionId));
  };
  const currentSessionId = (agentId: string) => {
    const work = currentRef.current;
    return isSession(work) && work.agentId === agentId ? work.sessionId : null;
  };
  const surfaceTypeOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.surfaceType;

  const unclaimedRoutine = useMemo(
    () => [...proposals.values()].filter((p) => p.risk !== 'high-risk' && !claimed.has(p.id)),
    [proposals, claimed],
  );
  const pendingList = useMemo(() => [...proposals.values()], [proposals]);

  useEffect(() => onDecided(() => setAuditVersion((v) => v + 1)), [onDecided]);

  const prevUnclaimedRef = useRef(unclaimedRoutine.length);
  useEffect(() => {
    if (unclaimedRoutine.length > prevUnclaimedRef.current) setDrawerDismissed(false);
    prevUnclaimedRef.current = unclaimedRoutine.length;
  }, [unclaimedRoutine.length]);

  useEffect(() => api.on('chat-event', (p: any) => {
    if (p?.sessionId) {
      const ov = sessionOverridesRef.current.get(p.sessionId);
      if (ov) ov.updatedAt = Date.now();
    }
    // 主进程已经把这条写进 errors.db 并给了 id；用同一个 id 上报，错误中心只会有一行。
    if (p?.type === 'runtime_error' && typeof p?.errorId === 'string') {
      reportError(typeof p?.message === 'string' ? p.message : '运行时错误', {
        source: typeof p?.source === 'string' ? p.source : undefined,
        id: p.errorId,
      });
    }
    if (p?.type === 'session_title' && p?.sessionId) {
      const title = String(p.title ?? '');
      const prevOv = sessionOverridesRef.current.get(p.sessionId) ?? {};
      sessionOverridesRef.current.set(p.sessionId, { ...prevOv, name: title, updatedAt: Date.now() });
      setSessions((prev) => {
        const next = { ...prev };
        let found = false;
        for (const k of Object.keys(next)) {
          if (next[k].some((s) => s.id === p.sessionId)) {
            found = true;
            next[k] = next[k].map((s) => (s.id === p.sessionId ? { ...s, name: title } : s));
          }
        }
        if (!found) {
          const work = currentRef.current;
          const owner =
            sessionOverridesRef.current.get(p.sessionId)?.agentId
            ?? (isSession(work) && work.sessionId === p.sessionId ? work.agentId : undefined);
          if (owner) {
            const list = next[owner] ?? [];
            const pinned = list.filter((s) => s.pinned);
            const unpinned = list.filter((s) => !s.pinned && !s.archived);
            const arch = list.filter((s) => s.archived);
            const sessionItem: ShellSession = { id: p.sessionId, name: title, state: '', updatedAt: Date.now() };
            next[owner] = [...pinned, sessionItem, ...unpinned, ...arch];
          }
        }
        return next;
      });
    }
  }), [api, reportError]);
  useEffect(() => {
    const off = api.on('runtime-pool', (p: any) => setRuntimePool(mapRuntimePool(p, pendingList)));
    api.getRuntimePool?.().then((p: any) => setRuntimePool(mapRuntimePool(p, pendingList))).catch(() => {});
    return off;
  }, [api, pendingList]);
  // 状态栏更新徽标：订阅 Main 推来的 update-state / update-progress，并在挂载时取一次初值。
  useEffect(() => {
    const onState = (p: unknown) => {
      setUpdateState(p && typeof p === 'object' ? p as UpdateState : null);
    };
    const onProgress = (p: unknown) => {
      if (!p || typeof p !== 'object') return;
      setUpdateState((prev) => (prev ? { ...prev, progress: p as UpdateProgress } : prev));
    };
    const off = api.on?.('update-state', onState);
    const offProgress = api.on?.('update-progress', onProgress);
    const pending = api.getUpdateState?.();
    if (pending) {
      pending.then((s: any) => onState(s)).catch(() => {});
    }
    return () => {
      if (typeof off === 'function') off();
      if (typeof offProgress === 'function') offProgress();
    };
  }, [api]);
  useEffect(() => {
    const off = api.on?.('document-parse', (p: any) => {
      if (p && typeof p === 'object') setDocumentParse(p as DocumentParseSnapshot);
    });
    const pending = api.getDocumentParse?.();
    if (pending) {
      pending.then((p: any) => {
        if (p && typeof p === 'object') setDocumentParse(p as DocumentParseSnapshot);
      }).catch(() => {});
    }
    return () => { off?.(); };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const subject = await api.getLocalSubject();
        if (cancelled) return;
        setUserName(subject.userId);
        setRoles(subject.roles ?? []);
        api.listAgents?.().then((list: Array<{ id: string; name: string; surfaceType?: string; knowledge?: ShellAgent['knowledge'] }>) => {
          if (cancelled || !Array.isArray(list) || !list.length) return;
          setAgents(list.map((a) => ({
            id: a.id,
            name: a.name,
            status: 'idle' as const,
            surfaceType: a.surfaceType,
            knowledge: a.knowledge,
          })));
        }).catch(() => {});
      } catch {
        // 本地主体初始化失败时仍保留默认壳,不阻塞渲染
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const exportAudit = (jsonl: string) => {
    // 服务器权威导出:使用主进程 diagnostics 返回的完整审计 JSONL
    api.diagnostics().then((d) => downloadText(`sparkii-audit-${new Date().toISOString().slice(0, 10)}.jsonl`, d.audit)).catch(() => {
      const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sparkii-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const downloadText = (filename: string, text: string) => {
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const refreshSessions = (agentId?: string) => {
    // 目录只更新元数据 / 补行 / 删行，不写 active。高亮在传给 Shell 前从 current 派生。
    api.listChatSessions?.()?.then((list: any[]) => {
      const fetchedById: Record<string, ShellSession & { profileId: string }> = {};
      const fetchedByProfile: Record<string, Array<ShellSession & { profileId: string }>> = {};
      const work = currentRef.current;
      for (const s of list ?? []) {
        let profileId = s.profileId ?? sessionOverridesRef.current.get(s.id)?.agentId ?? '';
        if (!profileId && isSession(work) && work.sessionId === s.id) profileId = work.agentId;
        const diskName = sessionDisplayName({ title: s.title, firstMessage: s.firstMessage, updatedAt: s.updatedAt });
        const override = sessionOverridesRef.current.get(s.id);
        const name = override?.name ?? diskName;
        if (override && diskName === override.name) sessionOverridesRef.current.delete(s.id);
        const item: ShellSession & { profileId: string } = {
          id: s.id,
          name,
          state: '',
          pinned: s.pinned ?? false,
          archived: s.archived ?? false,
          updatedAt: Math.max(Number(s.updatedAt) || 0, override?.updatedAt ?? 0),
          sortOrder: s.sortOrder ?? null,
          profileId,
        };
        fetchedById[s.id] = item;
        (fetchedByProfile[profileId] ??= []).push(item);
      }
      setSessions((prev) => {
        const next: Record<string, ShellSession[]> = {};
        const placed = new Set<string>();

        for (const [profileId, rows] of Object.entries(prev)) {
          const kept: ShellSession[] = [];
          for (const s of rows) {
            const f = fetchedById[s.id];
            if (f) {
              const { profileId: _pid, ...meta } = f;
              kept.push({ ...s, ...meta });
              placed.add(s.id);
            } else if (sessionOverridesRef.current.has(s.id)) {
              kept.push(s);
              placed.add(s.id);
            }
          }
          if (kept.length) next[profileId] = kept;
        }

        for (const [profileId, rows] of Object.entries(fetchedByProfile)) {
          const fresh = rows.filter((f) => !placed.has(f.id));
          if (fresh.length) {
            const mapped = fresh.map(({ profileId: _pid, ...meta }) => meta);
            next[profileId] = [...orderSessions(mapped), ...(next[profileId] ?? [])];
            for (const f of fresh) placed.add(f.id);
          }
        }

        for (const profileId of Object.keys(next)) if (!next[profileId].length) delete next[profileId];
        for (const profileId of Object.keys(next)) next[profileId] = stickyOrder(next[profileId]);
        return next;
      });
    }).catch(() => {});
  };

  const onNewSession = (agentId: string) => {
    commitCurrent(openNew(agentId));
  };

  const onOpenSession = (agentId: string, sessionId: string) => {
    commitCurrent(openHistory(agentId, sessionId, surfaceTypeOf(agentId)));
    refreshSessions(agentId);
  };

  const onRenameSession = (agentId: string, sessionId: string, title: string) => {
    const prevOverride = sessionOverridesRef.current.get(sessionId) ?? {};
    sessionOverridesRef.current.set(sessionId, { ...prevOverride, name: title });
    setSessions((prev) => {
      const list = prev[agentId] ?? [];
      return { ...prev, [agentId]: list.map((s) => (s.id === sessionId ? { ...s, name: title } : s)) };
    });
    api.setChatTitle?.(sessionId, title, 'user')?.then(() => refreshSessions(agentId));
  };

  const onDeleteSession = (agentId: string, sessionId: string) => {
    sessionOverridesRef.current.delete(sessionId);
    api.deleteChatSession?.(sessionId).then(() => {
      const work = currentRef.current;
      if (isSession(work) && work.sessionId === sessionId) commitCurrent(clearCurrentSession(work));
      refreshSessions(agentId);
    });
  };

  const onPinSession = (agentId: string, sessionId: string, pinned: boolean) => {
    const cur = sessions[agentId] ?? [];
    const session = cur.find((s) => s.id === sessionId);
    if (!session) return;
    const others = cur.filter((s) => s.id !== sessionId);
    const othersPinned = others.filter((s) => s.pinned);
    const othersUnpinned = others.filter((s) => !s.pinned && !s.archived);
    const arch = others.filter((s) => s.archived);
    // 置顶 → 移到置顶块最前；取消置顶 → 移到未置顶块最前
    const next = pinned
      ? [{ ...session, pinned: true }, ...othersPinned, ...othersUnpinned, ...arch]
      : [...othersPinned, { ...session, pinned: false }, ...othersUnpinned, ...arch];
    const visCount = next.filter((s) => !s.archived).length;
    const renumbered = next.map((s, i) => ({ ...s, sortOrder: i < visCount ? i : s.sortOrder }));
    setSessions((prev) => ({ ...prev, [agentId]: renumbered }));
    next.filter((s) => !s.archived).forEach((s, i) => api.setSessionOrder?.(s.id, i, agentId));
    api.setSessionPinned?.(sessionId, pinned, agentId);
  };

  const onArchiveSession = (agentId: string, sessionId: string, archived: boolean) => {
    api.setSessionArchived?.(sessionId, archived, agentId)?.then(() => refreshSessions(agentId));
  };

  const onReorderSession = (agentId: string, orderedIds: string[]) => {
    // 拖拽后仍保持“置顶在最前”：先按拖拽结果排列，再用 stickyOrder 把置顶项稳定地挪到最前
    const cur = sessions[agentId] ?? [];
    const byId = new Map(cur.map((s) => [s.id, s]));
    const visSet = new Set(cur.filter((s) => !s.archived).map((s) => s.id));
    const orderedVis = orderedIds.filter((id) => visSet.has(id)).map((id) => byId.get(id)!);
    const arch = cur.filter((s) => s.archived);
    const sticky = stickyOrder([...orderedVis, ...arch]);
    const visCount = sticky.filter((s) => !s.archived).length;
    const next = sticky.map((s, i) => ({ ...s, sortOrder: i < visCount ? i : s.sortOrder }));
    setSessions((prev) => ({ ...prev, [agentId]: next }));
    sticky.filter((s) => !s.archived).forEach((s, i) => api.setSessionOrder?.(s.id, i, agentId));
  };

  useEffect(() => {
    if (!agents.length) return;
    for (const a of agents) refreshSessions(a.id);
  }, [agents]);

  const derivedAgents = agents.map((a) => {
    const profileId = a.id;
    const running = runtimePool.sessions.some((s) => s.profileId === profileId);
    const queued = runtimePool.queue.some((q) => q.profileId === profileId);
    return { ...a, status: running ? 'running' : queued ? 'queued' : 'idle' } as ShellAgent;
  });

  const stopRuntimeSession = async (sessionId: string) => {
    await api.abortChat(sessionId);
  };

  const releaseRuntimeSession = async (sessionId: string) => {
    await api.releaseSessionSlot(sessionId);
    const work = currentRef.current;
    if (isSession(work) && work.sessionId === sessionId) {
      commitCurrent(clearCurrentSession(work));
      refreshSessions(work.agentId);
    }
  };

  const cancelQueuedSession = async (queueId: string) => {
    await api.cancelQueuedSession(queueId);
  };

  const statusText = '';

  const navigate = (s: ScreenId) => {
    const isAgent = agents.some((a) => a.id === s);
    if (isAgent) {
      commitCurrent(openNew(s));
      refreshSessions(s);
      return;
    }
    // 常规入口进设置 ⇒ 回到默认 pane，不让更新 pill 的落点粘住。
    if (s === 'settings') setSettingsPane(undefined);
    commitCurrent(openPage(s));
  };

  const buildActions = (agentId: string, _session: AgentSession): AgentSurfaceActions => {
    const isChat = surfaceTypeOf(agentId) === 'chat';
    if (isChat) {
      return {
        newSession: () => onNewSession(agentId),
        openSession: (sessionId) => {
          bindCurrentSession(agentId, sessionId);
          refreshSessions(agentId);
        },
        startWorkflow: () => {},
        review: () => {},
        requestExport: () => {},
        chooseDocument: async () => ({}),
        readDocumentBytes: async () => ({ error: 'denied' }),
      };
    }
    return {
      newSession: () => onNewSession(agentId),
      openSession: (id) => {
        bindCurrentSession(agentId, id);
        refreshSessions(agentId);
      },
      startWorkflow: (payload) => {
        return api.runWorkflow(agentId, payload).then((res) => {
          if (res?.sessionId) bindCurrentSession(agentId, res.sessionId);
          return res;
        }).catch((e: any) => {
          reportError(String(e?.message ?? e), { source: agents.find((a) => a.id === agentId)?.name ?? agentId });
          return {};
        });
      },
      review: (action, payload) => {
        const sid = currentSessionId(agentId);
        if (!sid) return;
        api.updateWorkflowState(sid, { action, ...payload }).catch((e) => reportError(String(e?.message ?? e), { source: agentId }));
      },
      requestExport: (payload) => {
        const sid = currentSessionId(agentId);
        if (!sid) { commitCurrent(openPage('approvals')); return; }
        void api.requestExportReport(sid, payload ?? {}).catch(() => {});
      },
      chooseDocument: (opts) => api.chooseDocument(opts),
      readDocumentBytes: (path) => api.readDocumentBytes(path, currentSessionId(agentId)),
    };
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <HomeView userName={userName} agents={derivedAgents} pendingApprovals={pendingList} onNavigate={navigate} />
    ),
    approvals: (
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>审批中心</h3>
        <ApprovalCenter
          onOpenDetail={() => setDrawerDismissed(false)}
        />
      </div>
    ),
    audit: (
      <AuditView key={auditVersion} api={api} onExport={exportAudit} />
    ),
    settings: (
      <SettingsView api={api} onExportAudit={exportAudit} initialPane={settingsPane} />
    ),
  };

  const highlightedId = highlightedSessionId(current);
  const sessionsView = useMemo(
    () => withDerivedActive(sessions, highlightedId),
    [sessions, highlightedId],
  );
  const agentFrames = derivedAgents.map((a) => {
    const mine = isSession(current) && current.agentId === a.id ? current : null;
    const sid = mine?.sessionId ?? null;
    return (
      <AgentFrame
        key={a.id}
        agent={a}
        active={Boolean(mine)}
        draft={a.surfaceType === 'chat' && Boolean(mine) && sid == null}
        sessionId={sid}
        mode={mine?.mode ?? 'live'}
        buildActions={buildActions}
        title={sid ? (sessions[a.id] ?? []).find((s) => s.id === sid)?.name : undefined}
      />
    );
  });
  const surfaceNode = current.type === 'page' ? (surfaces[current.page] ?? null) : null;

  return (
    <>
      <Shell
        active={shellActive(current)}
        agents={derivedAgents}
        sessions={sessionsView}
        pendingApprovals={pendingList.length}
        statusText={statusText}
        runtimePool={runtimePool}
        userName={userName}
        userRole={roles.length ? roles.join(' · ') : '审核员'}
        onNavigate={navigate}
        onNewSession={onNewSession}
        onOpenSession={onOpenSession}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
        onPinSession={onPinSession}
        onArchiveSession={onArchiveSession}
        onReorderSession={onReorderSession}
        onStopSession={stopRuntimeSession}
        onReleaseSession={releaseRuntimeSession}
        onCancelQueuedSession={cancelQueuedSession}
        documentParse={documentParse}
        onStopParse={() => { void api.stopDocumentParse?.(); }}
        onReleaseParse={() => { void api.releaseDocumentParse?.(); }}
        onCancelLoad={() => { void api.cancelDocumentParseLoad?.(); }}
        update={updateSummary ?? undefined}
        onUpdateClick={() => setUpdateDialogOpen(true)}
      >
        {surfaceNode}
        {agentFrames}
      </Shell>
      <UpdateDialog
        open={updateDialogOpen}
        state={updateState}
        api={api}
        onClose={() => setUpdateDialogOpen(false)}
      />
      <ApprovalDrawer
        open={unclaimedRoutine.length > 0 && !drawerDismissed}
        currentSessionId={isSession(current) ? current.sessionId ?? '' : ''}
        onClose={() => setDrawerDismissed(true)}
      />
      <HighRiskApprovalDialog />
    </>
  );
}
