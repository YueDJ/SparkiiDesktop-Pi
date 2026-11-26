# R8-FIX-round6-gate-listener

- 日期：2026-11-26
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 修复项：final-round5 privacy review B1 — invalidation listener 失败后重试可能无通知解除 `privacyBlocked`
- 结论：FIXED

## 范围

Gate 单元修复范围：

- `packages/approval/src/gate.ts`
- `packages/approval/test/gate.test.ts`

另写入本报告及指定的 before/after 证据。后续在 `apps/desktop/test/memory-round7-regression.test.ts:795` 补充真实 MemoryService 集成回归，详见 `R8-FIX-round6-truth-privacy.md`；未修改 MemoryService、workflow、R7 或其他生产文件，未提交 Git。

## 实现

- `packages/approval/src/gate.ts:14-18`、`:23`：新增进程内 `pendingInvalidations`，按 proposal 保存最新 canonical 对象及已成功通知的 listener 集合。
- `packages/approval/src/gate.ts:195-222`：新增重放逻辑。每个 proposal 只重调尚未成功的当前 listener；已成功 listener 不重复调用。重放时与当前 listener 集合比较，因此排队期间新增的 listener 会收到通知，已注销 listener 不再调用。
- `packages/approval/src/gate.ts:224-267`：非空 `redactTexts` 先尝试重放，但收集重放错误后仍继续执行 Audit 登记，避免待通知队列阻断新隐私模式登记。
- `packages/approval/src/gate.ts:236-255`：Audit 登记成功后才扫描并替换 proposal canonical。只有 `redactValue` 实际检出脱敏变化才计入 `changed` 并入队；重试没有新变化时返回 0，不会重复制造 invalidation。同一 proposal 已有未完成通知时只更新其 canonical 对象，不重复调用已成功 listener。
- `packages/approval/src/gate.ts:260-267`：只有错误为空且通知队列为空才解除 `privacyBlocked`；Audit 与 listener 同时失败时错误均保留在聚合错误中。
- `packages/approval/src/gate.ts:96-105`、`:225-228`：`updateApprovedPayload` 和空 `redactTexts` 仍只执行 fail-closed 检查，不重放、不清队列、不解除封锁。

生产调用链只读核对：

- `apps/desktop/electron/main/workflow.ts:52-55`：listener 通过 `settle()` 拒绝并结算审批等待。
- `apps/desktop/electron/main/memory/service.ts:1138-1154`：Gate 抛错后保留清理失败状态，不继续完成删除。
- `apps/desktop/electron/main/memory/service.ts:1171`：仅全部清理成功后才清除 pending privacy journal。

## 新增回归

| 测试 | 关键断言 | 位置 |
| --- | --- | --- |
| listener 首次 throw、第二次 success | 实际调用 1→2；第二次重放先于 Audit 登记；第二次 `redactTexts` 返回 0；两次收到同一 canonical 对象；status 保持 `pending` 且 `privacyRedacted=true`；仅 1 条 `proposal.created`；第二次后封锁解除 | `packages/approval/test/gate.test.ts:83-125` |
| listener 持续失败 | 两次均抛错并保持封锁；listener 实际调用 2 次；Audit 登记实际调用 2 次；第二语料 `laterSecret` 即使重放失败仍已登记 | `packages/approval/test/gate.test.ts:127-149` |
| 逐 listener 状态与新增 listener | 首次成功 listener 不重复调用；失败 listener 恰好重试 1 次；排队期间新增 listener 调用 1 次并收到 canonical | `packages/approval/test/gate.test.ts:151-183` |
| 模拟 MemoryService journal | Gate 失败时 journal 保留且删除未完成；重放成功后 journal 清除、删除完成，listener 实际调用 2 次 | `packages/approval/test/gate.test.ts:185-222` |

真实 `MemoryService` + `ApprovalGate` + Audit 集成回归另见 `apps/desktop/test/memory-round7-regression.test.ts:795`：首次 listener 抛错后生产删除失败、journal 保留、truth 仍含秘密且 Gate 读取阻断；第二次生产删除重放成功后 journal 清除、truth/list/Audit 无秘密。完整三文件 127/127 证据见 `after/round6-truth-privacy.txt`，报告见 `R8-FIX-round6-truth-privacy.md`。

## 验证与精确计数

### 修复前红灯

命令：

```text
pnpm exec vitest run packages/approval/test/gate.test.ts -t "R8 round6 B1" --maxWorkers=1 --no-file-parallelism
```

结果：1 个文件，21 项中 **4 failed / 17 skipped**，退出码 1。四项失败分别证明重试未调用 listener、持续失败被错误解除、新增 listener 丢失、journal 在未重放下被清除。

原始输出：`docs/memory-evidence/repair-2026-11-25-round8/before/round6-gate-listener.txt`

### 修复后聚焦绿灯

同一命令：1 个文件，21 项中 **4 passed / 17 skipped**，退出码 0。

### 完整 gate + audit 串行

命令：

```text
pnpm exec vitest run packages/approval/test/gate.test.ts packages/approval/test/audit.test.ts --maxWorkers=1 --no-file-parallelism
```

结果：**2 个文件全部通过；32 passed / 0 failed / 0 skipped**，退出码 0。

- `packages/approval/test/gate.test.ts`：21 tests
- `packages/approval/test/audit.test.ts`：11 tests
- 合计：32 tests

### 类型与 diff 检查

- `pnpm typecheck`：退出码 0；递归范围为 9/10 workspace projects，实际执行 `packages/ui` 与 `apps/desktop` 的 typecheck script；desktop 依次运行两个 `tsc --noEmit` 配置。
- `git diff --check -- packages/approval/src/gate.ts packages/approval/test/gate.test.ts`：退出码 0。

修复后原始输出：`docs/memory-evidence/repair-2026-11-25-round8/after/round6-gate-listener.txt`

## 限制与后续

1. listener API 仍是同步 `(proposal) => void`；异步 listener 的 Promise 拒绝不在本次契约范围内。真实服务集成回归现已补充，但 listener 仍由测试主动抛错，不覆盖异步 listener。
2. 通知队列与 proposal 一样是**进程内状态**，不提供跨进程重启持久化；本次修复保证同一 Gate 实例上的失败重试，不改变既有 proposal 存储模型。
3. listener API 仍是同步 `(proposal) => void`；异步 listener 的 Promise 拒绝不在本次契约范围内。
4. 未运行 Electron、真实 Pi 子进程或全仓测试；本次完整验证范围是指定的 Gate + Audit 串行测试和 workspace typecheck。未跳过完整 Gate/Audit 测试，未弱化断言，未调整超时，未动 R7，未提交。
