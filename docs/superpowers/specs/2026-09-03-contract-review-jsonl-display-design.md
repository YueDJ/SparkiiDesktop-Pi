# Contract Review JSONL Display (Live + History) — Design Spec

**Status:** Draft (pending human review)
**Date:** 2026-09-03
**Branch:** current working branch
**Depends on:** `docs/superpowers/specs/2026-09-02-agent-surface-template-and-contract-review-design.md`（薄契约 / live-history 同源）
**Amended by:** `2026-09-05-live-session-pipeline-design.md`（JSONL 仍是已提交落盘真相；live 起步在进程活着时用会话树 + in-flight，事件按 TUI 全量透传）

## Goal

让合同审核 Surface 与通用聊天使用**同一条真相管道**：Pi JSONL 是唯一事实源；实时显示是 JSONL 追加的 SDK 回声；打开历史仍可写。平台只写入通用 custom 条目，业务 key 与渲染归 Agent Surface。

## Confirmed Decisions

1. 不新增 IPC，不新增事件通道，不让 Electron 伪造另一种 chat-event。
2. 写入走 Pi SDK `SessionManager.appendCustomEntry`；实时走与 `pi.appendEntry` 相同的 `{ type: "entry_appended", entry }`。
3. JSONL 行形状以 SDK 为准：`{ type: "custom", customType, data, id, parentId, timestamp }`。
4. 历史会话保持可写：打开后继续订阅，与通用聊天打开旧对话相同。`mode` 不切断数据面。
5. 平台写入只含引擎生命周期 + 不透明 `data`；不写 `stepId: 'report'` / `action: 'result'` 等合同专用字段。
6. Contract Surface 是 `session.entries` 的纯投影；复核只通过现有 `updateWorkflowState` 追加 custom 行。
7. 窗口底栏只保留运行池按钮（`运行 n/max · q 排队`）。不在底栏显示 workflow 步骤文案。
8. **运行池的管理与显示一律不动**（acquire/release/queue、`runtime-pool` 事件、RuntimeCenter、底栏右侧按钮、App 里对池的订阅与 stop/release/cancel）。
9. 平台生产代码不按 agent id 分支。agent 由 `agents/*/manifest.yaml` 在打包时组合进来（surface 绑定是生成物）。顺手清掉：`ScreenId` 里的 agent-id、`'chat'`/`'dashboard'` 占位导航、`runtime.ts` 按 id 的 surface/tools 兜底、IPC 缺省 `profileId ?? 'general'`。测试夹具和生成文件可以出现真实 agent id。
10. 通用聊天的架构、设计和运行路径这次完全不动。
11. 原文 PDF 预览放到下一阶段统一规划，本次不动。

## SDK Facts (verified against `@earendil-works/pi-coding-agent@0.84.4`)

| 事实 | 含义 |
| --- | --- |
| `appendCustomEntry` 只 `_appendEntry`（入内存 + 落盘） | 直接调 SessionManager **不会** `subscribe` |
| `pi.appendEntry` = `appendCustomEntry` + `_emit({ type: "entry_appended", entry })` | 这才是通用聊天自定义行的 live 路径 |
| 当前 `pi-sdk-runtime.appendWorkflowEntry` 只调 SessionManager | 合同自定义行有 JSONL、无 live |
| `normalizeEvent` 对 `entry_appended` 只放行用户消息和 `custom_message` | `type: "custom"` 会变成 `unknown` 被丢掉 |
| 当前 `src/surface/normalize.ts` 认 `type === "workflow_step_start"` | 与真实 JSONL 的 `type: "custom"` 对不上，历史回放也会漏 |

## Architecture

