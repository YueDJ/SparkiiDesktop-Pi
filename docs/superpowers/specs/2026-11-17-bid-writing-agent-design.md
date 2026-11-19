# 标书写作智能体（bid-writing）产品设计文档

**状态：** 产品设计定稿（讨论收口）· 架构审核修复中
**日期：** 2026-11-17
**适用产品：** Sparkii Desktop（本地部署、可审计的多智能体工作台）
**前置讨论：** 2026-11-17 六轮 UI/UX 与产品模型讨论（详见 `.workbuddy/memory/2026-11-17.md`）
**架构审核：** 首轮审核「不通过」，6 项阻塞 + 8 项重要问题，本文为修复版（见文末审核与修复记录）

---

## 0. 文档定位与阅读指引

本文是标书写作智能体的**产品设计定稿**，回答"做成什么、怎么交互、数据怎么放、边界在哪"。它不替代后续的技术规格与实现计划——那些在本文审核通过后另出 `spec` 与 `plan`。

### 0.1 三条硬约束（审核后精确化）

1. **业务独立，最小平台改动。** 标书的业务逻辑、流程、界面、技能全部在独立 profile 包内，平台**不含任何 `bid-writing` 业务特判**。为支撑"文件即事实源"，需新增一组**通用、非业务特判**的平台能力与接入动作（文件读写 IPC、surface 草稿判定、构建期绑定生成）——**每一处改动都在第 14 章「平台改动清单」逐条登记**，含影响面与回归验证点，确保其他智能体不受影响。
2. **数据不出本机。** 图表渲染、资料解析、正文存储全部在本机完成；唯一的外部调用是按 API 连公司 SparkiiRAG 知识库（按账号权限），属于受控能力。
3. **安全遵循现行能力边界模型。** 遵循 `2026-10-21` 任务边界驱动设计：工作区内读写按 Task Grant 自动 `ALLOW`（不弹窗、有审计），越界/外部副作用才审批。详见第 11 章。

### 0.2 工作量标记

- **【复用】** 平台已具备，直接使用；
- **【新增·包内】** 新智能体目录内实现；
- **【平台改动】** 必须改平台，见第 14 章清单（逐条登记）；
- **【缺口·需验证】** 平台当前没有，技术设计阶段验证方案。

> **重要：** 用户已明确"可接受平台改动，但所有改动必须严格记录，且不能影响其他智能体"。因此凡标 **【平台改动】** 者，必须在第 14 章有对应条目；本文不含任何未登记的隐式平台改动。

---

## 1. 背景与目标

### 1.1 用户痛点

标书（投标文件）写作是长周期、强反复、重资料的工作：输入杂（招标文件、背景、资质、报价、截图）；要查公司历史方案与产品资料；技术方案需要**技术性插图**（架构图/拓扑图/流程图），不是文字描述；一份标书跨数天、几十轮修改；Word 太重，不可能每改一句都重新生成。

### 1.2 产品目标

在现有平台上新增标书写作智能体，提供：以"项目"为中心的可反复编辑工作台；两条互不干扰的上下文来源（公司知识库 + 项目私有资料）；可编辑、可渲染成图片的 draw.io 技术图表生成；轻量 Markdown 中间态、最终一次性导出 Word；全程本机、工作区内零打断、可审计。

### 1.3 目标用户

业务人员（商务/售前/投标岗），非技术背景；技术管理员负责配置知识库连接与模型端点。

---

## 2. 核心产品模型：项目 / 会话 / 文档

这是本智能体与平台现有智能体**最根本的区别**，也是全部设计的基石。

```text
项目（Project）= 一个固定的工作区目录，长期存在，是一等公民
  └─ 文档（Document）= 工作区里的标书正文 + 图 + 版本，权威状态在文件里
       └─ 会话（Conversation）= 对项目的一次编辑，多条、短命、上下文独立
```

| 概念 | 定义 | 生命周期 | 谁是事实源 |
| --- | --- | --- | --- |
| **项目** | 一份标书；对应一个固定工作区目录 | 长期，跨天跨周 | `project.json` + 工作区文件 |
| **文档** | 正文（Markdown）+ 图表 + 版本快照 | 随项目持续演进 | `output/` 下的文件 |
| **会话** | 一次编辑动作（生成首稿、改图、补章节…） | 短，一条对话 | 独立 `ChatSessionRecord` + 独立 JSONL |

**关键推论：**
- 用户进入项目，默认开一条新会话；会话是"编辑手段"，不是"文档本身"；
- 新会话上下文为空，按需从 `input/` 与选定知识库加载资料，但工作区产出一直在；
- 关闭、重开、换会话，标书不丢——权威状态在文件，不在会话上下文里。

符合平台产品原则①"权威状态是唯一事实源，LLM 叙述只是旁注"。

---

## 3. 设计原则与边界

1. **业务独立。** 全部业务逻辑落在 `apps/desktop/agents/bid-writing/`；平台层不出现任何 `bid-writing` 业务分支。必需的平台改动都是通用能力，逐条登记于第 14 章。
2. **薄契约接入。** Surface 实现 `AgentSurfaceProps` 薄契约；surface 类型用 `custom`（整页自研），复用平台壳层。custom 的空会话草稿适配属【平台改动 P2】。
3. **文件即事实源。** 项目状态、正文、进度写在文件里，界面读文件权威状态。读写能力由【平台改动 P1】提供。
4. **两条上下文线分离。** 公司知识库走 SparkiiRAG API；项目私有资料走上传解析；来源分别标注、分别可溯源。
5. **轻量中间态。** 正文以 Markdown 为工作格式，Word 只在最终导出编译。
6. **工作区内零打断。** 遵循 Task Grant 模型：工作区内 CRUD 自动 ALLOW、有审计；不弹审批。
7. **显示与线程解耦，全部复用。** 对话区接平台 Live Session Pipeline 与 `useAgentSession`，不新造显示机制。
8. **图表是技术图，不是文生图。** draw.io 结构化生成 + 本机渲染，中文标签准确、可编辑、可复现、离线。

**明确不做（本期）：** 不改平台运行时/会话存储/审批语义；不做 PPT 述标稿；不做定时值守/外部系统写入；不做多人协同；不做文生图。

---

## 4. 平台能力盘点（审核后修正）

### 4.1 【复用】平台已具备

