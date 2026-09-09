# SparkiiRAG Connector — Design Spec

**Status:** Draft v7（连接器 Tasks 1–6 已在 `feat/sparkii-rag-connector` 落地；本版吸收知识问答 Surface / 出处气泡 / 空检索 abort。计划：`docs/superpowers/plans/2026-09-09-sparkii-rag-connector.md`）  
**Date:** 2026-09-09  
**Depends on:**
- `docs/2026-08-22-design.md`（A 类连接器：文档/知识库）
- `docs/superpowers/specs/2026-08-25-general-agent-design.md`（进程模型：Renderer / Main / Pi）
- `docs/superpowers/specs/2026-09-04-runtime-viewport-decoupling-design.md`
- `docs/superpowers/specs/2026-09-05-live-session-pipeline-design.md`
- `packages/connectors` 现有 `document` / `knowledge` / `report` 合同
- SparkiiRAG（RAGFlow 同源）`docs/references/http_api_reference.md`

**Amends:**
- `knowledge.search` 现为进程内 BM25，语料来自 `agent/knowledge/corpus.json`
- 通用智能体 chat 与知识问答不得混用同一 profile
- v6「会话头选库、工具卡当出处、空检索覆盖模型正文」由本版取代

---

## Goal

在 `@sparkii/connectors` 增加可配置的 **SparkiiRAG 客户端**，并同期交付独立智能体 **企业知识问答**。Desktop **只检索和打开出处**。文档上传、解析、切块全部在 SparkiiRAG Web 完成。生成、模型路由、审批、审计仍留在 Desktop。

不嵌入 RAGFlow Chat，不走 OpenAI 兼容 `/chat/completions` 做整段问答。不改通用智能体的工具列表与默认聊天行为。合同审核本期仍走本地 BM25（切 RAG 不在本期）。

## Why this round

宏昌方案里横向可演示、别的客户也有的能力是「问制度」。现有 BM25 只适合合同审核那一小份法规语料；企业问答要混合检索（词 + 向量），引擎用本机/内网的 SparkiiRAG，不在 Desktop 里自己做入库。

后续平台 OCR → 财务扫描单据、化验手写。环保不在这条链上（要监测数据和工艺图谱，不是 OCR）。那些不在本 spec。

## Confirmed Decisions

1. **引擎是 SparkiiRAG。** 地址和密钥必须可配置：现在是本机 WSL（默认 `http://127.0.0.1:9380`），以后是客户内网服务器，只改设置、不改代码。
2. **第一期 Desktop 不上传、不触发解析。** 入库只在 SparkiiRAG Web。Desktop 调用 `POST /api/v1/retrieval` 和打开原文（`GET .../documents/{id}`）。
3. **设置新开「知识库」分组**，不塞进「数据与隐私」。
4. **连接器与知识问答同一轮做。** 新 profile `knowledge-qa`，不把检索混进通用智能体。
5. **出处权威是本轮检索的结构化 `documents`，不是模型措辞。** 句内 `[1]` / `[2]` 只靠系统提示，以下半文件列表为准。不调用 SparkiiRAG 聊天补全，不把生成交给它的大模型。
6. **检索后端写在 profile，不写死智能体 id。** `manifest.knowledge.backend: bm25 | sparkiirag`。合同审核本期 `bm25`；知识问答 `sparkiirag`，未配好引擎时失败，禁止静默退回 `corpus.json`。
7. **不把 RAGFlow Chat 当智能体。** 检索与生成拆开：检索在 SparkiiRAG，生成在 Desktop。
8. **检索接法用方案 2：** Pi 发出 `knowledge.search`，Main 连 SparkiiRAG 执行，结果回 Pi 供生成；窗口（Renderer）画出处。
9. **空检索由 Main 硬拒，不经过大模型。** `chunks.length === 0` 时 abort 本轮生成，写入拒答气泡。本期 **不做** Main 侧「没搜就 follow_up 再答」；先搜只靠系统提示。未命中的硬锁只覆盖「搜了但 chunks 为空」。
10. **引擎全局一份 Key。** 可见库 = 这把 Key 在 SparkiiRAG 上能列出的全部 dataset。Desktop **不再**给智能体配允许范围。每个需要知识库的智能体只配一个 **默认库**。`picker: hidden`（合同审核）永远用默认；`picker: session`（知识问答）在 **Composer 工具栏**从 Key 可见的全部库中自选。
11. **已保存的 RAG Key 对 Renderer 不可见、不可复制。** 设置页只显示「已配置 / 未配置」。空保存 = 保持原 Key；只有粘贴一条新 Key 才替换。Main 永不把明文 Key 经 IPC 发给窗口。现有 `sparkii:getApiKey('sparkiirag')` 必须返回 `null`，不得 `keyFor`。`saveSettings` 合并写入，不得用大模型保存覆盖掉 `rag`；Key 只经 `saveRagSettings`。
12. **知识问答与通用智能体共用 `StandardChatSurface` 与同一套 live/history 管道。** 定制走插槽（`toolbarExtra`、`renderAssistantMessage` / `renderCustomEntry`、空状态文案、隐藏工作区/技能），**禁止** `if (agent.id === 'knowledge-qa')`。
13. **助手正文与出处存成 JSONL 里相邻的两份数据，渲染成同一个气泡。** 不改写 Pi 已写入的 assistant `text`。不把出处做成第二条聊天气泡。
14. **`manifestSchema` 必须声明 `knowledge`。** Zod 默认 strip 未知键；不加字段则 YAML 里的 `knowledge` 进不了 `ProfileManifest`，执行层会当成未配置并误走 BM25。

