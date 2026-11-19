# 标书写作智能体（bid-writing）技术设计文档

**状态：** 阶段 A 产物 · P0 可行性验证通过 · 待用户确认后进入阶段 B（实现计划）
**日期：** 2026-11-17
**对应任务：** 用户实施提示词阶段 A（技术设计 + P0 可行性验证）
**权威需求源：** `docs/superpowers/specs/2026-11-17-bid-writing-agent-design.md`（17 章，终审通过）
**技术依据：** `2026-09-02-agent-surface-thin-contract-custom-extension.md`、`2026-09-05-live-session-pipeline-design.md`、`2026-10-21-agent-approval-boundary-design.md`、`2026-09-11-session-workspace-home.md`

> 本文只做技术设计与可行性验证结论，不含任何产品代码改动（符合阶段 A 边界）。所有 P1-P7 平台改动沿用产品设计文档 §14 的登记格式；本文新增的归属结论立即回填 §14（见 §7）。

---

## 1. 结论摘要（TL;DR）

- **三个 P0 spike 全部可行**（T2 渲染 / T1 检索 / P1 IPC），无"不可行 → 停下请示"触发项。
- **T1 归属：包内 + 通用平台依赖，不新增 P6。** 用主进程/包内 `better-sqlite3` FTS5（trigram）建项目级索引，索引文件落在工作区 `input/.index/`，读写走 P1 通用 IPC。P6 保持"条件条目、未触发"。
- **T2 归属：包内渲染 + 一条通用渲染 IPC → 触发 P7（转为确定项）。** 图结构 JSON → 自研确定性 JSON→SVG 转换器（包内）→ 本机 Chromium 无头渲染 PNG → PNG tEXt 块内嵌 draw.io 源 XML。为保证"renderer 沙箱不能起子进程"的渲染能力，新增一条**通用** RPC（SVG→PNG 渲染并写回工作区），登记为 **P7**。全程离线、中文正确、体积约 20KB/图。
- **T3 收口：主进程通用 MD→DOCX（含图片）编译能力，作为 P1 的一部分。** `docx@9.7.1` 的 `ImageRun` 已验证可嵌 PNG 生成有效 DOCX。不复用 `report.export`（其 payload 不含图片、且走审批 broker），但复用其 `mkdir + writeFile` 惯例与审计入口。
- **T4/T5/T6 均可用"包内逻辑 + 既有平台能力"实现**，无新增平台改动（详见 §4）。
- **P1 安全基座已存在，无需从零造**：`WorkspaceExecutor`（边界/符号链接/硬链接/信任锚/原子写全覆盖）、`createTaskGrant`+`admitWorkspace`（Workspace Admission）、`isPathInside`、`rt.audit.append`（审计）。P1 的职责是**把这些通用能力封装成一组 typed IPC**，不是重写安全逻辑。

---

## 2. P0 可行性验证（三个 spike，均通过）

验证在本机 `Windows / Node v22.22.2 / pnpm 9.15.9` 实际执行；临时脚本在系统临时目录运行、已清理，未写入仓库、未产生任何平台改动。

### 2.1 Spike 1 — T2 图表渲染（最高风险项）

| 验证点 | 方法 | 结论 |
| --- | --- | --- |
| 本机离线渲染 SVG→PNG | Playwright Chromium headless，`executablePath` 指向本机已装 `chromium_headless_shell-1208` | ✅ `RENDER_OK png bytes = 19780` |
| 中文标签不乱码 | SVG 内 `font-family="Microsoft YaHei"`，渲染后目视核对 | ✅ "应用层 / 数据汇聚层 / 提供服务"清晰正确 |
| 图内嵌 draw.io 源 XML（可编辑闭环） | draw.io "include a copy" 机制：`deflate` + `base64url` 存入 PNG `tEXt` 块（keyword `mxfile`） | ✅ 编解码 roundtrip OK，tEXt 块可构造，源 XML 可无损读回 |
| 体积 | 单图 PNG 实测 | ✅ ~20KB/图，几十张图仍可控 |
| 随包依赖体积 | 全仓搜索 `drawio/mxgraph/diagrams` 依赖 | 平台无此类依赖；采用"自研 JSON→SVG + 本机 Chromium"规避随包编辑器体积/许可 |

**注意（版本坑）**：`@playwright/test@1.62.1` 期望 `chromium_headless_shell-1234`，本机缓存为 1208，直接 `launch()` 会失败；用 `launch({ executablePath })` 指向已装版本即通过。落地时渲染能力放主进程，Chromium 由 Electron 自带或随包固定版本（在 P7 实现任务中锁定并写死路径/自检，避免版本漂移）。

**结论：T2 可行。** 降级方案也全部本机：`JSON→SVG→PNG`（主路径）失败时可退回 `JSON→SVG`（矢量，DOCX 可嵌 SVG 或再转 PNG），仍是本机、中文准确、可复现；任何情况下不调用联网 draw.io。

### 2.2 Spike 2 — T1 项目级检索

| 验证点 | 方法 | 结论 |
| --- | --- | --- |
| 平台是否有现成"按工作区建索引"的复用能力 | 读 `packages/connectors/.../knowledge/index.ts` + 审核报告 I1 | `Bm25Index` 是进程内类、语料来自内置 corpus，无动态建索引 API → 确认为"新增组件" |
| 本机 FTS5 可用性 | `better-sqlite3@13` `:memory:` 建 `fts5` 虚表 | ✅ 可用 |
| 中文检索质量 | `unicode61` vs `trigram` 分词对比 | `unicode61` 对中文整句不切词（"架构"查不到"总体架构"）；`trigram` 对 ≥3 字中文子串有效（"数据汇聚"命中），2 字查询受限 |
| 依赖归属 | `better-sqlite3` 已是 desktop 主进程依赖 | 平台通用依赖，非新增；索引库文件落工作区 `input/.index/`，读写走 P1 IPC |

**结论：T1 可行，选 A（项目级索引）为目标。** 采用"FTS5 trigram 全文索引 + 精确 read 回原文 snippet"；针对 trigram 的 2 字查询短板，辅以 B 方案（摘要清单 `input/manifest.md`）作为短词/兜底路径。索引组件落在包内（agent 侧工具 + 主进程通用检索 helper），**不新增平台能力、不触发 P6**；索引持久化经 P1 通用写 IPC，符合 Workspace Admission。

### 2.3 Spike 3 — P1 IPC 可行性与冲突排查

