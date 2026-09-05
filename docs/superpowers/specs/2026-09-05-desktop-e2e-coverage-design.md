# Desktop E2E Coverage — Design Spec

**Status:** Draft（待架构师审核）
**Date:** 2026-09-05
**Depends on:** Live session pipeline（`2026-09-05-live-session-pipeline-design.md`）；Runtime ⊥ Viewport（`2026-09-04-runtime-viewport-decoupling-design.md`）；合同 JSONL 显示（`2026-09-03-contract-review-jsonl-display-design.md`）；通用智能体（`2026-08-25-general-agent-design.md` §12）；合同 pilot 验收（`docs/2026-08-22-design.md` §11）
**Does not replace:** 上述规格的产品行为。本文件只规定 **Playwright + 真 Electron 窗口** 要守住哪些用户可见不变量，以及哪些继续只靠 Vitest。
**Does not implement:** 本轮只定清单与计划；落地另开执行。

## Goal

现有 3 条 E2E 是旧产品冒烟：合同批准终态、通用智能体打开 Composer、设置页切供应商。它们 **不能** 抓住「合同 live 必须等跑完、切走再回来才看到结果」——那条回归只等「审核完成」。

本规格把 E2E 收成一张分层清单：只测窗口里用户能看见、且跨主进程 / Pi 子进程 / renderer 才会坏的行为。管道内部形状、盖章、先听后快照、崩溃丢槽，继续只靠已有 Vitest。

## Current Inventory（已有，不删）

| 文件 | 断言 | 模型依赖 |
| --- | --- | --- |
| `apps/desktop/e2e/pilot.spec.ts` | 上传 → 审核 → 批准 → 「审核完成」→ 审计 `proposal.approved` | 文件级 `SPARKII_SKIP_LLM=1` 整文件跳过 |
| `apps/desktop/e2e/general.spec.ts` | 通用智能体 Composer 可见、`workspace-path` 含 `Sparkii` | 无 |
| `apps/desktop/e2e/provider-settings.spec.ts` | 设置页切 DeepSeek / Ollama、保存 key | 无 |

缺口：无 `playwright.config`；三条用例各自 `electron.launch`；CI（`.github/workflows/ci.yml`）只跑 `pnpm test`（Vitest），不跑 Playwright。

## What counts as E2E

E2E = Playwright 驱动 **已构建的** `dist-electron/main/index.js` + 真窗口。

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

不调用会烧 token 的 skill。合同 workflow 第一步 `load` = `document.read`，`deriveWorkflowTimeline` 一旦收到 `workflow_step_start`，顶栏就会变成 `审核中：load`（或后续步骤名）。这是 **管道把 custom 行折进 `session.entries`** 的最小可见信号。旧 bug 下这条顶栏不会在当场出现。

`SPARKII_SKIP_LLM` **不得** 跳过 Lane A。若本机没有可启动的 Pi runtime，测试失败（环境坏了），不要标 skip 伪装绿。

### Lane B — 真实模型（`SPARKII_SKIP_LLM=1` 才跳过）

需要 skill / 聊天补全 / `report.export`。沿用现有 env：`SPARKII_E2E_DOCUMENT`、`SPARKII_E2E_EXPORT_DIR`。skip **按 test**，不要按文件。

### Lane C — 无模型、不启 Pi 业务循环

打开壳、设置页、Composer 存在性。现有 `general.spec.ts` / `provider-settings.spec.ts` 归这里。

## Must-cover list（按优先级）

### P0 — 本轮必须有（live 管道 + 原 pilot 缺口）

用户可见、且旧 E2E 会绿、产品却是坏的。

