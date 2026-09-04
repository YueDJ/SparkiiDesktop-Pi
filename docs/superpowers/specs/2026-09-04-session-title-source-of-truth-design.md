# Session Title Source of Truth — Design Spec

**Status:** Draft (pending human review)
**Date:** 2026-09-04
**Branch:** `cursor/session-title-source-of-truth-3fdc`
**Supersedes:** `docs/superpowers/specs/2026-08-26-session-storage-and-credentials-design.md` §5.2（平台在 `agent_end` 后自动起名）
**Depends on:** 薄契约 / Agent 与平台分责（`2026-09-01`、`2026-09-02`、`2026-09-03`）

## Goal

把所有智能体的会话显示名收成一条路：

- **名字写在哪里：** 只写 Pi jsonl 的会话名（`set_session_name` / `session_info`）。
- **谁起名：** 各 Agent 自己的策略。平台不起名、不改名、不截断。
- **谁显示：** 平台在 jsonl 名字变化后，立刻插入或更新侧栏。没有这一行就插入，有就改标题。

合同审核、通用智能体、以后的 Agent，都走同一条「公布标题」能力。

## Confirmed Decisions

1. **Pi jsonl 的会话名是唯一真相。** 界面缓存、`sessions.db`、`firstMessage` 都不是标题权威。`sessions.db` 继续不存 title。
2. **起名在 Agent。** 叫什么、截多长、改几次、要不要用模型，都是该 Agent 的策略。
3. **平台不起名。** 不提供「起短名」API，不在主进程写起名 prompt，删除 `maybeGenerateTitle` 以及 `agent_end` 自动起名。
4. **平台只做公布：** 收到 `(sessionId, title)` → 写入 Pi → 广播现有 `session_title` → 侧栏插入或改名。给什么认什么。
5. **不新开事件通道。** 继续用 `sparkii:setChatTitle` + `chat-event` 的 `{ type: "session_title", sessionId, title }`。语义从「改个标题」升级为「公布标题」。
6. **平台生产代码不按 agent id 分支。** `App.tsx` / `ipc.ts` 不出现「合同用文件名、通用走两步」这类判断。
7. **合同审核：** 用户点「开始审核」且已有 `sessionId` 后，公布一次，title = 合同文件名（含扩展名，不截断）。未点开始、只有本地选文件时不公布（还没有会话）。
8. **通用智能体，两步，都在 `agents/general`：**
   1. 第一条用户消息发出、会话 id 可用：先公布占位名 = 该条可见文本截到 20 字。
   2. 第一条助手回复出现后：Agent 自己用「用户第一句 + 助手第一句」向模型要一个不超过 20 字的短名，再公布一次。
9. **截断是 Agent 的事。** 平台写入和显示都不截断。通用占位和短名按 JS 字符串 `slice(0, 20)`（中文一字一长度）。合同文件名不截。
10. **侧栏有名就立刻出现。** 公布是插入侧栏的唯一正规入口。`openSession` / `startWorkflow` 只绑定当前会话 id，不再编一个「新对话」当产品标题。
11. **后写覆盖先写。** 平台不锁「已经起过名就不能再写」。通用 Agent 自己保证短名只试一次；若用户已把占位名改成别的，Agent 不再覆盖。
12. **用户侧栏手动改名** 也走同一条公布路径。
13. **列表接口的 `title` 只来自 Pi `name`。** 不再把 `firstMessage` 填进 `title`。`firstMessage` 可另字段留给无标题旧会话做只读兜底。
14. **补全不是起名。** 通用 Agent 起短名若需要问模型，走无业务语义的一次性补全（Pi 已有 `complete` RPC）。prompt、截断、何时调用全部在 Agent。平台不写「请为以下对话生成标题」。
15. **旧会话不回填。** 历史上没有 `name` 的会话保持原样；界面可用截断的 `firstMessage` 或时间做只读兜底，不写回 Pi。

## Current State (why it is tangled)

今天标题有三条互不相认的路：

| 路径 | 谁在做 | 写不写 Pi | 侧栏 |
| --- | --- | --- | --- |
| 通用首条发送 | `App.commitNewSession` 用用户原文或「新对话」 | 否 | 立刻插一行 |
| 通用第一轮结束 | 主进程 `maybeGenerateTitle`（workflow 跳过） | 是 | 只改已有行 |
| 合同开始审核 | Contract Surface `setChatTitle(文件名)` | 是 | 广播只改已有行，工作流从不插行，所以当时看不见 |

