# SparkiiOnto 本体能力工具面 — 设计 Spec

**状态:** Draft v1（待评审）
**日期:** 2026-09-22
**被测修订:** `YueDJ/SparkiiOnto` `origin/main` = `01cbaa78`，产品 `0.6.8`（WSL 本地服务实测）
**Depends on:**
- `docs/references/sparkiionto-api.md`（消费面实测契约，v1）
- `docs/superpowers/specs/2026-09-22-sparkiionto-connector-design.md`（既有知识管道与后端判别，本轮沿用其全部纪律）
- `docs/2026-08-22-design.md`（A 类连接器：文档 / 知识库）
- `docs/roadmap/2026-09-22-agent-roadmap.md`（阶段 0.1 / 0.2 的来源）

**Amends:** 无。本轮是**增量**：不改任何现存智能体、不改既有知识管道的行为。

---

## 1. 背景与目标

上一轮把 SparkiiOnto 作为**第二个知识后端**接进了既有知识管道——但只用了它给桌面端准备的那层**兼容检索面**（探活、能力协商、列知识域、词法检索、打开原文）。本体的真正价值不在检索，而在**图**：节点、关系、路径、决策链、血缘。

**目标：** 把本体产品的**只读能力面**接通为桌面端可用的智能体工具，使智能体能够沿关系与因果链推理，并让每条结论都能回溯到它的来源。

**非目标（一句话）：** 本轮不做写路径、不做本体编辑器、不做消费型智能体。理由见 §3 D1、D10。

---

## 2. 实测事实（本轮，`01cbaa78` / `0.6.8`）

### 2.1 能力面：81 个端点

运行中的服务 `/openapi.json` 实测共 **81 条路径**（下表按路径逐条归类，合计 81）。上一版契约文档 §6 的清单**不全**：缺产品面的 `/api/v1/onto/graph/*` 三个端点、缺 `decision_chain` 用到的 `/compliance`、缺词汇与记忆族，且把血缘只写成 Explorer 面的 `GET /api/provenance`（产品面另有 `GET /api/v1/onto/provenance`，实测两者并存，产品面为本轮选用）。

| 归类 | 路径数 | 本轮处理 |
| --- | --- | --- |
| 检索与知识域（上一轮已接） | 5 | 已完成 |
| 产品面图 / 血缘 / 审计 | 5 | 图 3 与血缘 1 纳入工具；审计非目标 |
| 知识域 / 文档 / 作业 | 8 | 只读部分已接；作业面非目标 |
| 本体生命周期（草稿 / 提案 / 发布 / 回滚） | 10 | 非目标 |
| 构建（construction） | 2 | 只接只读自检（§7） |
| LLM 连接管理 | 5 | 非目标 |
| Explorer 图 | 12 | 收敛为工具（§5） |
| 决策 | 6 | 收敛为工具（§5） |
| 时间 / 分析 / 词汇 | 11 | 本轮不入工具（可后续） |
| 富化 / 导入导出 / 标注 / 记忆 / markdown | 11 | 非目标 |
| 认证与其它 | 6 | 非目标 |

**本轮工具面用到 15 个端点，收敛为 11 个工具**（§5 表逐行相加可核对）；其余只读能力族进入连接器层（D3，含至少 1 例契约测试），写路径与运维面按 D1 处理。

工具 → 端点映射（15 条，供核对）：

| 工具 | 端点数 | 端点 |
| --- | --- | --- |
| `ontology.search_nodes` | 1 | `POST /api/v1/onto/graph/search` |
| `ontology.search_documents` | 1 | `POST /api/v1/retrieval` |
| `ontology.node` | 2 | `GET /api/v1/onto/graph/nodes/{id}`、`GET /api/graph/node/{id}/neighbors` |
| `ontology.path` | 1 | `GET /api/graph/path` |
| `ontology.decisions` | 1 | `GET /api/decisions` |
| `ontology.decision_chain` | 3 | `GET /api/decisions/{id}/chain`、`/{id}/precedents`、`/{id}/compliance` |
| `ontology.provenance` | 1 | `GET /api/v1/onto/provenance` |
| `ontology.graph_summary` | 2 | `GET /api/v1/onto/graph/summary`、`GET /api/graph/stats` |
| `ontology.distance_matrix` | 1 | `POST /api/graph/distance-matrix` |
| `ontology.reason` | 1 | `POST /api/reason` |
| `ontology.query` | 1 | `POST /api/sparql` |

§2.1 表里标注"Explorer 图 12 / 决策 6"的端点中，未进入上表的其余部分（`/api/graph/search`、`/api/graph/node`、`/api/graph/nodes`、`/api/graph/edges`、`/api/graph/node/{id}/path`、两处 semantic-neighborhood、`/api/decisions/{id}`、`/api/decisions/causal-distance`）归两端：能被产品面或现有工具等价覆盖的（如 `/api/graph/search` 由产品面覆盖）不重复暴露；其余与词汇、时间、分析、记忆、标注读、markdown 读一起进入**连接器层**（D3）。

### 2.2 权限模型：按**动词**映射与按**端点**声明并存

