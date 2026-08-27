# 思考强度（Thinking Level / Reasoning Effort）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让通用聊天会话支持“思考强度”档位选择，并把全局默认、每模型记忆、会话覆盖三层优先级贯穿到 Pi SDK 的 `AgentSession.setThinkingLevel`。

**Architecture:** Pi SDK 已暴露 `AgentSession.setThinkingLevel()` / `getAvailableThinkingLevels()`。我们在 agent-host 的 RPC 层新增 `set_thinking_level` / `list_thinking_levels` / `get_thinking_level`，在主进程把档位像 `model` 一样存进 `chat_sessions`，并把“全局默认 + 每模型记忆 + 会话覆盖”解析成最终档位后，在每次 `prompt` 前 apply。

**Tech Stack:** Electron + React/TS + Vitest；`@earendil-works/pi-coding-agent`（`^0.84.3`，`ThinkingLevel` 阶梯 = `off/minimal/low/medium/high/xhigh/max`，默认 `medium`）、`@sparkii/agent-host`、better-sqlite3。

**Spec:** 本次需求无独立 spec 文件；决策依据为 Pi SDK 0.84.3 的公开 API（`AgentSession.setThinkingLevel(level, { persist? })`、`getAvailableThinkingLevels()`、`THINKING_LEVEL_OPTIONS`）与仓库既有模型选择链路（`chat_sessions.model`）。

## Global Constraints

- Node >=22、pnpm >=9；全部包 ESM，相对导入带 `.js` 后缀。
- 测试用 vitest：`packages` 用 forks 池，`apps` 用 jsdom；从仓库根运行 `npx vitest run <相对路径>`。
- 提交信息前缀：feat / fix / refactor / test / docs / style / chore；每个任务一次提交。
- UI 文案简体中文。
- 档位词汇只用 Pi 抽象阶梯 `off/minimal/low/medium/high/xhigh/max`，前端不感知服务商原生参数。
- 空档位 `null` = 不调用 `setThinkingLevel`，保持现有行为（跟随 SDK 默认 `medium`），不得改变既有会话的默认行为。

---

## 范围裁定（Scope Ruling）

- 落地 #1 会话级档位、#2 全局默认、#3 每模型记忆。
- **#4（自定义 provider 的 thinking 协议映射）延后**：Pi 的 `thinkingFormat` / `thinkingLevelMap` 是 `models.json` 的**模型级**字段，本项目当前对自定义 provider 只写 `{ baseUrl, api }` 并让 SDK 联网发现模型，尚未作者模型级 override；强行在 provider 级写这些字段会被 schema 忽略。该能力需要单独的“模型级 override 作者”功能，本期不做。

---

### Task 1: agent-host 暴露 thinking-level RPC

