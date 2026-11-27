# R8-REPAIR-MEMORY architecture reviews

- Date：2026-11-26 首轮，2026-11-27 final-r15 终审
- Repository：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- Review baseline：local HEAD `b411f47` + Round8 review remediation（final-r15 冻结盘态）
- Source manifest：`source-sha256-final-r15.txt`，聚合值记录在 `source-manifest-sha256.txt` 的 r15 锚点行
- Evidence manifest：`evidence-sha256.txt`（对 `repair-2026-11-25-round8/` 全树重扫，仅排除清单自身）；
  独立重算记录见 `after/evidence-sha256-verification-final-r15.txt` 与 `after/source-sha256-verification-final-r15.txt`
- 工作方式：三份互相独立的只读复审，各自运行测试复现断言，互不查看对方结论

## 首轮独立审查（final-r12）

| Domain | Report | Verdict | Blocking |
|---|---|---|---:|
| TRUTH-RECOVERY | `reviews/R8-REVIEW-TRUTH-RECOVERY-final-round8-r12.md` | APPROVE | 0 |
| PRIVACY-FENCE | `reviews/R8-REVIEW-PRIVACY-FENCE-final-round8-r12.md` | APPROVE | 0 |
| RUNTIME-LOGGER | `reviews/R8-REVIEW-RUNTIME-LOGGER-final-round8-r12.md` | CHANGES_REQUIRED | 1 |

Runtime 阻断项：`workflow.sendPrompt()` 在 `rt.promptTurn()` 接受命令时即完成。生产非阻塞 Pi 通道里，
命令接受早于助手终态，因此 LLM 步骤可能返回空/过期输出并提前解除事件监听。

## 中间轮次的阻断项与闭环

| 轮次 | 域 | 阻断项 | 处置 |
|---|---|---|---|
| r13 | PRIVACY | 映射引用的 focused 证据文件当时不存在；大量 `file:line` 引用漂移到无关构造 | 重新运行并落盘 focused 证据；逐条重锚全部引用 |
| r14 | TRUTH | `PROBE_DAEMON_SOURCE` 用 `require` 引导，eval worker 按 ESM 求值时编译失败，每个 truth 边界冻结主线程满 5s 才回退 | 改为动态 `import()` 引导；补 worker `error`/`exit` 监听；等待循环兼容状态 1/2；解析路径逐级短路且限制在包根内。见 `after/final-r14-probe-worker-module-kind.txt` |
| r14 | PRIVACY | 审计 `payload_summary` 在脱敏前截断，跨边界的登记秘切会残留明文前缀 | 上限移入 `AuditStore.append()` 在脱敏之后施加，取消 6 处调用点预截断，新增 2 条回归。见 `after/final-r15-audit-payload-cap-order.txt` |
| r14 | RUNTIME | 任意 `agent_end` 被当作本轮终态，而 Pi 在有界重试前就派发 `agent_end{willRetry:true}`，步骤以重试前文本记为 completed | `workflow.ts:374` 与 `ipc.ts:3646` 加 `willRetry !== true` 门；新增 `workflow-broker.test.ts:1251` 回归，含修复前红灯证据 |

## final-r15 终审

| Domain | Report | Verdict | Blocking |
|---|---|---|---:|
| TRUTH-RECOVERY | `reviews/R8-REVIEW-TRUTH-RECOVERY-final-round8-r15.md` | APPROVE | 0 |
| PRIVACY-FENCE | `reviews/R8-REVIEW-PRIVACY-FENCE-final-round8-r15.md` | APPROVE | 0 |
| RUNTIME-LOGGER | `reviews/R8-REVIEW-RUNTIME-LOGGER-final-round8-r15.md` | APPROVE | 0 |

三域均给出：

```text
APPROVE
Blocking finding count: 0
```

## final-r16：最后一项门禁阻断已关闭

npx vitest run `apps/desktop/test/ipc.test.ts` 整文件运行对 `R8 round5 blocker5` 的非确定性挂起，
根因在测试自身：B、C 两条替换轮在同一同步块并发入队，谁先登记到会话队列尾部由各自 open 阶段的
promise 完成顺序决定，而用例只发一次 `agent_settled` 却断言被放行的必须是 B。修复只动测试
（`blocker5` 改为逐个入队，并新增“C 在 B 终态之前不得发送”的断言；新增 `blocker5b` 覆盖并发入队的确定序放行），
生产实现未改动；把栅栏临时改为“不等待前一轮”后两条用例同时失败，判别力成立，随后按 SHA-256 校验还原。

复验：`ipc.test.ts` 全文件连续 10 次 `171 passed`；曾经的触发对与整个 runtime 绑定组各连续 6 次全绿。
证据见 `after/final-r16-ipc-full-repeat{1..10}.txt`、`after/final-r16-blocker5-queue-race-trace.txt`、
`after/final-r16-blocker5-fix-and-mutation-check.txt`；纠错过程（含此前“停在准入 await”的错误结论如何产生）
保留在 `reviews/R8-FINDING-IPC-BLOCKER5-NONDETERMINISM.md`。

final-r16 门禁全绿：串行完整套件两轮 595 passed / 1 skipped、focused 204、Approval 95、agent-host 219、
Runtime A/B/C、`pnpm -w typecheck` Done、`git diff --check` exit 0。三域终审（r15）之后只改动了
`apps/desktop/test/ipc.test.ts` 一个测试文件，被评审的生产实现未变，故三域 APPROVE / 0 blocking 仍然成立。
## 遗留的非阻断项（三域共同确认，不在本轮解决）

- `ipc.ts:2320` 的 prompt lane 返回值不带 settled/cancelled 标记，`waitForSettled` 仅由该实现兑现。
- `abortChat` 兑现 `turn.settled` 后，被中止步骤仍可能以部分文本 journal 为 `completed`。
- `truth-path.ts:314` 取值域异常未先回收 bridge（仍 fail closed）。
- `store.ts:879-882` 不按 `ref.corrupt` 过滤，理论上写入一条零记忆的 `scope_files` 行，下一次 reconcile 删除。
- Windows TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名、相邻 Pi carrier 密钥非 DPAPI、
  缺少跨进程 dataDir 锁与断电级 fsync、FakeHandle 不等于真实 Pi 子进程、打包 Electron 下常驻探针生命周期未验证。