| 能力 | 载体 / API | 用在哪 |
| --- | --- | --- |
| 内嵌 Agent 运行时、进程池 | `packages/agent-host` | 会话执行 |
| Profile 声明式配置 + 签名校验 | `packages/config`、`agents/*/manifest.yaml` | 智能体接入 |
| Surface 薄契约 | `AgentSurfaceProps` | 自定义三栏界面 |
| 壳层（会话/审批中心/审计/主题/运行池） | `apps/desktop/src/{shell,trust,audit}` | 全局框架 |
| 文档解析（PDF/Word/Excel/图片 OCR） | Pi 工具 `document.read` | 参考资料解析 |
| SparkiiRAG 连接与数据集列举/会话知识选择 | `listRagDatasets` / `testRagConnection` / `setSessionKnowledge` / `openRagDocument`（preload API） | 知识库勾选与检索 |
| DOCX 报告导出（标题/段落/表格，**不含图片**） | Pi 工具 `report.export`；preload `requestExportReport(sessionId, summary)` | 最终导出基础 |
| 会话存储（workspacePath / piSessionFile / updatedAt / titleLockedByUser / sortOrder） | `chat-session-store.ts` | 项目分组、排序、标题改名 |
| 工作区分配/选择/绑定 | `allocateAutoWorkspace` / `chooseWorkspace` / `setChatWorkspace`（preload API） | 项目工作区固定绑定 |
| 会话打开/列表/增量对话 | `openChatSession` / `listChatSessions(profileId)` / `promptSession(behavior: steer\|followUp)` | 多会话编辑 |
| 实时会话管道 | Live Session Pipeline（`2026-09-05` 设计）+ `useAgentSession`（由 `AgentFrame` 调用，surface 收 `session` prop） | 对话区实时+历史同源 |
| 标题自动生成 + 用户锁名 | `setChatTitle(sessionId, title, source?)` / `titleLockedByUser` | 对话标题 |
| 任务边界授权 | Task Grant / Policy Engine（`2026-10-21` 设计） | 工作区内零打断的安全依据。注：该设计为"已确认、可进入实现设计"，工作区内文件写 `ALLOW` 已可用，但 shell/外部能力仍受 Gateway 约束、部分平台为 partial——按成熟度使用，不夸大 |

> 说明：`document.read` / `report.export` 是 **Pi 工具名**（子进程内执行），不是 renderer 直接调用的 preload API；renderer 侧导出对应 `requestExportReport`。两者不要混为一谈。

### 4.2 【新增·包内】

- `manifest.yaml` / `agent/`（提示词、工具、skills）/ `surface/` / `security/`；
- 标书写作 skills（大纲、章节撰写、需求点核对、图表生成）；
- `project.json` 读写逻辑、工作区布局约定、项目列表/新建向导/工作台三栏 UI；
- draw.io 图结构生成 skill 与本机渲染工具（第 7 章）；
- Markdown→DOCX（含图片）编译器（第 8 章）。

### 4.3 【平台改动】

新增一组**通用工作区文件读写 IPC**（第 14 章 P1）；custom surface 草稿判定适配（P2）；构建期 surface 绑定生成 + catalog 注册（P3）；审计项目维度（P4）。

### 4.4 【缺口·需验证】

项目私有资料检索组件（6.3）；draw.io 离线渲染/内嵌编辑（7.5）；MD→DOCX 编译进程归属（8.3）；手改与 AI 增量的三方合并（8.1）。

---

## 5. 工作区数据模型

### 5.1 目录约定

一份标书 = 一个**固定**工作区。沿用平台路径规则 `Documents/Sparkii/workspaces/<agentId>/<projectKey>`，项目创建时分配一次并固定，所有会话绑定此路径。

```text
<项目工作区>/
  project.json
  input/
    甲方招标文件.pdf
    项目背景.docx
    资质证书/
    screenshots/
    .index/                 【缺口】项目级检索索引（见 6.3）
  output/
    manuscript/
      00-封面.md
      01-投标函.md
      03-技术方案.md
      ...
    figures/
      arch-3-2.drawio
      arch-3-2.png
    versions/
      v6/ v7/ ...            （差异快照 + 内容哈希去重，见 8.2）
    final/
      投标文件.docx
```

### 5.2 `project.json`（权威状态）

```jsonc
{
  "id": "bid-2026-11-17-001",
  "name": "智慧园区智能化项目 · 投标文件",
  "client": null, "deadline": null, "projectCode": null,   // 选填，可后补
  "template": "标准技术方案模板-v2",
  "status": "drafting",                 // drafting | exported（exported=存在导出产物/最近导出时间，非终态）
  "workspacePath": "C:/Users/.../workspaces/bid-writing/glow-fox-k7m",
  "knowledgeBases": [{ "datasetId": "kb-tech", "name": "技术方案库" }],
  "chapters": [                         // 章节树：左栏大纲与正文导航的单一事实源
    { "id": "1",   "title": "投标函", "file": "01-投标函.md", "status": "done" },
    { "id": "3.2", "title": "系统总体架构", "blockId": "blk-3-2", "status": "editing" }
  ],
  "progress": { "done": 4, "total": 12 },
  "version": 7,
  "createdAt": 1731820800000, "updatedAt": 1731820800000
}
```

要点：项目状态确定性写在文件；`knowledgeBases` 记录本项目勾选的知识库；`chapters` 用稳定 `blockId` 锚定正文块（供手改/AI 增量定位，见 8.1）；所有选填字段有显眼补录入口。

### 5.3 会话与项目的映射【审核修正】

**平台事实**（`2026-09-11` 工作区设计）：每条新 session 默认分配一条**新** `workspacePath`（`allocateAutoWorkspace` 用 UUID）。因此"相同 workspacePath 的一组会话"**不会自动发生**。

**产品机制（零改存储层）：**
- 项目创建时分配一次固定 `projectPath`，写入 `project.json`；
- **每条新会话必须在创建时即绑定 `projectPath`** —— 这是让多会话共享同一工作区的**关键动作**，不是"纯前端分组"就能做到。推荐一步式：`promptSession(null, text, …, context: { workspacePath: projectPath, workspaceKind: 'auto' })`（`ipc.ts` 的 `openOrCreateSession` 支持在 context 内指定路径）。备选 `setChatWorkspace(sessionId, projectPath)` 会把 `workspaceKind` 置为 `'user'` 并触发生命周期事件，故仅在一步式不可用时采用；
- 项目列表 = `listChatSessions(profileId)` 按 `workspacePath` 分组 + `project.json` 元数据，在 Surface 侧实现（纯前端读取，不改存储）；
- **Workspace Admission**：项目路径须通过 `2026-10-21` §4.3.1 准入检查（用户主目录下的普通项目后代可通过；不得落在主目录根、系统目录、Sparkii 控制目录及其后代）。项目创建走 `chooseWorkspace` 让用户选普通目录，或校验自动分配路径的祖先链。

**审计关联（I7）**：平台审计以 `sessionId` 为维度，无项目字段。项目↔会话映射通过 `project.json.workspacePath` + 会话 `workspacePath` 建立；审计"回溯到项目"由 Surface 用该映射呈现（不改审计 schema），详见 11.3。

