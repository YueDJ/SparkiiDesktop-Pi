# Live Session Pipeline Implementation Plan

> **For agentic workers:** 本 plan 在 spec 经架构师审核通过前 **不得执行**。审核通过后，用 superpowers:subagent-driven-development（推荐）或 executing-plans 按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 通用聊天与合同审核共用同一条实时管道。进程活着时起步用 `getBranch()` + `streamingMessage`；线上帧 TUI 原样透传；打开先听再快照；步骤行失败必须暴露；盖章用池子当前 `slot.sessionId`；compaction 整表换树；崩溃 / 退出只认 JSONL。

**Architecture:** Production（Pi 子进程）→ Pipeline（Electron main，每进程一根，出门盖活 `sessionId`）→ Consumption（renderer 把帧折进 `session.entries`）。JSONL 仍是已提交落盘真相。各 Surface 画什么不在本轮：合同投影仍以 JSONL-display spec 为准；通用智能体全量绘制下次再做。本轮必须把行折进列表，否则合同 live 卡片和聊天气泡仍会丢。

**Tech Stack:** Electron main + `@sparkii/agent-host` Pi 子进程、`sparkii:event:chat-event`、Vitest、现有 `Logger` / 错误中心。

**Spec:** `docs/superpowers/specs/2026-09-05-live-session-pipeline-design.md`

## Global Constraints

- 不新开 IPC 通道，不发明 `preview` / `committed` 两种新 `type`。仍走 `sparkii:event:chat-event`。
- 不按 agent id 分叉管道。平台生产代码不写 `'general'` / `'contract-review'`。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- **运行池冻结：** 不改 max / queue / `runtime-pool` 事件形状 / RuntimeCenter / 底栏右侧按钮 / App 的 stop·release·cancel。只改 `release` 里 `sessionId = null` 的时机，以及盖章读取活 `slot.sessionId`。
- **不保证**进程死后仍能看到未落盘那句；主进程不把 `streamingMessage` 代写进 JSONL。
- 不为没在看的 session 重放 token；不因视口盯着而不释放 slot。
- `buildContextEntries()` 不当平台时间线。
- `get_messages` 不当 UI 时间线主源（仅微缝补一次）。
- 投影用 `message` 全文换槽，禁止 `+= delta`。
- 未知 `type` 整包转发，不裁成 `{ type: 'unknown' }`。
- 本轮 **不** 给通用智能体补 TUI 全套控件（bash 实时块、compaction 卡片等视觉对齐下次做）。`applyChatEvent` / `applySurfaceEvent` 必须按 spec 第 2 条把帧折进列表。
- 本轮 **不** 改合同 `customType` 词汇或忽略/空白策略。
- 测试：Vitest。相关旧夹具改成 Pi 原形状，不放宽。renderer 与 electron `tsc --noEmit` 必须通过。

---

## Ownership (do not blur)

### 平台必须改

| 改动 | 为什么是平台 | 不改什么 |
| --- | --- | --- |
| `normalizeEvent` 恒等透传 | 管道是共用的 | 不按 Agent 白名单 |
| `get_state` 带出 `streamingMessage` | 子进程真相 | 不把 in-flight 写盘 |
| `openChatSession` 活着读树+流式槽 | 起步合成 | 不用 `get_messages` 当主时间线 |
| `pipeSessionEvents` 盖活 `slot.sessionId` | 一根进程一根管 | 不搞 `pipeId` / 窗口进程表 |
| 池子 `release`：先 `sessionId=null` 再 `new_session` | 防串话 | 不改排队/上限 |
| workflow start/end 空 catch → 暴露 | 引擎写入 | 不改步骤业务、不截断 output |
| `useAgentSession` 先听后快照 | 跨进程无序 | 不在 hook 里按 agent 分支 |
| `applyChatEvent` 全文换槽 + 工具三件套 | live=历史同一套条目 | 不新画通用智能体控件 |

### 本轮不要动

```text
合同 Surface 认哪些 customType / 忽略 vs 空白
通用智能体把所有 type 画成 TUI 控件
运行池 UI、审批、起名、标题 upsert
sparkii:event:workflow（已停）不要救回来
```