| ID | 场景 | Lane | 通过标准（窗口） | 失败即回归的产品点 |
| --- | --- | --- | --- | --- |
| L1 | 合同：点「开始审核」后 **不离开页面** | A | 超时内（建议 60s）`workflow-status` 变为 `/审核中|审核完成|审核失败/`。空白顶栏 + 空态「运行审核后，风险发现会显示在这里」= 失败。优先等到 `/审核中/`；机器快已经跑完也算过（说明 custom 行到了窗口）。**禁止**先等「审核完成」再倒推曾经审核中 | live 步骤行没进画面 |
| L2 | 审核仍在跑时点顶栏 Sparkii 回首页，再从「会话历史」点回 **同一条** 会话 | A | 回来后仍见 `/审核中/` 或已有风险卡；**不要**点左栏 `agent-nav-*`（那会 `newSession`） | 视口离开不等于停跑；活着回来走树 + in-flight，不是空页 |
| L3 | 合同跑到有 `review` output 之后，**仍不离开** | B | 至少一张风险卡（`data-testid="risk-card"`）；顶栏最终可以是「审核完成」，但风险卡必须在这次停留里出现，不能靠切走再打开 | 旧 bug 的后半句：跑完也不画，直到 reopen |
| D1 | 合同导出审批点 **拒绝** | B | 无 `SPARKII_E2E_EXPORT_DIR/report.docx`；审计可见 `proposal.denied`；不得出现「写入已执行」类成功文案 | 原 pilot 验收「被拒绝的写不会发生」从未 E2E |
| P1-keep | 现有批准终态 | B | 保留 `pilot.spec.ts` 的批准 → 「审核完成」→ `proposal.approved`。可与 L3 同一次运行，但拒绝（D1）必须是 **另一次** launch，避免两次审批互踩 | 不丢现有基线 |

L1 与 L2 可以共用一次 launch（先 L1 断言，再离开再回来做 L2），只要 L1 的「未完成」在离开前已经成立。

L3 不要写成「等审核完成再看卡」而不记录完成前是否已有卡：完成前有卡 = live；完成后才有卡但仍未离开 = 也算本条通过（管道在当场折了 `workflow_step_end`）。**禁止**「完成 → 回首页 → 再点开才看到卡」算通过。

### P1 — 通用智能体 spec §12（已有 backlog，本轮计划写清，落地可后于 P0）

来源：`docs/superpowers/notes/2026-08-25-general-agent-e2e-backlog.md`。现有 `general.spec.ts` 只证明 Composer 在。

| ID | 场景 | Lane | 通过标准 |
| --- | --- | --- | --- |
| G0 | 现有冒烟 | C | 保留 |
| G1 | 纯问答，不要求创建文件 | B | 桌面数据目录外 **不** 出现新的 `Sparkii*` 工作区文件夹（问答不得懒创建） |
| G2 | 「创建 hello.txt」→ 批准 | B | 审批卡可见；批准后指定/默认工作区出现文件；审计含 `proposal.executed`（及若产品仍写 `workspace.created` 则一并断言） |
| G3 | 同上但拒绝 | B | 无该文件；审计 `proposal.denied` |
| G4 | Composer 指定工作区再写入 | B | 写入落在所选目录，不在桌面默认 `Sparkii*` |
| G5 | 模型选择器换模型再发一条 | B 或带本地假 endpoint 的 A | 该轮实际 `set_model` / 请求打到所选模型。若无法在窗口侧观察，本条 **降为不强制**（见「观察性」），不要为它新开生产 IPC |
| G6 | 拒绝后执行器不执行 | B | 与 G3 合并即可；不单开一条重复点拒绝 |

G5 若只能靠主进程日志或 mock 服务器访问记录来证明，允许 E2E 读 **测试进程自己起的** mock 访问日志，不读产品 `sparkii.log.jsonl` 当断言源（日志格式不是 UI 契约）。

### P2 — 不在本规格强制

- 设置页已有冒烟，不扩到「路由表 / thinking level / 详情级」除非产品再开规格。
- 并发两个 Agent 审批互不串（旧 plan 里的 `concurrency.spec.ts`）：可选，不阻塞 P0。
- 视觉模型附件链路（`2026-08-30-attachments-image-todo.md`）：仍待真实 vision，不塞进本清单。
- 通用智能体把所有 Pi `type` 画成 TUI 控件：管道规格第 7 条明确下次再做，E2E 不提前锁视觉。

## Harness（测试基础设施，不是产品）

全部 E2E 共用 `apps/desktop/e2e/harness.ts`（名字可微调，但必须只有一处 `electron.launch`）：

- 临时 `SPARKII_DATA_DIR`
- 可选 `SPARKII_PROFILE_DIR`（合同回归仍可只挂 contract-review，与现 `pilot.spec.ts` 一致）
- 可选 `SPARKII_E2E_DOCUMENT` / `SPARKII_E2E_EXPORT_DIR`
- `args: ['dist-electron/main/index.js']`
- `app.close()` 在测试结束时调用
- **workers = 1**，禁止并行两个 Electron 抢同一机上的未隔离资源；每个 test 自己的 `DATA_DIR`

新增 `apps/desktop/playwright.config.ts`：`testDir: './e2e'`，超时按 Lane B 拉长（单测可再 `setTimeout`），`fullyParallel: false`。

**禁止：**

