# 实施交接提示词：记忆模块（Memory Module）M1 → M2 → M3

> 用法：把本文件全文交给实施 agent 作为任务提示词。它是冷启动自包含的；权威设计规格在
> `docs/superpowers/plans/2026-11-23-memory-module-design.md`（v2，已过架构评审），开工前必须完整读一遍。
> 本文件与设计文档冲突时，以设计文档为准；发现两者都错时，停下汇报，不许自行改设计。

---

## 0. 你的任务

在 Sparkii Desktop（Electron 多智能体平台，pnpm monorepo）实现"记忆模块"：四层记忆（用户全局 / 各智能体习惯 / 项目内共享 / 会话情景），文件为真相源 + SQLite 派生索引，会话结束系统代管提炼（待确认队列），艾宾浩斯衰减降权，显式遗忘真删。按设计文档 §15 的 M1 → M2 → M3 顺序实施，每个里程碑验收通过才进下一个。

**所有产品决策已拍板**（设计文档 §2 D1–D7），不要重新讨论、不要"优化"需求。特别注意三个容易被好心改坏的决定：
1. 记忆工具走**平台可信分支**（设计文档 §10），**不扩展** approval 包的 CapabilityKind 闭联合、不登记 DEFAULT_TOOL_DESCRIPTORS。这是评审后的显式信任决策，不是疏漏。
2. **不改 Pi SDK**（node_modules 里的 @earendil-works/pi-coding-agent）、**不改签名 agent 包**（apps/desktop/agents/*/ 的清单与 prompt）。工具与记忆块都由平台层附加。
3. 第一版**不做会话中途记忆热更新**（技术上可做，是取舍不是不能）。

## 1. 硬规矩

- 记忆数据**永远本地**：不写远端 RAG/onto 后端，不新增任何第三方外发通道。提炼调用用户已配置的大模型（与聊天同通道），设置开关旁必须有那句隐私明示文案（设计文档 §12.2）。
- 损坏即拒绝：提炼输出解析失败整批丢弃 + errors.db 记录，绝不半批写入；项目记忆文件损坏停止该 scope 注入 + 修复入口，绝不静默覆盖。
- 状态机出口穷举：pending 的批准/驳回/目标失效/源会话被删/项目搬迁/索引重建，每个出口都要实现并有用例（设计文档 §7.4 表）。
- 不许用删验收判据、调阈值、关检查的方式换进度。做不完的进最终汇报的"未做"清单，不许静默降级。
- git：每个里程碑本地 commit 一次（`feat(memory): ...`），按文件名精确 stage。**禁止 push**。**禁止 stage 这三个构建产物**：`apps/desktop/native/windows-sandbox/bin/HostShellRunner.exe / SandboxProbe.exe / SparkiiSandbox.exe`（构建会就地重编它们，属已知现象，不是你的改动）。不动 `.codex-handoff/`。
- 同仓库可能有另一个 agent 做过标书打磨：**行号会漂移，一切挂点按符号名定位，编辑前先重读文件**。设计文档 §3 的行号是 2026-11-23 的快照，用作线索而非坐标。

## 2. 环境与工具事实（本机已验证）

- Windows + git bash。Node ≥22，pnpm@9.15.0（root package.json 声明）。PowerShell 执行策略可能拦脚本：用 `pnpm.cmd` / `npm.cmd` 形式调用。
- 测试：`pnpm test`（= vitest run）**只在仓库根跑**（包目录 cwd 会因路径前缀重复造成假失败）。要 grep 汇总行时加 `NO_COLOR=1`。
- 类型检查：`pnpm typecheck`；lint：`pnpm lint`；构建：`pnpm build`。本 shell **没有 make**。
- better-sqlite3 在 root pnpm `neverBuiltDependencies` 里（用预构建二进制，不本地编译）。内置 SQLite 3.53.4 + FTS5 宏已有编译期证据，但预构建二进制一致性是推断 ⇒ **M1 第 0 步写运行时探测**：开临时内存库执行 `CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')` 验证；失败则检索退化 LIKE 并在汇报中记录，不阻塞。
- bash 里**反引号会当场执行**：写含反引号的文档/提交信息用 heredoc 保护。
- Edit 工具坑：工作树行尾不恒定（checkout 可能翻成 LF），多行 old_string 改完必须 grep 复验；**不要拿 markdown 标题行当 old_string 锚点**（会吞标题）；替换长行时 new_string 必须完整包含要保留的部分。
- UI 验收手段：Electron 渲染进程可用 `electron . --remote-debugging-port=9222` 暴露 CDP，用 Chrome DevTools Protocol 截图、查 console/network。仓库内没有现成截图脚本，自己写临时脚本放 scratch 目录，交付前清理。

## 3. 承重代码锚点（2026-11-23 对码核实；按符号定位）

**注入链**
- `apps/desktop/electron/main/saddle.ts`：`buildProfileSaddle` / `buildAgentSaddle` 组装 SessionSaddle，systemPrompt 来自 agent 清单。记忆块作为新可选参数在此追加到鞍文本末尾。
- `packages/agent-host/src/pi-sdk-runtime.ts`：`before_agent_start` 钩子（约 :175-184）每次 run 活读 pendingSaddle（约 :385）；`applySaddleSystemPrompt` 合并。
- `packages/agent-host/src/skill-prompt.ts`：`mergeSaddleSystemPrompt`（约 :50-70）最终顺序 = 鞍文本 + skills 目录 + cwd 行。不要改它。
- `configure_session` 可随时重发（`packages/agent-host/src/pi-runtime.ts` 约 :156-157）——第一版不用，但别在注释里写"SDK 不支持热更"。

**工具链与可信分支**
- `packages/agent-host/src/tool-registry.ts`：`resolveToolDefinitions`（约 :107）。未知工具名会抛错并清空整盘工具（pi-sdk-runtime.ts 约 :295-321）⇒ 工具定义注册与鞍附加必须同一批原子改动。
- `apps/desktop/electron/main/ipc.ts`：`bindRuntimeActions`（约 :384-403）——**memory_* 拦截分支加在 `actionRouter.route` 之前**；不依赖 rt.security（非 win32 也要能用）。
- 审批门硬拒证据（为什么不能走正常登记）：`security/windows-platform.ts` 约 :187 dataDir=closure 根；`packages/approval/src/security/policy.ts` :94-99 critical 硬拒、:21-22 空 resources、:140-146 越界写硬拒；`security/action-normalizer.ts` 约 :299-305 UNKNOWN_TOOL 抛错。
- forget 的审批复用现有 proposal broker（propose 通道，参考 pi-runtime-tools.ts 的 connectorWriteProposal 用法）。

**提炼通道**
- `ipc.ts` `sparkii:completeText`（约 :1564-1578）：槽位 + `resolveModelTarget(settings,'title') ?? ('default')` + `client.send({type:'complete'})` 的先例。
- `pi-sdk-runtime.ts` `complete()`（约 :471-483）= completeSimple，单轮无状态不进会话历史 ⇒ 提炼槽位**不需要** configure_session/switch_session。
- 内部槽位先例：`ipc.ts` `withProbeSlot`（约 :650-660，meta.internal=true）+ `injectProbeKey`（约 :662-665）。
- `packages/model-router/src/types.ts:1`：`ModelTask` 闭联合，加 `'memory'` 必须改这里。routes 存储是 Record<string,string>，无需迁移。
- 槽位池：`packages/agent-host/src/pi-runtime-pool.ts` `snapshot()`（约 :63）、acquire 池满**排队**（约 :135-138）、`cancelPending`（约 :96）。礼让 = 先查 snapshot 有空闲才 acquire，竞态入队 5 秒超时 cancelPending。
- 空闲释放仅 15 秒：`ipc.ts` `sessionIdleReleaseMs`（约 :624）⇒ 90 秒 debounce 期满原槽位必已释放，必须自借内部槽位。

**事件与素材**
- `ipc.ts` `ensureProcessPipe`（约 :738-781）：`agent_settled`（约 :744）是提炼触发器挂点；注意 B1 归属判据注释，别破坏 Grant 收尾逻辑。
- JSONL 是树（parentId/分支）+ compaction 条目；读取先例 `packages/agent-host/src/session-catalog.ts` `readPiSessionMessages` / `readPiSessionEntries` + SDK `parseSessionEntries`（约 :34-44）。素材位点用 **entry-id**，不用字节偏移。
- `chat-session-store.ts`：chat_sessions 含 profileId / workspaceKind('auto'|'user') / workspacePath / piSessionFile。

**存储与围栏**
- `paths.ts` `dataDirFor(userId)`：%LOCALAPPDATA%\SparkiiDesktop\data\<userId>。runtime.ts assemble 里 sessions.db/audit.db/errors.db 同级放 memory.db 与 memory/ 目录。
- `security/workspace-file-service.ts` list 操作（约 :250-252）裸 readdir ⇒ 在此过滤 `.sparkii` 条目。
- `packages/agent-host/src/workspace-guard.ts`：加 `.sparkii/**` 读写拒绝（平台保留目录）。
- 标书 surface `index.tsx` 约 :611 的点文件过滤只管 input 资料清单，**不要改标书 surface**。

**设置页与 preload**
- `apps/desktop/src/shell/SettingsView.tsx` PANE_GROUPS/PANE_LABELS（约 :126-146）：「模型与知识」组加 memory pane；ROUTE_TASKS（约 :152-157）加「记忆」。新组件参照 SettingsKnowledgePane.tsx，深色主题。
- preload 是**修改**现有三件套：`apps/desktop/electron/preload/api.ts / api-types.ts / index.ts`。

## 4. 里程碑与出口验收（判据全部要证据，不要界面绿勾）

### M1 地基与手动记忆（设计文档 §15-M1）
第 0 步 FTS trigram 探测（§2）。然后 memory-service（文件+db+打分+围栏校验）、memory-settings、SettingsMemoryPane、IPC、preload、五处挂点。
出口验收：
- 手动新增用户/项目记忆 → 新会话问"你记得我什么"能答出，且**从会话 JSONL 或主进程日志取证 `<memory>` 块真的进了 prompt**（把取证片段存进汇报）。
- 衰减单测：pinned 豁免、半衰期边界、预算截断、pinned 超预算截断+警示、**注入不重置时钟 / 检索命中与显式操作才重置**。
- 文件树不出现 .sparkii；agent write 工具写 .sparkii 被拒（实测，不是只读代码断言）。
- auto 工作区不建项目记忆；删除/置顶/编辑/归档/重建索引/损坏修复全通。
- 设置页截图（深色主题）+ CDP console/network 清洁（零 error 零 warning，有 warning 要同类全局审计）。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（仓库根）全绿，连跑两次结果一致。

### M2 提炼管道与显式工具（设计文档 §15-M2）
出口验收：
- 端到端：真实对话表达偏好 → 静默期后 pending 出现（含来源 excerpt）→ 设置页批准 → 下一条会话注入生效；驳回 → 同候选不再提案。
- 畸形 JSON 注入测试：整批丢弃 + errors.db 有记录 + 真相源文件 grep 无半批写入。
- memory_forget 弹审批；普通删除后文件+db+FTS 三处 grep 无残留；隐私删除后 episodes/pending/黑名单/JSONL/chat_sessions 五处无残留。
- pending 出口用例：批准时 targetId 已删 → 降级 ADD 候选；源会话被删 → pending 失效提示。
- 槽位礼让实测：占满 maxAgents 后触发提炼窗口 → pool snapshot 无排队条目、日志证明跳过；交互 prompt 不被阻塞。
- 自动提炼开关关闭后零 LLM 出机调用（network 取证）。
- 三件套全绿连跑两次。

### M3 情景检索与空闲整合（设计文档 §15-M3）
出口验收：
- 跨项目模糊回忆用例（"上个月那个项目"）经 memory_search 命中情景摘要并定位项目。
- 整合提案进 pending，不自动改 active；每次整合 LLM 调用 ≤3。
- 同一检索连跑两次命中数与 accessCount 增量一致；强化重置时钟可单测复算。
- 三件套全绿连跑两次。

## 5. 过程纪律

- 一个里程碑做到底再汇报，不要中途停下来播报进度或问"要不要继续"。决策已全部前置；真遇到阻塞（事实与文档矛盾、挂点被占用无法协调、验收判据物理上做不到）才停，停下时说清卡在哪、已排除什么。
- 绿勾怀疑论：单次跑通不算数（连跑两次）；测试断言注入缝而生产走包装器不算数；用例名比断言多说得不算数。验收证据存文件（截图/日志片段/grep 输出），汇报里给路径。
- 临时脚本/临时库/探测产物放 scratch，交付前清理；交付后工作树里只留实现代码、测试、文档。
- 每个里程碑 commit 前 `git status` 复查 stage 内容，确认没混入 exe 产物与 scratch。

## 6. 最终汇报格式（一次性）

1. 三个里程碑各自：做了什么、验收证据路径（截图/日志/测试输出）、commit hash。
2. 未做清单与走了回退的项（如 FTS 退化 LIKE），逐条说明原因。
3. 实施中发现的设计文档事实错误（如有）：位置 + 实际代码证据。
4. 遗留风险与建议（不擅自实施）。