# Sparkii Desktop 运行线程池同步与运行中心设计规格

- 日期：2026-08-28
- 状态：设计已确认，待实施
- 范围：Pi 线程池实时快照、底部状态栏、运行中心抽屉、运行参数设置
- 前置文档：
  - `docs/superpowers/specs/2026-08-25-sparkii-desktop-ux-design.md`
  - `docs/superpowers/specs/2026-08-25-general-agent-design.md`
  - `docs/superpowers/specs/2026-08-28-ui-foundation-and-component-library-design.md`

## 1. 背景与目标

当前底部状态栏显示的 `运行 0/4` 不是真实线程池状态。`Shell` 从 `agents` 数组的
`status` 计算运行数和排队数，而 `App.tsx` 初始化智能体时把状态固定为 `idle`；
主进程的 `PiRuntimePool` 没有向渲染进程暴露快照，也没有订阅式事件。

本规格的目标：

1. 让底部状态栏显示真实线程池运行数和排队数。
2. 让左栏智能体、首页智能体卡片从同一份快照推导状态。
3. 在底部状态栏提供“运行中心”入口，支持查看运行中会话、排队项，并执行
   “停止会话 / 释放槽位 / 取消排队”。
4. 在设置页把并发上限、排队开关等运行参数接成真实配置。

## 2. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 用户权限 | 不区分普通用户和管理员，所有功能全量提供 |
| 运行中心入口 | 只放在底部状态栏；点击摘要行打开运行中心抽屉 |
| 设置页摘要 | 不在设置页重复展示运行摘要 |
| 停止会话语义 | 复用通用聊天的 `abortChat`：清队列 → `abort` → 等待 idle；保留会话和槽位 |
| 释放槽位语义 | 重置当前 Pi 会话并把工作进程放回可复用池；不 kill 进程 |
| 终止进程 | 本次不做 |
| 并发上限 | 仍放在“设置 → 智能体与运行”，真实生效 |

## 3. 非目标

- 不做硬性进程 kill / 重启工作进程。
- 不做多用户权限隔离或角色差异。
- 不做空闲槽位自动超时回收。
- 不改变现有合同审核与通用智能体的业务流程。
- 不引入新的第三方大型 UI 框架。

## 4. 架构总览

```text
Renderer
  ├─ App.tsx：持有 RuntimePoolSnapshot 状态，订阅 runtime-pool 事件
  ├─ Shell / StatusBar：底部摘要按钮，点击打开运行中心抽屉
  ├─ RuntimeCenter：运行中列表、排队列表、操作与确认
  └─ SettingsView：真实运行参数设置

Electron IPC
  ├─ getRuntimePool()
  ├─ cancelQueuedSession(queueId)
  ├─ releaseSessionSlot(sessionId)
  └─ runtime-pool 事件推送

Main Process
  └─ PiRuntimePool
       ├─ 保存槽位 / 会话 / 排队元数据
       ├─ 维护订阅者并推送快照
       ├─ 支持取消排队、释放槽位
       └─ 支持动态更新 maxAgents / queueEnabled
```

## 5. 数据模型

### 5.1 池快照

主进程向渲染进程推送的运行时快照：

```ts
export type RuntimeSessionStatus =
  | 'starting'
  | 'streaming'
  | 'waiting-approval'
  | 'occupied-idle';

export interface RuntimeSlotView {
  slotId: string;
  sessionId: string;
  profileId: string;
  profileName: string;
  label: string;
  status: RuntimeSessionStatus;
  startedAt: number;
}

export interface RuntimeQueueItemView {
  queueId: string;
  profileId: string;
  profileName: string;
  label: string;
  position: number;
}

export interface RuntimePoolSnapshot {
  maxAgents: number;
  active: number;
  queued: number;
  slots: RuntimeSlotView[];
  queue: RuntimeQueueItemView[];
}
```

约束：

- `active` 等于 `slots.length`。
- 空闲槽位不进入 `slots` 列表，其数量由 `maxAgents - active` 表达。
- `queue` 按 `position` 升序排列。
- 快照中不包含 API key、文件系统路径等敏感信息；只保留界面展示和操作所需的标识。

### 5.2 池内部扩展

`PiRuntimePool` 需要支持：

- `acquire(sessionId, options)` 的 `options` 增加可选 `meta`：

```ts
interface RuntimeAcquireMeta {
  profileId: string;
  profileName?: string;
  label?: string;
}
```

- 排队项需要保存完整的 `AcquireOptions`，在槽位释放时原样重新绑定，不能丢失
  `saddle`、`resumeSessionFile` 和 `meta`。
- 排队项需要稳定的 `queueId`，用于渲染端取消排队。
- 池内任何 `acquire / bind / release / renameSession / cancelPending / setMaxAgents`
  成功或失败后，都要推送一次最新快照。

## 6. IPC 契约

新增以下方法：

```ts
getRuntimePool(): Promise<RuntimePoolSnapshot>;
cancelQueuedSession(queueId: string): Promise<{ ok: boolean }>;
releaseSessionSlot(sessionId: string): Promise<{ ok: boolean }>;
```

新增事件：

```ts
on('runtime-pool', (snapshot: RuntimePoolSnapshot) => void): () => void;
```

