# Desktop E2E Coverage — Design Spec

**Status:** 待产品评估（架构师 Approve with nits；must-fix 已吸收）。**未获产品点头前不得写 Playwright / harness / testid。**
**Date:** 2026-09-05
**Depends on:** Live session pipeline（`2026-09-05-live-session-pipeline-design.md`）；Runtime ⊥ Viewport（`2026-09-04-runtime-viewport-decoupling-design.md`）；合同 JSONL 显示（`2026-09-03-contract-review-jsonl-display-design.md`）；通用智能体（`2026-08-25-general-agent-design.md` §12）；合同 pilot 验收（`docs/2026-08-22-design.md` §11）
**Does not replace:** 上述规格的产品行为。本文件只规定 **Playwright + 真 Electron 窗口** 要守住哪些用户可见不变量，以及哪些继续只靠 Vitest。
**Does not implement:** 只落文档。执行计划里的 Task 1–6 要等产品评估通过。

## Goal

现有 3 条 E2E 是旧产品冒烟：合同批准终态、通用智能体打开 Composer、设置页切供应商。它们 **不能** 抓住「合同 live 必须等跑完、切走再回来才看到结果」——那条回归只等「审核完成」。

本规格把 E2E 收成一张分层清单：只测窗口里用户能看见、且跨主进程 / Pi 子进程 / renderer 才会坏的行为。管道内部形状、盖章、先听后快照、崩溃丢槽，继续只靠已有 Vitest。

## Current Inventory（已有，不删）

| 文件 | 断言 | 模型依赖 |
| --- | --- | --- |
| `apps/desktop/e2e/pilot.spec.ts` | 上传 → 审核 → 批准 → 「审核完成」→ 审计 `proposal.approved` | 文件级 `SPARKII_SKIP_LLM=1` 整文件跳过（本轮改成按 test skip） |
| `apps/desktop/e2e/general.spec.ts` | 通用智能体 Composer 可见、`workspace-path` 含 `Sparkii` | 无 |
| `apps/desktop/e2e/provider-settings.spec.ts` | 设置页切 DeepSeek / Ollama、保存 key | 无 |

缺口：无 `playwright.config`；三条用例各自 `electron.launch`；CI（`.github/workflows/ci.yml`）只跑 `pnpm test`（Vitest），不跑 Playwright。`pilot.spec.ts` 的 `agent-card-contract` 与真实 id `contract-review` 不一致，本轮改掉。

## What counts as E2E

E2E = Playwright 驱动 **已构建的** renderer + `dist-electron/main/index.js` + 真窗口。

必须同时满足：

1. 走真实主进程 IPC 与 Pi 子进程（或它启动失败时的可见失败，不得伪造成功）。
2. 断言落在 **用户可见** 的 DOM（`data-testid` / 稳定 role / 可见文本），不读主进程内存、不订 `chat-event` 做第二套时间线。
3. 不新开生产 IPC、不注入 Pi 事件、不把 slot 钉死、不按 agent id 分叉管道。

## What stays Vitest（明确不做 E2E）

这些已有或应留在单元/集成里。做成 E2E 只会慢、飘、并且测不到比 Vitest 更多的产品面：

| 不变量 | 为什么不是 E2E |
| --- | --- |
| `normalizeEvent` 恒等、未知 type 不裁 | 无窗口 |
| 活着起步 `getBranch()` + `streamingMessage`；微缝才碰 `get_messages` | 主进程 RPC，已有 `ipc.test.ts` |
| 盖活 `sessionId`、解绑丢事件、`session_unbound` | 主进程，已有 `ipc.test.ts` |
| 崩溃槽不进空闲池、死后 `send()` 立刻抛 | 池子 / supervisor |
| `sendPrompt` 全文替换、`+= delta` 禁止 | workflow 集成 |
| 步骤行 append 失败恰好一行错误中心 | 需注入写盘失败；Vitest 已覆盖 |
| 先听后快照、换会话丢缓冲、compaction 整表换树 | renderer 纯函数 + hook |
| `bash_execution_update` 不刷列表、bash id 是否等于 `toolCallId` | 折叠逻辑；真 Pi id 对得上是 live 轨迹，不是窗口冒烟 |
| `processPipes` 拆订、死槽队列 FIFO | 无用户可见面 |
| ChatWorkbench（未挂进 App） | 生产窗口走不到 |

