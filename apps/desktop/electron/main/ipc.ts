import { ipcMain, dialog, app, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listPiSessions, readPiSessionMessages, type PiProviderInfo, type SessionSaddle } from '@sparkii/agent-host';
import { createBroker, resolveModelTarget, runWorkflow, selectModel } from './workflow.js';
import { resolveExportPath } from './export-path.js';
import { loadSettings, saveSettings } from './settings.js';
import { buildProviderList } from './provider-catalog.js';
import { autoWorkspacePath } from './workspace.js';
import { buildProfileSaddle } from './saddle.js';
import { writePiModelsConfig } from './pi-model-config.js';
import { probeProviderModels } from './provider-probe.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  const openSessions = new Map<string, { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string }>();
  const titledSessions = new Set<string>();

  const anchorDir = (sessionId: string) => join(rt.dataDir, 'sessions', sessionId);

  function buildSaddle(profileId: string, sessionId: string): SessionSaddle {
    return buildProfileSaddle(rt.profileOf(profileId), anchorDir(sessionId), rt.chatSessions.get(sessionId)?.workspacePath);
  }

  async function withProbeSlot<T>(fn: (client: Awaited<ReturnType<typeof rt.pool.acquire>>['client']) => Promise<T>): Promise<T> {
    const key = `probe:${randomUUID()}`;
    const slot = await rt.pool.acquire(key, {});
    try {
      return await fn(slot.client);
    } finally {
      await rt.pool.release(key);
    }
  }

  async function injectProbeKey(client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'], providerId: string): Promise<void> {
    const key = await rt.keyFor(providerId);
    if (key) await client.send({ type: 'set_api_key', provider: providerId, apiKey: key });
  }

  async function providerProbeTarget(providerId: string, apiKeyOverride?: string | null) {
    const settings = await loadSettings(rt.dataDir);
    const custom = (settings.providers ?? []).find((p) => p.id === providerId);
    const apiKey = apiKeyOverride ?? (await rt.keyFor(providerId));
    if (custom) return { baseUrl: custom.baseUrl, api: custom.api, apiKey };
    const runtimeProviders = await withProbeSlot(async (client) => {
      const resp = await client.send({ type: 'list_providers' });
      if (!resp.success) throw new Error(resp.error ?? 'list_providers failed');
      return (resp.data ?? []) as PiProviderInfo[];
    });
    const base = runtimeProviders.find((p) => p.id === providerId);
    if (!base) throw new Error(`unknown provider ${providerId}`);
    return { baseUrl: base.baseUrl, api: undefined, apiKey };
  }

  const messageText = (m: unknown): string => {
    const rec = (m ?? {}) as { role?: string; text?: string; content?: unknown };
    if (typeof rec.content === 'string') return rec.content;
    if (Array.isArray(rec.content)) return rec.content.map((b) => (b as { text?: string })?.text ?? '').join('');
    return typeof rec.text === 'string' ? rec.text : '';
  };

  async function maybeGenerateTitle(
    sessionId: string,
    profileId: string,
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>,
  ): Promise<void> {
    try {
      const settings = await loadSettings(rt.dataDir);
      const target = resolveModelTarget(settings, 'title');
      if (!target) return;
      const resp = await slot.client.send({ type: 'get_messages' });
      const messages = (resp.data ?? []) as unknown[];
      const firstUser = messages.find((m) => (m as { role?: string })?.role === 'user');
      const firstAssistant = messages.find((m) => (m as { role?: string })?.role === 'assistant');
      const userText = messageText(firstUser);
      const assistantText = messageText(firstAssistant);
      const prompt = userText
        ? `请为以下对话生成一个不超过20字的标题。\n用户：${userText}${assistantText ? `\n助手：${assistantText}` : ''}`
        : '';
      if (!prompt) return;
      const titleResp = await slot.client.send({
        type: 'complete',
        provider: target.provider,
        modelId: target.modelId,
        text: prompt,
      });
      if (!titleResp.success) return;
      const name = String(titleResp.data ?? '').trim().slice(0, 40);
      if (!name) return;
      await slot.client.send({ type: 'set_session_name', name });
      getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_title', sessionId, title: name });
    } catch {
      // 标题生成失败不影响主流程
    }
  }

  ipcMain.handle('sparkii:newChatSession', async (_e, profileId: string) => {
    const now = new Date();
    const workspacePath = autoWorkspacePath(app.getPath('desktop'), now);
    const tempKey = `new:${randomUUID()}`;
    const slot = await rt.pool.acquire(tempKey, {
      saddle: buildProfileSaddle(rt.profileOf(profileId), anchorDir(tempKey), workspacePath),
    });
    let sessionId: string | undefined;
    try {
      const state = await slot.client.send({ type: 'get_state' });
      if (!state.success) throw new Error(state.error ?? 'get_state failed');
      sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
      const sessionFile = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (!sessionId) throw new Error('runtime did not provide a session id');
      rt.pool.renameSession(tempKey, sessionId);
      openSessions.set(sessionId, { slot, profileId });
      await mkdir(anchorDir(sessionId), { recursive: true });
      rt.chatSessions.create({
        id: sessionId,
        profileId,
        workspaceKind: 'auto',
        workspacePath,
        piSessionFile: sessionFile ?? null,
      });
      return { sessionId, workspacePath, model: null };
    } catch (e) {
      if (sessionId) {
        openSessions.delete(sessionId);
        await rt.pool.release(sessionId);
      } else {
        await rt.pool.release(tempKey);
      }
      throw e;
    }
  });

  ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      const resp = await open.slot.client.send({ type: 'get_messages' });
      return { messages: (resp.data ?? []) as unknown[] };
    }
    const rec = rt.chatSessions.get(sessionId) ?? (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
    if (!rec) throw new Error('session not found');
    const file = (rec as { piSessionFile?: string | null }).piSessionFile
      ?? (rec as { path?: string }).path;
    if (!file) return { messages: [] };
    try {
      return { messages: readPiSessionMessages(file) };
    } catch (e) {
      // 空会话或尚未落盘的会话（首条 assistant 才写 jsonl）没有文件，返回空消息。
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [] };
      throw e;
    }
  });

  ipcMain.handle('sparkii:listChatSessions', async (_e, profileId?: string) => {
    const all = await listPiSessions(join(rt.piAgentDir, 'sessions'));
    const mapped = all.map((s) => {
      const rec = rt.chatSessions.get(s.id);
      return {
        id: s.id,
        title: s.name ?? s.firstMessage,
        profileId: rec?.profileId,
        updatedAt: s.modified.getTime(),
        piFile: s.path,
      };
    });
    return profileId ? mapped.filter((m) => m.profileId === profileId || m.profileId === undefined) : mapped;
  });
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);
  ipcMain.handle('sparkii:getChatMessages', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) return [];
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return (resp.data ?? []) as unknown[];
  });

  ipcMain.handle('sparkii:promptSession', async (_e, sessionId: string, text: string) => {
    let open = openSessions.get(sessionId);
    if (!open) {
      const rec = rt.chatSessions.get(sessionId);
      if (!rec) throw new Error('session not found');
      const slot = await rt.pool.acquire(sessionId, {
        saddle: buildSaddle(rec.profileId, sessionId),
        resumeSessionFile: rec.piSessionFile ?? undefined,
      });
      open = { slot, profileId: rec.profileId };
      openSessions.set(sessionId, open);
    }
    const { slot, profileId } = open;
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId }));
    const rec = rt.chatSessions.get(sessionId);

    if (rec?.model) {
      await selectModel(rt, 'chat', sessionId, rec.model);
    } else {
      await selectModel(rt, 'chat', sessionId);
    }
    const win = getWindow();
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
      off = slot.client.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
        if (ev.type === 'agent_end') {
          clearTimeout(timer); off(); resolve();
          if (!titledSessions.has(sessionId)) {
            titledSessions.add(sessionId);
            void maybeGenerateTitle(sessionId, profileId, slot).catch(() => {});
          }
        }
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
    const open = openSessions.get(sessionId);
    if (!open) {
      const rec = rt.chatSessions.get(sessionId);
      if (rec) {
        void rt.pool.acquire(sessionId, {
          saddle: buildSaddle(rec.profileId, sessionId),
          resumeSessionFile: rec.piSessionFile ?? undefined,
        }).then((slot) => {
          openSessions.set(sessionId, { slot, profileId: rec.profileId });
          return slot.client.send({ type: 'set_session_name', name: title });
        }).catch(() => {});
        return { ok: true };
      }
    }
    if (open) void open.slot.client.send({ type: 'set_session_name', name: title }).catch(() => {});
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
    const providerId = settings.activeProviderId ?? 'deepseek';
    const models = await withProbeSlot(async (client) => {
      await injectProbeKey(client, providerId);
      const resp = await client.send({ type: 'list_models', provider: providerId });
      if (!resp.success) return [] as string[];
      return ((resp.data ?? []) as Array<{ modelId: string }>).map((m) => m.modelId);
    }).catch(() => [] as string[]);
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

  ipcMain.handle('sparkii:getLocalSubject', () => ({
    userId: rt.subject.userId,
    roles: rt.subject.roles,
  }));
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
  ipcMain.handle('sparkii:getSettings', async () => {
    const settings = await loadSettings(rt.dataDir);
    const apiKey = settings.activeProviderId ? await rt.keyFor(settings.activeProviderId) : null;
    return { ...settings, ...(apiKey ? { apiKey } : {}) };
  });
  ipcMain.handle('sparkii:getApiKey', (_e, providerId: string) => rt.keyFor(providerId));
  ipcMain.handle('sparkii:listProviders', async () => {
    const settings = await loadSettings(rt.dataDir);
    const runtimeProviders = await withProbeSlot(async (client) => {
      const resp = await client.send({ type: 'list_providers' });
      if (!resp.success) throw new Error(resp.error ?? 'list_providers failed');
      return (resp.data ?? []) as PiProviderInfo[];
    });
    return buildProviderList(runtimeProviders, settings.providers ?? []);
  });
  ipcMain.handle('sparkii:saveSettings', async (_e, settings: unknown) => {
    const s = settings as Parameters<typeof saveSettings>[1] & { apiKey?: string };
    const { apiKey, ...rest } = s;
    await saveSettings(rt.dataDir, rest);
    if (s.activeProviderId) {
      await rt.setKey(s.activeProviderId, apiKey ?? '');
      await rt.pool.broadcast(
        apiKey
          ? { type: 'set_api_key', provider: s.activeProviderId, apiKey }
          : { type: 'remove_api_key', provider: s.activeProviderId },
      );
    }
    await writePiModelsConfig(rt.piAgentDir, s.providers ?? []);
    return { ok: true };
  });
  ipcMain.handle('sparkii:listModels', async (_e, providerId: string, apiKey?: string | null) => {
    try {
      const target = await providerProbeTarget(providerId, apiKey);
      const result = await probeProviderModels({ providerId, ...target });
      return {
        ok: result.ok,
        models: result.models ?? [],
        httpStatus: result.httpStatus,
        reason: result.reason,
        error: result.error,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('sparkii:testConnection', async (_e, providerId: string, apiKey?: string | null) => {
    try {
      const target = await providerProbeTarget(providerId, apiKey);
      const result = await probeProviderModels({ providerId, ...target });
      return {
        ok: result.ok,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        reason: result.reason,
        error: result.error,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
    const sessionId = randomUUID();
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildProfileSaddle(rt.profileOf('contract-review'), anchorDir(sessionId)),
    });
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