## Current State

### 已落地（Tasks 1–6）

`SparkiiRagClient`、`knowledge.*` `host: 'main'`、`connector_read` RPC、Main `executeKnowledgeSearch`、写后不可读的 RAG Key、设置页「知识库」分组。实现时读 `rt.profileOf(id).profile.manifest.knowledge`，不要从 `assemble()` 裁过的 AgentManifest 找。

`manifestSchema` **尚无** `knowledge`（架构师第一轮 Important）。必须在创建 `knowledge-qa` YAML **之前**补上。

### Desktop 三个进程

```text
Renderer（窗口里的 React）
  无 Node、无密钥、不能访问客户内网密钥。只画界面、发 IPC。

Main（Electron 主进程）
  可信控制层：设置、Keyring、审批、审计、会话、模型路由。
  现在大模型 API Key 只存在这里。对 SparkiiRAG 的 HTTP 也应只从这里发出。

Pi 子进程（智能体循环）
  调模型、决定调哪些工具。host:main 的 read 走 connector_read；
  write 工具只提出议，Main 批准后才执行。
```

「用 Main」不是新造一个服务，而是：**不要让 Pi 子进程拿着 RAG 的 API Key 去访问 9380**。

### SparkiiRAG HTTP（本期只用）

认证：`Authorization: Bearer <API Key>`。成功：`code === 0`。API Key 绑的是 **租户/账号**，不是某一个 dataset。该账号拥有的库以及 `permission=team` 的共享库都能被 `GET /datasets` 列出。

| 能力 | 方法 | 路径 | 本期 Desktop |
| --- | --- | --- | --- |
| 健康检查 | GET | `/api/v1/system/healthz` | 设置页测连通（无需 Key） |
| 列知识库 | GET | `/api/v1/datasets` | 验证 Key、默认库下拉、Composer 选库选项 |
| 检索 | POST | `/api/v1/retrieval` | **核心** |
| 下载原文 | GET | `/api/v1/datasets/{id}/documents/{doc}` | 打开出处 |
| 列文档 | GET | `/api/v1/datasets/{id}/documents` | 可选，只读状态 |

**本期不用：** 上传、parse/chunks、ingest、删文档、建库、OpenAI 兼容 Chat Completions、知识图谱、RAPTOR。

检索是混合检索：`vector_similarity_weight` 默认 0.3（词项权重 0.7）。命中即出处：`content`、`document_id`、`document_keyword`、`dataset_id`、`similarity`、`term_similarity`、`vector_similarity`、`positions`（可空）、`doc_aggs`。

## Approaches：检索放在哪一层

知识问答每一轮都是：检索 → 片段交给模型写回答 → 窗口列出出处。差别是 **谁发起检索、谁发 HTTP**。