本体服务的 19 个动作里，桌面端读面需要 4 个：`domain:read`、`graph:read`、`job:read`、`audit:read`。实测的判定方式是**两套并存**：

| 面 | 前缀 | 判定方式 |
| --- | --- | --- |
| 产品面 | `/api/v1/*` | **逐端点**声明动作（如 `/api/v1/onto/graph/search` 声明 `graph:read`） |
| Explorer 面 | `/api/*` | **按 HTTP 动词**：GET → `graph:read`；POST/PUT/PATCH/DELETE → `graph:write` |

**这条差异直接决定本轮能接什么。** 实测（当前凭据 scope = `domain:read` + `graph:read`）：

| 端点 | 结果 |
| --- | --- |
| `GET /api/v1/info`、`/api/v1/datasets`、`/api/v1/retrieval` | 200 ✅ |
| `GET /api/v1/onto/domains` | 200 ✅ |
| `GET /api/v1/onto/graph/summary` | 200 ✅ |
| `GET /api/v1/onto/graph/nodes/{id}` | 200 ✅ |
| `POST /api/v1/onto/graph/search` | 200 ✅（产品面，声明 `graph:read`） |
| `GET /api/v1/onto/provenance` | 200 ✅ |
| `GET /api/v1/onto/construction/capabilities`、`/sources` | 200 ✅ |
| `GET /api/graph/stats`、`/api/graph/nodes`、`/api/graph/edges` | 200 ✅ |
| `GET /api/graph/node/{id}/neighbors` | 200 ✅（返回 `relationship` / `weight` / `hop`） |
| `GET /api/decisions`、`/api/analytics`、`/api/temporal/bounds` | 200 ✅ |
| `POST /api/graph/search` | **403** ❌（POST 被判为写） |
| `POST /api/sparql`、`POST /api/reason`、`POST /api/graph/distance-matrix` | **403** ❌（同上） |
| `GET /api/v1/onto/jobs` | **403** ❌（需 `job:read`） |

上表的两套动作口径需要分清：**本文列出的 4 个动作是"读面可能用到"的全集**（`job:read` 用于作业面、`audit:read` 用于审计导出）；**本轮的 11 个工具只用到 `domain:read` 与 `graph:read`**，交付凭据保持这两个，不升级。连接器层里的审计族、作业族因此在本轮凭据下**不可用**，只做离线映射契约测试（§11.1），生产可用性移交 §13。

### 2.3 数据现状：图里几乎没有本体内容

实测 `node_count = 6`、`edge_count = 5`，节点类型只有 `document`（1）与 `document_chunk`（5），边只有 `contains`（5）——即文档入库产生的血缘图。`GET /api/decisions` 返回 `[]`；`GET /api/vocabulary/schemes` 返回 `[]`；`GET /api/temporal/bounds` 返回 `{min: null, max: null}`；构建能力返回 `{"model_extraction": false}`（未配置 LLM 连接，自动抽取不可用）。

**工具面接通 ≠ 因果推理可用。** 前者是代码，后者是图谱内容工程（见 §10）。这是本轮交付说明必须写明的边界。

### 2.4 已发现的实现不一致：路径端点读的是内存图

`GET /api/graph/node/{id}/path` 与 `GET /api/graph/path` 走 `session.build_graph_dict`（**内存图会话**），而 `neighbors` / `stats` / `nodes` / `edges` / 产品面的 `nodes/{id}` 走**持久化存储**。实测症状：同一个 `node_id` 在邻域接口返回 200，在路径接口报 `404 {"detail":"... Source node ... not found"}`（两个方向都失败）。

这不是我们的接线问题，是该修订上两个图来源会不一致。**它是对端缺陷，记录为移交项（§13），不作为裁剪本端工具面的理由**（D15）。`ontology.path` 照常交付。

---

## 3. Confirmed Decisions

1. **只接只读能力面。** 本轮不接任何写路径（文档入库、作业、知识域管理、本体草稿/提案/发布/回滚、富化、导入导出、标注、记忆、LLM 连接管理），也不接运维面（用户、令牌、备份、schema）。桌面端凭据保持只读，**不申请 `graph:write`**。
   理由：写路径的每一件事本质是"在桌面端做本体编辑器"，收益与风险要单独评估；而只读面已经足以支撑"沿因果链推理"这一产品目标。

2. **对端的缺口不裁剪本端的连接器能力。** 本轮交付**完整的只读连接器能力面**：本体产品所有的只读能力都在连接器里实现，不因为对端当前缺一个权限映射、缺一段持久化、或缺一份图谱内容而被砍掉。对端的缺陷与缺口一律记录为**移交项**（§13），由对端排期修复；本端照常实现、照常交付。
   受影响的具体端点（`graph/search`、`distance-matrix`、`sparql`、`reason`）在**连接器层照常实现**；它们在当前凭据下可能返回 403（§8），文案必须可诊断，并在对端修好按语义判权后自动恢复可用。