```text
appendCustomEntry(customType, data)
        → JSONL  { type: "custom", customType, data, id, parentId, timestamp }
        → AgentSession._emit({ type: "entry_appended", entry })   // 与 pi.appendEntry 相同
        → subscribe → normalizeEvent → pipeSessionEvents → 现有 chat-event
        → useAgentSession.applySurfaceEvent
        → session.entries

打开会话：openChatSession → 同一 normalizeSessionEntries（按 JSONL 原顺序）
写复核：actions.review → 现有 updateWorkflowState → 同一 append 路径
```

Surface 不读 `sparkii:event:state` / 游离 `workflow.result`，也不读 `sparkii:event:workflow`。

窗口最底下的 StatusBar 分两截，不要混：

- **右侧按钮**「运行 n/max · q 排队」：运行池摘要，点开运行中心。这次**整条链路冻结**（不只按钮）：`runtime-pool` 事件、RuntimeCenter、App 的 `mapRuntimePool` / stop / release / cancel。与 workflow IPC 无关。
- **左侧灰字** `statusText`：现在被填成「正在执行:load」，来自 `sparkii:event:workflow`。产品不需要这句；步骤进度只出现在合同工作台自己的顶栏（从 JSONL 推导）。App 传空字符串即可。`StatusBar` 组件的 `statusText` 槽位可留着，不必删组件。

因此不再以「壳还要用」为由保留 `sparkii:event:workflow`：主进程停止 `send`，App / `useAgentSession` 停止监听。失败仍走现有错误中心，不靠这条通道。

合同审核走同一套运行池：slot 管的是 Pi 进程，不是某个 Agent 的专用线程。`runWorkflow` 与 `promptSession` 都 `pool.acquire`；底栏 `0/4` 和 RuntimeCenter 已经会显示合同会话。这次只补一件：workflow 会话不要走聊天的 `agent_settled → idle-release`，以免技能调用中途把 slot 放掉。池本身的上限、排队、停止、释放、取消都不改。

## Data Shape

### 平台引擎写入（任意 workflow Agent）

| customType | data（不透明字段仅此） |
| --- | --- |
| `workflow_step_start` | `{ stepId, startedAt }` |
| `workflow_step_end` | `{ stepId, status, finishedAt, error?, output? }` |

`stepId` / `output` 来自该 Agent 的 `workflow.yaml` 与 runner 的 `state[step.id]`。平台不解读 `output`。

**删除**整段结束后的合同专用行：`{ customType: "workflow_state", data: { stepId: "report", action: "result", payload: finalState } }`。逐步 `output` 即权威结果；compaction 后消息可能被摘要，custom 行仍在，适合 UI。

### Agent 自己写的状态行

现有 `updateWorkflowState(sessionId, entry)` 仍 `appendCustomEntry("workflow_state", entry)`。`entry` 的 key 由调用方（Agent）决定。合同审核使用例如：

```text
{ stepId: "review", action: "risk_confirmed", payload: { riskId } }
{ stepId: "review", action: "risk_comment", payload: { riskId, note } }
{ stepId: "report", action: "report_merged" }
```

平台不解析这些 key。App 的 `review(action, payload)` 应把 Agent 传入的对象展开进 `entry`，使 JSONL 的 `data` 与 Surface 读取路径一致（`data.payload.riskId`，而不是扁平 `data.riskId`）。

### 平台 SessionEntry（薄）

```text
SessionEntry = ChatEntry | CustomSessionEntry

CustomSessionEntry
  kind: "custom"
  id: string
  customType: string
  data: Record<string, unknown>
  timestamp?: number
```

`deriveWorkflowTimeline` 可以留在平台：只认 `customType` 为 `workflow_step_start` / `workflow_step_end`（引擎词汇）。  
`extractWorkflowResult` 改为按 `stepId` merge 各步 `output`（`result[stepId] = output`），不再认 `action === "result"`。合同 Surface 用 `result.review` / `result.report` 是因为 workflow 步骤就叫这些名字。

## Platform Changes (minimal, with impact)

不改 preload 方法名与返回形状 `{ ok, sessionId }`。

### 1. 适配层对齐 `pi.appendEntry`

