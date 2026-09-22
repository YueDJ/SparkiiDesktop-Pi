# SparkiiOnto 知识后端 接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SparkiiOnto 作为 Desktop 的第二个远端知识后端接进既有知识管道：一套代码 + 后端判别，不动任何现存智能体，为后续新智能体（本体/工艺）留出能力位。

**Architecture:** 复用既有"方案 2"：Pi 发 `knowledge.search` → `connector_read` → Main 选客户端执行 → 结果回 Pi → 出处写 `knowledge_turn`。新增 `SparkiiOntoClient`（`/api/v1/info` 协商 + 兼容端点），平台侧只加"后端维度"这一层参数，不新建并行栈。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron IPC、SparkiiOnto HTTP（`Authorization: Bearer <API token>`，`{code,message}` 封装）。

**Spec:** `docs/superpowers/specs/2026-09-22-sparkiionto-connector-design.md`
**Contract:** `docs/references/sparkiionto-api.md`（实测 v1）

## 前置：本地联调环境（已完成，供本计划复用）

| 项 | 值 |
| --- | --- |
| Onto 代码修订 | `YueDJ/SparkiiOnto` `origin/main` = `01cbaa78`，克隆在 WSL `~/sparkiionto-main` |
| venv | WSL `~/sparkiionto-venv`（uv + Python 3.14；**不含 torch 等 ML 栈**） |
| 运行数据 | WSL `~/sparkiionto-deploy/data`（SQLite + graph.json + sources） |
| 服务地址 | `http://127.0.0.1:9380`（`python -m sparkii_onto.api.server`） |
| 凭据 | `~/sparkiionto-deploy/token-desktop`（scope `domain:read`,`graph:read`）；`token-narrow`（`job:read`，负例用） |
| 凭据假设 | **本轮按"Onto 提供一个只读可轮换 token"施工**，Desktop 只当不透明凭据用（见 spec Decision 13）。现状：只有 1 个用户 `sparkiiadmin`(`SparkiiOperator`)，最小权限靠 token scope；服务账号/角色/scope 收紧由 Onto 侧后续补（spec §11） |
| 脚本 | `…\sparkiionto-wsl\{00..04}-*.sh`（建/启/播种/取证） |
| 证据 | `~/sparkiionto-deploy/evidence/` |
| 启动前提 | WSL 内 curl 必须 `--noproxy '*'`；产品服务用 `sparkiionto-product-server` 或 `python -m sparkii_onto.api.server`（`sparkiionto-server` 是上游库 API，端口 8000，**不含产品路由**） |
| 本机命令 | **不要用 `pnpm <cmd>`**（会触发隐式重装并失败 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。统一用 `node node_modules/vitest/vitest.mjs run …` 与 `node node_modules/typescript/bin/tsc …`；下文中所有 `pnpm vitest run …` 都按此替换 |

## Global Constraints

- **不改任何现存智能体的 manifest 或 surface**：`contract-review`(bm25)、`knowledge-qa`(sparkiirag)、`general`、`procurement-review` 行为与配置保持不变。（唯一例外候选是 Task 5 Step 4 里那个**待你批准**的 1 行透传，默认不做。）
- 后端判别只读 `rt.profileOf(id).profile.manifest.knowledge.backend`；生产代码**禁止**以 agent id 分支。
- Pi 子进程不得 `fetch` 知识服务、不得读取任何知识凭据；知识工具保持 `host: 'main'`。
- `knowledge.search` 的模型参数只有 `query` 与可选 `topK`；出现 `datasetId` 必须忽略或拒绝。
- 凭据命名空间：`knowledge:sparkiionto`（**不与**模型服务商的 `apiKey:*` 混用）；`getApiKey` 对 `sparkiirag`/`sparkiionto` 都返回 `null`；**新增**自定义服务商命名冲突检查（拒绝这两个 id）。
- **凭据不透明**：Desktop 不得出现角色名/scope 名/用户概念的判断，不解析 token；只存 Keyring + 请求头带 `Authorization: Bearer`；401（凭据失效）与 403（权限不足）文案必须不同。**本轮 Desktop 不含任何写路径。**
- **出站 body 必须完整**：Onto `/retrieval` 的 5 个字段全必填，`vector_similarity_weight` 虽被服务端忽略但**不能省略**（漏传 → 422 → 会被误报成"服务不支持"）。
- **不要假设共享基类/文件存在**：`RagFlowHttpClient`、`sparkiirag/http-client.ts` 在 `main` 上都不存在；动手前先 `git ls-tree -r main -- <path>` 或 `rg` 核对。
- **改枚举要改全**：`backend` 联合类型在仓库里有 **8 处**，另有一处**行为点** `knowledgeFromManifest`（会把新后端压成 `bm25`）。
- **改检索要改全**：后端判定点共 **13 处**——`ipc.ts` 里 12 行含 `'sparkiirag'` 字面量（归纳为 11 个逻辑点：出处写入/接地重置/会话前探活/原文落盘/设置读写/Key 守卫），**外加 2 处不含字面量、按 grep 必然漏掉的默认域写入**（`ipc.ts` 的 `persistDefaultDataset`、`workflow.ts` 的 `persistDefault`）。漏一处就是静默的"只有 RAG 能用"或"域 id 写错配置块"。
- 读配置宽容、写配置严格：非法已存 URL 不得让 `getSettings` 抛错。
- URL 允许内网 `http://`（不得恢复 HTTPS-only）。
- 出处打开沿用 `{datasetId, documentId}`；**不得**引入不透明 `connectionRef` / 凭据代际 / 中立句柄。
- `chunks.length === 0` → 走既有"空检索拒答"，不经大模型；"会话所选域不在 `/datasets`" → `SESSION_DATASET_GONE`（按列表判定，不匹配错误文案）。
- 检索超时 30s；审计只记 query 前 120 字 + 命中文件名，不记 chunk 全文与 token。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| Onto HTTP 客户端 / 响应映射 | `packages/connectors/src/sparkiionto/` | Electron、Pi |
| 设置 / 凭据 / 探活 / 检索执行 | `apps/desktop/electron/main/knowledge-*.ts`、`rag-search.ts`、`rag-open.ts` | Renderer、Pi |
| 设置页两块分组 | `apps/desktop/src/shell/SettingsKnowledgePane.tsx` | 智能体目录 |
| 智能体 | **本轮不动** | — |

