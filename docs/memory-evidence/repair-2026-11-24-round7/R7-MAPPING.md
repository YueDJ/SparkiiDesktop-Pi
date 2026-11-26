# 第七轮记忆模块修复（R7）交付与验证映射

开始日期：2026-11-24  
最终归档日期：2026-11-25  
仓库：`C:\Users\YDJ\Desktop\SparkiiDesktop-Pi`  
基线及当前 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`

## 1. 缺陷、源码、测试与证据映射

| 缺陷 | 生产源码 | 回归测试 | 修复前证据 | 最终修复后证据 |
|---|---|---|---|---|
| R7-P0-1 递归工具泄露 `.sparkii` | `packages/agent-host/src/workspace-search-tools.ts`、`packages/agent-host/src/tool-registry.ts`、`packages/agent-host/src/workspace-tools.ts`、`packages/agent-host/src/workspace-tree-fence.ts`、`apps/desktop/electron/main/security/workspace-file-service.ts`、`apps/desktop/electron/main/security/workspace-executor.ts` | `packages/agent-host/test/tool-registry.test.ts`、`packages/agent-host/test/workspace-tools.test.ts`、`apps/desktop/test/memory-fence-canonical.test.ts`、`apps/desktop/test/workspace-file-service.test.ts`、`apps/desktop/test/workspace-file-service.integration.test.ts` | `fence/before.txt`、`fence/before-recursive-mutations.txt`、`fence/before-canonical-root.txt` | `fence/after.txt`、`fence/after-focused.txt`、`fence/after-canonical-root.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-1 隐私删除残留明文 | `apps/desktop/electron/main/memory/service.ts`、`apps/desktop/electron/main/memory/store.ts`、`apps/desktop/electron/main/memory/tools.ts`、`apps/desktop/electron/main/memory/types.ts`、`apps/desktop/electron/main/chat-session-store.ts`、`apps/desktop/electron/main/error-store.ts`、`apps/desktop/electron/main/logger.ts`、`packages/approval/src/gate.ts`、`packages/approval/src/audit.ts`、`packages/approval/src/executor.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/main/security/runtime-action-router.ts` | `apps/desktop/test/memory-round7-regression.test.ts`、`apps/desktop/test/memory-audit-regression.test.ts`、`apps/desktop/test/memory-tools.test.ts`、`packages/approval/test/gate.test.ts`、`apps/desktop/test/logger.test.ts`、`apps/desktop/test/ipc.test.ts`、`apps/desktop/test/runtime-action-router.test.ts` | `memory/before-focused.txt`、`memory/before-focused-2.txt`、`memory/before-privacy-approval.txt`、`before-global-truth-redaction.txt`、`approval-execution-races-before.txt`、`final3-privacy-before.txt`、`final3-whitespace-before.txt` | `memory-after-performance.txt`、`approval-execution-races-after-final.txt`、`approval-execution-router-gate-after.txt`、`final3-privacy-after.txt`、`final3-privacy-full.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-2 替换修复重复身份仍报成功 | `apps/desktop/electron/main/memory/service.ts`、`apps/desktop/electron/main/memory/store.ts`、`apps/desktop/electron/main/memory/truth-batch.ts` | `apps/desktop/test/memory-round7-regression.test.ts`、`apps/desktop/test/memory-audit-regression.test.ts` | `memory/before-focused-2.txt`、`truth-index-review-regressions-before-valid-2.txt` | `memory-after-performance.txt`、`truth-index-review-regressions-after-2.txt`、`truth-index-review-regressions-after-repeat.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-3 普通来源删除跨身份冲突仍提交 | `apps/desktop/electron/main/memory/service.ts`、`apps/desktop/electron/main/memory/store.ts`、`apps/desktop/electron/main/memory/truth-batch.ts`、`apps/desktop/electron/main/ipc.ts` | `apps/desktop/test/memory-round7-regression.test.ts`、`apps/desktop/test/memory-audit-regression.test.ts`、`apps/desktop/test/ipc.test.ts` | `memory/before-focused-2.txt`、`truth-index-review-regressions-before-valid-2.txt` | `memory-after-performance.txt`、`truth-index-review-regressions-after-2.txt`、`truth-index-review-regressions-after-repeat.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-4 索引残留或永久缺失 | `apps/desktop/electron/main/memory/store.ts`、`apps/desktop/electron/main/memory/service.ts` | `apps/desktop/test/memory-round7-regression.test.ts`、`apps/desktop/test/memory-audit-regression.test.ts`、`apps/desktop/test/memory-index-fallback.test.ts` | `memory/before-focused-2.txt`、`before-global-truth-redaction.txt`、`truth-index-review-regressions-before-valid-2.txt` | `memory-after-performance.txt`、`conflict-index-isolated.txt`、`truth-index-review-regressions-after-2.txt`、`truth-index-review-regressions-after-repeat.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-5 运行时重置竞态交出已杀槽位 | `packages/agent-host/src/pi-runtime-pool.ts`、`packages/agent-host/src/pi-runtime.ts`、`packages/agent-host/src/pi-runtime-supervisor.ts`、`packages/agent-host/src/pi-runtime-transport.ts`、`apps/desktop/electron/main/workflow.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/main/security/task-lifecycle.ts` | `packages/agent-host/test/pi-runtime-pool.test.ts`、`packages/agent-host/test/pi-runtime-supervisor.test.ts`、`packages/agent-host/test/pi-runtime.test.ts`、`apps/desktop/test/workflow-broker.test.ts`、`apps/desktop/test/ipc.test.ts`、`apps/desktop/test/task-lifecycle.test.ts` | `runtime-logger/pool-before.txt`、`runtime-direct-facade-before.txt`、`pool-workflow-blockers-before.txt`、`binding-lease-races-before.txt`、`pool-stale-release-before-valid-2.txt`、`ipc-stale-release-before.txt`、`final4-task-admission-before.txt` | `runtime-logger/pool-after.txt`、`runtime-direct-facade-after.txt`、`pool-workflow-blockers-after-final.txt`、`binding-lease-races-after-2.txt`、`ipc-stale-release-after-2.txt`、`final4-ipc-after.txt`、`final4-task-lifecycle-after.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |
| R7-P1-6 日志脱敏破坏 JSONL/schema | `apps/desktop/electron/main/logger.ts` | `apps/desktop/test/logger.test.ts` | `runtime-logger/logger-before.txt`、`logger-escaped-malformed-before.txt`、`final3-logger-before.txt` | `runtime-logger/logger-after.txt`、`logger-escaped-malformed-after.txt`、`final3-logger-after.txt`、`full-run-final-serial-1.txt`、`full-run-final-serial-2.txt` |

## 2. 最终验证命令与结果

全量相关套件按文件串行执行；在用户给定文件列表上增加 `--maxWorkers=1 --no-file-parallelism`，未删文件、未改测试阈值。

```sh
NO_COLOR=1 pnpm exec vitest run apps/desktop/test/*memory*.test.* apps/desktop/test/workspace*.test.* apps/desktop/test/action-normalizer.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/logger.test.ts apps/desktop/test/windows-platform.test.ts packages/agent-host/test/tool-registry.test.ts packages/agent-host/test/coding-tools.test.ts packages/agent-host/test/pi-runtime-pool.test.ts packages/agent-host/test/pi-runtime-supervisor.test.ts --maxWorkers=1 --no-file-parallelism
```

- 第一轮：`full-run-final-serial-1.txt`，25 个文件通过，389 项通过，1 项既有跳过，耗时 145.68 秒。
- 第二轮：`full-run-final-serial-2.txt`，25 个文件通过，389 项通过，1 项既有跳过，耗时 121.93 秒。
- 两轮均在最终 final-4 task-grant commit 修复之后执行，结果一致。
- 全量类型检查：`NO_COLOR=1 npm.cmd run typecheck`，通过，见 `typecheck-final.txt`。
- 补充重点验证：`final3-privacy-full.txt` 23/23、`final3-logger-after.txt` 21/21、`final3-workflow-full.txt` 30/30、`final4-ipc-after.txt` 6/6、`final4-task-lifecycle-after.txt` 5/5。
- `git diff --check`：通过；仅有 Git 的 LF/CRLF 提示，无空白错误。
- 最终 Git 状态、HEAD、暂存区与补丁哈希：`final-git-state.txt`。
- 当前工作树变更源码/测试 SHA-256：`source-sha256.txt`。该清单包含任务开始前已存在的未提交改动，不把既有工作归为本轮新增。
- 证据 SHA-256：`evidence-sha256.txt`。补丁哈希只覆盖已跟踪文件的 `git diff --binary`；未跟踪证据由该清单单独覆盖。

## 3. 实现说明

- 递归搜索在遍历层排除保留目录；`ls` 在排序、计数和限流前过滤；审批返回路径重新做规范化围栏验证；递归删除/移动和主进程文件写入均先做保留目录检查。
- 隐私删除先收集并保留已知明文语料，全局清理 Gate、Audit、Error、Logger、跨会话记忆真相和 episode，再删除目标真相/索引/会话；外部清理失败不报成功并保留重试语料。
- Gate 中所有保留状态均递归脱敏；已脱敏提案不可再批准或执行。审计和工具摘要改用 ID、数量、长度、SHA-256。提案模式在执行前重新读取 canonical approved 状态，调用方模式携带 proposalId 并在副作用前同步复核；失效等待者以拒绝结束。
- `pendingOp` 只有通过共享结构校验的控制字段才保留；非法 `targetId`、`projectId`、`mergeIds` 及其嵌套内容仍进入明文语料和递归脱敏。纯空白删除词被丢弃，但不裁剪有意义的首尾空白。
- SQLite 使用 `secure_delete`、WAL checkpoint、必要的 `VACUUM`，回归测试直接检查实际数据库/WAL 字节。
- 替换修复与普通来源删除都在任何真相写入前做全量身份预检；冲突时原字节不变且不发成功事件。
- 未注册项目的可搜索索引被驱逐，`scope_files.content_hash` 同时失效；非可搜索恢复元数据仍支持隐私删除定位；冲突解除后未变真相可重新索引。
- 运行时槽位重置期间不可分配；失败清除该 client 的全部 `bySession` 映射；队列、快照和 active 计数使用同一闸门。成功会话切换响应必须返回严格递增的安全整数 generation；不确定响应同步退休槽位。每次绑定分配新 lease，workflow/IPC 在订阅、发送、每个事件和发送完成时校验，旧 lease 的 release/unbind 不能影响同 ID 替代绑定。
- `TaskLifecycle.start()` 在异步 grant 工厂完成后、`registry.start()` 前同步执行所有权 guard；过期的 task admission 不能在同 ID 替代 grant 注册后恢复并撤销替代 grant。
- 日志对 JSON 字符串值做递归脱敏，不改字段名；重写非空文件补尾换行；未来写入与导出共用结构化规则。替换 marker 的每个 Unicode scalar 均不出现在已登记秘密语料中，物理 CR/LF 秘密在分行前清理；畸形历史行用 `JSON.parse` 解码完整字符串 token 并清理全部 JSON escape，无法安全清理的 token/行替换为合法脱敏占位符。

## 4. 架构终审

三个独立只读架构域均明确返回 `APPROVE`：

- `R7-REVIEW-TRUTH-INDEX`：`architecture-review-truth-index-final.txt`。
- `R7-REVIEW-FENCE-PRIVACY`：`architecture-review-fence-privacy-final-4.txt`。
- `R7-REVIEW-RUNTIME-LOGGER`：`architecture-review-runtime-logger-final-5.txt`。

汇总见 `architecture-reviews.md`。

## 5. 未完成项、已知限制与回退

- Windows 主进程路径检查仍存在 TOCTOU 残留风险，本轮未声称修复；没有新的真实复现证据，未扩大范围。
- 当前 Windows 账号下真实 symlink 可能因 EPERM 跳过；回退为保留既有跳过并明确标注，未删测试、未调阈值、未伪造链接。
- 未验证 `.sparkii` 之外递归硬链接别名的完整行为；缺少新的真实复现，未扩大范围。
- 运行时池测试使用现有 FakeHandle/DeferredResetHandle，**未使用真实子进程**；真实子进程生命周期、transport 顺序和 shutdown 行为仍未验证。
- 畸形历史日志行尽可能改写为合法 JSONL；完整字符串 token 无法安全清理时回退为合法脱敏占位符，不保留已登记秘密，也不删除正常记录。
- 完整 IPC 套件曾有一个与本轮无关的 shell-host 环境用例返回 `platform.shell-disabled`；未修改该环境相关路径。R7 IPC 重点用例、TaskLifecycle 和用户指定的最终全量套件均通过。
- 证据目录保留所有中途失败和超时输出；最终通过只认本节列出的最终证据。

## 6. 操作边界

- 未执行 `git reset --hard`、`git checkout --`、`git restore`、`git clean`、强推或删分支。
- 未暂存、提交、推送或修改 Git 配置。
- 未覆盖、删除或改写既有 `docs/memory-evidence/repair-2026-11-24/` 证据。
- 实验只使用临时目录和临时数据库，未触碰真实安装目录、真实用户数据或真实记忆文件。
- 未升级/降级依赖，未修改 CI/CD，未做无关重构。
- R7 不需要 UI 修改或浏览器验证；工作树中既有 UI/记忆改动按原样保留。