### 方案 1 — 子进程自己连 SparkiiRAG

Pi 调 `knowledge.search` → 子进程拿 Key 去 `fetch`。改动最小，密钥离开 Main。**不采用。**

### 方案 2 — Pi 请求，Main 执行（采用）

```text
用户在窗口提问
        │
        ▼
Main 把问题交给 Pi（智能体循环）
        │
        ▼
Pi / 模型决定：要查知识库
  调用工具 knowledge.search({ query: "高温津贴怎么发" })
        │  不在子进程里发 HTTP；不传 datasetId
        ▼
connector_read RPC → Main
  注入 dataset_ids（默认库，或会话当前选中）
  SparkiiRagClient.retrieve(...)
        │
        ├─ chunks.length === 0
        │     空工具结果先回 Pi（审计）
        │     返回之后再调度 abort（不要在 return 前 await abort）
        │     append knowledge_turn { refused: true, text: RAG_REFUSE_TEXT, documents: [] }
        │     若 abort 没赶上、JSONL 留下助手正文：管道仍原样转发；
        │     Surface walk 用相邻 refused knowledge_turn 替换该助手气泡
        │
        └─ 有命中
              工具结果回 Pi（编号 chunks 供模型打 [1][2]）
              本轮 pending.documents 记下 doc_aggs
              模型流式写助手正文（气泡上半，不改 text）
              该条助手 message_end → append knowledge_turn { refused: false, documents }
              窗口：同一气泡下半画出处（Renderer，不是 Pi）
```

Pi 发出「去搜」，Main 用 API 打 SparkiiRAG，结果再回给 Pi。**展示不在 Pi 里。** 出处清单由 Main 在本轮结束时写入 JSONL custom，Renderer 折进助手气泡。工具结果仍是模型生成的依据；气泡下半文件列表以 `knowledge_turn.documents` 为准，不解析模型句子里的书名号。

### 方案 3 — Main 每轮先搜再让模型写

不问 Pi，Main 在 `promptSession` 里直接 retrieve。**不采用。**

**一期就按方案 2 实现**（仍不含上传解析）。

## Non-goals（一期）

- Desktop 上传、parse、建库、删文档、chunk 编辑。
- 通用智能体里加知识库工具或自动检索。
- 嵌入 SparkiiRAG / RAGFlow Web，或走 `/api/v1/openai/{chat_id}/chat/completions`。
- 给智能体勾选「允许的知识库范围」（`allowedDatasetIds`）。
- 把已存 RAG Key 回传到 Renderer，或沿用模型 Key 那种密码框回填。
- 合同审核本期切到 SparkiiRAG（设置里可先填默认法规库，检索执行器仍是 BM25）。
- 财务 OCR、图谱、RAPTOR、环保监测。
- 页码级 PDF 跳转（`positions` 只透传，UI 不用）。
- 句向量二次对齐、审计级「句句有出处」。句内 `[n]` 不做强制校验。
- 改写已落盘的 assistant `text`（不把出处拼进模型正文）。
- 用 JSON 指针 / `assistantId` 解引用工具结果（改为同一次写入的 `knowledge_turn.documents` 快照）。

## Architecture

```text
设置 → 知识库
  rag.baseUrl + Keyring(apiKey:sparkiirag) + rag.bindings[].defaultDatasetId
        │
Pi  knowledge.search({ query }) / knowledge.fetch_document（read）
        │  connector_read（无审批）
        ▼
Main  SparkiiRagClient
        │  retrieve / fetchDocument / health / listDatasets
        ▼
SparkiiRAG（WSL 或客户内网，地址可配置）
        │
JSONL：user → toolCall/toolResult → assistant text → custom knowledge_turn
Renderer：同一助手气泡（上半正文 / 横线 / 下半出处）
```

### 包边界

