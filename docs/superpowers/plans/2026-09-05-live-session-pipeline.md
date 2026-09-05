# Live Session Pipeline Implementation Plan

> **For agentic workers:** 本 plan 已经架构师审过并吸收 must-fix。审核记录见下文「Architect corrections」。按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 通用聊天与合同审核共用同一条实时管道。进程活着时起步用 `getBranch()` + `streamingMessage`；线上帧 TUI 原样透传；打开先听再快照；步骤行失败必须暴露；盖章用池子当前 `slot.sessionId`；compaction 整表换树；崩溃 / 退出只认 JSONL。

**Architecture:** Production（Pi 子进程）→ Pipeline（Electron main，每进程一根，出门盖活 `sessionId`）→ Consumption（renderer 把帧折进 `session.entries`）。JSONL 仍是已提交落盘真相。各 Surface 画什么不在本轮：合同投影仍以 JSONL-display spec 为准；通用智能体全量绘制下次再做。本轮必须把行折进列表，否则合同 live 卡片和聊天气泡仍会丢。

**Tech Stack:** Electron main + `@sparkii/agent-host` Pi 子进程、`sparkii:event:chat-event`、Vitest、现有 `Logger` / 错误中心。

**Spec:** `docs/superpowers/specs/2026-09-05-live-session-pipeline-design.md`

## Architect corrections

已吸收（无需产品再拍板）：

1. `sendPrompt` 必须在 Task 1 改成全文替换，否则合同每步 `output` 变空。
2. `ChatWorkbench` 是生产消费者（虽未挂进 App），放进 Task 5，不要藏在夹具任务。
3. 删掉 `openSessions.offEvents` 三处拆管；卸下只靠 `slot.sessionId = null`。
4. `session_unbound` 由 ipc 在 `pool.release` 之前发，池子不碰窗口。
5. 快照带 `streaming`；微缝只在 `isStreaming && !streamingMessage`。
6. 未知 type 折进列表但 `shouldShowEntry` 默认 `debug`，不要在 standard 详情级刷卡片。
7. 错误中心恰好一行：main 写入 + 同一 `errorId`；App 听 `runtime_error` 做 toast。
8. user 行按「末条相同文本」去重，不依赖一定先有 `message_start`。

**Architect verdict:** Approve with nits（已吸收；IMPLEMENTATION MAY START）。

## Global Constraints

- spec / plan 已经架构师 Approve with nits，可以改产品代码。
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
| `sendPrompt` 用 `e.type==='message'` 且 `+= e.delta` | 透传后合同每步 output 变空 | 改成 `message_update`/`message_end` 全文替换 `acc` |
| 把 `tool_execution_*` 改写成 `tool_call` / `tool_result` | 同上 | 删映射 |
| 把 user `entry_appended` 压成 `{ type:'message', role:'user' }` | 同上 | 原样送达；折叠发生在 `applySurfaceEvent` |
| `openChatSession` 活着时并行 `get_messages` 当时间线 | spec 第 1 条 | 主路径改 `get_session_entries` + `streamingMessage` |
| `useAgentSession` 用 `messages` 填时间线 | 同上 | 只在主进程微缝补；hook 不再 `rawMessages` 当 entries |
| `pipeSessionEvents` 闭包冻住 `sessionId` | spec 第 5 条 | 出门读活牌子 |
| `openSessions.offEvents?.()` 在 release/delete/workflow beforeRelease | 会拆掉**进程**管子，下一会话无 live | 三处删除；卸下只靠 `sessionId=null` |
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
apps/desktop/electron/main/workflow.ts              # sendPrompt 全文替换；步骤行失败暴露
apps/desktop/electron/main/logger.ts               # 已有，直接用
apps/desktop/electron/main/error-store.ts          # append INSERT OR IGNORE
apps/desktop/electron/preload/api-types.ts          # openChatSession 增加 streamingMessage / streaming
apps/desktop/src/App.tsx                           # 仅当 runtime_error 带 errorId 时进错误中心
apps/desktop/src/surface/standard-chat.tsx         # 无 errorId 的 Pi runtime_error 才 reportError
packages/ui/src/patterns/ErrorCenter.tsx            # reportError 可带 id
apps/desktop/src/workbench/ChatWorkbench.tsx        # 认 Pi message_*（Task 5）
apps/desktop/agents/contract-review/surface/index.tsx  # 刷新触发改 message_end（不改投影规则）

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