3. **工具按语义切分，不按端点切分；但工具层与连接器层分开。**
   - **工具层（模型可见）11 个**（§5）：每个单一职责、参数稳定、返回形状统一。逐端点暴露会让模型在近义工具间做选择，既占上下文又降低准确率。
   - **连接器层（平台代码可用，模型不可见）**：其余只读能力族（分析、时间、词汇、审计、标注读、记忆、markdown 读）同样实现为类型化方法并配契约测试，供后续功能使用，但不进模型的工具清单。
   - 两层共用同一客户端、同一凭据、同一 `/info` 协商。

4. **工具命名进入独立命名空间 `ontology.*`，不使用 `knowledge.*_onto` 之类的后端后缀。**
   理由三条：（a）`knowledge.search` 与本体图查询是**两种不同的能力**（文档片段检索 vs 图对象查询），不是同一能力的两个实现，命名必须体现能力差异而不是实现差异；（b）后端对模型不可见是既有硬约束（D6），把 `onto` 写进工具名等于把后端泄进模型可见面，将来换实现这个名字就说谎；（c）模型侧的函数名会被规范化（`[^a-zA-Z0-9_-]` → `_`），`ontology.search_nodes` 对模型呈现为 `ontology_search_nodes`，与 `knowledge_search` 在词形上完全可分。

5. **优先产品面，Explorer 面按白名单补充。** 能走 `/api/v1/onto/*` 的一律走产品面（逐端点声明权限、随版本演进更稳定）；只有产品面没有等价物时才用 Explorer 的 GET 端点，且限定在 §5 列出的白名单内。

6. **路由分层锁死：后端由配置决定，工具由模型选择。**
   - **后端**（这个工具背后连哪套管道）：由平台按智能体配置确定性解析，模型不可见、不可选、不可影响；
   - **工具**（这次该用哪种能力）：模型唯一的自由度，依据工具描述选择；
   - **知识域**：`picker: hidden` 时用该智能体默认绑定，`picker: session` 时由用户在会话中选择。
   三者不得互相越界。

7. **不做静默跨后端回退。** `knowledge.search` 不会在空结果时自动改问本体；本体工具也不会在空结果时自动改问文档检索。需要"一次问两边"时，用一个**显式**的合并工具并标注每条命中的来源后端——本轮不做。
   理由：静默回退会让"这次为什么答得好/差"无法解释，出处与审计无法标注来源，并且会绕过既有的"空检索拒答"硬规则。

8. **图与检索的空结果语义必须显式可辨。** 工具返回必须让模型能区分"图里没有这类节点"与"服务异常"；`ontology.graph_summary` 提供图规模自检，供模型在声称因果结论之前确认有没有数据可推理。

9. **工具在 Main 执行（`host: 'main'`），凭据不出 Main。** 与既有 `knowledge.search` / `document.read` 同一模式；Pi 子进程不得直接访问本体服务、不得读取凭据。

10. **本轮不改任何现存智能体。** 工具面交付后，由后续的消费型智能体在自己的 `tools.yaml` / `capabilities.ts` 里显式声明 `ontology.*`。本轮只交付平台能力与平台级验证（与上一轮同一口径）。

11. **两套错误封装必须分别处理。** 产品面 `/api/v1/*` 是 `{code, message}`；Explorer 面是 `{"detail": ...}`（含 404 的 not found 与 405 的方法错误）。401（凭据失效）与 403（权限不足）在文案上必须区分，且文案不得携带 token。

12. **不引入 MCP。** 沿用上一轮结论：本体侧 MCP 是 stdio 进程且工具面不含检索，若在 Pi 侧拉起还会绕过 Main 的审批与审计。本体能力继续走 REST。

13. **本体的文档检索移出 `knowledge.search`，归入本体工具家族（`ontology.search_documents`）。**
    两套服务承载的是**不同内容**（RAG 侧是制度 / 法规 / 规程等文档集合；本体侧是工艺知识域，域内既有文档片段也有图），检索质量也不同（RAG 为混合检索，本体侧当前为词法检索）。把两者塞进同一个 `knowledge.search`、靠配置在背后二选一，会把一个**内容与质量都不同的来源差异**藏进实现里，并且因为后端是单槽，同一个智能体永远无法同时使用两边。
    因此：`knowledge.search` 回归它本来的含义——**文档 / 知识库检索**（本地语料 `bm25` 与 `sparkiirag` 两个实现，二者是可互换的文档集合）；本体的文档检索与图检索统一由 `ontology.*` 承担，凭据、域选择、能力协商与图工具共用。
    这样模型看到的是"查文档"与"查工艺知识域（文档 + 图）"两件真实不同的事，而不是同一个工具名的两种隐藏行为。

