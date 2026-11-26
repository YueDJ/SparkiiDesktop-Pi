# R8 Round7 修复报告：truth 提交点与 verified copy 源身份窗口

- 日期：2026-11-26
- 基线 HEAD：`101487d3f612764766cc024d4b28dbf846a926cf`
- 权威终审：`docs/memory-evidence/repair-2026-11-25-round8/reviews/R8-REVIEW-TRUTH-RECOVERY-round6-final.md`
- 范围：B1/B2；未处理 B3-B5，未修改 `memory/store.ts`、`memory/service.ts` 或 R7/round7/extraction 测试。

## 结论

B1、B2 均已修复并保存真实修复前红灯与修复后绿灯。最终串行全量结果为 **53/53 passed**，Electron main typecheck 退出码为 **0**。

## 根因与修复

### B1：committed journal 的提交点晚于实际 rename

根因：`atomicWrite()` 在 `renameSync(temp, journal)` 成功后仍会执行 fresh probe、身份、内容和 temp 消失验证；`truth-batch.ts` 原先要等 `atomicWrite()` 返回后才把 `committed` 设为 `true`。因此 rename 已成功、后续验证抛错时，catch 仍走未提交回滚，恢复旧 truth 并删除已提交 journal/backup。

修复：

- `settings.ts` 的 `atomicWrite()` 增加最小 `onRenamed` 回调，在 rename 成功后、任何 post-rename 验证前触发。
- `truth-batch.ts` 在 committed journal 的 rename 回调中立即设置 `committed = true`。
- 若 `atomicWrite()` 未返回就抛错，catch 使用 `readTruthFileVerified()` 安全重读 journal；确认 `committed === true` 后只执行 committed cleanup，绝不 restore。
- 重读无法确认或确认/清理失败时，保留 journal/backup，并持久化 `.truth-write-block.json`，停止后续写入。
- 安全确认后清理成功时保留原始验证错误；不误报为“清理失败”。

### B2：destination 最后探测后 source 身份已过期

根因：`copyTruthFileVerified()` 早期读取并验证 source，随后完成 destination 的 fresh probe/双 lstat，再直接 `copyFileSync()`。source 可在 destination 探测窗口被替换为外部硬链接，外部字节先落入 destination，post-copy 检测无法撤回写入。

修复：

- 保留 destination 的首次与最后双 lstat 检查；在最后 destination 检查之后、`copyFileSync()` 之前，立即对 source 再做 fresh probe + 双 lstat，并与先前 source 身份比较。
- copy 后继续验证 source 身份、destination 路径属性/单链接属性、destination 稳定身份和内容。
- Windows 覆盖既有 destination 时，完整身份中的 `size/mtimeMs/ctimeMs` 可能合法变化；post-copy 检查因此锚定新捕获的 destination 身份，同时仍要求既有 destination 的 `dev/ino/mode/nlink` 不变。该调整由全量回归中原有“多文件失败后回滚”用例暴露，避免把合法覆盖误判为攻击，同时保留对目标替换和硬链接的检测。

## 回归覆盖

### B1

`memory-truth-batch.test.ts` 新增 `once` / `persistent` 两个生产路径用例：

- 通过真实 `atomicWrite()` 的 rename 回调，在 committed journal rename 后、`atomicWrite()` 返回前注入属性探测失败。
- 两种情况都断言目标保持 `COMMITTED_TRUTH_B1_92D\n`。
- `persistent`：committed journal、原始 backup、write-block 均保留；再次 `recoverTruthBatch()` 仍报告写入阻断，目标不回滚。
- `once`：安全重读确认 committed 后按 committed cleanup 删除 journal/backup；再次恢复返回空警告，目标仍为新值。

修复前两个用例均真实失败：期望新值，实际为 `ORIGINAL_TRUTH_B1_71C\n`。

### B2

新增 production recovery 与 production copy helper 两个用例：