不改（投影规则 / 控件清单）：

```text
合同认哪些 customType / 忽略 vs 空白（刷新触发从 type==='message' 改成 message_end 除外）
通用智能体把所有 type 画成 TUI 控件
运行池 UI、审批、起名、标题 upsert
sparkii:event:workflow（已停）不要救回来
```

---

### Task 1: `normalizeEvent` 恒等透传

**Files:**
- Modify: `packages/agent-host/src/rpc-client.ts`
- Modify: `packages/agent-host/src/types.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`（`sendPrompt`）
- Test: `packages/agent-host/test/rpc-client.test.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`（步骤 output 来自 Pi 全文事件）

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

`workflow-broker.test.ts` 增加：给一步 `llm`/`skill` 喂 `message_start` → `message_update`（全文 `"第3条存在期限不对齐"`）→ `message_end` → `agent_end`，断言该步 `workflow_step_end.data.output` 含这句全文，而不是 `''`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/agent-host test test/rpc-client.test.ts`  
Expected: FAIL（仍压成 `message` / `tool_call` / `unknown`）

- [ ] **Step 3: Minimal implementation**

`normalizeEvent`：若 `raw && typeof raw === 'object' && typeof raw.type === 'string'` 则 `return { ...raw }`；否则 `{ type: 'unknown', raw }`。删掉 `switch`。

`types.ts` 的 `NormalizedEvent` 改成开放对象。下游用 `ev.type` 收窄。

`sendPrompt`（`workflow.ts`）：

```ts
off = client.onEvent((e) => {
  if ((e.type === 'message_update' || e.type === 'message_end') && e.message) {
    acc = assistantTextFromMessage(e.message); // 全文替换，禁止 acc += delta
  }
  if (e.type === 'agent_end') finish();
});
```

`acc = assistantTextFromMessage(e.message)`：在 `workflow.ts` **本地**写一个小函数（`content` 字符串或 text block 拼接）。不要从 `@sparkii/ui` 进口 `contentText`（它未导出）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/agent-host test`（必须绿）以及 desktop `workflow-broker` 里「步骤吃到全文」那条。Task 1 保持 agent-host 绿，并更新它打破的主进程消费者（`sendPrompt`）。renderer 夹具留给 Task 5/8。

- [ ] **Step 5: Commit**

```text
passthrough Pi events; take full text in sendPrompt
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
isStreaming / streaming: session.isStreaming   // 已有则保留

// openChatSession 活着：
{
  entries: get_session_entries 的 data,          // getBranch()
  streamingMessage: get_state.streamingMessage ?? null,
  streaming: Boolean(get_state.isStreaming ?? get_state.streaming),
  inputs,
}

// 死了：
{
  entries: readPiSessionEntries(file),       // 去掉 header
  streamingMessage: null,
  streaming: false,
  inputs,
}
// 死了路径不要再返回 messages 当时间线。ipc.test.ts 里
// expect(opened).toMatchObject({ messages: [] }) 改成 entries + streamingMessage: null。

// 微缝（只在 main，且必须同时满足）：
// get_state.isStreaming === true && streamingMessage == null
// 才 get_messages；最后一条 assistant 与 branch 最后一条 assistant 文本不全等
// → 放入 streamingMessage。气泡是否转圈看返回的 `streaming` 字段，不看该对象在不在。
// 其他打开路径 expect(sent.filter(c => c.type === 'get_messages')).toHaveLength(0)
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
  expect(res.streaming).toBe(true);
  expect(sent.filter(c => c.type === 'get_messages').length).toBe(0); // 主路径不拉；微缝测试另开
});

it('dead session reads JSONL entries only (no preview)', async () => {
  // openSessions 无此 id
  expect(res.streamingMessage).toBeNull();
  expect(res.entries).toEqual(jsonlBody);
});
```

微缝另开一条：仅当 `isStreaming===true` 且 `streamingMessage` 空、`get_messages` 末条 assistant 与 branch 末条文本不等 → `res.streamingMessage` 等于那条 assistant。主路径（idle 或已有 stream）`get_messages` 次数为 0。

- [ ] **Step 2: Run test to verify it fails**