后果：

- 通用侧栏上的第一个名字不是 Pi 里的名字。
- 短名策略写在平台，合同策略写在 Agent。
- 工作流未命名时，`listChatSessions` 用整段 `firstMessage`（往往是很长的 workflow prompt）当 title。
- `session_title` 监听器只 `map` 已有行，不会插入。

## Architecture

```text
Agent（想名字）
  合同：开始审核 → 文件名
  通用：首条用户消息 → 占位（≤20）
        首条助手回复 → Agent 自己补全短名（≤20）
  用户：侧栏手动改名
            │
            ▼
  sparkii:setChatTitle(sessionId, title)     // 唯一公布口
            │
            ▼
平台主进程
  trim；空串拒绝（不写、不广播）
  set_session_name → Pi jsonl session_info     // 唯一落盘
  chat-event session_title                     // 唯一通知
            │
            ▼
平台界面
  侧栏按 sessionId upsert（无则插入，有则改名）
  当前会话顶栏跟着改
  刷新列表时：Pi name 优先；没有 name 才用截断 firstMessage / 时间
```

三层各做一件事：

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| Agent | 决定字符串和时机 | 不改侧栏 DOM / 不直接写 jsonl |
| 平台写入 | 写 Pi + 广播 | 不猜文件名、不起短名、不截断 |
| 平台显示 | upsert 侧栏 | 不编「新对话」当产品名 |

`apps/desktop/src/surface/**` 继续不 import `agents/**`。通用策略只放在 `apps/desktop/agents/general/**`。合同策略只放在 `apps/desktop/agents/contract-review/**`。

## Platform Capability

### 公布：现有 `sparkii:setChatTitle`

输入：`sessionId: string`，`title: string`。

行为：

1. `title = title.trim()`。空串 → `{ ok: false }`，不写 Pi，不广播，侧栏不动。
2. 对已打开会话发 `set_session_name`；未打开则按现有逻辑 acquire 后再发。写入失败不抛给主流程，不重试起名。
3. 广播 `{ type: "session_title", sessionId, title }`（可用乐观广播：先通知界面，Pi 异步写）。
4. 返回 `{ ok: true }` 表示已接受这次公布，不表示磁盘一定已刷完。

删除：

- `maybeGenerateTitle`
- `titledSessions`（它只为「平台自动起名不要覆盖用户改名」服务；平台不再自动起名）
- `agent_end && rec.kind !== 'workflow'` 这条起名分支

不新增：`generateTitle` / `suggestTitle` / `publishTitle` 等第二套 IPC。

### 显示：`session_title` 改为 upsert

`App.tsx` 收到 `session_title`：

- 该 `sessionId` 已在某个 Agent 的列表里 → 只改 `name`。
- 不在任何列表里 → 插入到**当前拥有该会话的 Agent**（`activeSessionByAgent` / `workflowByAgent` / `chatSessions.profileId` 已能归属）。插在未置顶可见会话的最前（与今天 `commitNewSession` 的位置规则一致：置顶组之后、未置顶之前）。
- 若该会话正是某 Agent 的当前会话 → 同步顶栏 `title`。

`openSession(id)` / `startWorkflow`：

- 只设置 `activeSessionId` / `workflow.sessionId`。
- 不再调用「用一段话当名字并插入侧栏」。
- `openSession` 的可选 `title` 参数停止使用（可留着以免立刻改契约，但平台忽略它）。

`commitNewSession` 不再是标题来源。首条消息后的侧栏出现，必须来自 Agent 的第一次公布。

用户手动改名：继续 `onRenameSession` → 本地先改（避免闪旧名）→ `setChatTitle` → 刷新。与 Agent 公布同一条写入。

### 列表读取

`listChatSessions`：

```text
title: s.name || undefined
firstMessage: s.firstMessage          // 独立字段，不再并进 title
```

`sessionDisplayName`：

1. 有 `title`（Pi name）→ 原样显示，不再截断。
2. 否则有 `firstMessage` → `slice(0, 20)`，只读兜底。
3. 否则时间；再否则「会话」。

兜底绝不 `set_session_name`。