### 6.1 `getRuntimePool`

返回当前池快照。用于渲染端首次加载和断线恢复。

### 6.2 `cancelQueuedSession`

- 按 `queueId` 找到排队项。
- 从 `pending` 中移除。
- 使等待中的 `acquire` promise 以 `RUNTIME_QUEUE_CANCELLED` 语义拒绝，避免
  调用方永久挂起。
- 推送快照。

### 6.3 `releaseSessionSlot`

- 如果会话仍在 `openSessions` 中，先通过 `get_state` 更新 `pi_session_file`。
- 取消该会话的事件订阅，从 `openSessions` 和 `appliedModelBySession` 移除。
- 调用 `rt.pool.release(sessionId)`，使工作进程复位并复用。
- 不删除 `chat_sessions` 中的会话记录。
- 推送快照。

## 7. UI 信息架构

### 7.1 底部状态栏

`StatusBar` 从外部接收 `RuntimePoolSnapshot`，显示：

```text
运行 {active}/{maxAgents} · {queued} 排队
```

整行是一个按钮，带 hover、focus ring、chevron 和可访问名称：

```text
aria-label="打开运行中心，当前运行 2/4，排队 1"
```

数字变化使用 `role="status"` 和 `aria-atomic="true"`，让屏幕阅读器读到完整语境，
而不是只播报一个裸数字。

### 7.2 运行中心抽屉

由底部状态栏打开，右侧抽屉结构：

```text
运行中心
运行 2/4 · 排队 1 · 空闲 2

运行中
通用智能体 · 会话#7    生成中      [停止] [释放槽位]
合同审核 · 会话#3      等待审批    [停止] [释放槽位]

排队中
通用智能体 · 新会话    第 1 位    [取消排队]
合同审核 · 新会话      第 2 位    [取消排队]
```

规则：

- 停止会话只在 `streaming` 或 `waiting-approval` 可用；`occupied-idle` 禁用。
- 释放槽位只要槽位被占用即可用；点击后确认。
- 取消排队只出现在排队列表。
- 空态分别为“暂无运行中的智能体”和“暂无排队任务”。
- 整个池为空时，显示“当前没有正在运行的会话”。
- 危险操作使用确认；确认后 loading；成功用 toast，失败在行内显示错误。

### 7.3 左栏与首页

左栏 `AgentNav` 和首页 `HomeView` 不再从静态 `agents` 状态推断运行情况，而是由
`App.tsx` 根据 `RuntimePoolSnapshot` 计算每个 profile 的状态：

- 该 profile 有 `slots` 项 → `running`
- 否则该 profile 有 `queue` 项 → `queued`
- 否则 → `idle`

## 8. 用户旅程

```text
启动
→ 底部状态栏显示真实 0/4
→ 点击摘要打开运行中心
→ 新建会话
   ├─ 有空闲槽位：直接进入运行中，状态栏 1/4
   └─ 无空闲且开启排队：进入排队列表，显示位次
→ 停止会话：当前轮优雅停止，会话和槽位保留
→ 释放槽位：会话离开运行中，工作进程重置为可复用
→ 排队的下一个会话自动顶上
→ 取消排队：从等待队列移除
```

释放槽位后自动顶上的关键约束：下一个排队项必须使用自己保存的
`saddle / resumeSessionFile / meta` 绑定，不能继承上一个会话的残留配置。

## 9. 设置页

“设置 → 智能体与运行”不展示运行摘要，只展示并真实生效以下配置：

- 并行智能体上限：1–8，默认 4。
- 超出上限时排队：开关。
- 崩溃自动恢复：开关。
- 日志级别：信息 / 调试 / 警告。

行为：

- 降低上限不强制终止正在运行的会话，只影响后续新会话。
- 上限调整即时应用到池的准入逻辑，不需要重启应用。
- 排队关闭且达到上限时，新会话创建立即报错。

## 10. 错误处理与状态

- 首次加载运行池快照时显示“正在读取运行状态…”。
- 获取失败时运行中心显示错误和“重试”入口。
- 停止 / 释放 / 取消操作失败时，在对应行内显示错误，不关闭抽屉。
- 排队项被取消后，其等待中的创建 promise 以可识别错误结束，调用方不悬挂。

## 11. 测试策略

### agent-host 单元测试

- 池在 acquire / release / renameSession / cancelPending / setMaxAgents 后推送快照。
- 排队项保存完整 acquire options，释放后原样绑定。
- `cancelPending` 取消正确队列项并拒绝对应 promise。
- `setMaxAgents` 调整准入上限但不回收现有槽位。

### desktop 单元测试

- `getRuntimePool` 返回池快照。
- `cancelQueuedSession` 和 `releaseSessionSlot` 调用正确的池方法。
- `StatusBar` 使用快照显示运行数 / 排队数。
- `RuntimeCenter` 渲染运行中、排队、空态，并按状态禁用操作。

## 12. 自检记录

- 无 TBD / TODO。
- 停止、释放、取消排队语义与第 2 节决策一致。
- 快照、IPC、UI 状态和测试策略中的字段名保持一致。
- 范围聚焦于线程池同步、运行中心和设置参数，不含进程 kill 或空闲回收。