| 验证点 | 方法 | 结论 |
| --- | --- | --- |
| 与 `readDocumentBytes` 是否冲突 | 读 `ipc.ts:1751` + `document-bytes.ts` | 不冲突。`readDocumentBytes` 只读"已授予/附件/工作区内"的受限文档字节（PDF/DOCX/TXT/图片，40MB 上限），面向预览；P1 是通用工作区 CRUD（读/写/列/建/删/改名/移动/版本/导出），用途与签名不同。P1 **复用**其 `isPathInside` 围栏思路而非改写它。 |
| 与 `requestExportReport` 是否冲突 | 读 `ipc.ts:1412` | 不冲突。`requestExportReport` 走 `broker.route(connectorWriteProposal('report.export'))`，是**带审批**的 Pi 侧导出（sideEffect=write）。P1/T3 的主进程编译导出走"用户主动点击授权 + 工作区内 ALLOW + 审计"，是另一条路径。二者并存、互不改写；T3 编译不注册为 `report.export` 工具，避免触发其审批。 |
| Workspace Admission 是否现成 | 读 `task-grant-factory.ts` / `workspace-admission.ts` / `workspace-executor.ts` | ✅ 现成。`createTaskGrant` 调 `admitWorkspace` 做准入；`WorkspaceExecutor.execute` 对 fs.write/delete/move 做目标规范化、`..`/符号链接/目录联接/重解析/硬链接拒绝、信任锚保护、workspace root 不可替换、原子写。**P1 IPC 直接复用这套，不重写安全逻辑。** |
| 一步式会话绑定（O1） | 读 `ipc.ts:952-1052` 的 `openOrCreateSession` | ✅ 支持 `context.workspacePath` + `context.workspaceKind` 一步建会话并绑定固定路径，避免 `setChatWorkspace` 的 `'user'` 副作用。T5/T6 采用此方案。 |
| 审计与项目回溯 | 读 `ipc.ts` 中 `rt.audit.append` 多处调用 | ✅ `audit.append({ actor, action, resource, ... })` 通用入口现成；项目↔会话映射用 `project.json.workspacePath` = 会话 `workspacePath`（Surface 侧呈现，不改审计 schema → P4 保持条件未触发）。 |

**结论：P1 IPC 可实现、与现有能力不冲突、安全基座可复用。** 这是本阶段最重要的正向结论——P1 不是"新建一套文件权限系统"，而是"把已有通用安全能力封装为 typed IPC 并补全审计"。

---

## 3. P0/P6/P7 平台改动归属结论（登记 §14）

| 编号 | 阶段 A 结论 | 是否转为确定项 |
| --- | --- | --- |
| P1 | 确定。通用工作区文件 IPC（读/写/列/建/删/改名/移动/版本/导出写出）+ 主进程 MD→DOCX 编译。复用既有 `WorkspaceExecutor`/`admitWorkspace`/`audit`。 | 已是确定项，接口见 §6 |
| P2 | 确定。`App.tsx:633` draft 判定放宽到 custom surface。 | 已是确定项 |
| P3 | 确定。新增 profile 后重生成 `agent-surface-bindings.ts` + catalog 注册。 | 已是确定项 |
| P4 | 保持条件项、未触发。用 §5.3 的 workspacePath 映射在 Surface 呈现审计归属，不改审计 schema。 | 否 |
| P5 | 确定。项目路径创建/绑定走既有 Workspace Admission（复用 `admitWorkspace`）。 | 已是确定项 |
| P6 | **未触发**。T1 检索索引落包内 + 主进程通用 helper + `better-sqlite3`（已有依赖），索引文件走 P1 IPC 写工作区，不新增平台检索组件/IPC。 | 否（保持兜底） |
| P7 | **转为确定项**。T2 需要一条通用 RPC：把图结构/SVG 交主进程用本机 Chromium 渲染成 PNG 并写回工作区（renderer 沙箱不能起子进程）。该 RPC 通用（无标书语义），须经 Workspace Admission + 审计。接口见 §6.2。 | **是（新登记）** |

> P7 转确定的理由严格遵循设计文档 §14/P7 与 §6.3 兜底规则（R2）："T2 渲染一旦确定需要平台侧 IPC，立即转为确定条目并补全登记"。该 IPC 是通用渲染能力（任何 agent 可用），不含 `bid-writing` 特判。

---

## 4. T1–T6 技术方案定稿

### T1 项目私有资料按需检索 —— 【包内 + 平台通用依赖，无新增改动】
- 数据结构：`input/.index/fts.sqlite`（FTS5 trigram，字段 `path/title/body/mtime`）+ `input/manifest.md`（人可读摘要清单，短词/兜底）。
- 建索引：资料导入时（走 `document.read` 解析）按块切分写 FTS5；索引库在工作区内，随项目走、不进公司知识库。
- 检索：新会话按"当前项目 workspacePath"检索 `input/.index`，命中 snippet → Surface 标注来源 → 按需 `readDocumentBytes`/P1 read 取原文片段。
- 查询策略：≥3 字走 trigram；2 字/无命中降级读 manifest 清单 + 精确打开。
- 依赖：`better-sqlite3`（desktop 已有），通用 helper 放主进程，包内工具经 IPC 调用（或 Pi 工具进程内建索引，二选一在阶段 B 定，均不新增平台能力）。

### T2 图表渲染与可编辑闭环 —— 【包内确定性转换 + 主进程渲染 + P7 IPC】
- 链路：模型输出图结构 JSON（schema 见设计 §7.3，模型不出像素坐标）→ 包内确定性 `JSON→draw.io XML(mxGraph)` 存 `figures/*.drawio` → 包内 `JSON/XML→SVG`（分层布局，中文走系统字体）→ **P7 通用 RPC**：主进程用本机 Chromium 无头把 SVG 渲染 PNG → PNG tEXt 内嵌源 XML → MD 相对路径引用。
- 可编辑两条路均写回同一 `.drawio`（源是唯一可编辑对象）：①点图 → 用本机内嵌查看/编辑（阶段 B 评估"随包静态 draw.io 资源"体积，若超阈值则用轻量自研属性编辑面板，仍是本机）；②对话描述改 JSON → 重走链路重渲染、版本 +1。
- 离线/中文/体积：见 §2.1 spike，全部通过。降级 Also 本机。
- 归属：转换器/布局/内嵌编解码在包内；渲染 RPC 登记 P7。

