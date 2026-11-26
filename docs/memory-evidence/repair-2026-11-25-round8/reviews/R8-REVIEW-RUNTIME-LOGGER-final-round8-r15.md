# R8 runtime 域终审（final-r15）

- Task-id：`R8-REPAIR-MEMORY`
- 域：运行时生命周期、prompt 终态关联、workflow lease、日志脱敏与 IPC teardown
- 审查方式：独立只读复审，禁止改动仓库；审查者可自行运行 Vitest 与对照 Pi 发行版源码
- 轮次：final-r13 APPROVE / 0 → final-r14 CHANGES_REQUIRED / 1（`agent_end` 终态语义）→ 修复 → final-r15 复核
- 日期：2026-11-27

## 结论

- Verdict: **APPROVE**
- Blocking finding count: **0**（原始 1 项已修复并加回归）

## 阻断项与闭环

`apps/desktop/electron/main/workflow.ts` 原把任意 `agent_end` 视为本轮终态。Pi 1.5 在每一次有界重试之前
都会派发 `agent_end` 并附 `willRetry`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:766`，
`_willRetryAfterAgentEnd` 定义在 812 行；默认 `retry.enabled=true`、`maxRetries=3`）。于是重试期间：
`finish()` 触发 `off()` 解除监听 → 重试后的最终回答再也进不来 → 步骤以重试前的中途文本被 journal 为
`completed`。

修复：`workflow.ts:374` 改为 `agent_settled || (agent_end && willRetry !== true)`；
`ipc.ts:3646` 的另一条等待路径加上同一道门。默认 harness（`workflow-broker.test.ts:115`）同步改为该门，
并把 `prompt_error` 收敛为“promptId 相同且 `terminal === true`”才结束本轮。

回归：`apps/desktop/test/workflow-broker.test.ts:1251` 以
`message_end(中途文本) → agent_end{willRetry:true} → message_end(最终文本) → agent_settled` 的序列断言
步骤输出必须是最终文本。修复前该用例失败于 `output: "RETRY_INTERMEDIATE_73A"`
（`before/final-r14-workflow-retryable-agent-end.txt`），修复后通过
（`after/final-r14-workflow-retryable-agent-end.txt`）。

## final-r15 复核确认

1. 除上述两处外，全仓仅 `packages/agent-host/src/pi-runtime-pool.ts:468` 还读 `agent_end`，用途是池占用态
   展示（会被随后的 `agent_start`/`turn_start` 纠正），不是 journaling 终态；prompt 串行栅栏（`ipc.ts:1351`）
   只认 `agent_settled`。`normalizeEvent` 跨传输保留 `willRetry`（`packages/agent-host/test/rpc-client.test.ts:53`）。
2. 运行结果：`apps/desktop/test/workflow-broker.test.ts` **43 passed**；
   `apps/desktop/test/runtime-action-router.test.ts` **44 passed**；
   `npx vitest run apps/desktop/test/ipc.test.ts -t "R8 B1 serializes workflow A behind prompt B"` **1 passed / 169 skipped**。
3. 用例完整性：`git diff HEAD` 显示测试文件相对基线只新增用例、无删除、无 skip/only、未调高任何 timeout；
   唯一放宽的断言是 `workflow-broker.test.ts:228` 的拒绝文案正则（同时保留旧分支与 submit 计数断言），
   对应更强的生产 fail-closed 文案，已在映射中记录并有当时的红灯证据。

## 审查者确认仍未处理的非阻断项

- (a) `ipc.ts:2320` 的 prompt lane 返回值不带 settled/cancelled 标记，`waitForSettled` 只由该唯一实现兑现；
  workflow 侧已靠自身事件门 + correlated `prompt_error` + 300s 超时兜底。
- (b) `abortChat` → `completePromptTurnForBinding` 会兑现 `turn.settled`，被中止的步骤仍可能以部分文本
  journal 为 `completed`（`ipc.ts:1374` 只把 `aborted` 当作栅栏释放条件）。
- (c) 拒绝类审计写入失败已改为不使整次派发异常（`runtime-action-router.ts:151` 的 `auditDenial`），
  放行路径仍必须转 `AUDIT_FAILED`（`:602`）。
- (d) 审计截断顺序见 privacy 报告（`packages/approval/src/audit.ts:299`）。
- (e) 原生探针回溯已限制在最近的包根之内（`truth-path.ts:258`）。

## 仍未解决的整轮阻断

`npx vitest run apps/desktop/test/ipc.test.ts` 全文件运行对 `R8 round5 blocker5` 非确定性挂起
（r15 五次重复 4 通过 / 1 失败；单独运行同一用例 5/5 通过；按 describe 组运行时 3 次中 2 次失败）。
定位到被排队的替换轮已通过队列栅栏、停在 `startSessionTask → taskLifecycle.start → createTaskGrant →
admitWorkspace` 的 await 上；句柄快照显示只有定时器悬挂、无未完成 fs 请求。
详见 `reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md`。runtime 审查者判定该披露“充分且诚实”，
但它仍使 R8 整体不予验收、不执行 push。
