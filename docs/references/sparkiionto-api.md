# SparkiiOnto 服务契约（Desktop 消费面）

**状态:** 已实测（v1）
**日期:** 2026-09-22
**被测修订:** `YueDJ/SparkiiOnto` `origin/main` = `01cbaa78`
**被测版本:** 产品 `0.6.8`（Python 包名仍为 `semantica`，对外产品名由 `semantica/product_brand.py` 统一为 `SparkiiOnto`）
**验证环境:** WSL2 Ubuntu-26.04 + Python 3.14 + SQLite 开发档，见文末"复现"。

本文只记录 **实测到的事实**，作为 Desktop 侧 spec 的输入；不含设计决策（那是下一份文档）。

---

## 1. 产品形态与边界

SparkiiOnto 是 semantica 的独立产品化版本（`upstream = semantica-agi/semantica`），对外暴露 **一个 FastAPI 服务**（产品 API + Explorer 面合并在一个进程里）。与 Desktop 相关的部分：

| 层 | 路径 | 说明 |
| --- | --- | --- |
| 产品 API | `sparkii_onto/api/native.py` | 前缀 `/api/v1`；登录、`/info`、知识域、作业、图检索、血缘、审计 |
| **Desktop 兼容层** | `sparkii_onto/api/compatibility.py` | 文件名即 `SparkiiDesktop-compatible datasets, retrieval, and source routes`；提供 `/datasets`、`/retrieval`、原文下载 |
| Explorer（upstream 面） | `semantica/explorer/routes/*` | `/api/graph/*`、`/api/sparql`、`/api/decisions`、`/api/temporal`、`/api/analytics`、`/api/enrich/*`、`/api/export|import` 等，在产品模式下由 `product_require_auth` 接管鉴权 |
| 生命周期 | `sparkii_onto/api/lifecycle.py` | 本体草稿/提案/版本（`ontology:*` 动作） |

启动方式（**易踩坑**）：`sparkiionto-server` 指向 **上游** `semantica.server:main`（默认 `:8000`，是库 API，**不含产品路由**）。产品服务用下面任一方式（两者等价，`01cbaa78` 起控制台脚本已存在）：

```bash
sparkiionto-product-server --host 127.0.0.1 --port 9380   # console script
python -m sparkii_onto.api.server --host 127.0.0.1 --port 9380   # 等价写法
```

---

## 2. 认证与授权

### 2.1 凭据形态

| 形态 | 获取方式 | 默认有效期 | 用于 |
| --- | --- | --- | --- |
| 会话 token | `POST /api/v1/auth/session`（用户名+密码，201） | 3600s（`SPARKIIONTO_SESSION_LIFETIME_SECONDS`） | Explorer/控制台、运维脚本 |
| **API token** | `sparkiionto-admin create-token --username <u> --name <n> --scope <action> ...`（明文只显示一次） | **86400s（24h）**（`SPARKIIONTO_TOKEN_LIFETIME_SECONDS`） | Desktop 等服务间集成 |
| legacy operator key | `SEMANTICA_API_KEY` 环境变量，作为 `X-API-Key` 头 | 不过期（轮换靠改环境变量） | 兼容 upstream Explorer；产品模式下非测试环境要求该值非默认且 ≥16 字符 |

实测（`api_tokens` 表）：`created_at = 2026-09-22 08:06:31` → `expires_at = 2026-09-23 08:06:31`，即 **24 小时后失效**。服务端只存 `token_digest` 与 `lookup_prefix`，不可找回。

### 2.2 请求头

`Authorization: Bearer <session|api token>`；或 `X-API-Key: <SEMANTICA_API_KEY>`（仅 legacy 操作员）。产品模式下 `SEMANTICA_ALLOW_ANONYMOUS=true` 会被**拒绝启动**。

### 2.3 授权（deny-by-default）

角色：`SparkiiOperator`（全部 19 个动作）· `CustomerReader`（3：graph/domain/job 读）· `CustomerOntologist`（8：+ 写图、管域、建/取消作业、本体草稿）· `CustomerAdmin`（16：+ 审计、用户、token、备份、本体评审/发布/回滚、`settings:manage`）。`schema:manage` 与 `backup:restore` 仅 `SparkiiOperator` 拥有。

API token 额外按 **scope** 逐个动作校验（`principal.credential_kind == "api_token"` 时）。
Desktop 读面所需：

| 端点 | 所需动作（scope） |
| --- | --- |
| `GET /api/v1/info` | `domain:read` |
| `GET /api/v1/datasets` | `domain:read` |
| `POST /api/v1/retrieval` | `graph:read` |
| `GET /api/v1/datasets/{dataset}/documents/{document}` | `graph:read` |