---

## 6. 两条上下文线

两条线都汇入大模型上下文，机制不同、来源分别标注，可回溯到"引自公司知识库"还是"来自上传文件"。

### 6.1 线一：公司知识库（SparkiiRAG）【复用】

- 知识库是公司另一产品 SparkiiRAG，经 **API** 连接；RAG 按账号权限返回可见知识库列表。
- 用户在新建向导第 3 步（或项目内随时）勾选本项目要用的知识库，存入 `project.json.knowledgeBases`。
- 检索复用平台 SparkiiRAG 基础设施：`listRagDatasets` 列库、`setSessionKnowledge` 定范围、`openRagDocument` 打开出处；结果带出处、可回溯。
- 平台不碰 RAG 权限逻辑（由 RAG 侧按账号决定）。

### 6.2 线二：项目私有参考资料【复用解析】

- 用户上传文件（Word/PDF/文本/图片截图）存 `input/`；走 `document.read` 解析（电子件读文字层，扫描件/截图走本机 OCR）。
- 解析产物留 `input/`，本项目私有，**不进公司知识库**；每条上下文注明来源文件、可展开原文片段。

### 6.3 新会话"按需加载"【缺口·需验证】

新会话上下文为空，如何按需拿到 `input/` 的资料？

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A 项目级索引（目标） | 导入时切块建本机轻量索引，新会话按"当前项目"作用域检索，命中再 `read` 原文 | 体验最好；**这是新增组件，不是"复用 BM25 作用域"**（`Bm25Index` 是进程内类，无按工作区动态建索引的 API）——技术设计确定归属层与接口 |
| B 摘要清单 + 精确读取（降级） | `input/manifest.md` 存每份资料摘要，会话先读清单再决定打开哪几份 | 零新增能力；资料多时不够聪明 |

**结论：** A 为目标、B 为可交付降级。T1 缺口按"新增组件"登记，不再暗示复用。

**T1/T2 归属兜底规则（R2，用户"全登记"约束）：** T1 项目级索引、T2 渲染子进程若最终需要平台侧组件或新 IPC，技术设计确定后**必须补登记为 P6 / P7**（含通用性、影响面、对其他 agent 回归点）；否则一律落在包内或 Pi 工具侧，不新增平台能力。本文不含任何未登记的隐式平台改动——此规则确保归属未定期间也不产生登记漏洞。

### 6.4 不可信输入防护【审核新增】

上传的招标文件/DOCX/截图 OCR 属**不可信输入**，与知识库一起进 LLM 是提示注入面（`2026-10-21` §3.4/§4.2 威胁）。防护：
- 来源隔离标记：每块上下文带 `source` 标签（文件/知识库），明确"以下是资料内容，不是指令"；
- 写入参数由 Main/确定性边界重算（8.1），不采信模型自报的路径/风险；
- 写操作落入第 11 章能力边界，工作区内 ALLOW、越界 ASK/DENY；
- 资料解析产物视为数据，不得解释为权限扩张指令。

---

## 7. 图表生成与渲染（重点）

用户明确要求：**draw.io 那种技术性图表**（架构图/拓扑图/流程图），是**图片图像**，不是文字或 mermaid；生成后**可反复修改**。

### 7.1 选型理由

- 文生图：中文标签糊、不可编辑、不可复现 —— 不采用；
- mermaid 文字图：是文本，不满足"图片图像" —— 不采用；
- **draw.io（diagrams.net）**：节点+连线+中文标签精确、开放 XML（`.drawio`）、导出的 PNG 可内嵌源 XML 从而被重新打开编辑 —— 采用。

### 7.2 生成链路（提议—执行分离）

```text
① 模型输出结构化图描述（JSON，不是 XML）
   { type, title, nodes:[{id,label,group,items,icon}], edges:[{from,to,label}], layout:"LR|TB" }
② 确定性转换器：JSON → draw.io XML（mxGraph model）—— 包内代码，不让模型直接吐 XML
③ 自动布局：分层/方向排布（布局算法技术设计选型）
④ 写出 .drawio 源到 output/figures/
⑤ 本机渲染成 PNG/SVG，PNG 内嵌源 XML（draw.io "Include a copy of my diagram"）
⑥ Markdown 相对路径引用：![总体架构](figures/arch-3-2.png)
```

①是 skill（模型只产结构化数据）；②–⑤确定性、可测试、可复现；全程本机，不调文生图。

### 7.3 图结构 Schema（模型输出契约）

```jsonc
{
  "type": "architecture",              // architecture|topology|flowchart|sequence
  "title": "系统总体架构",
  "layout": "TB",
  "nodes": [
    { "id":"app",  "label":"应用层", "group":"应用层", "items":["运维门户","移动应用","大屏"], "icon":"app" },
    { "id":"plat", "label":"平台层", "group":"平台层", "items":["数据汇聚","智能分析","服务网关"], "icon":"server" }
  ],
  "edges": [{ "from":"plat", "to":"app", "label":"提供服务" }],
  "style": { "palette":"blue", "language":"zh-CN" }
}
```

模型不定像素坐标，由布局统一排布；`group` 支持分层框（感知/平台/应用层）；`icon` 走 draw.io 内置技术图形库，保证是"技术图"。

### 7.4 可编辑闭环（两条改图路径）

1. **点图编辑源**：点正文图片 → 用**本机内嵌** draw.io 编辑器打开对应 `.drawio` → 改节点/连线/标签 → 保存 → 自动重渲染 PNG 并替换引用；
2. **对话描述重绘**：对话里说"把应用层拆成三块" → 模型基于当前图结构增量改 → 重走 7.2 → 图自动换、版本 +1。

两条路写回同一个 `.drawio` 源，源是唯一可编辑对象，PNG 只是渲染产物。

### 7.5 渲染引擎与离线约束【缺口·需验证，P0 先行】

- 平台无 draw.io/mxgraph 依赖；draw.io 的 CLI/内嵌渲染多依赖完整编辑器运行时，随包分发有体积/许可/离线问题。
- **T2 定为 P0 先行技术验证**：确认离线渲染引擎（如随包 diagrams.net 静态资源 + 无头渲染）与内嵌编辑器的离线实现；中文按系统字体或随包字体，验证不乱码。
- **降级方案也必须本机完成**（如本机静态 HTML 版 draw.io），**不得**用联网版外部 draw.io（违反"数据不出本机"）。若"图片+可编辑+离线"三者都不可行，回到用户确认取舍。
- T2 结论影响第 14 章 P1 是否需要额外 IPC（渲染子进程/文件写出）。

### 7.6 与正文/导出衔接