| 包 | 职责 |
| --- | --- |
| `@sparkii/connectors` | `SparkiiRagClient`、`RetrievalResult` 映射、超时/错误码。不 import Electron。 |
| `apps/desktop` Main | 读知识库设置与 Keyring；执行 retrieve/fetch；测连通；注入 dataset；空检索 abort；写入 `knowledge_turn` |
| `packages/agent-host` | 知识库 read 工具走 `connector_read`，不在子进程发 HTTP |
| `packages/ui` | `ChatComposer.toolbarExtra` 通用插槽；不认识 SparkiiRAG / dataset |
| Renderer `surface/` | 知识库选库控件、出处折气泡、打开原文；`StandardChatSurface` 只提供插槽 |
| `packages/config` | `manifest.knowledge` schema + 知识问答 profile |
| 通用智能体 | **不改工具列表**；不传知识问答插槽，聊天外观与现在一致 |
| 合同审核 | 一期检索仍走 BM25；不折 `knowledge_turn` |

### 会话管道（必须复用，禁止另做时间线）

与通用智能体相同：

```text
Pi: getBranch() + streamingMessage → subscribe events
Main: ensureProcessPipe 盖 sessionId，转发 chat-event；没有第二条时间线
Renderer: useAgentSession — 先 subscribe 缓冲，再 openChatSession 快照，再 applySurfaceEvent
```

- 直播且进程仍在：`get_session_entries` + `streamingMessage`（不是磁盘）
- 进程已死：JSONL via `readPiSessionEntries`
- `get_messages` **不是**时间线
- `StandardChatSurface` 只渲染 `props.session.entries`（经插槽折气泡），无本地乐观时间线
- 切 `current` 不 abort；卸载 Surface 不停 Pi
- 事件按 `sessionId` 过滤；`generation` 丢掉过期快照
- 切会话不中断流式；Stop 只在 Composer

选中的知识库是会话元数据（Main 内存 `Map`，类似模型/工作区），**不进 JSONL**。换库只影响后续提问。气泡里的出处来自该轮已写入的 `knowledge_turn`。

## 可配置的知识库（设置新分组）

设置增加分组 **知识库**，分两块：引擎，和每个智能体的默认库。

### 引擎（全局一份）

| 字段 | 存储 | 说明 |
| --- | --- | --- |
| 引擎地址 | `settings.json` `rag.baseUrl` | 默认 `http://127.0.0.1:9380`，内网改地址即可 |
| API Key | Keyring `apiKey:sparkiirag` | 与模型 Key 相同加密；**写后不可读回窗口** |
| 相似度阈值 | `settings.json` `rag.similarityThreshold` | 默认 `0.2`，传给 `/retrieval` |
| 向量权重 | `settings.json` `rag.vectorSimilarityWeight` | 默认 `0.3`，与 SparkiiRAG 默认一致 |

测试连接：`healthz` + `GET /api/v1/datasets`（`page_size=100`，按页翻到空）。列出的库 = 这把 Key 所属账号能看到的全部库。Desktop **不**创建 dataset，也 **不**给智能体勾选范围。

阈值与向量权重本期存盘并传给 retrieve；设置页可以不提供旋钮。

### API Key：只写替换，读回只给布尔值

规则：

| 方向 | 行为 |
| --- | --- |
| Renderer → Main | 仅在用户粘贴了新 Key 时提交明文；空字符串表示不改 |
| Main → Renderer | 只回 `rag.hasApiKey: boolean`，永不回明文、不回后四位、不回掩码假值 |
| 设置页展示 | 已配置：输入框空白，旁注「已配置，留空则保持」；未配置：空白占位「粘贴 API Key」 |
| 保存 | 输入为空 → Keyring 不动；非空 → `set` 替换。不提供「显示已存 Key」 |
| 测连通 / 拉库列表 | 输入为空则 Main 用 Keyring；输入非空则用本次粘贴的值（可先测再存） |
| 禁止 | `getApiKey('sparkiirag')` 读出明文；复制按钮；点击小眼睛揭示已存 Key；把 Key 写进 `settings.json`、日志、审计；大模型「保存」整表覆盖 `rag` |

换 Key 之后可见库集合会变。Main 下次 `listDatasets` 时：已存 `defaultDatasetId` 若不在新列表里，视为未配置，走「默认怎么来」。

### 每个智能体一个默认库

```ts
type AgentKnowledgeBinding = {
  agentId: string
  defaultDatasetId: string
}
```

存在 `settings.json` `rag.bindings[]`。不写进签名 profile。