### 2.4 错误形状（实测）

`/api/v1/*` 的业务错误统一 `{"code":<int>,"message":"<str>"}`；但 **Starlette 路由级错误不经产品 handler**：例如 `GET /api/v1/retrieval` 返回 `405 {"detail":"Method Not Allowed"}`。Explorer 面（`/api/graph/*` 等）也仍是 `{"detail":...}`。**Desktop 侧只按 HTTP 状态码分类，不依赖响应体形状**（plan Task 1 已如此规定）。

```jsonc
// 无凭据
401 {"code":401,"message":"authentication required"}
// 凭据错误或已过期
401 {"code":401,"message":"invalid or expired credential"}
// 凭据有效但 scope/角色不足
403 {"code":403,"message":"action denied"}
// 请求体多字段/类型错（Pydantic extra="forbid"）
422 {"code":422,"message":"invalid request"}
```

**注意**：凭据失效与权限不足是 **401 与 403 的区别**，Desktop 必须分开提示。

### 2.5 用户与角色管理的现状（实测）

| 能力 | 现状 |
| --- | --- |
| 数据模型 | 有：`users`(id/username/password_hash/active/created_at)、`role_assignments`(user_id/role)、`api_tokens`(scopes/expires_at/revoked_at/lookup_prefix/token_digest) |
| 角色矩阵 | 有：4 角色 × **19** 动作（`01cbaa78` 的 `rbac.py` 实测计数），deny-by-default；API token 还叠加 scope 校验 |
| 建第一个用户 | 有：`sparkiionto-admin bootstrap-operator`（固定赋 `SparkiiOperator`） |
| **建第二个用户 / 分配角色** | **没有入口**：`repositories.assign_role()` 存在，但除单测外**无任何调用者**；CLI 与 HTTP 都没有 `create-user` / `assign-role` / `/users` |
| 用户列表 / 停用 / 改密 | **没有入口**（`users.active` 字段存在，只能改库） |
| `USER_MANAGE` / `TOKEN_MANAGE` | 动作已定义并授予 `CustomerAdmin`，但**没有任何端点使用**（声明了、未实现） |
| token 签发 / 吊销 | 有：`create-token --scope ...`、`revoke-token --token-id`；**无 `--expires-in`**，寿命只能整体配 `SPARKIIONTO_TOKEN_LIFETIME_SECONDS` |
| token 可观测性 | 无 `last_used_at`；`GET /api/v1/auth/me` 只回 `user_id/username/roles/credential_kind`，**不回 scope 与到期时间** |
| 审计归属 | `actor = 所属用户名`，**不含 token 名**；同一个人签发的多个 token 在审计里无法区分 |

实测库内容：`users` 只有 1 行 `sparkiiadmin`，`role_assignments` 只有 1 行 `SparkiiOperator`。即**当前产品形态是"单用户 + 单角色 + 多 token(带 scope)"**：最小权限目前靠 **token scope** 实现（实测：只带 `job:read` 的 token 访问 `/datasets`、`/retrieval` 均 403），而不是靠独立用户或专用角色。

**Desktop 侧的处理约定**：Desktop 把 token 当**不透明凭据**——不解析、不假设角色/scope 名称、不本地建模权限；只要求"能通过 `healthz → info → datasets` 的只读探测"。权限控制（服务账号、专用只读角色、scope 收紧、到期可见性）由 Onto 侧后续补齐，Desktop 只需区分 401 与 403 两种失败文案。

---

## 3. Desktop 消费面（本次实测的 5 个端点）

### 3.1 健康检查（不需要凭据）

```
GET /api/v1/system/healthz
200 {"status":"ok","product":"SparkiiOnto","version":"0.6.8"}
```

不健康时返回 **503** 且 `status:"nok"`（会检查 DB、图文件可写、源目录可写）。这是探活入口，**先于**凭据校验。

### 3.2 能力协商

```
GET /api/v1/info                     # 需要 domain:read
200 {
  "product": "SparkiiOnto",
  "version": "0.6.8",
  "api_version": "v1",
  "deployment_profile": "single-instance",
  "retrieval": { "backend": "sql-lexical", "semantic_embeddings": false },
  "capabilities": {
    "datasets": true, "document_fetch": true,
    "ontology_lifecycle": true, "graph": true, "provenance": true,
    "audit": true, "events": true,
    "legacy_ontology": false, "legacy_provenance": false
  }
}
```