### T3 MD+图片→DOCX 编译 —— 【主进程通用能力，并入 P1】
- 单一方案：主进程通用编译器读 `output/manuscript/*.md` + `figures/*.png`，用 `docx` 的 `ImageRun` 一次性编译到 `output/final/*.docx`。
- 触发：用户点"导出"= 对相同目标/载荷的主动授权（approval-boundary §9.4），工作区内 ALLOW、不弹审批、写审计；是否过 Capability Gateway 由阶段 B 按 §8.3 确认（结论不改变免二次审批）。
- 不复用 `report.export`（无图片、走审批 broker），但沿用 `mkdir(dirname)+writeFile` 与 `audit.append` 惯例。

### T4 WYSIWYG 编辑 + blockId 三方合并 —— 【包内 + P1 写 IPC】
- 编辑器：react-markdown/remark-gfm（desktop 已有）为底，块级可编辑；图片以可视块呈现，"查看源码"给高级用户；MD↔富文本双向无损（T4 范围）。
- 块锚：正文按稳定 `blockId` 分块，`project.json.chapters` 记录锚点；AI 改动为块级原地 patch，不整章重写。
- 三方合并：以 `versions/vN` 为基线（base / 当前文件 / AI patch）；目标块生成期间被手改 → 检测冲突、保留双方、用户裁决、不静默覆盖；成功合并存新快照（差异快照 + 内容哈希去重 + 保留策略，approval-boundary §13.3）。
- 写回：经 P1 IPC，Workspace Admission 校验 + 审计。

### T5 项目列表/切换（workspacePath 分组）—— 【Surface 侧，零改存储】
- `listChatSessions(profileId)` 拉取后按 `workspacePath` 分组 + `project.json` 元数据，在 Surface 实现；项目卡片按 `updatedAt` 倒序。
- 新会话绑定走 `promptSession(null, text, …, context:{ workspacePath: projectPath, workspaceKind:'auto' })` 一步式（§5.3/§9.4/O1），避免 `setChatWorkspace` 的 `'user'` 副作用。
- 对话记录搜索：`listChatSessions` 后前端过滤（§9.5）。

### T6 新会话新建 + 绑回 + 回放 —— 【平台既有能力组合】
- 每条对话 = 新 `ChatSessionRecord` + 独立 JSONL + 固定项目 `workspacePath`；新对话用 T5 的一步式 context 绑定。
- 对话显示完全复用 Live Session Pipeline（`useAgentSession` 由 `AgentFrame` 调用，Surface 收 `session` prop，不新造机制）；来源标注由 custom Surface 从 `tool_execution_*` 事件自行提取（O3）。
- 回放/续问按 pipeline 第 1/3/5 条（进程活着 getBranch()+streamingMessage、死了只读 JSONL、generation 整份丢弃）；标题复用 `setChatTitle` + `titleLockedByUser`。

---

## 5. 会话与工作区映射（权威口径，修正文档瑕疵）

- 采用 §5.3/§9.4 的一步式绑定：`promptSession(null, text, …, { workspacePath, workspaceKind:'auto' })`；由 `ipc.ts:952` 的 `openOrCreateSession` 在 `context.workspacePath` 存在时按 `'auto'|'user'` 写入（`:981-986`），已验证。
- `setChatWorkspace` 仅作备选：它会 `taskLifecycle.end` + `configure_session` 且置 `workspaceKind:'user'`（`ipc.ts:1381-1397`）。
- 设计文档 §10.2/§12/§13 表 T5 中"setChatWorkspace 绑回"的旧表述以本节为准（用户提示词已指明此瑕疵）。
- 项目创建走 `chooseWorkspace`（用户选普通目录）或校验自动分配路径祖先链，须过 Workspace Admission（§4.3.1）：主目录普通后代通过，主目录根/系统目录/Sparkii 控制目录及其后代拒绝。

---

## 6. P1 / P7 IPC 接口与安全边界

### 6.1 P1 通用工作区文件 IPC（新增，全部 typed、通用、非特判）

| IPC channel（示意） | 入参 | 职责 | 复用基座 |
| --- | --- | --- | --- |
| `sparkii:workspaceRead` | `{ sessionId, path }` | 读工作区内文本文件（MD/JSON/XML），返回文本 | `isPathInside` + admission |
| `sparkii:workspaceWrite` | `{ sessionId, path, content }` | 写/覆盖工作区文件（原子写） | `WorkspaceExecutor.execute(write)` |
| `sparkii:workspaceList` | `{ sessionId, dir }` | 列目录 | admission + 边界 |
| `sparkii:workspaceMkdir` | `{ sessionId, path }` | 建目录 | `WorkspaceExecutor`(ensureDirectoryChain) |
| `sparkii:workspaceDelete` | `{ sessionId, path }` | 删文件/普通子目录（工作区内免审批） | `WorkspaceExecutor.execute(delete)` |
| `sparkii:workspaceRename` / `workspaceMove` | `{ sessionId, from, to }` | 改名/移动 | `WorkspaceExecutor.execute(move)` |
| `sparkii:workspaceWriteVersion` | `{ sessionId, projectPath, version }` | 写版本快照（差异 + 哈希去重） | write + admission |
| `sparkii:compileDocx` | `{ sessionId, projectPath, outPath, manuscript, figures }` | 主进程 MD+图→DOCX 编译写出 | docx `ImageRun` + write + audit |

**R1 验收硬条件（逐条实现，缺一不可）：**
1. 每次操作先按 `sessionId` 取会话 → `workspacePath` → 构造/复用 Task Grant → `admitWorkspace` 校验目标在固定工作区内；
2. 拒绝越界：`..`、符号链接、目录联接、重解析点、硬链接别名、workspace root/父目录/信任锚（复用 `WorkspaceExecutor.verifyResource` 的失败关闭语义）；
3. 每次操作写 `rt.audit.append`（含 `sessionId`、projectKey、action、target、result），失败也写审计（失败关闭）；
4. 审计"回溯到项目"用 `project.json.workspacePath = 会话.workspacePath` 映射（Surface 呈现，不改 schema）。

### 6.2 P7 通用图表渲染 IPC（新增，因 T2 转确定）

| IPC channel（示意） | 入参 | 职责 | 安全边界 |
| --- | --- | --- | --- |
| `sparkii:renderDiagram` | `{ sessionId, projectPath, outPath(png), svg }` | 主进程用本机 Chromium 无头把 SVG 渲染为 PNG、内嵌源 XML、写回工作区 | 同 §6.1 R1：Workspace Admission 校验 outPath 在工作区内、拒绝越界、写审计、失败关闭；渲染子进程/浏览器生命周期受主进程管理，离线 |

