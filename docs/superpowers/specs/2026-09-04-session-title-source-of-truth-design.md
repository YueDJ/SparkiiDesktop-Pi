# Session Title Source of Truth — Design Spec

**Status:** Implemented
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

1. **Pi jsonl 的会话名是唯一真相。** 界面缓存、`firstMessage` 都不是标题权威。`sessions.db` 继续不存 title 字符串；只多存一比特「用户锁了标题」（见 11）。
2. **起名在 Agent。** 叫什么、截多长、改几次、要不要用模型，都是该 Agent 的策略。
3. **平台不起名。** 不提供「起短名」API，不在主进程写起名 prompt，删除 `maybeGenerateTitle` 以及 `agent_end` 自动起名。
4. **平台只做公布 + 用户锁。** 收到 `(sessionId, title, source)` →（若 `source=agent` 且已锁则拒绝）→ 写入 Pi → 广播现有 `session_title` → 侧栏插入或改名。平台仍不改写、不截断传入的字符串。
5. **不新开事件通道。** 继续用 `sparkii:setChatTitle` + `chat-event` 的 `{ type: "session_title", sessionId, title }`。语义从「改个标题」升级为「公布标题」。第三参是 `source`，不是第二条 IPC。
6. **平台生产代码不按 agent id 分支。** `App.tsx` / `ipc.ts` 不出现「合同用文件名、通用走两步」这类判断。锁名规则对所有 Agent 相同。
7. **合同审核：** 用户点「开始审核」且已有 `sessionId` 后，公布一次。title = 文件名去掉最后一个扩展名，再 `slice(0, 20)`。未点开始、只有本地选文件时不公布（还没有会话）。Pi 里已有名字则不再公布。
8. **通用智能体，两步，都在 `agents/general`：**
   1. 第一条用户消息发出、会话 id 可用且还没有标题：先公布占位名 = 该条可见文本截到 20 字（现算，不另存）。
   2. 第一条助手回复出现后：仅当当前标题仍等于「用同一规则再算出来的占位」时，才用「用户第一句 + 助手第一句」起不超过 20 字的短名并公布。对不上就不再写。
9. **截断是 Agent 的事。** 平台写入和显示都不截断。合同、通用占位、通用短名都按 JS 字符串 `slice(0, 20)`（中文一字一长度）。
10. **侧栏有名就立刻出现。** 公布是插入侧栏的唯一正规入口。`openSession` / `startWorkflow` 只绑定当前会话 id，不再编一个「新对话」当产品标题。
11. **用户改过名之后，Agent 永远不能再改。** 靠平台持久化的锁保证，不靠组件内存。见下方「用户锁名」。
12. **用户侧栏手动改名** 走同一条公布路径，且 `source: "user"`，从而上锁。
13. **列表接口的 `title` 只来自 Pi `name`。** 不再把 `firstMessage` 填进 `title`。`firstMessage` 可另字段留给无标题旧会话做只读兜底。
14. **补全不是起名。** 通用 Agent 起短名若需要问模型，走无业务语义的一次性补全（Pi 已有 `complete` RPC）。prompt、截断、何时调用全部在 Agent。平台不写「请为以下对话生成标题」。
15. **旧会话不回填标题。** 历史上没有 `name` 的会话保持原样；界面可用截断的 `firstMessage` 或时间做只读兜底，不写回 Pi。旧会话的锁默认为未锁；合同「已有名字就不再公布」避免打开历史时用文件名盖掉旧标题。

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
Agent（想名字）                         用户（侧栏改名）
  合同：开始审核 → 去扩展名后 ≤20          source: "user"
  通用：首条用户消息 → 占位 ≤20
        首条助手回复 → 短名 ≤20（仅此一次）
  source: "agent"
            │                                    │
            └──────────────┬─────────────────────┘
                           ▼
            sparkii:setChatTitle(sessionId, title, source)
                           │
                           ▼
平台主进程
  trim；空串拒绝
  source=agent 且 titleLockedByUser → 拒绝（不写、不广播）
  source=user → 写 Pi，并把 titleLockedByUser=true 写入 sessions.db
  source=agent 且未锁 → 写 Pi，锁保持 false
  chat-event session_title
                           │
                           ▼
平台界面
  侧栏按 sessionId upsert
