# 会话与运行时线程生命周期设计

- 日期：2026-08-29
- 状态：spec，待用户评审
- 范围：通用智能体会话的 draft / committed / lease 生命周期、空会话策略、运行时槽位释放策略
- 前置文档：
  - `docs/superpowers/specs/2026-08-26-session-storage-and-credentials-design.md`
  - `docs/superpowers/specs/2026-08-28-runtime-pool-management-design.md`
  - `docs/superpowers/specs/2026-08-25-general-agent-design.md`

## 1. 背景

当前通用智能体会话存在以下问题：

1. 新建会话会立即 `acquire` Pi runtime slot，并写入 `sessions.db`，因此空会话也会占线程并出现在历史里。
2. 用户可以重复创建多个空会话。
3. 打开历史会话后，`getChatState` 会通过 `ensureOpenSession` 拉起线程。
4. 线程只在用户手动“释放槽位”或删除会话时释放，切换会话、关闭 surface 都不会释放。
5. Sparkii 在 `PiRuntimePool` 里维护了一套自己的运行状态，和 Pi 原生生命周期有重叠。

本设计的目标是让 Sparkii 直接贴合 Pi 的会话生命周期，只维护必要的进程租约和产品策略，避免重复状态机。

## 2. 目标与非目标

### 目标

- 空会话不启动线程，不写数据库，不出现在会话历史。
- 同一时间只能存在一个空会话。
- 第一次真正需要运算时才 `acquire` 一个 runtime slot。
- Pi 会话 settle 后，在宽限期内无新任务时自动释放 slot。
- 用户重新打开历史会话时，能从 `sessionFile` 恢复上下文继续对话。
- 保留 Pi 进程池和进程复用能力。
- 用 `agent_settled` 作为 release 的唯一 Pi 生命周期信号。

### 非目标

- 不删除或重建 Pi 会话 jsonl。
- 不在每次 `agent_end` 后立即释放线程。
- 不做 LRU 抢占式释放；先使用固定 grace timeout。
- 不在 Sparkii 内重新实现 Pi 的 `compacting / retrying / streaming` 状态。
- 不改变审批与审计的安全模型。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| Draft Session | 前端可见但尚未产生 Pi 会话的空会话；无 `sessionId`、无 jsonl、无线程 |
| Committed Session | 已产生 Pi jsonl 的会话；可能当前占用 slot，也可能不占用 |
| Lease | 一个 committed session 临时占用某个 Pi runtime slot |
| Runtime Slot | `PiRuntimePool` 中的一个可复用 Pi 子进程 |
| `sessionFile` | 当前 Pi 会话对应的 JSONL 文件绝对路径，是会话上下文的事实源 |
| `agent_settled` | Pi 原生事件，表示没有 retry、compaction retry 或 queued continuation 会自动继续 |

## 4. 现状与问题根因

关键位置：

- `apps/desktop/electron/main/ipc.ts`
  - `sparkii:newChatSession` 立即 acquire、创建 Pi session、写入 `chat_sessions`。
  - `sparkii:getChatState` 调 `ensureOpenSession`，导致打开历史会话也会 acquire。
  - `openSessions`、`appliedModelBySession`、`titledSessions` 等 map 分散维护。
- `packages/agent-host/src/pi-runtime-pool.ts`
  - 维护 `RuntimeSessionStatus` 和事件到状态的转换。
- `apps/desktop/src/App.tsx`
  - `onNewSession('general')` 直接调用 `newChatSession`，无法区分 draft 与 committed。

## 5. 已确认决策