14. **D13 的拆分是纯平台侧改动，不改任何现存智能体。`manifest.knowledge.backend` 的 `sparkiionto` 枚举值彻底移除，不留已废弃值。**
    实测：现存 4 个智能体**没有任何一个**使用 `sparkiionto` 后端（`contract-review` 与 `procurement-review` 为 `bm25`，`knowledge-qa` 为 `sparkiirag`）。因此撤掉"`knowledge.search` 路由到本体"只是平台侧的路由与配置收敛——包括 `manifest.knowledge.backend` 枚举**删除** `sparkiionto` 值（回落为 `bm25 | sparkiirag`）、检索链路的本体分支收敛——**智能体文件一行不改**。
    **不要用"判定点数量"描述改动范围**（上一轮遗留的"11/13 处"与实际代码不符：今天 `ipc.ts` 里判定用的 `=== 'sparkiirag'` 只有 1 处，另有约 10 行提到本体但其中多数属于必须保留的探活/原文/接地资产）。改动范围以实现计划里的"判定点 → 保留/删除 → 受影响测试"逐行表为准。
    保留一个"能配但不生效"的废弃值只会制造陷阱：配了它、搜不到东西，而没有任何地方会报错。删除会让写错配置在加载期就失败。
    **移除边界（实施时不得越界）：** 只删 `manifest.knowledge.backend` 这一个枚举值（6 处联合类型 + `knowledgeFromManifest` 行为点）。**保留** `sparkiionto` 在其余域中的全部标识：设置分组与凭据命名空间（`knowledge:sparkiionto`）、探活与能力协商、出处与原文下载（`rag-grounding.ts` / `rag-open.ts` / `knowledge-citations.tsx` 的 `backend` 字段与缓存分段）、`KnowledgeBackendId` 类型。它们服务的是"打开原文"这条被明确保留的资产（§7）。

15. **对端待办单独成节（§13），按对端排期，不阻塞本端交付。**
    本端只负责"把能力对上"；对端的缺陷与缺口——路径端点的图来源不一致、只读端点按动词判权、图谱内容为空、token 运维项、检索后端为词法——一律记录并移交，**本端不为它们设计绕行方案，也不因此减少工具**。这条是对 D2 的展开：判断标准是"这是不是本端连接器该覆盖的能力"，而不是"对端现在能不能跑通"。

16. **`ontology.query`（只读查询）接上，定位为高级工具，仅在智能体显式声明时可见。**
    理由：它提供另外 10 个工具表达不了的能力——**聚合与分组**（按类型/域统计）、**按属性过滤**（现有图接口只有 `type` / `search` / 分页，没有属性谓词）、**跨锚点合取与任意投影**（"同时关联 A 与 B 的节点"、只返回符合条件的子图）。这些在工艺诊断这类领域很难在第一天全部枚举完，查询是覆盖长尾的手段。
    **`ontology.reason` 只做纯推理，不写图。** 服务端的 `applyToGraph` 参数（可让推理结果落到图上）**不暴露给工具**，工具不传该参数（服务端默认 `false`）；并在 §13 增加"确认 `/api/reason` 含 `applyToGraph` 时的写语义"这一对端确认项，避免只读工具带出写副作用（D1）。
    但它是通用入口，能查到什么无法预先约束。因此：
    - **不默认给任何智能体**：不在平台层注入，只有智能体在自己的 `agent/tools.yaml` / `capabilities.ts` 里显式声明时才出现在工具清单里（复用既有声明机制，不新增开关）。
    - **护栏三条**：单独的更短超时（默认 10s，区别于其余工具的 30s）；响应体上限，超出即截断并置 `truncated: true`；审计记录**查询全文**（§8 的"不记全文"在此工具上单独豁免）。
    - **描述约束**：必须写明"这是高级查询入口，优先使用专用工具"，并写明"没有结果不等于图谱里没有数据"（与 D8 一致）。
    - **演进原则**：当某个查询变成高频，就把它固化成专用工具。查询语言是发现长尾的手段，不是终态；这条原则同时防止它退化为绕过工具设计的后门。
    **与路线图的差异说明：** 路线图阶段 0.1 的非目标是"SPARQL 全量暴露与写图"。本条不与之冲突——D16 只接**只读查询**、且默认不注入任何智能体（仅显式声明可见），比"全量暴露"严格得多；写图与图写入工具仍是本轮与 0.1 的共同非目标。
    工具名 `knowledge.search` 保持不变；只新增 `ontology.*`。因此不存在"重命名工具导致所有声明它的智能体都要改"的问题（那才是会牵动智能体的改动，本轮不做）。
    上一轮为接入本体而建立的资产**全部保留**：Onto 设置分组、独立凭据、探活、`/info` 能力协商、原文下载、出处来源字段。变化的只是"谁用它"——从 `knowledge.search` 改为本体工具。

---

## 4. 架构与包边界

```text
智能体（Pi）
  ontology.search_nodes / ontology.search_documents / ontology.node / ontology.path
  ontology.decisions / ontology.decision_chain / ontology.provenance / ontology.graph_summary
  ontology.distance_matrix / ontology.reason / ontology.query
        │  host:'main' → connector_read（无审批，sideEffect: read）
        ▼
Main  SparkiiOntoClient（扩展：图方法）
        │  同一 baseUrl 校验 / 同一凭据 / 同一 /info 能力协商
        ├─ 产品面  /api/v1/onto/graph/*、/api/v1/onto/provenance、/api/v1/retrieval
        └─ Explorer /api/graph/node/{id}/neighbors、/api/graph/path、/api/decisions/*
        ▼
JSONL toolResult → 模型继续推理 → 结论写入回答 / 报告
```