- 通用性：channel 名与参数无 `bid-writing`/标书语义，任何需要"本机 SVG→PNG"的 agent 可用 → 符合 §14"通用非特判"。
- 回归点：渲染 IPC 不改动现有 surface/会话/审批路径；现有 agent 不调用则行为不变（纳入全量回归）。

---

## 7. 与设计文档 §14 的同步（阶段 D 将进一步回填实际文件）

阶段 A 需回填 §14 的结论（本阶段不改产品代码，仅登记技术结论）：
- **P7 由"（条件）待定"改为"确定"**：改动文件/层 = `electron/main/ipc.ts`（+ 新 `render` helper）、`preload/api.ts`、`api-types.ts`；改什么 = 新增通用 `renderDiagram` RPC（本机 SVG→PNG + 源 XML 内嵌 + 写回工作区）；为什么 = T2 渲染需 renderer 之外的本机子进程能力（§7.5/spike2.1）；通用非特判 = 是；对其他 agent 影响 = 不调用则不变；回归点 = 渲染边界/越界/审计 + 全量 agent 回归。
- **P6 保持"（条件）未触发"**：理由见 §3。
- P1 接口细化见 §6.1，不改变 §14 P1 的通用非特判性质与验收硬条件。

---

## 8. 风险与备选

| 风险 | 应对 |
| --- | --- |
| Chromium 版本漂移（1234 期望 vs 1208 实装） | P7 实现时锁定随包/自带 Chromium 路径 + 启动自检（`executablePath` 显式指定），失败关闭并提示，不静默降级联网 |
| FTS5 trigram 2 字查询不命中 | manifest 摘要清单兜底 + 精确打开；必要时加 n-gram/拼音扩展（包内，不新增平台） |
| P1 IPC 影响其他 agent（P1 影响面最大） | 独立评审 + 全量回归 general/contract-review/knowledge-qa/procurement-review；新 IPC 单独测试权限/边界/审计；确认不与 `readDocumentBytes`/`requestExportReport` 冲突（spike2.3 已确认） |
| 内嵌 draw.io 编辑器体积/许可 | 阶段 B 评估随包静态资源；超阈值用轻量自研属性编辑面板（仍本机）；源 `.drawio` 始终可编辑，PNG 内嵌源 XML 保证不丢可编辑性 |
| 手改/AI 增量冲突 | blockId 三方合并 + 冲突提示 + 版本回退（T4） |
| 提示注入（上传件） | 来源隔离标签 + Main 重算写入参数 + 工作区边界（设计 §6.4） |

---

## 9. 阶段 A 完成判定

- ✅ 必读资料全部通读（README.md 读取被安全策略拦截，未纳入；其架构信息由审核报告/技术依据文档覆盖）。
- ✅ T1-T6 技术方案定稿（§4）。
- ✅ 三个 P0 spike 全部可行（§2），无不可行项。
- ✅ P6/P7 归属结论明确（§3）：P6 未触发、P7 转确定。
- ✅ P1 IPC 接口与安全边界定义（§6），安全基座复用既有能力。
- ✅ 用户决定跳过技术设计审核，直接照已通过的产品设计文档施工（阶段 B 压缩为口头清单）。

---

## 10. 实现状态回填（用户决定跳过审核，直接照 §14 施工）

> 硬约束 1：平台改动立即登记、通用非特判、含回归点。以下为实际落地登记。

### 阶段 C1–C2（P1 骨架）已落地

| 编号 | 实际改动文件 | 改了什么 | 通用非特判 | 验证 |
| --- | --- | --- | --- | --- |
| **P1** | 新增 `electron/main/security/workspace-file-service.ts`；改 `electron/main/ipc.ts`、`electron/preload/api.ts`、`electron/preload/api-types.ts`、`src/types/sparkii-api.ts`；改 `test/preload-api.test.ts`；新增 `test/workspace-file-service.test.ts` | 7 条通用工作区 IPC（read/write/list/mkdir/delete/rename/move），每次经 `admitWorkspace` + `pathProbe` 校验固定工作区、拒绝 `..`/绝对路径/符号链接/reparse/硬链接别名、审计（allow/deny + sessionId→projectPath）、失败关闭。**未改** `readDocumentBytes`/`requestExportReport`，二者并存无冲突 | 是：接口无标书语义，任何 agent 可用 | 两端 typecheck 通过；service 单测 7/7；现有智能体回归 250+ 全绿 |
| **P2** | `src/App.tsx:633` | draft 判定从 `surfaceType === 'chat'` 放宽为 `chat || custom`，按 surface 能力开放、不写 agentId | 是 | app-general/app-workflow/contract-surface 全绿 |
| **P3** | 重生成 `src/platform/agent-surface-bindings.ts` | 注册 bid-writing surface（生成脚本自动扫描 manifest） | 是：标准接入动作 | 生成物含 bid-writing；agent 路由测试全绿 |
| **P5** | 复用既有 `admitWorkspace`（P1 服务内调用） | 项目工作区读写走既有 Workspace Admission | 是：复用平台机制 | P1 service 准入测试覆盖 |

### 阶段 C4–C7（P2–P5）已落地 —— 全部完成

| 编号 | 实际改动文件 | 改了什么 | 通用非特判 | 验证 |
| --- | --- | --- | --- | --- |
| **P7**（转确定，原兜底） | 新增 `electron/main/security/render-diagram-service.ts`、`electron/main/security/electron-svg-renderer.ts`；改 `ipc.ts`/`preload/api.ts`/`api-types.ts` | 通用 `renderDiagram` IPC：主进程用**自带 Electron Chromium**（offscreen BrowserWindow，无额外依赖/无联网/无版本漂移）把 SVG 渲染 PNG，draw.io 源 XML 存入 PNG `tEXt` 块；PNG 经 P1 `writeBytes` 写回固定工作区（复用 Workspace Admission + 审计） | 是：接口无标书语义，任何 agent 可用 | 8 单测（含 CRC/tEXt roundtrip/失败关闭）；renderer+electron typecheck 通过 |
| **P1（导出扩展）** | 新增 `electron/main/security/docx-compile-service.ts`；`workspace-file-service.ts` 增 `readBytes`/`writeBytes`；`ipc.ts` 增 `compileDocx` | 通用 `compileDocx` IPC：主进程用 `docx` 库把 MD（标题/段落/列表/图片）编译为 DOCX，图片从工作区经 P1 readBytes 读取，产物经 writeBytes 写 `output/final/`；用户主动导出构成授权，免审批、留审计 | 是：通用编译器，无标书语义 | 4 单测（有效 DOCX/图片嵌入/缺图降级）；typecheck 通过 |
| **P6** | — | **未触发**：T1 项目级检索落在包内（`project-index.ts`，切块 JSON 索引 + 关键词/tri-gram 匹配 + manifest 兜底），不新增平台检索能力/IPC | 是 | project-index 单测通过 |
| **P4** | — | **未触发**：审计回溯用 `project.json.workspacePath` = 会话 `workspacePath` 映射，不改审计 schema | 是 | P1 审计含 sessionId+projectPath |