Run: vitest `pi-runtime-command-data` 与 desktop `ipc.test.ts` 里 open 相关。Expected: FAIL（无 `streamingMessage`；仍并行 `get_messages`）。

- [ ] **Step 3: Minimal implementation**

`getState` 增加 `streamingMessage`。`openChatSession`：有 open slot → `get_session_entries` + `get_state`（带 `streaming`）；仅微缝才 `get_messages`。死了走现有 JSONL，显式 `streamingMessage: null`、`streaming: false`。ENOENT 仍带 `inputs`。

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
  getSessionId(): string | null   // bind 里闭包：() => slot.sessionId，不要拷贝当时的字符串
}

// ipc：WeakMap<client, unsub> 键是 client（进程稳），不是每次 acquire 的新包装对象
function ensureProcessPipe(slot: PiRuntimeSlot): void {
  if (pipes.has(slot.client)) return;
  const off = slot.client.onEvent((ev) => {
    const id = slot.getSessionId();
    if (!id) return;
    const win = getWindow(); // 回调内取，不要订管时冻住 BrowserWindow
    win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId: id });
    // sessionId 盖写事件自带的同名字段
    if (ev.type === 'agent_settled' && !inFlightWorkflowRuns.has(id)) {
      scheduleIdleRelease(id);
    }
  });
  pipes.set(slot.client, off);
}

// session_unbound：ipc 在调用 pool.release 之前发送（池子没有 BrowserWindow）
function unbindAndRelease(sessionId: string) {
  win?.webContents.send('sparkii:event:chat-event', { type: 'session_unbound', sessionId });
  await rt.pool.release(sessionId);
}
```

`pool.release` **只**做：

```text
1. slot.sessionId = null        // 之后事件不送窗口
2. new_session
3. bind 下一个（slot.sessionId = 下一个）
```

不要给池子窗口句柄。池子里的 `Slot.offEvent`（status 用）与 ipc 的旧 `offEvents` 不是一回事；ipc 的 `openSessions.offEvents` **三处都删掉**（`releaseSessionSlotInternal`、`deleteChatSession`、`runWorkflow` 的 `beforeRelease`）。卸下只靠牌子变 null。现有 ipc 测试 `stops forwarding client events after the workflow slot is released` 改为：mock `getSessionId()===null` 时不再 send，而不是靠 unsubscribe。

`pipeSessionEvents(sessionId, entry)` 改为 `ensureProcessPipe(entry.slot)`。`openSessions` 仍可当「这条会话占用哪个 slot」的簿记，**不是**窗口侧进程表。

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

`bind` 返回 `{ client, supervisor, getSessionId: () => slot.sessionId }`。`release`：先 `sessionId=null` 再 `new_session`。ipc：`ensureProcessPipe`；删三处 `offEvents`；`session_unbound` 在 `pool.release` 之前发。idle-release 用 settled **当时**读到的 id。

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
- Modify: `apps/desktop/electron/main/error-store.ts`
- Modify: `packages/ui/src/patterns/ErrorCenter.tsx`（`reportError` 可带 `id`）
- Modify: `apps/desktop/src/App.tsx`（全局听 `runtime_error`）
- Modify: `apps/desktop/src/surface/standard-chat.tsx`（有 `errorId` 时不要再 `reportError`）
- Test: `apps/desktop/test/workflow-broker.test.ts`
- Test: `apps/desktop/test/error-store.test.ts`

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
// 2. 主进程是唯一写入者：
//    id = randomUUID()
//    rt.errors.append({ id, message, source, createdAt })
//    send chat-event { type:'runtime_error', sessionId, message, errorId: id, source }
//    source = profile displayName，不要写死合同
// 3. 恰好一个写入者：
//    有 errorId → 只有 App reportError(message, { source: event.source, id: errorId })
//    无 errorId（Pi 自己的 runtime_error）→ 只有 Surface（standard-chat）reportError
//    二者互斥，禁止双 toast / 双行
//    ErrorStore INSERT OR IGNORE
//    合同页不听 runtime_error，靠 App 收带 errorId 的那条
// 4. 若失败的是带巨大 output 的 step_end：再试一条很小的 step_end failed（无 output）
// 5. 连这个也失败 → 停循环，不要跑下一步
// 6. finally：等到这一轮最后一次 append 结束再 release
```

