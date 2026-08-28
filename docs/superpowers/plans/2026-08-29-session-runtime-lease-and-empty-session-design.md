# Session Runtime Lease and Empty Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让空会话不落库、不占线程，第一次 prompt 才创建 Pi session 并 acquire；所有自动释放统一走 `agent_settled -> 60s grace timer`。

**Architecture:** 主进程增加极薄 lease/timer 管理，移除 UI 对 `newChatSession` 的提前调用；首次 prompt 通过 `promptDraftSession` 原子创建并发送。Pi 生命周期事件继续作为唯一状态源。

**Tech Stack:** Electron Main、preload、React/Vitest、`@sparkii/agent-host`。

**Spec:** `docs/superpowers/specs/2026-08-29-session-runtime-lease-and-empty-session-design.md`

## Global Constraints

- 不引入新的第三方依赖。
- 保持 `sparkii:newChatSession` 兼容旧测试和潜在调用者，但新的 UI 路径不再使用它。
- `agent_settled` 是自动 release 的唯一触发点。
- 默认 idle release 为 60000 ms，后续可通过 settings 扩展。
- 所有新代码必须有测试；使用仓库已有 Vitest 结构。

---

### Task 1: 扩展 preload API 类型和实现

**Files:**
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`

**Interfaces:**
- Consumes: existing `SparkiiApi`。
- Produces: `DraftPromptContext`、`promptDraftSession`。

- [ ] **Step 1: Write the failing test**

在 `preload-api.test.ts` 的名字列表和调用测试中增加 `promptDraftSession`：

```ts
const names = [
  // 现有项...
  'promptDraftSession',
];
```

```ts
it('invokes promptDraftSession with profile, text, and context', () => {
  const calls: string[] = [];
  const ipc = {
    invoke: (channel: string, ...args: unknown[]) => {
      calls.push(channel, JSON.stringify(args));
      return Promise.resolve({ ok: true, sessionId: 's1' });
    },
    on: () => {},
    removeListener: () => {},
  };
  const api = buildApi(ipc as any);
  void api.promptDraftSession('general', 'hello', { model: null });
  expect(calls[0]).toBe('sparkii:promptDraftSession');
});
```

- [ ] **Step 2: Run test to verify it fails**

```text
Expect: promptDraftSession does not exist / type error.
```

- [ ] **Step 3: Add API types and implementation**

`api-types.ts`:

```ts
export interface DraftPromptContext {
  profileId: string;
  workspacePath?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
}
```

`SparkiiApi`:

```ts
promptDraftSession(
  profileId: string,
  text: string,
  context: DraftPromptContext,
): Promise<{ ok: boolean; sessionId: string; behavior: 'prompt' | 'steer' | 'followUp' }>;
```

`api.ts`:

```ts
promptDraftSession: (profileId, text, context) =>
  invoke('promptDraftSession', profileId, text, context) as Promise<{
    ok: boolean;
    sessionId: string;
    behavior: 'prompt' | 'steer' | 'followUp';
  }>,
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
feat(desktop): expose promptDraftSession preload API
```

---

### Task 2: 实现 `promptDraftSession` IPC

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `registerIpc(rt, getWindow, logger)`；现有 `newChatSession` 内部逻辑。
- Produces: handler `sparkii:promptDraftSession`。

- [ ] **Step 1: Write the failing test**

```ts
it('promptDraftSession creates a session and sends the first prompt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });

  const sent: any[] = [];
  const client = {
    onEvent: vi.fn(() => () => {}),
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'get_state') {
        return { success: true, data: { sessionId: 's-new', sessionFile: null } };
      }
      return { success: true };
    },
  };
  const rt = await makeRuntime({ dataDir, piAgentDir, client });
  (rt as any).chatSessions.create = vi.fn();

  const handlers = await registeredHandlers();
  const promptDraftSession = handlers.get('sparkii:promptDraftSession');
  const result = await promptDraftSession!(null, 'general', 'hello', {});

  expect(result).toMatchObject({ ok: true, sessionId: 's-new' });
  expect(sent).toContainEqual({ type: 'prompt', message: 'hello' });
  expect(rt.pool.acquire).toHaveBeenCalled();
  expect((rt as any).chatSessions.create).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement handler**

在 `registerIpc` 内复用 `newChatSession` 的创建步骤，但成功创建后立即发送 prompt。

关键辅助函数可先抽取为 `createCommittedSession(profileId, context)`，但本任务以最小修改为原则：