## File Structure

```text
packages/connectors/src/sparkiionto/types.ts             新增（SparkiiOntoInfo 等 Onto 专有类型）
packages/connectors/src/sparkiionto/client.ts            新增（自带 fetch/超时/状态码映射；不继承 SparkiiRagClient）
packages/connectors/src/index.ts                         导出追加
packages/connectors/test/sparkiionto-client.test.ts      新增（用实测响应做 fixture）
packages/connectors/test/fixtures/sparkiionto/*.json     新增（来自 ~/sparkiionto-deploy/evidence）
        ※ 不新增 mapper：复用 sparkiirag/map.ts 的 mapRetrieval / mapDatasets
        ※ 不改 packages/connectors/src/sparkiirag/*

packages/config/src/schema.ts                            backend 枚举加 sparkiionto
packages/config/src/types.ts                             backend 联合类型
packages/ui/src/patterns/Shell.tsx                       backend 联合类型（第 3 处）
apps/desktop/src/surface/contract.ts                     backend 联合类型（第 4 处）
apps/desktop/electron/preload/api-types.ts               backend 联合类型（第 5 处）+ 新 IPC 类型
apps/desktop/electron/preload/api.ts                     新 IPC 透传
apps/desktop/electron/main/agent-catalog.ts              backend 联合类型（第 6 处）
apps/desktop/electron/main/rag-settings.ts               backend 联合类型（第 7 处）+ knowledgeFromManifest 行为点
apps/desktop/electron/main/rag-search.ts                 第 8 处 + 客户端工厂 + 出处归属 + backend 参数

apps/desktop/electron/main/settings.ts                   AppSettings.sparkiionto 块
apps/desktop/electron/main/knowledge-settings.ts         新增：按后端取配置/绑定（读宽容、写严格）
apps/desktop/electron/main/knowledge-probe.ts            新增：healthz → info → datasets + 状态码分类
apps/desktop/electron/main/runtime.ts                    Keyring accessor：knowledgeToken/setKnowledgeToken(backend)
apps/desktop/electron/main/rag-open.ts                   按 backend 选 client + 缓存分段
apps/desktop/electron/main/rag-grounding.ts              documents/citations 加可选 backend（additive）
apps/desktop/electron/main/workflow.ts                   knowledge.search 走后端工厂（行为不变）
apps/desktop/electron/main/ipc.ts                        11 个后端判定点（12 行字面量）+ 2 处默认域写入之一（清单见 Task 4 Step 2）+ 新 handler + getSettings/save
apps/desktop/electron/main/provider-catalog.ts           新增命名冲突检查（拒绝 sparkiirag / sparkiionto）

apps/desktop/src/shell/SettingsKnowledgePane.tsx         RAG 组保持不动 + 并列新增 Onto 组
apps/desktop/src/shell/SettingsView.tsx                  SettingsApi 类型 + 装配
apps/desktop/src/surface/knowledge-citations.tsx         类型加可选 backend（无行为变化）

apps/desktop/test/knowledge-settings.test.ts             新增
apps/desktop/test/knowledge-probe.test.ts                新增
apps/desktop/test/rag-search.test.ts                     扩展（onto 分支 + 既有断言不动）
apps/desktop/test/rag-open.test.ts                       扩展（缓存分段）
apps/desktop/test/ipc.test.ts                            扩展（探活/列表/打开原文/命名冲突/getApiKey）
apps/desktop/test/settings-knowledge-pane.test.tsx       扩展（两块分组）
apps/desktop/test/knowledge-isolation.test.ts            扩展现有文件（不新建）
apps/desktop/test/knowledge-citations.test.tsx           保持（本轮不改行为）
```