**包内实现（非平台改动）**：
- P2 写作闭环：`block-merge.ts`（blockId 三方合并+冲突保留双方）、`version-store.ts`（差异快照+哈希去重+保留策略）、`context-lines.ts`（两条上下文线来源标注+不可信输入隔离）、4 个 skill（outline/chapter_draft/requirement_check/diagram）。
- P3 图表：`figure-converter.ts`（图结构 JSON 归一化+确定性分层布局+JSON→SVG+JSON→draw.io XML）；Surface 集成"从对话生成图表"。
- P5 打磨：项目资料检索（T1）、对话搜索（listChatSessions 前端过滤）、记住大纲位置（localStorage）、新对话一步绑定同一工作区。
- 测试：`bid-writing-p2` 12/12、`bid-writing-figure` 8/8、`bid-writing-surface` 6/6、`docx-compile-service` 4/4、`workspace-file-service` 7/7。

**最终验证**：现有智能体全量回归 **334 测试全绿**（general/contract-review/knowledge-qa/procurement-review）；零业务特判扫描通过（平台核心无 `bid-writing` 分支，唯一出现为构建期 surface 绑定生成物，属 P3 标准接入）。

### bid-writing profile（包内，非平台改动）
- 新增 `apps/desktop/agents/bid-writing/`：`manifest.yaml`（surface.type=custom）、`agent/capabilities.ts`、`agent/prompts/system.md`、`security/{approval,roles}.yaml`、`ui/`、`surface/{index.tsx,project-store.ts,styles.css}`。
- 三栏 Surface：项目列表/新建向导 + 大纲/正文/对话；新会话走 `promptSession(null, …, { workspacePath, workspaceKind:'auto' })` 一步绑定；对话区复用 `session`（Live Pipeline），来源标注/图表/导出待 P2-P4 阶段。
- 测试：`test/bid-writing-surface.test.tsx` 5/5（项目列表、workspacePath 分组、新建绑定、三栏渲染、章节保存）。

### 架构师终审（首轮不通过 → 修复闭环）

首轮独立架构审核判定**不通过**：安全边界（P1）、平台治理、零业务特判、与现有能力不冲突四项**全部通过**；列 5 项阻塞 + 4 项建议。逐项修复如下（全部已落地并复测）：

| 项 | 审核意见 | 修复 | 状态 |
| --- | --- | --- | --- |
| **B1** | 正文为裸 textarea，未达 §8.1/I8 WYSIWYG（图片可视块、查看源码切换） | 新增 `surface/wysiwyg.tsx`：react-markdown+remark-gfm 块级渲染、图片可视块（点击编辑源）、"查看源码"MD 无损切换；补 WYSIWYG 样式；修图片路径 `figures/`→`output/figures/` | ✅ |
| **B2** | 两条上下文线未在 Surface 接入：`context-lines.ts` 死代码、向导缺资料上传/知识库勾选、缺 O3 来源标注 | 向导扩为三步（名称→资料→知识库）：`addMaterial`（chooseDocument+readDocumentBytes 写 input/+buildIndex）、`listRagDatasets` 勾选写 `project.json.knowledgeBases`+`setSessionKnowledge`；对话区从 `tool_execution_*` custom 条目提取来源用 `sourceChip` 展示；新增 3 项单测 | ✅ |
| **B3** | 右栏"＋"走裸 `actions.newSession()`，未绑定工作区 | 左右栏"＋"统一改走 `startNewConversation()`（一步绑定同一 workspacePath） | ✅ |
| **B4** | 图编辑闭环缺"点图编辑源"路径 | 新增点图编辑：`editFigure` 读 `.json` 源 → modal 编辑 → `saveFigureSource` 重渲染 PNG+draw.io；生成图同时落盘 `.json`+`.drawio`+图片引用 | ✅ |
| **B5** | 差异快照基线丢失：某文件在基线版本未变时 `restoreFile` 读回 null，三方合并误报冲突 | `version-store.restoreFile` 按 `index.files[path]` hash 回溯到最近含该文件的版本 | ✅ |
| 建议① | `compileDocx` 默认业务词"投标文件" | 默认值改通用字面量（`document`/`output/final/document.docx`） | ✅ |
| 建议③ | 生成图引用只进 state 未落盘，导出丢失 | `generateFigure` 立即 `writeChapter` 落盘引用 | ✅ |
| 建议⑧a | 图片 scale=2 时反而不 resize，分辨率低 | `electron-svg-renderer` 统一 resize 到 width×scale | ✅ |
| 建议⑧b | 安全测试用 mock probe，符号链接/硬链接逃逸未被真实验证 | 委托复审由架构师独立评估（见下） | 见复审结论 |

**修复后验证**：149 核心测试全绿（bid-writing-surface 9/9、p2 12/12、figure 8/8、docx-compile 4/4、workspace-file-service 7/7、preload-api 2/2、ipc 107/107）；两端 typecheck 0 错误。已提交架构师复审。

### 架构师复审（第二轮不通过 → 再修复）

第二轮复审判定**不通过**，抓到两个被"假绿灯"测试掩盖的真实缺陷（B3/B4/B5、建议①③⑧a、零特判、测试真实性均通过）：