| 主题 | 决策 |
| --- | --- |
| Pi 生命周期 | 以 Pi 原生事件和 `get_state` 为权威，Sparkii 不重复维护会话状态 |
| 空会话 | 完全作为前端 UI 状态，不创建主进程 draft 对象 |
| 空会话去重 | 由前端 `screen === 'general' && sessionId === null` 保证 |
| 首次 prompt | 使用单个原子 IPC 创建 Pi session、写索引、发送 prompt |
| 历史会话打开 | 只读 jsonl，不 acquire |
| 历史会话再次提问 | 无 lease 时重新 acquire，并恢复 saddle / model / key / thinking |
| 释放触发 | `agent_settled` 是唯一 Pi 生命周期触发点 |
| 释放前状态检查 | 不重复检查 steering / followUp / pendingMessageCount / retry / compaction |
| 审批未决 | 审批等待发生在 tool execute 内，Pi 不会 settle；不额外阻止 release |
| 释放方式 | `pool.release(sessionId)`，发送 `new_session`，进程回池复用，不 kill |
| Grace period | 默认 60 秒，可配置 |
| 释放路径 | 所有会话统一走 `agent_settled -> 60s grace timer -> release`，不因离开 surface 单独提前释放 |
| 运行时状态 | 移除 Sparkii 自定义状态机，只保留 `lease` 存在与否 |

## 6. 目标架构

```text
Renderer
  ├─ App.tsx
  │    ├─ screen / activeGeneralSession
  │    └─ draft 模式：sessionId === null
  ├─ GeneralChatSurface
  │    ├─ 历史会话：openChatSession 只读
  │    └─ 空会话：首次发送调用 promptDraftSession
  └─ Shell / RuntimeCenter

Electron IPC
  ├─ promptDraftSession(profileId, text, context)
  ├─ openChatSession(sessionId)
  ├─ promptSession(sessionId, text, options?)
  ├─ getChatState(sessionId)
  ├─ listChatSessions(profileId?)
  ├─ deleteChatSession(sessionId)
  ├─ releaseSessionSlot(sessionId)
  └─ chat-event / runtime-pool 事件

Main Process
  ├─ session-leases.ts
  │    ├─ ensureLease(sessionId)
  │    ├─ releaseLease(sessionId)
  │    ├─ scheduleIdleRelease(sessionId)
  │    └─ cancelIdleRelease(sessionId)
  ├─ PiRuntimePool
  ├─ ChatSessionStore
  └─ Pi event stream（agent_settled 等）
```

主进程只维护两个会话相关 map：

```ts
leases: Map<string, SessionLease>
idleTimers: Map<string, NodeJS.Timeout>
```

不再维护 `drafts` map，也不再维护 Sparkii 自定义的会话运行状态。

## 7. 数据模型

### 7.1 `SessionLease`

```ts
export interface SessionLease {
  sessionId: string;
  profileId: string;
  slot: PiRuntimeSlot;
  offEvents?: () => void;
}
```

约束：

- 一个 `sessionId` 最多对应一个 lease。
- lease 不保存 Pi 事件状态，只保存 Sparkii 需要的资源信息。
- idle timer 单独放在 `idleTimers` map，不混入 lease。

### 7.2 `DraftPromptContext`

空会话没有主进程对象。首次 prompt 时，前端把 draft 阶段的用户偏好一起传入：

```ts
export interface DraftPromptContext {
  profileId: string;
  workspacePath?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
}
```

### 7.3 `sessionFile`

`sessionFile` 是 Pi 会话的 JSONL 文件绝对路径，保存：

- session header；
- user / assistant 消息；
- tool call / tool result；
- compaction 摘要；
- branch summary；
- model / thinking level 变化；
- `session_info` 标题。

`sessions.db` 只保存：

- `id`
- `profileId`
- `workspaceKind`
- `workspacePath`
- `model`
- `thinkingLevel`
- `piSessionFile`
- 创建和更新时间

消息正文始终只存在于 Pi jsonl 中。

## 8. 会话生命周期

### 8.1 新建空会话

```text
用户点击“新会话”
  -> 前端设置 screen = general
  -> 前端设置 activeGeneralSession = null
  -> 前端进入 draft 输入状态
  -> 不调用任何 IPC
```

不创建：

- `sessionId`；
- `sessions.db` 记录；
- Pi jsonl；
- runtime slot。

### 8.2 首次 prompt

