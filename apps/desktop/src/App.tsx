import { useEffect, useState, type ReactNode } from 'react';
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

function mapRuntimePool(raw: any, pendingApprovals: any[]): RuntimePoolSummary {
  const pendingSessionIds = new Set(pendingApprovals.map((p: any) => p.sessionId));
  return {
    active: Number(raw?.active ?? 0),
    queued: Number(raw?.queued ?? 0),
    maxAgents: Number(raw?.maxAgents ?? 4),
    sessions: (raw?.slots ?? []).map((s: any) => ({
      sessionId: s.sessionId,
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
      profileName: q.profileName || q.profileId,
      label: q.label || q.queueId,
      position: q.position,
    })),
  };
}

function profileIdForAgent(id: ScreenId): string {
  return id === 'contract' ? 'contract-review' : id;
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
  const [agents, setAgents] = useState<ShellAgent[]>([{ id: 'contract', name: '合同审核', status: 'idle' }]);
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
          setAgents(list.map((a) => ({ id: (a.id === 'contract-review' ? 'contract' : a.id) as ScreenId, name: a.name, status: 'idle' })));
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
    if (action === 'run-workflow:contract-review') {
      setWorkflow({ status: 'running' });
      api.runWorkflow('contract-review', { documents: state.documents });
    }
  };

  const refreshSessions = (agentId: string, activeId = activeGeneralSession) => {
    const profileId = agentId === 'contract' ? 'contract-review' : agentId;
    api.listChatSessions?.(profileId)?.then((list: any[]) => {
      const mapped: ShellSession[] = (list ?? []).map((s) => ({
        id: s.id,
        name: sessionDisplayName({ title: s.title, firstMessage: s.firstMessage, updatedAt: s.updatedAt }),
        state: '',
        time: s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
        active: s.id === activeId,
      }));
      setSessions((prev) => ({ ...prev, [agentId]: mapped }));
      const active = mapped.find((s) => s.id === activeId);
      if (active) setGeneralTitle(active.name);
    }).catch(() => {});
  };

  const onNewSession = async (agentId: string) => {
    if (agentId === 'general') {
      try {
        const res = await api.newChatSession?.('general');
        if (res?.sessionId) {
          setGlobalError('');
          setActiveGeneralSession(res.sessionId);
          refreshSessions('general', res.sessionId);
        }
      } catch (e) {
        setGlobalError(String((e as Error)?.message ?? e));
      }
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
    api.setChatTitle?.(sessionId, title).then(() => refreshSessions(agentId));
  };

  const onDeleteSession = (agentId: string, sessionId: string) => {
    api.deleteChatSession?.(sessionId).then(() => {
      if (sessionId === activeGeneralSession) setActiveGeneralSession(null);
      refreshSessions(agentId);
    });
  };

  const derivedAgents = agents.map((a) => {
    const profileId = profileIdForAgent(a.id);
    const running = runtimePool.sessions.some((s) => s.profileName === profileId);
    const queued = runtimePool.queue.some((q) => q.profileName === profileId);
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
    : workflow.status === 'done' ? '审核完成 · 报告待复核'
      : workflow.status === 'failed' ? '审核失败'
        : '合同审核就绪 · 等待开始';

  const navigate = (s: ScreenId | 'contract-review') => {
    if (s === 'general') {
      setScreen('general');
      refreshSessions('general');
      return;
    }
    if (s === 'contract' || s === 'contract-review') {
      setScreen('contract');
      refreshSessions('contract');
      return;
    }
    // 对话/仪表板表面留档,待后端就绪后接入
    if (s === 'chat' || s === 'dashboard') { setScreen('contract'); return; }
    setScreen(s);
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <HomeView userName={userName} agents={derivedAgents} pendingApprovals={pending} onNavigate={navigate} />
    ),
    contract: (
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
      <SettingsView api={api} />
    ),
  };

  const generalSurface = (
    <GeneralChatSurface
      api={api}
      sessionId={activeGeneralSession}
      active={screen === 'general'}
      onNewSession={() => onNewSession('general')}
    />
  );

  const surfaceTitles: Partial<Record<ScreenId, string>> = {
    contract: '合同审核 · 会话#3',
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
