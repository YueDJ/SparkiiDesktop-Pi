import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession } from './shell/Shell.js';
import type { RuntimePoolSummary } from '@sparkii/ui';
import { SettingsView } from './shell/SettingsView.js';
import { ApprovalCenter } from './trust/ApprovalCenter.js';
import { ApprovalPanel } from './trust/ApprovalPanel.js';
import { AuditView } from './audit/AuditView.js';
import type { WorkflowStatusState } from './workbench/WorkflowStatus.js';
import { ContractSurface } from './surfaces/ContractSurface.js';
import { HomeView } from './surfaces/HomeView.js';
import { GeneralChatSurface } from './surfaces/GeneralChatSurface.js';

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

export function App() {
  const api = window.sparkii;
  const [userName, setUserName] = useState('');
  const [state, setState] = useState<Record<string, unknown>>({ documents: [] });
  const [pending, setPending] = useState<any[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);
  const [workflow, setWorkflow] = useState<WorkflowStatusState>({ status: 'idle' });
  const [screen, setScreen] = useState<ScreenId>('home');
  const [roles, setRoles] = useState<string[]>([]);
  const [agents, setAgents] = useState<ShellAgent[]>([{ id: 'contract-review', name: '合同审核智能体', status: 'idle' }]);
  const [sessions, setSessions] = useState<Record<string, ShellSession[]>>({});
  const [activeGeneralSession, setActiveGeneralSession] = useState<string | null>(null);
  const [generalTitle, setGeneralTitle] = useState('');
  const [globalError, setGlobalError] = useState('');
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

  useEffect(() => api.on('state', (s) => setState(s as Record<string, unknown>)), [api]);
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
    if (e.type === 'step_started') setWorkflow({ status: 'running', step: e.stepId });
    else if (e.type === 'workflow_completed') setWorkflow({ status: 'done' });
    else if (e.type === 'workflow_failed') setWorkflow({ status: 'failed', error: e.error?.message });
  }), [api]);
  useEffect(() => api.on('chat-event', (p: any) => {
    if (p?.sessionId) {
      const ov = sessionOverridesRef.current.get(p.sessionId);
      if (ov) ov.updatedAt = Date.now();
    }
    if (p?.type === 'session_title' && p?.sessionId) {
      setSessions((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = next[k].map((s) => (s.id === p.sessionId ? { ...s, name: p.title } : s));
        }
        return next;
      });
      if (p.sessionId === activeGeneralSession) setGeneralTitle(p.title);
    }
  }), [api, activeGeneralSession]);
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
          setAgents(list.map((a) => ({ id: a.id as ScreenId, name: a.name, status: 'idle' })));
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

  const onAction = async (action: string) => {
    if (action === 'documents.upload') {
      const { path } = await api.chooseDocument();
      if (path) setState((s) => ({ ...s, documents: [path] }));
    }
    if (action.startsWith('run-workflow:')) {
      const profileId = action.slice('run-workflow:'.length);
      setWorkflow({ status: 'running' });
      api.runWorkflow(profileId, { documents: state.documents });
    }
  };

  const refreshSessions = (agentId: string, activeId = activeGeneralSession) => {
    // 以 sessions 数组为唯一真相源：刷新只做“原地更新元数据 + 补齐新会话 + 移除已删除”，
    // 不重新排序，从而避免后端滞后的时间戳把会话来回挪动。
    api.listChatSessions?.()?.then((list: any[]) => {
      const fetchedById: Record<string, ShellSession & { profileId: string }> = {};
      const fetchedByProfile: Record<string, Array<ShellSession & { profileId: string }>> = {};
      for (const s of list ?? []) {
        const profileId = s.profileId ?? 'general';
        const diskName = sessionDisplayName({ title: s.title, firstMessage: s.firstMessage, updatedAt: s.updatedAt });
        const override = sessionOverridesRef.current.get(s.id);
        const name = override?.name ?? diskName;
        // 后端返回的名称与本地一致，说明已确认，清除覆盖
        if (override && diskName === override.name) sessionOverridesRef.current.delete(s.id);
        const item: ShellSession & { profileId: string } = {
          id: s.id,
          name,
          state: '',
          active: profileId === 'general' && s.id === activeId,
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
      if (active) setGeneralTitle(active.name);
    }).catch(() => {});
  };

  const onNewSession = async (agentId: string) => {
    if (agentId === 'general') {
      setGlobalError('');
      setActiveGeneralSession(null);
      setGeneralTitle('');
      setScreen('general');
      return;
    }
    setWorkflow({ status: 'idle' });
    setState((s) => ({ ...s, documents: [] }));
  };

  const onOpenSession = (agentId: string, sessionId: string) => {
    if (agentId !== 'general') {
      navigate(agentId as ScreenId);
      return;
    }
    setScreen('general');
    setActiveGeneralSession(sessionId);
    refreshSessions(agentId, sessionId);
  };

  const onRenameSession = (agentId: string, sessionId: string, title: string) => {
    const prevOverride = sessionOverridesRef.current.get(sessionId) ?? {};
    sessionOverridesRef.current.set(sessionId, { ...prevOverride, name: title });
    setSessions((prev) => {
      const list = prev[agentId] ?? [];
      return { ...prev, [agentId]: list.map((s) => (s.id === sessionId ? { ...s, name: title } : s)) };
    });
    if (sessionId === activeGeneralSession) setGeneralTitle(title);
    api.setChatTitle?.(sessionId, title)?.then(() => refreshSessions(agentId));
  };

  const onDeleteSession = (agentId: string, sessionId: string) => {
    sessionOverridesRef.current.delete(sessionId);
    api.deleteChatSession?.(sessionId).then(() => {
      if (sessionId === activeGeneralSession) setActiveGeneralSession(null);
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
    refreshSessions('general');
  }, []);

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
    if (sessionId === activeGeneralSession) setActiveGeneralSession(null);
    refreshSessions('general');
  };

  const cancelQueuedSession = async (queueId: string) => {
    await api.cancelQueuedSession(queueId);
  };

  const statusText = workflow.status === 'running'
    ? `正在执行:${workflow.step ?? '…'}`
    : '';

  const navigate = (s: ScreenId | 'contract-review') => {
    if (s === 'general') {
      setScreen('general');
      refreshSessions('general');
      return;
    }
    if (s === 'contract-review') {
      setScreen('contract-review');
      refreshSessions('contract-review');
      return;
    }
    // 对话/仪表板表面留档,待后端就绪后接入
    if (s === 'chat' || s === 'dashboard') { setScreen('contract-review'); return; }
    setScreen(s);
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <HomeView userName={userName} agents={derivedAgents} pendingApprovals={pending} onNavigate={navigate} />
    ),
    'contract-review': (
      <ContractSurface state={state} workflow={workflow} onAction={onAction} onRequestExport={() => setScreen('approvals')} />
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

  const generalSurface = (
    <GeneralChatSurface
      api={api}
      sessionId={activeGeneralSession}
      active={screen === 'general'}
      draft={screen === 'general' && activeGeneralSession === null}
      onSessionCommitted={(sessionId, title) => {
        setActiveGeneralSession(sessionId);
        // 一旦首条消息发出，立即把会话插入历史，避免等后端刷新造成延迟
        sessionOverridesRef.current.set(sessionId, { name: title ? String(title).slice(0, 24) : '新会话', updatedAt: Date.now(), agentId: 'general' });
        const name = String(title || '新会话').slice(0, 24);
        setGeneralTitle(name);
        setSessions((prev) => {
          const general = prev['general'] ?? [];
          if (general.some((s) => s.id === sessionId)) return prev;
          // 新会话插到“置顶会话”之后（真正的 sticky 置顶）
          const pinned = general.filter((s) => s.pinned);
          const unpinned = general.filter((s) => !s.pinned && !s.archived);
          const arch = general.filter((s) => s.archived);
          const sessionItem: ShellSession = { id: sessionId, name, state: '', active: true, updatedAt: Date.now() };
          return { ...prev, general: [...pinned, sessionItem, ...unpinned, ...arch] };
        });
        refreshSessions('general', sessionId);
      }}
      onNewSession={() => onNewSession('general')}
    />
  );

  const surfaceTitles: Partial<Record<ScreenId, string>> = {
    'contract-review': '合同审核 · 会话#3',
    chat: '法规问答 · 会话#1',
    dashboard: '舆情监控 · 会话#2',
    general: activeGeneralSession ? `通用智能体 · ${generalTitle || '会话'}` : '通用智能体',
  };

  return (
    <>
      {globalError && <div className="chat-error" role="alert" style={{ margin: 'var(--spacing-sm)' }}>{globalError}</div>}
      <Shell
        active={screen}
        agents={derivedAgents}
        sessions={sessions}
        pendingApprovals={pending.length}
        statusText={statusText}
        runtimePool={runtimePool}
        userName={userName}
        userRole={roles.length ? roles.join(' · ') : '审核员'}
        surfaceTitle={surfaceTitles[screen]}
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
        <div style={{ display: screen === 'general' ? 'block' : 'none', height: screen === 'general' ? '100%' : 'auto' }}>{generalSurface}</div>
        {screen !== 'general' && <div>{surfaces[screen]}</div>}
      </Shell>
      {approvalOpen && (
        <ApprovalPanel
          proposals={pending}
          currentSessionId={activeGeneralSession}
          focusId={approvalFocusId}
          onDecide={decide}
          onClose={() => setApprovalOpen(false)}
        />
      )}
    </>
  );
}