---

## Task 1 — 连接器：`SparkiiOntoClient` + 映射 + 契约测试

- [ ] **Step 1: fixture。** 把 `~/sparkiionto-deploy/evidence/*.body` 里的实测响应（healthz / info / datasets / retrieval 命中 / retrieval 空 / retrieval 未知域 / retrieval `threshold=0` / 401 / 403 / 原文的 content-type+disposition）复制成 `packages/connectors/test/fixtures/sparkiionto/*.json`。
  - 注意：evidence 目录里**没有** 422 响应，需**现场生成**（`curl` 打一个越界/缺字段请求即可），至少三条：漏传 `vector_similarity_weight`、多一个未知字段、`page_size=21`。三者都应得到 `422 {"code":422,"message":"invalid request"}`。
  - 正文里的 id/时间戳是示例值，**以 evidence 目录为准**（域 `d264d494-…`、文档 `071c7edd-…`）。
- [ ] **Step 2: 类型与映射。** 只新增 `src/sparkiionto/types.ts`（`SparkiiOntoInfo`：product/version/api_version/deployment_profile/retrieval.{backend,semantic_embeddings}/capabilities）。**载荷映射直接复用 `sparkiirag/map.ts` 的 `mapRetrieval(data, threshold)` 与 `mapDatasets(data)`**——Onto 兼容载荷的字段（`document_keyword`/`dataset_id`/`similarity`/`term_similarity`/`vector_similarity`/`doc_aggs[].doc_id|doc_name|count`）与其完全一致（已核对 `main` 的 `map.ts`），**不要新写 mapper**。注意两个 mapper 期望的都是 `payload.data`（不是整个信封）：`mapRetrieval(payload.data, threshold)`、`mapDatasets(payload.data)`；信封的 `code !== 0` 由 client 自己判定（`{code,message}` 是产品 API 的统一错误形状）。
- [ ] **Step 3: client（自带传输，不继承）。** 新增 `src/sparkiionto/client.ts`：
  - `main` 上**不存在** `RagFlowHttpClient`，也**没有** `sparkiirag/http-client.ts`；`SparkiiRagClient` 的 `send/requestJson/parseJson/assertOk/authHeaders` 全是 `private`，且把所有非零 `code` 一律映射成 `CONNECTOR_DENIED`——**无法满足 Onto 的 401/403/404/422 区分**，因此本 client **自带** `fetch` + `AbortSignal.timeout(30s)` + JSON 解析 + **按 HTTP 状态码**分类的错误映射，**不改动 `packages/connectors/src/sparkiirag/*`**（保护现存智能体）。将来出现第三个后端再评估抽取共享基类。
  - 构造时校验 baseUrl（**允许内网 http**，允许端口，拒绝 userinfo/query/hash）；`info()` 一次性协商并缓存；`listDatasets()`/`retrieve()`/`fetchDocument()` 首次调用前先确保 `/info` 通过；`product !== 'SparkiiOnto'`、`api_version !== 'v1'`、`deployment_profile !== 'single-instance'`、`capabilities.datasets !== true` → `CONNECTOR_UNSUPPORTED`。
  - `retrieve()` 的请求体**必须包含全部 5 个字段**：`question`、`dataset_ids`、`similarity_threshold`、**`vector_similarity_weight`（常量，例 `0.3`）**、`page_size`。服务端是 `extra="forbid"` + 全必填，**漏传 `vector_similarity_weight` 会 422**（该字段"必填但被忽略"）。
- [ ] **Step 4: 测试**（`packages/connectors/test/sparkiionto-client.test.ts`）：
  - `/info` 正常 + 四种协商失败各 1 例（product/api_version/deployment_profile/capabilities）；
  - `datasets` envelope 正常/畸形；
  - `retrieval` 命中（`similarity/term_similarity/vector_similarity` 与 `doc_aggs` 映射）、空、未知域 200 空、**`threshold=0` → 全部片段且 `similarity=0.0`**；
  - **出站 body 断言：包含 `vector_similarity_weight`**（防漏传回归）；
  - 401→`CONNECTOR_DENIED`、403→`CONNECTOR_DENIED`、404/405→`CONNECTOR_UNSUPPORTED`、**422→`CONNECTOR_UNSUPPORTED` 且文案与 404 不同**、429/5xx/超时→`CONNECTOR_IO`；
  - 非 JSON 响应体；错误文案不含 token；
  - 原文下载返回原始字节。
- [ ] **Step 5: 验证**
```bash
pnpm vitest run packages/connectors/test/sparkiionto-client.test.ts
```

## Task 2 — 平台设置与凭据