- 在 destination 最后一次探测窗口，把 source 替换为真实外部硬链接。
- Recovery：修复前 truth 被 `EXTERNAL_COPY_SOURCE_SECRET_B2_83E\n` 覆盖；修复后在 copy 前拒绝硬链接，truth 保持 `PARTIAL_TRUTH_B2_71C\n`，外部文件不变，journal/backup 被隔离，write-block 存在。
- Direct copy：destination 使用 `.truth-backups/0.backup`；修复前被 `EXTERNAL_COPY_BYTES_B2_83E\n` 覆盖；修复后保持 `DESTINATION_BYTES_B2_92D\n`，外部字节未进入该 backup。

注意：recovery 用例的攻击源本身就是 backup 路径，被攻击者替换后隔离的 backup 必然保留攻击者硬链接内容，这是证据保留要求；外部字节未进入 truth。direct copy 用例单独证明外部字节未进入作为 destination 的 backup。

## 命令与精确计数

所有 Vitest 命令均使用 `--maxWorkers=1 --no-file-parallelism`。

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| B1 before | `pnpm exec vitest run apps/desktop/test/memory-truth-batch.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose -t 'R8 review truth round7 B1'` | exit 1；`2 failed \| 51 skipped (53)` |
| B1 after | 同上 | exit 0；`2 passed \| 51 skipped (53)` |
| B2 before | `pnpm exec vitest run apps/desktop/test/memory-truth-batch.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose -t 'R8 review truth round7 B2'` | exit 1；`2 failed \| 51 skipped (53)` |
| B2 after | 同上 | exit 0；`2 passed \| 51 skipped (53)` |
| 全量 after | `pnpm exec vitest run apps/desktop/test/memory-truth-batch.test.ts --maxWorkers=1 --no-file-parallelism` | exit 0；`53 passed (53)`，1 file passed |
| Electron typecheck | `pnpm --dir apps/desktop exec tsc --noEmit -p tsconfig.electron.json` | exit 0；无 TypeScript 诊断 |

## 证据文件

- B1 before：`docs/memory-evidence/repair-2026-11-25-round8/before/round7-truth-commit-point.txt`
- B1 after：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-truth-commit-point.txt`
- B2 before：`docs/memory-evidence/repair-2026-11-25-round8/before/round7-truth-copy-source.txt`
- B2 after：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-truth-copy-source.txt`
- 全量 after：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-truth-batch-full.txt`
- Typecheck after：`docs/memory-evidence/repair-2026-11-25-round8/after/round7-electron-typecheck.txt`

SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| B1 before | `f7dedf826f4543c06f26145a232d18777d329520002a893f48705e6135776316` |
| B1 after | `f37cb7100ad93ff45f0e6fa39019d90b27c6a1b65d8eabd4ae736b48fad382d7` |
| B2 before | `7ef02d8c715e646c5be13e109e2f222521f3517a866040c86d6eee62562f987b` |
| B2 after | `08e528cb8c3dfe2c16870a8b33c028c7287277ba6e58da21d711a62efe0b955f` |
| 全量 after | `cc7f42531ef84039119d07527d2a330ff7476b7f61a802b4c86dc2a0209f1059` |
| Typecheck after | `f347c78f76546a50223a1fbc8907e89d415bc4889c0aebfa3efa7a8bde592f39` |

## 修改文件

- `apps/desktop/electron/main/memory/settings.ts`
- `apps/desktop/electron/main/memory/truth-batch.ts`
- `apps/desktop/electron/main/memory/truth-path.ts`
- `apps/desktop/test/memory-truth-batch.test.ts`
- 本报告及上述 before/after 证据文件

## 限制与未解决风险

- 本次修复关闭指定的 destination 探测窗口，但不声称消除 Windows TOCTOU：最后 source 检查与 `copyFileSync()` 之间仍存在理论竞态。
- 未引入跨进程 dataDir 锁；多进程同时操作同一 memory 目录仍不在保证范围。
- 未增加 power-loss 级目录 fsync；现有文件 fsync/rename 保证不等于断电持久性保证。
- Windows symlink EPERM 仍按既有 fail-closed 行为处理，未绕过权限或平台限制。
- 所有回归只使用临时目录/临时 DB；未触碰真实用户目录、数据库、CI/CD、依赖版本或 R7 证据。
- 工作树原有大量未提交修改未被覆盖、回退或提交；本任务未执行任何 git 写操作。
