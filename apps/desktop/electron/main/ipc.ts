import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { createBroker, runWorkflow, selectModel } from './workflow.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  rt.supervisor.onProposal((request) => broker.request(request, "default"));

  ipcMain.handle('sparkii:login', async (_e, username: string, password: string) => {
    rt.subject = await rt.identity.authenticate(username, password);
    return { userId: rt.subject.userId, roles: rt.subject.roles };
  });
  ipcMain.handle('sparkii:getProfile', () => ({ manifest: rt.profile.manifest, pages: rt.profile.ui.pages, theme: rt.profile.ui.theme, tools: rt.profile.agent.tools }));
  ipcMain.handle('sparkii:chooseDocument', async () => {
    if (process.env.SPARKII_E2E_DOCUMENT) return { path: process.env.SPARKII_E2E_DOCUMENT };
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '文档', extensions: ['pdf', 'docx', 'xlsx', 'txt', 'md'] }] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? { } : { path: result.filePaths[0] };
  });
  ipcMain.handle('sparkii:listPendingApprovals', () => rt.gate.listPending());
  ipcMain.handle('sparkii:decideApproval', async (_e, id: string, approved: boolean, note?: string) => {
    if (!rt.subject) throw new Error('not authenticated');
    let out = await rt.gate.decide(id, rt.subject, approved, note);
    let result: unknown;
    if (out.status === 'approved' && out.toolName !== 'workflow.approval') {
      out = await rt.executor.execute(out, { actor: rt.subject.userId });
      result = out.execution?.result;
    }
    broker.decide(out.id, { approved: out.status === 'approved' || out.status === 'executed', status: out.status, result });
    return out;
  });
  ipcMain.handle('sparkii:queryAudit', (_e, filter: object) => rt.audit.query(filter));
  ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
    await selectModel(rt, 'chat');
    const c = await rt.supervisor.start();
    const win = getWindow();
    let off = () => {};
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
      off = c.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', ev);
        if (ev.type === 'agent_end') { clearTimeout(timer); off(); resolve(); }
      });
      c.send({ type: 'prompt', message: text }).then((resp) => {
        if (!resp.success) { clearTimeout(timer); off(); reject(new Error(resp.error ?? 'prompt failed')); }
      });
    });
    return { ok: true };
  });
  ipcMain.handle('sparkii:runWorkflow', async (_e, _id: string, input: Record<string, unknown>) => {
    await runWorkflow(rt, getWindow, input, broker);
    return { ok: true };
  });
  ipcMain.handle('sparkii:exportReport', async (_e, input: { title: string; sections: Array<{ heading: string; body: string }> }) => {
    if (!rt.subject) throw new Error('not authenticated');
    let filePath: string | undefined;
    if (process.env.SPARKII_E2E_EXPORT_DIR) {
      filePath = `${process.env.SPARKII_E2E_EXPORT_DIR}/report.docx`;
    } else {
      const win = getWindow();
      const r = win
        ? await dialog.showSaveDialog(win, { defaultPath: `${input.title || 'report'}.docx` })
        : { canceled: true, filePath: undefined };
      if (r.canceled || !r.filePath) return { ok: false, status: 'canceled' };
      filePath = r.filePath;
    }
    const d = await broker.request({
      toolName: 'report.export', targetSystem: 'report', summary: `导出报告到 ${filePath}`,
      payload: { ...input, format: 'docx', path: filePath }, risk: 'write',
    }, 'default');
    return { ok: d.approved, proposalId: d.proposalId, status: d.status, result: d.result };
  });
  ipcMain.handle('sparkii:diagnostics', async () => ({ logs: await logger.export(), audit: await rt.audit.exportJsonl() }));
}