```ts
ipcMain.handle('sparkii:promptDraftSession', async (
  _e,
  profileId: string,
  text: string,
  context: { workspacePath?: string | null; model?: string | null; thinkingLevel?: string | null } = {},
) => {
  const now = new Date();
  const workspacePath = context.workspacePath ?? autoWorkspacePath(app.getPath('desktop'), now);
  const settings = await loadSettings(rt.dataDir);
  const rawMaxAgents = Number(settings.maxAgents ?? process.env.SPARKII_MAX_AGENTS ?? 4);
  const maxAgents = Number.isFinite(rawMaxAgents) && rawMaxAgents > 0 ? Math.floor(rawMaxAgents) : 4;
  rt.pool.setMaxAgents?.(maxAgents);
  if (rt.pool.activeCount() >= maxAgents && settings.queueEnabled === false) {
    throw new Error(`已达到最大并发会话数 ${maxAgents}，请先释放一个槽位`);
  }

  const target = context.model
    ? resolveSessionModel(settings, { model: context.model })
    : resolveSessionModel(settings, null);
  const thinkingLevel = context.thinkingLevel ?? resolveThinkingLevel(settings, null, target);
  const tempKey = `new:${randomUUID()}`;
  const slot = await rt.pool.acquire(tempKey, {
    saddle: buildProfileSaddle(rt.profileOf(profileId), anchorDir(tempKey), workspacePath, target ?? undefined, thinkingLevel),
    meta: {
      profileId,
      profileName: (rt.profileOf(profileId).profile as { manifest?: { displayName?: string } })?.manifest?.displayName ?? profileId,
      label: '新会话',
    },
  });

  let sessionId: string | undefined;
  try {
    const freshResp = await slot.client.send({ type: 'new_session' });
    if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
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
      model: context.model ?? null,
      thinkingLevel: context.thinkingLevel ?? null,
      piSessionFile: sessionFile ?? null,
    });

    if (target) {
      const apiKey = await rt.keyFor(target.provider);
      if (apiKey) {
        const keyResp = await slot.client.send({ type: 'set_api_key', provider: target.provider, apiKey });
        if (!keyResp.success) throw new Error(keyResp.error ?? 'set_api_key failed');
      }
      await selectModel(rt, 'chat', sessionId, `${target.provider}/${target.modelId}`);
    }

    const promptResp = await slot.client.send({ type: 'prompt', message: text });
    if (!promptResp.success) throw new Error(promptResp.error ?? 'prompt failed');
    return { ok: true, sessionId, behavior: 'prompt' as const };
  } catch (e) {
    if (sessionId) {
      openSessions.delete(sessionId);
      await rt.pool.release(sessionId);
      rt.chatSessions.delete(sessionId);
    } else {
      await rt.pool.release(tempKey);
    }
    throw e;
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
feat(desktop): add atomic promptDraftSession handler
```

---

### Task 3: 历史会话读取不再 acquire

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `openSessions`, `rt.pool.get`。
- Produces: `getChatState` 对无 lease session 返回默认 idle，不调用 `ensureOpenSession`。

- [ ] **Step 1: Write the failing test**

```ts
it('getChatState does not acquire when a session has no lease', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });

  const client = { send: async () => ({ success: true }) };
  const rt = await makeRuntime({
    dataDir,
    piAgentDir,
    client,
    chatSession: { profileId: 'general', model: null },
  });

  const handlers = await registeredHandlers();
  const getChatState = handlers.get('sparkii:getChatState');
  const result = await getChatState!(null, 's-missing');

  expect(result).toMatchObject({ streaming: false, steering: [], followUp: [] });
  expect(rt.pool.acquire).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Change `getChatState`**

把当前 `getChatState` 中 `const open = await ensureOpenSession(sessionId); pipeSessionEvents(...)` 改为：

```ts
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
pipeSessionEvents(sessionId, open);
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
fix(desktop): do not acquire a Pi slot for read-only chat state
```

---

### Task 4: `listChatSessions` 不再返回空会话

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `listPiSessions`, `rt.chatSessions.get`。
- Produces: only committed sessions with a Pi transcript.

- [ ] **Step 1: Write the failing test**

```ts
it('listChatSessions excludes empty sessions from the local store', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });

  const client = { send: async () => ({ success: true }) };
  const rt = await makeRuntime({ dataDir, piAgentDir, client });
  (rt.chatSessions as any).list = () => [{
    id: 'empty-1',
    profileId: 'general',
    workspaceKind: 'auto',
    workspacePath: 'C:/ws/empty',
    model: null,
    thinkingLevel: null,
    piSessionFile: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }];

  const handlers = await registeredHandlers();
  const listChatSessions = handlers.get('sparkii:listChatSessions');
  const result = await listChatSessions!(null, 'general');
  expect(result).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Remove stored empty fallback**

