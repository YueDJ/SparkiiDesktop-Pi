# SparkiiOnto 知识后端 — 设计 Spec

**状态:** Draft v1（待讨论；尚未编码）
**日期:** 2026-09-22
**Depends on:**
- `docs/references/sparkiionto-api.md`（本轮实测契约，v1）
- `docs/superpowers/specs/2026-09-09-sparkii-rag-connector-design.md`（既有知识管道：方案 2、空检索拒答、出处折气泡）
- `docs/2026-08-22-design.md`（A 类连接器：文档/知识库）
- `DESIGN.md`（设置分组、表面范式）

**Amends:**
- 上一轮废弃实现 `feat/sparkiionto-integration`（本地与远端分支已删除）：其"另一套并行栈 + 不透明出处引用 + 中立句柄 + HTTPS-only"设计**整体不采纳**，理由见 §2。

---

## 1. 背景

客户内网同时存在两个**平级**知识产品，各自 rebrand 自上游：

| 产品 | 上游 | 用途 | Desktop 形态 |
| --- | --- | --- | --- |
| SparkiiRAG | RAGFlow | 制度问答、文档写作；混合检索 | 已在 main：`manifest.knowledge.backend: sparkiirag` |
| SparkiiOnto | semantica | 本体/因果链推导、工艺检测与优化 | 本轮新增能力 |

关键事实（实测，见契约文档）：SparkiiOnto **自己提供了一层面向 Desktop 的兼容 API**（`sparkii_onto/api/compatibility.py`，文件注释为 "SparkiiDesktop-compatible datasets, retrieval, and source routes"），形状与 RAGFlow 的 `datasets` / `retrieval` / 原文下载一致，并额外提供 `/api/v1/info` 能力协商。

因此本轮的正确做法不是"再造一套知识栈"，而是**把这层兼容 API 作为一个新的后端接进既有知识管道**，并把产品差异（配置、凭据、能力、检索质量）显式表达出来。

---

## 2. 为什么不采纳上一版实现

| 上一版做法 | 问题 | 本轮做法 |
| --- | --- | --- |
| `sparkiirag` 与 `sparkiionto` 两套 settings / secret store / probe / IPC / 设置页代码并行 | 约 1700 行新增，其中 ~540 行是全新的重复模块；后续每加一个后端再翻一倍 | **一套代码 + 后端判别**（client 工厂 + 每后端一个配置块） |
| 把知识问答 `knowledge-qa` 的 backend 从 `sparkiirag` 改成 `sparkiionto` | 直接改变已上线智能体的行为与质量（Onto 是词法检索，实测自然语言中文问句 0 命中） | **不动任何现存 manifest**；新能力由后续新智能体消费 |
| 设置页删掉 SparkiiRAG 的地址/Key 输入 | 使 `backend: sparkiirag` 成为"代码支持、UI 无法配置"的半废弃状态（注：该删除只存在于被废弃的分支，`main` 上 RAG 组完好） | **不动 RAG 分组**，并列新增 Onto 分组 |
| `openRagDocument` 改为必须携带 Main 进程内签发的不透明 `connectionRef` | 重启后出处全部打不开（历史与会话内都是），核心功能回退 | 保持 main 行为：dataset + document id + 当前凭据 |
| 非 loopback 强制 HTTPS | 与"内网 HTTP 服务"部署形态冲突，且会让旧 RAG 内网配置无法迁移 | 允许内网 `http://`；是否 TLS 由部署决定 |
| 凭据代际计数 + 中立文档句柄 + 临时目录清理 | 复杂度高、收益依赖未声明的威胁模型；改变了既有出处路径行为 | 不做；只保留"凭据不出 Main"这条既有边界 |
| 只给 `sparkiionto` 加模型服务商保留名 | 同一类凭据出现两种安全等级（`sparkiirag` 仍可被自定义服务商借道取用）；且 `main` 上**根本没有**该机制 | **新增**命名冲突检查，覆盖 `sparkiirag` 与 `sparkiionto`（见 Decision 4） |
| 读配置时对非法 URL 直接抛错 | settings.json 一旦被写坏，设置页与检索链路一起失败 | 读宽容（回落 + 提示），写严格 |

