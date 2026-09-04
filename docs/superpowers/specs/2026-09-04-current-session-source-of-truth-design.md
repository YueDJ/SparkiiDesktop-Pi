# Current Session Source of Truth — Design Spec

**Status:** Draft (pending human review — 审核通过后再改代码)
**Date:** 2026-09-04
**Branch:** `cursor/current-session-truth-9b43`
**Depends on:** 会话标题公布（`2026-09-04-session-title-source-of-truth-design.md`）；Agent 薄契约（`2026-09-01`、`2026-09-02`）
**Supersedes:** `App.tsx` 里「每个 Agent 各记一条 current」的双状态（`activeSessionByAgent` + `workflowByAgent` + `titleByAgent`）

## Goal

把「左边历史列表高亮谁」和「右边正在显示什么」收成同一条事实：

- 全应用只有一个当前工作 `current`。右边可以是一条会话，也可以是首页、设置、审批、审计。
- 左边目录只展示已经落盘、已经有名字的会话。
- 左边高亮、右边内容都只读 `current`，不允许各记一份再对一下，也不另挂一个平行的 `screen`。
- 点历史、点智能体、打开壳页面、新会话还没 id、第一条消息出了标题，都走同一套规则。
- 合同审核和通用聊天不再各走一套打开 / 高亮逻辑。以后加 Agent 也不再加第三份 map。

## Confirmed Decisions

1. **唯一事实源是 `current`，不是侧栏行上的 `active`，也不是每个 Agent 各自的 current。**
2. **`current` 描述右边此刻是什么，会话只是其中一种。** 右边可以是一条会话，也可以是首页、设置、审批、审计。这些都写进同一份 `current`，不再另挂一个和它平行的 `screen` 当第二真相。
3. **形状只区分「会话」和「非会话页」，不把今天的四个壳页面写死进类型。**

```ts
type CurrentWork =
  | { type: 'page'; page: string }
  | { type: 'session'; agentId: string; sessionId: string | null; mode: 'live' | 'history' };
```

`page` 是右边这块非会话内容的 id，和现有 `ScreenId` 一样是开放字符串。今天用到的是 `home` / `settings` / `approvals` / `audit`，以后加「知识库」「账单」之类，只是新的 id，**不必改 `CurrentWork`**。谁负责渲染：壳里的 `surfaces[page]` 注册表；没注册就当未知页（不渲染会话、也不高亮）。

`type: 'session'` 且 `sessionId` 有值 = 正在看目录里的这一条；`sessionId` 为空 = 正在看这个 Agent 的新会话，还没落盘。`type: 'page'` = 右边不是任何会话。新 Agent 走 `session`，不要做成新的 page。
4. **左边是目录，右边只渲染 `current`。** 目录在启动和运行中更新（刷新、改名、删除、`session_title` upsert）。`current.type === 'page'` 时右边是对应壳页面；`type === 'session'` 时右边是该 Agent 的工作区。
5. **高亮是派生值，不存进目录。** `sessions` 数组不保存 `active`。渲染前算：仅当 `current.type === 'session' && current.sessionId === row.id` 才亮。全列表最多亮一行。新会话（`sessionId` 为空）或任何 `type: 'page'`（不管 page 是今天的四个还是以后的新 id）一行都不亮。
6. **点左侧某一条历史：** `current = { type: 'session', agentId, sessionId, mode }`。右边打开它，左边只亮它。
7. **点左上角某个智能体：** 永远开新会话。`current = { type: 'session', agentId, sessionId: null, mode: 'live' }`。右边是空白新工作区；左边不高亮。
8. **新会话在有名字之前不进目录。** 没有 id、没有标题，左边没有这一行，也就没有高亮。`openSession` / `startWorkflow` / `promptSession` 只绑定 `current.sessionId`，不插侧栏。侧栏出现仍只走已有的 `session_title` upsert。
9. **发出第一条消息（或合同点开始审核）并且 Agent 公布了标题：** 补上 `sessionId`（若还没有），目录出现这一行，且只亮它。
10. **打开非会话页：** `current = { type: 'page', page }`，`page` 是该页的 id。右边交给 `surfaces[page]`；左边全部不亮。**不把上一条会话藏在 current 后面。** 要从某条历史回来，再点目录里的那一行。从首页点某个 Agent 卡片：与左上角相同，开该 Agent 的新会话。以后新增壳页面 = 注册 `surfaces[新id]` + 导航到该 id，高亮规则不用改。
11. **删的是当前这条：** 仍留在该 Agent，`sessionId = null`，`mode = 'live'`，右边回到未落盘的新会话，左边不再高亮。删的不是当前这条：只从目录拿掉。
12. **`mode` 不是第二份 current。** 它只属于 `type: 'session'`，告诉工作区怎么读这条会话：从目录打开且该 Agent 的 surface 是 workflow → `'history'`；新会话、聊天、以及 `startWorkflow` / 首条消息绑定 id 之后 → `'live'`。聊天 surface 不区分 history。判断用 `surfaceType`，不用 agent id。
13. **平台生产代码不按 agent id 分支打开 / 高亮。** `App.tsx` 里不再出现「chat 写 map A、workflow 写 map B」，也不再同时维护 `screen` 和 per-agent current。能力差异只体现在：聊天在 `sessionId == null` 时是 draft composer；workflow 用 `mode` 回放历史。
14. **每个 Agent 仍挂一个 `AgentFrame`，但只有 `current.type === 'session' && current.agentId === 该帧` 时才拿到 `sessionId`。** 其他帧 `sessionId = null`。壳页面时所有帧都不作为当前工作区。
15. **标题显示名从目录读。** 仅 `type: 'session'` 且有 `sessionId` 时，把该行 `name` 交给 Surface。不再维护 `titleByAgent`。没有 id 时不传标题，聊天自己显示「新对话」。
16. **本 spec 只改平台壳。** 不改 SessionList 的交互，不改 Agent 起名策略，不改合同审核业务、运行池、审批抽屉内部、置顶 / 归档 / 拖拽。