### 本轮要删掉的代码

| 现在还在 | 为什么废 | 怎么清 |
| --- | --- | --- |
| `normalizeEvent` 把 `message_update` 压成 `{ type:'message', delta }` | spec 第 2 条禁止 | 改成原样返回；不要留一条「兼容扁事件」分支 |
| 把 `tool_execution_*` 改写成 `tool_call` / `tool_result` | 同上 | 删映射 |
| 把 user `entry_appended` 压成 `{ type:'message', role:'user' }` | 同上 | 原样送达；折叠发生在 `applySurfaceEvent` |
| `openChatSession` 活着时并行 `get_messages` 当时间线 | spec 第 1 条 | 主路径改 `get_session_entries` + `streamingMessage` |
| `useAgentSession` 用 `messages` 填时间线 | 同上 | 只在主进程微缝补；hook 不再 `rawMessages` 当 entries |
| `pipeSessionEvents` 闭包冻住 `sessionId` | spec 第 5 条 | 出门读活牌子 |
| `workflow.ts` 的 `.catch(() => {})`（start/end/failed） | spec 第 4 条 | 整段空 catch 删掉 |
| `release` 里先 `new_session` 再 `sessionId=null` | 解绑窗口期仍盖旧 id | 对调顺序 |

改完后扫一眼：生产代码不得再拼 `delta` 进气泡；不得再出现 workflow start/end 的空 catch。

---

## File Structure

```text
packages/agent-host/src/rpc-client.ts              # normalizeEvent 恒等
packages/agent-host/src/types.ts                    # NormalizedEvent 放开（不再当允许名单）
packages/agent-host/src/pi-sdk-runtime.ts           # getState.streamingMessage
packages/agent-host/src/pi-runtime-pool.ts           # getSessionId；release 先卸牌子
packages/agent-host/test/rpc-client.test.ts
packages/agent-host/test/pi-runtime-command-data.test.ts
packages/agent-host/test/pi-runtime-pool.test.ts

apps/desktop/electron/main/ipc.ts                  # 盖章；openChatSession；crash；session_unbound
apps/desktop/electron/main/workflow.ts              # 步骤行失败暴露
apps/desktop/electron/main/logger.ts               # 已有，直接用
apps/desktop/electron/preload/api-types.ts          # openChatSession 增加 streamingMessage

apps/desktop/src/surface/open-session.ts            # 纯函数：缓冲叠快照、generation
apps/desktop/src/surface/use-agent-session.ts        # 先听后快照；compaction 重建
apps/desktop/src/surface/normalize.ts               # applySurfaceEvent 认 Pi 形状
packages/ui/src/patterns/pi-timeline.ts             # applyChatEvent 全文换槽 + 工具三件套

apps/desktop/test/surface-normalize.test.ts
apps/desktop/test/pi-timeline.test.ts
apps/desktop/test/use-agent-session.test.ts
apps/desktop/test/ipc.test.ts
apps/desktop/test/workflow-broker.test.ts
apps/desktop/test/app-general.test.tsx             # 夹具改 Pi 原形状
apps/desktop/test/standard-chat.test.tsx
apps/desktop/test/chat-workbench.test.tsx
```

不改（除非测试夹具形状）：

```text
apps/desktop/agents/contract-review/surface/**     # 投影规则不动
apps/desktop/agents/general/surface/**             # 不补全量绘制
packages/ui/src/patterns/RuntimeCenter.tsx
packages/ui/src/patterns/SessionList.tsx
```

---

### Task 1: `normalizeEvent` 恒等透传

**Files:**
- Modify: `packages/agent-host/src/rpc-client.ts`
- Modify: `packages/agent-host/src/types.ts`
- Test: `packages/agent-host/test/rpc-client.test.ts`

**Interfaces:**