Profile 只声明要不要知识库、界面能不能选：

```yaml
# knowledge-qa
knowledge:
  enabled: true
  picker: session         # Composer 工具栏从 Key 可见的全部库里选
  backend: sparkiirag    # 未配引擎则失败，禁止回退 BM25

# contract-review
knowledge:
  enabled: true
  picker: hidden          # 只用默认，界面不出现选库
  backend: bm25           # 本期仍走 corpus.json；切 RAG 后改 sparkiirag
```

未 `knowledge.enabled` 的智能体（通用智能体）不出现在默认库表里，也搜不到任何库。

### 怎么用

- **合同审核：** `picker: hidden`，永远用该智能体的默认库。界面不选库。本期检索执行器仍是 BM25。
- **企业知识问答：** `picker: session`。下拉 = 当前 Key 的 `GET /datasets` 全部结果。打开会话时选中默认。换库只影响后续提问。可选一项「全部可见库」：`dataset_ids` 一次传多个。合同审核不提供这一项。
- 可见集合随 Key 变：换账号即换可见库。

### 默认怎么来

1. 设置里为该智能体选默认（下拉来自连通后的库列表）。
2. 未选：第一次检索用当前 Key 下列表第一项，并写回 bindings。
3. 列表为空：提示先在 SparkiiRAG 建库，不调用模型。

### 检索用哪一个库

`knowledge.search` **不接受模型传入的 datasetId**。模型只能传 `query`（以及可选的 `topK`）。Main 读 `rt.profileOf(profileId).profile.manifest.knowledge`。

Main 注入 `dataset_ids`：

- `hidden`：该智能体的 `defaultDatasetId`（或自动回填的第一项）
- `session`：会话当前选中；初始 = 默认；若用户选了「全部可见库」，则传入当前列出的全部 id

**默认库**（设置里的 `defaultDatasetId`，含 hidden）：若空或不在本次列表，视为未配置 → 列表第一项并写回 bindings。  
**会话选择**（Composer 里选的 id）：若不在本次列表，拒绝检索，提示重新选库。

`backend === 'sparkiirag'` 且未配 URL/Key、或列表为空：在 **prompt 发出之前** 失败，提示去「设置 → 知识库」，不调用模型，也不创建新 session。

## 工具合同

```ts
type KnowledgeSearchArgs = {
  query: string
  topK?: number // 默认 6，封顶由 Main 限制
}

type RetrievalResult = {
  chunks: Array<{
    id: string
    content: string
    documentId: string
    documentName: string
    datasetId: string
    similarity: number
    termSimilarity?: number
    vectorSimilarity?: number
    positions?: unknown
  }>
  documents: Array<{
    documentId: string
    documentName: string
    chunkCount: number
  }>
}
```

`SparkiiRagClient.retrieve` 请求体映射：

- `question` ← `query`
- `dataset_ids` ← Main 注入
- `similarity_threshold` ← 设置
- `vector_similarity_weight` ← 设置
- `page_size` ← `topK`（封顶 20）；不要把模型传入的 `datasetId` 写入 body

命中映射：`dataset_id` 可能是 string 或 `string[]`，取第一个非空写成 `datasetId: string`。`doc_aggs` 缺省或 `{}` 时 `documents = []`。回给 Pi 的工具结果应让模型能按 **1-based 序号**对应 `chunks`（提示里写清「第 n 段对应 [n]」）。