| 包 | 职责 | 本轮改动 |
| --- | --- | --- |
| `packages/connectors` | 图客户端与映射纯逻辑；不 import Electron。**扩展现有 `SparkiiOntoClient`，不新建并行栈** | `src/sparkiionto/graph.ts`（图方法 + Explorer 错误封装映射）、`types.ts`（图类型）、`index.ts`（导出） |
| `apps/desktop` Main | 工具定义与执行：`ontology.*` 注册、白名单放行、审计摘要 | `connector-registry.ts`、`ipc.ts`（`handleConnectorRead` 白名单）、`workflow.ts`（`allTools` 映射） |
| `packages/agent-host` | 工具定义转换（已有通用机制） | `tool-registry.ts` 的 `CONNECTOR_TOOLS` 纳入本体连接器 |
| `apps/desktop/src` | 设置页展示图谱自检（§7） | `SettingsKnowledgePane.tsx`（Onto 组内追加只读一行） |
| `apps/desktop/agents/**` | 智能体 | **不改**（D10） |

**必须同时改到的接线点共五处（漏一处就是静默失败）：** ① `connector-registry.ts` 的连接器列表；② `packages/agent-host/src/tool-registry.ts` 的 `CONNECTOR_TOOLS`；③ `apps/desktop/electron/main/workflow.ts` 的 `allTools`；④ **同文件 `runTool` 的 main-host 特判**（漏掉会让流程型智能体的 `ontology.*` 落到 stub handler）；⑤ `apps/desktop/electron/main/ipc.ts` 的 `handleConnectorRead` 白名单（须插在 `knowledge.search` 分支之前）。上一轮 `document.read` 就是"只改 `host` 不改白名单 → 聊天立刻 `unhandled`"。

---

接线点共 **五处**，必须同批落地：`connector-registry.ts` 的连接器列表、`packages/agent-host/src/tool-registry.ts` 的 `CONNECTOR_TOOLS`、`apps/desktop/electron/main/workflow.ts` 的 `allTools`、**同文件 `runTool` 的 main-host 特判**（漏掉会让流程型智能体的 `ontology.*` 落到 stub handler）、`apps/desktop/electron/main/ipc.ts` 的 `handleConnectorRead` 白名单（须插在 `knowledge.search` 分支之前）。

## 5. 工具面契约

11 个工具，全部 `sideEffect: 'read'`、`host: 'main'`。参数对模型用 **camelCase**，客户端映射到接口的 snake_case。

| 工具 | 给模型的语义 | 入参 | 底层端点 |
| --- | --- | --- | --- |
| `ontology.search_nodes` | 在工艺图谱里按关键词查找节点（设备、参数、工序、事件） | `query`（必填）、`limit`（可选，默认 20） | `POST /api/v1/onto/graph/search`（产品面当前只支持 `query` + `limit`，见 §13 事项 6） |
| `ontology.search_documents` | 在指定的工艺知识域里检索文档片段（工艺规程、说明、记录） | `query`（必填）、`domainId`（可选，缺省用该智能体绑定的默认域）、`limit`（可选，≤20） | `POST /api/v1/retrieval`（本体兼容检索面） |
| `ontology.node` | 取一个节点的详情，以及它的邻域（有哪些关联节点、什么关系） | `nodeId`（必填）、`depth`（可选，默认 1） | `GET /api/v1/onto/graph/nodes/{id}` + `GET /api/graph/node/{id}/neighbors?depth=` |
| `ontology.path` | 取两个节点之间的关系路径（中间经过哪些节点、多少跳） | `source`、`target`（必填）、`algorithm`（可选 `bfs`/`dijkstra`）、`directed`（可选） | `GET /api/graph/path?source=&target=&algorithm=&directed=` |
| `ontology.decisions` | 列出决策记录（可按类别过滤） | `category`（可选）、`limit`（可选） | `GET /api/decisions?category=&limit=` |
| `ontology.decision_chain` | 取某条决策的因果链、先例与合规结论 | `decisionId`（必填）、`limit`（可选，先例条数） | `GET /api/decisions/{id}/chain` + `/precedents` + `/compliance` |
| `ontology.provenance` | 取本体血缘：某条结论或某份文档的依据来源 | `domainId`（可选）、`documentId`（可选） | `GET /api/v1/onto/provenance?domain_id=&document_id=` |
| `ontology.graph_summary` | 自检图谱规模（有多少节点、什么类型、有没有可推理的数据） | 无 | `GET /api/v1/onto/graph/summary` + `GET /api/graph/stats` |
| `ontology.distance_matrix` | 给一组节点，返回两两之间的距离（用于比较多个可疑原因谁离异常点更近） | `nodeIds`（必填，数组）、`metric`（可选 `hops`/`weighted`/`semantic`） | `POST /api/graph/distance-matrix` |
| `ontology.reason` | 把事实与规则交给本体做逻辑推理，得到推出的结论（前向 / 反向） | `facts`、`rules`（必填）、`mode`（可选 `forward`/`backward`）；**不暴露 `applyToGraph`**（D16） | `POST /api/reason` |
| `ontology.query` | 对图谱执行只读查询（**高级工具**，由智能体显式声明后才可见；见 D16） | `query`（必填，查询语句） | `POST /api/sparql` |