```ts
// NormalizedEvent 不再是封闭联合（封闭联合 = 允许名单，会逼着人把新 type 裁成 unknown）。
export type NormalizedEvent = { type: string; [key: string]: unknown }

export function normalizeEvent(raw: unknown): NormalizedEvent {
  // 对象且有 type 字符串 → 原样返回（浅拷贝即可，不要抽字段）
  // 否则 → { type: 'unknown', raw }   // 只有「根本不是事件」才 unknown
}
```

`PiRpcClient.onEvent` 仍发 `NormalizedEvent`。子进程 `createPiRuntime` 继续走 `normalizeEvent`；恒等之后双重调用仍安全。

- [ ] **Step 1: Write the failing tests**

改 `rpc-client.test.ts`，旧「压扁」断言全部翻过来：

```ts
it('passes message_update through with full message', () => {
  const raw = {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] },
    assistantMessageEvent: { type: 'text_delta', delta: '条' },
  };
  expect(normalizeEvent(raw)).toEqual(raw);
});

it('does not flatten tool_execution_* or user entry_appended', () => {
  const tool = { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', params: { path: 'a.md' } };
  expect(normalizeEvent(tool)).toEqual(tool);
  const user = {
    type: 'entry_appended',
    entry: { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '先检查' }] } },
  };
  expect(normalizeEvent(user)).toEqual(user);
});

it('forwards unknown types as-is (does not wrap as type:unknown)', () => {
  const raw = { type: 'future_thing', x: 1 };
  expect(normalizeEvent(raw)).toEqual(raw);
});

it('passes custom entry_appended through unchanged', () => {
  const raw = {
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'workflow_step_end', data: { stepId: 'review' }, id: 'e1' },
  };
  expect(normalizeEvent(raw)).toEqual(raw);
});
```

生命周期（`compaction_*` / `auto_retry_*` / `thinking_level_changed`）改为 `toEqual(raw)`，不要再断言抽过的子集。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/agent-host test test/rpc-client.test.ts`  
Expected: FAIL（仍压成 `message` / `tool_call` / `unknown`）

- [ ] **Step 3: Minimal implementation**

`normalizeEvent`：若 `raw && typeof raw === 'object' && typeof raw.type === 'string'` 则 `return { ...raw }`；否则 `{ type: 'unknown', raw }`。删掉 `switch`。

`types.ts` 的 `NormalizedEvent` 改成开放对象。下游用 `ev.type` 收窄。

- [ ] **Step 4: Run test to verify it passes**

Run: 同上。Expected: PASS。再跑 `pnpm --filter @sparkii/agent-host test`，把仍依赖扁形状的测试改到 Task 8，本任务只保证 `rpc-client` 绿。若全量红是预期的，不要在本任务里改 desktop。

- [ ] **Step 5: Commit**

```text
passthrough Pi events in normalizeEvent
```

---

### Task 2: 活着起步 = `getBranch()` + `streamingMessage`

**Files:**
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`（若 `get_state` 透传 getState 即可则不动命令表）
- Modify: `apps/desktop/electron/main/ipc.ts`（`sparkii:openChatSession`）
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Test: `packages/agent-host/test/pi-runtime-command-data.test.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**

```ts
// getState() 增加（可空）
streamingMessage: session.agent?.state?.streamingMessage ?? null

// openChatSession 活着：
{
  entries: get_session_entries 的 data,          // getBranch()
  streamingMessage: get_state.streamingMessage ?? null,
  inputs,
  messages?: 仍可返回，但 renderer 时间线不用
}

// 死了：
{
  entries: readPiSessionEntries(file),       // 去掉 header
  streamingMessage: null,
  inputs,
}