图源与渲染图放 `output/figures/`；MD 相对路径引用；图随正文进版本快照；导出 DOCX 时 PNG 嵌入对应章节（第 8 章）。

---

## 8. Markdown 中间态与最终导出

### 8.1 中间态与手改/AI 合并【审核修正】

- 正文以分章节 Markdown 持久化于 `output/manuscript/`；轻、可手改、可 diff、LLM 擅长。
- **编辑器形态（I8）**：面向非技术用户，采用**所见即所得（WYSIWYG）编辑**，底层是 Markdown，图片以可视块呈现（不暴露 `![](...)` 源码）；提供"查看源码"给高级用户。MD↔富文本双向无损转换是 T4 的一部分。
- **手改与 AI 增量叠加的合并机制（I4）**：不是"天然不冲突"，需明确定义：
  - 正文按稳定 `blockId` 分块（见 `project.json.chapters` 与 MD 内块锚）；
  - AI 改动是**块级原地 patch**（只改目标 `blockId` 对应的块），不整章重写；
  - 以 `versions/vN` 为基线做三方合并（基线 / 当前文件 / AI 补丁）；
  - 若 AI 目标块在生成期间被用户手改，检测冲突并提示（保留双方，用户裁决），不静默覆盖；
  - 每次成功合并存新版本快照。
- 文件写回能力依赖【平台改动 P1】。

### 8.2 版本快照【新增·包内】

- 每次改动存快照到 `output/versions/vN/`；采用**差异快照 + 内容哈希去重 + 保留策略**（避免几十轮全量膨胀，参考 `2026-10-21` §13.3）；
- 支持回退与对比；快照存工作区外还是内、容量策略在技术设计定。

### 8.3 最终导出 DOCX【审核修正，收口为单一方案】

- 用户点"导出"且敲定后，才把 `manuscript/*.md` + `figures/*.png` **一次性编译**成 DOCX 到 `output/final/`；
- **编译方案收口**：因 `report.export` 当前不支持图片、且 `docx` 是 Node 库不宜在 renderer 沙箱运行，**采用"主进程内新增通用 MD→DOCX（含图片）能力"**——作为【平台改动 P1】的一部分或一个受管连接器，在技术设计确定。数据流：`Surface 请求导出 → 主进程读工作区 MD/PNG → 编译 DOCX → 写入 output/final/ → 审计`。
- 导出落在**工作区内**（`output/final/`），按 Task Grant 属工作区普通写，`ALLOW`；用户点导出构成对完全相同目标与载荷的主动授权（`2026-10-21` §9.4），**不弹审批**；
- 全程留审计，可回溯到项目与会话（11.3）。

---

## 9. UI/UX 设计

沿用 `DESIGN.md`（浅色+蓝+大圆角，语义色清晰）。三栏可调宽。

### 9.1 项目列表页

顶栏复用壳层；主区"我的标书项目" + `＋ 新建项目`；卡片显示项目名、甲方、进度（done/total 章）、状态（编制中/已导出）、最后更新时间（**按最后修改时间倒序**）；点卡片进入工作台。`已导出` 表示"存在导出产物/最近导出时间"，非终态，仍可继续改。

### 9.2 新建项目向导（四步）

1. 项目信息：仅"项目名称"必填，其余选填；
2. 上传资料：可跳过；
3. 选知识库：按权限列出、勾选，可跳过；
4. 选模板：套用公司 MD 骨架，可跳过。

建好即分配固定工作区 + `project.json` + MD 模板。补录入口显眼：工作台顶部"项目信息"，左/顶部"添加资料""知识库"。

### 9.3 项目工作台（核心三栏）

```text
顶栏：项目名 [← 项目列表]  已保存 · 版本 vN · 项目信息 · 导出
┌──────────────┬───────────────────────────┬───────────────┐
│ 左栏          │ 中栏                       │ 右栏           │
│ 章节大纲（上） │ 标书正文 · 全篇             │ 本次对话       │
│ ·点击定位/记位 │ ·滚动浏览全部章节           │ ·＋ 新对话      │
│ ────────────  │ ·大纲点击→导航并置顶标题     │ ·消息流        │
│ 对话记录（下） │ ·WYSIWYG 直接编辑（块级）   │ ·@ 引用资料    │
│ ·更新时间排序 │ ·图表以图片内嵌，可点编辑    │ ·来源标注      │
│ ·搜索按钮     │                           │               │
└──────────────┴───────────────────────────┴───────────────┘
```

**左栏**：大纲在上（来自 `project.json.chapters`），点击→中栏滚动定位、标题置顶、记住位置，不切页；对话记录在下，按 `updatedAt` 倒序（编辑后浮顶），顶部搜索按钮。

**中栏**：展示整本正文（非逐章切换）；大纲点击只滚动定位；WYSIWYG 直接编辑（8.1）；图表图片内嵌可点编辑。

**右栏**：本次会话对话流；右上角简洁"＋"开新对话；点"＋"后左/中栏不变，只换右侧对话；输入框支持 `@` 引用资料。

### 9.4 进入项目行为【审核修正】

- 进入项目 → 用 `promptSession(null, text, …, context: { workspacePath: projectPath, workspaceKind: 'auto' })` 一步创建并绑定项目工作区（见 5.3，避免 `setChatWorkspace` 的 `'user'` 副作用）；
- 新会话空上下文，按需从 `input/`（6.3）与 `project.json.knowledgeBases` 加载资料；
- custom surface 的空会话草稿态依赖【平台改动 P2】；
- "＋"新对话走同一路径；旧对话留档可回放、可继续（见 10.2）。

### 9.5 对话记录搜索（O4）

无现成 API：`listChatSessions(profileId)` 拉取后**前端过滤**（标题/摘要关键词），结果点击打开对应会话。

---

## 10. 对话机制与线程模型

### 10.1 显示与线程解耦：完全复用平台管道【复用】

平台 Live Session Pipeline（`2026-09-05`，已批准）解决"显示与线程分开、中间有管道"：

```text
Pi 进程（会话树 + streamingMessage）
  → 主进程管道（每进程一根 Pipe，每帧盖当前 slot.sessionId，全量透传）
     → 窗口只画 sessionId == 当前对话的事件
```

继承机制：进程活着起步 `getBranch()+streamingMessage`，进程关只读 JSONL；打开先缓冲→一次快照→叠缓冲，换会话整份丢弃（generation）不串话；切换/回答中切换走管道既有机制（解绑 `sessionId=null`→new_session→再绑）；live 与历史同源。

`useAgentSession` 由 `AgentFrame` 调用，Surface 收到 `session` prop——Surface 只管"画"，不自己接管道。