```

三层各做一件事：

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| Agent | 决定字符串和时机 | 不改侧栏 DOM / 不直接写 jsonl |
| 平台写入 | 写 Pi + 广播；用户改名上锁，挡住之后的 Agent 公布 | 不猜文件名、不起短名、不截断 |
| 平台显示 | upsert 侧栏 | 不编「新对话」当产品名 |

`apps/desktop/src/surface/**` 继续不 import `agents/**`。通用策略只放在 `apps/desktop/agents/general/**`。合同策略只放在 `apps/desktop/agents/contract-review/**`。

## Platform Capability

### 公布：现有 `sparkii:setChatTitle`

输入：`sessionId: string`，`title: string`，`source: "user" | "agent"`。

- 侧栏手动改名必须传 `"user"`。
- Agent 公布必须传 `"agent"`。
- 不缺省。调用方漏传则视为 `"agent"`（宁可不锁，不可把 Agent 的第一次占位误锁成用户改名）。

行为：

1. `title = title.trim()`。空串 → `{ ok: false }`，不写 Pi，不广播，不上锁。
2. `source === "agent"` 且该会话 `titleLockedByUser === true` → `{ ok: false, reason: "locked" }`，不写 Pi，不广播。这是保证，与 Agent 是否还挂在内存无关。
3. 对已打开会话发 `set_session_name`；未打开则按现有逻辑 acquire 后再发。写入失败不抛给主流程，不重试起名。
4. `source === "user"` → `sessions.db` 将该会话 `titleLockedByUser` 置为 true。锁只增不减；用户再改一次名仍是用户锁。Agent 公布从不改这比特。
5. 广播 `{ type: "session_title", sessionId, title }`（可用乐观广播：先通知界面，Pi 异步写）。被锁拒绝时不广播。
6. 返回 `{ ok: true }` 表示已接受这次公布，不表示磁盘一定已刷完。

删除：

- `maybeGenerateTitle`
- 主进程内存里的 `titledSessions`（重启即丢，挡不住「打开历史再点一次」）
- `agent_end && rec.kind !== 'workflow'` 这条起名分支

不新增：`generateTitle` / `suggestTitle` / `publishTitle` 等第二套 IPC。锁是 `setChatTitle` 的第三参，不是新通道。

### 用户锁名（为什么必须落在平台）

只靠 Agent「我只改一次」不够：

| 场景 | 只有 Agent 内存 Set | 加上平台锁 |
| --- | --- | --- |
| 通用：短名写完后再也不调 | 够用 | 双保险 |
| 通用：占位之后、短名之前用户改名 | Agent 可对比「是不是我的占位」 | 锁已上，短名必被拒绝 |
| 合同：用户改名 → 打开历史 → Surface 因 `sessionId`+文件名再次 `setChatTitle` | 组件重挂，Set 空了，会覆盖 | 拒绝 |
| 合同：用户改名 → 历史里再次开始审核（同一 `sessionId`） | 同上，会覆盖 | 拒绝 |
| 重启应用后再打开该会话 | 内存没了 | 锁在 `sessions.db`，仍在 |

锁存 `sessions.db` 的 `title_locked_by_user INTEGER NOT NULL DEFAULT 0`，和 pinned / archived 一样是会话索引元数据，**不是标题本身**。标题字符串仍只在 Pi jsonl。

不把锁写进 Pi `session_info`：SDK 条目只有 `name`，不要发明第二套标题协议。

旧会话没有这一列：迁移默认 `0`（未锁）。不回扫「哪些是用户改过的」。合同另有一条「Pi 已有名字就不再公布」，打开旧历史时不会用文件名盖掉已有标题。

用户没有「解锁」。想改名只能自己再改；Agent 不能要回命名权。

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

用户手动改名：继续 `onRenameSession` → 本地先改（避免闪旧名）→ `setChatTitle(id, title, "user")` → 刷新。写入与 Agent 同一条；`source` 不同。

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

触发点仍是「开始审核之后」有了 `sessionId`，不是选文件当时。

名字算法（Agent 内，平台不管）：

```text
stripLastExt("采购合同.pdf")     → "采购合同"
stripLastExt("合同.最终版.docx") → "合同.最终版"
stripLastExt("只有名字")         → "只有名字"
然后 trim + slice(0, 20)
若结果为空 → 「合同审核」
```

`stripLastExt` = 去掉最后一个 `.` 及其后的扩展名（`/\.[^./\\]+$/`）。不处理多段压缩包之类的特例。

何时公布：

- 当前是 live、有 `sessionId`、且 Pi / 界面还没有名字 → `setChatTitle(id, 算出的名字, "agent")`。
- 已经有名字（自己写过的文件名、用户改过的）→ **不再调用**。
- 打开历史（`mode === "history"`）→ **不再调用**，避免给没有 Pi name 的旧会话回填文件名。
- 平台锁是第二道：即使用户改名后 Surface 又调用了，也会被拒绝。

公布之后侧栏立刻出现（平台 upsert）。同一 `sessionId` 再次开始审核、或换文件再跑，都不改已经存在的名字。新会话新 `sessionId` 才按新文件再起一次名。

### 通用智能体（`agents/general`）

两步策略在 **general 包内的包装层**，不要写进 `src/surface/standard-chat.tsx`。

包装层仍渲染 `StandardChatSurface`，自己看 props 里的 `sessionId`、`session.entries`、当前 `title`。

**占位名怎么来：现算，不另存。**

```text
placeholderOf(第一条用户可见文本) = trim(文本).slice(0, 20) || 「新对话」
```

第一条用户可见文本 = 已写入会话的那条用户正文（与 `StandardChatSurface` 发出的 `display` 相同，含附件前缀）。算法是纯函数，时间线上永远还在，所以**不必**再写一份「我当时占位写了啥」到内存或磁盘。第二次写之前，用同一函数再算一遍，和**当前标题**比。

**第一步 — 占位名**

- 条件：`sessionId` 有值，已有第一条用户可见文本，且当前还没有标题。
- 公布 `placeholderOf(...)`，`source: "agent"`。
- 已有标题（打开历史、已经占位过）→ 不写。

**第二步 — 短名**

- 条件：已有第一条助手可见正文（非空 `content`；纯思考 / 纯工具块不算）。
- `expected = placeholderOf(第一条用户文本)`。
- **仅当 `当前标题 === expected` 时**才起短名并公布。意思是：现在挂着的还是我按规则算出的那个占位，没有被用户改掉，也还没换成短名。
- `当前标题 !== expected` → 什么都不做。包括：用户改过、短名已经写过、打开历史。不必记「我已经起过短名」。
- 已锁 → 即使误调用也会被平台拒绝。
- 补全失败 / 空串 / 无模型：不公布，保持占位。
- 同一挂载周期里用本地标记避免对同一次回复打两次补全；这只是防抖，不是判断依据。

```text
当前标题 === placeholderOf(首条用户消息)  →  还可以起短名
当前标题是别的字 / 已经是短名 / 用户改过   →  不再写
```

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

只要在自己的时机调用 `setChatTitle(..., "agent")`。不需要注册「标题策略插件」。用户一旦改名，平台锁会挡住任何 Agent。

## Data Flow

### 合同：开始审核

```text
点开始审核
  → runWorkflow → sessionId
  → Contract Surface 公布「采购合同」（去 .pdf，≤20）
  → setChatTitle(..., "agent") → set_session_name
  → session_title
  → 侧栏插入「采购合同」
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
侧栏重命名
  → setChatTitle(id, 新名, "user")
  → Pi 写入 + titleLockedByUser=true
  → session_title → 各处同一名字
```

之后无论通用短名、合同打开历史、同一会话再次开始审核，Agent 的 `setChatTitle(..., "agent")` 都被拒绝。

通用若发生在占位之后、短名之前：当前标题已经不是 `placeholderOf(首条消息)`，Agent 跳过；平台锁是底线。打开已有短名的历史同样对不上占位，不会再起一次名。

## Error Handling

| 情况 | 行为 |
| --- | --- |
| 空 / 空白 title | 拒绝。不写、不广播。 |
| `set_session_name` 失败 | 主流程继续。界面可能已乐观更新；下次刷新以 Pi 为准（可能回到旧名或兜底）。 |
| 会话尚不存在 | `{ ok: false }` 或不写。Agent 等 `sessionId` 再公布。 |
| 通用补全失败 / 无模型 | 保持占位名。对话不受影响。 |
| 短名空串 | 不公布，保持占位名。 |
| 用户已改名（已锁） | Agent 公布返回 `locked`，侧栏保持用户的名字。 |
| 通用占位之后、短名之前用户改名 | Agent 跳过短名；即使调用也被锁拒绝。 |
| 合同打开已有名字的历史 | Agent 不公布；即使调用：有锁则拒绝，无锁但已有名字也不该覆盖。 |
| jsonl 无 `name` 的旧会话 | 只读兜底，不回填。 |
| 重复公布同一字符串（未锁） | 允许。显示幂等。 |
| 工作流进行中公布 | 允许。与运行池、步骤无关。 |

## Testing

平台：

- `setChatTitle(..., "agent")` 写 `set_session_name` 且发出 `session_title`（已有测试按第三参改）。
- `setChatTitle(..., "user")` 写 Pi、置锁、广播。
- 已锁之后 `source: "agent"` 不写、不广播、返回 `locked`。重启后再调仍然拒绝。
- 空 title 不写不广播不上锁。
- `listChatSessions` 的 `title` 仅为 `name`；超长 `firstMessage` 不再出现在 `title`。
- 主进程在 `agent_end` 后不再 `complete`、不再自动 `set_session_name`。
- `session_title`：已有行改名；没有行则插入到正确 Agent 列表；当前会话顶栏同步。
- `openSession` / `startWorkflow` 单独调用时，侧栏不出现「新对话」假标题（除非 Agent 公布了这四个字）。
- 生产代码无 `agentId === 'contract-review'` / `'general'` 的起名或锁名分支。

合同：

- 未点开始审核：不调用 `setChatTitle`。
- 开始审核后：`setChatTitle(sessionId, "采购合同", "agent")`（来自 `采购合同.pdf`）；侧栏立刻出现。
- `非常非常长的合同文件名一共二十多个字.docx` → 20 字、无扩展名。
- Pi 已有名字（含打开历史、再次开始审核）：不再公布。
- 用户改名后，即使 Surface 再次调用，平台也拒绝覆盖。

通用：

- 首条消息后公布 `slice(0, 20)`；侧栏立刻是占位名，且 Pi 收到同名。
- 助手首条回复后调用补全（prompt 在 Agent 测试里锁定）；再公布短名；侧栏改名不双行。
- 补全失败：侧栏仍是占位名。
- 占位与短名之间用户改名：当前标题 ≠ `placeholderOf(首条)`，不公布短名；平台侧亦已上锁。
- 打开已有短名的历史：当前标题 ≠ 占位，不再补全、不再写。
- 不把占位名另存到内存或磁盘；只从第一条用户消息现算。
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
- 用户解锁 / 把命名权交回 Agent。锁只增不减。

## Suggested Implementation Order

实现计划（下一阶段 `writing-plans`）按这三段拆，每一段可单独验收：

1. **平台收口：** 公布 = 写 Pi + upsert 显示 + 用户锁；列表 `title` 只认 `name`；删掉自动起名。
2. **合同接上：** 开始审核 → 去扩展名且 ≤20；已有名字不再公布；靠 upsert 立刻上侧栏。
3. **通用接上：** 包装层两步；补全薄 API；`standard-chat` / `ipc` 不再承担起名。

## Self-Review Notes

- 无 TBD：公布口、空串、截断归属、合同去扩展名、两步时机、用户锁的存储与 source、打开历史、列表字段、补全边界均已选定。
- 与已确认原则一致：平台不起名；jsonl 仍是标题字符串唯一落盘；锁是索引元数据，不是第二套标题。
- 不靠 Agent 组件内存保证「用户改过不再覆盖」；合同打开历史靠「已有名字不公布」+ 平台锁两道。
- 通用不另存占位名：占位是第一条用户消息的纯函数，第二次写只比较「当前标题 === 再算出来的占位」。
- 一份 spec 覆盖一条管道 + 两个已有 Agent 的策略，不拆第二份。落地可按上面三段做 plan。
- 修订了 2026-08-26 的「平台在第一轮结束起名」：触发和 prompt 回到通用 Agent；平台只保留写入、广播、便宜模型路由、用户锁。
- `completeText` 是通用补全，不是起名服务；合同不调用，避免平台再长出标题业务。