## Current State (why it is tangled)

今天「当前会话」有三份，高亮只认其中一份：

| 状态 | 谁在写 | 谁在读 | 后果 |
| --- | --- | --- | --- |
| `activeSessionByAgent[agentId]` | 打开 / 新建**聊天** | 高亮、`draft`、聊天 `sessionId` | 每个聊天 Agent 可各亮一条 |
| `workflowByAgent[agentId]` | 打开 / 新建 / 开始**工作流** | 合同右边的 `sessionId` / `mode` | 点合同历史右边打开了，高亮不更新 |
| `titleByAgent[agentId]` | 改名、`session_title`、刷新 | 顶栏 / Surface `title` | 第三份「当前标题」 |
| `sessions[agentId][].active` | `refreshSessions`、新建时手改、`session_title` 写死 `true` | `SessionList` 的 `current` 样式 | 目录里又存了一份高亮 |

点「合同 A」只写 `workflowByAgent`，`refreshSessions` 的 `active` 却只看 `activeSessionByAgent`。所以右边已经是合同 A，左边不亮。

点通用只清通用那一组的 `active`。合同一旦也能亮，再点通用就会：右边是新对话，左边合同 A 还亮着。

`session_title` 插入时写死 `active: true`，不关其他组。刷新又按「每个 profile 自己的 current」重算 `active`，每个分组都能亮一条。

`AgentFrame` 注释还写着「每个 Agent 保留自己的 live/history」。这和「全列表只有一个当前」是两套产品假设。

## Architecture

```text
用户动作
  点历史一行
  点左上角智能体 / 首页 Agent 卡片
  点首页 / 设置 / 审批 / 审计
  首条消息或开始审核绑定 id
  Agent 公布标题
  删除当前 / 释放当前线程
            │
            ▼
        current =
          { type: 'page', page } |
          { type: 'session', agentId, sessionId | null, mode }
            │
            ├──────────────────────────┐
            ▼                          ▼
     右边                              左边目录
     page → 壳页面                     磁盘 + session_title
     session → 该 Agent 工作区         不存 active
                                       渲染时 active ⇔
                                         current.type === 'session'
                                         && current.sessionId === row.id
```

三层各做一件事：

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| `current` | 记住右边此刻是哪一页或哪一条会话 | 不按 Agent 各存一份；壳页面不是「会话藏在后面」 |
| 目录 `sessions` | 已落盘会话的名字、分组、顺序 | 不存「谁是当前」 |
| 渲染 | 右边绑 `current`；左边派生高亮 | 不在 refresh / 事件里改 `active` 字段 |

`SessionList` 继续吃 `s.active`。谁算 `active` 改成渲染前派生，列表组件不用动。

## Data Model