`retrieval.backend` / `semantic_embeddings` 是**后端自述**：当前实现是 `SqlLexicalRetrievalBackend`（`name="sql-lexical"`、`semantic_embeddings=False`）。Desktop 应据此调整行为，而不是假定有向量检索。

### 3.3 知识域列表（= RAGFlow 的 dataset）

```
GET /api/v1/datasets?page=1&page_size=100     # 需要 domain:read；page_size ≤ 100
200 {"code":0,"data":[{"id":"92a86306-…-a836","name":"水泥工艺知识域"}]}
```

同一份数据的另一种视图是 `GET /api/v1/onto/domains`（返回 `id/name/description/created_at`）。**没有删除知识域的端点**。

### 3.4 检索

```
POST /api/v1/retrieval              # 需要 graph:read
Content-Type: application/json
{
  "question": "高温津贴按日计发",
  "dataset_ids": ["92a86306-…-a836"],
  "similarity_threshold": 0.2,
  "vector_similarity_weight": 0.3,
  "page_size": 6
}
```

五个字段**全部必填**（`extra="forbid"`，多一个字段就 422）；`page_size ≤ 20`。

响应：

```jsonc
200 {"code":0,"data":{
  "chunks":[{
    "id":"bba4fe4b-…", "content":"四、高温津贴按日计发，露天作业人员每人每工作日 15 元。",
    "document_id":"91461c7a-…", "document_keyword":"水泥窑协同处置工艺说明.md",
    "dataset_id":"92a86306-…",
    "similarity":1.0, "term_similarity":1.0, "vector_similarity":0.0
  }],
  "doc_aggs":[{"doc_id":"91461c7a-…","doc_name":"水泥窑协同处置工艺说明.md","count":1}]
}}
```

实测出的语义（**这是本契约最关键的部分**）：

| 行为 | 实测结果 | 含义 |
| --- | --- | --- |
| 查询是片段子串 | `similarity = 1.0` | 打分 = 1.0 直接命中 |
| 否则按词元重叠 | `score = |查询词元 ∩ 片段词元| / |查询词元|` | 词元正则 `[\w\u3400-\u9fff]+`：**中文不切词**，整段连续汉字算一个词元 |
| 自然语言中文问句 | `chunks: []`（threshold 0.2） | 例：问「窑尾温度偏低该如何处理」→ 0 命中 |
| `similarity_threshold = 0.0` | 返回全部片段，`similarity = 0.0` | 阈值是 `score >= threshold`，0 会"全放行" |
| `vector_similarity_weight` | **必填但被忽略**：`RetrievalRequest` 无默认值 + `extra="forbid"` ⇒ 漏传 **422**；服务端代码注释 `Lexical scoring intentionally ignores vectors.`，`vector_similarity` 恒为 `0.0`，`term_similarity == similarity` | 必须传一个常量（如 `0.3`），**不能省略**——省略会把请求形状 bug 伪装成"服务不支持" |
| 不存在的 `dataset_ids` | `200` + `chunks: []` | **不报错、不是 404**，与"没命中"无法区分 |
| 等分片段的顺序 | 按 `(-score, document_id, chunk_id)` 排序 | 兼容载荷**不含 ordinal**，等分时顺序对调用方无意义 |

### 3.5 打开原文

```
GET /api/v1/datasets/{dataset_id}/documents/{document_id}   # 需要 graph:read
200
  content-type: text/markdown; charset=utf-8
  content-disposition: attachment; filename*=utf-8''%E6%B0%B4%E6%B3%A5…md
  content-length: 428
  <原始字节，与入库内容逐字节一致（diff 通过）>
```

---

## 4. 入库与作业（Desktop 本期不用，但影响"能不能检索到"）

```
POST /api/v1/onto/domains/{domain_id}/documents      # graph:write；JSON 或 multipart
202 {"document":{"id":"…","ingest_state":"pending","checksum":"sha256:…","size_bytes":428,…},
     "job_id":"3b139f3d-…"}

POST /api/v1/onto/jobs/{job_id}/process              # job:process（仅 SparkiiOperator）
200 {"id":"…","state":"completed","version":2,"failure_reason":null}

GET  /api/v1/onto/jobs/{job_id}                      # job:read
200 {"kind":"ingest_document","state":"completed","attempts":1,"max_attempts":1,…}
```

实测行为：