**来源标注（O3）**：Live Pipeline 只盖 `sessionId`、归一化器不解析业务来源；custom surface 需自行从 `tool_execution_*` 事件提取引用来源（哪个文件/哪个知识库）并展示。这是 Surface 侧工作，不改管道。

### 10.2 "新对话"的会话生命周期【审核修正，确定方案】

删除原文"复用进程清上下文"的模糊说法。确定映射：

- **每条对话 = 一条新 `ChatSessionRecord` + 独立 JSONL + 固定项目 `workspacePath`**；
- 新对话 = `promptSession(sessionId=null,…)` 新建 + `setChatWorkspace(项目路径)` 绑回；
- 旧对话留档在左栏"对话记录"，点击 `openChatSession(id)` 回放；进程已关只读其 JSONL；继续则 `switch_session` 用同一文件重建树后增量追加（管道 §第1条）；
- 同会话内连续微调用 `promptSession` 的 `steer`/`followUp`；上下文高时提示"建议开新对话"（选择权交用户）；
- 并发极低（单人编辑），即使每条会话各占一个 sessionId 也不排队；进程槽位空闲会释放。

---

## 11. 审批与安全（审核重写：现行能力边界模型）

### 11.1 用 Task Grant 语言重写

废止"按工具名白名单留空=零审批"的旧表述（`2026-10-21` §18.3 已取代）。现行模型：

- **工作区内普通 CRUD 自动 `ALLOW`**（§7.2）：`manuscript/*.md`、`.drawio`、`figures/`、`input/` 的增删改查、删除——不产生 Approval Proposal，但写 Tool 时间线与审计（口径对齐权威设计 §9.1，"不留审批行"≠"不留痕"）；
- 这正是用户"工作区内增删改查/删除不需审核"诉求的**平台原生实现**，比"白名单留空"理由更硬：安全来自确定性工作区边界，不来自模型自述；
- **执行路径区分（R4）**：Pi agent 发起的写/删/改走 Pi 工具链（Task Grant/WorkspaceExecutor，既有能力）；用户在中栏手改经 P1 新 IPC 的写/删/改名/移动走 P1 路径——因此 **P1 IPC 清单须含：读、写、列目录、建目录、删除、改名、移动、写出版本/导出文件**，两条路径都必须写审计；
- **P1 新 IPC 的安全边界与审计归属（R1）**：renderer 经 P1 IPC 的每次文件操作必须（a）经 Workspace Admission 校验目标在固定项目工作区内、拒绝越界（含 `..`/符号链接逃逸）、（b）写审计并回溯到 sessionId→项目、（c）失败关闭。否则"可控/可审计/被拒绝的写绝不发生"对新写路径不成立——此为 P1 的**验收硬条件**，spec 阶段必须解决；
- 导出 DOCX：主理由是**用户主动点击导出构成对完全相同目标与载荷的授权**（`2026-10-21` §9.4），故不弹审批；按 §8.3 Capability Gateway 分类"文件导出"属外部副作用能力，MD→DOCX 编译写出到 `output/final/` 后是否需经 Gateway 由技术设计确认，但不改变"用户主动授权免二次审批"的结论（R3）；
- 越界读、联网（除已绑定 RAG API 外）、外部系统写、改凭据 → `ASK`/`DENY`；本智能体本期基本不触发。

### 11.2 "可控"的正确表达

`PRODUCT.md` 的"写操作人工把关"在新模型下解释为：写操作的**影响范围由确定性 Task Grant 界定**，越界必被拦截且留审计；自动 ALLOW 也全程可解释、可回溯（§10.3），不是"无人把关"。

### 11.3 审计与项目回溯

- 自动 ALLOW 也 100% 留审计（§14）；项目↔会话映射通过 `project.json.workspacePath` = 会话 `workspacePath` 建立；
- Surface 呈现审计时按该映射归属到项目（不改审计 schema）；若需审计原生项目字段，登记为【平台改动 P4】，技术设计决定是否必要。

### 11.4 不采用自动审批

用户明确不采用"大模型判断安全级别→自动审批"（模型不可信，§3.4）。本期靠 Task Grant + 工作区边界，不引入模型自评授权。

---

## 12. 端到端流程

```text
新建项目（填名，其余跳过）→ 分配固定工作区 + project.json + MD 模板
→ 补录：上传资料到 input/（解析）、勾选知识库
→ 进入工作台 → 新建会话A + setChatWorkspace(项目路径)（空上下文）
→ 会话A：按需加载资料+知识库检索 → 生成 12 章 MD 首稿 + 图表
→ 手改（块级三方合并）/ 对话微调 / 点图编辑 → 每次存版本快照
→ "＋"开会话B（空上下文，绑同一工作区）→ 继续改同一份 output
→ 对话记录按更新时间排序，可搜索、可回放
→ 敲定 → 导出 → MD+图一次性编译 DOCX 到 output/final/（工作区内 ALLOW、留审计）
→ 项目 status=exported（非终态，仍可打开修改）
```

---

## 13. 技术缺口与待验证项

| # | 缺口 | 归属 | 建议 |
| --- | --- | --- | --- |
| T1 | 项目私有资料按需检索 | 新增组件（非复用 BM25） | A 项目级索引为目标，B 摘要清单为降级 |
| T2 | draw.io XML→PNG/SVG 本机渲染 + 内嵌编辑 | 包内 + 可能 IPC | P0 先行验证；离线/中文/体积；降级也须本机 |
| T3 | MD+图片→DOCX 编译 | 主进程通用能力（平台改动 P1 或受管连接器） | 收口单一方案，见 8.3 |
| T4 | 正文 WYSIWYG 编辑 + 块级三方合并 + 文件写回 | 包内 + P1 IPC | blockId、基线、冲突提示、MD↔富文本无损 |
| T5 | 项目列表/切换（workspacePath 分组） | Surface 侧 | 零改存储；`setChatWorkspace` 绑回固定路径（5.3） |
| T6 | 新会话新建 + 绑回 + 回放 | 平台既有能力组合 | 10.2 确定方案（独立留档，非复用进程清上下文） |

---

## 14. 平台改动清单（审核新增，一等章节）

> 用户要求：所有平台改动严格记录、不影响其他智能体。以下逐条登记。原则：改动均为**通用能力或标准接入动作**，**不含任何 `bid-writing` 业务特判**。

