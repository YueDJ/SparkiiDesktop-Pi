# R8 open finding：`ipc.test.ts` 全文件运行对 `R8 round5 blocker5` 存在非确定性挂起

结论先行：这是一个**未解决的门禁阻断**。R8 不宣称验收通过，本轮不推送远端。

## 现象

- `npx vitest run apps/desktop/test/ipc.test.ts`（单文件、无跨文件并行）在 final-r15 的 5 次重复中
  4 次 `170 passed`、1 次 `1 failed | 169 passed`（见 `after/final-r15-ipc-full-repeat{1..5}.txt`）；
  final-r14 同命令 5 次重复为 3 通过 / 2 失败。
- 失败用例固定为 `R8 runtime binding regressions > R8 round5 blocker5 waits for prior prompt turns
  to settle before arming queued replacements`，报错 `Error: Test timed out in 5000ms.`。
- 同一用例单独运行 `-t "blocker5"` 连续 5 次全部通过；
  但按整个 describe 组运行 `-t "R8 runtime binding regressions"` 时 3 次中有 2 次失败。
- 在该用例里插入 250ms 轮询探针后，`replacing` 在 tick 0 即已完成、3 次组运行全部通过——
  说明竞争窗口在毫秒级的微任务/定时器交错内，探针本身改变了调度（Heisenbug）。

## 已定位到的停顿位置

用临时日志（改后按 SHA-256 校验还原，当前树内无残留）追踪 `promptSession` 的排队替换路径：

```
ZZARMED PROMPT_A
ZZTASK-BEGIN PROMPT_A
ZZTASK-DONE PROMPT_A task=...
ZZSEND-BEGIN PROMPT_A
ZZRELEASE turn=...            ← 上一轮 turn 结束、队列释放
ZZARMED PROMPT_B
ZZTASK-BEGIN PROMPT_B         ← 之后再无任何日志
```

即：被排队的替换请求已经越过队列栅栏并创建了 turn，随后停在
`startSessionTask()` → `taskLifecycle.start(async () => createTaskGrant({...}))`
→ `createTaskGrant` 内的 `admitWorkspace()`  await 链上，`ZZTASK-DONE` 从未出现。

挂起 +2.5s 时的句柄快照：

```
ZZPENDING handles=PipeWrap×4,Timeout×13
ZZTIMERCOUNT activeHandles=4 requests=0
ZZHANDLEKINDS Pipe,Socket,Socket,Socket
```

`_getActiveRequests()=0` 排除真实文件系统请求悬挂；等待对象是定时器驱动的 await。

## 已排除的因素

- 不是本轮 truth 原生探针改动：blocker5 使用注入的 fake `probeAttributes` / mock `pathProbe`。
- 不是本轮 audit 改动：`packages/approval` 94 用例、`runtime-action-router` 43 用例全绿，
  且挂起点在 Grant 准入而非审计写入。
- 不是跨用例运行时对象泄漏：`exportRuntime()` 每次新建 `TaskGrantRegistry` 与 `TaskLifecycle`，
  会话队列映射（`promptQueueTailsBySession` / `promptTurnsBySession`）是每个注册闭包私有。
- 不是本轮 workflow/prompt 关联改动：`workflow-broker.test.ts` 42→43 用例全绿，
  `ipc.test.ts` 其余 169 用例在失败运行中也全绿。

## 为什么这是生产隐患而不只是测试脆弱

`promptSession` 的串行栅栏设计要求“上一轮结束 → 替换轮准入”。观测到的形态是替换轮已经创建 turn、
但准入 `createTaskGrant` 的 await 永不返回，此时：

1. 该会话的队列尾部已被替换轮占用，后续 prompt 全部排队；
2. 唯一的兜底是 300s 的 `prompt timeout` 定时器，用户界面会长时间无响应；
3. 触发条件依赖前序用例留下的进程级状态（本文件 170 个用例共享一个 Node 进程），
   因此真实应用中同样可能存在“先前会话遗留的进程级状态使新会话准入悬挂”的等价路径。

具体 awaits 尚未逐行定位（`admitWorkspace` 内部 4 处 await 与注入 `probe` 的 mock 交互），
需要在专门一轮里先建立确定性复现，再判断是生产缺陷还是测试夹具共享进程状态的产物。

## 门禁处置

- 已按事实记录：`final-r15-ipc-full-repeat{1..5}.txt`（4 通过 / 1 失败）。
- 其余门禁均为确定性通过：串行完整套件两轮 594 passed / 1 skipped、focused 5 files 203 passed、
  Approval 94、agent-host 219、Runtime A/B/C 1、`pnpm -w typecheck` Done、`git diff --check` exit 0。
- 因此本轮不宣称 R8 验收完成，不执行 push；`R8-MAPPING.md` 的门禁状态与本条保持一致。