- 上传即 202，文档 `ingest_state: pending`；**未处理完的文档检索不到**。
- 作业由 worker 处理：产品进程内置 worker，或 `sparkiionto-product-worker`；`POST /onto/jobs/{id}/process` 是操作员手动触发路径。
- 切块方式（`ingestion.py`）：**先按空行分段**（`re.split(r"\n\s*\n")`），每段再按 2000 字符硬切；chunk id = `uuid5(document_id, "chunk:{ordinal}")`。本次播种语料每行之间都有空行，所以表现为"5 行 → 5 个 chunk"——这是语料特征，不是通用规则。
- 原文存放于 `SPARKIIONTO_SOURCE_DIR`，路径为 `<domain_id>/<document_id>/<文件名>`。
- 列表里 `created_at` 有时不带 `Z`（上传响应带 `Z`，列表不带）——解析时容错。

---

## 5. 与 SparkiiRAG（RAGFlow）的差异对照

| 维度 | SparkiiRAG（RAGFlow 系） | SparkiiOnto（兼容层） |
| --- | --- | --- |
| 选库单位 | dataset | 知识域（`KnowledgeDomain`） |
| 检索 | 混合检索（词 + 向量），`vector_similarity_weight` 有效 | **SQL 词法**，权重无效；中文退化为子串匹配 |
| 能力协商 | 无 | 有 `/api/v1/info`（`retrieval.backend`、`semantic_embeddings`、`capabilities`） |
| 认证 | `Authorization: Bearer <API Key>`（租户级） | Bearer 会话/API token + **scope**；另有 legacy `X-API-Key` |
| 失败封装 | `{code,message}` | `{code,message}`（仅 `/api/v1/*`） |
| 原文下载 | 有 | 有（同形状；额外带 `filename*`） |
| 入库 | 引擎 Web 端 | Desktop 也可上传（本期不用） |
| 健康检查 | `/api/v1/system/healthz` | 同路径、同形状 |
| 产品默认端口 | 9380（内网服务） | 9380（`python -m sparkii_onto.api.server` 默认值） |

**两套接口形状相同是产品侧有意为之**（文件名即 `SparkiiDesktop-compatible`），但**检索质量不同**，这一点必须在 Desktop 侧显式处理。

---

## 6. 本体能力会用的端点（按实测修正）

同进程内已挂载且用同一套凭据。**授权口径两套并存**：

| 面 | 前缀 | 判权方式 |
| --- | --- | --- |
| 产品面 | `/api/v1/*` | **逐端点**声明动作（如 `/api/v1/onto/graph/search` 声明 `graph:read`） |
| Explorer 面 | `/api/*` | **按 HTTP 动词**：GET → `graph:read`；POST/PUT/PATCH/DELETE → `graph:write` |

| 能力 | 端点 |
| --- | --- |
| 产品面图（本轮工具用） | `POST /api/v1/onto/graph/search`、`GET /api/v1/onto/graph/summary`、`GET /api/v1/onto/graph/nodes/{id}` |
| Explorer 图检索/邻域/路径/统计 | `GET /api/graph/node/{id}/neighbors`、`GET /api/graph/path`、`GET /api/graph/stats`、`GET /api/graph/nodes`、`GET /api/graph/edges`、`GET /api/graph/semantic-neighborhood`（`POST /api/graph/search` 按动词判权为写，只读凭据下 403） |
| SPARQL（只读，按动词判权） | `POST /api/sparql` |
| 推理（按动词判权） | `POST /api/reason` |
| 距离矩阵（按动词判权） | `POST /api/graph/distance-matrix` |
| 决策 | `GET /api/decisions`、`GET /api/decisions/{id}`、`/{id}/chain`、`/{id}/precedents`、`/{id}/compliance`、`/causal-distance` |
| 血缘（两处并存） | Explorer 面 `GET /api/provenance?node_id=`、`/api/provenance/report`；**产品面 `GET /api/v1/onto/provenance`（本轮选用）** |
| 审计 | `GET /api/v1/onto/audit`（需 `audit:read`；只读凭据 403） |
| 分析 | `GET /api/analytics`（可选 `metrics`：centrality/community/connectivity）、`GET /api/analytics/validation` |
| 时间 | `GET /api/temporal/bounds`、`GET /api/temporal/snapshot?at=`、`GET /api/temporal/diff`、`GET /api/temporal/patterns`、`GET /api/temporal/distance-history` |
| 词汇 | `GET /api/vocabulary/schemes`、`GET /api/vocabulary/concepts?scheme=`、`GET /api/vocabulary/hierarchy?scheme=` |
| 标注读 / 记忆读 / markdown 读 | `GET /api/annotations`、`GET /api/memories`、`GET /api/markdown/{kind}/{resource_id}`（`kind` ∈ `context-node` / `agent-memory`） |
| 本体生命周期 | `GET /api/v1/onto/domains/{id}/drafts`、`GET /api/v1/onto/drafts/{id}`、`POST /api/v1/onto/drafts/{id}/submit`、`POST /api/v1/onto/drafts/{id}/reject`（`lifecycle.py`，前缀 `/api/v1/onto`；动作为 `ontology:draft|review|publish|rollback`） |
| 事件推送 | `WS /api/v1/onto/events`、`WS /ws/graph-updates`（Origin 白名单，禁止 query 传凭据） |

