import { ipcMain, dialog, app, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionSaddle } from '@sparkii/agent-host';
import { createBroker, runWorkflow, selectModel } from './workflow.js';
import { resolveExportPath } from './export-path.js';
import { loadSettings, saveSettings } from './settings.js';
import { listModels, testModel } from './model-probe.js';
import { autoWorkspacePath } from './workspace.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  const openSessions = new Map<string, { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string }>();

  const anchorDir = (sessionId: string) => join(rt.dataDir, 'sessions', sessionId);

  function buildSaddle(profileId: string, sessionId: string): SessionSaddle {
    const pr = rt.profileOf(profileId);
    const rec = rt.chatSessions.get(sessionId);
    return {
      tools: pr.profile.agent.tools,
      skillsDir: join(pr.dir, 'agent', 'skills'),
      cwd: anchorDir(sessionId),
      systemPrompt: pr.profile.agent.prompts.system,
      workspaceRoot: rec?.workspacePath,
    };
  }

  ipcMain.handle('sparkii:newChatSession', async (_e, profileId: string) => {
    const sessionId = randomUUID();
    const now = new Date();
    const workspacePath = autoWorkspacePath(app.getPath('desktop'), now);
    await mkdir(anchorDir(sessionId), { recursive: true });
    rt.chatSessions.create({
      id: sessionId, profileId, title: `会话 ${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      workspaceKind: 'auto', workspacePath,
    });
    return { sessionId, workspacePath, model: null };
  });

  ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    if (!openSessions.has(sessionId)) {
      const slot = await rt.pool.acquire(sessionId, {
        saddle: buildSaddle(rec.profileId, sessionId),
        resumeSessionFile: rec.piSessionFile ?? undefined,
      });
      openSessions.set(sessionId, { slot, profileId: rec.profileId });
      const state = await slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
    }
    const open = openSessions.get(sessionId)!;
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return { messages: (resp.data ?? []) as unknown[] };
  });

  ipcMain.handle('sparkii:listChatSessions', (_e, profileId?: string) => rt.chatSessions.list(profileId));
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);
  ipcMain.handle('sparkii:getChatMessages', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) return [];
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return (resp.data ?? []) as unknown[];
  });

  ipcMain.handle('sparkii:promptSession', async (_e, sessionId: string, text: string) => {
    const open = openSessions.get(sessionId);
    if (!open) throw new Error('session not open');
    const { slot, profileId } = open;
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId }));
    const rec = rt.chatSessions.get(sessionId);
    const pr = rt.profileOf(profileId);
    if (rec?.model) {
      const [provider, modelId] = rec.model.split('/');
      const resp = await slot.client.send({ type: 'set_model', provider, modelId });
      if (!resp.success) throw new Error(`cannot select model ${rec.model}: ${resp.error ?? 'unknown'}`);
    } else {
      const target = pr.router.resolve('coding') ?? pr.router.resolve('default');
      if (target) {
        const resp = await slot.client.send({ type: 'set_model', provider: target.provider, modelId: target.modelId });
        if (!resp.success) throw new Error(`cannot select model ${target.provider}/${target.modelId}: ${resp.error ?? 'unknown'}`);
      }
    }
    const win = getWindow();
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
      off = slot.client.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
        if (ev.type === 'agent_end') { clearTimeout(timer); off(); resolve(); }
      });
      slot.client.send({ type: 'prompt', message: text }).then((resp) => {
        if (!resp.success) { clearTimeout(timer); off(); reject(new Error(resp.error ?? 'prompt failed')); }
      });
    });
    const state = await slot.client.send({ type: 'get_state' });
    if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:abortChat', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) await open.slot.client.send({ type: 'abort' });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatTitle', (_e, sessionId: string, title: string) => {
    rt.chatSessions.update(sessionId, { title });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatModel', (_e, sessionId: string, model: string | null) => {
    rt.chatSessions.update(sessionId, { model });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatWorkspace', async (_e, sessionId: string, path: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    if (path) {
      rt.chatSessions.update(sessionId, { workspaceKind: 'user', workspacePath: path });
    } else {
      const now = new Date();
      rt.chatSessions.update(sessionId, { workspaceKind: 'auto', workspacePath: autoWorkspacePath(app.getPath('desktop'), now) });
    }
    const open = openSessions.get(sessionId);
    if (open) {
      const resp = await open.slot.client.send({ type: 'configure_session', saddle: buildSaddle(open.profileId, sessionId) });
      if (!resp.success) throw new Error(`configure_session failed: ${resp.error ?? 'unknown'}`);
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:chooseWorkspace', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? {} : { path: result.filePaths[0] };
  });

  ipcMain.handle('sparkii:getModelOptions', async () => {
    const settings = await loadSettings(rt.dataDir);
    const models = settings.baseUrl ? (await listModels(settings.baseUrl, settings.apiKey)).models ?? [] : [];
    return { defaultModel: settings.defaultModel ?? null, models };
  });

  ipcMain.handle('sparkii:deleteChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      const state = await open.slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
      await rt.pool.release(sessionId);
      openSessions.delete(sessionId);
    }
    rt.chatSessions.delete(sessionId);
    return { ok: true };
  });

  ipcMain.handle('sparkii:login', async (_e, username: string, password: string) => {
    rt.subject = await rt.identity.authenticate(username, password);
    return { userId: rt.subject.userId, roles: rt.subject.roles };
  });
  ipcMain.handle('sparkii:getProfile', () => {
    const first = [...rt.profiles.values()][0];
    return { manifest: first.profile.manifest, pages: first.profile.ui.pages, theme: first.profile.ui.theme, tools: first.profile.agent.tools };
  });
  ipcMain.handle('sparkii:listAgents', () =>
    [...rt.profiles.values()].map((pr) => ({
      id: pr.profile.manifest.name,
      name: pr.profile.manifest.displayName ?? pr.profile.manifest.name,
    })),
  );
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
      if (out.toolName === 'report.export') {
        const path = await resolveExportPath(getWindow, process.env, (win, opts) =>
          dialog.showSaveDialog(win as BrowserWindow, opts),
        );
        if (path) {
          out.payload = { ...(out.payload as Record<string, unknown>), path };
          out = await rt.executor.execute(out, { actor: rt.subject.userId });
          result = out.execution?.result;
        } else {
          await rt.audit.append({ actor: rt.subject.userId, action: 'execution.blocked', resource: out.toolName });
          out.execution = { ok: false, error: 'export path canceled' };
        }
      } else {
        out = await rt.executor.execute(out, { actor: rt.subject.userId });
        result = out.execution?.result;
      }
    }
    broker.decide(out.id, { approved: out.status === 'approved' || out.status === 'executed', status: out.status, result });
    return out;
  });
  ipcMain.handle('sparkii:queryAudit', (_e, filter: object) => rt.audit.query(filter));
  ipcMain.handle('sparkii:getSettings', () => loadSettings(rt.dataDir));
  ipcMain.handle('sparkii:saveSettings', (_e, settings: unknown) => saveSettings(rt.dataDir, settings as Parameters<typeof saveSettings>[1]));
  ipcMain.handle('sparkii:listModels', (_e, baseUrl: string, apiKey?: string) => listModels(baseUrl, apiKey));
  ipcMain.handle('sparkii:testModel', (_e, baseUrl: string, apiKey?: string) => testModel(baseUrl, apiKey));
  ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
    const sessionId = randomUUID();
    const slot = await rt.pool.acquire(sessionId);
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId: 'contract-review' }));
    try {
      await selectModel(rt, 'chat', sessionId);
      const c = slot.client;
      const win = getWindow();
      await new Promise<void>((resolve, reject) => {
        let off = () => {};
        const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
        off = c.onEvent((ev) => {
          win?.webContents.send('sparkii:event:chat-event', ev);
          if (ev.type === 'agent_end') { clearTimeout(timer); off(); resolve(); }
        });
        c.send({ type: 'prompt', message: text }).then((resp) => {
          if (!resp.success) { clearTimeout(timer); off(); reject(new Error(resp.error ?? 'prompt failed')); }
        });
      });
    } finally {
      await rt.pool.release(sessionId);
    }
    return { ok: true };
  });
  ipcMain.handle('sparkii:runWorkflow', async (_e, _id: string, input: Record<string, unknown>) => {
    await runWorkflow(rt, getWindow, input, broker);
    return { ok: true };
  });
  ipcMain.handle('sparkii:diagnostics', async () => ({ logs: await logger.export(), audit: await rt.audit.exportJsonl() }));
}
