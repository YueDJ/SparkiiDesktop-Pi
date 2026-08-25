import { useEffect, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession } from './shell/Shell.js';
import { SettingsView } from './shell/SettingsView.js';
import { ApprovalDialog } from './approval/ApprovalDialog.js';
import { AuditView } from './audit/AuditView.js';
import type { WorkflowStatusState } from './workbench/WorkflowStatus.js';
import { ContractSurface } from './surfaces/ContractSurface.js';

const AGENTS: ShellAgent[] = [
  { id: 'contract', name: '合同审核', status: 'running' },
];

const SESSIONS: Record<string, ShellSession[]> = {
  contract: [
    { id: 's3', name: '会话#3', state: '比对中', time: '今天', active: true },
    { id: 's2', name: '会话#2', state: '已完成', time: '昨天' },
    { id: 's1', name: '会话#1', state: '已归档', time: '周一' },
  ],
};

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
  const [screen, setScreen] = useState<ScreenId>('contract');

  useEffect(() => api.on('state', (s) => setState(s as Record<string, unknown>)), [api]);
  useEffect(() => api.on('approval', (p) => setPending((xs) => [...xs, p])), [api]);
  useEffect(() => api.on('workflow', (e: any) => {
    if (e.type === 'step_started') setWorkflow({ status: 'running', step: e.stepId });
    else if (e.type === 'workflow_completed') setWorkflow({ status: 'done' });
    else if (e.type === 'workflow_failed') setWorkflow({ status: 'failed', error: e.error?.message });
  }), [api]);

  const refreshApprovals = () => api.listPendingApprovals().then((xs) => setPending(xs as any[]));

  const login = async () => {
    await api.login(username, password);
    setAuthed(true);
    setProfile(await api.getProfile());
    await refreshApprovals();
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

  const onNewSession = () => {
    setWorkflow({ status: 'idle' });
    setState((s) => ({ ...s, documents: [] }));
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
    // 仅合同审核已落地;对话/仪表板/首页总览表面留档,待后端就绪后接入
    if (s === 'home' || s === 'chat' || s === 'dashboard') { setScreen('contract'); return; }
    setScreen(s);
  };

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    contract: (
      <ContractSurface state={state} workflow={workflow} onAction={onAction} onRequestExport={() => setScreen('approvals')} />
    ),
    approvals: (
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>审批中心</h3>
        {pending.length === 0 && <div className="card muted">没有待处理的审批事项</div>}
        {pending.map((p) => (
          <ApprovalDialog
            key={p.id}
            proposal={p}
            onDecide={(id, ok, note) => {
              api.decideApproval(id, ok, note).then(() => {
                refreshApprovals();
                setAuditVersion((v) => v + 1);
              });
            }}
          />
        ))}
      </div>
    ),
    audit: (
      <AuditView key={auditVersion} api={api} />
    ),
    settings: (
      <SettingsView />
    ),
  };

  const surfaceTitles: Partial<Record<ScreenId, string>> = {
    contract: '合同审核 · 会话#3',
    chat: '法规问答 · 会话#1',
    dashboard: '舆情监控 · 会话#2',
  };

  return (
    <Shell
      active={screen}
      agents={AGENTS}
      sessions={SESSIONS}
      pendingApprovals={pending.length}
      statusText={statusText}
      surfaceTitle={surfaceTitles[screen]}
      onNavigate={navigate}
      onNewSession={onNewSession}
    >
      {surfaces[screen]}
    </Shell>
  );
}