| 编号 | 改动文件/层 | 改什么 | 为什么（依赖它的设计） | 是否通用/非特判 | 对其他智能体影响 | 回归验证点 |
| --- | --- | --- | --- | --- | --- | --- |
| **P1** | `electron/main/ipc.ts`、`preload/api.ts`、`api-types.ts` | 新增一组**通用工作区文件 IPC**：按路径读、写、列目录、建目录、**删除、改名、移动**、写出版本/导出文件；新增主进程 MD→DOCX（含图片）通用编译能力。**验收硬条件（R1）**：每次操作经 Workspace Admission 校验目标在固定工作区内、越界拒绝、写审计并回溯 sessionId→项目、失败关闭 | 文件即事实源、手改即时写回、版本快照、图表落盘、含图导出、免审批删除（B1/I2/I3/R1/R4/T3/T4） | 是：任何 agent 都可用，接口不含标书语义 | 潜在影响面最大——现有 agent 不调用这些新 IPC 则行为不变；需确认不与已有 `readDocumentBytes`/`requestExportReport` 冲突 | 全量跑现有 agent 测试（general/contract-review/knowledge-qa/procurement-review）；新增 IPC 权限与路径边界测试（含 `..`/符号链接逃逸）；审计归属测试；导出回归对照 |
| **P2** | `src/App.tsx`（draft 判定，`App.tsx:633`） | 让 `custom` 类型 surface 也能拿到空会话草稿态（当前仅 `chat` 启用） | 进入项目即空会话、"＋"新对话（B4/9.4） | 是：按 surface 能力开放，不写 agentId | 仅放宽 draft 判定条件，chat/workflow 现有判定不变 | 回归 chat/worldflow/contract 的 draft 与新会话用例 |
| **P3** | `src/platform/agent-surface-bindings.ts`（构建期生成物）、agent catalog | 新增 profile 后重新生成绑定、注册目录 | 任何新 agent 的标准接入（B6） | 是：标准接入动作，非核心逻辑 | 纯生成物更新，不改运行时语义 | 构建期绑定单测；其他 agent 路由不变 |
| **P4**（条件） | 审计层（若需原生项目字段） | 增加项目维度或note字段 | 审计"回溯到项目"（I7） | 是：通用字段 | 审计导出格式可能变化 | 审计导出回归；**优先用 5.3 映射在 Surface 呈现，能不改则不改** |
| **P5** | Workspace Admission 接入 | 项目路径创建/绑定时走准入检查（§4.3.1） | 固定工作区安全性（B2） | 是：平台既有机制，新 agent 复用 | 无（复用既有检查） | 准入用例：主目录后代通过、受保护树拒绝 |
| **P6**（条件） | 待定（T1 项目级索引） | 若项目级检索索引落在平台侧则登记（新增检索组件/IPC） | T1 归属未定（§6.3 兜底规则 R2） | 是：通用检索能力 | 确定归属时评估 | 与现有知识检索回归对照 |
| **P7**（条件） | 待定（T2 draw.io 渲染） | 若渲染/内嵌编辑需平台侧 IPC 则登记（如渲染子进程） | T2 归属未定（§7.5 兜底规则 R2） | 是：通用渲染能力 | 确定归属时评估 | 渲染子进程权限与边界测试 |
| **P8**（实施中新增） | `electron/preload/api-types.ts`（`DraftPromptContext.allowDegradedKnowledge?`）、`electron/main/ipc.ts`（`sparkii:promptSession` 的 RAG 门禁判定）、`preload/api.ts`、`src/types/sparkii-api.ts` | 给知识库门禁增加**可选降级开关**，默认关闭：仅当调用方显式传 `allowDegradedKnowledge: true` 时，RAG 未就绪也照常建会话并继续（审计不变）；未传则完全保持既有严格行为 | 与 §15"RAG 不可用降级不阻断写作"一致；原实现为硬阻断，导致新建项目报"创建会话失败" | 是：普通能力开关，无 `agentId`/业务分支 | **默认关闭 ⇒ 现有 agent 零行为变化**；knowledge-qa 等以知识库为核心能力的 agent 不开启，仍严格门禁（不会静默退化为无检索假知识库） | `ipc.test.ts` 原有"sparkiirag 未配置不建会话"用例必须仍绿 + 新增"显式开启时放行"用例；现有智能体全量回归 |
| **P9**（验收暴露：创建项目即自动写作） | `electron/main/ipc.ts`（新增 `sparkii:createSession`）、`preload/api.ts`、`preload/api-types.ts`、`test/preload-api.test.ts`、`test/ipc.test.ts` | 新增**通用能力**：创建空会话并绑定固定工作区（复用 `openOrCreateSession`，产出会话记录 + Pi 会话文件 + workspacePath），但**不发送任何 prompt**、不触发 LLM；绑定后立即释放运行时槽位（`unbindAndRelease` + 清 `openSessions`），首次真实 `promptSession(sessionId, …)` 时按需恢复 | 原实现用 `promptSession(null, "开始新标书项目：…")` 建会话——创建项目即触发一轮 LLM 写作，用户在不知情下等"框架搭好"才见界面。用户明确要求：创建项目 ≠ 立刻写作；进入项目补资料/需求，确认后才协作 | 是：通用"建空会话"能力，无 `agentId`/标书语义；`promptSession` 行为完全不变 | **纯新增 IPC，无任何现有调用方 ⇒ 现有 agent 零行为变化**；不改 `promptSession`/池策略/审批 | `ipc.test.ts` 新增"createSession 建会话但不发 prompt / 释放槽位"用例 + 原有 108 用例全绿；surface 新增"创建不调 promptSession""确认后才发首条 prompt"用例 |
| **P10**（方案 C：准备阶段可改存放位置） | `electron/main/ipc.ts`（新增 `sparkii:relocateWorkspace`）、`electron/main/workspace-relocation.ts`（搬迁 helper）、`electron/main/chat-session-store.ts`（新增 `updateWorkspacePathInTransaction`）、`preload/api.ts`、`preload/api-types.ts`、`test/workspace-relocation.test.ts`、`test/ipc.test.ts`、`test/preload-api.test.ts` | 新增**1 个通用 IPC**：整体搬迁会话的固定工作区根到用户指定空目录（sessionId 不变）。严格按实施计划 §5.1 的 13 步：基础/双向嵌套/准入(reparse+hardlink+canonical)/idle/空目录校验 → `fs.cp` → 文件数+字节对账 → **单事务**批量更新所有引用该路径的 session record（F8）→ `configure_session` 重绑 → 验证 → 末位删源 → 审计；成功广播 `workspace-relocated` | 用户想把标书放到自己指定的位置（网盘/归档），且会话历史/知识库绑定/T1 索引（均随 sessionId 或整体目录）不丢；P1 文件服务明禁 move workspace root（`workspace-file-service.ts:272-274`），必须独立能力 | 是：**无 `agentId`/业务特判**，setup 限制放包内；平台侧仅通用 idle 校验（`taskLifecycle.active`） | **纯新增 IPC，无现有调用方 ⇒ 现有 agent 零行为变化**；不改 P1/P7/P9 既有 handler；B1 修复独立 | `workspace-relocation.test.ts` 覆盖全流程/批量事务/空目录/循环嵌套/reparse/跨盘对账/EBUSY 删源失败保留双份/审计；`ipc.test.ts` 新增 P10 channel 集成（批量更新+广播）；preload channel 断言 |