`listChatSessions` 只保留 `listPiSessions` 映射，不再把 `rt.chatSessions.list()` 合并进去。

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
fix(desktop): exclude empty sessions from history
```

---

### Task 5: 统一 `agent_settled` 60s 自动释放

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `openSessions`, `pipeSessionEvents`, `releaseSessionSlot` handler。
- Produces: `idleTimers` 和 `agent_settled` 释放路径。

- [ ] **Step 1: Write the failing test**

```ts
it('schedules idle release after agent_settled and releases after timeout', async () => {
  vi.useFakeTimers();
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });

  const events: Array<(e: any) => void> = [];
  const sent: any[] = [];
  const client = {
    onEvent: (cb: (event: any) => void) => {
      events.push(cb);
      return () => {};
    },
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'get_state') {
        return { success: true, data: { sessionId: 's1', sessionFile: '/tmp/s.json', isStreaming: false } };
      }
      return { success: true };
    },
  };
  const rt = await makeRuntime({ dataDir, piAgentDir, client, chatSession: { profileId: 'general', model: null } });

  const handlers = await registeredHandlers();
  const promptDraftSession = handlers.get('sparkii:promptDraftSession');
  await promptDraftSession!(null, 'general', 'hello', {});
  events[0]?.({ type: 'agent_settled' });

  expect(rt.pool.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(rt.pool.release).toHaveBeenCalledWith('s1');
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add timer maps and event handling**

在 `registerIpc` 内：

```ts
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  }, 60_000);
  idleTimers.set(sessionId, timer);
}
```

在 `pipeSessionEvents` 的 onEvent 回调中：

```ts
if (ev.type === 'agent_settled') {
  scheduleIdleRelease(sessionId);
} else {
  cancelIdleRelease(sessionId);
}
```

把 `releaseSessionSlot` handler 的主体提取为 `releaseSessionSlotInternal`，供 timer 复用；删除/手动释放时也 `cancelIdleRelease`。

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
feat(desktop): release Pi lease after agent_settled grace period
```

---

### Task 6: 前端空会话和首次 prompt

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`

**Interfaces:**
- Consumes: `promptDraftSession`。
- Produces: `GeneralChatSurface` 支持 `draft` 和 `onSessionCommitted`。

- [ ] **Step 1: Write the failing UI test**

```tsx
it('does not call newChatSession when creating an empty session', async () => {
  const { api } = makeApi();
  render(<App />);
  await screen.findByText(/工作台 · 上午好/);
  fireEvent.click(screen.getByTestId('agent-card-general'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  await screen.findByTestId('composer-input');
  expect(api.newChatSession).not.toHaveBeenCalled();
});
```

再添加首次 prompt 调用测试：

```tsx
it('sends the first draft prompt through promptDraftSession', async () => {
  const { api } = makeApi();
  api.promptDraftSession = vi.fn().mockResolvedValue({ ok: true, sessionId: 'g1' });
  render(<App />);
  await screen.findByText(/工作台 · 上午好/);
  fireEvent.click(screen.getByTestId('agent-card-general'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '你好' } });
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
  await waitFor(() => expect(api.promptDraftSession).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement UI changes**

`App.tsx`:

- `onNewSession('general')` 只设置 `screen='general'`、`activeGeneralSession=null`、`generalTitle=''`，不调用 API。
- `GeneralChatSurface` 增加：

```tsx
draft={screen === 'general' && activeGeneralSession === null}
onSessionCommitted={(sessionId) => {
  setActiveGeneralSession(sessionId);
  refreshSessions('general', sessionId);
}}
```

`GeneralChatSurface.tsx`:

- 增加 `draft?: boolean` 和 `onSessionCommitted?` props。
- 如果 `!sessionId && draft`，渲染 composer，不渲染空状态。
- `send` 在 draft 时调用：

```ts
const res = await api.promptDraftSession('general', prompt, {
  workspacePath,
  model,
  thinkingLevel,
});
onSessionCommitted?.(res.sessionId);
```

- `refreshModelOptions` 在 draft 时只加载模型和 provider，不调用 `refreshMeta`。
- `chooseWorkspace` 在 draft 时只设置本地 `workspacePath`。

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```text
feat(desktop): use UI draft mode and promptDraftSession for empty sessions
```

---

### Task 7: 全量验证与修复

**Files:**
- 所有已修改文件。

- [ ] **Step 1: Run targeted tests**

```text
node_modules\.bin\vitest.cmd run apps/desktop/test/ipc.test.ts apps/desktop/test/app-general.test.tsx apps/desktop/test/preload-api.test.ts
```

如果运行环境无法解析 `node`，使用运行时自带 Node：

```text
C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe node_modules\vitest\vitest.mjs run ...
```

- [ ] **Step 2: Run typecheck if available**

```text
pnpm --filter @sparkii/desktop typecheck
```

- [ ] **Step 3: Fix all failures**

- [ ] **Step 4: Commit final fixes**

```text
test(desktop): finalize session lifecycle tests and fixes
```