- [ ] **Step 1: `backend` 联合类型的完整清单（8 处，缺一处就静默出错）。** `packages/config/src/schema.ts`（zod enum）、`packages/config/src/types.ts`、`packages/ui/src/patterns/Shell.tsx:27`、`apps/desktop/src/surface/contract.ts:11`、`apps/desktop/electron/preload/api-types.ts:141`、`apps/desktop/electron/main/agent-catalog.ts:4`、`apps/desktop/electron/main/rag-settings.ts:23`、`apps/desktop/electron/main/rag-search.ts:24`。
  另有**一处行为点**：`rag-settings.ts` 的 `knowledgeFromManifest` 现在是 `backend: knowledge?.backend === 'sparkiirag' ? 'sparkiirag' : 'bm25'`——**它会把 `sparkiionto` 静默压成 `bm25`**，必须改成显式三分支。改完必须复跑 `apps/desktop/test/agent-catalog.test.ts`、`apps/desktop/test/settings*.test.tsx` 与 `knowledge-citations.test.tsx`（这些用例里到处写着 `backend: 'sparkiirag'`）。
- [ ] **Step 2:** `settings.ts` 增 `sparkiionto?: { baseUrl?: string; similarityThreshold?: number; bindings?: Array<{agentId,defaultDatasetId}> }`（与 `rag` 平行，互不覆盖）。
- [ ] **Step 3:** 新增 `knowledge-settings.ts`：
  - `knowledgeBackendSettings(backend, settings)` → `{ baseUrl, similarityThreshold, bindings, invalidBaseUrl? }`；
  - **读宽容**：非法/缺失 URL → 默认 `http://127.0.0.1:9380` + `invalidBaseUrl: true`，**不抛错**；
  - 写严格：保存时校验（非空、http/https、无 userinfo/query/hash）。
- [ ] **Step 4:** Keyring 命名空间 `knowledge:sparkiionto`；`apps/desktop/electron/main/runtime.ts` 的 `Runtime` 接口增 `knowledgeToken(backend)` / `setKnowledgeToken(backend, token)`（实现放 `createKnowledgeSecretStore` 或等价处），并在 `assemble()` 里暴露。
- [ ] **Step 5: IPC 读写。**
  - `sparkii:getSettings`：把 `sparkiionto` 从 `...rest` 里摘出来（现在只摘 `rag`/`documentParse`），重建成 `{ baseUrl, similarityThreshold, bindings, hasToken: boolean, invalidBaseUrl?: boolean }`，**绝不回传 token**；
  - 新增 `sparkii:saveKnowledgeSettings(backend, partial)`（或 `saveSparkiiOntoSettings`）：URL 写严格校验 + `setKnowledgeToken` 写入；`backend='sparkiirag'` 时保持既有 `saveRagSettings` 行为不变；
  - **命名冲突检查的调用点**：唯一持久化自定义服务商的路径是 `sparkii:saveSettings`（`ipc.ts` 约 1342-1358 行，写 `providers[]` 前），在那里拒绝 `providers[].id ∈ {sparkiirag, sparkiionto}` 并返回可诊断错误；`provider-catalog.ts` 只作为判定函数/常量所在处，**不是**调用点。
  - `sparkii:getApiKey` 的守卫扩到 `sparkiionto`/`apiKey:sparkiionto`；
  - `preload/api.ts` + `api-types.ts` + `SettingsView.tsx` 的 `SettingsApi` 同步类型。
- [ ] **Step 6:** 测试 `apps/desktop/test/knowledge-settings.test.ts`：读宽容（坏 JSON/坏 URL）、写严格、两个后端的 bindings 互不覆盖、`getSettings` 不回传 token、`getApiKey` 对两个知识 id 都返回 null。
- [ ] **Step 7:** 验证 `pnpm vitest run apps/desktop/test/knowledge-settings.test.ts apps/desktop/test/settings.test.tsx apps/desktop/test/ipc.test.ts`

## Task 3 — 探活与能力协商（IPC）

- [ ] **Step 1:** 新增 `knowledge-probe.ts`：`probeKnowledgeBackend(backend, {baseUrl, credential, override})`，顺序 `healthz → info → datasets`，返回 `{ok, info?, datasets?, error?: {code,message,reason}}`；按 SPEC §3 的码表分类；`reason` 取 `unreachable|unauthorized|forbidden|unsupported|unhealthy|invalid_config`。
- [ ] **Step 2:** IPC：新增 `sparkii:testKnowledgeConnection(backend, override?)`、`sparkii:listKnowledgeDatasets(backend)`；既有 `testRagConnection`/`listRagDatasets` 保留为 `backend='sparkiirag'` 的薄封装（renderer 兼容）。
- [ ] **Step 3:** 探活相关 IPC 的 preload/`SettingsView` 类型（其余类型在 Task 2 Step 5 已就位，别重复改）。
- [ ] **Step 4:** 测试 `apps/desktop/test/knowledge-probe.test.ts` + `ipc.test.ts` 增例（含 401/403 文案区分、`/info` 不匹配）。
- [ ] **Step 5:** 验证 `pnpm vitest run apps/desktop/test/knowledge-probe.test.ts apps/desktop/test/ipc.test.ts`