后 3 个工具的端点属于 §2.2 里"按动词判权"的一类：连接器照常实现（D2），当前凭据下可能返回 403；对端按语义判权或补产品面等价端点后即自动可用（§13 移交项 2）。

`ontology.query` 另有三条本端护栏与一条对端诉求（D16、§13 事项 7）：本端用更短超时、响应体上限（超出截断并置 `truncated`）、审计记查询全文；对端需在服务端提供查询超时与行数上限。

### 5.1 工具描述（模型可见）的写法约束

描述必须让模型分清"该查文档还是该查图谱"，禁止出现实现细节：

- 允许：工艺图谱、节点、关系、邻域、路径、决策链、血缘、依据来源、跳数。
- 禁止：SparkiiOnto、本体产品名、SQL、词法检索、接口名、端点路径、`graph:read`。
- `knowledge.search` 的描述保持"在知识库中检索相关条款片段"不变；它与 `ontology.search_documents` 的区别必须写在**内容域**上（知识库 / 制度法规文档 vs 工艺知识域），不写在后端名上。

### 5.2 返回形状

所有工具统一返回：

```ts
type OntologyToolResult = {
  ok: boolean;
  data?: unknown;              // 收敛后的业务形状：nodes / documents / edges / path / decisions / provenance / summary / inference / rows
  truncated?: boolean;         // 命中被 limit 截断
  empty?: boolean;             // 查询成功但没有结果（与 error 区分）
  error?: { code: string; message: string };
};
```

节点一律裁剪为 `{ id, type, label?, content?, properties? }`；边为 `{ source, target, type, weight }`。**不返回**服务端原始信封、不返回内部路径、不返回 token。

实施期落定的取值（回填）：`QUERY_MAX_BYTES = 256 * 1024`；`TOOL_BUDGET_MS = { 'ontology.query': 10_000, default: 30_000 }`；
`limit` 上限只在 `ontology.search_documents`（20），其余工具的 `limit` 默认 20、服务端各自另有上限。

### 5.3 命名与唯一性

- 命名空间固定 `ontology.`；动词在后的下划线命名。
- 模型侧看到的函数名是规范化后的形式（`.` → `_`），因此**规范化后必须全局唯一**；实施时必须有一条测试锁定"连接器全部工具名在规范化后无碰撞"。

---

## 6. 客户端与能力协商

- 复用 `SparkiiOntoClient` 的 baseUrl 校验、凭据、超时与 `/info` 协商（不新建并行栈）。
- `ontology.search_documents` 走**已接通**的本体兼容检索面（`POST /api/v1/retrieval`）；该实现从 `knowledge.search` 的调用链上摘除，改由本体工具调用，客户端与端点本身不变。
- 图方法的前置条件：`/info` 的 `capabilities.graph === true`；不满足返回 `CONNECTOR_UNSUPPORTED`。`/info` 协商结果缓存一次。
- Explorer 面错误封装（`{"detail": ...}`）与产品面（`{code, message}`）在客户端内部分开处理，对上层统一为 `{code, message}`。
- 超时沿用 30s；单次工具调用内部若串行多个端点，总预算不超过 30s，超时即失败（不部分成功）。

---

## 7. 设置与凭据

- **凭据不变**：仍为 `domain:read` + `graph:read`，无需新增 scope（§2.2 实测）。
- 设置页 Onto 组的"默认知识域"绑定对象由"`knowledge.search` 的默认数据集"改为"本体工具的默认域"（供 `ontology.search_documents` 使用）；RAG 组的"智能体默认库"保持原义不变。两组绑定互不覆盖的既有约束保留。
- 设置页 Onto 组在既有能力协商展示旁边，**追加一行只读自检**：图谱节点数与边数，并在无数据时给出"图谱暂无数据"的提示。目的是让"接线没问题但图里没内容"与"接线坏了"可分辨。
- 自检失败不阻断保存，只显示状态。

---

## 8. 失败语义与审计

| 情况 | 行为 |
| --- | --- |
| 未配置地址或凭据 | 沿用既有未配置文案，指向设置页 |
| 401 | 凭据失效/过期，文案指向设置页 |
| 403 | 权限不足，文案提示联系管理员（与 401 必须不同） |
| 404（路径/邻域无结果） | **不是错误**：返回 `empty: true`，不抛失败 |
| 404/405（端点不存在或方法不对） | `CONNECTOR_UNSUPPORTED`，文案独立（区别于"无结果"） |
| 422 | `CONNECTOR_UNSUPPORTED`，文案独立（请求参数不被该服务接受） |
| 5xx / 超时 / 网络 | `CONNECTOR_IO` |
| `/info` 能力协商不匹配或缺 `graph` | `CONNECTOR_UNSUPPORTED` |
| 图里没有数据 | `empty: true` + `ontology.graph_summary` 可自检；**禁止**让模型据此编造结论 |
| 403（只读凭据 + 动词判权的端点） | `CONNECTOR_DENIED`，文案可诊断：说明该能力需要服务端按语义授权或补充等价端点，并指向设置页与管理员（与 401 必须不同） |

