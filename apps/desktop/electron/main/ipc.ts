import { ipcMain, dialog, app, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listPiSessions, readPiSessionMessages, type PiProviderInfo, type SessionSaddle } from '@sparkii/agent-host';
import { applyThinkingLevel, createBroker, resolveModelTarget, resolveSessionModel, resolveThinkingLevel, runWorkflow, selectModel } from './workflow.js';
import { resolveExportPath } from './export-path.js';
import { loadSettings, saveSettings } from './settings.js';
import { buildProviderList } from './provider-catalog.js';
import { autoWorkspacePath } from './workspace.js';
import { buildProfileSaddle } from './saddle.js';
import { writePiModelsConfig } from './pi-model-config.js';
import { probeProviderModels } from './provider-probe.js';
import { mutateQueues, type QueueMutation, type QueueSnapshot } from './queue-mutation.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  const openSessions = new Map<
    string,
    { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string; offEvents?: () => void }
  >();
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

  const chatStateData = (data: unknown): {
    isStreaming?: boolean;
    streaming?: boolean;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
  } => (data ?? {}) as {
    isStreaming?: boolean;
    streaming?: boolean;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
  };

  async function ensureOpenSession(sessionId: string): Promise<{
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>;
    profileId: string;
    offEvents?: () => void;
  }> {
    let open = openSessions.get(sessionId);
    if (open) return open;

    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildSaddle(rec.profileId, sessionId),
      resumeSessionFile: rec.piSessionFile ?? undefined,
    });
    open = { slot, profileId: rec.profileId };
    openSessions.set(sessionId, open);
    return open;
  }

  function pipeSessionEvents(
    sessionId: string,
    entry: { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string; offEvents?: () => void },
  ): void {
    if (entry.offEvents) return;
    const win = getWindow();
    entry.offEvents = entry.slot.client.onEvent((ev) => {
      win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
      if (ev.type === 'agent_end' && !titledSessions.has(sessionId)) {
        titledSessions.add(sessionId);
        void maybeGenerateTitle(sessionId, entry.profileId, entry.slot).catch(() => {});
      }
    });
  }

  async function readQueues(entry: { slot: Awaited<ReturnType<typeof rt.pool.acquire>> }): Promise<QueueSnapshot> {
    const state = await entry.slot.client.send({ type: 'get_state' });
    if (!state.success) throw new Error(state.error ?? 'get_state failed');
    const data = chatStateData(state.data);
    return {
      steering: Array.isArray(data.steering) ? data.steering : [],
      followUp: Array.isArray(data.followUp) ? data.followUp : [],
    };
  }

  async function rebuildQueues(
    client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'],
    snapshot: QueueSnapshot,
  ): Promise<void> {
    for (const message of snapshot.steering) {
      await client.send({ type: 'steer', message });
    }
    for (const message of snapshot.followUp) {
      await client.send({ type: 'follow_up', message });
    }
  }

  async function waitForIdle(
    client: Awaited<ReturnType<typeof rt.pool.acquire>>['client'],
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await client.send({ type: 'get_state' });
      if (!state.success) throw new Error(state.error ?? 'get_state failed');
      const data = chatStateData(state.data);
      const streaming = data.isStreaming ?? data.streaming ?? false;
      if (!streaming) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('stop timeout');
  }

  ipcMain.handle('sparkii:newChatSession', async (_e, profileId: string) => {
    const now = new Date();
    const workspacePath = autoWorkspacePath(app.getPath('desktop'), now);
    const settings = await loadSettings(rt.dataDir);
    const maxAgents = Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4);
    if (rt.pool.activeCount() >= maxAgents) {
      throw new Error(`已达到最大并发会话数 ${maxAgents}，请先关闭一个空闲会话`);
    }
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
      const entry = { slot, profileId };
      openSessions.set(sessionId, entry);
      pipeSessionEvents(sessionId, entry);
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
    const seen = new Set(mapped.map((m) => m.id));
    const stored = rt.chatSessions.list(profileId).map((rec) => ({
      id: rec.id,
      title: undefined,
      profileId: rec.profileId,
      updatedAt: rec.updatedAt,
      piFile: rec.piSessionFile ?? undefined,
    }));
    const merged = [...mapped, ...stored.filter((m) => !seen.has(m.id))];
    return profileId ? merged.filter((m) => m.profileId === profileId || m.profileId === undefined) : merged;
  });
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);
  ipcMain.handle('sparkii:getChatMessages', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) return [];
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return (resp.data ?? []) as unknown[];
  });

  ipcMain.handle('sparkii:promptSession', async (
    _e,
    sessionId: string,
    text: string,
    options?: { behavior?: 'steer' | 'followUp' },
  ) => {
    const open = await ensureOpenSession(sessionId);
    pipeSessionEvents(sessionId, open);
    open.slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId: open.profileId }));
    const rec = rt.chatSessions.get(sessionId);

    const target = rec?.model
      ? await selectModel(rt, 'chat', sessionId, rec.model)
      : await selectModel(rt, 'chat', sessionId);
    if (target) {
      const settings = await loadSettings(rt.dataDir);
      await applyThinkingLevel(open.slot.client, resolveThinkingLevel(settings, rec, target));
    }

    const stateResp = await open.slot.client.send({ type: 'get_state' });
    if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
    const state = chatStateData(stateResp.data);
    const isStreaming = state.isStreaming ?? state.streaming ?? false;
    const behavior = options?.behavior ?? (isStreaming ? 'followUp' : 'prompt');

    if (behavior === 'steer') {
      const resp = await open.slot.client.send({ type: 'steer', message: text });
      if (!resp.success) throw new Error(resp.error ?? 'steer failed');
    } else if (behavior === 'followUp') {
      const resp = await open.slot.client.send({ type: 'follow_up', message: text });
      if (!resp.success) throw new Error(resp.error ?? 'follow_up failed');
    } else {
      const resp = await open.slot.client.send({ type: 'prompt', message: text });
      if (!resp.success) throw new Error(resp.error ?? 'prompt failed');
    }

    const after = await open.slot.client.send({ type: 'get_state' });
    if ((after.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(sessionId, {
        piSessionFile: (after.data as { sessionFile: string }).sessionFile,
      });
    }
    return { ok: true, behavior: behavior === 'prompt' ? 'prompt' : behavior };
  });

  ipcMain.handle('sparkii:abortChat', async (_e, sessionId: string) => {
    const open = await ensureOpenSession(sessionId);
    pipeSessionEvents(sessionId, open);
    const cleared = await readQueues(open);

    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    const abortResp = await open.slot.client.send({ type: 'abort' });
    if (!abortResp.success) throw new Error(abortResp.error ?? 'abort failed');
    await waitForIdle(open.slot.client);
    return { ok: true, cleared };
  });

  ipcMain.handle('sparkii:getChatState', async (_e, sessionId: string) => {
    const open = await ensureOpenSession(sessionId);
    pipeSessionEvents(sessionId, open);
    const resp = await open.slot.client.send({ type: 'get_state' });
    if (!resp.success) throw new Error(resp.error ?? 'get_state failed');
    const data = chatStateData(resp.data);
    return {
      streaming: data.isStreaming ?? data.streaming ?? false,
      steering: data.steering ?? [],
      followUp: data.followUp ?? [],
    };
  });

  ipcMain.handle('sparkii:queueMutate', async (_e, sessionId: string, mutation: QueueMutation) => {
    const open = await ensureOpenSession(sessionId);
    pipeSessionEvents(sessionId, open);
    const snapshot = await readQueues(open);
    const next = mutateQueues(snapshot, mutation);

    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    await rebuildQueues(open.slot.client, next);
    return { ok: true, steering: next.steering, followUp: next.followUp };
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

  ipcMain.handle('sparkii:setChatThinkingLevel', async (_e, sessionId: string, level: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    rt.chatSessions.update(sessionId, { thinkingLevel: level });
    if (level) {
      const settings = await loadSettings(rt.dataDir);
      const target = resolveSessionModel(settings, rec);
      if (target) {
        const next = { ...(settings.modelThinkingLevels ?? {}), [`${target.provider}/${target.modelId}`]: level };
        await saveSettings(rt.dataDir, { ...settings, modelThinkingLevels: next });
      }
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:listThinkingLevels', async (_e, providerId: string, modelId: string) => {
    return withProbeSlot(async (client) => {
      await injectProbeKey(client, providerId);
      const modelResp = await client.send({ type: 'set_model', provider: providerId, modelId });
      if (!modelResp.success) throw new Error(modelResp.error ?? 'set_model failed');
      const resp = await client.send({ type: 'list_thinking_levels' });
      if (!resp.success) throw new Error(resp.error ?? 'list_thinking_levels failed');
      return (resp.data ?? []) as string[];
    });
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
    return { defaultModel: settings.defaultModel ?? null, models, provider: providerId };
  });

  ipcMain.handle('sparkii:deleteChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      const state = await open.slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
      open.offEvents?.();
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