**Compaction / 子进程崩溃 / 步骤行写盘失败** 不进 E2E。触发条件不稳定，产品也不保证进程死后仍能看见未落盘那句。

## Lanes

三条跑道，禁止把 LLM 用例的 skip 涂到整文件。

### Lane A — 只要 Pi 子进程能起来（CI 仍不强制跑）

**Locked fact：** 不需要 API key。`runWorkflow` 先 `acquire` + `new_session`，LinearRunner 在 `runTool` / `sendPrompt` 之前 yield `step_started`；合同第一步 `load` = `document.read`（本地连接器）。`journal.record('workflow_step_start', { stepId: 'load' })` 发生在 skill / 模型之前。无 key 时 Lane A 仍必须跑到顶栏 `审核中：load`（或后续已写出的 stepId）。

`deriveWorkflowTimeline` 一旦把 `workflow_step_start` 折进 `session.entries`，顶栏是 `审核中：<stepId>`。这是管道把 custom 行折进窗口的最小可见信号。旧 bug 下这条顶栏当场不会出现。

`SPARKII_SKIP_LLM` **不得** 跳过 Lane A。失败条件只有：Pi 起不来，或超时内顶栏从未出现 `审核中：<stepId>`。不要 skip，不要第三种 `SPARKII_E2E_*`，不要为无 key 特判 runner。

### Lane B — 真实模型（`SPARKII_SKIP_LLM=1` 才跳过）

需要 skill / 聊天补全 / `report.export`。沿用现有 env：`SPARKII_E2E_DOCUMENT`、`SPARKII_E2E_EXPORT_DIR`。skip **按 test**，不要按文件。

### Lane C — 无模型、不启 Pi 业务循环

打开壳、设置页、Composer 存在性。现有 `general.spec.ts` / `provider-settings.spec.ts` 归这里。接 harness 之后仍应能跑。

## Must-cover list（按优先级）

### P0 — 本轮必须有（live 管道 + 原 pilot 缺口）

用户可见、且旧 E2E 会绿、产品却是坏的。

| ID | 场景 | Lane | 通过标准（窗口） | 失败即回归的产品点 |
| --- | --- | --- | --- | --- |
| L1 | 合同：点「开始审核」后 **不离开页面** | A | 60s 内 `workflow-status` 匹配 `/审核中：(load\|search\|review\|report)/`。`审核完成` / `审核失败` **不是** L1 通过。空白顶栏（与空态「运行审核后，风险发现会显示在这里」同时出现）= 失败。空态节点单独出现不算失败（`load`/`search` 时 findings 仍空，文案仍是那句；`reviewPending` 时同一节点是「审核中…」） | live 步骤行没进画面 |
| L2 | L1 通过后点 `home` 回首页，再从合同 **会话组** 点回同一行 | A | （a）离开前记下当时的 `workflow-status` 全文；（b）仍在首页时，该会话行必须带 `aria-label="运行中"` 的转圈（池子还占着，不是视口在画 JSONL）；（c）点回后：转圈仍在，**或** 顶栏相对离开前已前进（更后的 stepId / 出现 `risk-card` / 变为完成或失败）。同一句 `审核中：load` 且无转圈 = 失败（只是重放已落盘 start）。**禁止**点 `agent-nav-*` | 视口离开不等于停跑；活着回来走树 + in-flight |
| L3 | 合同跑到有 `review` output 之后，**仍不离开** | B | 至少一张 `risk-card`；顶栏最终可以是「审核完成」，但风险卡必须在这次停留里出现 | 旧 bug 后半句：跑完也不画，直到 reopen |
| D1 | 合同导出审批点 **拒绝** | B | 独立 launch。dialog 出现后 **先点拒绝**（等待上限 < `approval.yaml` 的 300s 自动否认，建议 60s）。无 `report.docx`；审计有 `proposal.denied`，**该会话没有** `proposal.executed`。不要用模糊「已执行」文案（筛选器上也有这三字） | 原验收「被拒绝的写不会发生」 |
| P1-keep | 现有批准终态 | B | 保留批准路径；`workflow-status` 为「审核完成」（不要 `getByText(/审核完成/)` 扫整页）；审计 `proposal.approved`。可与 L3 同一次 launch。D1 必须另一次 launch | 不丢现有基线 |