刷新仍以数组为顺序真相；刷新只更新已有行的元数据、补齐磁盘上多出来的会话、去掉已删除的。新会话的**第一次出现**优先走 `session_title` upsert，而不是等下一次 `listChatSessions`。

## Agent Policies

### 合同审核（`agents/contract-review`）

已经在 Surface 里：`sessionId` + 文件名齐了就 `setChatTitle(sessionId, fileName)`，每会话一次。

本次只要求：

- 触发点仍是「开始审核之后」有了 `sessionId`，不是选文件当时。
- 文件名不截断、不去扩展名。
- 公布之后侧栏必须立刻出现这一行（靠平台 upsert，不再等刷新）。
- Surface 继续只公布一次；用户之后手动改名，合同 Agent 不再覆盖。

### 通用智能体（`agents/general`）

今天 `agents/general/surface/index.tsx` 只是 `export default StandardChatSurface`。两步策略加在 **general 包内的包装层**，不要写进 `src/surface/standard-chat.tsx`。

包装层仍渲染 `StandardChatSurface`，自己看 props 里的 `sessionId` 与 `session.entries`：

**第一步 — 占位名**

- 条件：`sessionId` 有值，且时间线上已有第一条用户可见文本。可见文本 = 已写入会话的那条用户正文（与 `StandardChatSurface` 发出的 `display` 相同，含附件前缀），不是平台另算的摘要。
- 名字：`trim` 后 `slice(0, 20)`；若截完为空，用「新对话」。
- 立刻 `setChatTitle`。每会话只做一次。

**第二步 — 短名**

- 条件：第一步已做；时间线上已有第一条助手可见正文；本会话还没尝试过短名。助手可见正文 = 第一条带非空 `content` 文本的助手消息；纯思考 / 纯工具块不算。
- Agent 自己组 prompt（例如：用这两段话起一个不超过 20 字的中文标题，只输出标题）。
- 经无业务语义的补全拿到字符串，`trim` + `slice(0, 20)`；空则保持占位名，不再写。
- 若此时侧栏/当前名已经不是自己写的那个占位名（用户改过）→ 不公布短名。
- 补全失败、无模型、无 key：静默保持占位名，不影响对话。
- 只尝试一次，不论成败。

包装层用本组件内的 `Set<sessionId>` 记「占位已写 / 短名已试」，不依赖平台的 `titledSessions`。

`StandardChatSurface` 的 `openSession(res.sessionId)` 继续只用来告诉平台「当前会话是这个 id」。不要把用户原文经 `openSession(id, title)` 传给平台当名字。

### 一次性补全（给通用 Agent 用，不是起名 API）

Pi 子进程已有 `{ type: "complete", provider, modelId, text }`，不追加进会话消息。Renderer 今天没有这层封装。

Renderer 今天调不到 `complete`。新增一个**无标题语义**的薄 API：

```text
completeText(sessionId: string, text: string): Promise<{ ok: boolean; text?: string }>
```

- 用该会话已打开的 slot（与今天 `maybeGenerateTitle` 用 slot 的方式相同）。
- 模型解析用现有便宜路由。`ModelTask: "title"` 只表示「轻量补全这条配置」，不表示平台知道这是在起名。本次不改路由表，也不把 prompt 写进主进程。
- 主进程禁止出现「用户：… / 助手：… / 生成标题」这类字符串。
- 不得把起名 prompt 挪回 `ipc.ts`。不另开 `generateTitle`。

其他 Agent 不需要补全就不要调用。合同审核不调用。

### 以后的 Agent

只要在自己的时机调用 `setChatTitle`。不需要注册「标题策略插件」，也不需要改平台。

## Data Flow

### 合同：开始审核

```text
点开始审核
  → runWorkflow → sessionId
  → Contract Surface 公布文件名
  → set_session_name
  → session_title
  → 侧栏插入「采购合同.pdf」
```

### 通用：第一轮对话

```text
用户发送「帮我看看这份合同的违约责任条款怎么改」
  → promptSession 创建会话
  → openSession(id) 只绑定当前 id
  → general 包装层公布「帮我看看这份合同的违约责」
  → 侧栏插入占位名

助手第一条回复到达 entries
  → general 包装层 completeText(自己的 prompt)
  → 公布「违约责任条款修改」
  → 侧栏只改标题，不新开一行
```

### 用户手动改名