> **实施登记（2026-11-17，用户拍板跳过技术设计审核直接施工后回填）：** P7 已依据 §14 兜底规则转为**确定项**并落地——新增通用 `renderDiagram` IPC（`electron/main/security/render-diagram-service.ts`、`electron-svg-renderer.ts`），主进程用自带 Electron Chromium 把 SVG 渲染 PNG、内嵌 draw.io 源 XML，经 P1 writeBytes 写回工作区（Workspace Admission + 审计、通用非特判）。P1 另扩展 `compileDocx` 通用能力（`docx-compile-service.ts`，MD+图→DOCX）。P6/P4 保持未触发（T1 检索落包内、审计用 workspacePath 映射）。完整文件清单与验证结果见 `docs/superpowers/plans/2026-11-17-bid-writing-agent-technical-design.md` §10。实施过程**零 `bid-writing` 业务特判进入平台核心**；现有智能体全量回归 334 测试通过。
>
> **P8 补充登记（真实运行暴露）：** 平台原有"RAG 未就绪即拒绝建会话"是硬阻断且被测试锁定（`ipc.test.ts`），与本文件 §15"降级不阻断"要求冲突。取舍为**加开关、不改默认**：默认严格不变（保护 knowledge-qa 等核心依赖知识库的 agent），bid-writing 在 `surface/index.tsx` 的 4 处 `promptSession` 显式声明 `allowDegradedKnowledge: true`（声明位置在包内，非平台）。同批修复的还有"custom surface 无 composer"——已复核 `AgentFrame` 确认平台不注入输入框，由包内自建（非平台改动）。
>
> **P9 补充登记（验收暴露，2026-11-19）：** 用户验收发现"新建标书项目启动很慢"，根因是 `createProject` 用 `promptSession(null, "开始新标书项目：…")` 建会话——创建即触发 LLM 写作，且 `listChatSessions`/工作区文件 IPC 依赖会话记录存在。P9 提供"建空会话但不发 prompt"的通用能力解决此耦合。配套包内改动（非平台）：`ProjectFile.status` 新增 `setup` 态；`surface/index.tsx` 的 `createProject`/`startNewConversation`/`openProject` 改用 `createSession`；工作台新增"准备阶段"面板（补甲方/截止日/编号/模板、追加参考资料、填补充需求），点「确认信息，开始写作」才 `writeProject(status:'drafting')` 并发出首条 prompt；setup 态下 composer 被拦截。所有写入仍走 P1 fenced IPC。
>
> **P10 补充登记（方案 C · 2026-11-19）：** 设计稿"零新增 IPC"已修订为"**新增 1 个通用 IPC**"。包内配套（非平台）：工作区抽屉「更改存放位置」仅 setup 渲染，drafting/exported 锁定；调用链 `chooseWorkspace → relocateWorkspace → 更新 activeProject.workspacePath → writeProject → refreshProjects`，监听 `workspace-relocated` 广播做跨窗口同步。知识库绑定（决策⑦）放**顶栏常驻** popover，setup/drafting/exported 全程可改；打开会话按 `project.json.knowledgeBases` 恢复内存绑定（修 `sessionKnowledgeSelections` 内存 Map 重启丢失），F8 多 session 共享路径同步绑定；T1 `input/.index` 索引与 RAG 是两条独立通道，改知识库不重建 T1。存储位置写作后锁定、知识库写作后仍可改——两条生命周期分离。
>
> **前置 bug 修复登记（B1/B2/B3 · 2026-11-19）：**
> - **B1**（平台通用，`ipc.ts`）：`agent_settled` 从无条件 `taskLifecycle.end(sessionId,'session-ended')` 改为"本轮 prompt 归属判断"——仅当该 session 已 arm 本轮 taskId 且与活跃 Grant 一致时才 end；迟到的 settled（旧 `new_session`）不再撤销刚建立的 Task Grant（`TASK_REVOKED` 根因）。P9 槽位策略按设计稿决策⑤由"建完即释放"改为"**保持槽位 + 15s idle 释放**"，与 end 修复协同。
> - **B2**（包内）：`openProject` 的 `createSession` fallback 补 `ensureSkeleton`，消除 `WORKSPACE_NOT_CREATED`。
> - **B3**（包内）：工具 deny 的 `ruleId`/`error.code`（如 `TASK_REVOKED`）回显到对话气泡（`surface/denial-label.ts`），不再只显示笼统"无法读写"。
>
> **两项技术验证结论采信（见 `docs/superpowers/reviews/2026-11-19-workspace-relocation-tech-verification.md`）：** ① 评审 MUST-FIX 3 前提被推翻——本机实验证实 cwd 锁目录（EBUSY），但 Pi 子进程 fork 不设 cwd、saddle.cwd 指向 app data、`configureSaddle` 不 chdir，无任何常驻进程 cwd 在工作区；句柄占用从"必须先解决"降级为"删源失败保留双份"兜底。② MUST-FIX 5 原语已存在——`taskLifecycle.active(sessionId)` 即空闲判定，无需新增；B1 独立修 `agent_settled` 误 end，与 relocate 解耦。两项均不阻塞编码，已据此放行。

**改动治理要求：**
- 每条改动在实现 plan 中展开为独立任务，含测试用例与对其他 agent 的回归；
- P1 影响面最大，须单独评审并先做 spike（验证 IPC 设计与现有导出/读取不冲突）；
- P6/P7 为**兜底条目**：T1/T2 技术设计一旦确定需平台侧能力，立即转为确定条目并按上表格式补全，绝不留下未登记的隐式改动；
- 所有改动保留"通用、非特判"性质——review 时若发现任何 `if (agentId === 'bid-writing')` 进入平台核心，判定为违规。

---

## 15. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| draw.io 离线渲染/编辑器体积 | 图表不可交付 | T2 为 P0 先验证；降级也本机；三者不可行则回用户确认 |
| P1 平台改动影响其他 agent | 平台回归 | 第 14 章登记 + 全量回归 + 通用非特判约束 |
| 手改与 AI 增量冲突 | 手改被覆盖 | blockId 三方合并 + 冲突提示 + 版本回退（8.1） |
| `input/` 资料多时加载不准 | 生成质量降 | 先交付 B 方案，A 增强 |
| RAG 连接不可用 | 知识库线失效 | 复用连接状态与错误中心，明确提示；资料线仍可用 |
| 提示注入（上传件） | 越权/错误生成 | 6.4 来源隔离 + Main 重算参数 + 工作区边界 |
| 项目模型相对"会话即事实源"偏移 | 实现复杂 | 权威在文件、会话只编辑；5.3/14 覆盖 |