**Files:**
- Modify: `packages/agent-host/src/types.ts:18-35`
- Modify: `packages/agent-host/src/pi-runtime.ts:5-27, 85-140`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts:136-200`
- Test: `packages/agent-host/test/pi-runtime.test.ts`

**Interfaces:**
- Produces:
  - `RpcCommand` 增加 `{ type: 'set_thinking_level'; level: string }`、`{ type: 'get_thinking_level' }`、`{ type: 'list_thinking_levels' }`。
  - `PiRuntimeSession` 增加 `setThinkingLevel(level: string): void`、`getThinkingLevel(): string`、`getAvailableThinkingLevels(): string[]`。
  - `adaptSession()` 返回对象增加同名方法，透传到 `session.setThinkingLevel(level)` / `session.thinkingLevel` / `session.getAvailableThinkingLevels()`。

- [ ] **Step 1: Write the failing test**

`packages/agent-host/test/pi-runtime.test.ts` 的 `fakeSession()` 增加：

```ts
setThinkingLevel: vi.fn(),
getThinkingLevel: vi.fn(() => "medium"),
getAvailableThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
```

并在 `describe("createPiRuntime")` 内新增：

```ts
it("routes thinking level commands to the session", async () => {
  const session = fakeSession();
  const host: PiRuntimeSessionHost = {
    current: () => session,
    newSession: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    configureSaddle: vi.fn(async () => {}),
  };
  const sent: PiRuntimeEnvelope[] = [];
  const transport = {
    postMessage: (env: PiRuntimeEnvelope) => sent.push(env),
    onMessage: (cb: (env: PiRuntimeEnvelope) => void) => {
      transport.emit = cb;
      return () => {};
    },
    emit: (_env: PiRuntimeEnvelope) => {},
  };
  createPiRuntime({ host, transport });

  transport.emit(commandEnvelope("t1", { type: "set_thinking_level", level: "high" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.setThinkingLevel).toHaveBeenCalledWith("high");

  transport.emit(commandEnvelope("t2", { type: "get_thinking_level" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toContainEqual(responseEnvelope("t2", {
    id: "t2", type: "response", command: "get_thinking_level", success: true, data: "medium",
  }));

  transport.emit(commandEnvelope("t3", { type: "list_thinking_levels" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toContainEqual(responseEnvelope("t3", {
    id: "t3", type: "response", command: "list_thinking_levels", success: true,
    data: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: FAIL（`set_thinking_level` 未处理，走 default 分支抛错）

- [ ] **Step 3: Write minimal implementation**

`types.ts` 的 `RpcCommand` union 增加：

```ts
| { type: 'set_thinking_level'; level: string }
| { type: 'get_thinking_level' }
| { type: 'list_thinking_levels' }
```

`pi-runtime.ts` 的 `PiRuntimeSession` 接口增加：

```ts
setThinkingLevel(level: string): void;
getThinkingLevel(): string;
getAvailableThinkingLevels(): string[];
```

`handleCommand` 的 switch 增加：

```ts
case "set_thinking_level":
  session.setThinkingLevel(command.level);
  return undefined;
case "get_thinking_level":
  return session.getThinkingLevel();
case "list_thinking_levels":
  return session.getAvailableThinkingLevels();
```

`pi-sdk-runtime.ts` 的 `adaptSession()` 返回对象内、`setModel` 附近增加：

```ts
setThinkingLevel: (level) => {
  session.setThinkingLevel(level);
},
getThinkingLevel: () => session.thinkingLevel,
getAvailableThinkingLevels: () => session.getAvailableThinkingLevels(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-runtime.test.ts
git commit -m "feat(agent-host): expose thinking level rpc commands"
```

---

### Task 2: settings 增加 defaultThinkingLevel 与 modelThinkingLevels

**Files:**
- Modify: `apps/desktop/electron/main/settings.ts:5-13`
- Test: `apps/desktop/test/settings-store.test.ts`

**Interfaces:**
- Produces: `AppSettings` 增加 `defaultThinkingLevel?: string`、`modelThinkingLevels?: Record<string, string>`。

- [ ] **Step 1: Write the failing test**

`settings-store.test.ts` 增加：

```ts
it('roundtrips thinking level defaults', async () => {
  const d = await makeDir();
  await saveSettings(d, {
    defaultThinkingLevel: 'high',
    modelThinkingLevels: { 'deepseek/deepseek-v4-pro': 'max' },
  });
  const loaded = await loadSettings(d);
  expect(loaded.defaultThinkingLevel).toBe('high');
  expect(loaded.modelThinkingLevels).toEqual({ 'deepseek/deepseek-v4-pro': 'max' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: FAIL（当前 test 文件没有该用例，新增后因类型/断言会先失败或由新用例跑失败——若 `loadSettings` 已返回原样对象，此断言实际会通过，故改为断言类型字段存在并已保存）

> 注：`loadSettings`/`saveSettings` 是泛型 JSON 透传，新增字段无需改实现；本任务的“失败”体现在新增用例首次运行不存在。若发现该用例直接通过，说明 JSON 透传已覆盖，可跳过实现步骤直接提交（保留用例作为回归保护）。

- [ ] **Step 3: Write minimal implementation**

`settings.ts` 的 `AppSettings` 增加两字段：

```ts
defaultThinkingLevel?: string;
modelThinkingLevels?: Record<string, string>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/settings.ts apps/desktop/test/settings-store.test.ts
git commit -m "feat(desktop): persist thinking level defaults"
```

---

### Task 3: chat_sessions 增加 thinkingLevel 列

**Files:**
- Modify: `apps/desktop/electron/main/chat-session-store.ts`
- Test: `apps/desktop/test/chat-session-store.test.ts`

**Interfaces:**
- Produces: `ChatSessionRecord.thinkingLevel: string | null`；`create`/`update` 接受 `thinkingLevel`；`list`/`get` 返回该字段。

- [ ] **Step 1: Write the failing test**

`chat-session-store.test.ts` 增加：

```ts
it('stores and updates the thinking level', () => {
  const s = store();
  s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a', thinkingLevel: 'high' });
  expect(s.get('pi-1')).toMatchObject({ thinkingLevel: 'high' });
  s.update('pi-1', { thinkingLevel: null });
  expect(s.get('pi-1')).toMatchObject({ thinkingLevel: null });
  s.close();
});
```

并在已有 legacy 迁移用例里追加断言：

```ts
expect(cols.some((c) => c.name === 'thinking_level')).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/chat-session-store.test.ts`
Expected: FAIL（`thinkingLevel` 未被写入/读取）

- [ ] **Step 3: Write minimal implementation**

`chat-session-store.ts`：

1. `ChatSessionRecord` 增加 `thinkingLevel: string | null;`。
2. `CREATE TABLE` 增加 `thinking_level TEXT,`。
3. `create` 的 row 与 INSERT 增加 `thinkingLevel: rec.thinkingLevel ?? null` 与 `thinking_level` 列。
4. `list`/`get` 的 SELECT 增加 `thinking_level AS thinkingLevel`。
5. `update` 的 patch 类型增加 `'thinkingLevel'`，UPDATE 增加 `thinking_level=@thinkingLevel`。
6. 在既有 `title` 迁移后，追加：若 `table_info` 无 `thinking_level`，执行 `ALTER TABLE chat_sessions ADD COLUMN thinking_level TEXT`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/chat-session-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/chat-session-store.ts apps/desktop/test/chat-session-store.test.ts
git commit -m "feat(desktop): store thinking level per chat session"
```

---

### Task 4: workflow 层解析/应用思考强度

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts:70-121`
- Test: `apps/desktop/test/thinking-level.test.ts`（新建）

**Interfaces:**
- Consumes: `AppSettings`（Task 2）、`ChatSessionRecord` 的 `model`/`thinkingLevel`（Task 3）。
- Produces:
  - `resolveSessionModel(settings, rec): { provider: string; modelId: string } | null`
  - `resolveThinkingLevel(settings, rec, target): string | null`
  - `applyThinkingLevel(client, level): Promise<void>`
  - `selectModel(...)` 返回值改为 `Promise<{ provider: string; modelId: string } | null>`

- [ ] **Step 1: Write the failing test**

新建 `apps/desktop/test/thinking-level.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { resolveSessionModel, resolveThinkingLevel } from '../electron/main/workflow.js';

describe('resolveSessionModel', () => {
  it('prefers an explicit model and splits provider/modelId', () => {
    expect(resolveSessionModel({ activeProviderId: 'deepseek' }, { model: 'zai/glm-5' }))
      .toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
  it('uses the active provider for a bare model id', () => {
    expect(resolveSessionModel({ activeProviderId: 'zai' }, { model: 'glm-5' }))
      .toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
  it('falls back to chat route when no model is set', () => {
    expect(resolveSessionModel(
      { activeProviderId: 'zai', defaultModel: 'glm-5' },
      { model: null },
    )).toEqual({ provider: 'zai', modelId: 'glm-5' });
  });
});

describe('resolveThinkingLevel', () => {
  const target = { provider: 'deepseek', modelId: 'deepseek-v4-pro' };
  it('prefers the session override', () => {
    expect(resolveThinkingLevel(
      { defaultThinkingLevel: 'low', modelThinkingLevels: { 'deepseek/deepseek-v4-pro': 'high' } },
      { thinkingLevel: 'max' },
      target,
    )).toBe('max');
  });
  it('falls back to per-model memory', () => {
    expect(resolveThinkingLevel(
      { defaultThinkingLevel: 'low', modelThinkingLevels: { 'deepseek/deepseek-v4-pro': 'high' } },
      { thinkingLevel: null },
      target,
    )).toBe('high');
  });
  it('falls back to global default then null', () => {
    expect(resolveThinkingLevel({ defaultThinkingLevel: 'low' }, { thinkingLevel: null }, target)).toBe('low');
    expect(resolveThinkingLevel({}, { thinkingLevel: null }, target)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/thinking-level.test.ts`
Expected: FAIL（`resolveSessionModel`/`resolveThinkingLevel` 未导出）

- [ ] **Step 3: Write minimal implementation**

`workflow.ts` 在 `resolveModelTarget` 之后增加：

```ts
export function resolveSessionModel(
  settings: AppSettings,
  rec: { model: string | null } | null | undefined,
): { provider: string; modelId: string } | null {
  const provider = settings.activeProviderId ?? 'deepseek';
  if (rec?.model) {
    const slash = rec.model.indexOf('/');
    return slash >= 0
      ? { provider: rec.model.slice(0, slash), modelId: rec.model.slice(slash + 1) }
      : { provider, modelId: rec.model };
  }
  return resolveModelTarget(settings, 'chat');
}

export function resolveThinkingLevel(
  settings: AppSettings,
  rec: { thinkingLevel: string | null } | null | undefined,
  target: { provider: string; modelId: string } | null,
): string | null {
  if (rec?.thinkingLevel) return rec.thinkingLevel;
  if (target) {
    const remembered = settings.modelThinkingLevels?.[`${target.provider}/${target.modelId}`];
    if (remembered) return remembered;
  }
  return settings.defaultThinkingLevel ?? null;
}

export async function applyThinkingLevel(
  client: { send: (command: unknown) => Promise<{ success: boolean; error?: string }> },
  level: string | null,
): Promise<void> {
  if (!level) return;
  const resp = await client.send({ type: 'set_thinking_level', level });
  if (!resp.success) throw new Error(`cannot set thinking level ${level}: ${resp.error ?? 'unknown'}`);
}
```

将 `selectModel` 的签名改为返回 `Promise<{ provider: string; modelId: string } | null>`，并在成功路径末尾 `return { provider, modelId };`，无 target 时 `return null;`。

更新 `sendPrompt`：把 `await selectModel(rt, task, sessionId);` 改为：

```ts
const target = await selectModel(rt, task, sessionId);
if (target) {
  const settings = await loadSettings(rt.dataDir);
  await applyThinkingLevel(client, resolveThinkingLevel(settings, null, target));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/thinking-level.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/test/thinking-level.test.ts
git commit -m "feat(desktop): resolve and apply thinking level"
```

---

### Task 5: 主进程 IPC 接线

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `resolveSessionModel` / `resolveThinkingLevel` / `applyThinkingLevel`（Task 4）。
- Produces:
  - `sparkii:getModelOptions` 返回增加 `provider: string`。
  - `sparkii:listThinkingLevels(providerId, modelId): Promise<string[]>`
  - `sparkii:setChatThinkingLevel(sessionId, level|null): Promise<{ ok: boolean }>`
  - `promptSession` 在 `selectModel` 之后 apply 档位。

- [ ] **Step 1: Write the failing test**

`ipc.test.ts` 增加三条用例。第一条验证 `listThinkingLevels`：

```ts
it('listThinkingLevels probes a model and returns available thinking levels', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek' }), 'utf8');
  const sent: any[] = [];
  const client = {
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'list_thinking_levels') {
        return { success: true, data: ['off', 'medium', 'high'] };
      }
      return { success: true };
    },
  };
  await makeRuntime({ dataDir, piAgentDir, client });

  const handlers = await registeredHandlers();
  const listThinkingLevels = handlers.get('sparkii:listThinkingLevels');
  const result = await listThinkingLevels!(null, 'deepseek', 'deepseek-v4-pro');
  expect(result).toEqual(['off', 'medium', 'high']);
  expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
  expect(sent).toContainEqual({ type: 'list_thinking_levels' });
});
```

第二条验证 `setChatThinkingLevel` 写会话 + 每模型记忆：

```ts
it('setChatThinkingLevel stores the session level and remembers it per model', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek' }), 'utf8');
  const client = { send: async () => ({ success: true }) };
  const update = vi.fn();
  const rt = await makeRuntime({ dataDir, piAgentDir, client, chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro' } });
  (rt as unknown as { chatSessions: { update: (id: string, p: unknown) => void } }).chatSessions.update = update;

  const handlers = await registeredHandlers();
  const setChatThinkingLevel = handlers.get('sparkii:setChatThinkingLevel');
  await setChatThinkingLevel!(null, 's1', 'high');

  expect(update).toHaveBeenCalledWith('s1', { thinkingLevel: 'high' });
  const cfg = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
  expect(cfg.modelThinkingLevels).toEqual({ 'deepseek/deepseek-v4-pro': 'high' });
});
```

第三条验证 `promptSession` 在 prompt 前发送 `set_thinking_level`：

```ts
it('promptSession applies the session thinking level before prompt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ activeProviderId: 'deepseek', defaultModel: 'deepseek-v4-pro' }), 'utf8');
  const sent: any[] = [];
  const client = {
    onEvent: (cb: (event: any) => void) => {
      queueMicrotask(() => cb({ type: 'agent_end' }));
      return () => {};
    },
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'get_state') return { success: true, data: { sessionFile: null } };
      return { success: true };
    },
  };
  await makeRuntime({
    dataDir,
    piAgentDir,
    client,
    chatSession: { profileId: 'contract-review', model: 'deepseek-v4-pro', thinkingLevel: 'high' },
  });

  const handlers = await registeredHandlers();
  const promptSession = handlers.get('sparkii:promptSession');
  await promptSession!(null, 's1', '你好');

  expect(sent).toContainEqual({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-v4-pro' });
  expect(sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/ipc.test.ts`
Expected: FAIL（新 handler 未注册 / promptSession 未发 `set_thinking_level`）

- [ ] **Step 3: Write minimal implementation**

`ipc.ts` 顶部 import 增加 `applyThinkingLevel, resolveSessionModel, resolveThinkingLevel`（从 `./workflow.js`）。

`getModelOptions` 返回改为：

```ts
return { defaultModel: settings.defaultModel ?? null, models, provider: providerId };
```

新增 handler（放在 `setChatModel` 附近）：

```ts
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
```

`promptSession` 里把现有 `selectModel` 分支改为：

```ts
const target = rec?.model
  ? await selectModel(rt, 'chat', sessionId, rec.model)
  : await selectModel(rt, 'chat', sessionId);
if (target) {
  const settings = await loadSettings(rt.dataDir);
  await applyThinkingLevel(slot.client, resolveThinkingLevel(settings, rec, target));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/ipc.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(desktop): wire thinking level through ipc"
```

---

### Task 6: preload 桥接

**Files:**
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`

**Interfaces:**
- Produces: `SparkiiApi` 增加 `setChatThinkingLevel`、`listThinkingLevels`；`getModelOptions` 返回增加 `provider: string`。

- [ ] **Step 1: Write the failing test**

`preload-api.test.ts` 的 `names` 数组增加 `'setChatThinkingLevel', 'listThinkingLevels'`；第二条用例增加对 `setChatThinkingLevel`/`listThinkingLevels` 的调用断言。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/preload-api.test.ts`
Expected: FAIL（方法名缺失）

- [ ] **Step 3: Write minimal implementation**

`api-types.ts` 增加：

```ts
setChatThinkingLevel(sessionId: string, level: string | null): Promise<{ ok: boolean }>;
listThinkingLevels(providerId: string, modelId: string): Promise<string[]>;
```

并把 `getModelOptions` 返回类型改为 `Promise<{ defaultModel: string | null; models: string[]; provider: string }>`。

`api.ts` 的 `buildApi` 增加：

```ts
setChatThinkingLevel: (sessionId, level) => invoke('setChatThinkingLevel', sessionId, level) as Promise<{ ok: boolean }>,
listThinkingLevels: (providerId, modelId) => invoke('listThinkingLevels', providerId, modelId) as Promise<string[]>,
```

并把 `getModelOptions` 的断言改为 `as Promise<{ defaultModel: string | null; models: string[]; provider: string }>`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/preload-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/test/preload-api.test.ts
git commit -m "feat(desktop): expose thinking level in preload api"
```

---

### Task 7: 前端 Composer + GeneralChatSurface 档位选择

**Files:**
- Create: `apps/desktop/src/workbench/thinking-levels.ts`
- Modify: `apps/desktop/src/workbench/Composer.tsx`
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: `apps/desktop/test/chat-composer.test.tsx`、`apps/desktop/test/general-chat-surface.test.tsx`

**Interfaces:**
- Consumes: `SparkiiApi.listThinkingLevels` / `setChatThinkingLevel`（Task 6）。
- Produces:
  - `THINKING_LEVELS`（完整阶梯）、`thinkingLevelLabel(level)`。
  - `ComposerProps` 增加 `thinkingLevels: string[]`、`thinkingLevel: string | null`、`onThinkingLevelChange(level: string | null): void`。
  - `GeneralChatSurface` 管理 `thinkingLevel`/`thinkingLevels`/`provider` 状态并在模型变化时刷新可用档位。

- [ ] **Step 1: Write the failing test**

`chat-composer.test.tsx` 的 `makeProps` 增加默认值 `thinkingLevels: ['off','minimal','low','medium','high','xhigh','max']`、`thinkingLevel: null`、`onThinkingLevelChange: vi.fn()`；新增：

```tsx
it('thinking select emits level changes', () => {
  const props = makeProps();
  render(<Composer {...props} />);
  const select = screen.getByTestId('thinking-select') as HTMLSelectElement;
  expect(select.value).toBe('');
  fireEvent.change(select, { target: { value: 'high' } });
  expect(props.onThinkingLevelChange).toHaveBeenCalledWith('high');
});
```

`general-chat-surface.test.tsx` 的 `makeApi` 增加 `getModelOptions` 返回 `provider: 'deepseek'`、`listThinkingLevels: vi.fn().mockResolvedValue(['off','medium','high'])`、`setChatThinkingLevel: vi.fn().mockResolvedValue({ ok: true })`；新增：

```tsx
it('changes the thinking level through the composer', async () => {
  const { api } = makeApi();
  render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
  await screen.findByText('hi');
  fireEvent.change(screen.getByTestId('thinking-select'), { target: { value: 'high' } });
  expect(api.setChatThinkingLevel).toHaveBeenCalledWith('s1', 'high');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/chat-composer.test.tsx apps/desktop/test/general-chat-surface.test.tsx`
Expected: FAIL（`thinking-select` 不存在 / props 缺失）

- [ ] **Step 3: Write minimal implementation**

`thinking-levels.ts`：

```ts
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const LABELS: Record<ThinkingLevel, string> = {
  off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};
export function thinkingLevelLabel(level: string): string {
  return LABELS[level as ThinkingLevel] ?? level;
}
```

`Composer.tsx`：增加三个 prop，在模型 `<select>` 旁边新增：

```tsx
<select
  className="model-select"
  data-testid="thinking-select"
  value={props.thinkingLevel ?? ''}
  onChange={(e) => props.onThinkingLevelChange(e.target.value || null)}
>
  <option value="">默认（跟随配置）</option>
  {props.thinkingLevels.map((l) => (
    <option key={l} value={l}>{thinkingLevelLabel(l)}</option>
  ))}
  {props.thinkingLevel && !props.thinkingLevels.includes(props.thinkingLevel) && (
    <option value={props.thinkingLevel}>{thinkingLevelLabel(props.thinkingLevel)}</option>
  )}
</select>
```

`GeneralChatSurface.tsx`：增加 `thinkingLevel`/`thinkingLevels`/`provider` 状态；`getModelOptions` 回填 `provider`；`refreshMeta` 回填 `rec.thinkingLevel`；新增 `activeTarget`/`refreshThinkingLevels`/`onThinkingLevelChange`，并在模型变化、`getModelOptions` 完成后刷新档位；把新 props 传给 `<Composer>`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/chat-composer.test.tsx apps/desktop/test/general-chat-surface.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workbench/thinking-levels.ts apps/desktop/src/workbench/Composer.tsx apps/desktop/src/surfaces/GeneralChatSurface.tsx apps/desktop/test/chat-composer.test.tsx apps/desktop/test/general-chat-surface.test.tsx
git commit -m "feat(desktop): add thinking level selector to chat composer"
```

---

### Task 8: 设置页默认思考强度

**Files:**
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Test: `apps/desktop/test/settings-view.test.tsx`

**Interfaces:**
- Consumes: `THINKING_LEVELS` / `thinkingLevelLabel`（Task 7）。
- Produces: 设置页「大模型连接」新增「默认思考强度」下拉，保存 `defaultThinkingLevel`。

- [ ] **Step 1: Write the failing test**

`settings-view.test.tsx` 新增：

```tsx
it('saves the default thinking level', async () => {
  const saveSettings = vi.fn().mockResolvedValue({});
  render(<SettingsView api={makeApi({ saveSettings })} />);
  await screen.findByText('已加载本机配置');
  fireEvent.change(screen.getByTestId('default-thinking-select'), { target: { value: 'high' } });
  fireEvent.click(screen.getByText('保存'));
  await waitFor(() => expect(saveSettings).toHaveBeenCalled());
  const arg = saveSettings.mock.calls[0][0] as Record<string, unknown>;
  expect(arg.defaultThinkingLevel).toBe('high');
});
```

（需在 `makeApi` 顶部补 `import { waitFor }`；如文件已导入则复用。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/test/settings-view.test.tsx`
Expected: FAIL（`default-thinking-select` 不存在）

- [ ] **Step 3: Write minimal implementation**

`SettingsView.tsx`：增加 `defaultThinkingLevel` state；加载时回填；在「默认模型」下方新增「默认思考强度」下拉（`data-testid="default-thinking-select"`），选项 `""`（跟随 SDK 默认）+ `THINKING_LEVELS`；`save()` 的 `saveSettings` 参数加 `defaultThinkingLevel`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/desktop/test/settings-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shell/SettingsView.tsx apps/desktop/test/settings-view.test.tsx
git commit -m "feat(desktop): add default thinking level setting"
```

---

### Task 9: 收尾验证

- [ ] **Step 1:** `npx vitest run`（全量单测）
- [ ] **Step 2:** `pnpm typecheck`
- [ ] **Step 3:** `pnpm lint`

---

## Self-Review

- **Spec 覆盖：** #1 会话档位（Task 1/3/5/7）、#2 全局默认（Task 2/8）、#3 每模型记忆（Task 2/4/5）；#4 已裁定延后并记录原因。
- **占位符扫描：** 无 TBD/TODO；每处代码均有明确实现或裁定。
- **类型一致：** `setThinkingLevel`/`listThinkingLevels`/`setChatThinkingLevel` 在 agent-host、preload、IPC、前端命名一致；`resolveThinkingLevel` 的入参与 `ChatSessionRecord.thinkingLevel`、`AppSettings.modelThinkingLevels` 一致。
