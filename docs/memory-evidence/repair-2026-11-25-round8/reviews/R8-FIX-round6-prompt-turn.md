# R8-FIX-round6-prompt-turn

- 日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 修复项：`R8-REVIEW-RUNTIME-LOGGER final-round5 B1` — prompt 已投递后，post-send `get_state` 失败或 ownership 变化时错误释放串行 barrier
- 结论：B1 已修复，指定 7 个测试文件串行 **291/291 通过**，两个 pool 伴随 fixture 修正后 **3/3 通过**，最终 `pnpm typecheck` 通过。

## 范围

仅修改生产与测试：

- `apps/desktop/electron/main/ipc.ts`
- `apps/desktop/test/ipc.test.ts`
- `packages/agent-host/test/pi-runtime-pool-saddle.test.ts`
- `packages/agent-host/test/pi-runtime-pool-skill-isolation.test.ts`

两个 pool 伴随文件仅补齐 fake `new_session` 响应中生产 pool 已要求的严格递增 `sessionGeneration` 契约；没有修改 pool/supervisor/transport/SDK 生产代码。

另写入本报告及指定的 before/after 证据。未修改 R7、runtime pool、supervisor、transport、SDK、Memory 或其他生产文件；未提交 Git。

## 根因

复审定位的原问题在 `apps/desktop/electron/main/ipc.ts:2144-2162`（复审时行号）：prompt 命令已经成功派递后，catch 仍无条件调用 `completePromptTurn`。Pi 的 `agent_settled` 不带 turn id，barrier 一旦提前释放，replacement B 就会在 A 仍可能运行时 arm；随后 A 迟到的 settled 会被错误归属给 B。

## 实现

- `apps/desktop/electron/main/ipc.ts:969-991`：`PromptTurn` 增加不可变 binding 身份 `client/lease` 与 `started` 标记，避免用 session id 单独判断旧事件归属。
- `apps/desktop/electron/main/ipc.ts:1002-1016`：新增按 binding/admission 释放的 helper；binding 已消失时才允许无 binding 释放，防止旧 teardown 释放同 id replacement。
- `apps/desktop/electron/main/ipc.ts:1278-1322`：仅在 replacement 已 arm（`readyForSettled`）后接受 `agent_start`/`turn_start`，避免 arm 前旧 start 污染标记；owned settled 必须同时满足 started，cancelled/aborted terminal 仍可释放。这样 B arm 后、首个 start 前的额外迟到 settled 不会消费 B。
- `apps/desktop/electron/main/ipc.ts:1334-1350`：进程退出先结束当前 admission，再退休 binding，最后释放 barrier；旧 binding 的退出事件不能释放新 lease。
- `apps/desktop/electron/main/ipc.ts:1647-1661`：`unbindAndRelease` 只有在 binding 消失或 client/lease 已变化后释放对应 turn；`new_session` 失败由 pool 退休 slot，未确认退休前不提前放行。
- `apps/desktop/electron/main/ipc.ts:2113-2114`、`:2188-2214`：新增 `promptMayBeRunning`。send 一旦尝试即视为不确定运行态；只有明确的失败响应或 send 前失败才释放。成功后 post-send `get_state` reject、ownership assert 失败均不再把 command failure 当作 turn ended。
- `apps/desktop/electron/main/ipc.ts:2226-2255`：abort 先撤销 admission，再发送 abort，并用 `waitForIdle()` 确认 runtime 已 idle 后按 captured binding/admission 释放。
- `apps/desktop/electron/main/ipc.ts:2770-2813`、`:2910-2944`：stop/release 的 `get_state` transport 错误不再阻断 slot 退休；无 binding 分支也清理残留 barrier。workspace/stop/cancellation 因此仍可通过既有 teardown 路径恢复队列。

## 新增回归

`apps/desktop/test/ipc.test.ts:6496-6561`：

1. A 的 prompt 命令已成功发送并 arm，但 post-send `get_state` 挂起后 reject。
2. 尝试 B，断言 A settled 前发送记录仍只有 `PROMPT_A`。
3. A 发 `agent_start` 后 settled，B 才发送并取得新 task/admission。
4. A settled 后、B arm 前插入一个旧 start；B 首个 start 前再投一个迟到 settled，断言旧 start 未被计入、`TaskLifecycle.end` 未调用、B task/admission 不变。
5. B 自己的 start + settled 才结束 B。

