# R8 truth 域终审（final-r15）

- Task-id：`R8-REPAIR-MEMORY`
- 域：记忆真相层完整性与崩溃恢复（truth-path / truth-batch / store 读取复用 / 原生探针）
- 审查方式：独立只读复审，禁止改动仓库；审查者可自行运行 Vitest 复现断言
- 轮次：final-r13 APPROVE / 0 → final-r14 CHANGES_REQUIRED / 1 → 修复后 final-r15 复核
- 日期：2026-11-27

## 结论

- Verdict: **APPROVE**
- Blocking finding count: **0**

## final-r14 阻断项与其闭环

阻断项：`PROBE_DAEMON_SOURCE` 以 `require('node:worker_threads')` 开头。`new Worker(code, { eval: true })`
的求值模块类型继承父线程启动方式，按 ESM 求值时 `require` 不存在，worker 编译期即失败；此时主线程已经
停在同步 `Atomics.wait(control, 0, …, 5000)`，`worker.on('error')` 只能排队投递、无法提前唤醒，于是每个
逻辑 truth 边界都要冻结主线程满 5 秒才回退一次性 `execFileSync`。

闭环证据（`after/final-r14-probe-worker-module-kind.txt`）：同一驱动下，修复前的 `require` 形式在
`execArgv: ['--input-type=module']` 时报 `require is not defined in ES module scope`，当前
`Promise.all([import(...), import(...)])` 引导形式在同一模式下 `ALIVE`；生产路径实测 5 次探测 296ms、
调用结束后仍有 1 个常驻 `SandboxProbe.exe`，证明真实走的是 resident bridge。

影响范围界定（同一文件已记录）：默认启动方式（plain node ESM 父线程与 vitest fork）下 bridge 本就正常，
因此 Round7 的 `221 → 151` 探针计数收敛、`4199ms` 基础用例与 r13 隐私用例 1210ms 的既有证据不被推翻。

## final-r15 复核确认的六项

1. worker 源码引导已改为动态 import，两种求值模式都能启动；提取真实常量文本自测通过。
2. `truth-path.ts:197-201` 注册 `error`/`exit` → `invalidate` → `disposeProbeDaemon`；`terminate()` 捕获拒绝
   （`truth-path.ts:160`），监听器在 `probeDaemon = record` 之前挂上，编译期失败不会变成未捕获 `error`。
3. `resolveProbeHelper()`（`truth-path.ts:277-286`）逐级短路 resourcesPath → 模块相对（深度 <8 且在最近
   `package.json` 处停止）→ cwd；探针缺失仍在 `:291` 抛错，零属性返回只可能出现在空路径列表或非 win32。
4. 主线程等待循环（`:214-229`）对状态 1 与 2 续等并重算截止时间；超时/状态 4/意外状态/数量不符
   （`:231/:235/:241/:246`）均先回收 bridge 再抛错，由 `:304` 捕获后回退一次性 `execFileSync`，
   `:314` 再校验长度与取值域 ∈{0,1}，任何异常都 fail closed。
5. `apps/desktop/test/memory-truth-probe-daemon.test.ts` 四条用例真实有判别力：从仓库根与从 `apps/desktop`
   分别运行均为 **4 passed**；`<2000ms` 时间断言对应“bridge 失效应等满 5000ms”的下界（实测 646/671ms），
   常驻子进程计数断言要求 bridge 存活，两者同时失败才能证明回退。
6. 围栏未被削弱：`git diff HEAD` 显示 `removeTruthPathVerified` / `removeTruthPathsVerified` 未改动语义，
   `copyTruthFileVerified` 只增加了 copy 前的 `inspectTruthFileTwice` 复核；store 侧保留逐文件 verified read
   并新增 `expectedIdentity` 与无条件 `assertSnapshotCurrent`。
   `memory-truth-batch.test.ts` + `memory-r8-regression.test.ts` 合计 **113 passed**。

## 审查者提出的非阻断项（记录为后续可优化，不影响结论）

- `truth-path.ts:314` 的取值域异常未先 `disposeProbeDaemon` 就抛错（仍 fail closed，真实异常已由 worker 状态 4 路径回收）。
- `store.ts:879-882` 未按 `ref.corrupt` 过滤，理论上可为仅因 registry/scope 不一致而 corrupt 的文件写入一条
  零记忆的 `scope_files` 哈希行；下一次 `reconcileAllUnfenced`（`store.ts:1067`）会删除它，未暴露未验证内容。

## 与本轮整体门禁的关系

truth 域三个阻断（r13 两项证据/映射、r14 worker 模块类型）均已闭环，本域判定 APPROVE / 0 blocking。
整体 R8 验收仍被 `reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md` 所记的 IPC 全文件非确定性挂起阻断，
该问题不属于 truth 域，且不因本域批准而被视为已解决。