## Task 4 — 检索执行：按后端选客户端

- [ ] **Step 1:** `rag-search.ts` 引入工厂 `knowledgeClientFor(backend, settings, credential)`（`bm25` 返回 null；`sparkiirag`/`sparkiionto` 返回各自 client）。
- [ ] **Step 2: 后端相关的判定点必须全部改造（下面每一处都要改，且 `bm25`/`sparkiirag` 分支逐字节保持现状）。** 已核对 `main`：`ipc.ts` 里含 `'sparkiirag'` 字面量的行共 **12 行**（63/354/378/430/459/472/482/484/774/1321/1330/1373），归纳为 **11 个逻辑点**：
  1. `probeRag`（`keyFor('sparkiirag')` + `new SparkiiRagClient` + `'SparkiiRAG 不可达'`）→ 保留为 sparkiirag 专用，另外接通用探活；
  2. `persistHitTurn` 的 `if (knowledge.backend !== 'sparkiirag') return;` → **否则 onto 的出处永远不会写进会话**；
  3. prompt 处理里的 `if (knowledge.backend === 'sparkiirag') groundingTurns.set(resetTurn())` → 否则 onto 的每轮接地状态不重置；
  4. `assertSparkiiRagReady`（`!== 'sparkiirag'` 直返 + `keyFor` + `SparkiiRagClient` + 两条中文错误）→ 改为按后端探活；
  5. `cacheRagFile`（`knowledge.fetch_document` 的落盘路径，硬编码 `SparkiiRagClient` + `keyFor('sparkiirag')`）；
  6. `handleConnectorRead` 的 `knowledge.search` 分支；
  7. `markSearchResult` 处的 `if (out.ok && knowledge.backend === 'sparkiirag')`；
  8. `else if (!out.ok && knowledge.backend === 'sparkiirag' && message === SESSION_DATASET_GONE)`；
  9. `sparkii:getSettings` 的 `keyFor('sparkiirag')`；
  10. `sparkii:getApiKey` 的守卫；
  11. `sparkii:saveRagSettings` 的 `setKey('sparkiirag', …)`。
  **另有 2 处不含该字面量、按字面量 grep 必然漏掉的默认域写入**（漏掉会让 Onto 会话把域 id 写进 `rag.bindings`，且 `sparkiionto.bindings` 永不更新）：
  12. `ipc.ts` 的 `persistDefaultDataset(profileId, datasetId)`（约 369-374 行，无条件 `patchRagSettings`）；
  13. `workflow.ts` 里 `knowledge.search` 分支的 `persistDefault` 回调（约 277-282 行，同样无条件 `patchRagSettings`）。
  两处都要改成"按后端取配置块再写"（`knowledgeBackendSettings(backend, …)`），并由 Task 2 Step 6 的"两个后端 bindings 互不覆盖"断言守住。另：`workflow.ts` 的 `knowledge.search` 分支本身也要按后端取（见上）。
- [ ] **Step 3: 参数与出处归属。** Onto 的出站 body **必须带** `vector_similarity_weight`（常量 0.3；必填但被服务端忽略，漏传即 422）；`similarity_threshold` **不做 clamp**（用该后端的配置值，默认 0.2）；`rag-grounding.ts` 把 `backend` 写进本轮 `knowledge_turn.documents[]`/`citations[]`（缺省 `sparkiirag`，历史数据语义不变）。
- [ ] **Step 4:** 测试：`rag-search.test.ts` 扩展 onto 命中/空/未知域 + **断言该后端配置的 `similarityThreshold`/`topK` 透传到 client**（**出站 body 的断言放在 Task 1 Step 4 的 connector 测试里**——`rag-search.test.ts` 注入的是假 `retrieve`，看不到 body）；**并锁住 bm25 与 sparkiirag 的既有断言不变**；`rag-grounding.test.ts` 增 `backend` 字段用例（缺省行为不变）。
  注意实现细节：`rag-grounding.ts` 的 `markSearchResult` 会按 `documentId` 合并 documents（约 26-33、95-104 行），**合并时要显式带上 `backend`**，否则字段会在合并中被丢掉。
- [ ] **Step 5:** 验证 `pnpm vitest run apps/desktop/test/rag-search.test.ts apps/desktop/test/workflow-broker.test.ts`

## Task 5 — 打开原文

