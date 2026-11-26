# R8 round7 runtime/logger 修复报告

## 范围与独立核验

- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 指定基线 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`。工作树已有大量并行 R6/R7/R8 未提交修改，本次只改下方 CHANGES 所列 runtime/IPC 文件，未回退或覆盖其他修改。
- 权威入口：`docs/memory-evidence/repair-2026-11-25-round8/reviews/R8-REVIEW-RUNTIME-LOGGER-round6-final.md`。
- 除阅读生产代码和测试外，核验了已安装 Pi SDK 1.5.0 的 `dist/core/agent-session.js` 与 `dist/core/agent-session-runtime.js`：无 model/auth 及 prepare 失败可发生在 `_startRun()` 之前或其 prepare catch 中，这些路径不会走到发送 `agent_settled` 的 finally；`switchSession()`/`newSession()` 也没有 SDK 层互斥。报告中的 B1/B2 均成立。

## 根因与生产修复

### B1：opening bind/release 生命周期竞态

**根因**

1. `bind()` 在首次 await 前发布 alias，但 configure/switch 尚未完成；`release()` 可同时卸 alias 并发送 `new_session()`，迟到的 switch 又把已删除会话恢复到复用 child。
2. `cancelAcquire()` 只取消 queued acquisition，不等待已进入 bind 的 promise。
3. release 没有与 opening/resetting 共用可验证的所有权边界；alias 消失被误当成安全复用证据。

**生产入口与修复**

- `packages/agent-host/src/pi-runtime-pool.ts`
  - `Slot.lifecycleTail` + `enqueueLifecycle()` 为同一 child 的 `configure_session`、`switch_session`、`new_session`、bind 和 release 建立单一 promise-tail 串行化通道。
  - `send()` 对生命周期命令入队；已在 lane 内的 bind/release 使用 `sendNow()`，避免递归入队。
  - bind 的 alias 仍在 await 前发布以阻止并发 acquire，但 configure/switch/最终 `ownsBinding()` 检查全部位于 lane 内；每次 await 后复查 cancellation。
  - cancellation 或 ownership 不确定时调用 `retireSlot()` 并等待 supervisor 确认退出，不再仅删除 alias 后复用。
  - release 合并到同一 lane，执行时才重新检查 client/lease/session ownership；reset 未确认前保持不可用。
  - 新增 `waitForAcquire()`，覆盖 queued acquisition、正在执行的 bind 和 cancellation retirement。
- `apps/desktop/electron/main/ipc.ts`
  - privacy stop 先捕获 `waitForAcquire()` promise，再 `cancelAcquire()`，然后把该 promise 交给 `stopSessionRuntimeOwned()`。
  - 删除流程等待 cancelled acquisition/bind 完成（包括 reset 或确认 exit）后，才读取 binding、停止抽取/解析并执行破坏性提交；binding 在等待期间变化会拒绝删除。

**回归**

- pool 使用 delayed `switch_session`，让旧代码中的 release/`new_session` 与 replacement 先完成，确定性地复现“未 kill、同一 child 被复用、reset 已发生”的危险状态。
- 修复后断言 late switch 完成前 release/replacement 均未结算、没有 reset、child 已退休；late switch 后旧 child 被 cancel/退出，replacement 使用新 child。
- IPC 回归证明 destructive memory/session cleanup 等待 cancelled opening bind 结束。

### B2：pre-run/prepare prompt 拒绝无终态

**根因**

1. SDK 的确定性 prompt 拒绝可能不产生 `agent_settled`；原适配器只发 `runtime_error(command=prompt)`，IPC 不把它当终态，导致 `PromptTurn`、admission 与 `TaskGrant` 永久占用。
2. 原 `adaptSession()` 每次调用都创建独立 `runtimeErrorListeners`。`createPiRuntime()` 订阅的 wrapper 与实际执行 prompt 的 wrapper 不是同一个，真实 SDK 拒绝因此可能根本到不了 runtime listener。本次同时把 listener 集合提升到 host 作用域。
3. `agent_settled` 没有 turn id，不能安全地用 generic error 释放当前或 replacement turn。

**生产入口与修复**

- `packages/agent-host/src/types.ts`、`pi-runtime.ts`、`pi-sdk-runtime.ts`
  - prompt command/options 增加可选 `promptId`。
  - `PiRuntimeError` 增加 `promptId`/`terminal`。
  - `startPromptWithoutBlocking()` 捕获非阻塞 prompt promise 的拒绝；有有效 correlation id 时标记为 terminal。
  - `createPiRuntime()` 仅把 `command=prompt`、`terminal=true` 且 id 非空的错误转换为专用 `prompt_error`；其他错误仍为 generic `runtime_error`。
  - `handleCommand()` 将 `promptId` 传入实际 SDK session。
- `apps/desktop/electron/main/ipc.ts`
  - 每个 `PromptTurn` 生成独立 UUID，并随 prompt command 下发。
  - `ensureProcessPipe()` 只消费精确匹配当前 turn、ready 状态、slot client、live binding client/lease、admission/task ownership、`command=prompt`、`terminal=true` 和 `promptId` 的 `prompt_error`。
  - 原 turn 仍拥有 grant 时才调用 `lifecycle.end()`；已取消且不再拥有 grant 的 turn 只释放串行 barrier，绝不结束 replacement 的 grant。
  - 允许当前原 turn 的 own-terminal 在 prompt response/post-send ownership assertion 恢复前完成清理；turn 被移除后例外立即失效。
  - round6 post-send barrier 保持不变：一旦 prompt command 已尝试且 transport 结果不明确，response/get_state 失败不会释放 queue，仍等待 owned/cancelled terminal、abort 确认 idle 或 binding retirement。
- pool 将 `prompt_error` 与既有 terminal runtime event 一样恢复为 `occupied-idle`。

**回归**

- adapter：pre-run 拒绝和已启动 prompt 拒绝都保留原 `promptId` 与 terminal 标记。
- 真实已安装 SDK host（不是 FakeHandle）：无 model 拒绝，以及使用临时目录、临时 auth/model saddle、仅 spy `_prepareRun` 的 prepare 拒绝；后者断言 `_prepareRun` 调用一次、没有 `agent_start`/`agent_settled`，但产生 correlated `prompt_error`。
- IPC：确定性失败释放 A 后 B 可运行；abort A 后启动 B，A 的 late correlated error 和携带 B id 的 generic `runtime_error` 均不结束 B，B 最终正常 settled。

## 精确串行验证

所有 Vitest 命令均使用 `--maxWorkers=1 --no-file-parallelism`。

### 修复前真实红灯

```bash
pnpm exec vitest run packages/agent-host/test/pi-runtime-pool.test.ts -t "R8 round7 B1" --maxWorkers=1 --no-file-parallelism
```

结果：**1 failed, 53 skipped**。危险状态为 `releaseSettled=true`、`replacementSettled=true`、`resetRequests=1`、`killed=false`、`handles=1`。
证据：`docs/memory-evidence/repair-2026-11-25-round8/before/round7-runtime-privacy-opening.txt`。

```bash
pnpm exec vitest run packages/agent-host/test/pi-sdk-runtime-queue.test.ts packages/agent-host/test/pi-sdk-runtime.test.ts apps/desktop/test/ipc.test.ts -t "R8 round7 B2" --maxWorkers=1 --no-file-parallelism
```

结果：**3 files failed；6 failed, 179 skipped, 185 total**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/before/round7-runtime-prompt-error.txt`。