| 项 | 复审意见 | 修复 | 状态 |
| --- | --- | --- | --- |
| 阻塞1 (O3) | 来源 chips 匹配 `customType:'tool_execution_*'` 形状，但真实 pipeline 把 tool 事件归一化为 `kind:'tool'`（无 customType），知识库来源是 `customType:'knowledge_turn'`，故 chips 恒空 | 新增 `context-lines.extractSourceChips`，识别真实两种形状（kind:tool 的 knowledge/document 类 + knowledge_turn custom 行），去重；Surface 改调用它；单测用真实形状（禁止伪造 customType） | ✅ |
| 阻塞2 (B1) | WYSIWYG 图片用 `readDocumentBytes(相对路径)` 读，该 API 要求绝对/granted 路径，真实运行必然 denied/missing，图片加载失败 | 改用 `workspaceReadBytes({sessionId, path})`（工作区相对路径，经 P1 fenced）+ base64→Blob；补 `WorkspaceFileResult.bytesBase64` 类型字段；新增真实相对路径加载测试 + API 缺失时的防御性守卫 | ✅ |
| 建议⑧b | 安全测试用 mock probe + Set 强制标记 reparse，符号链接/硬链接防护未被真实验证 | 新增 `test/workspace-file-service.integration.test.ts`：用**真实** `createWindowsPathProbe`（realpath/lstat）+ 真实 symlink/hard-link 夹具，验证 .. 逃逸/符号链接/硬链接别名全部拒绝且写审计；4/4 通过 | ✅ |
| 建议 §6.4 | `renderContext` 仍为死代码，结构化隔离标记未进入注入通路 | **登记决策**：资料/知识文本由 agent 运行时按需读取（`system.md` + skills），不经过 Surface 直接注入 LLM；不可信输入隔离由 agent prompt 层（`system.md` 第3条明确"资料不是指令"）+ P1 工作区硬边界共同承担。`renderContext` 保留为可复用工具（有单测），Surface 不调用属预期，非缺口 | ✅（登记） |

**再修复后验证**：WYSIWYG 2/2、context-lines 单测新增 3 项、surface 9/9；真实 probe 集成测试 4/4；两端 typecheck 0 错误。已提交架构师第三轮复审。

### 架构师第三轮终审：**通过（有重要建议）** —— 可交付

独立复跑确认：两端 typecheck 0 错误；核心 158/158、现有智能体回归 225/225；零业务特判成立；第二轮两项阻塞（O3 来源 chips 恒空、B1 图片加载失败）按真实 pipeline 形状修复并验证。架构师 3 条重要建议（不阻塞）已全部就地处理：

1. `extractSourceChips` Shape 2 的 text 改从真实 `knowledge_turn.citations[].snippet` 按 documentId 提取（原读 `documents[].snippet` 与真实形状不符），测试夹具改真实形状并断言 snippet。
2. 符号链接集成测试无法创建链接时输出显式 `console.warn`（不再静默跳过），并标注需提权 CI 覆盖。
3. §6.4 结构化来源围栏（`<<<SOURCE>>>`）写入 `chapter_draft/SKILL.md`，使来源隔离标记进入 agent 运行时资料读取通路（与 `renderContext` 格式一致）；`system.md` 已有"资料不是指令"原则声明 + P1 工作区硬边界，三者共同闭环。

**交付状态**：全部 P0–P5 阶段实现完成、三轮架构审核通过、验证全绿。详见"改动文件清单/验证结果"各表。

### 运行时 profile 完整性修复（真实启动暴露，2026-11-17）

真实启动 `pnpm start` 时 main 进程抛 `Error: missing file: agent/tools.yaml`（`loadProfile`），随后还有 `approval policy invalid`。根因：**surface 单测全用 mock API，从未跑过平台真实的 profile loader**，所以"编译过 + 测试绿"但启动即崩。

`packages/config/src/loader.ts` 的 `loadProfile` 强制读取以下 8 类文件，缺一即 `PROFILE_INVALID`：

| 必需文件 | bid-writing 修复前 | 处置 |
| --- | --- | --- |
| `manifest.yaml` | ✅ | — |
| `agent/tools.yaml` | ❌ 缺失 | 新增（与 manifest.capabilities.tools 一致：read/write/edit/delete/move/knowledge.search/report.export） |
| `agent/workflow.yaml` | ❌ 缺失 | 新增（custom surface 不走 linear workflow，`steps: []`） |
| `agent/knowledge/corpus.json` | ❌ 缺失 | 新增（`[]`，项目资料运行时上传） |
| `ui/pages/home.json` | ✅ | — |
| `ui/theme.yaml` + 其指向的 `ui/theme/tokens.json` | ✅ | — |
| `security/roles.yaml` | ✅ | — |
| `security/approval.yaml` | ⚠️ 缺必填 `requireApproval` | 补 `requireApproval: []`（schema 必填；空数组语义=不使用已废止的工具白名单审批，审批仍走 Task Grant/Gateway/Admission） |

**回归防护（关键）**：新增 `test/bid-writing-profile.test.ts`，用**真实** `loadProfile` 加载真实 profile 目录，断言 manifest/surface=custom/tools/4 个 skills/system prompt/workflow/corpus/theme/roles 全部可解析。此类"运行期文件缺失"今后会在测试阶段暴露，而非启动时。

**验证**：真实 `loadProfile` 通过；159 测试全绿；两端 typecheck 0 错误。（本机 shell 环境 `ELECTRON_RUN_AS_NODE=1` 且无桌面会话，无法起 GUI 做端到端启动，已用真实 loader 覆盖崩溃点。）

### 运行时"创建会话失败"修复：知识库门禁可选降级（P8，真实运行暴露）

**现象**：profile 补齐后可正常启动，但在新建项目时提示"创建会话失败"。

**根因**：`ipc.ts` 的 `sparkii:promptSession` 在创建会话前调 `assertKnowledgeReady(profileId)`；当 `sparkiirag` 后端未配置/未就绪时它返回 `{ ok:false, error:'…' }` **且不创建会话**。bid-writing 的 manifest 声明 `knowledge.backend: sparkiirag`，因此被硬阻断。

该阻断本身是**平台既有契约**，且被测试显式锁定（`test/ipc.test.ts` "promptSession does not create a session when sparkiirag is unconfigured"），不能改默认行为——knowledge-qa 这类"知识库即核心能力"的 agent 必须保持严格门禁，否则会静默退化为无检索的假知识库。而产品设计 §15 要求"rag 不可用时降级并提示，不阻断写作"。两者冲突。

**处置：新增可选降级标志，默认关闭（通用、非特判）**

| 编号 | 实际改动文件 | 改了什么 | 通用非特判 | 验证 |
| --- | --- | --- | --- | --- |
| **P8** | `electron/preload/api-types.ts`（`DraftPromptContext.allowDegradedKnowledge?`）、`electron/main/ipc.ts`（gate 判定）、`electron/preload/api.ts`、`src/types/sparkii-api.ts`（类型对齐） | `promptSession` 的 RAG 门禁增加 `context.allowDegradedKnowledge === true` 旁路：仅当调用方显式声明"知识库是可选增强"时，RAG 不就绪也建会话并继续（审计照旧）；未声明则为原有严格行为 | 是：标志为通用能力开关，无 agentId/业务分支；平台核心无 `bid-writing` 字样 | `ipc.test.ts` 108/108（含新增降级放行 1 项 + 原有严格门禁项仍绿）；现有智能体回归 225/225 |