// 微缝（只在 main 做一次，hook 不二次投票）：
// streamingMessage == null 且 get_messages 最后一条 assistant
// 在 entries 里找不到等价内容 → 把这条 assistant 放进 streamingMessage
// （当已定稿、尚未入树的那句；renderer 按 message_end 规则折进去，streaming:false）
```

不要读磁盘当活着起步。不要用 `buildContextEntries()`。

- [ ] **Step 1: Write the failing tests**

`pi-runtime-command-data.test.ts`：`get_state` 含 `streamingMessage`（夹具里设 `session.agent.state.streamingMessage`）。

`ipc.test.ts` 活着打开：

```ts
it('opens a live session from getBranch + streamingMessage, not get_messages', async () => {
  // slot 仍在 openSessions
  // stub get_session_entries → 含 custom 步骤行
  // stub get_state → streamingMessage = { role:'assistant', content:[{type:'text', text:'第3条'}] }
  // stub get_messages → 另一套更短的 messages
  const res = await openChatSession('s1');
  expect(res.entries).toEqual(branch);
  expect(res.streamingMessage).toEqual(theStream);
  expect(sent.filter(c => c.type === 'get_messages').length).toBe(0); // 主路径不拉；微缝测试另开
});

it('dead session reads JSONL entries only (no preview)', async () => {
  // openSessions 无此 id
  expect(res.streamingMessage).toBeNull();
  expect(res.entries).toEqual(jsonlBody);
});
```

微缝另开一条：`streamingMessage` 空、`get_messages` 末条 assistant 不在 branch → `res.streamingMessage` 等于那条 assistant（或等价字段）。主路径测试不得误伤这条。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `pi-runtime-command-data` 与 desktop `ipc.test.ts` 里 open 相关。Expected: FAIL（无 `streamingMessage`；仍并行 `get_messages`）。

- [ ] **Step 3: Minimal implementation**

`getState` 增加 `streamingMessage`。`openChatSession`：有 open slot → `get_session_entries` + `get_state`；仅微缝才 `get_messages`。死了走现有 JSONL，显式 `streamingMessage: null`。ENOENT 仍带 `inputs`（runtime-viewport spec 已定）。

- [ ] **Step 4: Run tests**

Expected: PASS（本任务相关）。

- [ ] **Step 5: Commit**

```text
open live sessions from getBranch and streamingMessage
```

---

### Task 3: 每进程一根 Pipe，盖章用活 `slot.sessionId`

**Files:**
- Modify: `packages/agent-host/src/pi-runtime-pool.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `packages/agent-host/test/pi-runtime-pool.test.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**

```ts
export interface PiRuntimeSlot {
  client: PiRuntimeClient
  supervisor: PiRuntimeSupervisor
  getSessionId(): string | null   // 活读内部 Slot.sessionId
}

// ipc：WeakMap<client, unsub>，每个 client 只订一次
function ensureProcessPipe(slot: PiRuntimeSlot): void {
  slot.client.onEvent((ev) => {
    const id = slot.getSessionId();
    if (!id) return;                          // 卸下期间不送
    win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId: id });
    if (ev.type === 'agent_settled' && !inFlightWorkflowRuns.has(id)) {
      scheduleIdleRelease(id);
    }
  });
}

// 解绑（可选，现有通道）：
// 把 sessionId 置 null 之前，若旧 id 非空，送一条 { type:'session_unbound', sessionId: 旧id }
// renderer 只用来停转圈。不新开 IPC。
```

`release` 顺序：

```text
1. 若旧 sessionId 非空 → 发 session_unbound（仍盖旧 id）
2. slot.sessionId = null        // 之后事件不送窗口
3. new_session
4. bind 下一个（slot.sessionId = 下一个）
```

`pipeSessionEvents(sessionId, entry)` 改为 `ensureProcessPipe(entry.slot)`，不要把 `sessionId` 冻进闭包。`openSessions` 仍可当「这条会话占用哪个 slot」的簿记，**不是**窗口侧进程表，renderer 不准镜像一份。

窗口过滤保持：`p.sessionId === current.sessionId`。

- [ ] **Step 1: Write the failing tests**

池：

```ts
it('clears sessionId before sending new_session on release', async () => {
  // spy：new_session 发出时 slot.sessionId 必须已经是 null
});
```

ipc：

```ts
it('stamps chat-event with live slot.sessionId, not the subscribe-time id', async () => {
  pipe attached while sessionId === 'A'
  rename/rebind to 'B' without new listener
  emit event → sent payload.sessionId === 'B'
});