审计：按工具名记录调用与结果规模（节点数 / 路径跳数 / 命中条数），**不记** token、不记服务端原始信封、不记超出必要的正文。
**唯一豁免：`ontology.query` 记录查询全文**（D16）——通用查询入口若不留原文，事后无法解释"这条结论是从哪次查询来的"。

---

## 9. Non-goals（本轮明确不做）

1. 写路径：文档入库、作业（建 / 取消 / 处理）、知识域管理、本体草稿 / 提案 / 提交 / 发布 / 回滚。
2. 运维与管理面：LLM 连接管理、用户与令牌、备份、schema、词汇导入、富化、导入导出、标注写、记忆写、markdown 写。
   （只读的分析、时间、词汇、审计、标注读、记忆、markdown 读**在连接器层实现**，见 D3；审计因需 `audit:read` 且在连接器层已覆盖，本轮不暴露为模型工具。）
3. 图谱内容建设本身（建模、抽取、导入）——这是内容工程，移交 §13 事项 3。
4. 消费型智能体及其 `manifest` / `surface`；Composer 选库控件改造（`KnowledgeDatasetPicker` 按后端取列表）——本轮不做，因为本轮没有消费方，改了无法端到端验证；随消费型智能体一期落地。
5. 跨后端的自动或合并检索（D7）。D13 之后这条从"我们刻意不做"升级为"结构上不存在"：文档检索与工艺知识域检索是两个工具、两套内容。
6. 图写入、图可视化界面、与绘图或报表的集成。

---

## 10. 风险与应对

| 风险 | 证据 | 应对 |
| --- | --- | --- |
| **图里没有本体数据** | 实测 6 节点 5 边，全是文档分块 | 工具面归工具面；`ontology.graph_summary` 自检 + 设置页展示；交付说明写明"因果结论需图谱内容就绪" |
| **路径端点读内存图，与持久化存储不一致（对端缺陷）** | 同一 `node_id` 邻域 200、路径 404（双向） | 移交 §13 事项 1，由对端统一图来源。**本端不裁剪工具、不做绕行**；`ontology.path` 照常交付，修复前可能返回 `empty` |
| **4 个只读端点按动词判权（对端缺陷）** | 只读凭据下 `graph/search`、`sparql`、`reason`、`distance-matrix` 均 403 | 移交 §13 事项 2。本端照常实现工具，403 时给出可诊断文案 |
| 检索质量：本体侧当前为词法检索 | `/info` 报 `sql-lexical`、`semantic_embeddings: false`；中文自然语言长问句 0 命中 | 工具描述引导短查询与引用式查询；不把本体工具当作问答检索的替代 |
| 模型把"图里没有"当成"没有异常" | 空结果与失败在语义上易混 | `empty` 与 `error` 显式分离（§5.2、§8），并在工具描述里写明"没有结果不等于没有风险" |
| 工具名规范化后碰撞 | `pi-runtime-tools.ts` 会把非 `[a-zA-Z0-9_-]` 字符替换为 `_` | 唯一性测试（§5.3） |
| 接线漏改导致静默失败 | 上一轮 `document.read` 的教训 | §4 的五处接线清单 + 隔离测试（静态扫描 + 运行时分发/审计） |
| **撤掉 `knowledge.search` → 本体路由会碰到上一轮交付面** | 该路由是上一轮"第二个知识后端"的产物，涉及枚举值、客户端工厂分支与散落的判定点 | 实测现存智能体无一使用该后端，故不动智能体；改动范围以实现计划的"判定点 → 保留/删除 → 受影响测试"逐行表为准（**不要用判定点数量描述范围**，上一轮遗留的计数与代码不符）；平台侧收敛后，既有 BM25 与 SparkiiRAG 路径必须逐字节不变，由既有测试全绿守住 |

---

## 11. 验收标准

1. **契约测试（离线 fixture）**：11 个工具各自的成功、空结果、404 无结果、401、403（含"只读凭据被动词判权挡下"这一例）、422、5xx 映射各至少 1 例；Explorer 面与产品面两套错误封装分别覆盖；连接器层的其余只读能力族（分析 / 时间 / 词汇 / 审计 / 标注读 / 记忆 / markdown 读）各有至少 1 例契约测试。
2. **命名与唯一性**：连接器全部工具名规范化后唯一；`ontology.*` 与 `knowledge.*` 不冲突。
3. **隔离**：生产代码无 `agentId === …` 特判；Pi 侧无凭据、不 fetch 本体服务；`ontology.*` 全部 `host: 'main'`；未在白名单内的工具名不得被静默执行。
4. **平台级端到端（真实服务）**：用脚本或测试直接跑 Main 执行链路（不经智能体），对本地本体服务完成知识域内文档检索、节点搜索命中、节点详情 + 邻域、决策列表（空）、血缘、图规模自检；并断言空结果返回 `empty` 而不是 `error`。**受对端缺陷影响的 4 个端点（`path`、`distance_matrix`、`reason`、`query`）在真实服务上的验证，以"能跑通就不失败、被对端挡下时给出可诊断错误"为口径**，不因对端未修复而判本轮不通过。
5. **明确不验收**：对话级端到端（选库、气泡、出处）留给消费型智能体一期；因果推理结论质量取决于图谱内容，不在本轮验收范围。
6. **回归**：既有知识管道（BM25 / SparkiiRAG）行为与测试全部不变；本体检索改由 `ontology.search_documents` 承担后，其契约测试与原兼容面一致；全量单测不得新增失败。

