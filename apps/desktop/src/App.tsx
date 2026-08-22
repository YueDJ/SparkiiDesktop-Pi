import { useEffect, useState } from 'react';
import { PageComposer } from './composer/PageComposer.js';
import { validatePageSchema } from './composer/validate.js';
import { ChatWorkbench } from './workbench/ChatWorkbench.js';
import { ApprovalDialog } from './approval/ApprovalDialog.js';
import { AuditView } from './audit/AuditView.js';

export function App() {
  const api = window.sparkii;
  const [authed, setAuthed] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<any>(null);
  const [state, setState] = useState<Record<string, unknown>>({ documents: [] });
  const [pending, setPending] = useState<any[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);

  useEffect(() => api.on('state', (s) => setState(s as Record<string, unknown>)), [api]);
  useEffect(() => api.on('approval', (p) => setPending((xs) => [...xs, p])), [api]);

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
    if (action === 'run-workflow:contract-review') api.runWorkflow('contract-review', { documents: state.documents });
    if (action === 'export-report') {
      const body = ((state.workflow as any)?.result?.report) ?? '';
      api.exportReport({ title: '审核报告', sections: [{ heading: '报告', body: String(body) }] });
    }
  };

  if (!authed) {
    return (
      <div>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>登录</button>
      </div>
    );
  }

  const page = profile?.pages?.['home'];
  return (
    <div>
      {page && validatePageSchema(page).ok ? <PageComposer schema={page} state={state} onAction={onAction} /> : null}
      <ChatWorkbench api={api} />
      {pending.map((p) => (
        <ApprovalDialog key={p.id} proposal={p} onDecide={(id, ok, note) => { api.decideApproval(id, ok, note).then(() => { refreshApprovals(); setAuditVersion((v) => v + 1); }); }} />
      ))}
      <AuditView key={auditVersion} api={api} />
    </div>
  );
}