`updateWorkflowState` 的 throw 路径不改。不准静默截断 `output`。测试断言错误中心 **恰好一行**（同一 id）。

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
  expect(errors.append).toHaveBeenCalledTimes(1)
  expect(chat-event runtime_error.errorId).toBe(那次 append 的 id)
  expect(release).toHaveBeenCalled()
});

it('does not swallow start/end append failures with empty catch', () => {
  // 生产 workflow.ts 不得再出现这三处 .catch(() => {})
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL（空 catch 仍吞掉）。

- [ ] **Step 3: Minimal implementation**

抽 `appendStep`。三处空 catch 删掉。失败走 Logger + 单行错误中心 + 可选极小 failed end + 停循环。`ErrorStore.append` 用 `INSERT OR IGNORE`。`reportError` 接受可选 `id`。App **只**处理带 `errorId` 的 `runtime_error`（并透传 `source`）；standard-chat **只**处理不带 `errorId` 的。`finally` 保持 `beforeRelease` + `pool.release`。成功 `debug`。

- [ ] **Step 4: Run tests**

Run: vitest `workflow-broker`。Expected: PASS。现有「跑完才 release、中途不 idle-release」保持。

- [ ] **Step 5: Commit**

```text
surface workflow step-row append failures
```

---

### Task 5: 把 Pi 帧折进 `session.entries`（不是画控件）

**Files:**
- Modify: `packages/ui/src/patterns/pi-timeline.ts`（`applyChatEvent`、`eventLabel` default）
- Modify: `packages/ui/src/patterns/chat-detail-level.ts`（未知 event 保持 `?? 'debug'`）
- Modify: `apps/desktop/src/surface/normalize.ts`
- Modify: `apps/desktop/src/workbench/ChatWorkbench.tsx`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（刷新触发 `message` → `message_end`；不改 customType 投影）
- Test: `apps/desktop/test/pi-timeline.test.ts`
- Test: `apps/desktop/test/surface-normalize.test.ts`
- Test: `apps/desktop/test/chat-workbench.test.tsx`

**行为（spec 第 2 条表）：**

| 事件 | 列表 |
| --- | --- |
| `message_start` assistant | 新开流式槽，`text/thinking` 来自 `message` 全文 |
| `message_update` | 找到 **`streaming===true` 的那条**（不要假定是 `entries.at(-1)`，中间可能插了工具块），整句换成 `message` |
| `message_end` | 再刷全文，`streaming:false`，**不等树 id** |
| `message_start` user | 追加 user |
| `entry_appended` 且 message+user | 末条已是相同文本的 user 则跳过，否则追加（单独一条、没有 `message_start` 也要能画出） |
| `entry_appended` custom | 已有 `entry.id` 则跳过，否则追加 |
| `tool_execution_start` | 按 `toolCallId` 开工具块（`args`/`params` → input） |
| `tool_execution_update` | 同一块刷 `partialResult` |
| `tool_execution_end` | 最终 `result` / `isError`，结束该块 |
| 未知 `type` | 追加 `kind:'event'`，`event` 为原 type，`payload` 整包。`TimelineEventType` 放宽；`eventLabel`/`eventDetail`/`eventStatus` 加 `default`（label=原 type）。`shouldShowEntry` 继续 `EVENT_MIN_LEVEL[event] ?? 'debug'`，**不要**把未知降到 standard，否则聊天会刷生命周期卡 |
| 旧扁 `{ type:'message', delta }` | **不必兼容** |

`ChatWorkbench`：同样按 `message_start`/`update`/`end` 全文换槽，禁止 `+= delta`。它没挂进 App，但仍是生产文件，不要只改测试。

`compaction_end` 成功：`applyChatEvent` 可追加 lifecycle；**换树发生在 hook**。

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

it('appends a user bubble from entry_appended when there was no message_start', () => {
  const e = applySurfaceEvent([], {
    type: 'entry_appended',
    entry: { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请审核' }] } },
  });
  expect(e.filter(x => x.kind === 'message' && x.role === 'user')).toHaveLength(1);
});

it('updates the streaming slot even if a tool block is last', () => {
  let e = applyChatEvent([], { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } });
  e = applyChatEvent(e, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read' });
  e = applyChatEvent(e, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ab' }] } });
  const msg = e.find(x => x.kind === 'message' && x.role === 'assistant');
  expect(msg).toMatchObject({ text: 'ab', streaming: true });
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

重写 `applyChatEvent` 的 message / tool 分支：换槽对准 `streaming===true`。`applySurfaceEvent`：custom 按 id；user 按末条相同文本去重。`eventLabel` 加 default。ChatWorkbench 改 Pi 形状。合同刷新触发改 `message_end`。

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
  snapshot: { entries: unknown[]; streamingMessage?: unknown | null; streaming?: boolean },
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
   若 snapshot.streamingMessage → 折进列表
   槽的 streaming 标志 = snapshot.streaming（不要用「有没有 streamingMessage」当转圈）
5. 按顺序 apply buffer（custom 按 id 去重）
6. setState 一次铺底
7. 之后事件直接 apply，不再用这次快照
```

`compaction_end` 成功：再走 1–6（新 gen）。不要用 `buildContextEntries()`。

从历史打开再续问：`sessionId` 不变则 effect **不重跑**，即使后来进程活了、`openChatSession` 若被别人调用返回更短列表，hook 也不要用新快照覆盖已画内容。不要在 prompt 成功后再 `openChatSession` 清屏。`mode` 不切断数据面。

`session_unbound` 且 `sessionId` 匹配：`streaming=false`，不清 entries。

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
- Modify: `apps/desktop/electron/main/ipc.ts`（`open.slot.supervisor.onExit`）
- Test: `apps/desktop/test/ipc.test.ts`

**行为：**

```text
ipc **只**在 `ensureProcessPipe` 里按 `client` 订一次 `supervisor.onExit`（与管子同一套 WeakMap 去重）。不要在 `ensureOpenSession` 再订，否则崩溃会打 N 次 log、卸 N 次。

不要把崩溃生命周期扩进 PiRuntimePool（池子仍无 onExit 接线，本轮不扩）。

子进程退出：
  logger.error({ msg: 'pi runtime exited', ctx: { sessionId: getSessionId(), code } })
  不要把 streamingMessage 写进 jsonl
  走与手动释放相同的 ipc 卸下：session_unbound → pool.release（内部先 null）
再打开：死了路径（JSONL），没有 preview
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

- [ ] **Step 2–4:** FAIL → ipc 订 `supervisor.onExit` 并走现有 unbind → PASS。不要新通道，不要改池子生命周期。

- [ ] **Step 5: Commit**

```text
stop live pipe and log when pi process exits
```

---

### Task 8: 夹具与回归改成 Pi 原形状

**Files:**
- Modify tests: `app-general.test.tsx`、`standard-chat.test.tsx`、`use-agent-session.test.ts`、`ipc.test.ts`、以及任何仍发 `{ type:'message', delta }` / `tool_call` 的 live 夹具
- ChatWorkbench 夹具在 Task 5 已改，这里只扫漏
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
rg "acc \\+= e.delta" apps/desktop/electron/main/workflow.ts
rg "type: 'message', role: 'assistant', delta" apps/desktop/src packages
rg "open\\.offEvents" apps/desktop/electron/main/ipc.ts
rg "buildContextEntries" apps/desktop/src apps/desktop/electron packages/agent-host/src
```

workflow 空 catch 必须为 0。`sendPrompt` 不得 `+= delta`。ipc 不得再 `offEvents?.()`。不得用 `buildContextEntries` 当起步。

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

- 第 7 条把「画」和「送达 / 折进列表」切开：本 plan 改 pipe + `apply*` + hook，不改 Agent 控件清单。未知 type 留在列表但详情级默认 debug，禁止为此把 `?? 'debug'` 改成 standard。
- `NormalizedEvent` 必须开放，否则 Task 1 会在类型层重新做允许名单。
- 盖章读活牌子，idle-release / settled 也要用当时的 id，否则会 release 错会话。
- `getSessionId` 必须闭包内部 Slot；WeakMap 键是 `client`。
- 微缝只在 `isStreaming && !streamingMessage` 时打 `get_messages`，避免 renderer 三路投票。
- 测试先于实现。旧「扁 delta」测试是要改的规格，不是要迁就的兼容层。
- `sendPrompt` 与 `normalizeEvent` 必须同一任务改，否则合同步骤 output 变空。