```text
侧栏重命名 → setChatTitle → Pi + session_title → 各处同一名字
```

若发生在占位名之后、短名之前：通用 Agent 发现当前名 ≠ 自己的占位名，跳过短名。

## Error Handling

| 情况 | 行为 |
| --- | --- |
| 空 / 空白 title | 拒绝。不写、不广播。 |
| `set_session_name` 失败 | 主流程继续。界面可能已乐观更新；下次刷新以 Pi 为准（可能回到旧名或兜底）。 |
| 会话尚不存在 | `{ ok: false }` 或不写。Agent 等 `sessionId` 再公布。 |
| 通用补全失败 / 无模型 | 保持占位名。对话不受影响。 |
| 短名空串 | 不公布，保持占位名。 |
| 用户已改占位名 | 不公布短名。 |
| jsonl 无 `name` 的旧会话 | 只读兜底，不回填。 |
| 重复公布同一字符串 | 允许。显示幂等。 |
| 工作流进行中公布 | 允许。与运行池、步骤无关。 |

## Testing

平台：

- `setChatTitle` 写 `set_session_name` 且发出 `session_title`（已有测试保留）。
- 空 title 不写不广播。
- `listChatSessions` 的 `title` 仅为 `name`；超长 `firstMessage` 不再出现在 `title`。
- 主进程在 `agent_end` 后不再 `complete`、不再自动 `set_session_name`。
- `session_title`：已有行改名；没有行则插入到正确 Agent 列表；当前会话顶栏同步。
- `openSession` / `startWorkflow` 单独调用时，侧栏不出现「新对话」假标题（除非 Agent 公布了这四个字）。
- 手动改名仍走 `setChatTitle`。
- 生产代码无 `agentId === 'contract-review'` / `'general'` 的起名分支。

合同：

- 未点开始审核：不调用 `setChatTitle`。
- 开始审核后：`setChatTitle(sessionId, 文件名)` 一次；侧栏出现该文件名（upsert，不必再 `refreshSessions` 才看见）。
- 用户改名后，合同 Surface 不再用文件名覆盖。

通用：

- 首条消息后公布 `slice(0, 20)`；侧栏立刻是占位名，且 Pi 收到同名。
- 助手首条回复后调用补全（prompt 在 Agent 测试里锁定）；再公布短名；侧栏改名不双行。
- 补全失败：侧栏仍是占位名。
- 占位与短名之间用户改名：不再公布短名。
- `StandardChatSurface` 不包含起名策略。

回归：`app-general` / `app-workflow` / `contract-surface` / `ipc` 里与标题、列表、新会话相关的用例按新语义改，不放宽。

## Out of Scope

- 改 Pi SDK 的 `set_session_name` / `session_info` 协议。
- 给旧会话批量补标题。
- 改侧栏改名交互、置顶、归档、拖拽排序。
- 原文 PDF 预览、运行池、JSONL 业务行、审批。
- 把 `setChatTitle` 搬进 `AgentSurfaceActions`（现有 preload API 够用）。
- 改 `ModelTask` 路由表或去掉历史任务名 `title`。
- 为合同审核或其它 Agent 增加短名补全。
- 多语言标题、按显示宽度截断、emoji 规范化。

## Suggested Implementation Order

实现计划（下一阶段 `writing-plans`）按这三段拆，每一段可单独验收：

1. **平台收口：** 公布 = 写 Pi + upsert 显示；列表 `title` 只认 `name`；删掉自动起名。
2. **合同接上：** 保持「开始审核 → 文件名」；靠 upsert 立刻出现在侧栏。
3. **通用接上：** 包装层两步；补全薄 API；`standard-chat` / `ipc` 不再承担起名。

## Self-Review Notes

- 无 TBD：公布口、空串、截断归属、两步时机、用户改名与短名的关系、列表字段、补全边界均已选定。
- 与已确认原则一致：平台不起名；jsonl 唯一落盘；Agent 策略不进 `src/surface`。
- 一份 spec 覆盖一条管道 + 两个已有 Agent 的策略，不拆第二份。落地可按上面三段做 plan。
- 修订了 2026-08-26 的「平台在第一轮结束起名」：触发和 prompt 回到通用 Agent；平台只保留写入、广播、便宜模型路由。
- `completeText` 是通用补全，不是起名服务；合同不调用，避免平台再长出标题业务。
