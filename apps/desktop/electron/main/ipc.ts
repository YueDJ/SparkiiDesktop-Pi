import { ipcMain, dialog, app, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { listPiSessions, readPiSessionEntries, type PiProviderInfo, type SessionSaddle } from '@sparkii/agent-host';
import { applyThinkingLevel, createBroker, modelTargetKey, resolveModelTarget, resolveSessionModel, resolveThinkingLevel, runWorkflow, selectModel } from './workflow.js';
import { findCompatibleModels, type ModelCapability } from '@sparkii/model-router';
import { sortAgents } from './agent-catalog.js';
import { resolveExportPath } from './export-path.js';
import { loadSettings, saveSettings } from './settings.js';
import { buildProviderList } from './provider-catalog.js';
import { autoWorkspacePath, ensureWorkspaceDir } from './workspace.js';
import { buildAgentSaddle } from './saddle.js';
import { buildAttachmentPrompt, stageAttachments } from './attachments.js';
import { resizeImageForAttachment } from './image-resize.js';
import { writePiModelsConfig } from './pi-model-config.js';
import { probeProviderModels } from './provider-probe.js';
import { verifyRuntime } from './runtime-provision.js';
import { mutateQueues, type QueueMutation, type QueueSnapshot } from './queue-mutation.js';
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';
import type { ChatAttachment, ChooseDocumentOptions } from '../preload/api-types.js';
import { DEFAULT_CHOOSE_EXTENSIONS, grantDocumentPath, readGrantedDocumentBytes } from './document-bytes.js';

function parseSessionInputs(raw: string | null | undefined): { path: string; name?: string; missing?: boolean }[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return undefined;
    return arr.map((item) => {
      if (typeof item === 'string') return { path: item };
      const rec = (item ?? {}) as Record<string, unknown>;
      return {
        path: String(rec.path ?? ''),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
        missing: !existsSync(String(rec.path ?? '')),
      };
    });
  } catch {
    return undefined;
  }
}

function assistantText(message: unknown): string {
  const rec = (message ?? {}) as Record<string, unknown>;
  const content = rec.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = (block ?? {}) as Record<string, unknown>;
        return b.type === 'text' ? String(b.text ?? '') : '';
      })
      .join('');
  }
  return typeof rec.text === 'string' ? rec.text : '';
}

function lastAssistantOfBranch(entries: unknown[]): unknown | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = (entries[i] ?? {}) as Record<string, unknown>;
    if (String(entry.type) !== 'message') continue;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    if (message.role === 'assistant') return message;
  }
  return null;
}

function lastAssistantOfMessages(messages: unknown[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = (messages[i] ?? {}) as Record<string, unknown>;
    if (message.role === 'assistant') return message;
  }
  return null;
}

/**
 * `message_end` 先清空 `streamingMessage`，之后才 `appendMessage`。夹在中间打开会两边都没有
 * 这一句，此时它只在 `get_messages` 里。仅在这条微缝上补一次，不把 `get_messages` 当时间线。
 */