打开出处：UI 点 `documentId` → Main `fetchDocument` 写入 `%LOCALAPPDATA%\SparkiiDesktop\data\rag-cache\` → 系统默认程序打开。只读缓存，不经写审批。

## 企业知识问答智能体

- id：`knowledge-qa`，界面名「企业知识问答」
- `surface.type: chat`，**独立 profile**。`apps/desktop/agents/knowledge-qa/surface/index.tsx` 包一层 `StandardChatSurface`，传入插槽；不要默认再导出一份未定制的壳。
- 工具：`knowledge.search`（read）、`knowledge.fetch_document`（read，或由 UI 点出处走 IPC，不经过模型）
- **不注册** `bash` / `edit` / `write` / `knowledge.ingest`
- 无用户技能库（不要 `skillLibrary: user`）
- 系统提示：制度问答；回答前必须 `knowledge.search`；只根据工具返回的 chunks 写；用了第 n 段就在该句末标 `[n]`；没有命中由平台拒答，禁止用通识顶上
- Composer：`picker === 'session'` 时 `toolbarExtra` 为知识库 `<select>`（`data-testid="knowledge-dataset-select"`）。位置：`ui-composer-toolbar-left` **最左侧**（上传按钮之前）。知识问答隐藏工作区按钮与技能菜单。
- 空状态：不要通用那句「也可以在工作区内编程」。改成可问制度、依据检索结果回答。
- 发送：`onBeforeSend`（知识问答传入）里 `await setSessionKnowledge(sessionId ?? ('draft:'+agentId), selection)`，**然后** `promptSession`。`promptSession` 在 `openOrCreateSession` **之后**、`client.send` **之前**把 `draft:${profileId}` 搬到真实 sessionId。`!res?.ok` 要 `reportError` 并清 busy。

通用智能体保持 coding 工作台；不传上述插槽。会话列表按智能体隔离。

必填 profile 文件与现有 loader 一致：`manifest.yaml`、`agent/tools.yaml`、`agent/workflow.yaml`、`agent/prompts/system.md`、`agent/knowledge/corpus.json`（`[]`）、`security/roles.yaml`、`security/approval.yaml`、`ui/pages/home.json`、`ui/theme.yaml` + tokens、`surface/index.tsx`。加完后跑 `node apps/desktop/scripts/generate-surface-bindings.mjs`。

`listAgents` 与 `App.tsx` 必须把 `knowledge` 原样拷到 `ShellAgent` / `AgentDescriptor`。执行检索仍读 `profileOf().profile.manifest.knowledge`。

## 出处：存两行、画一个气泡（对齐 SparkiiRAG 的 message + reference）

SparkiiRAG Web 把助手 `content` 和 `reference` 分开存、在同一个 `MessageItem` 里画。Pi JSONL 不能给已有 assistant 加字段，所以：

**有命中：**

```text
JSONL
  user
  knowledge.search toolCall / toolResult     ← 审计；默认详情档不画成出处气泡
  assistant 正文（流式 message_update，不改 text）
  custom knowledge_turn { refused: false, documents: [{ documentId, documentName, datasetId }] }
```

**画面（一个气泡，key 始终是这条 assistant 的 id，避免重挂打断文字流）：**

```text
┌ 助手气泡 ─────────────────
│  根据《高温作业津贴办法》……[1]
│  ─────────────────────
│  出处  高温作业津贴办法.pdf
└
```

上半先流；`knowledge_turn` 在该条 `message_end` 之后写入，下半可以晚到。下半不到则没有横线和出处。

**同一轮保证（不是往回猜 toolCall）：**

每个 `sessionId` 在 Main 有本轮状态，**新用户 `prompt` 时清空**：

```ts
type KnowledgeTurnState = {
  searchCalled: boolean
  miss: boolean
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>
}
```

- `executeKnowledgeSearch` 成功：`searchCalled = true`；`chunks.length === 0` → `miss = true`；否则 `documents` 按 `documentId` 去重合并本轮所有 search 的 `documents`。
- 有命中的助手 `message_end`：**仅当**该消息可见正文非空（`assistantText(message).trim() !== ''`）。思考块、仅含 toolCall 的 `message_end` **不** append。append 必须在该 handler 里立刻执行，保证与该助手消息相邻。
- 不把 `assistantId` / `toolCallIds` 当查找键。配对规则是时间线顺序：**一条可见助手消息后面紧邻的 `knowledge_turn`（中间不得插入其他 message）属于它。**
- `documents` 必须带 `datasetId`。`doc_aggs` 没有该字段时，从本轮 chunks 按 `documentId` 回填；若 `documents` 为空但 chunks 有命中，从 chunks 去重派生。

**空检索：**

```text
JSONL
  user
  空的 knowledge.search 结果
  custom knowledge_turn { refused: true, text: RAG_REFUSE_TEXT, documents: [] }