上一版**唯一值得保留的判断**是："Onto 的接口形状与 RAG 相同、可以复用同一条管道"——这条判断是对的，但实现方式（复制整套栈）不对。

---

## 3. Confirmed Decisions

1. **两个产品、一个通道。** 共用的只有"Main 执行、凭据不出 Main、审计、出处管道"这一层；**配置、凭据、探活、能力、以及将来的本体工具面都是各自独立的**。
2. **后端判别继续写在 profile。** `manifest.knowledge.backend: 'bm25' | 'sparkiirag' | 'sparkiionto'`，不写死智能体 id。本轮**不新增、不修改任何智能体的 manifest 或 surface**。
3. **能力协商驱动行为。** Desktop 在探活时读 `/api/v1/info`：
   - `retrieval.semantic_embeddings === false` → 该后端是词法检索：设置页**不展示**向量权重旋钮、Desktop 不把它用于任何计算；但请求体里**仍必须照契约传 `vector_similarity_weight`**（该字段在 Onto 上"必填但被服务端忽略"，漏传会 422）；
   - `capabilities.document_fetch === false` → 关闭"打开出处"。**本轮只读取/展示该能力，不实现该防御分支**：Onto 当前恒为 `true`（`native.py`），为它写一条永不触发的分支属 YAGNI；等真出现该能力的后端时再加。
   - `product`/`api_version`/`deployment_profile` 不匹配 → 视为不支持（防止把别的服务当成本产品）。
