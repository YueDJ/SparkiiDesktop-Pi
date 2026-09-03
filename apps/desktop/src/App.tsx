import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession } from './shell/Shell.js';
import { ErrorProvider, useErrors, type ErrorStoreAdapter, type RuntimePoolSummary } from '@sparkii/ui';
import type { SparkiiApi } from './types/sparkii-api.js';
import { SettingsView } from './shell/SettingsView.js';
import { ApprovalCenter } from './trust/ApprovalCenter.js';
import { ApprovalPanel } from './trust/ApprovalPanel.js';
import { AuditView } from './audit/AuditView.js';
import type { WorkflowStatusState } from './workbench/WorkflowStatus.js';
import { HomeView } from './platform/HomeView.js';
import { useAgentSurface } from './platform/surface-registry.js';
import { extractWorkflowResult } from './surface/normalize.js';
import { useAgentSession } from './surface/use-agent-session.js';
import type { AgentSession, AgentSurfaceActions } from './surface/contract.js';

export function sessionDisplayName(s: { title?: string; firstMessage?: string; updatedAt?: number }): string {
  if (s.title) return s.title;
  if (s.firstMessage) return String(s.firstMessage).slice(0, 24);
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

function mapRuntimePool(raw: any, pendingApprovals: any[]): RuntimePoolSummary {
  const pendingSessionIds = new Set(pendingApprovals.map((p: any) => p.sessionId));
  return {
    active: Number(raw?.active ?? 0),
    queued: Number(raw?.queued ?? 0),
    maxAgents: Number(raw?.maxAgents ?? 4),
    sessions: (raw?.slots ?? []).map((s: any) => ({
      sessionId: s.sessionId,
      profileId: s.profileId,
      profileName: s.profileName || s.profileId,
      label: s.label || s.sessionId,
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
      label: q.label || q.queueId,
      position: q.position,
    })),
  };
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
  const store = useMemo(() => makeErrorStore(window.sparkii), []);
  return (
    <ErrorProvider store={store}>
      <AppShell />
    </ErrorProvider>
  );
}

/** One always-mounted frame per agent: owns that agent's live/history session (so leaving and
 *  returning keeps the stream) and renders the agent's surface only while active. Every agent —
 *  chat, workflow or custom — reuses the same session truth source (useAgentSession). */
function AgentFrame(props: {
  agent: ShellAgent;
  active: boolean;
  draft: boolean;
  sessionId: string | null;
  mode: 'live' | 'history';
  buildActions: (agentId: string, session: AgentSession) => AgentSurfaceActions;
}) {
  const { agent, active, draft, sessionId, mode, buildActions } = props;
  const session = useAgentSession(agent.id, sessionId, mode);
  const { Surface } = useAgentSurface(agent.id);
  if (!Surface) return null;
  return (
    <div style={{ display: active ? 'block' : 'none', height: active ? '100%' : 'auto' }}>
      {active && (
        <Surface
          agent={agent}
          sessionId={sessionId}
          mode={mode}
          session={session}
          actions={buildActions(agent.id, session)}
          draft={draft}
          active
        />
      )}
    </div>
  );
}

function AppShell() {
  const api = window.sparkii;
  const { reportError } = useErrors();
  const [userName, setUserName] = useState('');
  const [pending, setPending] = useState<any[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);
  const [screen, setScreen] = useState<ScreenId>('home');
  const [roles, setRoles] = useState<string[]>([]);
  const [agents, setAgents] = useState<ShellAgent[]>([]);
  const [sessions, setSessions] = useState<Record<string, ShellSession[]>>({});
  const [workflowByAgent, setWorkflowByAgent] = useState<Record<string, { sessionId: string | null; mode: 'live' | 'history' }>>({});
  const [workflowStatusByAgent, setWorkflowStatusByAgent] = useState<Record<string, WorkflowStatusState>>({});
  const [activeSessionByAgent, setActiveSessionByAgent] = useState<Record<string, string | null>>({});
  const [titleByAgent, setTitleByAgent] = useState<Record<string, string>>({});
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalFocusId, setApprovalFocusId] = useState<string | null>(null);
  const [runtimePool, setRuntimePool] = useState<RuntimePoolSummary>({
    active: 0,
    queued: 0,
    maxAgents: 4,
    sessions: [],
    queue: [],
  });
  // 本地尚未被后端确认的会话状态（名称 / 最近活动时间 / 所属智能体）。
  // 新会话、重命名、正在运行的会话在刷新时用这份覆盖值穿透滞后的后端快照，
  // 一旦后端确认(名称与时间一致/会话出现)即清除，避免多个各自为政的缓存。
  const sessionOverridesRef = useRef<Map<string, { name?: string; updatedAt?: number; agentId?: string }>>(new Map());

  const activeSessionFor = (agentId: string) => activeSessionByAgent[agentId] ?? null;
  const setActiveSessionFor = (agentId: string, sessionId: string | null) => {
    setActiveSessionByAgent((prev) => ({ ...prev, [agentId]: sessionId }));
  };
  const titleFor = (agentId: string) => titleByAgent[agentId] ?? '';
  const setTitleFor = (agentId: string, title: string) => {
    setTitleByAgent((prev) => ({ ...prev, [agentId]: title }));
  };
  const workflowFor = (agentId: string) => workflowByAgent[agentId] ?? { sessionId: null, mode: 'live' as const };
  const workflowByAgentRef = useRef(workflowByAgent);
  useEffect(() => { workflowByAgentRef.current = workflowByAgent; }, [workflowByAgent]);

  useEffect(() => api.on('approval', (p) => {
    setPending((xs) => [...xs, p]);
    // 审批是需要人工接管的时刻:新提案到达时自动弹出右侧审批抽屉,并聚焦该提案
    setApprovalFocusId((p as { id: string }).id);
    setApprovalOpen(true);
  }), [api]);
  useEffect(() => {
    if (pending.length === 0 && approvalOpen) setApprovalOpen(false);
  }, [pending.length, approvalOpen]);
  useEffect(() => api.on('workflow', (e: any) => {
    // Route the workflow event to the agent that owns this workflow session.
    const agentId = Object.entries(workflowByAgentRef.current).find(([, w]) => w.sessionId === e.sessionId)?.[0];
    if (!agentId) return;
    setWorkflowStatusByAgent((prev) => {
      if (e.type === 'step_started') return { ...prev, [agentId]: { status: 'running', step: e.stepId } };
      if (e.type === 'workflow_completed') return { ...prev, [agentId]: { status: 'done' } };
      if (e.type === 'workflow_failed') {
        reportError(e.error?.message ?? '审核失败', { source: agentId });
        return { ...prev, [agentId]: { status: 'failed', error: e.error?.message } };
      }
      return prev;
    });
  }), [api, reportError]);
  useEffect(() => api.on('chat-event', (p: any) => {
    if (p?.sessionId) {
      const ov = sessionOverridesRef.current.get(p.sessionId);
      if (ov) ov.updatedAt = Date.now();
    }
    if (p?.type === 'session_title' && p?.sessionId) {
      const ov = sessionOverridesRef.current.get(p.sessionId);
      if (ov) ov.name = p.title;
      setSessions((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = next[k].map((s) => (s.id === p.sessionId ? { ...s, name: p.title } : s));
        }
        return next;
      });
      for (const [agentId, sid] of Object.entries(activeSessionByAgent)) {
        if (sid === p.sessionId) setTitleFor(agentId, p.title);
      }
    }
  }), [api, activeSessionByAgent]);
  useEffect(() => {
    const off = api.on('runtime-pool', (p: any) => setRuntimePool(mapRuntimePool(p, pending)));
    api.getRuntimePool?.().then((p: any) => setRuntimePool(mapRuntimePool(p, pending))).catch(() => {});
    return off;
  }, [api, pending]);

  const refreshApprovals = () => api.listPendingApprovals().then((xs) => setPending(xs as any[]));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const subject = await api.getLocalSubject();
        if (cancelled) return;
        setUserName(subject.userId);
        setRoles(subject.roles ?? []);
        await refreshApprovals();
        api.listAgents?.().then((list: Array<{ id: string; name: string }>) => {
          if (cancelled || !Array.isArray(list) || !list.length) return;
          setAgents(list.map((a) => ({
            id: a.id as ScreenId,
            name: a.name,
            status: 'idle',
            surfaceType: (a as { surfaceType?: string }).surfaceType,
          })));
        }).catch(() => {});
      } catch {
        // 本地主体初始化失败时仍保留默认壳,不阻塞渲染
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const decide = (id: string, ok: boolean, note?: string) => {
    // 先本地移除,避免抽屉等待服务器往返;失败时 refreshApprovals 恢复
    setPending((xs) => xs.filter((p) => p.id !== id));
    api.decideApproval(id, ok, note).then(() => {
      refreshApprovals();
      setAuditVersion((v) => v + 1);
    });
  };

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

  const refreshSessions = (agentId: string, activeId = activeSessionFor(agentId)) => {
    // 以 sessions 数组为唯一真相源：刷新只做“原地更新元数据 + 补齐新会话 + 移除已删除”，
    // 不重新排序，从而避免后端滞后的时间戳把会话来回挪动。
    api.listChatSessions?.()?.then((list: any[]) => {
      const fetchedById: Record<string, ShellSession & { profileId: string }> = {};
      const fetchedByProfile: Record<string, Array<ShellSession & { profileId: string }>> = {};
      for (const s of list ?? []) {
        let profileId = s.profileId ?? '';
        if (!profileId) {
          const owner = Object.entries(workflowByAgentRef.current).find(([, w]) => w.sessionId === s.id)?.[0];
          profileId = owner ?? '';
        }
        const diskName = sessionDisplayName({ title: s.title, firstMessage: s.firstMessage, updatedAt: s.updatedAt });
        const override = sessionOverridesRef.current.get(s.id);
        const name = override?.name ?? diskName;
        // 后端返回的名称与本地一致，说明已确认，清除覆盖
        if (override && diskName === override.name) sessionOverridesRef.current.delete(s.id);
        const item: ShellSession & { profileId: string } = {
          id: s.id,
          name,
          state: '',
          active: s.id === activeId,
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

        // 1) 保留已有会话的位置：后端有则原地更新元数据；本地未确认则保留；后端已删除则丢弃
        for (const [profileId, list] of Object.entries(prev)) {
          const kept: ShellSession[] = [];
          for (const s of list) {
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

        // 2) 后端返回但本地还没有的新会话 → 按默认顺序插到该分类最前
        for (const [profileId, list] of Object.entries(fetchedByProfile)) {
          const fresh = list.filter((f) => !placed.has(f.id));
          if (fresh.length) {
            const mapped = fresh.map(({ profileId: _pid, ...meta }) => meta);
            next[profileId] = [...orderSessions(mapped), ...(next[profileId] ?? [])];
            for (const f of fresh) placed.add(f.id);
          }
        }

        // 3) 清理空分组
        for (const profileId of Object.keys(next)) if (!next[profileId].length) delete next[profileId];
        // 4) 保证置顶会话始终在最前（即使别处改了 pinned 标记）
        for (const profileId of Object.keys(next)) next[profileId] = stickyOrder(next[profileId]);
        return next;
      });
      const active = (fetchedByProfile[agentId] ?? []).find((s) => s.id === activeId);
      if (active) setTitleFor(agentId, active.name);
    }).catch(() => {});
  };

  const onNewSession = async (agentId: string) => {
    const isChatAgent = agents.find((agent) => agent.id === agentId)?.surfaceType === 'chat';
    if (isChatAgent) {
      setActiveSessionFor(agentId, null);
      setTitleFor(agentId, '');
      setScreen(agentId as ScreenId);
      return;
    }
    setWorkflowByAgent((prev) => ({ ...prev, [agentId]: { sessionId: null, mode: 'live' } }));
    setWorkflowStatusByAgent((prev) => ({ ...prev, [agentId]: { status: 'idle' } }));
  };

  const onOpenSession = (agentId: string, sessionId: string) => {
    const isChatAgent = agents.find((agent) => agent.id === agentId)?.surfaceType === 'chat';
    setScreen(agentId as ScreenId);
    if (isChatAgent) {
      setActiveSessionFor(agentId, sessionId);
      refreshSessions(agentId, sessionId);
      return;
    }
    setWorkflowByAgent((prev) => ({ ...prev, [agentId]: { sessionId, mode: 'history' } }));
    refreshSessions(agentId);
  };

  const onRenameSession = (agentId: string, sessionId: string, title: string) => {
    const prevOverride = sessionOverridesRef.current.get(sessionId) ?? {};
    sessionOverridesRef.current.set(sessionId, { ...prevOverride, name: title });
    setSessions((prev) => {
      const list = prev[agentId] ?? [];
      return { ...prev, [agentId]: list.map((s) => (s.id === sessionId ? { ...s, name: title } : s)) };
    });
    if (sessionId === activeSessionFor(agentId)) setTitleFor(agentId, title);
    api.setChatTitle?.(sessionId, title)?.then(() => refreshSessions(agentId));
  };

  const onDeleteSession = (agentId: string, sessionId: string) => {
    sessionOverridesRef.current.delete(sessionId);
    api.deleteChatSession?.(sessionId).then(() => {
      if (sessionId === activeSessionFor(agentId)) setActiveSessionFor(agentId, null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    for (const [agentId, sid] of Object.entries(activeSessionByAgent)) {
      if (sid === sessionId) {
        setActiveSessionFor(agentId, null);
        refreshSessions(agentId);
      }
    }
  };

  const cancelQueuedSession = async (queueId: string) => {
    await api.cancelQueuedSession(queueId);
  };

  const activeAgent = derivedAgents.find((a) => a.id === screen);
  const isChatSurface = activeAgent?.surfaceType === 'chat';

  const topbarTitle = activeAgent
    ? isChatSurface
      ? (titleFor(activeAgent.id) || '新对话')
      : activeAgent.name
    : undefined;

  const statusText = (() => {
    if (activeAgent?.surfaceType !== 'workflow') return '';
    const wf = workflowStatusByAgent[activeAgent.id];
    return wf?.status === 'running' ? `正在执行:${wf.step ?? '…'}` : '';
  })();

  const navigate = (s: ScreenId) => {
    const isAgent = agents.some((a) => a.id === s);
    if (isAgent) {
      setScreen(s);
      refreshSessions(s);
      return;
    }
    // 对话/仪表板表面留档,待后端就绪后接入
    if (s === 'chat' || s === 'dashboard') { setScreen('home'); return; }
    setScreen(s);
  };

  // 一旦首条消息发出，立即把会话插入历史，避免等后端刷新造成延迟。
  const commitNewSession = (agentId: string, sessionId: string, title?: string) => {
    setActiveSessionFor(agentId, sessionId);
    sessionOverridesRef.current.set(sessionId, { name: title ? String(title).slice(0, 24) : '新对话', updatedAt: Date.now(), agentId });
    const name = String(title || '新对话').slice(0, 24);
    setTitleFor(agentId, name);
    setSessions((prev) => {
      const list = prev[agentId] ?? [];
      if (list.some((s) => s.id === sessionId)) return prev;
      const pinned = list.filter((s) => s.pinned);
      const unpinned = list.filter((s) => !s.pinned && !s.archived);
      const arch = list.filter((s) => s.archived);
      const sessionItem: ShellSession = { id: sessionId, name, state: '', active: true, updatedAt: Date.now() };
      return { ...prev, [agentId]: [...pinned, sessionItem, ...unpinned, ...arch] };
    });
    refreshSessions(agentId, sessionId);
  };

  // Per-agent actions: chat agents use the platform standard surface; workflow agents expose the
  // workflow lifecycle. `session` is the agent's own normalized timeline (backend truth source).
  const buildActions = (agentId: string, session: AgentSession): AgentSurfaceActions => {
    const isChat = agents.find((a) => a.id === agentId)?.surfaceType === 'chat';
    if (isChat) {
      return {
        newSession: () => onNewSession(agentId),
        openSession: (sessionId, title) => commitNewSession(agentId, sessionId, title),
        startWorkflow: () => {},
        review: () => {},
        requestExport: () => {},
        chooseDocument: async () => ({}),
      };
    }
    return {
      newSession: () => onNewSession(agentId),
      openSession: (id) => onOpenSession(agentId, id),
      startWorkflow: (payload) => {
        setWorkflowStatusByAgent((prev) => ({ ...prev, [agentId]: { status: 'running' } }));
        setWorkflowByAgent((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] ?? { sessionId: null, mode: 'live' }), mode: 'live' } }));
        api.runWorkflow(agentId, payload).then((res) => {
          if (res?.sessionId) setWorkflowByAgent((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] ?? { sessionId: null, mode: 'live' }), sessionId: res.sessionId ?? null } }));
        }).catch(() => {});
      },
      review: (action, payload) => {
        const sid = workflowFor(agentId).sessionId;
        if (!sid) return;
        api.updateWorkflowState(sid, { action, ...payload }).catch((e) => reportError(String(e?.message ?? e), { source: agentId }));
      },
      requestExport: () => {
        const sid = workflowFor(agentId).sessionId;
        if (!sid) { setScreen('approvals'); return; }
        const result = session.result ?? extractWorkflowResult(session.entries);
        const report = result?.['report'] as Record<string, unknown> | undefined;
        const compare = result?.['compare'];
        void api.requestExportReport(sid, {
          title: typeof report?.title === 'string' ? report.title : '合同审核报告',
          findings: Array.isArray(compare) ? compare.length : 0,
        }).catch(() => {});
      },
      chooseDocument: () => api.chooseDocument(),
    };
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <HomeView userName={userName} agents={derivedAgents} pendingApprovals={pending} onNavigate={navigate} />
    ),
    approvals: (
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>审批中心</h3>
        <ApprovalCenter proposals={pending} onOpenDetail={(p) => { setApprovalFocusId(p.id); setApprovalOpen(true); }} />
      </div>
    ),
    audit: (
      <AuditView key={auditVersion} api={api} onExport={exportAudit} />
    ),
    settings: (
      <SettingsView api={api} onExportAudit={exportAudit} />
    ),
  };

  // One always-mounted frame per agent so each agent keeps its own session (live/history) even
  // when its surface is unmounted. The frame shows the surface only while the agent is active.
  const agentFrames = derivedAgents.map((a) => (
    <AgentFrame
      key={a.id}
      agent={a}
      active={a.id === screen}
      draft={a.surfaceType === 'chat' && activeSessionFor(a.id) == null}
      sessionId={a.surfaceType === 'chat' ? activeSessionFor(a.id) : workflowFor(a.id).sessionId}
      mode={a.surfaceType === 'chat' ? 'live' : workflowFor(a.id).mode}
      buildActions={buildActions}
    />
  ));
  const surfaceNode = surfaces[screen] ?? null;

  return (
    <>
      <Shell
        active={screen}
        agents={derivedAgents}
        sessions={sessions}
        pendingApprovals={pending.length}
        statusText={statusText}
        title={topbarTitle}
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
      >
        {surfaceNode}
        {agentFrames}
      </Shell>
      {approvalOpen && (
        <ApprovalPanel
          proposals={pending}
          currentSessionId={activeSessionFor(agents.find((a) => a.surfaceType === 'chat')?.id ?? '')}
          focusId={approvalFocusId}
          onDecide={decide}
          onClose={() => setApprovalOpen(false)}
        />
      )}
    </>
  );
}