**Where:** `packages/agent-host/src/pi-sdk-runtime.ts` 的 `appendWorkflowEntry`。

写入后对 AgentSession 发出 `{ type: "entry_appended", entry }`，使现有 `createPiRuntime` 的 `subscribe → normalizeEvent` 能转发出去。`AgentSession._emit` 为 private：适配层复现 `pi.appendEntry` 那两行（append + emit 同一事件形状）。加测试：append 后 `subscribe`/`onEvent` 收到 `entry_appended`，且 `entry.type === "custom"`。

**Impact:** 仅走 `append_workflow_entry` 的会话；通用 `prompt` 路径不变。

### 2. `normalizeEvent` 透传 custom

**Where:** `packages/agent-host/src/rpc-client.ts`。

`entry_appended` 且 `entry.type === "custom"` → `{ type: "entry_appended", entry }`（整行保留）。用户消息映射保持现状。

**Impact:** 通用聊天若没有 custom 行则无可见变化。`standard-chat` 仍用 `kind === message|tool|event` 过滤，不会把 workflow custom 画成气泡。

### 3. Surface 归一化认 Pi 形状，保持时间顺序

**Where:** `apps/desktop/src/surface/normalize.ts`、`contract.ts`。

- 认 `{ type: "custom", customType, data }` 与 live 的 `{ type: "entry_appended", entry }`。
- **按 JSONL / 事件原顺序**交错 chat 与 custom，禁止把全部 workflow 条目前置。
- custom 行 id 用 Pi 的 `entry.id`，禁止 `Date.now()+random`。

**Impact:** 合同历史回放从「对不上标记」变为能还原；聊天回归测试必须仍绿。

### 4. `runWorkflow` 先交 sessionId，并接入同一条事件管

与 `promptSession` 对齐：会话 `create` + 改名之后**立刻**让 renderer 拿到 `sessionId`，runner 在后台继续。preload 的 `runWorkflow` 仍返回 `{ ok, sessionId }`，语义变为「已开始」而非「已结束」。

必须同时：

- 在 session 就绪时 `pipeSessionEvents`（与聊天同一函数），否则 SDK 事件到不了 renderer。
- **workflow 会话禁止 `agent_settled → scheduleIdleRelease`。** 聊天在一轮结束后会闲置释放 slot；若 workflow 的 `sendPrompt` 也触发 `agent_settled`，会在后续步骤跑到一半时把 slot 释放掉。workflow 的 slot 只由 runner 结束时的 `pool.release` 释放。判断：`chatSessions.get(id)?.kind === "workflow"` 则跳过 idle-release。
- `try/finally` 不能在「返回 sessionId」时释放 slot；后台 loop 结束后再 release。失败则写 `workflow_step_end` `status: "failed"` 并 release。

**Impact:** `workflow-broker.test.ts` 中「await runWorkflow 即完成」要改为：promise 在第一阶段返回 id，完成靠 JSONL/事件或测试里等 loop。`promptSession`、会话列表、审批 IPC 不动。

### 5. 逐步 `output` 写入 `workflow_step_end`

`step_completed` 时把 `e.output` 放入 `data.output`。不要再写合同专用的最终 `workflow_state result`。

**Impact:** 仅 workflow JSONL；聊天 JSONL 不变。导出路径若读 `session.result.report`，在 merge-by-stepId 后对合同仍成立。

### 6. 停掉 `sparkii:event:workflow`（及工作台用的 `state` 结果灌入）

底栏不再需要步骤文案后，这条通道没有产品消费者：