```ts
type CurrentWork =
  | { type: 'page'; page: string }
  | { type: 'session'; agentId: string; sessionId: string | null; mode: 'live' | 'history' };

// AppShell 里只留这一份（不再另存 screen）
current: CurrentWork
sessions: Record<string, ShellSession[]>  // 目录；行上不再写 active
```

启动：`current = { type: 'page', page: 'home' }`。

给 `Shell` 的 `active`（顶栏哪一项）从 `current` 派生：`page` 或 `agentId`。不要再维护一份平行的 `screen` state。

同步写入一份 `currentRef`，给 `listChatSessions` 的异步回调和 `chat-event` 用。现有 `activeSessionByAgentRef` / `workflowByAgentRef` 删掉。

派生：

```ts
function highlightedSessionId(current: CurrentWork): string | null {
  if (current.type !== 'session' || !current.sessionId) return null;
  return current.sessionId;
}

function shellActive(current: CurrentWork): ScreenId {
  return current.type === 'page' ? current.page : current.agentId;
}

function withDerivedActive(
  sessions: Record<string, ShellSession[]>,
  highlightedId: string | null,
): Record<string, ShellSession[]> {
  // 每一行 active = (s.id === highlightedId)
}
```

`highlightedId === null`：新会话（`sessionId` 为空）或任何壳页面。左边一行都不亮。

## User Actions

### 启动

- `current = { type: 'page', page: 'home' }`。
- `listChatSessions` 灌进目录。没有任何高亮。

### 点左侧历史

```text
onOpenSession(agentId, sessionId)
  current = { type: 'session', agentId, sessionId, mode: surfaceType === 'workflow' ? 'history' : 'live' }
```

右边该 Agent 的 frame 用这个 `sessionId` + `mode`。目录里只亮这一行。

聊天和合同走同一个函数。不再 `if (isChatAgent) setActiveSessionFor; else setWorkflowByAgent`。

### 点左上角智能体

Shell 已有：`onNewSession(agentId)` 然后 `onNavigate(agentId)`。

```text
onNewSession(agentId)
  current = { type: 'session', agentId, sessionId: null, mode: 'live' }
  // 不改目录，不写 active
```

右边是新工作区；聊天 `draft = true`；合同是空的上传页。左边不高亮。

### 打开非会话页（首页 / 设置 / 以后的新页）

这些不是「会话还在、只是先不亮」，而是右边换成另一种内容，所以 `current` 本身要换成 page：

```text
onNavigate(pageId)   // 不是 Agent
  current = { type: 'page', page: pageId }
  右边 = surfaces[pageId]   // 未注册则无会话、无高亮
```

左边全部不亮。上一条会话不藏在 current 里。要再看它，点目录里的那一行。今天的 `home` / `settings` / `approvals` / `audit` 只是四个已注册的 id，不是类型枚举。

### 首页点 Agent 卡片

`HomeView` 调 `onNavigate(agentId)`。此时 `current` 已是首页，所以和左上角一样：开该 Agent 的新会话。

```text
onNavigate(agentId)
  current = { type: 'session', agentId, sessionId: null, mode: 'live' }
```

### 绑定 id（还没有标题）

聊天首条 `promptSession` 回来、或合同 `runWorkflow` 回来：

```text
仅当 current.type === 'session' 时：
  current = { ...current, sessionId: 新id, mode: 'live' }
```

此时目录里还没有这一行。左边仍然不高亮。右边已经挂在这个 id 上，后续 `chat-event` 进这条会话。

`actions.openSession(id)`（Surface 内部绑定，不是点历史）和 `actions.startWorkflow` 的 sessionId 回写，都只改 `current`，不插目录。

### Agent 公布标题

已有 `session_title` upsert 不变：没有行就插入到拥有该 id 的 Agent 分组，有行就改名。

归属：

1. 后端 / 覆盖值上的 `profileId`
2. 否则：`current.type === 'session' && current.sessionId === 该 id` 则归 `current.agentId`

插入时**不要**写 `active: true`。高亮等下一帧派生：若右边正在看这个 id，这一行会亮；否则不亮。

同时不要再 `setTitleFor`。Surface 的 `title` 直接读目录里这一行的 `name`。

### 删除 / 释放

- 删除当前这条（`current.type === 'session'` 且 id 对得上）：`sessionId = null`，`mode = 'live'`，然后刷新目录。
- 删除其他行：只刷新目录。
- 释放线程且被释放的正是当前 session id：同样置空。工作流今天删除后不清理 `workflowByAgent`，这次一并修掉。
- 当前是壳页面时删除某一行：只刷新目录，`current` 仍是该 page。