L1 与 L2 共用一次 launch：先 L1，再 L2。L1 未看到 `审核中：<stepId>` 就不要进入 L2。

L3：完成前有卡 = live；完成后才有卡但仍未离开 = 通过（当场折了 `workflow_step_end`）。**禁止**「完成 → 回首页 → 再点开才看到卡」算通过。

合同 Lane A/B 的 `SPARKII_PROFILE_DIR` **默认** 为 `apps/desktop/agents/contract-review`（该目录就是 profile，`manifest.yaml` 在此）。不是可选。这样 L2 只有一个会话组。

### P1 — 通用智能体 spec §12（已有 backlog，本轮计划写清，落地可后于 P0）

来源：`docs/superpowers/notes/2026-08-25-general-agent-e2e-backlog.md` 与通用智能体规格 §12。现有 `general.spec.ts` 只证明 Composer 在。

G1 **不削弱**：§12 已锁「纯问答 → 桌面上不出现任何 `Sparkii*` 文件夹」。本 E2E 规格不改这条产品规则。实现时在 **本条 test 开始时** 快照 Desktop，只断言本条增量；合同 Lane A 会 `ensureWorkspaceDir(autoWorkspacePath(desktop))`，不得把那些目录算进 G1。

| ID | 场景 | Lane | 通过标准 |
| --- | --- | --- | --- |
| G0 | 现有冒烟 | C | 保留 |
| G1 | 纯问答，不要求创建文件 | B | 本条开始后 Desktop **不** 新增 `Sparkii*`（问答不得懒创建）。不改成「只要不在 data dir 就算过」 |
| G2 | 「创建 hello.txt」→ 批准 | B | 审批卡可见；批准后工作区出现文件；审计含 `proposal.executed`（若仍写 `workspace.created` 则一并断言） |
| G3 | 同上但拒绝 | B | 无该文件；审计 `proposal.denied` |
| G4 | Composer 指定工作区再写入 | B | **观察性降级：** `chooseWorkspace` 没有 `SPARKII_E2E_*` 短路，是真的 `showOpenDialog`。无现成注入则本条 **不做**，不新开 env / IPC |
| G5 | 模型选择器换模型再发一条 | 不强制 | 无窗口可观察点则不实现，不为它新开生产 IPC |
| G6 | 拒绝后执行器不执行 | B | 与 G3 合并 |

G5 若只能靠测试进程自己起的 mock 访问日志来证明，允许读那份日志；不读产品 `sparkii.log.jsonl`。

### P2 — 不在本规格强制

- 设置页已有冒烟，不扩到路由表 / thinking / 详情级。
- 并发两个 Agent 审批互不串：可选，不阻塞 P0。
- 视觉模型附件链路：不塞进本清单。
- 通用智能体把所有 Pi `type` 画成 TUI 控件：管道规格第 7 条下次再做。

## Harness（测试基础设施，不是产品）

全部 E2E 共用 `apps/desktop/e2e/harness.ts`（必须只有一处 `electron.launch`）：

- 临时 `SPARKII_DATA_DIR`
- 合同用例 **必须** 设 `SPARKII_PROFILE_DIR` 为 `apps/desktop/agents/contract-review`
- 合同用例设 `SPARKII_E2E_DOCUMENT` / `SPARKII_E2E_EXPORT_DIR`
- Electron 入口用 `import.meta.url` 解析到 `apps/desktop/dist-electron/main/index.js`，不要依赖进程 cwd
- 每个 test 一个临时 `--user-data-dir`（`workers: 1` **不能**代替这个：Chromium SingletonLock / 默认 userData 仍会撞）
- `app.close()` 在测试结束时调用
- **workers = 1**，`fullyParallel: false`

新增 `apps/desktop/playwright.config.ts`：`testDir: './e2e'`。从包目录跑：`pnpm --filter @sparkii/desktop exec playwright test`。不要从仓库根用相对 `dist-electron/...` 当 args。

跑之前必须：

```text
pnpm --filter @sparkii/desktop build:renderer
pnpm --filter @sparkii/desktop build:main
pnpm --filter @sparkii/desktop ensure:runtime
```

无 `VITE_DEV_SERVER_URL` 时主进程加载 `dist/index.html`，只 `build:main` 窗口是空的。

**禁止：**