- 生产代码读 `SPARKII_E2E_*` 除已经存在的 `SPARKII_E2E_DOCUMENT`（选文件）和 `SPARKII_E2E_EXPORT_DIR`（导出路径）之外，本轮 **不** 新增第三种产品侧 e2e 开关去注入事件或跳过 runner。
- 为 E2E 新开 `sparkii:event:*` 或 debug IPC。
- 假的 contract-review profile / 缩短 workflow 来「更容易绿」——L1/L2 必须打真实 `apps/desktop/agents/contract-review` 的 `load` 步。
- 把 mock OpenAI 做进 `electron/main`。若 P1/G5 需要假 endpoint，mock 进程由 **测试文件** 拉起，产品只是设置里的 `baseUrl`。

## Selectors

优先 `data-testid`。本轮允许、也只允许为 E2E 稳定性在生产组件上加 testid（不改行为）：

| 目标 | 现状 | 本轮 |
| --- | --- | --- |
| 合同顶栏状态 | 已有 `workflow-status` | 沿用；断言文本 `/审核中/` `/审核完成/` `/审核失败/` |
| 风险卡 | 只有 class `contract-risk-card` | 加 `data-testid="risk-card"` |
| 风险空态 | 无 testid | 加 `data-testid="contract-empty"`（便于确认不是静默空白） |
| 首页合同卡片 | `HomeView` 为 `agent-card-${id}`，id 来自 manifest `name` = `contract-review` | **锁死 `agent-card-contract-review`**。现有 `pilot.spec.ts` 写的 `agent-card-contract` 是错的，Task 里必须改掉，不要再「以 DOM 为准猜」 |
| 回首页 | 顶栏「Sparkii」无 testid | 加 `data-testid="home"` |
| 会话行 | 已有 `session-${id}` | 用 `page.getByTestId(/^session-/)` 点 **合同那一组里刚出现的那一行**（标题会变成文件名） |
| 错误 toast | 无 testid | P0 不依赖；若顺手加 `data-testid="error-toast"` 可以，不当 P0 断言 |
| 审批 | `getByRole('dialog')` + 「批准」/「拒绝」 | 沿用；D1/G3 点「拒绝」 |

左栏 `agent-nav-*` 的点击语义是 **新建会话**（`Shell.startNewSession`），L2 **禁止**用它当「回来」。

## Observation rules

- L1 的时钟：点击「开始审核」之后立刻等 `workflow-status` 非空。若 Pi 迟迟不写出 `workflow_step_start`，测试应 **失败**（超时），不要先等 审核完成再倒推。机器快已经 `审核完成` 仍算 L1 过（L3 再锁风险卡）。
- L2 回来后允许状态已前进（`search` / `review` / 已有风险卡），不允许空白顶栏 + 「运行审核后，风险发现会显示在这里」且无步骤。
- 不断言内部 stepId 顺序必须是 load→search→review→report（那是 workflow.yaml，不是管道）。可见「审核中」足够证明 custom 行到了窗口。
- 不把底栏运行池文案当 live 进度（运行池规格冻结；JSONL-display 也不在底栏画步骤）。

## CI

本轮 **不** 把 Playwright 加进 GitHub Actions。理由：CI 镜像无模型、无稳定的 Electron/显示、`better-sqlite3` 已在 vitest 覆盖。README 写清本地命令：

```text
pnpm --filter @sparkii/desktop build:main
pnpm --filter @sparkii/desktop exec playwright test          # 全量（无模型时 Lane B 跳过）
SPARKII_SKIP_LLM=1 pnpm --filter @sparkii/desktop exec playwright test   # 只跑 A+C
```

以后若要 CI 跑 Lane C，另开任务，不堵本规格。

## Explicitly not this spec

- 实现 live 管道本身（已落地）。
- 通用智能体全量 TUI 控件。
- 为没在看的 session 重放 token。
- 保证崩溃后仍能看见未落盘 assistant。
- 假 provider 内嵌进产品。
- 用 E2E 替代任何已有 Vitest。

## Locked

1. E2E 只锁窗口可见不变量；管道内部不进 Playwright。
2. 三条 Lane；`SPARKII_SKIP_LLM` 只跳过需要补全 / skill / 导出的 test。
3. P0 = L1、L2、L3、D1 + 保留现有批准 pilot。
4. P1 = 通用智能体 §12（G1–G4、G6；G5 不强锁 IPC）。
5. 不新增产品侧事件注入开关。
6. L2 回来只点会话历史，不点 agent-nav。
7. 本轮不加 CI Playwright。