- [ ] **Step 1:** `rag-open.ts`：`fetchAndCacheDocument` 增 `backend`，缓存目录改 `rag-cache/<backend>/<datasetId>/<docId><ext>`（**旧的扁平路径保留读取兼容**，避免既有缓存失效；跨后端同 `documentId` 不再撞车）。
- [ ] **Step 2:** IPC `sparkii:openRagDocument({ backend?, datasetId, documentId, fileName? })`：`backend` 缺省 = `sparkiirag`（保持 main 行为，仍把 `path` 回给 renderer，不引入任何不透明引用）。**同一条路由也要覆盖 `knowledge.fetch_document`（`cacheRagFile`）**——它现在硬编码 RAG，两处必须一起改，否则模型自己取原文时会走错后端。
- [ ] **Step 3:** 测试：onto 下载字节一致 + `shell.openPath` 调用一次 + 失败时返回有界错误码 + **同一 `documentId` 在两个后端下落到不同缓存路径**。
- [ ] **Step 4: 待批准项（默认不做）。** 把 `doc.backend` 从出处气泡透传到 `openRagDocument` 需要改 `apps/desktop/agents/knowledge-qa/surface/index.tsx` **一行**（`backend: doc.backend`）。它是 additive 的（RAG 会话下 `doc.backend === undefined` ⇒ Main 缺省 `sparkiirag`，行为逐字节不变），但**属于修改既有智能体文件**，与 Decision 15 冲突。**默认本轮不做**：平台侧写入/路由/缓存分段照做并由单测覆盖；要不要加这一行由产品方拍板（加了才能让 Onto 会话的"点出处打开原文"真正可用）。
- [ ] **Step 5:** 验证 `pnpm vitest run apps/desktop/test/rag-open.test.ts apps/desktop/test/ipc.test.ts`

## Task 6 — 设置页：两块分组并列

- [ ] **Step 1:** **RAG 组保持既有结构与 testid 不变**（`main` 上已有地址、API Key、测试连接、保存、智能体默认库，testid `rag-*`）——**只在其中新增阈值控件**；别重排既有 DOM，否则 `settings-knowledge-pane.test.tsx` 会失效。
- [ ] **Step 2:** 新增 Onto 组：地址、API Token、测试连接（展示 `/info` 结果：检索后端 `sql-lexical`、是否语义嵌入、是否可打开原文）、保存、智能体默认域（`sparkiionto-default-domain-*`）。
- [ ] **Step 3:** **相似度阈值（两组都做）**：RAG 组新增 `similarityThreshold` + `vectorSimilarityWeight`（后者对 RAG 有效），沿用既有 `readRag`/`save` 的读写路径与 `rag.similarityThreshold`/`rag.vectorSimilarityWeight` 字段；Onto 组暴露 `similarityThreshold`（**不**暴露向量权重，服务端忽略它），写入 `sparkiionto.similarityThreshold`。两组都**不做 clamp**（默认 0.2）；但 `[0, 1]` 越界要**就地提示**（Onto 服务端 `Field(ge=0, le=1)`，越界会 422 且文案像"服务不支持"）；值 < 0.05 时旁注"几乎不过滤，会把无关片段当命中"。
- [ ] **Step 4:** **明文内网警告**：地址为非 loopback 的 `http://` 时显示提示（凭据与内容可能被同网段嗅探/篡改；建议反向代理终止 TLS），但不阻止保存。
- [ ] **Step 5:** 提示文案：Onto 组写明"词法检索：适合短查询/引用式提问"；token 寿命提示（默认 24h，需按站点策略上调）；地址默认值 `http://127.0.0.1:9380` 旁注明"仅适用于本机联调"（两个后端的默认 URL 相同，靠 `/info` 的 `product` 字段兜底区分）。
- [ ] **Step 6:** 测试 `settings-knowledge-pane.test.tsx`：两块都在；RAG 输入存在；Onto 能力/阈值/明文警告文案渲染；空 token 保存不覆盖。
- [ ] **Step 7:** 验证 `pnpm vitest run apps/desktop/test/settings-knowledge-pane.test.tsx`

## Task 7 — 隔离与回归

- [ ] **Step 1:** **扩展现有 `apps/desktop/test/knowledge-isolation.test.ts`**（该文件已存在，已锁"无 agent-id 分支 / 无 `/api/v1/openai/` / `knowledge.search` 无 datasetId / StandardChat 不 import picker"），**不要新建 `profile-isolation.test.ts`**。新增用例：解析 4 个现存 profile，断言 `knowledge` 与 `main` 逐字段一致（`contract-review`→bm25/hidden，`knowledge-qa`→sparkiirag/session，`general`/`procurement-review` 不变）。
- [ ] **Step 2:** 在 `ipc.test.ts` 现有 `getApiKey(sparkiirag) → null`（约 367 行）旁边补齐 `sparkiionto`；并新增**命名冲突检查**用例：自定义服务商 id 为 `sparkiirag`/`sparkiionto` 时保存被拒绝，且既有自定义服务商不受影响（`provider-catalog.ts` 现在**没有**任何保留名逻辑，这是新增保护）。
- [ ] **Step 3:** 全量回归（桌面仓库，不跑 Onto 仓库）。**基线已实测**（architect 复审时本机执行）：`Test Files 2 failed | 170 passed (172)`，两条失败都是 5000ms 超时且与知识管道无关（`packages/agent-host/test/pi-runtime-pool-skill-isolation.test.ts`、`packages/connectors/test/report.test.ts`）；12 个知识相关测试文件全绿（163 tests）。**目标是"不新增失败"**，不是"0 失败"。
- [ ] **Step 4:** 类型检查：`tsc --noEmit` 在 `apps/desktop/tsconfig.json` 与 `tsconfig.electron.json` 下各有约 20 条**既有**错误（其它模块；其中 `agents/knowledge-qa/surface/index.tsx:147-164` 也在既有列表里）。**目标同样是"不新增"**。
- [ ] **Step 5: 本机命令写法（重要）。** 本机 `pnpm <cmd>` 会触发隐式重装并失败（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，codex 自带 pnpm 11 + 无 TTY）。用 node 直调代替：
```bash
node node_modules/vitest/vitest.mjs run <测试文件...>
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.electron.json
```
（沙箱内读 `node_modules` 需要提权；`pnpm install` 不要跑。）

