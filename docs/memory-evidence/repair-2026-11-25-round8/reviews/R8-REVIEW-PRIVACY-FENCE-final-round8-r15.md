# R8 privacy 域终审（final-r15）

- Task-id：`R8-REPAIR-MEMORY`
- 域：隐私删除、脱敏登记与写入/读取围栏（service / audit / logger / settings 删除入口）
- 审查方式：独立只读复审，禁止改动仓库；审查者可自行运行 Vitest 复现断言
- 轮次：final-r13 CHANGES_REQUIRED / 2（均为证据与映射问题）→ 修复 → final-r14 CHANGES_REQUIRED / 2（N1 封存缺失、N2 审计截断）→ 修复 → final-r15 复核
- 日期：2026-11-27

## 结论

- Verdict: **APPROVE**
- Blocking finding count: **0**

## final-r14 两项阻断的闭环

**N2（真实缺陷，已修复并加回归）**：`auditReviewer()` / `auditDecision()` 在把 detail 交给
`AuditStore.append()` 之前先 `JSON.stringify(summary).slice(0, 512)`。当登记过的秘切落在 512 边界上时，
截断留下的前缀不再等于登记的完整串，指纹匹配认不出来，这段明文会被永久写入 `.db` 与 `-wal`。
修复：`packages/approval/src/audit.ts:299` 把上限移到逐列脱敏之后、在 `append()` 内部施加；
预截断调用点全部取消——`runtime-action-router.ts:136`、`runtime-action-router.ts:175`、
`workspace-file-service.ts:102`、`workspace-file-service.ts:200`、`ipc.ts:3233`、`workspace-relocation.ts:151`。
`memory/tools.ts:53` 经复核保留（其 payload 仅为 `scope:id`、`{length, sha256}` 摘要、`{proposalId}`、
数值计数与固定字面量，不含自由文本）。
两条新回归：`packages/approval/test/audit.test.ts:124`（跨边界秘切，断言入库恰为 512 字符、
`.db`/`-wal` 不含秘切前 12 字符）与 `apps/desktop/test/runtime-action-router.test.ts:800`
（600+ 字符 reviewer reason 必须完整抵达 `audit.append`）。前后实测见
`after/final-r15-audit-payload-cap-order.txt`：临时恢复预截断后 router 用例报
`expected '{"policyVersion":…' to contain '_TAIL_AFTER_CAP'`，还原后 56 passed。

**N1（封存证据尚未生成）**：属本轮收尾步骤，报告落盘后按“源码清单 → 锚点哈希 → Git 盘态 → 证据清单 →
独立复核”的顺序生成，映射“最终验证”一节按该顺序描述，未提前宣称已封存。

## final-r15 复核确认

- 域内不变量在代码与用例两个层面成立：构造期围栏先于 sink 注册与建库（`service.ts:124/125/126/136/143/147`）；
  `privacyDeleteBySession` 先 preflight 再不可逆清理（`:1237`）；单 sink 失败保留 journal、读取围栏与 write-block
  （`:1258-1293`）；重启恢复重新加载（`:951-962`、`:1134-1181`）。
- journal 替换前完整清零旧 journal（`service.ts:1097-1105` → `removeZeroedPrivacyFile` `:984-1051`，
  含清零前/回读/清零后三段围栏与 `O_RDWR | O_NOFOLLOW`），失败保留原始原因（`:1203-1209`）。
- 物理换行秘切不再破坏 JSONL 记录边界：`privacy-redactions.ts:120-127` 登记变体，
  `logger.ts:127` 的 `containsAcrossRecords` 在 `rewrite()` 中抛错阻断。
- 探针改动对隐私路径无 fail-open：worker 引导失败退出 71、`error`/`exit` 回收 bridge、
  超时/状态 4/意外状态/数量与取值域异常均抛错并回退一次性 `execFileSync`。

## 审查者复现的运行结果

- `packages/approval/test/audit.test.ts`：**12 passed**
- `apps/desktop/test/runtime-action-router.test.ts`：**44 passed**
- `npx vitest run --no-file-parallelism apps/desktop/test/logger.test.ts packages/approval/test/audit.test.ts apps/desktop/test/memory-r8-regression.test.ts`：
  **110 passed**（logger 38 + audit 12 + memory-r8 60）
- 本轮最终候选门禁（串行完整套件两轮 595 passed / 1 skipped、focused 5 files 204 passed、
  Approval package 95 passed、agent-host 219 passed、Runtime A/B/C 1 passed）见
  `after/final-r15-*.txt`；映射引用的行号经逐条抽查与当前树一致（残留 ±2 行漂移已修正）。

## 仍保留的披露（非阻断）

- Windows 路径检查与使用之间的 TOCTOU、symlink EPERM、`.sparkii` 外递归硬链接别名、
  相邻 Pi carrier 密钥非 DPAPI、缺少跨进程 dataDir 锁与断电级 fsync——均为既有披露，未被本轮宣称解决。
- FakeHandle 层测试证明命令、lease 与 teardown 逻辑，不证明真实 Pi 子进程；
  打包 Electron 下常驻探针生命周期与 resourcesPath 仍未做端到端验证。
- 隐私套件按 root 工作目录封存；本轮已把测试内的 `SandboxProbe.exe` 解析改为模块相对，
  从 `apps/desktop` 运行同样通过。
