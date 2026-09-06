# 通用聊天：审批状态进会话 JSONL — Design Spec

**Status:** Approved（架构师 must-fix 已吸收；可以改产品代码）
**Date:** 2026-09-06
**Plan:** `docs/superpowers/plans/2026-09-06-general-chat-approval-timeline.md`
**Depends on:** Live session pipeline（JSONL / 会话树是已提交对话的唯一事实）；审批展示契约（抽屉/模态仍只认台账）；通用智能体写工具走 `coding-tools`
**Amends:** 通用聊天 ToolCard 的 `awaitingApproval` 不再来自 renderer 对 `approval` 事件的 overlay

## Goal

通用聊天时间线上的工具卡，允许/拒绝后立刻变成完成或已拒绝；从历史打开同一条会话，审批态仍在。状态从会话 JSONL（活着时是会话树）投影，不靠窗口私藏。

## Confirmed Decisions

1. **对话时间线只认会话树 / JSONL。** 窗口 overlay 不是真相。`standard-chat` 里按 `toolName` 只加不删的 `pendingApprovals` 去掉。
2. **台账仍是平台的，本轮不改。** Gate / Executor / 审计 / `present()` / 抽屉与模态照旧。完整 payload、preview、diff、正文只在台账和工具参数里。
3. **JSONL 只记短状态。** 禁止把 `payload`、`preview`、`content`、`diff`、命令全文写入审批 custom 行。
4. **写不写这两行是智能体的事。** 本轮只让通用智能体的 bash/edit/write（`coding-tools`）写。连接器写工具（合同导出等）不写。平台生产代码不按 `'general'` / `'contract-review'` 分叉。
5. **投影在通用智能体 Surface。** 把 custom 行折进对应 ToolCard 的 `awaitingApproval` / `isError`，再交给 `StandardChatSurface`。不在聊天列表里单独画审批卡。平台 `deriveWorkflowTimeline` 继续只认 `workflow_step_*`。
6. **对号只按下面绑定表。** 禁止「最后一张同名 / 仍在等待」二次搜索。`requestId` 只用来把 required 和 resolved 配成一对。

## JSONL 形状

Pi `custom` 行，`data` 只允许这些键（有就写，没有就省略，不塞别的）：

```ts
// customType: 'approval_required'
{ requestId: string; toolName: string; status: 'pending'; toolCallId?: string }

// customType: 'approval_resolved'
{ requestId: string; toolName: string; status: 'approved' | 'denied'; toolCallId?: string; proposalId?: string }
```

- `requestId`：这次 `propose()` 的 id，**只**用来把 required 和 resolved 配成一对。Gate 的 `proposal.id` 在拦住之前还没有，pending 行不用它。
- `toolCallId`：Pi `ToolDefinition.execute` 的第一个参数。在 `execute` 外包一层，用 `AsyncLocalStorage`（或同等）带进 `propose` 前后的短行。没有观察到就不写这个键，不编造。
- `proposalId`：决定回来后若 decision 带了就写，没有就省略。

写入时机（Pi 子进程，直接 `appendCustomEntryAndEmit`，不走 Main 代写文件）：

1. `propose()` **之前**写 `approval_required`。
2. `propose()` **返回或抛出之后**写 `approval_resolved`（`try/catch`：抛出当 `denied`）。允许、拒绝、超时拒绝都要有 resolved，避免只留下 sticky required。进程被杀、决定从未返回：允许孤儿 required。
3. 只包 bash `exec`、edit/write 的 `writeFile` 三处 `propose`。`mkdir` / `readFile` / `access` 不写行。
4. 工作区外路径在 propose 之前就扔：不写审批行。
5. `recordSessionEntry` 缺失时：工具行为不变，只是不记行。

## 绑定表（投影必须按此，不要用 findLastUnresolvedTool）

对 `session.entries` 从左到右扫。先克隆 `kind === 'tool'` 的条目，不要改 `useAgentSession` 的原数组。

**配对**

- `approval_required` 与 `approval_resolved` **只**用相同 `requestId` 配成一对。
- 没有对应 required 的 resolved：什么都不做。

**卡片**

把一对绑到一张工具卡，只在遇到 `approval_required` 时绑一次：

1. 行上有 `toolCallId`，且时间线里有相同 `toolCallId` 的 tool → 用那张。
2. 否则：同名工具卡按出现顺序 FIFO，取下一张**还未被任何 required 占用**的。已有 `result` 的卡跳过。
3. 找不到卡：这行不涂任何工具。

`approval_resolved` **只**涂这对已经绑上的那张卡，不再按 toolName 搜索。

**涂色**

- required → 该卡 `awaitingApproval: true`
- resolved `approved` → `awaitingApproval: false`
- resolved `denied` → `awaitingApproval: false`；若还没有 `result`，则 `isError: true`（不编假 result；本轮不改 ToolCard 文案）
- 之后的 `tool_execution_end` / JSONL `toolResult` 仍按现有规则带上 `result` 并清 `awaitingApproval`

**必锁夹具：** 时间线里已经有两张无 result 的 write 卡，然后 required+resolved 只针对第一张，再 required 第二张。第一张不得把第二张钉成等待。

无审批行时返回原 `entries` 引用。custom 行本身不渲染。旧会话没有这两行：与本轮之前的 JSONL 回放相同。

## Live 路径

`appendCustomEntryAndEmit` 已会 `_emit({ type: 'entry_appended', entry })`。现有管道把它送到 `useAgentSession` → `applySurfaceEvent` 追加 custom。通用 Surface `useMemo` 投影。不新开 IPC，聊天面不再听 `approval` 给 ToolCard 打状态。

抽屉仍听 `sparkii:event:approval`：那是操作面，不是时间线。

## History 路径

`normalizeSessionEntries` 在每个 custom 行处 flush 聊天缓冲。JSONL 顺序是 `toolCall` → `approval_*` → `toolResult`，第一次 flush 会先产出一张无 `result` 的卡。后续 `toolResult` 必须并回那张未完成的同 `toolCallId` / 同名卡，不能再推一张「完成」卡。Live 路径走 `tool_execution_start/end`，不会裂成两张。

## Non-Goals

- 不改 Gate 策略、超时、RBAC、执行器。
- 不改审批弹出契约（summary / preview）。
- 不把审批决定写进 Pi `toolResult` 正文去冒充状态。
- 不让主进程直接改 JSONL 文件。
- 不给合同 Surface 加这两行，不改合同投影。
- 不为旧会话回填审批行。
- 不在 ToolCard 上新造「已拒绝」文案枚举。

## Test Points

- coding-tools：允许/拒绝各写 required + resolved；`data` 不得出现 `payload` / `preview` / `content` / `diff` / `command`；越界路径不写；`execute` 的 call id 进 `toolCallId`。
- 投影：绑定表 + 两张 write 的历史顺序夹具；denied 无 result → `isError` 且不在等待。
- StandardChat：`approval` IPC 不再改变卡片；entries 上已有 `awaitingApproval` 仍显示「等待审批」。
- 历史：`normalizeSessionEntries` 之后走同一投影函数；`toolCall` 与 `toolResult` 中间夹着审批行时仍是一张卡（完成），不是「运行中」+「完成」。
