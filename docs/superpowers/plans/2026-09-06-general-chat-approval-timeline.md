# 通用聊天审批时间线 Implementation Plan

> **For agentic workers:** 本 plan 已经架构师审过并吸收 must-fix。按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 通用聊天工具卡的等待/完成/拒绝从会话 JSONL 投影；允许或拒绝后当场更新；从历史打开仍在。台账与审批弹出不动。

**Architecture:** `coding-tools` 在 `propose` 前后 `appendCustomEntryAndEmit` 短状态行（带真实 `toolCallId`）。通用 Surface 按绑定表把这两行折进 ToolCard。删掉 `standard-chat` 对 `approval` 事件的 overlay。

**Tech Stack:** TypeScript、Vitest、React Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-06-general-chat-approval-timeline-design.md`

## Architect corrections

已吸收（无需产品再拍板）：

1. required/resolved **只**按 `requestId` 配对；绑卡：有 `toolCallId` 用它，否则同名 FIFO 消费；resolved 不再搜「最后一张 / 仍在等待」。
2. 本轮从 `execute(toolCallId, …)` 把真实 id 写入短行。
3. 投影章节写清绑定表；Task 2/4 夹具必须是「两张 write 已在列表里」再来第一张的 required+resolved。
4. `propose` 用 try/catch，抛出也写 resolved `denied`。
5. 只包三处 propose；投影 `useMemo`；克隆 tool 条目；无审批行返回原引用。
6. Task 3 删除 overlay；断言 `approval` IPC 不再改卡片，不留「若误传」措辞。

**Product forks:** none.

**Architect verdict:** Request changes 已吸收；IMPLEMENTATION MAY START。

## Implementation review

**Architect verdict:** Approve with nits（IMPLEMENTATION ACCEPTED）。Nits 不挡：Task 3 断言改为「不再订阅 approval」比发 IPC 更硬；拒绝无 result 时 ToolCard 仍可能显示「运行中」（本轮不改文案）。

## Global Constraints

## Global Constraints

- JSONL 审批行禁止出现 `payload` / `preview` / `content` / `diff` / `command` / 命令全文。
- 不改 Gate、Executor、审计 schema、`present()`、抽屉/模态、ToolCard 文案。
- 平台生产代码不写 `'general'` / `'contract-review'`。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- 连接器写工具不写这两行。
- 不新开 IPC。
- 相关旧测试按新语义改，不放宽。不把「approval 事件 → 等待审批」留成绿灯。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| 写 `approval_required` / `approval_resolved` | `packages/agent-host` 的 `coding-tools`（通用智能体的 bash/edit/write） | Gate、`broker.route`、连接器 `propose` |
| 把行折进 ToolCard | `apps/desktop/agents/general/surface` | `deriveWorkflowTimeline`、合同 Surface |
| 删 overlay | `standard-chat.tsx`（通用智能体正在用的标准聊天面） | 不要改成再听台账 |

---

## File Structure

```text
packages/agent-host/src/coding-tools.ts
packages/agent-host/src/tool-registry.ts
packages/agent-host/src/pi-sdk-runtime.ts
packages/agent-host/test/coding-tools.test.ts

apps/desktop/agents/general/surface/approval-timeline.ts
apps/desktop/agents/general/surface/approval-timeline.test.ts
apps/desktop/agents/general/surface/index.tsx

apps/desktop/src/surface/standard-chat.tsx
apps/desktop/test/standard-chat.test.tsx
```

---

### Task 1: coding-tools 写入短状态

**Files:** `packages/agent-host/src/coding-tools.ts`、`tool-registry.ts`、`pi-sdk-runtime.ts`、`test/coding-tools.test.ts`

`CodingToolsContext` 增加可选 `recordSessionEntry?(customType: string, data: Record<string, unknown>): void`。

`execute` 外包一层，把 Pi 的 `toolCallId` 放进 ALS，供 `proposeWrite` 读。抽 `proposeWrite`：required → `await propose` → resolved；catch 里写 denied 再抛。data 只含 spec 键。

`pi-sdk-runtime`：`recordSessionEntry: (customType, data) => appendCustomEntryAndEmit(session, customType, data)`。`RegistryContext` 原样下传。

**Tests：**

- 允许：required → resolved，`status: 'approved'`，`toolCallId` 等于 `execute` 的 id，keys ⊆ 允许集合。
- 拒绝：resolved `denied`，仍抛「未执行」。
- propose 抛错：仍有 resolved `denied`。
- 越界：不 propose、不 record。

跑：`pnpm --filter @sparkii/agent-host test`

---

### Task 2: 通用 Surface 投影

**Files:** `apps/desktop/agents/general/surface/approval-timeline.ts`（新）、同目录测试、`index.tsx`

纯函数 `applyApprovalStatus` 按 spec 绑定表。`GeneralAgentSurface` 用 `useMemo` 投影后再传 `StandardChatSurface`。

**Tests：**

- required 无 result → `awaitingApproval`
- 两张无 result 的 write 已在列表：先 required+resolved 第一张（用 requestId），再 required 第二张。第一张不在等待，第二张在等待。
- 有 `toolCallId` 时绑到对应卡，即使它不是同名 FIFO 的第一张。
- 无配对 required 的 resolved：不改任何卡。
- denied 无 result → `isError`、不在等待
- 无审批行：返回同一引用

跑：`pnpm exec vitest run apps/desktop/agents/general/surface/approval-timeline.test.ts`

---

### Task 3: 拿掉 StandardChat overlay

**Files:** `apps/desktop/src/surface/standard-chat.tsx`、`test/standard-chat.test.tsx`

删 `pendingApprovals`、`approval` 监听、按 Set 盖标志的 map。

原「from approval events」改为：entry 已有 `awaitingApproval` 则显示「等待审批」。另断言对当前会话发 `approval` 事件，已有 result 的卡仍是「完成」。

跑：`pnpm exec vitest run apps/desktop/test/standard-chat.test.tsx`

---

### Task 4: 历史同源夹具

**Files:** `approval-timeline.test.ts`（可与 Task 2 同文件）

用 `normalizeSessionEntries` 喂真实 JSONL 形状：一条 assistant 带两个 `toolCall` write，再 custom required+resolved（第一张的 requestId / toolCallId），再 required 第二张。投影后与 Task 2 两卡夹具一致。

跑相关 vitest；`pnpm --filter @sparkii/desktop exec tsc --noEmit` 若该包脚本存在则跑。

---

## 完成定义

- 允许后 live 卡片不再停在「等待审批」。
- 拒绝后卡片离开「等待审批」。
- 从历史打开：pending 仍等待；已决与当时一致；双 write 不串卡。
- 审批抽屉/预览/台账行为不变。
- JSONL 审批行没有大段正文。