**血缘两处并存**：Explorer 面 `GET /api/provenance`（`{detail}` 错误封装）与产品面
`GET /api/v1/onto/provenance`（`{code,message}` 封装）同时存在，两者都可读，本轮选用产品面。
Explorer 面判权按 HTTP 动词（GET → `graph:read`），因此 `POST /api/graph/search`、`POST /api/sparql`、
`POST /api/reason`、`POST /api/graph/distance-matrix` 在只读凭据下会被判为写而 403——这是对端
判权口径问题，记录为待办，本端连接器照常实现（见 spec §13 事项 2）。

---

## 7. 部署要点（本地实验环境已按此落地）

| 环境变量 | 用途 | 实测取值 |
| --- | --- | --- |
| `SPARKIIONTO_ENVIRONMENT` | `development|test|production`；production 强制 PostgreSQL 且 `secret_key ≥24` 字符 | `development`（SQLite） |
| `SPARKIIONTO_DATA_DIR` | 数据根目录 | `~/sparkiionto-deploy/data` |
| `SPARKIIONTO_SECRET_KEY` | 会话/令牌签名 | 随机 48B |
| `SEMANTICA_API_KEY` | legacy `X-API-Key` 操作员键（非测试环境必须非默认、≥16 字符） | 随机 48B |
| `SPARKIIONTO_TOKEN_LIFETIME_SECONDS` | API token 默认寿命 | 默认 86400（**Desktop 需要长寿命 token 时必须上调**） |

初始化顺序：`sparkiionto-admin init-schema` → `bootstrap-operator` → `create-token --scope domain:read --scope graph:read` → `python -m sparkii_onto.api.server`。

---

## 8. 复现（本次实测用的脚本）

脚本位于 `C:\Users\YDJ\.codex\visualizations\2026\09\22\01a0c7fa-58ad-75f1-905a-c53f1fe526d0\sparkiionto-wsl\`：

| 脚本 | 作用 |
| --- | --- |
| `check-env.sh` / `inspect-existing.sh` | 只读环境探测（WSL、端口、已有部署） |
| `setup-venv.sh` / `deps-step.sh` | 建 venv（uv，Python 3.14）+ 最小依赖（不含 torch 等 ML 栈） |
| `00-clone-main.sh` | 从 `origin/main` 克隆到 `~/sparkiionto-main` 并重指 editable 安装 |
| `01-deploy.sh` | 生成密钥、初始化库、建操作员、签发 `desktop`(domain:read+graph:read) 与 `narrow`(job:read) 两个 token |
| `02-start-server.sh` | 启动 `python -m sparkii_onto.api.server`（含代理绕过）并等 `healthz` |
| `03-contract-test.sh` | 播种 1 个知识域 + 1 篇文档、处理作业，跑 5 个消费端点 + 4 个鉴权负例，原始响应落盘 |
| `04-token-facts.sh` | 只读查看 token 有效期/角色/分块 |

原始响应证据：`~/sparkiionto-deploy/evidence/`（旧分支旧版本对照在 `evidence-stale-branch/`）。**本文正文里的 id / 时间戳是示例值**（取自更早一次播种），做 fixture 时以 `evidence/` 目录里的实际响应为准（该目录的域 id 是 `d264d494-…`、文档 id 是 `071c7edd-…`）。

`origin/main`(`01cbaa78`) 与旧分支的差异对比：除等分片段的 uuid 排序外，**契约响应逐字段一致**。

---

## 9. 待确认（尚无法从代码/实测确定）

1. 客户内网部署是否 HTTPS（反向代理终结）——决定 Desktop 侧 URL 策略。
2. Desktop 使用的 API token 由谁签发、多久轮换（默认 24h 太短）。
3. 是否有"删除知识域"的运维路径（当前 API 未暴露）。
4. 生产档位是否启用向量/嵌入后端（`semantic_embeddings` 是否变 `true`）。注意：仓库里**没有** `SPARKIIONTO_VECTOR_BACKEND` 这个环境变量；产品检索后端由 `create_product_app(retrieval_backend=…)` 注入（默认 `SqlLexicalRetrievalBackend`），届时 `/info` 的 `retrieval.backend` 与 `semantic_embeddings` 会随之变化。