既有正常 terminal 回归补齐了真实协议已有的 start 事件，未跳过用例、未放宽 timeout、未弱化断言：

- `apps/desktop/test/ipc.test.ts:1739-1830`
- `apps/desktop/test/ipc.test.ts:6384-6448`
- `apps/desktop/test/ipc.test.ts:6452-6494`
- `apps/desktop/test/ipc.test.ts:6613-6691`

## 验证与精确计数

### 修复前红灯

命令：

```text
pnpm exec vitest run apps/desktop/test/ipc.test.ts -t "R8 round6"
```

结果：1 个文件，166 项中 **1 failed / 165 skipped**，退出码 1。失败断言为 A terminal 前出现了 `PROMPT_B`：

```text
expected [ 'PROMPT_A', 'PROMPT_B' ] to deeply equal [ 'PROMPT_A' ]
```

原始输出：`docs/memory-evidence/repair-2026-11-25-round8/before/round6-prompt-turn.txt`

### 修复后聚焦绿灯

命令：

```text
pnpm exec vitest run apps/desktop/test/ipc.test.ts -t "R8 round6" --maxWorkers=1 --no-file-parallelism
```

结果：1 个文件，166 项中 **1 passed / 165 skipped**，退出码 0。

原始输出：`docs/memory-evidence/repair-2026-11-25-round8/after/round6-prompt-turn.txt`

### 指定完整套件串行

命令：

```text
pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/workflow-broker.test.ts apps/desktop/test/workflow-knowledge.test.ts apps/desktop/test/workflow-document-read.test.ts apps/desktop/test/task-lifecycle.test.ts packages/agent-host/test/pi-runtime-pool.test.ts packages/agent-host/test/pi-runtime-supervisor.test.ts --maxWorkers=1 --no-file-parallelism --reporter=dot
```

结果：**7 个文件全部通过；291 passed / 0 failed / 0 skipped**，退出码 0。

- `apps/desktop/test/ipc.test.ts`：166
- `apps/desktop/test/workflow-broker.test.ts`：40
- `apps/desktop/test/workflow-knowledge.test.ts`：1
- `apps/desktop/test/workflow-document-read.test.ts`：1
- `apps/desktop/test/task-lifecycle.test.ts`：14
- `packages/agent-host/test/pi-runtime-pool.test.ts`：53
- `packages/agent-host/test/pi-runtime-supervisor.test.ts`：16
- 合计：291

### 类型与 diff 检查

- `git diff --check -- apps/desktop/electron/main/ipc.ts apps/desktop/test/ipc.test.ts`：退出码 0。
- `pnpm typecheck`：最终重跑退出码 0；`packages/ui` 与 `apps/desktop`（renderer + electron tsconfig）均通过。本次未修改任何 Memory 文件。

### 额外 pool 巡检与 fixture 修正

初次另外运行两个 pool 伴随测试时，均因既有 fake `new_session` 响应缺少 `sessionGeneration` 而在 `packages/agent-host/src/pi-runtime-pool.ts:241` 抛出 `RuntimeSessionGenerationError`：

- `packages/agent-host/test/pi-runtime-pool-saddle.test.ts`：当时 1 failed / 1 passed。
- `packages/agent-host/test/pi-runtime-pool-skill-isolation.test.ts`：当时 1 failed。

随后只修正两个测试 fixture 的响应契约，使其返回生产 pool 已要求的严格递增 `sessionGeneration`；没有改生产 pool 或降低断言。重跑结果：**2 files passed，3 passed / 0 failed / 0 skipped**。原始输出：`docs/memory-evidence/repair-2026-11-25-round8/after/round6-pool-fixtures.txt`。主 `pi-runtime-pool.test.ts` 的 53 项也已全部通过。

## FakeHandle 限制

新增回归使用生产 `registerIpc` 路径与内存 `FakeHandle`，能证明 IPC admission、queue barrier、事件归属和 teardown 调用顺序；但 `FakeHandle` 不启动真实 Pi 子进程，事件由测试手动注入，不能证明真实 Pi 的事件时序、transport 半成功语义、进程退出/强杀行为或 SDK 内部调度。真实运行时行为仍需 Electron + Pi 子进程集成验证。