- `workflow.ts` 不再 `webContents.send('sparkii:event:workflow')`，也不再为了灌画面而 `send('sparkii:event:state', { workflow: { result } })`。
- `App.tsx` 不再听 `workflow` 填 `workflowStatusByAgent` / `statusText`；传给 Shell 的 `statusText` 为空。失败仍 `reportError`（可在 runner 失败路径直接调错误中心，或等 Surface 从 `workflow_step_end failed` 显示）。
- `useAgentSession` 不再听 `workflow` / `state` 改 `status`/`result`。
- **不要**改运行池：主进程 pool、idle-release 以外的 slot 生命周期、`runtime-pool` 通道、RuntimeCenter、底栏右侧按钮、App 的池订阅与 stop/release/cancel。workflow 只改「`kind === workflow` 时跳过聊天 idle-release」这一条，避免 slot 被提前释放。

**Impact:** `app-workflow` 里靠 `channels['workflow']` 断言「审核中：load」的用例改为喂 `chat-event` / entries。`StatusBar` 组件 API 可保留 `statusText`。

### 7. 清掉平台生产代码里的 agent-id 分支和占位屏

Agent 身份来自 `apps/desktop/agents/*/manifest.yaml`，打包时 `generate-surface-bindings.mjs` 生成 `surfaceByAgent`。平台只认 `listAgents()` / `manifest.surface.type`，不在源码里写死 `'general'` / `'contract-review'`。

会清：

- `ScreenId` 目前把 `'chat' | 'dashboard' | 'general' | 'contract-review'` 和平台屏写在一起。改为平台屏 `'home' | 'approvals' | 'audit' | 'settings'`；`ShellAgent.id` 用 `string`。删掉 `navigate` 把 `'chat'`/`'dashboard'` 打回首页的占位。删未使用的 `isChatSurface`。
- `runtime.ts`：`id === 'general'|'contract-review'` 的 surface/tools 兜底，以及从 `agents/general`、`agents/contract-review` 直接 import capabilities。surface 与 tools 只来自已加载的 manifest（两个 Agent 的 yaml 都已声明）。
- `ipc.ts`：`profileId ?? 'general'`、`agentId ?? 'general'`。调用方必须带上当前 agent；缺了就失败或跳过，不假装存在一个叫 general 的默认 Agent。

可以留下：测试夹具里的真实 agent id；生成文件 `agent-surface-bindings.ts`；`agents/` 目录名本身。

**不要**从 `SurfaceType` / `SessionKind` 去掉预留的 `dashboard` 枚举（给未来 Agent 的 schema）。**不要**改通用聊天实现。

**Impact:** 壳类型、`shell.test`、`App.navigate`、`runtime.ts`、少数 ipc 缺省；运行池行为不变。

### 8. 数据面始终订阅

`useAgentSession` 只要有 `sessionId` 就 `openChatSession` + 听 `chat-event`，不再用 `mode !== "live"` 挡住。App 打开历史只绑 `sessionId`（可继续传 `mode: "history"` 作 UI 提示，但不分流）。

**Impact:** 合同历史可继续复核；聊天本来就是始终 live，行为不变。

## Agent Changes (majority of UI)

`ContractAgentSurface`：

- 每次渲染从 `session.entries` 推导阶段、findings、报告、复核 map、是否已合并。不把这些做成会与 JSONL 分叉的 `useState`。
- 本地 state 仅限：筛选、勾选、备注草稿、面板折叠、idle 时尚未入会话的选文件。
- `load|search|review` → 审核；`report` → 报告；人工关卡 → 复核。失败步高亮，已有 `output` 保留。
- `actions.review("risk_confirmed", { stepId: "review", payload: { riskId } })`，使 JSONL `data` 与读取一致。
- live 骨架：有 `review` start、尚无其 `output` → 风险区骨架；有 `report` start、尚无 `output` → 报告骨架。

## Error Handling

- JSONL 损坏 / 读失败：空 entries，Surface 显示过程不完整，不伪造结果。
- 输入文件 missing：沿用 `meta.inputs[].missing`。
- 某步失败：该步 `workflow_step_end.status = failed`，后续步不写成功 end；已完成步的 output 仍在。
- `append_workflow_entry` 失败：catch 后步骤仍以 runner 事件推进引擎，但 UI 可能短暂落后；不得用第二套 `state` 事件补画面。
- 适配层 emit 失败：JSONL 仍在，打开历史可恢复；live 会缺这一帧。测试必须锁住 emit。