## Task 8 — 本地端到端（WSL Onto + Desktop）

- [ ] **Step 1:** 确认 Onto 服务在跑：`curl --noproxy '*' http://127.0.0.1:9380/api/v1/system/healthz` 返回 `status:ok`（起服务用前置表里的 `02-start-server.sh`，**那是本机脚本、不在仓库里**；换机器就按契约文档 §8 重建环境）。
- [ ] **Step 2:** Desktop 设置页填 `http://127.0.0.1:9380` + `token-desktop`（`~/sparkiionto-deploy/token-desktop`）→ 测试连接应显示检索后端与能力。
- [ ] **Step 3: 平台级端到端（本轮可做，且是真实服务）。**
  - 设置页填 `http://127.0.0.1:9380` + `token-desktop` → 测试连接应显示 `sql-lexical` / 无语义嵌入 / 可打开原文（走 Task 3 的 `healthz → info → datasets`）。
  - 用**脚本或测试**直接跑 Main 的执行链路（不经智能体）。注意参数以 **Task 4 之后的真实签名**为准（`runMainKnowledgeSearch` 会带 `backend`，`RagSettings` 的 4 个字段必填，含 `vectorSimilarityWeight`），例如：`runMainKnowledgeSearch({ args: { query: '高温津贴按日计发' }, profileId: 'e2e', sessionId: 'e2e', selection: null, knowledge: { enabled: true, backend: 'sparkiionto', picker: 'hidden' }, rag: knowledgeBackendSettings('sparkiionto', settings), apiKey: <token>, credentialGeneration: 1, bm25: <throw>, })`。
  - 断言：命中时 `chunks/documents` 映射正确、`term_similarity === similarity`、`vector_similarity === 0`；查一句自然语言中文问句时 `chunks` 为空（对应"空检索→拒答"）；`fetchAndCacheDocument` 落盘字节与源文件一致。
  - 该脚本/测试**不进 `agents/**`**，也不改任何现存 profile。
- [ ] **Step 4: 明确本轮的验证边界（对话级端到端延后）。** 用临时 profile 跑"气泡+出处"的对话级 E2E 在本轮**做不到**，原因是 main 上的选库链路只认 RAG：`KnowledgeDatasetPicker.tsx` 调 `api.listRagDatasets?.()`、`agents/knowledge-qa/surface/index.tsx` 读 `settings.rag.bindings` 并据此调 `setSessionKnowledge`——把副本 profile 的 backend 改成 `sparkiionto` 后，选库会解析到 RAG 侧；未配 RAG 时直接 `throw new Error('请选择知识库')`，发送被拦。**因此这一期交付的是"平台能力 + 真实服务上的执行链路验证"**；对话级 E2E（选库、气泡、点出处）与选库控件改造一起进入智能体一期（见"下一期"）。交付说明必须写明这一点。
- [ ] **Step 5:** 回归抽查现存智能体：`contract-review` 走 BM25 正常；`knowledge-qa` 仍走 SparkiiRAG（可用 `token-narrow` 反证权限错误文案）。

## Task 9 — 文档收尾与提交

- [ ] **Step 1:** 回填契约文档 §9"待确认"（HTTPS/域删除/token 轮换）与本计划前置表（若修订号变化）。
  - **交付说明（已知边界）· F2：** RAG 会话**新写出**的 `knowledge_turn` 现在也带 `"backend":"sparkiirag"`（spec Decision 9 里该字段可选、缺省即 `sparkiirag`，故不违约）；渲染行为由 `knowledge-citations.test.tsx` / `ipc.test.ts` 锁定，历史 JSONL 读回语义不变。
  - **交付说明（已知边界）· F5：** RAG 组比 `main` 多了一层 `<section data-testid="knowledge-rag-group">` 容器（组内节点顺序与 `rag-*` testid 逐字未动，既有用例只把查询收窄到组内），免得后人把它当成 `main` 的既有结构。
  - **交付说明（已知边界）· F6：** `packages/connectors/test/fixtures/sparkiionto/` 里 `document-upload` / `documents-list` / `domain-create` / `domains-list` / `job-get` / `job-process` 6 组入库·作业面响应未被任何测试引用，属实测证据留存（`fixtures/sparkiionto/README.md` 已说明，入库属本轮 non-goal）。