4. **凭据独立命名空间 + 新增命名冲突检查。** Keyring `knowledge:<backend>`（如 `knowledge:sparkiionto`），与模型服务商的 `apiKey:<provider>` 完全隔离；`getApiKey()` 对 `sparkiirag`/`sparkiionto` 都返回 `null`。**现状（`main`）没有任何"保留名"机制**（`provider-catalog.ts` 只有内置白名单）：自定义模型服务商可以取 id `sparkiirag`，使 `rt.keyFor('sparkiirag')` 读到模型 Key。本轮**新增**该检查——在自定义服务商保存路径上拒绝 `sparkiirag` 与 `sparkiionto`——并补测试。
5. **凭据形态：API token（Bearer）。** 由 Onto 侧 `sparkiionto-admin create-token` 签发，scope 至少 `domain:read` + `graph:read`。**默认 24h 过期** → 作为部署前提写进文档（需要长寿命则上调 `SPARKIIONTO_TOKEN_LIFETIME_SECONDS`），Desktop 侧 401 与 403 必须给出不同提示。身份与轮换策略见 Decision 13。
6. **URL 策略：不强制 HTTPS，但明文不静默。** 连接器同时支持 `http`/`https`，默认 `http://127.0.0.1:9380`；当地址是**非 loopback 的 http** 时，设置页给出明确警告（凭据与内容可能被同网段嗅探/篡改，建议放在终止 TLS 的反向代理后），但**不阻止保存**。生产推荐形态 = Onto 绑 loopback + 反向代理终止 TLS；"导入自签 CA"列为第二期可选项。
7. **失败语义沿用三码，但 422 必须可区分。** 401 → `CONNECTOR_DENIED`（凭据失效/过期）、403 → `CONNECTOR_DENIED`（权限不足）、404/405 → `CONNECTOR_UNSUPPORTED`（端点或方法不存在）、**422 → `CONNECTOR_UNSUPPORTED` 且文案独立**（"请求参数不被该服务接受"——这是请求形状错误的诊断信号，不能与"服务不支持"混同）、5xx/超时/网络 → `CONNECTOR_IO`、`/info` 协商不匹配 → `CONNECTOR_UNSUPPORTED`。错误文案不携带 token 与内部路径。
8. **空检索与"域消失"沿用既有规则**：`chunks.length === 0` → 走既有"空检索拒答"（不经大模型）；"会话所选域不在 `GET /datasets` 列表中" → `SESSION_DATASET_GONE`（与 RAG 同一判定，**不靠错误文案匹配**，因为实测未知域返回的是 200+空结果）。
9. **打开原文保持 main 行为，并显式记录后端归属。** 仍是 `dataset_id + document_id + 当前凭据`，Main 落缓存后交系统打开，不引入不透明引用；但因为有第二个后端：`knowledge_turn.documents[]`/`citations[]` **新增可选 `backend`**（缺省 `sparkiirag` ⇒ 历史 JSONL 与 `knowledge-qa` 行为不变），`openRagDocument` 新增可选 `backend`，缓存目录按后端分段（`rag-cache/<backend>/…`）避免跨后端 documentId 撞车。**平台侧写入/路由/缓存分段本轮就位**；而"气泡把 `doc.backend` 透传下去"这一行落在 `apps/desktop/agents/knowledge-qa/surface/index.tsx` 里，属**待批准项**（默认不做）——未批准时 Onto 会话的"点出处打开原文"不可用，交付说明必须写明。
10. **设置页两块并列，各有一份阈值控件**：`知识库（SparkiiRAG）` 在**保持既有结构**（地址 / API Key / 测试连接 / 保存 / 智能体默认库，testid `rag-*` 不变）之外，**新增**阈值控件（`similarityThreshold` + `vectorSimilarityWeight`）——`main` 上这两个值只在 `readRag`/`save` 里读写、**没有 UI**，本轮补上；并列新增 `本体（SparkiiOnto）`（地址、API Token、测试连接、保存、默认域、`similarityThreshold`）。RAG 的既有 DOM 与 testid 不得重排（否则 `settings-knowledge-pane.test.tsx` 会失效）。
11. **配置读取宽容、写入严格**：非法已存 URL 回落默认值 + 设置页提示；保存时才校验。
12. **不引入 MCP。** 三条理由（已核对本 fork）：（a）MCP 是 **stdio** 进程（`semantica_mcp/mcp/server.py`、`semantica/mcp_server/__init__.py` 都是 stdio 循环），图/向量库在**进程内**按 `SEMANTICA_KG_PATH` 加载——**连不到客户内网那台常驻服务**；（b）本 fork（0.6.8）的 MCP 工具面**不含文档检索**（`semantica_mcp/mcp/tools/` 只有 decisions/export/extraction/graph/reasoning，没有 upstream 0.7.0 的 retrieval 模块），所以"用 MCP 做检索"在当前修订上也不成立；（c）MCP 若在 Pi 侧拉起会**绕过 Main 的审批与审计**。本体能力后续仍走 REST（`product_require_auth` 已允许同一 token 访问 `/api/graph/*`、`/api/sparql` 等）。
13. **凭据假设（本轮）：Onto 侧提供一个可轮换的只读 API token，Desktop 把它当"不透明凭据"使用。**
    - **假设**：Onto 会提供一个对该产品**只读**（至少能读知识域与检索）、可轮换的 Bearer token。它怎么被授予、由谁签发、有哪些角色/scope——**Desktop 不做任何假设、不解析、不本地建模**。
    - **边界（硬约束）**：Desktop 侧不得出现角色名、scope 名、用户概念的判断；只做两件事——把 token 放进 Keyring（写后不可读回）、在请求头带 `Authorization: Bearer <token>`。失败只按 HTTP 语义处理：**401 = 凭据无效/过期**，**403 = 该凭据权限不足**（文案不同，指向设置页或联系管理员）。
    - **本轮 Desktop 没有任何写路径**：只调 `healthz`/`info`/`datasets`/`retrieval`/原文下载，全是读接口。因此即使签发的 token 权限过大，Desktop 也不可能产生写副作用。
    - **配置期就暴露权限问题**：设置页"测试连接"按 `healthz → info → datasets` 顺序探测，权限不足会在**配置时**以 403 文案暴露，而不是等第一次提问才失败。
    - **轮换（运维动作，Desktop 无需改动）**：签发新 token → 设置页粘贴并"测试连接"通过 → 吊销旧 token → 查审计确认旧 token 不再出现。
    - **寿命**：按站点策略设 `SPARKIIONTO_TOKEN_LIFETIME_SECONDS`（建议 90 天；PoC 可 365 天）。Desktop 侧若拿不到到期时间，只能在 401 时提示"凭据已失效/过期"。
    - 权限控制（服务账号、专用只读角色、scope 收紧、到期可见性）**由 Onto 侧后续补齐**，不阻塞本轮；清单见 §11。