## Testing

- agent-host：`append_workflow_entry` 之后 subscribe 收到 `entry_appended`，`entry.type === "custom"`。
- `normalizeEvent`：custom 透传；用户 `entry_appended` 仍映射为 user message。
- surface-normalize：真实 Pi 行（`type: "custom"`）能推导 running/done/failed；live `entry_appended` 与 history 同形；顺序与 JSONL 一致。
- useAgentSession：history 模式下仍应用 `chat-event`；`result.review` 在对应 step_end 到达后出现。
- workflow-broker：sessionId 在第一阶段返回；slot 在 loop 结束前不被 idle-release；step_end 含 output；无 `stepId: "report"` 的最终专用行。
- contract-surface：只喂 entries 即可渲染风险/报告/复核；history 可点确认并调用 `review`；entries 增量时确认状态不被 `useEffect` 冲掉。
- 壳：`ScreenId` 不含 agent-id；`navigate` 无 `'chat'`/`'dashboard'` 特判。`runtime.ts` 不再按 id 兜底 surface/tools，也不再 import 具体 agents。ipc 不再默认 `profileId = 'general'`。运行池摘要数字与 RuntimeCenter 行为不变。
- 回归：`standard-chat` / `app-general` / `surface-normalize` / `shell` 仅作防误伤，不改聊天实现。

## Out of Scope

- **原文 PDF 预览**：合同页看原文。下一阶段统一规划，本次不设计、不实现。
- **运行池的管理与显示**：主进程 pool、queue、`runtime-pool` IPC、RuntimeCenter、底栏右侧按钮、App 的池订阅与 stop/release/cancel。唯一相关改动是 workflow 会话跳过聊天 idle-release。合同审核已经走同一套 Pi 进程池。
- 落地 dashboard Surface；也不从 `SurfaceType` / `SessionKind` 去掉预留的 `dashboard` 枚举。
- **新 IPC / 改 `AgentSurfaceActions` 方法集**（见下节：不是还想加接口，是明确这次不加）。
- **通用聊天**：`standard-chat`、general surface、聊天会话/队列/模型选择，架构和实现都不动。回归测试只用来保证合同这条管道没有误伤聊天。

### 什么叫「不新增 IPC / 不改 AgentSurfaceActions」

现有 preload 已经够用，例如：`runWorkflow`、`updateWorkflowState`、`openChatSession`、`requestExportReport`、`chooseDocument`，以及现有 `chat-event`。

`AgentSurfaceActions` 现有六项也不改名字、不增方法：

`newSession` / `openSession` / `startWorkflow` / `review` / `requestExport` / `chooseDocument`

这次**不会**做例如：再开一条 `sparkii:event:workflow-progress`、给 Surface 加 `subscribeTimeline`、把 `review` 拆成 `confirmRisk`、给 `requestExport` 加参数。复核仍走现有 `review` → `updateWorkflowState`；只修正传入对象不要被 App 摊平。实时显示走现有 `chat-event`，不新开通道。

## Self-Review Notes

- 无 TBD：emit 路径、JSONL 形状、idle-release、early sessionId、Agent 投影、平台 agent-id 清理均已选定。
- 与「不要第二套真相」一致：不合成新事件类型，只补 SDK 已有的 `entry_appended`。
- 范围是一条管道 + 平台生产代码里无用的 agent-id 分支，不拆第二个 spec。
- `extractWorkflowResult` 按 stepId merge，避免平台认识「报告」这个业务词；步骤名仍来自各 Agent 自己的 yaml。
- 运行池整条链路冻结；通用聊天实现冻结；PDF 预览留到下一阶段。