- [ ] **Step 2:** 提交（分主题，便于审阅）：
```bash
git commit -m "feat(connectors): add SparkiiOnto knowledge client with capability negotiation"
git commit -m "feat(desktop): route knowledge.search by manifest backend and add SparkiiOnto settings"
git commit -m "test(desktop): lock existing agents against the new knowledge backend"
```

---

## Self-review

| Spec 条目 | Task |
| --- | --- |
| 两个产品、一个通道（配置/凭据独立） | 2, 3, 6 |
| 后端判别在 profile；不新增智能体 | 4, 7 |
| 能力协商驱动行为 | 1, 3, 6 |
| 凭据命名空间独立 + 命名冲突检查覆盖两者 | 2, 7 |
| URL 允许内网 HTTP | 1, 2 |
| 失败语义三码 + 401/403 分开 + 422 独立文案 | 1, 3 |
| 出站 body 必带 `vector_similarity_weight`（必填但被忽略） | 1, 4 |
| 空检索拒答 / `SESSION_DATASET_GONE` | 4 |
| 打开原文保持 main 行为 + 后端归属（含缓存分段） | 4, 5 |
| 设置页两块并列 | 6 |
| 读宽容 / 写严格 + getSettings 不回传 token | 2 |
| 阈值暴露（两组都有；字段按后端区分；不 clamp，越界就地提示，低值警告） | 6 |
| 明文内网警告不阻止保存 | 6 |
| 身份与轮换（现状 scope 方案 + 目标态依赖） | 前置表 / spec §11 |
| 不引入 MCP | Non-goal |
| 8 处 `backend` 联合类型 + `knowledgeFromManifest` 行为点 | 2, 7 |
| 13 处后端判定点全部改造（11 个逻辑点 + 2 处默认域写入） | 4 |
| 不影响现存智能体 | 7, 8 |

## 下一期（不在本计划内）

- 新智能体接入（本体/工艺）与其 `manifest.knowledge.backend: sparkiionto`、`picker: session` 配置。
- `KnowledgeDatasetPicker` 按后端取列表（控件本身要改，但只对 session-picker 智能体有意义）。
- Onto 会话的**对话级端到端**：`knowledge-qa` surface 的 `listSparkiiOntoDomains` / `sparkiionto.bindings` 解析 + 出处 `backend` 透传（1 行）；本轮只交付平台能力与平台级验证。

> 下一期做对话级 E2E 时可直接复用这条已核对的配方：`cp -r apps/desktop/agents/knowledge-qa /tmp/onto-e2e/knowledge-qa`（**目录名必须保持 `knowledge-qa`**——`useAgentSurface` 是 `surfaceByAgent[agentId]` 的无兜底查表，见 `apps/desktop/src/platform/surface-registry.tsx:7`）→ 只改副本 `manifest.yaml` 的 `backend: sparkiionto`（`picker` 可保持 `session`，届时 picker 已按后端取列表）→ `SPARKII_PROFILE_DIR=/tmp/onto-e2e/knowledge-qa` 以开发模式启动（`apps/desktop/electron/main/index.ts:53`，`allowUnsigned: NODE_ENV !== 'production'`）。
- 本体能力工具面（`/api/graph/*`、`/api/sparql`、血缘、决策链）→ 独立 connector + 新智能体。

## 不要再犯（上一版教训清单）

1. 不要为"第二个后端"复制整套 settings/secret/probe/IPC/设置页。
2. 不要为了接一个新后端去改已上线智能体的 manifest。
3. 不要在出处链路上引入会随进程重启失效的引用。
4. 不要把内网 HTTP 一刀切禁掉。
5. 不要在读配置路径上抛错。
6. 不要让同类凭据只有一半享受保留名保护。
7. 不要在没有真实服务的前提下写连接器契约（本轮已用 WSL 实测：`01cbaa78`）。
8. 不要在计划里假设"某个共享基类/文件存在"——本轮的 `RagFlowHttpClient` 与 `sparkiirag/http-client.ts` **在 `main` 上都不存在**；动手前先 `git ls-tree`/`rg` 核对。
9. 不要把"必填但被忽略"的字段当成可以省略（`vector_similarity_weight` 漏传 → 422 → 被误报成"服务不支持"）。
10. 不要只改 `packages/config` 的枚举——同一个联合类型在仓库里有 8 处，另有一处**行为点**（`knowledgeFromManifest`）会把新后端静默压回 `bm25`。
11. 不要只改"检索"那一条链路——`ipc.ts` 另有约 11 处 `=== 'sparkiirag'` 门（出处写入、接地重置、会话前探活、原文落盘、设置读写、Key 守卫）必须同步改造。