14. **相似度阈值：两组都暴露，字段按后端区分。** RAG 组：`similarityThreshold` + `vectorSimilarityWeight`（后者对 RAG 有效）；Onto 组：**只** `similarityThreshold`（向量权重对该后端是死参数，服务端忽略，不暴露）。两组都**不 clamp** 用户输入（默认 0.2）；但必须落在 **[0, 1]**：越界时**就地标红提示**（Onto 服务端是 `Field(ge=0.0, le=1.0)`，越界会 422，而 422 的文案是"请求参数不被该服务接受"，容易被误读成服务不支持），仍不静默改写。值 < 0.05 时旁注"几乎不过滤，会把无关片段当命中"。
15. **本轮只做连接器。** 不新增、不修改任何智能体；不做 Composer 选库控件改造（它只对 `picker: session` 的智能体有意义）；新智能体与本体（图/SPARQL/血缘）工具面都放下一期。

---

## 4. Architecture

```text
设置 → 知识库（两块）
  SparkiiRAG : rag.baseUrl      + Keyring(apiKey:sparkiirag)      + bindings
  SparkiiOnto: onto.baseUrl     + Keyring(knowledge:sparkiionto)  + bindings + /info 能力
        │
        ▼
Pi  knowledge.search({query}) / knowledge.fetch_document(datasetId, documentId)
        │  host:'main' → connector_read（无审批）
        ▼
Main  knowledgeBackendFor(profile) → { bm25 | sparkiirag | sparkiionto }
        ├─ bm25      : 既有 corpus
        ├─ sparkiirag: SparkiiRagClient        （main 现状，不改）
        └─ sparkiionto: SparkiiOntoClient      （本轮新增；/info 协商 + 兼容端点）
        │
        ▼
JSONL：user → toolCall/toolResult → assistant text → custom knowledge_turn{refused,documents[{…,backend?}],citations}
Renderer：同一助手气泡（上半正文 / 下半出处）；点出处 → openRagDocument({backend?, datasetId, documentId})
```

### 包边界

| 包 | 职责 | 本轮改动 |
| --- | --- | --- |
| `packages/connectors` | `SparkiiOntoClient`（HTTP + `/info` 协商 + 错误码）。不 import Electron | **新增 `src/sparkiionto/{client,types}.ts`；`client` 自带传输与状态感知错误映射，不继承、不改动 `SparkiiRagClient`**（后者的 `send/requestJson/assertOk` 全是 `private`，且把所有非零 `code` 映射为 `CONNECTOR_DENIED`，无法满足 Onto 的 401/403/404/422 区分）。**复用 `sparkiirag/map.ts` 的 `mapRetrieval`/`mapDatasets`**（Onto 兼容载荷字段与其完全一致），不新增 mapper |
| `apps/desktop` Main | 读设置与 Keyring；选客户端；探活；执行 retrieve/fetch；注入 dataset；空检索拒答；写 `knowledge_turn` | `settings.ts`（onto 配置块）、新增 `knowledge-settings.ts`、`knowledge-probe.ts`、`rag-search.ts`（客户端工厂 + backend 参数 + 出处归属）、`rag-grounding.ts`（documents/citations 加可选 backend）、`rag-open.ts`（缓存分段）、`runtime.ts`（Keyring accessor）、`workflow.ts`（`knowledge.search` 分支）、`ipc.ts`（11 处 `=== 'sparkiirag'` 门）、`provider-catalog.ts`/`saveSettings`（命名冲突检查） |
| `packages/config` | `manifest.knowledge.backend` 枚举加 `sparkiionto` | schema + types **以及 8 处联合类型/行为点**（`preload/api-types.ts`、`packages/ui/patterns/Shell.tsx`、`src/surface/contract.ts`、main 的 `rag-settings.ts`/`rag-search.ts`/`agent-catalog.ts`，以及**行为点** `knowledgeFromManifest`——它现在会把非 `sparkiirag` 一律压成 `bm25`）。完整清单见 plan Task 2 Step 1 |
| Renderer `src/shell` | 设置页两块并列 | `SettingsKnowledgePane.tsx`（**RAG 组保持不动** + 并列新增 Onto 组）、`SettingsView.tsx`（API 类型与装配） |
| Renderer `src/surface` | 出处气泡 | `knowledge-citations.tsx`：类型加**可选** `backend`（additive，无行为变化）。选库控件改造属下一期，本轮不动 |
| `apps/desktop/agents/*` | 智能体 | **无改动**（出处字段透传的那 1 行随下一期智能体落地） |