```

没有助手正文气泡。画面：普通助手样式的单气泡，仅拒答文案，无横线、无出处。若竞态留下模型助手行，walk 用相邻 refused `knowledge_turn` 替换（实时与历史同一规则）。

### Surface 插槽（平台壳不认识知识库）

`@sparkii/ui` `ChatComposer` 增加 `toolbarExtra?: ReactNode`。插在 `ui-composer-toolbar-left` 最前。Composer **不**接收 datasets、不判断 picker。

`StandardChatSurface` 增加（均可选，默认等于今天的通用聊天）：

```ts
toolbarExtra?: ReactNode
hideWorkspace?: boolean
emptyCopy?: { heading?: string; body?: string }
hideToolNames?: string[]
onBeforeSend?(): Promise<void>
composerSkills?: ComposerSkill[] | null
renderAssistantMessage?(args: {
  entry: Extract<ChatEntry, { kind: 'message'; role: 'assistant' }>
  following: CustomSessionEntry[]
}): ReactNode
renderCustomEntry?(entry: CustomSessionEntry): ReactNode | null
```

默认与今天通用聊天一致。`send` 在 `promptSession` 前 `await onBeforeSend?.()`；`promptSession` 若 `{ ok: false }` 则 `reportError` 并 `setBusy(false)`。`composerSkills={null}` 时 Composer 不加载技能菜单；缺省仍走今天的 `listSkills`。

知识问答 `surface/index.tsx`（由 `agent.knowledge` 驱动，不是 agent id）：

- `toolbarExtra`：仅当 `agent.knowledge?.picker === 'session'` 挂 `KnowledgeDatasetPicker`
- `hideWorkspace`：隐藏 Composer 工作区按钮；技能菜单传 `skills={null}`
- `hideToolNames`：`['knowledge.search', 'knowledge_search']`
- `emptyCopy`：可问制度、依据检索结果
- `renderAssistantMessage`：
  - `following[0]` 为 `knowledge_turn` 且 `refused` → **只画拒答文案**，忽略 `entry.text`（abort 竞态安全网）
  - `following[0]` 为 `knowledge_turn` 且非 `refused` → 两截气泡
  - 否则默认 Markdown 助手气泡
- `renderCustomEntry`：独立的 `knowledge_turn.refused`（前面没有助手）→ 拒答气泡；其它 custom 仍 `null`

`StandardChatSurface` **不** import 选库控件或出处组件。Picker 与折气泡都由知识问答 surface **传入**插槽。

时间线 walk：

1. 把 `kind === 'custom'` 纳入 walk（今天 `isChatEntry` 会丢掉它们）。
2. `shouldShowEntry` **只**用于 message / tool / event。custom **不要**走 `shouldShowEntry`（它会把无 `event` 的 custom 当成 debug 藏掉，拒答-only 会消失）。
3. 助手消息：收集其后连续 custom 为 `following`，调用 `renderAssistantMessage`。这些 following **不再单独画**。
4. 其它 custom：`renderCustomEntry`。
5. 助手 `ChatMessage` 的 `key` 必须是 `entry.id`。
6. `hideToolNames`：已完成（有 result）且详情档不是 debug 时隐藏；运行中仍画。

点文件名：`api.openRagDocument({ datasetId, documentId })`。BM25 `{ id, text, score }` 不走此 UI。

## 拒答与忠实度

**提示词不能保证模型不编。** 一期用 Main 把「没有」做成硬规则，把「有片段时别发挥」做成强约束。

### 固定拒答文案

```ts
export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。'
```

仅 `backend === 'sparkiirag'`。合同审核 BM25 不走这套。

### 能保证的：知识库没有 → 固定说不知道

1. **检索阈值。** `/retrieval` 带 `similarity_threshold`（默认 0.2）。低于阈值的片段不进 `chunks`。
2. **空结果短接（不经过大模型）。** `executeKnowledgeSearch` 成功且 `chunks.length === 0`：
   - 空列表仍回 Pi（审计、可选「未命中」工具卡在 debug 档）。
   - `miss = true`。
   - **先返回** connector_read 结果，再用 `queueMicrotask`（或等价）调度 abort + `append_workflow_entry` `knowledge_turn` `{ refused: true, text: RAG_REFUSE_TEXT, documents: [] }`。不要在 return 前 await abort。
   - **不改写**已有 assistant jsonl。**不在** `ensureProcessPipe` 里丢掉 `message_update` / `message_end`（直播管道必须透明；实时与历史同一套 JSONL）。
   - 若 abort 未赶上、模型已吐字：Surface 若 `following[0]` 为 refused `knowledge_turn`，**只画拒答**，忽略紧邻助手 `text`。没有助手、只有 refused custom 时走 `renderCustomEntry`。
3. **本轮必须先搜：本期不做 Main 强制补搜。** 不使用 `follow_up` / `steer` 把 chunks 当作用户消息。系统提示仍要求先 `knowledge.search`。硬锁只处理「已搜且 chunks 为空」。

### 只能尽量保证的：有片段 → 不超出片段

- 系统提示：只使用工具返回的 `content`；数字、条件、日期必须能在片段里找到；禁止用训练知识补充；用了第 n 段则标 `[n]`。
- UI 始终列出 `knowledge_turn.documents`。用户可以对着原文核对。权威是检索结果，不是气泡措辞，也不是 `[n]` 是否标对。
- 命中很少或相似度很低时，提示词要求先复述片段再下结论，拿不准就说依据不足。

**做不到的：** 无法数学证明每一句都出自 chunk。一期不承诺句句有出处。

## 错误与审计

| 情况 | 行为 |
| --- | --- |
| 未配 URL / Key，或 Key 下列表为空 | **发送前**提示去设置 → 知识库，不调用模型 |
| 默认库未选、或已存默认不在本次列表，且列表非空 | 用列表第一项并写回 bindings |
| 网络/超时 | `CONNECTOR_IO`，检索超时 30s |
| RAG `code !== 0` | 展示服务端 message |
| 引擎可达但 **会话选中的** dataset 不在本次列表 | 拒绝检索，提示重新选库 |

审计：每次检索 `tool.read`，摘要为 query 前 120 字 + 命中文件名；**不把 chunk 全文写入审计**；**不把 API Key 写入审计**。

## 测试

连接器：mock fetch 映射命中、`code !== 0`、超时（已有）。

Desktop 本期还要锁：

- 未配置则 search 返回 DENIED、无出站；`connector_read` 使 Pi 调 search 时 HTTP 只从 Main 出去
- 通用智能体没有 `knowledge.search`；不出现选库下拉；无 `knowledge_turn` 时助手气泡与现在一致
- `picker === 'session'` 出现 Composer 下拉；`picker === 'hidden'` / 无 knowledge 不出现
- 发送前 `setSessionKnowledge` 先于 `promptSession`
- 空 `chunks`：abort + `knowledge_turn.refused`；管道仍转发模型事件；最终气泡是 `RAG_REFUSE_TEXT`（walk 替换），不是模型发挥
- 助手后紧邻 refused `knowledge_turn`：只画拒答，无出处
- 仅 toolCall 的 `message_end` 不 append `knowledge_turn`
- 有命中：助手消息后紧邻 `knowledge_turn`；折进同一气泡；`key` 为 assistant id
- `getApiKey('sparkiirag')` 返回 null；`saveSettings` 不丢掉 `rag`；`knowledge.search` params 无 `datasetId`
- 生产代码无 `'knowledge-qa'` 调用方式分支；无对 `/api/v1/openai/` 的引用
- `parseProfileManifest` 保留 YAML `knowledge`，不会 strip

不在 CI 打真实 WSL。手工：SparkiiRAG 传一份制度 → Desktop 提问 → 同一气泡看到文件名出处。

实现任务拆分见 `docs/superpowers/plans/2026-09-09-sparkii-rag-connector.md`。合同审核仍用 BM25，不在本期切换。

---

已确认口径：方案 2；无 Desktop 入库；新设置分组；独立知识问答；引擎可配置；无智能体范围勾选、只配默认库；Composer 选库；RAG Key 写后不可读回；后端由 `manifest.knowledge.backend` 声明；出处两行合一气泡；空检索 abort；句内标仅提示。连接器 1–6 已编码；知识问答 Surface / 接地 / profile **尚未编码**。