```text
用户发送第一条消息
  -> 前端调用 promptDraftSession(profileId, text, context)
  -> 主进程创建 Pi session
  -> acquire runtime slot
  -> 写入 sessions.db
  -> 发送 prompt
  -> 返回真实 sessionId
```

任一步失败：

- 释放 slot；
- 删除已写入的 `sessions.db` 记录；
- 不产生空历史会话。

### 8.3 打开历史会话

```text
用户点击历史会话
  -> 前端设置 activeGeneralSession = realSessionId
  -> 调用 openChatSession(sessionId)
  -> 主进程只读 jsonl
  -> 不 acquire
```

### 8.4 历史会话再次提问

```text
promptSession(sessionId, text)
  -> 已有 lease：复用 slot
  -> 没有 lease：
       acquire slot
       configure_session(saddle)
       switch_session(sessionFile)
       set_api_key
       set_model
       set_thinking_level
  -> 发送 prompt
```

不需要恢复 steering / followUp，因为 release 只发生在 `agent_settled` 后，此时队列已空。

## 9. IPC 契约

### 9.1 `promptDraftSession`

```ts
promptDraftSession(
  profileId: string,
  text: string,
  context: DraftPromptContext,
): Promise<{
  ok: boolean;
  sessionId: string;
  behavior: 'prompt' | 'steer' | 'followUp';
}>
```

职责：

- 创建真实 Pi session；
- acquire slot；
- 写 `sessions.db`；
- 发送 prompt；
- 返回真实 `sessionId`。

### 9.2 `openChatSession`

```ts
openChatSession(sessionId: string): Promise<{
  messages: unknown[];
  entries?: unknown[];
}>
```

只读，不 acquire。

### 9.3 `getChatState`

```ts
getChatState(sessionId: string): Promise<ChatQueueState>
```

规则：

- 如果 session 有 lease，从 runtime 读取；
- 否则返回默认 idle 状态，不 acquire。

### 9.4 `promptSession`

```ts
promptSession(
  sessionId: string,
  text: string,
  options?: { behavior?: 'steer' | 'followUp' },
): Promise<{ ok: boolean; behavior?: 'prompt' | 'steer' | 'followUp' }>
```

只用于 committed session。

### 9.5 `releaseSessionSlot`

```ts
releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>
```

手动释放当前 lease，用于运行中心或应用退出等显式用户/系统动作。

注意：正常离开会话 surface 不调用这个接口，也不提前释放；统一交给
`agent_settled -> 60s grace timer -> release`。

### 9.6 `deleteChatSession`

删除 committed session：

- 有 lease 时先释放；
- 删除 `sessions.db` 记录；
- 删除或允许用户删除 Pi jsonl。

### 9.7 `listChatSessions`

```ts
listChatSessions(profileId?: string): Promise<unknown[]>
```

只返回 committed session：

```text
listPiSessions()
  -> 用 sessions.db 补充 profileId / workspace / model
  -> 返回
```

不再合并空会话记录。

## 10. 释放策略

### 10.1 触发条件

```text
agent_settled
  -> 启动 60 秒 grace timer
  -> 60 秒内没有新 prompt
  -> releaseLease(sessionId)
```

不检查：

- `steering`
- `followUp`
- `pendingMessageCount`
- `compaction`
- `retry`
- `pending approval`

理由：这些自动继续的情况都由 Pi 的 `agent_settled` 覆盖；审批未决时 Pi 不会 settle。

### 10.2 释放流程

```text
releaseLease(sessionId)
  -> get_state()
  -> 保存 sessionFile 到 sessions.db
  -> 取消事件订阅
  -> pool.release(sessionId)
  -> 删除 lease
  -> 删除 idle timer
```

`pool.release` 内部：

```text
发送 new_session
slot.sessionId = null
slot 回到空闲
进程保留并复用
```

不 kill Pi 进程。

### 10.3 新任务中断 grace timer

```text
grace timer 尚未到期，用户发送新 prompt
  -> 取消 timer
  -> 复用当前 lease
```

如果已经 release，则按历史会话再次 acquire。