---

## 12. 结论与交付说明

**工具数量维持 11 个。** `ontology.decisions` 与 `ontology.decision_chain` 不合并：前者是
决策**列表**（可按类别过滤），后者是某一条决策的**单条追溯**（因果链 + 先例 + 合规），语义粒度不同，
拆开才能让模型区分"列记录"与"追一条"。

**交付说明（已知边界）：**

1. 图谱内容为空：实测 6 节点 5 边，全为文档分块；因果结论需图谱内容就绪后才可依赖。
2. `ontology.path` / `ontology.distance_matrix` / `ontology.reason` / `ontology.query`
   在对端修复前会返回 `empty` 或 403（§13 事项 1 / 2）。
3. 本体文档检索改由 `ontology.search_documents` 承担，`knowledge.search` 不再连本体（D13）。

---

## 13. 移交本体侧的待办（记录，不阻塞本轮）

**归属澄清（不要把本端的事推给对端）：** 事项 3（图谱内容）在本端路线图里是**阶段 1 的业务侧前置**——由我方与工艺专家共同推进，负责人、范围与验收方式属本端待决事项，不整体记成对端待办；对端在这件事上的职责是提供建模 / 抽取 / 导入的手段。事项 5（词法检索）应表述为"由部署档位注入向量后端（或对端实现）"，属部署与集成选择。
**事项 7 的确认范围包含 `/api/reason`**：需确认其 `applyToGraph` 的写语义（本端工具不传该参数，D16），以及 `/api/sparql` 的服务端超时与行数上限。

| # | 事项 | 实测证据 | 对端需要做什么 | 对本端的影响 |
| --- | --- | --- | --- | --- |
| 1 | 路径端点与邻域/统计读取的图来源不一致 | 同一 `node_id`：邻域 200、路径 404（双向） | 让路径与邻域/统计读同一持久化来源 | `ontology.path` 修复前可能返回 `empty`；本端照常交付、不做绕行 |
| 2 | 只读端点按 HTTP 动词判权 | 只读凭据下 `POST /api/graph/search`、`POST /api/sparql`、`POST /api/reason`、`POST /api/graph/distance-matrix` 均 403 | 按语义判权，或补产品面等价端点 | `ontology.distance_matrix` / `ontology.reason` / `ontology.query` 修复前返回可诊断的 403 |
| 3 | 图谱内容为空 | 6 节点 5 边（全为文档分块）；决策列表空；构建 `model_extraction: false` | **本端内容工程**（业务侧与工艺专家共同建模，属阶段 1 前置）；对端只需提供建模 / 抽取 / 导入手段 | 工具可用但推不出工艺结论；本端以 `ontology.graph_summary` 与设置页把这件事显性化 |
| 4 | token 运维项（沿用上一轮清单） | 默认 24h 寿命、无 `--expires-in`、无 `last_used_at`、`/auth/me` 不回 scope 与到期 | 按站点策略支持长寿命 token 与到期可见性 | 部署期影响；本端只在 401 后提示失效 |
| 5 | 检索后端为词法检索 | `/info` 报 `sql-lexical`、`semantic_embeddings: false`；中文自然语言长问句 0 命中 | 由**部署档位**注入向量后端（或对端实现），属部署与集成选择 | 影响 `ontology.search_documents` 的召回质量；本端不做补偿 |
| 6 | 产品面图搜索的参数弱于 Explorer 面 | 产品面 `POST /api/v1/onto/graph/search` 只有 `query` + `limit`；Explorer 的 `POST /api/graph/search` 才有 `filters` / `anchor_node` / `max_hops` / `min_semantic_similarity` / `rank_by`，但被动词判权挡住（§13 事项 2） | 产品面补齐等价参数，或按语义判权放开 Explorer 搜索 | `ontology.search_nodes` 暂时只能"关键词 + 条数"；按类型 / 域 / 锚点过滤只能在客户端做 |
| 7 | 查询端点缺少服务端保护 | `POST /api/sparql` 当前无已知的超时与行数上限约束（实测仅能确认权限行为） | 服务端提供查询超时与行数上限；并确认查询为只读语义 | 本端只能做客户端护栏（更短超时、响应体上限、截断标记）；超时与行数的最终保障在对端 |