---

## 5. 契约要点（我们依赖什么）

详见 `docs/references/sparkiionto-api.md`。Desktop 只依赖以下最小面：

| 用途 | 调用 | 关键约束 |
| --- | --- | --- |
| 探活 | `GET /api/v1/system/healthz` | 无需凭据；503 表示不健康 |
| 能力 | `GET /api/v1/info` | 需 `domain:read`；校验 `product/api_version/deployment_profile`；读 `retrieval.semantic_embeddings`、`capabilities.document_fetch` |
| 列域 | `GET /api/v1/datasets?page&page_size≤100` | `{code:0,data:[{id,name}]}`；用于默认域回填与会话域校验 |
| 检索 | `POST /api/v1/retrieval` | **5 个字段全必填**（`extra="forbid"`，漏一个即 422）、`page_size≤20`；`vector_similarity_weight` **必填但被服务端忽略**；阈值语义 `score >= threshold`（0 = 全放行） |
| 原文 | `GET /api/v1/datasets/{d}/documents/{doc}` | 需 `graph:read`；返回原始字节 |
| 出处归属 | 写进 `knowledge_turn.documents[]` 的 `backend` | 缺省 `sparkiirag`；用于点出处时选择后端与缓存分段 |

**平台侧必须处理的五个差异**：

1. **`topK` 语义**：Onto `page_size ≤ 20`，与 RAG 现状一致（既有实现同样封顶 20），沿用统一 clamp。
2. **`vector_similarity_weight` 必填但被忽略**：**必须传一个常量值**（沿用 RAG 默认 `0.3` 或 `0`），**不能省略**——省略会 422，而 422 会被映射成"不支持"，把请求形状 bug 伪装成服务问题。契约测试要断言出站 body 里含该字段。
3. **阈值**：Onto 无默认值（必填），由 Desktop 传（每后端一份）。Desktop **不 clamp** 用户输入，但当值 < 0.05 时在设置页旁注"几乎不过滤"；**0 会全放行**（返回所有片段、分数 0.0），等于把无关文本喂给模型。
4. **等分排序不稳定**：兼容载荷无 `ordinal`，等分片段顺序按 uuid 决定；出处编号只能取"本次响应顺序"，不能跨请求复用。
5. **客户端二次过滤是 no-op**：复用的 `mapRetrieval` 会再按 `similarity < threshold` 过滤一次，而 Onto 已在服务端按同一阈值过滤；对 Onto 这是空操作，**不要"顺手"把两侧阈值改成不同的值**。

---

## 6. 对现存智能体的影响面（硬约束）

要求：**本轮改动不得改变任何现存智能体的行为**。

| 智能体 | 现状 | 本轮是否变化 | 回归测试 |
| --- | --- | --- | --- |
| `contract-review` | `knowledge.backend: bm25` | 不变（不读新代码路径） | 既有 BM25 测试全绿 |
| `knowledge-qa` | `backend: sparkiirag` + `picker: session` | **不变**（manifest 与行为都不动） | 既有 RAG 探测/检索/出处测试全绿 + 新增"配置页仍能配置 SparkiiRAG" |
| `general` | 无 knowledge 工具 | 不变 | 既有测试 |
| `procurement-review` | 无 knowledge | 不变 | 既有测试 |