### 刷新目录

`refreshSessions` 继续：原地更新元数据、补新行、去掉已删除、保持顺序和置顶。

**不再**根据「该 profile 的 activeSession」写 `active`。**不再**在刷新结束时用 per-agent current 回写 `titleByAgent`。

异步回调里用 `currentRef` 判断归属；`title` 渲染时从目录现查，不必再 setState。

## Right Pane

```text
Shell.active = shellActive(current)   // page 或 agentId

current.type === 'page'
  → 渲染 surfaces[current.page]（未注册则不显示会话）
  → 所有 AgentFrame.active = false，sessionId = null

current.type === 'session'
  → 该 agent 的 frame：
       active    = true
       sessionId = current.sessionId
       mode      = current.mode
       draft     = surfaceType === 'chat' && sessionId == null
       title     = 目录里该 sessionId 的 name（没有 id 则不传）
  → 其他 frame：active = false，sessionId = null
```

其他帧不挂别人的旧 `sessionId`，避免「隐藏的合同 A」和「可见的通用新会话」同时当真相。

`ApprovalPanel.currentSessionId`：仅当 `current.type === 'session'` 时用 `current.sessionId`，否则 `''`。不要再找「某一个 chat Agent 的 activeSession」。

## What To Delete

实现时必须从生产代码里拿掉，不得改名留着：

| 符号 | 为什么废 |
| --- | --- |
| `workflowByAgent` / `setWorkflowByAgent` / `workflowByAgentRef` / `workflowFor` | 按 Agent 记工作流当前 |
| `activeSessionByAgent` / `setActiveSessionByAgent` / `activeSessionByAgentRef` / `activeSessionFor` / `setActiveSessionFor` | 按 Agent 记聊天当前；又是高亮的错误来源 |
| `titleByAgent` / `titleFor` / `setTitleFor` | 第三份当前标题 |
| `bindChatSession` | 和 `onOpenSession` 重复；统一成改 `current` |
| `onNewSession` / `onOpenSession` 里的 `isChatAgent` 分叉 | 同一套 current 即可 |
| `AgentFrame` 上 `surfaceType === 'chat' ? activeSessionFor : workflowFor` | 改成只读 current |
| `refreshSessions` 里 `currentActive = activeSessionByAgentRef[profileId]` | 高亮不进目录 |
| `refreshSessions` 结束时按 `liveActive` `setTitleFor` | 标题从目录读 |
| `session_title` 插入时 `active: true` | 高亮是派生的 |
| `session_title` 里对两份 map 循环 `setTitleFor` | 同上 |
| `onNewSession` 里手动 `list.map(active: false)` | 派生后不必改目录 |
| 与 `current` 平行的 `screen` state | 右边是什么由 `current` 单独决定 |
| `AgentFrame` / `AppShell` 里「每个 Agent 保留自己的 session」的注释 | 产品假设已改 |

可以留：

- `sessions` + `sessionOverridesRef`（目录和乐观改名）
- `ScreenId` 类型（给 Shell 的 `active` 派生值用）
- `SessionList` / `s.active` 这个 **props**（由壳派生后传入）
- `orderSessions` / `stickyOrder` / `sessionDisplayName`
- Agent 的 `setChatTitle` / `session_title` 公布路径

## Invariants

任何时刻：

1. 目录里 `active === true` 的行数 ≤ 1（派生后保证）。
2. 若有一行 `active`，则 `current.type === 'session'` 且 `current.sessionId` 就是这一行，右边正在显示它。
3. 若 `current.type === 'session'` 且 `sessionId == null`，则没有任何一行 `active`。
4. 若 `current.type === 'page'`（任意 page id），则没有任何一行 `active`，右边也不是任何会话。
5. 不存在「通用亮一条、合同再亮一条」。
6. 生产壳代码不出现 `activeSessionByAgent`、`workflowByAgent`、`titleByAgent`，也不再另存一份 `screen` 与 `current` 并行。

## Error Handling / Edge Cases

