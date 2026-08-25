import { useEffect, useState, type ReactNode } from 'react';
import { Shell, type ScreenId, type ShellAgent, type ShellSession } from './shell/Shell.js';
import { SettingsView } from './shell/SettingsView.js';
import { PageComposer } from './composer/PageComposer.js';
import { validatePageSchema } from './composer/validate.js';
import { ChatWorkbench } from './workbench/ChatWorkbench.js';
import { ApprovalDialog } from './approval/ApprovalDialog.js';
import { AuditView } from './audit/AuditView.js';
import { WorkflowStatus, type WorkflowStatusState } from './workbench/WorkflowStatus.js';

const AGENTS: ShellAgent[] = [
  { id: 'contract', name: '合同审核', status: 'running' },
  { id: 'chat', name: '法规问答', status: 'idle' },
  { id: 'dashboard', name: '舆情监控', status: 'queued', queuePosition: 1 },
];

const SESSIONS: Record<string, ShellSession[]> = {
  contract: [
    { id: 's3', name: '会话#3', state: '比对中', time: '今天', active: true },
    { id: 's2', name: '会话#2', state: '已完成', time: '昨天' },
    { id: 's1', name: '会话#1', state: '已归档', time: '周一' },
  ],
  chat: [
    { id: 'c2', name: '会话#2', state: '已完成', time: '今天' },
    { id: 'c1', name: '会话#1', state: '进行中', time: '昨天', active: true },
  ],
  dashboard: [
    { id: 'd1', name: '会话#1', state: '已生成周报', time: '今天' },
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

  const page = profile?.pages?.['home'];
  const statusText = workflow.status === 'running'
    ? `正在执行:${workflow.step ?? '…'}`
    : workflow.status === 'done' ? '审核完成 · 报告待复核'
      : workflow.status === 'failed' ? '审核失败'
        : '● 合同审核就绪 · 等待开始';

  const surfaces: Partial<Record<ScreenId, ReactNode>> = {
    home: (
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>工作台 · 上午好,{username}</div>
        <div className="grid-2" style={{ marginBottom: 14 }}>
          <div className="card">
            <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>待你处理</h3>
            {pending.length === 0 && <div className="muted">没有待审批事项</div>}
            {pending.map((p) => (
              <div key={p.id} className="item" onClick={() => setScreen('approvals')}>
                <span className="dot dot-wait" />{p.summary}<span className="muted">查看 →</span>
              </div>
            ))}
          </div>
          <div className="card">
            <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>系统状态</h3>
            <div className="kv"><span className="ok-t">●</span> 本机运行<br /><span className="ok-t">●</span> 模型已连接<br /><span className="ok-t">●</span> 审计已开启</div>
          </div>
        </div>
        <div className="grid-4" style={{ marginBottom: 16 }}>
          {AGENTS.map((a) => (
            <button key={a.id} type="button" className="agent-card" onClick={() => setScreen(a.id)}>
              <div className="nm">{a.name}</div>
              <div className="muted">{a.status === 'running' ? '运行中' : a.status === 'queued' ? `排队 ${a.queuePosition}` : '空闲'}</div>
            </button>
          ))}
        </div>
        <div className="card">
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>最近会话</h3>
          {Object.entries(SESSIONS).map(([agentId, sessions]) => (
            <div key={agentId} className="item" onClick={() => setScreen(agentId as ScreenId)}>
              <span className="dot dot-idle" />{AGENTS.find((a) => a.id === agentId)?.name} {sessions[0]?.name}<span className="muted">{sessions[0]?.time}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    contract: (
      <div>
        <WorkflowStatus state={workflow} />
        {page && validatePageSchema(page).ok ? <PageComposer schema={page} state={state} onAction={onAction} /> : <div className="muted">该智能体尚未配置页面</div>}
      </div>
    ),
    chat: (
      <ChatWorkbench api={api} />
    ),
    dashboard: (
      <div className="card">
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>舆情监控</h3>
        <div className="muted">仪表板式表面将在后续阶段接入真实数据源(本地知识库 / 连接器)。</div>
      </div>
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
      onNavigate={setScreen}
      onNewSession={onNewSession}
    >
      {surfaces[screen]}
    </Shell>
  );
}