it('drops events while slot.sessionId is null', async () => {
  // 置 null 后 emit，窗口收不到
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL（闭包仍是 A；`new_session` 时牌子还在）。

- [ ] **Step 3: Minimal implementation**

`PiRuntimeSlot.getSessionId`。`release` 对调顺序（先发 `session_unbound` 再卸牌子再 `new_session`）。ipc 用活牌子盖章；`offEvents` 按 client 去重，不要每个 session 加一根。进程退出时 listener 随 client 消失即可。

idle-release 仍用**当时**的 session id（settled 时读到的 id），不要用闭包里的旧 A 去 release B。

- [ ] **Step 4: Run tests**

Expected: PASS。现有「workflow 中途不 idle-release」保持。

- [ ] **Step 5: Commit**

```text
stamp chat-events with live slot.sessionId
```

---

### Task 4: 步骤行投递失败必须暴露

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**

```ts
async function appendStep(slot, sessionId, customType, data): Promise<boolean> {
  const resp = await slot.client.send({ type: 'append_workflow_entry', customType, data });
  if (resp.success) {
    logger.debug({ msg: 'workflow entry appended', ctx: { sessionId, stepId: data.stepId, customType } });
    return true;
  }
  throw new Error(resp.error ?? 'append_workflow_entry failed');
}

// 失败：
// 1. logger.error({ sessionId, stepId, customType, error, outputBytes })  // 禁止整份 output
// 2. 错误中心一句人话：rt.errors.append + 现有 chat-event runtime_error
//    （source 用该 profile 的 displayName，不要写死合同）
// 3. 若失败的是带巨大 output 的 step_end：再试一条很小的 step_end failed（无 output）
// 4. 连这个也失败 → 停循环（break / return），不要跑下一步
// 5. finally：等到这一轮最后一次 append 结束（成功或已按上面报失败）再 release
```

`updateWorkflowState` 的 throw 路径不改。不准静默截断 `output`。

错误中心：不要新 IPC。`rt.errors.append({ id, message, source, createdAt })`，并 `webContents.send('sparkii:event:chat-event', { type: 'runtime_error', sessionId, message })`。App / standard-chat 已有 `runtime_error` → `reportError`。为避免聊天双 toast，本轮约定：**主进程已 append 的**，renderer 的 `runtime_error` 只负责 toast（若会双写 errors.db，standard-chat 对「workflow 步骤行」这条保持现状即可；测试断言至少一次人话进错误中心，不要强制恰好一次）。

- [ ] **Step 1: Write the failing tests**

```ts
it('stops the workflow and reports when step_end append fails', async () => {
  send mock: first completed append rejects / success:false
  expect(后续 step_started 不再发生)
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
    level: 'error',
    ctx: expect.objectContaining({ sessionId, stepId, customType: 'workflow_step_end' }),
  }))
  expect(ctx 有 outputBytes 且没有整份 output)
  expect(errors.append 或 chat-event runtime_error)
  expect(release).toHaveBeenCalled() // finally 仍释放，且在最后一次 append 之后
});

it('does not swallow start/end append failures with empty catch', () => {
  // 生产 workflow.ts 不得再出现这三处 .catch(() => {})
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL（空 catch 仍吞掉）。

- [ ] **Step 3: Minimal implementation**

抽 `appendStep`。三处空 catch 删掉。失败走 Logger + 错误中心 + 可选极小 failed end + 停循环。`finally` 保持 `beforeRelease` + `pool.release`。成功 `debug`。

- [ ] **Step 4: Run tests**

Run: vitest `workflow-broker`。Expected: PASS。现有「跑完才 release、中途不 idle-release」保持。

- [ ] **Step 5: Commit**

```text
surface workflow step-row append failures
```

---

### Task 5: 把 Pi 帧折进 `session.entries`（不是画控件）

**Files:**
- Modify: `packages/ui/src/patterns/pi-timeline.ts`（`applyChatEvent`）
- Modify: `apps/desktop/src/surface/normalize.ts`
- Test: `apps/desktop/test/pi-timeline.test.ts`
- Test: `apps/desktop/test/surface-normalize.test.ts`

**行为（spec 第 2 条表）：**

| 事件 | 列表 |
| --- | --- |
| `message_start` assistant | 新开流式槽，`text/thinking` 来自 `message` 全文 |
| `message_update` | 同一槽 **整句换成** `message`（禁止 `+= delta`） |
| `message_end` | 再刷全文，`streaming:false`，**不等树 id** |
| `message_start` user | 追加 user；随后 `entry_appended` 且 `entry.type==='message'` + user → 跳过 |
| `entry_appended` custom | 已有 `entry.id` 则跳过，否则追加 |
| `tool_execution_start` | 按 `toolCallId` 开工具块（`args`/`params` → input） |
| `tool_execution_update` | 同一块刷 `partialResult` |
| `tool_execution_end` | 最终 `result` / `isError`，结束该块 |
| 未知 `type` | **不要丢**：追加 `kind:'event'`，`event`/`payload` 保留原 type 与整包。聊天 UI 可以不画新控件 |
| 旧测试里的扁 `{ type:'message', delta }` | **不必兼容**。夹具改成 Pi 形状 |

从 `message.content` 抽 text / thinking：现有 `contentText` / `contentThinking`。

`compaction_end` 成功 **不要**在本函数里静默当一条普通 event 就完了——hook 会整表换树（Task 6）。本函数遇到成功 `compaction_end` 可以仍追加一条 lifecycle event，随后被整表换掉；或直接原样返回等 hook 处理。推荐：`applyChatEvent` 追加 lifecycle；**换树发生在 hook**，避免纯函数去 IPC。

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces the streaming slot with full message on message_update', () => {
  let e = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [] } });
  e = applyChatEvent(e, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '第3条' }] } });
  e = applyChatEvent(e, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: '第3条存在期限不对齐' }] } });
  expect(e.filter(x => x.kind === 'message')).toHaveLength(1);
  expect(e.at(-1)).toMatchObject({ kind: 'message', text: '第3条存在期限不对齐', streaming: true });
});

it('finalizes on message_end without waiting for a tree id', () => {
  let e = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '完' }] } });
  e = applyChatEvent(e, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完' }] } });
  expect(e.at(-1)).toMatchObject({ streaming: false, text: '完' });
});

it('ignores user entry_appended after message_start user', () => {
  let e = applyChatEvent([], { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } });
  e = applySurfaceEvent(e, {
    type: 'entry_appended',
    entry: { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } },
  });
  expect(e.filter(x => x.kind === 'message' && x.role === 'user')).toHaveLength(1);
});

it('keeps unknown event types in the list', () => {
  const e = applyChatEvent([], { type: 'future_thing', x: 1 });
  expect(e.at(-1)).toMatchObject({ kind: 'event', payload: expect.objectContaining({ type: 'future_thing' }) });
});
```

工具三件套、custom 去重：把旧 `tool_call`/`tool_result` 夹具改成 `tool_execution_*`。合同 `entry_appended` custom 保持。

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL（仍 `+= delta` / 不认 `message_start`）。

- [ ] **Step 3: Minimal implementation**

重写 `applyChatEvent` 的 message / tool 分支。`applySurfaceEvent`：custom 仍按 id；user 改走 `message_start` / 去重；其余交 `applyChatEvent`。删掉「扁 `type:'message' role:user`」专支。

- [ ] **Step 4: Run tests**

Run: vitest `pi-timeline` `surface-normalize`。Expected: PASS。

- [ ] **Step 5: Commit**

```text
fold TUI events into session entries by replacement
```

---

### Task 6: 先听、缓冲、一次快照；compaction 再换树

**Files:**
- Create: `apps/desktop/src/surface/open-session.ts`（纯函数，便于单测）
- Modify: `apps/desktop/src/surface/use-agent-session.ts`
- Test: `apps/desktop/src/surface/open-session.ts` 的测试放 `apps/desktop/test/open-session.test.ts`
- Test: `apps/desktop/test/use-agent-session.test.ts`

**Interfaces:**

```ts
export function applySnapshotThenBuffer(
  snapshot: { entries: unknown[]; streamingMessage?: unknown | null },
  buffer: unknown[],
  apply: typeof applySurfaceEvent,
): SessionEntry[]

export function shouldRebuildOnCompaction(ev: unknown): boolean
// type==='compaction_end' && !aborted && !errorMessage && willRetry !== true
```

Hook 顺序（generation 整数）：

```text
1. gen += 1；listen chat-event（sessionId 匹配）→ 写入 buffer，不 setState 画时间线
2. openChatSession(sessionId)
3. 若 gen 已变 / unmount → 丢快照、丢缓冲
4. entries = normalizeSessionEntries(snapshot.entries)
   若 snapshot.streamingMessage → 折成流式槽（与 message_start 相同）
5. 按顺序 apply buffer（custom 按 id 去重）
6. setState 一次铺底
7. 之后事件直接 apply，不再用这次快照
```

`compaction_end` 成功：再走 1–6（新 gen）。这是允许的第二次整表换树。不要用 `buildContextEntries()`。

从历史打开再续问：`sessionId` 不变则 effect 不重跑；已画留下，只追加新事件。不要在 prompt 成功后再 `openChatSession` 清屏。`mode` 仍只是依赖项，不切断数据面。

`session_unbound` 且 `payload.sessionId === sessionId`：`streaming=false`，不清 entries。

禁止：先把事件画上再让晚到快照整表覆盖。禁止晚到快照按 id 并集补洞。

- [ ] **Step 1: Write the failing tests**

`open-session.test.ts`：快照 + 缓冲 custom 去重；缓冲里的 `message_update` 与快照 `streamingMessage` 是同一槽。

`use-agent-session.test.ts`：

```ts
it('does not paint chat-events until the open snapshot is applied', async () => {
  let resolveOpen: (v: unknown) => void
  openChatSession mock = new Promise(r => { resolveOpen = r })
  renderHook(...)
  chatCb({ sessionId:'s1', type:'entry_appended', entry: { type:'custom', id:'c1', customType:'workflow_step_start', data:{ stepId:'review' } } })
  expect(result.current.entries).toEqual([])           // 还没铺
  await act(() => resolveOpen({ entries: [userRow], streamingMessage: null }))
  expect(result.current.entries.map(...)).toContainEqual(expect.objectContaining({ customType: 'workflow_step_start' }))
});

it('drops snapshot and buffer when session changes', async () => {
  // 打开 s1 未完成就切到 s2 → s1 的 resolve 不得写进 s2
});
```

旧「open 之后立刻 apply `tool_call`」改成 `tool_execution_*`，且必须等 snapshot。

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL（今日 snapshot 与 listener 并行，事件立刻 apply，snapshot 到达会整表替换）。

- [ ] **Step 3: Minimal implementation**

抽出 `applySnapshotThenBuffer`。hook 用 generation。compaction 成功再开一次。不要在 catch 里静默到空白以外的行为（读失败仍空会话）。

- [ ] **Step 4: Run tests**

Run: vitest `open-session` `use-agent-session` `contract-surface`（投影不改，夹具若发扁事件则改形状）。Expected: PASS。

- [ ] **Step 5: Commit**

```text
listen then snapshot when opening a session
```

---

### Task 7: 崩溃只认 JSONL；Logger.error

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`（或 pool/supervisor 的 exit 钩子接到 ipc）
- Test: `apps/desktop/test/ipc.test.ts`（或 host `pi-runtime-supervisor` + ipc 集成夹具）

**行为：**

```text
子进程 onExit / 非 0：
  logger.error({ msg: 'pi runtime exited', ctx: { sessionId: 当时牌子, code } })
  不要把 streamingMessage 写进 jsonl
  slot 按 release 路径卸牌子（先 null）→ 不再盖章
  若窗口还在看这条：可发 session_unbound 停转圈
再打开：走死了路径（JSONL），没有 preview
```

应用退出：现有关进程即可，不抢写 in-flight。

- [ ] **Step 1: Write the failing test**

```ts
it('logs and stops stamping when the pi child exits', async () => {
  // 模拟 slot supervisor exit
  expect(logger.error).toHaveBeenCalled()
  emit after exit → 不再 send chat-event
});
```

- [ ] **Step 2–4:** FAIL → 接 `supervisor.onExit` → PASS。不要新通道。

- [ ] **Step 5: Commit**

```text
stop live pipe and log when pi process exits
```

---

### Task 8: 夹具与回归改成 Pi 原形状

**Files:**
- Modify tests: `app-general.test.tsx`、`standard-chat.test.tsx`、`chat-workbench.test.tsx`、`use-agent-session.test.ts`、`ipc.test.ts`、以及任何仍发 `{ type:'message', delta }` / `tool_call` 的 live 夹具
- 不改合同投影断言（risk 卡片仍来自 `workflow_step_end.output`）

**规则：** live 夹具一律用 `message_start` / `message_update`（带 `message`）/ `message_end` / `entry_appended` / `tool_execution_*`。历史夹具仍用 JSONL `{ type:'message', message }` / `{ type:'custom', ... }`。

聊天「还在生成」：`streaming: true` 来自流式槽，不再靠扁 `delta`。

- [ ] **Step 1: 改夹具并跑会红的测试，直到绿**

Run:

```text
pnpm --filter @sparkii/agent-host test
pnpm --filter @sparkii/desktop test test/ipc.test.ts test/use-agent-session.test.ts test/surface-normalize.test.ts test/pi-timeline.test.ts test/open-session.test.ts test/workflow-broker.test.ts test/app-general.test.tsx test/app-workflow.test.tsx test/standard-chat.test.tsx test/contract-surface.test.tsx test/chat-workbench.test.tsx
```

Expected: PASS。合同「live 步骤行到达卡片」若还没有覆盖，在 `use-agent-session` 或 contract 测里补一条：缓冲/`entry_appended` `workflow_step_end` 后 `extractWorkflowResult` 有 `review`。

- [ ] **Step 2: typecheck**

```text
pnpm --filter @sparkii/agent-host exec tsc --noEmit
pnpm --filter @sparkii/desktop exec tsc --noEmit -p tsconfig.json
pnpm --filter @sparkii/desktop exec tsc --noEmit -p tsconfig.electron.json
pnpm --filter @sparkii/ui exec tsc --noEmit
```

- [ ] **Step 3: 扫生产代码回潮**

```text
rg "catch\\(\\(\\) => \\{\\}\\)" apps/desktop/electron/main/workflow.ts
rg "type: 'message', role: 'assistant', delta" apps/desktop/src packages
rg "buildContextEntries" apps/desktop/src apps/desktop/electron packages/agent-host/src
```

workflow 空 catch 必须为 0。生产路径不得 `+= delta`。不得用 `buildContextEntries` 当起步。

- [ ] **Step 4: Commit**

```text
update live-event fixtures to Pi TUI shapes
```

---

## Suggested Implementation Order

1. 透传（Task 1）——后面所有夹具都依赖原形状
2. 起步 RPC（Task 2）
3. Pipe 身份（Task 3）
4. 步骤行失败（Task 4）——与管道形状独立，可与 5 并行
5. 折进列表（Task 5）
6. 先听后快照 + compaction（Task 6）
7. 崩溃（Task 7）
8. 夹具 / typecheck / 回潮扫描（Task 8）

不要先改合同 Surface 视觉。不要先给通用聊天加 TUI 控件。不要先加第二条 IPC。

## Self-Review Notes

- 第 7 条把「画」和「送达 / 折进列表」切开：本 plan 改 pipe + `apply*` + hook，不改 Agent 控件清单。
- `NormalizedEvent` 必须开放，否则 Task 1 会在类型层重新做允许名单。
- 盖章读活牌子，idle-release / settled 也要用当时的 id，否则会 release 错会话。
- 微缝只在 main 做一次，避免 renderer 三路投票。
- 测试先于实现。旧「扁 delta」测试是要改的规格，不是要迁就的兼容层。