### 修复后聚焦绿灯

```bash
pnpm exec vitest run packages/agent-host/test/pi-runtime-pool.test.ts apps/desktop/test/ipc.test.ts -t "R8 round7 B1" --maxWorkers=1 --no-file-parallelism
```

结果：**2 passed, 221 skipped**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-privacy-opening.txt`。

```bash
pnpm exec vitest run packages/agent-host/test/pi-sdk-runtime-queue.test.ts packages/agent-host/test/pi-sdk-runtime.test.ts apps/desktop/test/ipc.test.ts -t "R8 round7 B2" --maxWorkers=1 --no-file-parallelism
```

结果：**3 files passed；6 passed, 179 skipped, 185 total**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-prompt-error.txt`。

### 受影响套件

```bash
pnpm exec vitest run \
  packages/agent-host/test/pi-runtime-pool.test.ts \
  packages/agent-host/test/pi-runtime-pool-skill-isolation.test.ts \
  packages/agent-host/test/pi-runtime-pool-saddle.test.ts \
  packages/agent-host/test/pi-runtime.test.ts \
  packages/agent-host/test/pi-runtime-supervisor.test.ts \
  packages/agent-host/test/pi-runtime-command-data.test.ts \
  packages/agent-host/test/pi-runtime-transport.test.ts \
  packages/agent-host/test/rpc-client.test.ts \
  packages/agent-host/test/pi-sdk-runtime.test.ts \
  packages/agent-host/test/pi-sdk-runtime-queue.test.ts \
  packages/agent-host/test/pi-sdk-runtime-skill-rebind.test.ts \
  packages/agent-host/test/pi-sdk-session-boundary.test.ts \
  packages/agent-host/test/pi-sdk-tool-loadout.test.ts \
  packages/agent-host/test/pi-sdk-host-tools.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

结果：**14 files passed；126 tests passed**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-agent-host-affected.txt`。