共享模块的改动都是**增量**：`settings.ts` 加可选块、`manifestSchema`/8 处联合类型加枚举值、`ipc.ts` 加 handler 与后端门、`connectors/index.ts` 加导出、`knowledge-citations.tsx` 加可选字段。三处**需要单测固定**：

| 改动 | 影响面 | 测试 |
| --- | --- | --- |
| **新增**自定义模型服务商命名冲突检查（拒绝 `sparkiirag`/`sparkiionto`） | 只有"自定义服务商恰好叫这两个名字"会受影响；`main` 上本来没有任何检查，属新增保护 | 保存路径拒绝两个 id + 既有自定义服务商不受影响 |
| 8 处 `backend` 联合类型 + `knowledgeFromManifest` 行为点 | 纯类型扩散 + 一行行为（`sparkiionto` 不再被压成 `bm25`） | `contract-review`/`knowledge-qa` 解析结果与 main 逐字段一致 |
| `ipc.ts` 约 12 处 `=== 'sparkiirag'` 门改为按后端取 | `bm25` 与 `sparkiirag` 分支必须逐字节保持 | 既有 `ipc.test.ts`/`rag-search.test.ts`/`knowledge-isolation.test.ts` 全绿 |

---

## 7. Non-goals（本轮）

- 本体/图/SPARQL/血缘/决策链工具面（下一期独立 spec；契约文档 §6 已备好端点清单）。
- 新智能体的接入与 Composer 选库控件改造（下一期随智能体一起做）。
- **对话级端到端**（Onto 会话里的选库、出处气泡、点出处打开原文）：依赖"选库控件按后端取列表"+ 出处 `backend` 透传那一行，随智能体一期落地；本轮只交付平台能力与平台级验证。
- Desktop 上传/入库/触发解析（Onto 侧支持，本轮不接）。
- 自动把 SparkiiRAG 配置迁移到 SparkiiOnto（两个产品并存，无需迁移）。
- 不透明出处引用、凭据代际、中立文档句柄（上一版方案，不采纳）。
- 向量检索/重排（Onto 当前后端为词法；`semantic_embeddings=false` 时不做补偿）。
- 让任何现存的问答类智能体改用 Onto。

---

## 8. 风险与对策

| 风险 | 证据 | 对策 |
| --- | --- | --- |
| Onto 词法检索不适合自然语言问答 | 实测：中文自然语言问句在阈值 0.2 下 0 命中；`semantic_embeddings=false` | 新智能体定位"本体/工艺"；不把 Onto 设为 QA 默认；设置页显式标注"词法检索"；提示用户 Onto 适合引用式/短查询 |
| API token 24h 过期 | `api_tokens.expires_at = created + 24h` | 部署前提文档化；Desktop 401 提示"凭据已失效/过期"并指向设置页；后续可评估 Desktop 侧重新签发流程 |
| 兼容层参数"必填但空转" | `vector_similarity_weight` 被服务端忽略，但 `extra="forbid"` 使其同为**必填**；`similarity_threshold=0` 会全放行 | 出站 body **始终**带 `vector_similarity_weight`（常量），契约测试断言其存在；阈值不 clamp，但值 < 0.05 时设置页警告 |
| 请求形状错误被误报为"服务不支持" | 漏传必填字段 → 422 → 映射成 `CONNECTOR_UNSUPPORTED` | 422 使用独立文案（"请求参数不被该服务接受"），并在契约测试里与 404 区分断言 |
| 知识域不可删除 | 无 DELETE 端点 | "域消失"只通过 `/datasets` 差异判定；提示用户去 Onto 控制台处理 |
| 出处编号跨轮不稳定 | 等分排序按 uuid、无 ordinal | 出处编号取本次响应顺序；UI 不承诺稳定编号 |
| `/info` 变更导致误判 | 产品版本演进 | 把 `product/api_version/deployment_profile` 校验写进单元测试；不匹配时给出可诊断文案 |

---

## 9. 验收标准