Surface 侧对应改动（**包内，非平台改动**）：`surface/index.tsx` 中 4 处 `promptSession` 调用显式传 `allowDegradedKnowledge: true`，并把 `res.error` 真实回显到状态栏（原先统一吞成"创建会话失败"，掩盖了真实原因）。

### 自定义 Surface 的对话输入框（composer）自建

复核 `App.tsx` 的 `AgentFrame` 后确认：平台只渲染 `<Surface>`，**不为 `custom` surface 注入 composer**（composer 仅由 `chat` surface 的内建壳提供）。而 P2 已把 draft 判定放宽到 `chat || custom`，所以 bid-writing 之前虽然能建会话，但对话栏没有输入框，用户无法发消息。

已在 `surface/index.tsx` 补自建 composer：`textarea` + 发送按钮 + `Ctrl/⌘+Enter` 快捷键 + 发送中态，走 `promptSession(sessionId, text, undefined, undefined, { allowDegradedKnowledge: true })` 进入 Live Session Pipeline（复用既有会话流，不新造管道）。新增 `test/bid-writing-surface.test.tsx` 2 项断言（发送时参数形状、失败时回显真实 error）。

**最终验证**：`bid-writing-surface` 11/11、bid-writing 全包 35/35、现有智能体回归 225/225、`ipc.test.ts` 108/108；仓库根全量 2255 通过（唯一失败为 `windows-sandbox-spike` 的原生探测超时/`reg.exe` 被环境策略拦截，与本改动无关）；两端 typecheck 0 错误。

### 新建项目耗时优化（P8 细化 + 包内并行化）

用户反馈"新建项目时间很长"。逐段追踪调用链后确认是**串行链叠加**，不是单点故障：

| 阶段 | 耗时来源 | 处置 |
| --- | --- | --- |
| 打开向导 | `listRagDatasets` → `probeRag` → `health()` + `listDatasets()`，RAG 配了但不可达时每请求 30s（最多 60s） | 本机 `settings.json` 未配 RAG，实际为毫秒级返回；未改 |
| 建会话 | ①**P8 原实现"探活失败才放行"，探活本身仍执行**——配了但不可达的 RAG 每次建会话/发消息都吃 30s；②`pool.acquire` 冷启动 `utilityProcess.fork` + Pi SDK 加载 + skills 扫描；③`maxAgents=4`、`queueEnabled=true`，4 个会话占用时新会话进 `pending` 排队，空闲槽仅在 `agent_settled` 后 60s 释放 | ①改为**降级模式直接跳过探活**（语义正确：可选知识依赖不做前置门禁，知识工具自身会返回 `CONNECTOR_DENIED`）；②③属平台既有并发策略，未改（见下文说明） |
| 写骨架 | 6 次 `workspaceMkdir` + 1 次 `project.json` + 5 次章节写 = **12 次串行 P1 IPC**，每次含 Admission + 路径 probe + 审计 | `ensureSkeleton` 改 `Promise.all`；6 次文件写改 `Promise.all`。路径互不相同、mkdir 本身 recursive，准入/审计语义不变 |
| 刷新列表 | 每个项目一次串行 `workspaceRead(project.json)` | 改 `Promise.all` 并行 |

**P8 细化登记**：`electron/main/ipc.ts` 把 gate 改为 `if (profileIdForGate && context.allowDegradedKnowledge !== true) { await assertKnowledgeReady(...); ... }`。仍是通用开关、默认严格、零业务特判。`ipc.test.ts` 的降级用例加重断言：配置 RAG 地址+凭据后仍断言 `fetch` **完全未被调用**（不只是失败放行）。

**仍未消除的耗时（需产品决策，未擅自改）**：`maxAgents=4` 的槽位排队与 60s 空闲释放是平台既有策略，bid-writing "一项目一会话" 模式下连建多个项目会占满槽位；解法方向是切换项目时显式 `releaseSessionSlot`，但会影响会话状态保持语义，需单独评审。冷启动的 Pi runtime 进程属平台架构，短期内只能靠预热池缓解。

**验证**：相关 160/160 全绿（含新增"降级不探活"断言）；renderer typecheck 0 错误。

### P9：创建项目即自动写作 — 机制重构（验收暴露，2026-11-19）

用户验收再次反馈"新建项目启动很慢"，并明确指出机制问题：**创建项目 = 立刻开始标书写作**，在用户不知情时后台跑模型，直到框架搭好才显示界面。读码确认调用链：`createProject` → `allocateAutoWorkspace` → `promptSession(null, "开始新标书项目：…")`；`promptSession` 在 `openOrCreateSession` 建会话后立即 `send({type:'prompt'})`（`ipc.ts:1322-1324`）+ `startSessionTask`，触发完整一轮 LLM。`startNewConversation` 与 `openProject` 兜底同样带 prompt。根因是**"建会话"与"发首条 prompt"被 `promptSession` 强耦合**，而 `listChatSessions`/工作区文件 IPC 又依赖会话记录存在，表面看"必须 promptSession"。

**方案：拆开"建会话"与"发 prompt"（P9 平台改动）**

| 平台改动 | 文件 | 内容 | 通用性 / 回归 |
| --- | --- | --- | --- |
| **P9** `sparkii:createSession` | `electron/main/ipc.ts`、`preload/api.ts`、`preload/api-types.ts`、`test/preload-api.test.ts`、`test/ipc.test.ts` | 复用 `openOrCreateSession(null, context)` 产出会话记录 + Pi 会话文件 + workspacePath；**不调 `startSessionTask`、不发任何 prompt**。槽位策略见下方"P9 槽位策略调整（B1 协同）" | 通用"建空会话"能力，无 agentId/标书语义；纯新增 IPC，`promptSession` 与现有 agent 行为完全不变 |

**包内改动（非平台）**：`project-store.ts` 的 `ProjectFile.status` 新增 `'setup'`（默认），语义 = 骨架已建、未开始写作；`surface/index.tsx` 三处建会话改 `createSession`；新增"准备阶段"面板（甲方/截止日/编号/模板 + 追加参考资料 + 补充需求），全部经 P1 fenced IPC 落盘到 `input/` 并重建 T1 索引；点「确认信息，开始写作」才 `writeProject(status:'drafting')` 并发出首条 prompt（携带确认后的全部需求）；setup 态 composer 被拦截。新增 `project-index.ts::loadMaterialDocs` 支持增量重建索引不丢历史资料。