```bash
pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/task-lifecycle.test.ts apps/desktop/test/workflow-broker.test.ts --maxWorkers=1 --no-file-parallelism
```

结果：**3 files passed；223 tests passed**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-desktop-affected.txt`。

```bash
pnpm exec vitest run packages/agent-host/test --maxWorkers=1 --no-file-parallelism
```

结果：**32 files：31 passed, 1 failed；214 passed, 2 failed**。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-agent-host-full.txt`。
两项失败均在既有 `packages/agent-host/test/runtime-actions.test.ts`：工作树已有 `runtime-actions.ts` 的 `sessionGeneration` envelope 改动，而旧测试仍期待不含该字段的 exact object。此文件不属于本任务 CHANGES，未修改。

### Typecheck 与 diff 检查

```bash
pnpm --filter @sparkii/desktop typecheck
```

结果：renderer 与 Electron 两个 TypeScript project 均通过。
证据：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-typecheck.txt`。

对本任务 CHANGES 的生产/测试文件执行 `git diff --check`，无输出。

## CHANGES

### 生产代码

- `packages/agent-host/src/pi-runtime-pool.ts`
- `packages/agent-host/src/pi-runtime.ts`
- `packages/agent-host/src/pi-sdk-runtime.ts`
- `packages/agent-host/src/types.ts`
- `apps/desktop/electron/main/ipc.ts`

### 测试

- `packages/agent-host/test/pi-runtime-pool.test.ts`
- `packages/agent-host/test/pi-sdk-runtime-queue.test.ts`
- `packages/agent-host/test/pi-sdk-runtime.test.ts`
- `apps/desktop/test/ipc.test.ts`

### 本报告与证据

- `docs/memory-evidence/repair-2026-11-25-round8/reviews/R8-FIX-round7-runtime.md`
- `docs/memory-evidence/repair-2026-11-25-round8/before/round7-runtime-privacy-opening.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-privacy-opening.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/before/round7-runtime-prompt-error.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-prompt-error.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-agent-host-affected.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-desktop-affected.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-agent-host-full.txt`
- `docs/memory-evidence/repair-2026-11-25-round8/after/round7-runtime-typecheck.txt`

## 限制与未解决风险

- FakeHandle 回归只证明 runtime 协议与主进程状态机；真实 SDK host 回归证明已安装 SDK 的拒绝路径，不等于真实 Pi 子进程/provider 端到端验证。
- 未发起真实 provider 请求，未验证真实凭据、网络故障或真实 Pi child 的进程级 switch/new_session 时序。
- Windows TOCTOU、symlink `EPERM`、跨进程锁仍未验证；本次没有改动或声称解决这些隐私域限制。
- agent-host 全套仍有上述两个既有 `runtime-actions` exact-envelope 失败；并行工作树后续改动可能改变最终合并结果，合并后需重跑。
- 未修改 memory service/store/extraction/types 或其测试，未改 CI/CD、依赖版本、R7 证据或真实用户目录/数据库；未执行任何 git 写操作。