### 10.4 离开会话 surface

用户切换页面、打开其他会话或回到首页时，不立即释放 lease。

如果会话还在运行，等它自然 `agent_settled`；如果已经 settled，则复用之前已经启动的
grace timer。

### 10.5 应用退出

应用退出前：

- 对仍占用的 lease 执行最终 release 或 abort 后 release；
- `pool.stopAll()` 负责最终回收进程。

## 11. 审批交互

审批等待发生在 Sparkii 工具执行的 `await ctx.propose(...)` 内。

因此：

- 审批未决时，Pi agent run 仍 active；
- Pi 不会发出 `agent_settled`；
- release 不会误触发。

审批超时由 Sparkii 配置控制：

```yaml
timeoutMs: 300000
```

超时后 proposal 变为 `expired`，按拒绝返回，Pi 继续执行并最终 settle。

## 12. UI 行为

### 12.1 空会话

- `activeGeneralSession === null` 时显示 composer draft 模式。
- 再次点击“新会话”不创建新对象，只保持当前 draft。
- 离开 general surface 时空会话丢弃，不进入历史。

### 12.2 历史列表

- 只显示 committed session。
- 标题优先使用 Pi `session_info`，其次首条用户消息，最后时间戳。

### 12.3 运行中心

- 只展示当前有 lease 的 session。
- `running` 从 Pi 事件推导。
- `waiting-approval` 从 Sparkii pending approval 推导。
- “释放槽位”直接调用 `releaseSessionSlot`。

## 13. 错误处理

- `promptDraftSession` 创建失败时不留下空会话记录。
- `pool.release` 失败时保留 lease，记录日志，不删除会话。
- `get_state` 失败时不更新 `sessionFile`，也不执行 release。
- 空闲释放失败后允许下次重试，不阻塞新 prompt。

## 14. 测试策略

### 14.1 agent-host 单元测试

- `PiRuntimePool.release` 只重置 session 并复用 slot，不 kill 进程。
- acquire / release 后 `bySession` 和 slot 状态正确。

### 14.2 desktop IPC 测试

- `promptDraftSession` 创建 session、写索引、发送 prompt、返回真实 id。
- `promptDraftSession` 失败时清理 slot 和索引。
- `openChatSession` 不触发 `pool.acquire`。
- `getChatState` 对无 lease 会话不触发 `pool.acquire`。
- 收到 `agent_settled` 后启动 idle timer，超时后 release。
- 收到新 prompt 时取消 idle timer。
- 用户离开会话 surface 不会立即 release，也不会改变统一的 grace timer 路径。

### 14.3 UI 测试

- 点击“新会话”只进入 draft，不调用 `newChatSession` / `promptDraftSession`。
- 空会话不出现在历史列表。
- 首次发送调用 `promptDraftSession`。
- 历史会话打开时不触发 acquire 相关调用。

## 15. 自检记录

- 无 TBD / TODO。
- 空会话不产生后端对象，不进入历史。
- 首次 prompt 使用原子 IPC，失败可清理。
- 释放条件只依赖 `agent_settled`，不重复检查 Pi 内部队列。
- 审批未决不会导致 Pi settle，因此不会误释放。
- 没有引入大型 `SessionCoordinator` 状态机。
- 主进程只保留 `leases` 和 `idleTimers`。
- 所有自动释放都走同一条 `agent_settled -> 60s grace timer` 路径。

## 16. 落地顺序建议

1. 抽取 `session-leases.ts`，统一 acquire / release / idle timer。
2. 移除 `newChatSession` 对空会话的提前 acquire 和落库。
3. 增加 `promptDraftSession` 原子 IPC。
4. 修改 `openChatSession` / `getChatState`，无 lease 时不 acquire。
5. 接入 `agent_settled` 事件和 60 秒 grace timer。
6. 修改前端空会话与首次 prompt 流程。
7. 简化 `listChatSessions`，移除空会话合并逻辑。
8. 补充单元、IPC 和 UI 测试。
