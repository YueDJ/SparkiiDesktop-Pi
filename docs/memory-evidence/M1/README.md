# M1 验收证据

- 日期：2026-11-23
- 所有路径相对仓库根。原始输出文件保留在本目录；scratch 中的构建/临时产物在交付前清理。

## 1. FTS5 trigram 运行时探测（M1 第 0 步）

`fts-probe.txt`：SQLite 3.53.4，`CREATE VIRTUAL TABLE ... tokenize='trigram'` 成功；三字及以上中文查询命中 1，两字查询命中 0（trigram 固有限制，检索层对 <3 字查询退化 LIKE）。单测 `memory-scoring.test.ts` / `memory-service.test.ts` 均确认 `probeFts5Trigram().available === true`。未走 LIKE 回退。

## 2. 真实 IPC 手动新增 → 新会话 prompt 注入取证

- `injection-log.txt`：隔离配置实例（CDP）中通过 renderer IPC `sparkii:addMemory` 新增「用户要求所有汇报先给结论，正文不超过三句」并置顶，再 `sparkii:createSession` 建新会话；主进程日志原文含完整 `<memory> ... [用户] (2026-11-23) ... </memory>` 块。
- 取证不是界面绿勾：日志由 `saddle.ts` 的 `buildAgentSaddle(..., memoryBlock)` 生产路径写出；单测 `saddle-memory` 用例另证块追加在鞍文本末尾。
- `settings-memory-dark.png`：深色主题设置页「记忆」面板截图（CDP 截图，已目视复核）。

## 3. 围栏与生命周期

- `apps/desktop/test/memory-fence.test.ts`：调用真实 `createCodingToolDefinitions` 的 write 工具执行 `.sparkii/memory.json` 写入 → 抛「平台保留目录」，且 `requestAction` 从未被调用；普通路径写入仍走原管道。`resolveGuardedReadPath`、delete/move、主进程 `workspace-file-service` list/write 同样实测拒绝/过滤。
- `apps/desktop/test/memory-service.test.ts`：注入不重置时钟、检索命中重置且两次检索命中/增量一致；pinned/半衰期/预算逻辑见 `memory-scoring.test.ts`；auto 工作区不建项目记忆；编辑/置顶/删除（含历史版本）/归档/重建索引/损坏停止注入与修复/搬迁自愈/全部 pending 出口有用例。
- `scratch/cdp/localappdata/.../data/memory/` 与 `memory.db` 由真实实例生成，工作树中的 scratch 目录交付前清理。

## 4. 三件套

- typecheck：`typecheck-summary.txt`（连跑两次均通过，原始输出曾在 scratch）。
- lint：`lint-summary.txt`（两次均 0 error；27 个 warning 均为仓库既有，本模块未新增）。
- test：`test-summary.txt`。记忆模块新增 19 个用例全通过；全量测试唯一失败为既有环境相关用例 `windows-sandbox-spike.test.ts > documents the Git Bash AppContainer limitation instead of enabling it`：`Error: cannot grant runtime ACL`，其原生 helper 调用 `reg.exe`，被本机安全策略拦截。
- 基线证明：`baseline-spike.txt` 在未改动的 HEAD 工作树上单独复跑同一用例，得到完全相同的失败（`1 failed | 7 passed`），确认非记忆模块引入。

## 5. CDP console / network 审计

- 记忆面板加载期间：`Runtime.exceptionThrown = 0`、`Log.entryAdded = 0`、`Network.loadingFailed = 0`。
- 唯一 warning：Electron 开发态 `Insecure Content-Security-Policy`，出现在应用初始工作台页面（进入设置页之前），文案明确「This warning will not show up once the app is packaged」。同类全局审计结论：框架级、非记忆模块引入、打包后消失。未通过关闭检查来消除。
