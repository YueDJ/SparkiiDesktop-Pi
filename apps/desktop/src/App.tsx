import { useEffect, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession } from './shell/Shell.js';
import { SettingsView } from './shell/SettingsView.js';
import { ApprovalCenter } from './trust/ApprovalCenter.js';
import { ApprovalPanel } from './trust/ApprovalPanel.js';
import { ApprovalModal } from './trust/ApprovalModal.js';
import { riskInfo, type ApprovalProposalLike } from './trust/types.js';
import { AuditView } from './audit/AuditView.js';
import type { WorkflowStatusState } from './workbench/WorkflowStatus.js';
import { ContractSurface } from './surfaces/ContractSurface.js';
import { HomeView } from './surfaces/HomeView.js';
import { GeneralChatSurface } from './surfaces/GeneralChatSurface.js';

export function App() {
  const api = window.sparkii;
  const [authed, setAuthed] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<any>(null);
  const [state, setState] = useState<Record<string, unknown>>({ documents: [] });
  const [pending, setPending] = useState<any[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);
  const [workflow, setWorkflow] = useState<WorkflowStatusState>({ status: 'idle' });
  const [screen, setScreen] = useState<ScreenId>('home');
  const [roles, setRoles] = useState<string[]>([]);
  const [detail, setDetail] = useState<ApprovalProposalLike | null>(null);
  const [agents, setAgents] = useState<ShellAgent[]>([{ id: 'contract', name: '合同审核', status: 'idle' }]);
  const [sessions, setSessions] = useState<Record<string, ShellSession[]>>({});
  const [activeGeneralSession, setActiveGeneralSession] = useState<string | null>(null);
  const [generalTitle, setGeneralTitle] = useState('');

  useEffect(() => api.on('state', (s) => setState(s as Record<string, unknown>)), [api]);
  useEffect(() => api.on('approval', (p) => {
    setPending((xs) => [...xs, p]);
    // 审批是需要人工接管的时刻:新提案到达时自动弹出详情(P2/P1)
    setDetail((cur) => cur ?? (p as ApprovalProposalLike));
  }), [api]);
  useEffect(() => api.on('workflow', (e: any) => {
    if (e.type === 'step_started') setWorkflow({ status: 'running', step: e.stepId });
    else if (e.type === 'workflow_completed') setWorkflow({ status: 'done' });
    else if (e.type === 'workflow_failed') setWorkflow({ status: 'failed', error: e.error?.message });
  }), [api]);

  const refreshApprovals = () => api.listPendingApprovals().then((xs) => setPending(xs as any[]));

  const decide = (id: string, ok: boolean, note?: string) => {
    api.decideApproval(id, ok, note).then(() => {
      setDetail(null);
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

  const login = async () => {
    const res = await api.login(username, password);
    setAuthed(true);
    setRoles(res.roles ?? []);
    setProfile(await api.getProfile());
    await refreshApprovals();
    api.listAgents?.().then((list: Array<{ id: string; name: string }>) => {
      if (Array.isArray(list) && list.length) {
        setAgents(list.map((a) => ({
          // profile manifest name is contract-review, while the surface key is contract
          id: (a.id === 'contract-review' ? 'contract' : a.id) as ScreenId,
          name: a.name,
          status: 'idle',
        })));
      }
    }).catch(() => {});
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

  const refreshSessions = (agentId: string) => {
    api.listChatSessions?.(agentId)?.then((list: any[]) => {
      const mapped: ShellSession[] = (list ?? []).map((s) => ({
        id: s.id,
        name: s.title ?? s.id,
        state: '',
        time: s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
      }));
      setSessions((prev) => ({ ...prev, [agentId]: mapped }));
      const active = mapped.find((s) => s.id === activeGeneralSession);
      if (active) setGeneralTitle(active.name);
    }).catch(() => {});
  };

  const onNewSession = async (agentId: string) => {
    if (agentId === 'general') {
      const res = await api.newChatSession?.('general');
      if (res?.sessionId) {
        setActiveGeneralSession(res.sessionId);
        refreshSessions('general');
      }
      return;
    }
    setWorkflow({ status: 'idle' });
    setState((s) => ({ ...s, documents: [] }));
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

  if (!authed) {
    return (
      <div className="login-wrap">
        <div className="login-left">
          <h1>Sparkii</h1>
          <p><b>可控</b>:写操作必须人工批准,拒绝即不写</p>
          <p><b>可审计</b>:全程留痕,可导出、可回溯</p>
          <p><b>本机运行</b>:数据不出本机,离线可用</p>
        </div>
        <div className="login-right">
          <div className="login-form">
            <h2>登录工作台</h2>
            <div className="muted" style={{ marginBottom: 18 }}>本地账号 · 数据留在本机</div>
            <input className="field" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input className="field" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn primary" style={{ width: '100%' }} onClick={login}>登录</button>
            <div className="trustline">● 审计已开启 · 本机运行</div>
          </div>
        </div>
      </div>
    );
  }

  const statusText = workflow.status === 'running'
    ? `正在执行:${workflow.step ?? '…'}`
    : workflow.status === 'done' ? '审核完成 · 报告待复核'
      : workflow.status === 'failed' ? '审核失败'
        : '● 合同审核就绪 · 等待开始';

  const navigate = (s: ScreenId) => {
    if (s === 'general') {
      setScreen('general');
      refreshSessions('general');
      return;
    }
    // 仅合同审核已落地;对话/仪表板表面留档,待后端就绪后接入
    if (s === 'chat' || s === 'dashboard') { setScreen('contract'); return; }
    setScreen(s);
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <HomeView userName={username} agents={agents} pendingApprovals={pending} onNavigate={navigate} />
    ),
    contract: (
      <ContractSurface state={state} workflow={workflow} onAction={onAction} onRequestExport={() => setScreen('approvals')} />
    ),
    general: (
      <GeneralChatSurface
        api={api}
        sessionId={activeGeneralSession}
        onNewSession={() => onNewSession('general')}
      />
    ),
    approvals: (
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>审批中心</h3>
        <ApprovalCenter proposals={pending} onOpenDetail={setDetail} />
      </div>
    ),
    audit: (
      <AuditView key={auditVersion} api={api} onExport={exportAudit} />
    ),
    settings: (
      <SettingsView api={api} />
    ),
  };

  const surfaceTitles: Partial<Record<ScreenId, string>> = {
    contract: '合同审核 · 会话#3',
    chat: '法规问答 · 会话#1',
    dashboard: '舆情监控 · 会话#2',
    general: activeGeneralSession ? `通用智能体 · ${generalTitle || '会话'}` : '通用智能体',
  };

  return (
    <>
      <Shell
        active={screen}
        agents={agents}
        sessions={sessions}
        pendingApprovals={pending.length}
        statusText={statusText}
        userName={username}
        userRole={roles.length ? roles.join(' · ') : '审核员'}
        surfaceTitle={surfaceTitles[screen]}
        onNavigate={navigate}
        onNewSession={onNewSession}
        onRenameSession={onRenameSession}
        onDeleteSession={onDeleteSession}
      >
        {surfaces[screen]}
      </Shell>
      {detail && (riskInfo(detail.risk).level === 'high'
        ? <ApprovalModal proposal={detail} onDecide={decide} onClose={() => setDetail(null)} />
        : <ApprovalPanel proposal={detail} onDecide={decide} onClose={() => setDetail(null)} />)}
    </>
  );
}