1. **契约测试**（离线，用实测响应做 fixture）：`/info` 协商、`datasets`、`retrieval`（命中/未命中/未知域/threshold 0）、原文下载、401/403/404/422/5xx/超时映射各 1 例。
2. **回归**：桌面仓库全量单测通过；`contract-review` 与 `knowledge-qa` 的 manifest 解析结果与 main 逐字段一致。
3. **设置页**：两块分组并列——RAG 组保持既有结构与 testid，**新增阈值控件**（阈值 + 向量权重）；Onto 组支持"测试连接"并展示 `/info` 协商出的检索后端与能力，暴露阈值（范围 [0,1]，越界就地提示，**无**向量权重）；非 loopback 明文地址给出警告但不阻止保存。
4. **平台级端到端（本地实测，本轮口径）**：WSL 内 Onto 服务（`origin/main`）+ Desktop 设置页测试连接显示 `sql-lexical`/无语义嵌入/可打开原文；再用脚本或测试直接跑 Main 执行链路（`runMainKnowledgeSearch` + `fetchAndCacheDocument`，不进 `agents/**`）验证命中映射、空命中、原文字节一致。
   **对话级端到端（选库控件、气泡、点出处）本轮不做**：main 上的选库链路只认 RAG（`KnowledgeDatasetPicker` 调 `api.listRagDatasets`、`knowledge-qa` surface 读 `settings.rag.bindings`），换成 Onto 后端后发送会被 `请选择知识库` 拦住；这部分与选库控件改造一起进入智能体一期。
5. **不影响现存智能体**：在本轮分支上跑 `contract-review` 与 `knowledge-qa` 的既有测试，无行为差异。

---

## 10. 待确认

1. 新智能体的定位与命名（本体/工艺分析？），以及是否需要"选域"控件。
2. 客户内网的 Onto 具体部署形态（是否走反向代理/TLS），以及 Desktop 是否需要"打开控制台"入口。

已定（不再讨论）：

- Desktop 的凭据身份与轮换：本轮假设 Onto 提供只读可轮换 token，Desktop 当不透明凭据用（Decision 13）；权限控制归 Onto 侧后续（§11）。
- 相似度阈值：在设置页暴露，按后端区分（Decision 14）。
- 本轮范围：只做连接器，不做新智能体与选库控件改造（Decision 15）。

---

## 11. Onto 侧后续工作（**不阻塞本轮**，按需推进）

本轮按 Decision 13 的假设施工：**Onto 提供一个只读可轮换 token，Desktop 当不透明凭据用**。因此下表全部**不是本轮的前置条件**；它们是把"权限控制"这件事真正做实所需要的工作，放在 Onto 侧后续排期。Desktop 侧的设计已经为它们留好位置（只做展示、不改存储结构）。

| 优先级 | 需求 | 规模估计 | 理由 |
| --- | --- | --- | --- |
| P0 | `sparkiionto-admin create-user --username --role` + `assign-role`（复用已有 `repositories.assign_role()`） | ~30 行 + 测试 | 现在**没有**建第二个用户的入口，专用服务账号无法建立 |
| P0 | `create-token --expires-in <days>` | ~10 行 | 目前只能改全局 `SPARKIIONTO_TOKEN_LIFETIME_SECONDS`，多客户端无法差异化 |
| P1 | 新增只读角色 `SparkiiIntegration`（动作集 = `domain:read` + `graph:read`） | ~10 行 | 比借用 `CustomerReader` 语义更清晰；也避免将来 CustomerReader 扩权时连带放大 Desktop 权限 |
| P1 | `GET /api/v1/auth/me` 返回当前凭据的 `scopes` + `expires_at`（或新增 token introspection） | ~20 行 | Desktop 想在凭据到期前 7 天提示，否则只能在 401 后告知失效 |
| P2 | `api_tokens.last_used_at` | ~15 行 + 迁移 | 轮换时判断旧 token 是否还在被使用 |
| P2 | 把向量后端接进 `RetrievalBackend` 协议 | 较大 | 现在产品检索恒为 `sql-lexical`（中文自然语言问句 0 命中）；若要 Onto 承担语义/问答检索需要它 |
| P2 | 审计 actor 带上 token 名 | ~10 行 | 同一个人签发的多个 token 目前不可区分 |