- 生产代码读 `SPARKII_E2E_*` 除已经存在的 `SPARKII_E2E_DOCUMENT`、`SPARKII_E2E_EXPORT_DIR` 之外，本轮 **不** 新增第三种产品侧开关。
- 为 E2E 新开 `sparkii:event:*` 或 debug IPC。
- 假的 / 缩短的 contract-review profile。
- 把 mock OpenAI 做进 `electron/main`。

## Selectors

优先 `data-testid`。只加属性，不改行为，不按 agent id 写平台分支。

| 目标 | 现状 | 本轮 |
| --- | --- | --- |
| 合同顶栏状态 | 已有 `workflow-status` | L1 锁 `/审核中：(load\|search\|review\|report)/`；P1-keep 锁该节点上的「审核完成」 |
| 风险卡 | class `contract-risk-card` | 加 `data-testid="risk-card"` |
| 风险空态 | 无 testid | 加 `data-testid="contract-empty"`（单独出现不是失败） |
| 首页合同卡片 | `agent-card-${id}` | **锁死 `agent-card-contract-review`**。改掉 `pilot.spec.ts` 的 `agent-card-contract` |
| 回首页 | 顶栏「Sparkii」无 testid | 加 `data-testid="home"` |
| 会话组 | 无 | 在 `ui-session-group` 上加 `data-testid="session-group-${agentId}"` |
| 会话行 | `session-${id}`；另有 `session-more-${agentId}` | L2：`getByTestId('session-group-contract-review').locator('[data-testid^="session-"]:not([data-testid^="session-more-"])').last()`。不匹配标题。转圈：同一组内 `getByLabel('运行中')` |
| 错误 toast | 无 | 可选 `data-testid="error-toast"`；P0 不断言 |
| 审批 | `getByRole('dialog')` + 「批准」/「拒绝」 | D1 点「拒绝」；等待 < 300s |

左栏 `agent-nav-*` = `Shell.startNewSession`。L2 **禁止**用它当「回来」。

## Observation rules

- L1 时钟：点击「开始审核」之后立刻等 `审核中：<stepId>`。不要先等「审核完成」。终态字符串不是 L1 通过。
- 空态「运行审核后，风险发现会显示在这里」在 `load`/`search` 是正常的。失败 = 顶栏空白 **并且** 这句还在。
- L2 必须证明进程还占槽（会话行转圈），不能只证明 JSONL 里已有 `workflow_step_start`。
- 不断言 stepId 必须按 load→search→review→report 顺序；L1 任一合法 stepId 即可。
- 不把底栏「运行 n/max」当 live 进度。L2 用的是 **会话行** 转圈，不是 StatusBar。

## CI

本轮 **不** 把 Playwright 加进 GitHub Actions。README 写清本地命令（含 renderer + main + runtime）。

```text
pnpm --filter @sparkii/desktop build:renderer
pnpm --filter @sparkii/desktop build:main
pnpm --filter @sparkii/desktop ensure:runtime
pnpm --filter @sparkii/desktop exec playwright test
SPARKII_SKIP_LLM=1 pnpm --filter @sparkii/desktop exec playwright test   # A+C；B 按 test 跳过
```

## Explicitly not this spec

- 实现 live 管道本身（已落地）。
- 通用智能体全量 TUI 控件。
- 为没在看的 session 重放 token。
- 保证崩溃后仍能看见未落盘 assistant。
- 假 provider 内嵌进产品。
- 用 E2E 替代任何已有 Vitest。
- 为 G4 新增选目录 env。

## Locked

1. E2E 只锁窗口可见不变量；管道内部不进 Playwright。
2. 三条 Lane；`SPARKII_SKIP_LLM` 只跳过需要补全 / skill / 导出的 test。
3. P0 = L1、L2、L3、D1 + 保留现有批准 pilot。
4. L1 必须看到 `审核中：<stepId>`；终态不算。
5. L2 用会话组 testid + 行上「运行中」转圈；禁止 agent-nav、禁止裸 `/^session-/`。
6. Lane A 无 API key 也必须能过 L1（Pi 能起即可）。
7. 合同 E2E 固定 `SPARKII_PROFILE_DIR` 为 contract-review 目录。
8. P1 G1 维持通用智能体 §12（问答不在 Desktop 建 `Sparkii*`），不削弱。
9. 不新增产品侧事件注入开关。
10. 本轮不加 CI Playwright。
11. Harness 解析绝对入口 + 每测 `--user-data-dir`；构建含 renderer。