async function recoverInFlightAssistant(
  client: { send: (command: { type: 'get_messages' }) => Promise<{ success: boolean; data?: unknown }> },
  branch: unknown[],
): Promise<unknown | null> {
  const resp = await client.send({ type: 'get_messages' });
  if (!resp.success) return null;
  const candidate = lastAssistantOfMessages(Array.isArray(resp.data) ? resp.data : []);
  if (!candidate) return null;
  const committed = lastAssistantOfBranch(branch);
  if (committed && assistantText(committed) === assistantText(candidate)) return null;
  return candidate;
}

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null, logger: Logger) {
  const broker = createBroker(rt, getWindow);
  const win = getWindow();
  if (win) {
    win.on('maximize', () => {
      if (!win.isDestroyed()) win.webContents.send('sparkii:event:window-maximized', true);
    });
    win.on('unmaximize', () => {
      if (!win.isDestroyed()) win.webContents.send('sparkii:event:window-maximized', false);
    });
  }
  rt.pool.subscribe?.((snapshot) => {
    getWindow()?.webContents.send('sparkii:event:runtime-pool', snapshot);
  });
  const openSessions = new Map<
    string,
    { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string }
  >();
  /** 一根进程一根管子；键是 client（进程稳），不是每次 acquire 的新包装对象。 */
  const processPipes = new WeakMap<object, () => void>();
  const appliedModelBySession = new Map<string, { provider: string; modelId: string }>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightWorkflowRuns = new Set<string>();
  const sessionIdleReleaseMs = 60_000;

  const anchorDir = (sessionId: string) => join(rt.dataDir, 'sessions', sessionId);

  function cancelIdleRelease(sessionId: string): void {
    const timer = idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(sessionId);
    }
  }

  function scheduleIdleRelease(sessionId: string): void {
    cancelIdleRelease(sessionId);
    const timer = setTimeout(() => {
      idleTimers.delete(sessionId);
      void releaseSessionSlotInternal(sessionId).catch(() => {});
    }, sessionIdleReleaseMs);
    idleTimers.set(sessionId, timer);
  }

  function buildSaddle(profileId: string, sessionId: string): SessionSaddle {
    const rec = rt.chatSessions.get(sessionId);
    return buildAgentSaddle(rt.agentOf(profileId), anchorDir(sessionId), rec?.workspacePath);
  }

  async function withProbeSlot<T>(fn: (client: Awaited<ReturnType<typeof rt.pool.acquire>>['client']) => Promise<T>): Promise<T> {
    const key = `probe:${randomUUID()}`;
    const slot = await rt.pool.acquire(key, {
      meta: { profileId: 'internal', profileName: '内部探测', label: '内部探测', internal: true },
    });
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

const MODEL_CAPABILITY_DEFAULTS: Record<string, ModelCapability[]> = {
  'deepseek-v4-pro': ['chat', 'reasoning', 'longContext', 'toolCall', 'thinking'],
  'deepseek-v4-flash': ['chat', 'fast', 'toolCall'],
  'deepseek-vision': ['chat', 'vision'],
};

  const chatStateData = (data: unknown): {
    isStreaming?: boolean;
    streaming?: boolean;
    isCompacting?: boolean;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
    streamingMessage?: unknown;
  } => (data ?? {}) as {
    isStreaming?: boolean;
    streaming?: boolean;
    isCompacting?: boolean;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    sessionFile?: string;
    steering?: string[];
    followUp?: string[];
    streamingMessage?: unknown;
  };

  async function ensureOpenSession(sessionId: string): Promise<{
    slot: Awaited<ReturnType<typeof rt.pool.acquire>>;
    profileId: string;
  }> {
    let open = openSessions.get(sessionId);
    if (open) return open;

    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildSaddle(rec.profileId, sessionId),
      resumeSessionFile: rec.piSessionFile ?? undefined,
      meta: {
        profileId: rec.profileId,
        profileName: (rt.profileOf(rec.profileId).profile as { manifest?: { displayName?: string } })?.manifest?.displayName ?? rec.profileId,
        label: sessionId.slice(0, 8),
      },
    });
    open = { slot, profileId: rec.profileId };
    openSessions.set(sessionId, open);
    return open;
  }

  /**
   * 每个子进程只订一次事件与退出。出门时当场读池子里的活 `slot.sessionId` 盖章：牌子为空就不送窗口，
   * 进程借给下一条会话时同一根管子自动改盖新 id。
   */
  function ensureProcessPipe(slot: Awaited<ReturnType<typeof rt.pool.acquire>>): void {
    if (processPipes.has(slot.client)) return;
    const off = slot.client.onEvent((ev) => {
      const sessionId = slot.getSessionId();
      if (!sessionId) return;
      getWindow()?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
      if (ev.type === 'agent_settled' && !inFlightWorkflowRuns.has(sessionId)) {
        scheduleIdleRelease(sessionId);
      }
    });
    // 退出跟管子同一套去重：订多次会让一次崩溃打 N 行日志、卸 N 次。
    const offExit = slot.supervisor.onExit((code) => {
      const sessionId = slot.getSessionId();
      void logger.log({ level: 'error', msg: 'pi runtime exited', ctx: { sessionId, code } });
      if (!sessionId) return;
      // 子进程没了就问不到 sessionFile，也不去抢救 streamingMessage：JSONL 是唯一的账。
      cancelIdleRelease(sessionId);
      openSessions.delete(sessionId);
      appliedModelBySession.delete(sessionId);
      void unbindAndRelease(sessionId).catch(() => {});
    });
    processPipes.set(slot.client, () => { off(); offExit(); });
  }

  /** 解绑：先让窗口停转圈，再卸牌子（池子内部先 `sessionId = null` 才 `new_session`）。 */
  async function unbindAndRelease(sessionId: string): Promise<void> {
    getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_unbound', sessionId });
    await rt.pool.release(sessionId);
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

  async function openOrCreateSession(
    sessionId: string | null,
    context: { profileId?: string; workspacePath?: string | null; model?: string | null; thinkingLevel?: string | null },
  ): Promise<{ open: Awaited<ReturnType<typeof ensureOpenSession>>; sessionId: string; workspacePath: string | undefined }> {
    if (sessionId) {
      cancelIdleRelease(sessionId);
      const open = await ensureOpenSession(sessionId);
      ensureProcessPipe(open.slot);
      open.slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId: open.profileId }));
      const rec = rt.chatSessions.get(sessionId);
      const target = rec?.model
        ? resolveSessionModel(await loadSettings(rt.dataDir), rec)
        : resolveSessionModel(await loadSettings(rt.dataDir), null);
      if (target) {
        const applied = appliedModelBySession.get(sessionId);
        if (!applied || applied.provider !== target.provider || applied.modelId !== target.modelId) {
          await selectModel(rt, 'chat', sessionId, `${target.provider}/${target.modelId}`);
          appliedModelBySession.set(sessionId, target);
        }
        const settings = await loadSettings(rt.dataDir);
        await applyThinkingLevel(open.slot.client, resolveThinkingLevel(settings, rec, target));
      }
      return { open, sessionId, workspacePath: rec?.workspacePath };
    }

    const profileId = context.profileId;
    if (!profileId) throw new Error('profileId is required');
    const now = new Date();
    const workspacePath = context.workspacePath ?? autoWorkspacePath(app.getPath('desktop'), now);
    const settings = await loadSettings(rt.dataDir);
    const rawMaxAgents = Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4);
    const maxAgents = Number.isFinite(rawMaxAgents) && rawMaxAgents > 0 ? Math.floor(rawMaxAgents) : 4;
    rt.pool.setMaxAgents?.(maxAgents);
    if (rt.pool.activeCount() >= maxAgents && settings.queueEnabled === false) {
      throw new Error(`已达到最大并发会话数 ${maxAgents}，请先释放一个线程`);
    }

    const target = context.model
      ? resolveSessionModel(settings, { model: context.model })
      : resolveSessionModel(settings, null);
    const thinkingLevel = context.thinkingLevel ?? resolveThinkingLevel(settings, null, target);
    const tempKey = `new:${randomUUID()}`;
    const slot = await rt.pool.acquire(tempKey, {
      saddle: buildAgentSaddle(rt.agentOf(profileId), anchorDir(tempKey), workspacePath, target ?? undefined, thinkingLevel),
      meta: {
        profileId,
        profileName: (rt.profileOf(profileId).profile as { manifest?: { displayName?: string } })?.manifest?.displayName ?? profileId,
        label: '新会话',
      },
    });

    let createdSessionId: string | undefined;
    try {
      const freshResp = await slot.client.send({ type: 'new_session' });
      if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
      const state = await slot.client.send({ type: 'get_state' });
      if (!state.success) throw new Error(state.error ?? 'get_state failed');
      createdSessionId = (state.data as { sessionId?: string } | undefined)?.sessionId;
      const sessionFile = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
      if (!createdSessionId) throw new Error('runtime did not provide a session id');
      rt.pool.renameSession(tempKey, createdSessionId);
      const entry = { slot, profileId };
      openSessions.set(createdSessionId, entry);
      ensureProcessPipe(slot);
      slot.supervisor.onProposal((req) => broker.route(req, { sessionId: createdSessionId!, profileId }));
      await mkdir(anchorDir(createdSessionId), { recursive: true });
      rt.chatSessions.create({
        id: createdSessionId,
        profileId,
        workspaceKind: 'auto',
        workspacePath,
        model: target ? modelTargetKey(target) : null,
        thinkingLevel: context.thinkingLevel ?? null,
        piSessionFile: sessionFile ?? null,
      });
      if (target) {
        const apiKey = await rt.keyFor(target.provider);
        if (apiKey) {
          const keyResp = await slot.client.send({ type: 'set_api_key', provider: target.provider, apiKey });
          if (!keyResp.success) throw new Error(keyResp.error ?? 'set_api_key failed');
        }
      }
      return { open: entry, sessionId: createdSessionId, workspacePath };
    } catch (e) {
      if (createdSessionId) {
        openSessions.delete(createdSessionId);
        await rt.pool.release(createdSessionId);
        rt.chatSessions.delete(createdSessionId);
      } else {
        await rt.pool.release(tempKey);
      }
      throw e;
    }
  }

  ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      // 视口拿到 sessionId 后接上这根进程的 PIPE。runWorkflow onReady / promptSession
      // 通常已经订过；WeakMap 去重。切历史再回来也走这里，避免 live 口没接上。
      ensureProcessPipe(open.slot);
      // 进程还活着：起步 = getBranch() + streamingMessage。不读磁盘（首条 assistant 落盘前
      // 文件可能是空的，树上已有步骤行），也不用 get_messages 当时间线。
      const [entriesResp, stateResp] = await Promise.all([
        open.slot.client.send({ type: 'get_session_entries' }),
        open.slot.client.send({ type: 'get_state' }),
      ]);
      const rec = rt.chatSessions.get(sessionId);
      const entries = (entriesResp.data ?? []) as unknown[];
      const state = chatStateData(stateResp.data);
      const streaming = Boolean(state.isStreaming ?? state.streaming ?? false);
      const streamingMessage = state.streamingMessage
        ?? (streaming ? await recoverInFlightAssistant(open.slot.client, entries) : null);
      return {
        entries,
        streamingMessage: streamingMessage ?? null,
        streaming,
        inputs: parseSessionInputs(rec?.inputs),
      };
    }
    const rec = rt.chatSessions.get(sessionId) ?? (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
    if (!rec) throw new Error('session not found');
    const file = (rec as { piSessionFile?: string | null }).piSessionFile
      ?? (rec as { path?: string }).path;
    const dead = (entries: unknown[]) => ({
      entries,
      streamingMessage: null,
      streaming: false,
      inputs: parseSessionInputs((rec as { inputs?: string }).inputs),
    });
    if (!file) return dead([]);
    try {
      return dead(readPiSessionEntries(file));
    } catch (e) {
      // 空会话或尚未落盘的会话（首条 assistant 才写 jsonl）没有文件，返回空时间线。
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return dead([]);
      throw e;
    }
  });

  ipcMain.handle('sparkii:listChatSessions', async (_e, profileId?: string) => {
    const all = await listPiSessions(join(rt.piAgentDir, 'sessions'));
    const mapped = all.map((s) => {
      const rec = rt.chatSessions.get(s.id);
      return {
        id: s.id,
        title: s.name,
        firstMessage: s.firstMessage,
        profileId: rec?.profileId,
        updatedAt: s.modified.getTime(),
        piFile: s.path,
        pinned: rec?.pinned ?? false,
        archived: rec?.archived ?? false,
        sortOrder: rec?.sortOrder ?? null,
      };
    });
    return profileId ? mapped.filter((m) => m.profileId === profileId || m.profileId === undefined) : mapped;
  });
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);

  ipcMain.handle('sparkii:promptSession', async (
    _e,
    sessionId: string | null,
    text: string,
    options?: { behavior?: 'steer' | 'followUp' },
    attachments: ChatAttachment[] = [],
    context: { profileId?: string; workspacePath?: string | null; model?: string | null; thinkingLevel?: string | null } = {},
  ) => {
    const { open, sessionId: resolvedSessionId, workspacePath } = await openOrCreateSession(sessionId, context);

    const list = attachments ?? [];
    const isImage = (a: ChatAttachment) => (a.type ?? '').toLowerCase().startsWith('image/')
      && (a.type ?? '').toLowerCase() !== 'image/svg+xml';
    const imageAtts = list.filter(isImage);
    const fileAtts = list.filter((a) => !isImage(a));

    if (fileAtts.length && !workspacePath) {
      throw new Error('会话缺少工作区，无法放置附件');
    }
    const staged = workspacePath ? await stageAttachments(workspacePath, fileAtts) : [];
    const finalText = buildAttachmentPrompt(text, staged);

    const images = await Promise.all(imageAtts.map(async (att) => {
      const resized = resizeImageForAttachment(att.path, att.type ?? '');
      const buffer = resized ? resized.buffer : await readFile(att.path);
      return {
        type: 'image' as const,
        mimeType: resized ? resized.mimeType : (att.type || 'image/png'),
        data: buffer.toString('base64'),
      };
    }));

    const stateResp = await open.slot.client.send({ type: 'get_state' });
    if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
    const state = chatStateData(stateResp.data);
    const isStreaming = state.isStreaming ?? state.streaming ?? false;
    const behavior = options?.behavior ?? (isStreaming ? 'followUp' : 'prompt');

    if (behavior === 'steer') {
      const resp = await open.slot.client.send(images.length
        ? { type: 'steer', message: finalText, images }
        : { type: 'steer', message: finalText });
      if (!resp.success) throw new Error(resp.error ?? 'steer failed');
    } else if (behavior === 'followUp') {
      const resp = await open.slot.client.send(images.length
        ? { type: 'follow_up', message: finalText, images }
        : { type: 'follow_up', message: finalText });
      if (!resp.success) throw new Error(resp.error ?? 'follow_up failed');
    } else {
      const resp = await open.slot.client.send(images.length
        ? { type: 'prompt', message: finalText, images }
        : { type: 'prompt', message: finalText });
      if (!resp.success) throw new Error(resp.error ?? 'prompt failed');
    }

    const after = await open.slot.client.send({ type: 'get_state' });
    if ((after.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(resolvedSessionId, {
        piSessionFile: (after.data as { sessionFile: string }).sessionFile,
      });
    }
    return { ok: true, sessionId: resolvedSessionId, behavior: behavior === 'prompt' ? 'prompt' : behavior };
  });

  ipcMain.handle('sparkii:abortChat', async (_e, sessionId: string) => {
    const open = await ensureOpenSession(sessionId);
    ensureProcessPipe(open.slot);
    const cleared = await readQueues(open);

    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    const abortResp = await open.slot.client.send({ type: 'abort' });
    if (!abortResp.success) throw new Error(abortResp.error ?? 'abort failed');
    await waitForIdle(open.slot.client);
    return { ok: true, cleared };
  });

  ipcMain.handle('sparkii:getChatState', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) {
      return {
        streaming: false,
        steering: [],
        followUp: [],
        isCompacting: false,
        contextUsage: null,
      };
    }
    ensureProcessPipe(open.slot);
    const resp = await open.slot.client.send({ type: 'get_state' });
    if (!resp.success) throw new Error(resp.error ?? 'get_state failed');
    const data = chatStateData(resp.data);
    return {
      streaming: data.isStreaming ?? data.streaming ?? false,
      steering: data.steering ?? [],
      followUp: data.followUp ?? [],
      isCompacting: data.isCompacting ?? false,
      contextUsage: data.contextUsage ?? null,
    };
  });

  ipcMain.handle('sparkii:queueMutate', async (_e, sessionId: string, mutation: QueueMutation) => {
    const open = await ensureOpenSession(sessionId);
    ensureProcessPipe(open.slot);
    const snapshot = await readQueues(open);
    const next = mutateQueues(snapshot, mutation);

    const clearResp = await open.slot.client.send({ type: 'clear_queue' });
    if (!clearResp.success) throw new Error(clearResp.error ?? 'clear_queue failed');
    await rebuildQueues(open.slot.client, next);
    return { ok: true, steering: next.steering, followUp: next.followUp };
  });

  ipcMain.handle('sparkii:setChatTitle', (_e, sessionId: string, title: string, source?: 'user' | 'agent') => {
    const trimmed = String(title ?? '').trim();
    if (!trimmed) return { ok: false };
    const origin = source === 'user' ? 'user' : 'agent';
    const rec = rt.chatSessions.get(sessionId);
    if (origin === 'agent' && rec?.titleLockedByUser) return { ok: false, reason: 'locked' };
    if (origin === 'user' && rec) {
      rt.chatSessions.update(sessionId, { titleLockedByUser: true });
    }
    getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_title', sessionId, title: trimmed });
    const open = openSessions.get(sessionId);
    if (!open) {
      if (rec) {
        void rt.pool.acquire(sessionId, {
          saddle: buildSaddle(rec.profileId, sessionId),
          resumeSessionFile: rec.piSessionFile ?? undefined,
        }).then((slot) => {
          openSessions.set(sessionId, { slot, profileId: rec.profileId });
          return slot.client.send({ type: 'set_session_name', name: trimmed });
        }).catch(() => {});
        return { ok: true };
      }
    }
    if (open) void open.slot.client.send({ type: 'set_session_name', name: trimmed }).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('sparkii:completeText', async (_e, sessionId: string, text: string) => {
    const open = await ensureOpenSession(sessionId);
    const settings = await loadSettings(rt.dataDir);
    const target = resolveModelTarget(settings, 'title') ?? resolveModelTarget(settings, 'default');
    if (!target) return { ok: false };
    const resp = await open.slot.client.send({
      type: 'complete',
      provider: target.provider,
      modelId: target.modelId,
      text: String(text ?? ''),
    });
    if (!resp.success) return { ok: false };
    const out = String(resp.data ?? '').trim();
    return out ? { ok: true, text: out } : { ok: false };
  });

  ipcMain.handle('sparkii:setChatModel', async (_e, sessionId: string, model: string | null) => {
    const open = openSessions.get(sessionId);
    const settings = await loadSettings(rt.dataDir);
    const target = resolveSessionModel(settings, { model });
    if (open) {
      ensureProcessPipe(open.slot);
      if (target) {
        const applied = appliedModelBySession.get(sessionId);
        const changed = !applied || applied.provider !== target.provider || applied.modelId !== target.modelId;
        if (changed) {
          await selectModel(rt, 'chat', sessionId, `${target.provider}/${target.modelId}`);
          appliedModelBySession.set(sessionId, target);
          getWindow()?.webContents.send('sparkii:event:chat-event', {
            type: 'model_change',
            sessionId,
            provider: target.provider,
            modelId: target.modelId,
          });
        }
      }
    }
    rt.chatSessions.update(sessionId, { model: target ? modelTargetKey(target) : null });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatThinkingLevel', async (_e, sessionId: string, level: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    rt.chatSessions.update(sessionId, { thinkingLevel: level });
    const open = openSessions.get(sessionId);
    if (open && level) {
      ensureProcessPipe(open.slot);
      const resp = await open.slot.client.send({ type: 'set_thinking_level', level });
      if (!resp.success) throw new Error(resp.error ?? 'set_thinking_level failed');
    }
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

  ipcMain.handle('sparkii:updateWorkflowState', async (_e, sessionId: string, entry: Record<string, unknown>) => {
    const open = await ensureOpenSession(sessionId);
    ensureProcessPipe(open.slot);
    const resp = await open.slot.client.send({
      type: 'append_workflow_entry',
      customType: 'workflow_state',
      data: entry,
    });
    if (!resp.success) throw new Error(resp.error ?? 'append workflow_state failed');
    if (!inFlightWorkflowRuns.has(sessionId)) scheduleIdleRelease(sessionId);
    return { ok: true };
  });

  ipcMain.handle('sparkii:requestExportReport', async (_e, sessionId: string, summary: Record<string, unknown>) => {
    const open = await ensureOpenSession(sessionId);
    ensureProcessPipe(open.slot);
    const d = await broker.route({
      requestId: randomUUID(),
      toolName: 'report.export',
      targetSystem: 'report',
      summary: `导出合同审核报告：${String(summary?.title ?? '')}`,
      payload: summary,
      risk: 'write',
    }, { sessionId, profileId: open.profileId });
    if (d.approved && open.slot.client) {
      await open.slot.client.send({
        type: 'append_workflow_entry',
        customType: 'workflow_state',
        data: { stepId: 'report', action: 'report_exported', at: new Date().toISOString(), ...summary },
      }).catch(() => {});
    }
    if (!inFlightWorkflowRuns.has(sessionId)) scheduleIdleRelease(sessionId);
    return { ok: true, approved: d.approved };
  });

  ipcMain.handle('sparkii:chooseWorkspace', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? {} : { path: result.filePaths[0] };
  });

  ipcMain.handle('sparkii:getModelOptions', async (_e, agentId?: string) => {
    const settings = await loadSettings(rt.dataDir);
    const providerId = settings.activeProviderId ?? 'deepseek';
    const modelEntries = await withProbeSlot(async (client) => {
      await injectProbeKey(client, providerId);
      const resp = await client.send({ type: 'list_models', provider: providerId });
      if (!resp.success) return [] as Array<{ modelId: string; supportsImages?: boolean }>;
      return (resp.data ?? []) as Array<{ modelId: string; supportsImages?: boolean }>;
    }).catch(() => [] as Array<{ modelId: string; supportsImages?: boolean }>);
    const models = modelEntries.map((m) => m.modelId);
    const supportsImages: Record<string, boolean> = {};
    for (const m of modelEntries) supportsImages[m.modelId] = m.supportsImages ?? false;
    const requirements = agentId
      ? (rt.agentOf(agentId).manifest.modelRequirements ?? { requires: ['chat'] })
      : { requires: ['chat'] };
    const descriptors = modelEntries.map((m) => ({
      provider: providerId,
      modelId: m.modelId,
      capabilities: MODEL_CAPABILITY_DEFAULTS[m.modelId]
        ?? (m.supportsImages ? ['chat', 'vision'] : ['chat', 'toolCall']) as ModelCapability[],
    }));
    const compatible = findCompatibleModels(descriptors, requirements);
    const compatibleSet = new Set(compatible.map((m) => m.modelId));
    return {
      defaultModel: settings.defaultModel ?? null,
      models,
      provider: providerId,
      supportsImages,
      modelRequirements: requirements,
      compatibleModels: models.filter((modelId) => compatibleSet.has(modelId)),
      incompatibleModels: models.filter((modelId) => !compatibleSet.has(modelId)),
    };
  });

  ipcMain.handle('sparkii:deleteChatSession', async (_e, sessionId: string) => {
    cancelIdleRelease(sessionId);
    const open = openSessions.get(sessionId);
    if (open) {
      const state = await open.slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
      await unbindAndRelease(sessionId);
      openSessions.delete(sessionId);
      appliedModelBySession.delete(sessionId);
    }
    rt.chatSessions.delete(sessionId);
    // 同步删除 Pi 会话文件，避免“已删除会话”仍出现在历史列表中
    try {
      const found = (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
      if (found) await rm(found.path, { force: true });
    } catch { /* ignore */ }
    return { ok: true };
  });

  async function ensureSessionRecord(sessionId: string, profileId?: string) {
    if (rt.chatSessions.get(sessionId)) return;
    if (!profileId) return;
    const found = (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
    if (!found) return;
    rt.chatSessions.create({ id: sessionId, profileId, workspaceKind: 'auto', workspacePath: found.cwd });
  }

  ipcMain.handle('sparkii:setSessionPinned', async (_e, sessionId: string, pinned: boolean, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    rt.chatSessions.update(sessionId, { pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setSessionArchived', async (_e, sessionId: string, archived: boolean, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    rt.chatSessions.update(sessionId, { archived: !!archived });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setSessionOrder', async (_e, sessionId: string, sortOrder: number | null, profileId?: string) => {
    await ensureSessionRecord(sessionId, profileId);
    if (!rt.chatSessions.get(sessionId)) return { ok: true };
    rt.chatSessions.update(sessionId, { sortOrder: sortOrder });
    return { ok: true };
  });

  ipcMain.handle('sparkii:getRuntimePool', () => rt.pool.snapshot());

  ipcMain.handle('sparkii:cancelQueuedSession', (_e, queueId: string) => {
    if (!rt.pool.cancelPending(queueId)) throw new Error('queue item not found');
    return { ok: true };
  });

  async function releaseSessionSlotInternal(sessionId: string): Promise<void> {
    if (!rt.pool.get(sessionId)) throw new Error('session is not occupying a runtime slot');
    cancelIdleRelease(sessionId);
    const open = openSessions.get(sessionId);
    if (open) {
      const state = await open.slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, {
          piSessionFile: (state.data as { sessionFile: string }).sessionFile,
        });
      }
      await unbindAndRelease(sessionId);
      openSessions.delete(sessionId);
      appliedModelBySession.delete(sessionId);
    } else {
      await unbindAndRelease(sessionId);
    }
  }

  ipcMain.handle('sparkii:releaseSessionSlot', async (_e, sessionId: string) => {
    await releaseSessionSlotInternal(sessionId);
    return { ok: true };
  });

  ipcMain.handle('sparkii:getLocalSubject', () => ({
    userId: rt.subject.userId,
    roles: rt.subject.roles,
  }));
  ipcMain.handle('sparkii:listAgents', () =>
    sortAgents([...rt.profiles.values()].map((pr) => ({
      id: pr.profile.manifest.name,
      name: pr.profile.manifest.name,
      displayName: pr.profile.manifest.displayName,
      sortOrder: pr.profile.manifest.sortOrder,
      surfaceType: rt.agentOf(pr.profile.manifest.name).manifest.surface.type,
    }))),
  );
  ipcMain.handle('sparkii:chooseDocument', async (_e, opts?: ChooseDocumentOptions) => {
    if (process.env.SPARKII_E2E_DOCUMENT) {
      grantDocumentPath(process.env.SPARKII_E2E_DOCUMENT);
      return { path: process.env.SPARKII_E2E_DOCUMENT };
    }
    const extensions = Array.isArray(opts?.extensions) && opts.extensions.length
      ? opts.extensions.map((ext) => ext.replace(/^\./, '').toLowerCase())
      : [...DEFAULT_CHOOSE_EXTENSIONS];
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '文档', extensions }] })
      : { canceled: true, filePaths: [] as string[] };
    if (result.canceled || !result.filePaths[0]) return {};
    grantDocumentPath(result.filePaths[0]);
    return { path: result.filePaths[0] };
  });
  ipcMain.handle('sparkii:readDocumentBytes', async (_e, path: string, sessionId?: string | null) => {
    const rec = sessionId ? rt.chatSessions.get(sessionId) : null;
    return readGrantedDocumentBytes(String(path ?? ''), {
      inputs: parseSessionInputs(rec?.inputs),
      workspacePath: rec?.workspacePath ?? null,
    });
  });
  ipcMain.handle('sparkii:listPendingApprovals', () => rt.gate.listPending());
  ipcMain.handle('sparkii:decideApproval', async (_e, id: string, approved: boolean, note?: string) => {
    let out = await rt.gate.decide(id, rt.subject, approved, note);
    let result: unknown;
    if (out.status === 'approved' && out.toolName !== 'workflow.approval') {
      if (out.toolName === 'report.export') {
        const payload = (out.payload ?? {}) as Record<string, unknown>;
        const suggested = typeof payload.path === 'string' && payload.path.trim() ? payload.path : undefined;
        const path = suggested ?? await resolveExportPath(getWindow, process.env, (win, opts) =>
          dialog.showSaveDialog(win as BrowserWindow, opts),
        );
        if (path) {
          out.payload = { ...payload, path };
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
    if (rest.logLevel) logger.level = rest.logLevel;
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
    const profileId = [...rt.profiles.keys()][0];
    if (!profileId) throw new Error('no profiles installed');
    const sessionId = randomUUID();
    const slot = await rt.pool.acquire(sessionId, {
      saddle: buildAgentSaddle(rt.agentOf(profileId), anchorDir(sessionId)),
    });
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId }));
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
  ipcMain.handle('sparkii:runWorkflow', async (_e, profileId: string, input: Record<string, unknown>) => {
    const requestedWorkspace = typeof input.workspacePath === 'string' && input.workspacePath.trim()
      ? input.workspacePath
      : undefined;
    const workspacePath = requestedWorkspace ?? autoWorkspacePath(app.getPath('desktop'), new Date());
    await ensureWorkspaceDir(workspacePath);
    const sessionId = await runWorkflow(rt, getWindow, {
      ...input,
      workspacePath,
      workspaceKind: requestedWorkspace ? 'user' : 'auto',
    }, broker, profileId, {
      onReady(id, slot) {
        inFlightWorkflowRuns.add(id);
        const entry = { slot, profileId };
        openSessions.set(id, entry);
        ensureProcessPipe(slot);
      },
      logger,
      async beforeRelease(id) {
        // workflow 跑完由 workflow.ts 调 pool.release；这里先让窗口停转圈，管子留给下一条会话。
        inFlightWorkflowRuns.delete(id);
        if (!openSessions.has(id)) return;
        getWindow()?.webContents.send('sparkii:event:chat-event', { type: 'session_unbound', sessionId: id });
        openSessions.delete(id);
      },
    });
    return { ok: true, sessionId };
  });
  ipcMain.handle('sparkii:diagnostics', async () => ({
    logs: await logger.export(),
    audit: await rt.audit.exportJsonl(),
    runtime: await verifyRuntime(process.env),
  }));
  ipcMain.handle('sparkii:listErrors', () => rt.errors.list());
  ipcMain.handle('sparkii:appendError', (_e, rec: { id: string; message: string; source: string; createdAt: number }) => rt.errors.append(rec));
  ipcMain.handle('sparkii:clearError', (_e, id: string) => { rt.errors.clearOne(id); return { ok: true }; });
  ipcMain.handle('sparkii:clearErrors', () => { rt.errors.clear(); return { ok: true }; });
  ipcMain.handle('sparkii:markAllErrorsRead', () => { rt.errors.markAllRead(); return { ok: true }; });

  ipcMain.handle('sparkii:windowMinimize', () => {
    getWindow()?.minimize();
    return true;
  });
  ipcMain.handle('sparkii:windowToggleMaximize', () => {
    const window = getWindow();
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle('sparkii:windowClose', () => {
    getWindow()?.close();
    return true;
  });
  ipcMain.handle('sparkii:windowIsMaximized', () => getWindow()?.isMaximized() ?? false);
}