**新的项目生命周期**：`创建（setup，零 LLM）→ 进入补信息/资料/需求 → 用户确认 → 首条 prompt（drafting）→ 逐章协作 → 导出（exported）`。

**验证**：`ipc.test.ts` 新增 createSession 用例（建会话但 `sent` 无 `prompt`/`steer`/`followUp`，且 `pool.release` 被调用）；surface 测试新增"创建不调 promptSession""setup 态 composer 被拦截""确认后才发首条 prompt 且携带需求"。相关 125/125 通过；双端 typecheck 0 错误。

---

### P9 槽位策略调整 + B1/B2/B3 前置修复（2026-11-19）

**B1（最关键）**：`ipc.ts` 的 `ensureProcessPipe` 原对每条 `agent_settled` 无条件 `taskLifecycle.end(sessionId,'session-ended')`。迟到的 settled（P9 建槽位 `new_session` / 旧进程复用产生）落在首条真实 prompt 建立 Grant 之后，会撤销 Grant，使工作区文件工具报 `TASK_REVOKED`。修法：`startSessionTask` 返回 Grant；`promptSession` 在三种投递分支成功后 arm 本轮 `{sessionId → taskId}`；`agent_settled` 仅当 `armed === activeGrant.taskId` 才认领 end（idempotent 消费，重复 settled 不再 end）。**P9 槽位策略**按设计稿决策⑤由"建完即释放"改为"**保持槽位 + 更激进的 15s idle 释放**"（`sessionIdleReleaseMs = 15_000`，`createSession` 改 `scheduleIdleRelease`）——保持槽位后首条 prompt 直接复用、不再 `new_session`，与归属判断协同根治竞态。取舍：setup 项目短时间占槽（15s 后自动回收），换来 Grant 不被误撤销。

**B2**：`openProject` 的 `createSession` fallback 补 `ensureSkeleton(sessionId)`，与 `createProject` 一致，消除 `WORKSPACE_NOT_CREATED`。

**B3**：新增 `surface/denial-label.ts::toolDenyLabel`，从 `kind:'tool'` 时间线条目的 `result`/`partialResult`（含 `{type:'text',text:JSON}` 信封）提取 `error.code`/`decision.ruleId`，回显到对话气泡，不再只显示笼统"无法读写"。

**验证**：`ipc.test.ts` 新增"B1 迟到 settled 不撤销非本轮 Grant"（setup 迟到/本轮 arm/taskId 不一致/重复 settled 四类）与 P9 15s 回收用例；`bid-writing-denial.test.ts` 覆盖四种 deny 信封。相关测试全绿，双端 typecheck 0 错误。

---

### P10：方案 C — 准备阶段可改「存放位置」（2026-11-19）

**决策来源**：设计稿决策⑥（存放位置方案 C）、⑦（知识库顶栏常驻）；实施计划 `docs/superpowers/plans/2026-11-19-workspace-relocation-plan.md`；架构评审/技术验证/统一复审三份报告。

**平台改动（1 个通用 IPC，无业务特判）**：

| 平台改动 | 文件 | 内容 | 通用性 / 回归 |
| --- | --- | --- | --- |
| **P10** `sparkii:relocateWorkspace(sessionId,newPath)` | `electron/main/ipc.ts`（handler）、`electron/main/workspace-relocation.ts`（12 步 helper）、`electron/main/chat-session-store.ts`（`updateWorkspacePathInTransaction`）、`preload/api.ts`、`api-types.ts`、`test/{workspace-relocation,ipc,preload-api}.test.ts` | 整体搬迁工作区根，sessionId 不变。严格顺序：基础校验 → 双向 `isSameOrDescendant` 循环嵌套 → 准入（`admitWorkspace` + 显式 `pathProbe.inspect` reparse/nlink + canonical）→ idle（`taskLifecycle.active(sessionId) === undefined`，不主动 end）→ 平台侧空目录 → `fs.cp` → 文件数/字节对账 → **单事务**批量更新所有 `workspacePath === old` 的 session record（F8）→ 对每个 open session 用自身 profileId `configure_session` → 验证 → 末位删源 → 审计；成功广播 `workspace-relocated`。失败策略：复制失败/对账失败/事务失败均只清目标副本、源完好；删源失败（EBUSY 等）保留双份 + 告警 + 审计，绝不删唯一副本 | 无 `agentId`/标书语义；setup 限制在包内守卫；纯新增 IPC，无现有调用方；`better-sqlite3.d.ts` 补 `transaction` 类型声明 |

**包内改动（非平台）**：
- 存放位置：`surface/index.tsx` 顶栏「工作区」抽屉 +「更改存放位置」按钮（**仅 setup 渲染**，drafting/exported 显示锁定提示）；调用链 `chooseWorkspace → relocateWorkspace → 更新 activeProject.workspacePath → writeProject → refreshProjects`（顺序保证不按旧 record 写回旧目录，F1）；监听 `workspace-relocated` 广播跨窗口刷新。
- 知识库（决策⑦）：顶栏常驻「知识库」popover，setup/drafting/exported 全程可改；workbench 侧加载 `listRagDatasets`；选中态从 `activeProject.knowledgeBases` 派生；「应用绑定」= `setSessionKnowledge` + `writeProject.knowledgeBases` + 刷新，「取消」回滚草稿；打开会话按 `project.json` 恢复内存绑定（修重启丢失），F8 多 session 同步；空数组显式清空；无连接降级文案。准备阶段面板保留摘要 +「前往设置」。**T1 `input/.index` 与 RAG 是两条独立通道，改知识库不重建 T1。**

**两项验证结论采信**：① 句柄占用前提不成立（Pi 不锁工作区），降级为兜底；② idle 原语 `taskLifecycle.active` 已存在，B1 独立修 agent_settled，与 relocate 解耦（详见技术验证报告）。

**验证**：`workspace-relocation.test.ts` 11 用例（全流程/基础校验/循环嵌套/空目录/reparse/复制失败/对账不一致/事务失败/EBUSY 保留双份/F8 批量/审计）；`ipc.test.ts` P10 channel 集成；preload channel 断言；surface 测试覆盖 setup 显示/drafting 隐藏、调用顺序、知识库应用/取消/空态/降级/恢复/多 session。全量回归与双端 typecheck 见最终验收。