---

## 16. 落地阶段建议

- **P0 验证**：T2 draw.io 离线渲染/编辑（风险最高）+ T1 检索方案 + P1 IPC spike；
- **P1 骨架**：profile 包 + 三栏 Surface + project.json + 项目列表/向导 + 工作区绑定（P1/P2/P3/P5）；
- **P2 写作闭环**：两条上下文线 + MD 中间态 + 章节生成 + 手改合并 + 版本 + 多会话（复用管道）；
- **P3 图表**：图结构 skill + 转换/渲染 + 编辑闭环；
- **P4 导出**：MD+图→DOCX 编译 + 审计（P1 编译能力）；
- **P5 打磨**：项目级检索索引、搜索、记住位置、体验优化。

---

## 17. 附录

### 附录 A：关键决策记录

1. 图表 = draw.io 技术图（非文生图/mermaid），图片图像 + 可编辑源 + 离线；
2. 标书 = 项目 = 固定工作区；会话 = 编辑手段（独立留档）；文档 = 一等公民（文件即事实源）；
3. 中间态 = Markdown（WYSIWYG 编辑 + 块级合并），Word 只最终导出；
4. 两条上下文线分离（SparkiiRAG API / 上传解析）+ 不可信输入防护；
5. 审批遵循 Task Grant：工作区内零打断、有审计，采用现行能力边界模型；
6. 对话显示完全复用 Live Session Pipeline；
7. 业务独立、零业务特判；**必需的平台改动全部登记于第 14 章，确保不影响其他智能体**。

### 附录 B：与现有文档的关系

| 文档 | 关系 |
| --- | --- |
| `PRODUCT.md` / `DESIGN.md` | 产品原则与视觉语言，本文不得冲突 |
| `README.md` / `docs/2026-08-22-design.md` | 平台架构 |
| `2026-09-02-agent-surface-template-and-contract-review-design.md` | Surface 薄契约与绑定（接入依据） |
| `2026-09-05-live-session-pipeline-design.md` | 对话区显示/线程解耦（完全复用） |
| `2026-09-11-session-workspace-home.md` | 工作区路径与分配（项目工作区依据） |
| `2026-10-21-agent-approval-boundary-design.md` | 审批/安全（§11 依据，取代旧工具白名单说法） |
| `2026-09-22-agent-roadmap.md` | 智能体路线图（本文为新增方向，不冲突） |

### 附录 C：架构审核与修复记录

**首轮审核（架构师 sub agent）：不通过** —— 6 项阻塞（B1 缺文件读写 IPC / B2 工作区模型冲突 / B3 审批机制过时 / B4 custom 无草稿 / B5 会话兼得矛盾 / B6 绑定文件改动）+ 8 项重要问题。

**修复对照：**

| 问题 | 修复 |
| --- | --- |
| B1 | 硬约束改为"最小平台改动"；新增【平台改动 P1】通用文件读写 IPC；第 14 章登记 |
| B2 | 明确项目固定 workspacePath + 每条新会话 `setChatWorkspace` 绑回（5.3）；Workspace Admission（P5） |
| B3 | §11 用 Task Grant 能力边界重写，废止工具白名单旧说法；导出在工作区内 ALLOW + 用户主动授权 |
| B4 | 新增【平台改动 P2】custom draft 判定；9.4 说明 |
| B5 | 10.2 确定"每条对话=新记录+独立 JSONL+固定路径"，删除"复用进程清上下文" |
| B6 | 第 14 章 P3 登记 binding 生成物改动；独立性表述精确化 |
| I1 | 6.3 明确 T1 是新增组件，删除"复用 BM25 作用域" |
| I2 | 8.3 收口单一方案：主进程 MD→DOCX 通用能力 |
| I3 | 7.5 降级方案改为本机，P0 验证，不得联网 |
| I4 | 8.1 定义 blockId + 三方合并 + 冲突提示 |
| I5 | 4.1 修正 API 名/签名/职责（工具名 vs preload API vs hook） |
| I6 | 6.4 新增不可信输入防护 |
| I7 | 5.3/11.3 项目↔会话映射 + 条件改动 P4 |
| I8 | 8.1 明确 WYSIWYG 编辑器形态 + MD 无损转换 |
| O1/O2/O3/O4 | 8.2 差异快照、9.1 状态语义、10.1 来源标注、9.5 搜索实现均已纳入 |

**第二轮复审（架构师 sub agent）：仍需修改** —— 6 项阻塞全部确认修复、I1-I8/O1-O4 全部落地、用户 5 项核心诉求全部保住；剩 4 项重要问题（R1 P1 IPC 安全边界与审计归属 / R2 T1 归属兜底 / R3 导出分类 / R4 P1 缺删除改名移动）+ 3 项建议（O1 会话绑定副作用 / O2 Task Grant 成熟度 / O3 审计口径）。

**第二轮修复对照：**

| 问题 | 修复位置 | 修复内容 |
| --- | --- | --- |
| R1 | §11.1、§14 P1 | P1 IPC 每次操作须经 Workspace Admission 校验、越界拒绝、写审计回溯 sessionId→项目、失败关闭——列为 P1 验收硬条件 |
| R2 | §6.3、§14 P6/P7 | T1/T2 归属兜底规则：需平台侧能力则补登记 P6/P7，否则落包内/Pi 工具侧，杜绝未登记改动 |
| R3 | §11.1、§8.3 | 导出免审批主理由改为 §9.4 用户主动授权；对齐 §8.3 Gateway 分类，编译写出是否过 Gateway 由技术设计定 |
| R4 | §11.1、§14 P1 | P1 清单补删除/改名/移动；区分 Pi 工具路径与 P1 IPC 路径，两者都写审计 |
| O1 | §5.3、§9.4 | 会话创建改用 `promptSession` 的 `context.workspacePath/workspaceKind` 一步绑定，避免 `'user'` 副作用 |
| O2 | §4.1 | Task Grant 成熟度措辞精确化（文件写可用，shell/外部仍受 Gateway，部分平台 partial） |
| O3 | §11.1 | "不留审批行"统一为"不产生 Approval Proposal，但写 Tool 时间线与审计" |

**终审（第三轮）：全部审核通过。** R1-R4/O1-O3 已全部解决，无阻塞项；用户 5 项核心诉求（draw.io 可编辑技术图+本机渲染、两条上下文线、Markdown 中间态、三层模型、三栏 UI、对话复用管道）与约束（平台改动全登记、通用非特判、含回归验证点）均满足。产物可进入下一阶段（技术设计 / 实现计划），**本阶段不含任何产品代码改动**。