| 情况 | 行为 |
| --- | --- |
| 启动在首页 | `current = { type: 'page', page: 'home' }`，无高亮 |
| 以后新增壳页面 | `surfaces` 增加一项；`current = { type: 'page', page: 新id }`；高亮公式不用改；`CurrentWork` 不用改 |
| 新会话尚未公布标题 | 有或没有 id 都不插行、不高亮 |
| `session_title` 晚于绑定 id | upsert 后派生高亮，只亮这一行 |
| `session_title` 对已不在 current 的旧 id | 只改名或补行，不抢高亮 |
| 打开历史后立刻点另一个智能体 | current 换成新会话，旧行还在目录里，不亮 |
| 打开历史后去首页 / 设置 | `current` 换成对应 page，高亮灭；再看旧会话只能再点目录 |
| 在设置页时目录仍更新 | 改名 / upsert 照常；不高亮 |
| 刷新目录时后端还没有新行 | 覆盖值仍可保留行；`active` 仍派生 |
| 删除当前 | 新会话，无高亮 |
| 删除非当前 | 目录少一行，current 不动 |
| 无 `profileId` 的旧列表项 | 仅当 current 是 session 且 id 对得上才归到 `current.agentId`；否则不猜分组 |
| 两个 Agent 同时 streaming | 右边只挂 current 这一条；另一条不再靠「隐藏 frame 里的旧 sessionId」当真相 |

## Testing

平台壳（`app-general` / `app-workflow`，必要时抽纯函数单测）：

- 点合同历史某一行：该行有 `current` class，通用分组没有任何 `current`；右边是合同工作区。
- 再点左上角通用：没有任何一行 `current`；右边是通用新会话（composer / 「新对话」）。
- 通用发出第一条消息但还没有 `session_title`：侧栏仍没有这一行（已有用例），也没有高亮。
- `session_title` 到达：这一行出现且是唯一的 `current`。
- 点另一条历史：高亮挪过去，只有新点的那一行亮。
- 打开历史后再点左上角同一 Agent：标题回到「新对话」，历史行还在但不再亮（已有通用用例，补上「没有 current class」）。
- 去首页或设置：所有历史行都没有 `current`；右边是对应壳页面。再点该历史行才能重新打开并高亮。
- 首页点 Agent 卡片：右边是该 Agent 新会话，无高亮。
- `openSession` / `startWorkflow` 单独绑定 id：不插「新对话」行（已有标题 spec）。
- 删除当前会话：回到新会话，无高亮。
- 生产代码 grep：无 `activeSessionByAgent` / `workflowByAgent` / `titleByAgent` / `setActiveSessionFor` / `workflowFor`。
- 不按 `'general'` / `'contract-review'` 写打开或高亮分支。

回归：现有 `app-general`、`app-workflow`、标题 upsert、合同历史可合并，语义不放宽。

## Out of Scope

- 改 `SessionList` 的点击 / 右键 / 置顶 / 归档 / 拖拽 / 「更多」。
- 改 Agent 起名、截断、用户锁名。
- 改合同审核步骤、合并到报告、导出。
- 改运行池、审批抽屉交互、Pi jsonl 协议。
- 首页「最近会话」做成可点列表（现在只是一句说明）。
- 多窗口、分屏同时看两个 Agent。
- 把 `current` 持久化到磁盘（重启后仍从首页开始）。

## Suggested Implementation Order

1. 抽出 `CurrentWork` 与派生高亮的纯函数 + 单测。
2. `App.tsx` 用一份 `current` 替换三份 map 和平行的 `screen`；打开 / 新建 / 绑定 / 删除 / 导航（含壳页面）只改 `current`。
3. 目录不再写 `active`；传给 Shell 前派生。删掉 `session_title` / `refreshSessions` / `onNewSession` 里所有手写 `active`。
4. 补左右同步的壳测试；grep 确认废代码已删除。

## Self-Review Notes

- 无 TBD：current 只分 session / page；`page` 是开放 id；高亮公式、点历史 / 点智能体 / 首页卡片 / 打开任意非会话页 / 绑定 id / 出标题 / 删除，都已选定。以后加壳页面不改 `CurrentWork`。
- 和已确认原则一致：左边是目录，右边由同一份 current 驱动；没落盘或右边不是会话，就没有高亮。
- 壳页面写进 `current`，不另留 `screen` 当第二真相，也不把旧会话藏在页面后面。
- 不把 `mode` 做成第二套 per-agent 状态。
- 不把 `active` 再写回目录，避免刷新把「每组一条高亮」刷回来。
- 标题 spec 的 upsert 入口保留；本 spec 只改「右边正在显示什么」和「亮谁」。
