# SparkiiOnto 本体能力工具面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 SparkiiOnto 的全部只读能力接通为桌面端可用的 11 个智能体工具（`ontology.*`），并把本体的文档检索从 `knowledge.search` 上摘除，使两套服务各管各的内容。

**Architecture:** 复用既有"Pi 发工具调用 → `connector_read` → Main 执行"的通道。新增 `SparkiiOntoGraph`（继承现有 `SparkiiOntoClient` 的传输与错误映射，不新建并行栈）承担图与决策端点；11 个工具定义为 `host: 'main'` 的只读工具，由 Main 的 `executeOntologyTool` 注入凭据后执行。`knowledge.search` 回落为 `bm25 | sparkiirag`。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron IPC、SparkiiOnto HTTP（产品面 `/api/v1/*` + Explorer 面 `/api/*`）。

**Spec:** `docs/superpowers/specs/2026-09-22-sparkiionto-ontology-tools-design.md`

## Global Constraints

- **不改任何现存智能体。** `apps/desktop/agents/**` 本轮一行不改；实测现存 4 个智能体无一使用 `sparkiionto` 后端。
- **`manifest.knowledge.backend` 删除 `sparkiionto` 值**，不留废弃值；枚举回落为 `bm25 | sparkiirag`。
- **工具命名空间固定 `ontology.`**；模型侧函数名由 `pi-runtime-tools.ts` 规范化（`.` → `_`），规范化后必须全局唯一。
- **11 个工具全部** `sideEffect: 'read'`、`host: 'main'`；凭据只在 Main；Pi 不得 fetch 本体服务、不得读凭据。
- **`ontology.query` 是高级工具**：平台不注入，仅智能体显式声明时可见；本端三条护栏——超时 10s、响应体上限（超出截断并置 `truncated: true`）、审计记查询全文。其余工具超时 30s。
- **空结果 ≠ 错误**：`empty: true` 与 `error` 必须分开；`ontology.graph_summary` 用于自检。
- **错误分类沿用既有映射**（401/403 → `CONNECTOR_DENIED`；404/405/422 → `CONNECTOR_UNSUPPORTED`；429/5xx/网络 → `CONNECTOR_IO`），文案不携带 token。
- **对端缺陷不裁剪本端能力**：`path` / `distance_matrix` / `reason` / `query` 照常实现；在真实服务上被对端挡下时给出可诊断错误即可，不判本轮不通过（spec §13）。
- **本机命令**：不要用 `pnpm <cmd>`（会触发隐式重装并失败 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。统一用
  `node node_modules/vitest/vitest.mjs run <测试文件>` 与 `node node_modules/typescript/bin/tsc --noEmit -p <tsconfig>`。
- **回归目标**：既有 BM25 / SparkiiRAG 路径逐字节不变；全量测试不得新增失败（基线以实施时的 `main` 为准）。

---

## File Structure

```text
packages/connectors/src/sparkiionto/client.ts        改：私有传输成员改 protected（send/requestJson/parseJson/authHeaders/httpError/timeoutMs）
packages/connectors/src/sparkiionto/graph.ts         新增：SparkiiOntoGraph + 图/决策/查询方法 + 结果归一化
packages/connectors/src/sparkiionto/types.ts         改：追加图与决策类型
packages/connectors/src/sparkiionto/tools.ts         新增：sparkiiOntoConnector（11 个工具定义 + Main 执行 stub）
packages/connectors/src/sparkiionto/read-families.ts 新增：其余只读能力族的类型化方法（Task 9；也可并入 graph.ts）
packages/connectors/src/index.ts                     改：导出 graph / tools

apps/desktop/electron/main/ontology-tools.ts         新增：executeOntologyTool（凭据注入、护栏、审计摘要、结果归一化）
apps/desktop/electron/main/connector-registry.ts     改：连接器列表加入 sparkiiOntoConnector
apps/desktop/electron/main/ipc.ts                    改：handleConnectorRead 增加 ontology.* 分发；删除本体知识路由
apps/desktop/electron/main/workflow.ts               改：allTools 加入本体工具；knowledge.search 分支回落
apps/desktop/electron/main/rag-search.ts             改：knowledge.search 检索链路收敛为 bm25|sparkiirag；**保留 knowledgeClientFor 的本体分支**（供 fetch_document / openRagDocument），其形参类型改为 `'bm25' | KnowledgeBackendId`（不能只写 KnowledgeBackendId——bm25 是检索链路要传的第三值）
apps/desktop/electron/main/rag-settings.ts           改：knowledgeFromManifest 两分支
apps/desktop/electron/main/settings.ts               不动（sparkiionto 配置块保留给本体工具）
apps/desktop/electron/main/knowledge-settings.ts     不动（knowledgeBackendSettings('sparkiionto', …) 今天就读 settings.sparkiionto 的绑定块，语义已正确；默认域的新用途在 Task 6 由调用方体现）

packages/agent-host/src/tool-registry.ts             改：CONNECTOR_TOOLS 纳入 sparkiiOntoConnector
packages/config/src/schema.ts                        改：knowledge.backend 枚举删 sparkiionto
packages/config/src/types.ts                         改：同上去掉联合类型分支
packages/ui/src/patterns/Shell.tsx                   改：同上去掉联合类型分支
apps/desktop/src/surface/contract.ts                 改：同上去掉联合类型分支
apps/desktop/electron/preload/api-types.ts           改：同上去掉联合类型分支
apps/desktop/electron/main/agent-catalog.ts          改：同上去掉联合类型分支

apps/desktop/src/shell/SettingsKnowledgePane.tsx     改：Onto 组绑定判定 + 图谱自检行
apps/desktop/electron/preload/api.ts                 改：新增图谱自检 IPC 透传

packages/connectors/test/sparkiionto-graph.test.ts   新增：图/决策/查询契约测试（离线 fixture）
packages/connectors/test/sparkiionto-tools.test.ts   新增：工具名唯一性、host/sideEffect、描述约束
packages/connectors/test/sparkiionto-read-families.test.ts 新增：其余只读能力族各 ≥1 例契约测试（Task 9）
packages/connectors/test/fixtures/sparkiionto/*.body 新增：本轮实测响应（含 403 / 404 真实负例）
apps/desktop/test/ontology-tools.test.ts             新增：Main 执行器（凭据、护栏、empty/error、审计）
apps/desktop/test/knowledge-isolation.test.ts        改：追加本轮不变量
apps/desktop/test/settings-knowledge-pane.test.tsx   改：追加自检行与绑定判定
apps/desktop/test/ontology-e2e.test.ts               新增：真实服务平台级端到端（无服务时跳过）
```

---

## Task 1: 图客户端（契约层）

**Files:**
- Modify: `packages/connectors/src/sparkiionto/client.ts`
- Create: `packages/connectors/src/sparkiionto/graph.ts`
- Modify: `packages/connectors/src/sparkiionto/types.ts`
- Modify: `packages/connectors/src/index.ts`
- Test: `packages/connectors/test/sparkiionto-graph.test.ts`
- Test fixtures: `packages/connectors/test/fixtures/sparkiionto/`（本轮实测响应）

**Interfaces:**
- Consumes: `SparkiiOntoClient`（既有）、`SparkiiOntoHttpError`（既有）、`normalizeOntoBaseUrl`（既有）
- Produces:
```ts
export type OntoGraphNode = { id: string; type: string; content?: string; properties?: Record<string, unknown> };
export type OntoGraphEdge = { source: string; target: string; type: string; weight?: number };
export type OntoGraphSummary = { nodeCount: number; edgeCount: number; nodeTypes: Record<string, number>; edgeTypes: Record<string, number> };
export type OntoPathResult = { nodes: string[]; hopCount: number; weight?: number } | null;
export type OntoDecision = { id: string; category?: string; title?: string; createdAt?: string; [k: string]: unknown };
export class SparkiiOntoGraph extends SparkiiOntoClient {
  searchNodes(input: { query: string; limit?: number }): Promise<OntoGraphNode[]>;
  getNode(nodeId: string): Promise<OntoGraphNode>;
  neighbors(nodeId: string, depth?: number): Promise<Array<OntoGraphNode & { relationship: string; weight: number; hop: number }>>;
  path(input: { source: string; target: string; algorithm?: 'bfs' | 'dijkstra'; directed?: boolean }): Promise<OntoPathResult>;
  distanceMatrix(input: { nodeIds: string[]; metric?: 'hops' | 'weighted' | 'semantic' }): Promise<{ nodes: string[]; matrix: number[][] }>;
  listDecisions(input: { category?: string; limit?: number }): Promise<OntoDecision[]>;
  decisionChain(decisionId: string, limit?: number): Promise<{ chain: unknown; precedents: unknown[]; compliance: unknown }>;
  provenance(input: { domainId?: string; documentId?: string }): Promise<Array<Record<string, unknown>>>;
  reason(input: { facts: unknown[]; rules: unknown[]; mode?: 'forward' | 'backward' }): Promise<unknown>;
  query(input: { query: string }): Promise<unknown[]>;
}
```

- [ ] **Step 1: 放宽既有客户端的传输可见性，并加两个最小扩展。**
  (a) 在 `client.ts` 把 `send` / `requestJson` / `parseJson` / `authHeaders` / `httpError` / `bodyIfJson` 由 `private` 改为 `protected`，把 `private readonly timeoutMs` 改名 `timeoutMsValue` 并加 `protected get timeoutMs()`（保证 `send()` 里 `this.timeoutMs` 仍生效）。
  (b) `requestJson` 增加可选第三参 `budgetMs?: number`（单次调用预算覆盖），`send()` 用 `opts.budgetMs ?? this.timeoutMs` 生成 `AbortSignal.timeout(...)`——这是 Task 3"逐工具总预算"的落点（spec §6）。
  (c) **收紧产品信封判定**：`requestJson` 里把 `code != null && Number(code) !== 0` 改为 `typeof code === 'number' && code !== 0`，避免 Explorer 面顶层出现非数值 `code` 时被 `NaN !== 0` 误判为失败（既有产品面响应恒为数值码，行为不变）。
  **替代方案（若实施时发现子类耦合更麻烦）：** 直接把图方法追加进 `SparkiiOntoClient`，或把传输抽成 `protected` 协作者对象——三者都满足"不新建并行栈"，选实现最省的一种并在提交信息里说明。
  **不改行为**：既有 `sparkiionto-client.test.ts`（25 例）必须原样全绿；失败即回退到替代方案。

- [ ] **Step 1b: 补一条回归断言**：`requestJson` 在"200 + 无 `code`"与"200 + `code` 为字符串"两种 Explorer 风格响应下都视为成功（对应 Step 1c）。

- [ ] **Step 2: 记录本轮实测 fixture。** 在 WSL 本地服务上用桌面凭据抓取并落盘（正文即真实响应，不做改写）：
  `graph-search.body`（`POST /api/v1/onto/graph/search` 命中）、`graph-summary.body`、`graph-nodes.body`、`graph-neighbors.body`、`graph-stats.body`、`decisions-empty.body`（`[]`）、`provenance.body`、`graph-path-notfound.body`（404 `{"detail":"...Source node ... not found"}`）、`sparql-denied.body`（403 `{"detail":"action denied"}`）、`reason-denied.body`、`distance-matrix-denied.body`、`retrieval-onto.body`（既有兼容面响应）。
  每条同时落 `.headers`（至少含 `content-type` 与状态码行）。**负例是真实观察到的事实，不是构造的。**
  **本轮要补、且要在实施时当场确认的 fixture：** `graph-path-ok.body`（路径成功，需对端事项 1 修复后或改用一个确有连通的节点对）、`decisions-chain.body` / `decisions-precedents.body` / `decisions-compliance.body`（需先有决策数据）、`decisions-category.body`（带 `category`/`limit` 的列表）。
  **服务不可用时的退路（避免 Task 1 被卡住）：** 优先复用上一轮已落盘的 `~/sparkiionto-deploy/evidence/`；仍缺的（如决策三端点）按"只测错误分类 + 404 归一化"降级，并在 fixture 的 `.headers` 旁写 `pending-live-capture` 标记；plan 与提交信息都要写明哪些 fixture 是待补的。

- [ ] **Step 3: 写失败测试。** `packages/connectors/test/sparkiionto-graph.test.ts`，注入假 `fetch` 返回 fixture，断言：
```ts
it('searchNodes 命中产品面图搜索', async () => {
  const graph = new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fakeFetch('/api/v1/onto/graph/search', 'graph-search') });
  const nodes = await graph.searchNodes({ query: '窑尾温度' });
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes[0]).toMatchObject({ id: expect.any(String), type: expect.any(String) });
  expect(nodes[0]).not.toHaveProperty('properties.domain_id');   // 类型已裁剪
});

it('path 返回 null 而不是抛错（404 无路径）', async () => {
  const graph = new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fakeFetch('/api/graph/path', 'graph-path-notfound', 404) });
  await expect(graph.path({ source: 'a', target: 'b' })).resolves.toBeNull();
});

it('query 在只读凭据下透出可诊断的 403', async () => {
  const graph = new SparkiiOntoGraph({ baseUrl: 'http://127.0.0.1:9380', apiKey: 't', fetch: fakeFetch('/api/sparql', 'sparql-denied', 403) });
  await expect(graph.query({ query: 'SELECT * WHERE { ?s ?p ?o }' })).rejects.toMatchObject({ code: 'CONNECTOR_DENIED', status: 403 });
});
```
- [ ] **Step 4: 运行，确认失败。**
  `node node_modules/vitest/vitest.mjs run packages/connectors/test/sparkiionto-graph.test.ts`
  预期：`SparkiiOntoGraph` 未定义 / 方法不存在。

- [ ] **Step 5: 实现 `graph.ts`。** 关键点：`await this.info()` 前置校验 `capabilities.graph === true`（不满足抛 `CONNECTOR_UNSUPPORTED`）；产品面用 `requestJson`（自动处理 `{code,message}` 信封），Explorer 面同样走 `requestJson`（`errorDetail` 已兼容 `detail` 键）；**404 在 `path` / `neighbors` 上归一化为 `null` / `[]`**，其余 404 仍抛；结果裁剪为上述类型，不返回服务端原始信封。

- [ ] **Step 6: 运行，确认通过。** 同 Step 4 命令，预期全绿；并复跑 `node node_modules/vitest/vitest.mjs run packages/connectors/test/sparkiionto-client.test.ts` 确认既有契约未变。

- [ ] **Step 7: 提交。** `git add packages/connectors/src/sparkiionto packages/connectors/test/sparkiionto-graph.test.ts packages/connectors/test/fixtures/sparkiionto && git commit -m "feat(connectors): add SparkiiOnto graph client for ontology read surface"`

---

## Task 2: 11 个工具定义

**Files:**
- Create: `packages/connectors/src/sparkiionto/tools.ts`
- Modify: `packages/connectors/src/index.ts`
- Test: `packages/connectors/test/sparkiionto-tools.test.ts`

**Interfaces:**
- Consumes: `Connector` / `ToolDef`（`packages/connectors/src/types.ts`）
- Produces: `export const sparkiiOntoConnector: Connector`，含 `ontology.search_nodes`、`ontology.search_documents`、`ontology.node`、`ontology.path`、`ontology.decisions`、`ontology.decision_chain`、`ontology.provenance`、`ontology.graph_summary`、`ontology.distance_matrix`、`ontology.reason`、`ontology.query` 共 11 个 `host: 'main'`、`sideEffect: 'read'` 的工具；handler 一律返回 `{ ok: false, error: { code: 'CONNECTOR_DENIED', message: 'ontology tools must run on main' } }`。

- [ ] **Step 1: 写失败测试。**
```ts
const tools = sparkiiOntoConnector.tools;
it('恰好 11 个工具且全部 host=main / read', () => {
  expect(tools).toHaveLength(11);
  for (const t of tools) expect(t).toMatchObject({ host: 'main', sideEffect: 'read' });
});
it('规范化后的函数名全局唯一', () => {
  const sdk = [...tools, ...knowledgeConnector.tools, ...documentConnector.tools, ...reportConnector.tools]
    .map((t) => t.name.replace(/[^a-zA-Z0-9_-]+/g, '_'));
  expect(new Set(sdk).size).toBe(sdk.length);
});
it('描述不泄露实现细节', () => {
  for (const t of tools) expect(t.description).not.toMatch(/SparkiiOnto|Paddle|SQL|graph:read|api\/v1/i);
});
it('query 的描述声明高级定位与空结果语义', () => {
  const q = tools.find((t) => t.name === 'ontology.query')!;
  expect(q.description).toContain('高级');
  expect(q.description).toContain('没有结果');
});
```
- [ ] **Step 2: 运行，确认失败。** `node node_modules/vitest/vitest.mjs run packages/connectors/test/sparkiionto-tools.test.ts`
- [ ] **Step 3: 实现 `tools.ts`。** 按 spec §5 表逐条落地：参数 camelCase（`nodeId` / `domainId` / `decisionId` / `nodeIds` / `algorithm` / `directed` / `metric` / `mode` / `limit` / `query` / `source` / `target` / `facts` / `rules`）。
  **`ontology.reason` 的入参只有 `facts` / `rules` / `mode`，不得出现 `applyToGraph`**（spec D16：写开关不进模型可见面）；`limit` 只对 `ontology.search_documents` 声明 `maximum: 20`（spec §5 只对它定了上限），其余带 `limit` 的工具只声明 `default: 20`。
  描述用能力词（工艺图谱 / 节点 / 关系 / 邻域 / 路径 / 决策链 / 血缘 / 依据来源 / 跳数），`ontology.query` 描述含"高级""优先使用专用工具""没有结果不等于图谱里没有数据"。
- [ ] **Step 3b: 补一条反向断言（对应 F7/N3）：**
```ts
it('ontology.reason 不暴露 applyToGraph', () => {
  const reason = tools.find((t) => t.name === 'ontology.reason')!;
  expect(Object.keys((reason.params as any).properties)).not.toContain('applyToGraph');
});
```
- [ ] **Step 4: 运行，确认通过。** 同 Step 2 命令。
- [ ] **Step 5: 提交。** `git commit -m "feat(connectors): define ontology tool surface (11 read-only tools)"`

---

## Task 3: Main 执行器

**Files:**
- Create: `apps/desktop/electron/main/ontology-tools.ts`
- Test: `apps/desktop/test/ontology-tools.test.ts`

**Interfaces:**
- Consumes: `SparkiiOntoGraph`（Task 1）、`sparkiiOntoConnector`（Task 2）、`knowledgeBackendSettings('sparkiionto', settings)`、Main 的凭据访问器
- Produces: `export async function executeOntologyTool(input: { toolName: string; args: Record<string, unknown>; profileId: string; settings: AppSettings; credential: string | null; fetch?: typeof fetch; now?: () => number }): Promise<{ ok: boolean; data?: unknown; empty?: boolean; truncated?: boolean; error?: { code: string; message: string } }>`；`export function ontologyAuditSummary(toolName: string, args: Record<string, unknown>, result: unknown): string`；`export function resolveOntologyDefaultDomain(settings: AppSettings, profileId: string): string | undefined`；`export const TOOL_BUDGET_MS: Record<string, number>`
  `profileId` 必需：`ontology.search_documents` 的 `domainId` 缺省要落到该智能体绑定的默认域，而绑定按 `agentId` 索引（`settings.sparkiionto.bindings[].agentId`）。Task 4 / Task 7 按此签名调用。

- [ ] **Step 1: 写失败测试。**
```ts
it('缺凭据时返回未配置错误，不发请求', async () => {
  const out = await executeOntologyTool({ toolName: 'ontology.graph_summary', args: {}, profileId: 'p1', settings, credential: null });
  expect(out.ok).toBe(false);
  expect(out.error?.message).toContain('设置');
});
it('把 domainId 缺省为该智能体的默认域', async () => {
  const withBinding = { ...settings, sparkiionto: { baseUrl: 'http://127.0.0.1:9380', bindings: [{ agentId: 'p1', defaultDatasetId: 'dom-1' }] } } as AppSettings;
  const bodies: string[] = [];
  await executeOntologyTool({
    toolName: 'ontology.search_documents', args: { query: '窑尾' }, profileId: 'p1',
    settings: withBinding, credential: 't', fetch: captureBody(bodies),
  });
  expect(bodies.join()).toContain('dom-1');
});
it('resolveOntologyDefaultDomain 读绑定', () => {
  expect(resolveOntologyDefaultDomain(withBinding, 'p1')).toBe('dom-1');
  expect(resolveOntologyDefaultDomain(withBinding, 'nobody')).toBeUndefined();
});
it('path 的空结果返回 empty 而不是 error', async () => {
  const out = await executeOntologyTool({ toolName: 'ontology.path', args: { source: 'a', target: 'b' }, profileId: 'p1', settings, credential: 't', fetch: fake404 });
  expect(out).toMatchObject({ ok: true, empty: true });
});
it('预算：query 10s，其余 30s', () => {
  expect(TOOL_BUDGET_MS['ontology.query']).toBe(10_000);
  expect(TOOL_BUDGET_MS.default).toBe(30_000);
});
it('多端点工具在总预算耗尽时失败且不返回部分结果', async () => {
  let t = 0;
  const out = await executeOntologyTool({
    toolName: 'ontology.node', args: { nodeId: 'n1' }, profileId: 'p1',
    settings, credential: 't', fetch: slowFetch, now: () => (t += 20_000),
  });
  expect(out.ok).toBe(false);
  expect(out.data).toBeUndefined();
});
it('query 的审计摘要包含查询全文', async () => {
  const out = await executeOntologyTool({ toolName: 'ontology.query', args: { query: 'SELECT ...' }, profileId: 'p1', settings, credential: 't', fetch: fakeOk });
  expect(ontologyAuditSummary('ontology.query', { query: 'SELECT ...' }, out)).toContain('SELECT ...');
});
it('query 超长响应被截断并置 truncated', async () => { /* 响应体 > 上限 */ });
it('未知工具名被拒绝', async () => { /* CONNECTOR_UNSUPPORTED */ });
```
- [ ] **Step 2: 运行，确认失败。** `node node_modules/vitest/vitest.mjs run apps/desktop/test/ontology-tools.test.ts`
- [ ] **Step 3: 实现 `ontology-tools.ts`。**
  `switch (toolName)` 逐工具调 `SparkiiOntoGraph`；导出 `TOOL_BUDGET_MS = { 'ontology.query': 10_000, default: 30_000 }`。
  **逐工具总预算（spec §6）：** 进入工具时记 `deadline = now() + (TOOL_BUDGET_MS[toolName] ?? TOOL_BUDGET_MS.default)`；多端点工具（`ontology.node` 2 个、`ontology.decision_chain` 3 个）在每次子请求前算 `remaining = deadline - now()`，`remaining <= 0` 立即整体失败（**不返回部分结果**），否则把 `remaining` 作为 `budgetMs` 传给 `requestJson`（Task 1 Step 1b）。
  `ontology.search_documents` 的 `domainId` 缺省经 `resolveOntologyDefaultDomain(settings, profileId)` 解析；`ontology.reason` **不传** `applyToGraph`；结果统一经 `normalizeOntologyResult()`（空数组 / `null` → `empty: true`）；`ontology.query` 结果体超过 `QUERY_MAX_BYTES`（256 KB）时截断并置 `truncated: true`；错误经既有映射转 `{ code, message }`，文案不含 token。
- [ ] **Step 4: 运行，确认通过。** 同 Step 2 命令。
- [ ] **Step 5: 提交。** `git commit -m "feat(desktop): execute ontology tools in main with credentials and guardrails"`

---

## Task 4: 平台接线（五处必须同一次落地）

**Files:**
- Modify: `apps/desktop/electron/main/connector-registry.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`（`handleConnectorRead`）
- Modify: `apps/desktop/electron/main/workflow.ts`（`allTools`）
- Modify: `packages/agent-host/src/tool-registry.ts`（`CONNECTOR_TOOLS`）
- Test: `apps/desktop/test/knowledge-isolation.test.ts`（静态扫描：host/sideEffect、无 `fetch(`、无 agentId 特判）、`apps/desktop/test/ipc.test.ts`（运行时：分发、白名单、审计）

**Interfaces:**
- Consumes: `sparkiiOntoConnector`（Task 2）、`executeOntologyTool`（Task 3）
- Produces: `handleConnectorRead` 在收到 `ontology.*` 时把请求交给 `executeOntologyTool`；`resolveToolDefinitions` 能解析全部 11 个工具名（不再抛 `unknown tool in saddle`）。

- [ ] **Step 1: 写失败测试。** 下面**第 1 条**追加到 `apps/desktop/test/knowledge-isolation.test.ts`（静态源码扫描）；**第 2 条**属运行时用例，落在 Step 1b 的 `apps/desktop/test/ipc.test.ts` 里（那里有 `rt` 入口）：
```ts
it('本体工具全部在 Main 执行且不在 Pi 侧发请求', async () => {
  for (const t of sparkiiOntoConnector.tools) expect(t.host).toBe('main');
  expect(sourceOf('packages/connectors/src/sparkiionto/tools.ts')).not.toMatch(/\bfetch\(/);
});
// ↓ 这一条放进 apps/desktop/test/ipc.test.ts（Step 1b 的落点）
it('未在白名单内的工具名不得被静默执行', async () => {
  // 与 Step 1b 同一入口，放进 apps/desktop/test/ipc.test.ts
  const out = await (rt as any).__onConnectorRead({ requestId: 'r0', toolName: 'ontology.unknown', args: {} });
  expect(out).toMatchObject({ ok: false, error: { code: 'CONNECTOR_DENIED' } });
});
```
- [ ] **Step 1b: 审计断言（spec §8 / D16）。** 这些用例**放进 `apps/desktop/test/ipc.test.ts`**（`knowledge-isolation.test.ts` 是静态源码扫描，承载不了运行时审计）：走既有测试入口 `(rt as any).__onConnectorRead`（**单参回调**，`ipc.test.ts:158-159`；既有调用见 `ipc.test.ts:840`，`profileId`/`sessionId` 由生产侧闭包绑定），并按既有可行写法**断言 `rt.audit.append` 的 mock 调用**（见 `ipc.test.ts:2601-2613` 对 `document.read` 的同一模式；`rt.audit.query` 在测试运行时默认返回 `[]`，读不回来）。追加：
```ts
it('每次本体工具调用恰好写一条审计，且 ontology.query 记查询全文', async () => {
  await (rt as any).__onConnectorRead({ requestId: 'r1', toolName: 'ontology.query', args: { query: 'SELECT ?s WHERE { ?s ?p ?o }' } });
  const appended = rt.audit.append.mock.calls;      // 与 ipc.test.ts:2601-2613 同一写法
  expect(appended).toHaveLength(1);
  const row = JSON.stringify(appended[0]);
  expect(row).toContain('ontology.query');
  expect(row).toContain('SELECT ?s WHERE');
  expect(row).not.toContain('token-');
});
```
另加一条守卫：新建 slot 时 `resolveToolDefinitions(['ontology.graph_summary'], …)` 不抛错（五处接线齐全）。
- [ ] **Step 2: 运行，确认失败。**
- [ ] **Step 3: 落地五处接线点（spec §4）。**
  ① `connector-registry.ts` 连接器数组加 `sparkiiOntoConnector`；② `packages/agent-host/src/tool-registry.ts` 的 `CONNECTOR_TOOLS` 由三连接器扩为四个；③ `apps/desktop/electron/main/workflow.ts` 的 `allTools` 同步；④ **同文件 `runTool` 的 main-host 特判**要覆盖 `ontology.*`（照抄 `document.read` / `knowledge.search` 的既有分支写法，否则流程型智能体的本体工具会落到 stub handler）；⑤ `ipc.ts` 的 `handleConnectorRead` 增加 `if (req.toolName.startsWith('ontology.')) { … }`，**必须插在 `knowledge.search` 分支之前**。
- [ ] **Step 3b: 审计写入（spec §8）。** 照 `handleConnectorRead` 里 `document.read`（`ipc.ts` 约 455-461 行）与 `knowledge.search`（约 493-499 行）的既有写法，在 `ontology.*` 分支执行前后 `rt.audit.append`：`action: 'tool.read'`、`resource: toolName`、`payloadSummary: ontologyAuditSummary(toolName, args, result)`；`ontology.query` 的摘要含查询全文（D16 的唯一豁免）；不记 token、不记服务端原始信封。
- [ ] **Step 4: 运行，确认通过。** 同时跑 `node node_modules/vitest/vitest.mjs run apps/desktop/test/ontology-tools.test.ts apps/desktop/test/knowledge-isolation.test.ts apps/desktop/test/ipc.test.ts`
- [ ] **Step 5: 提交。** `git commit -m "feat(desktop): wire ontology tool surface through connector_read, registry and workflow"`

---

## Task 5: 把本体从 `knowledge.search` 摘除

**Files:**
- Modify: `packages/config/src/schema.ts`、`packages/config/src/types.ts`、`packages/ui/src/patterns/Shell.tsx`、`apps/desktop/src/surface/contract.ts`、`apps/desktop/electron/preload/api-types.ts`、`apps/desktop/electron/main/agent-catalog.ts`
- Modify: `apps/desktop/electron/main/rag-settings.ts`、`apps/desktop/electron/main/rag-search.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/main/workflow.ts`（`knowledge.search` 的本体路由分支）
- Test: `apps/desktop/test/knowledge-settings.test.ts`、`apps/desktop/test/rag-search.test.ts`、`apps/desktop/test/ipc.test.ts`、`apps/desktop/test/agent-catalog.test.ts`、`apps/desktop/test/workflow-knowledge.test.ts`、`apps/desktop/test/knowledge-isolation.test.ts`（四个 profile 的 `knowledge` 逐字段一致）

**Interfaces:**
- Produces: `knowledgeFromManifest()` 返回 `bm25 | sparkiirag`；`knowledge.search` 的**检索链路**不再持有本体分支；`knowledgeClientFor()` **保留三分支**（形参类型写 `'bm25' | KnowledgeBackendId`，即收窄前的并集原样保留；它仍服务 `knowledge.fetch_document` 与渲染侧 `api.openRagDocument`）。

- [ ] **Step 1: 写失败测试。**
```ts
it('manifest 的 sparkiionto 值被拒绝（不再静默压成 bm25）', () => {
  // 用仓库真实导出：packages/config 的 parseProfileManifest，或按 knowledge-isolation.test.ts 的既有用法走 loadProfile
  expect(() => parseProfileManifest({ ...manifest, knowledge: { enabled: true, backend: 'sparkiionto' } })).toThrow();
});
it('knowledgeClientFor 保留本体分支（供 fetch_document / openRagDocument）', () => {
  expect(knowledgeClientFor('sparkiirag', rag, 'k')).not.toBeNull();          // 既有分支保持
  expect(knowledgeClientFor('sparkiionto', rag, 'k')).not.toBeNull();         // F1：保留给 fetch_document / openRagDocument
});
```
并在 `knowledge-isolation.test.ts` 断言四个现存 profile 的 `knowledge` 解析结果与 `main` **逐字段一致**。
- [ ] **Step 2: 运行，确认失败。**
- [ ] **Step 2b: 先产出"判定点 → 保留/删除 → 受影响测试"逐行表（`file:line`）。** **不要用"13 个判定点"这类数字描述范围**——它与今天代码不符（今天 `ipc.ts` 里判定用的 `=== 'sparkiirag'` 只有 1 处，另有约 10 行提到本体但多数必须保留）。表里每一行标注 `删除` / `保留` / `改写测试`，作为本任务唯一的改动范围依据。
  **删除集（仅这些）：** `packages/config/src/schema.ts`、`packages/config/src/types.ts`、`packages/ui/src/patterns/Shell.tsx`、`apps/desktop/src/surface/contract.ts`、`apps/desktop/electron/preload/api-types.ts`、`apps/desktop/electron/main/agent-catalog.ts` 里 `manifest.knowledge.backend` 的 `sparkiionto` 取值；`rag-settings.ts` 的 `knowledgeFromManifest` 本体分支（回到 `bm25 | sparkiirag` 两分支）；`rag-search.ts` 的 **knowledge.search 检索链路**本体分支与 `unconfiguredFor` / `emptyCorpusFor` 的本体文案；`ipc.ts` 与 `workflow.ts` 中 `knowledge.search` 的本体路由分支。
  **保留集（越界即破坏 §7 资产）：** `knowledgeClientFor` 的本体分支（它是 `knowledge.fetch_document` 与渲染侧 `api.openRagDocument`（主进程通道名 `sparkii:openRagDocument`，`ipc.ts` 的 `ipcMain.handle`）共用的客户端工厂——删了会让本体文档的原文下载静默走 RAG 客户端）；`rag-open.ts` 的按后端缓存分段；`rag-grounding.ts` 的 `backend` 字段；`knowledge-settings.ts` / `knowledge-probe.ts` / `provider-catalog.ts` / `runtime.ts` 与 `KnowledgeBackendId` 类型；`ipc.ts` 的探活、接地、拒答、原文下载与 Key 守卫文案。**BM25 与 SparkiiRAG 分支逐字节保持。**
- [ ] **Step 2c: 必须改写的既有断言（不改它们，Step 4 不可能全绿）：** `apps/desktop/test/ipc.test.ts`（本体会话检索与默认域写入那组）、`apps/desktop/test/rag-search.test.ts`、`apps/desktop/test/workflow-knowledge.test.ts`（本体检索分支）。逐条标注"删除 / 改写 / 保留"，并**新增**一条回归断言：`openRagDocument({ backend: 'sparkiionto' })` 仍走本体客户端且落到 onto 缓存分段（证明 F1 类错误不会发生）。
  **`rag-search.test.ts:209-212` 四行是硬约束：`knowledgeClientFor('bm25', …)` 与 `knowledgeClientFor('sparkiionto', …)` 两条断言都必须保留，不得列为"待删"。**
- [ ] **Step 3: 按 Step 2b 的表收敛实现。** 只动表里标 `删除` 的行；每改一处立即跑该文件对应的既有测试，确认只有预期断言变化。
  同时做一处**类型调整**：`knowledgeClientFor` 的形参写成 `'bm25' | KnowledgeBackendId`（`manifest.knowledge.backend` 收窄为两值后，检索链路 `runMainKnowledgeSearch` 仍要传 `bm25`、而 `ipc.ts` 的 `cacheRagFile`/探活传 `KnowledgeBackendId`；只写 `KnowledgeBackendId` 会同时产生 `TS2345` 与 `TS2367`）。
- [ ] **Step 4: 运行回归。** `node node_modules/vitest/vitest.mjs run apps/desktop/test/knowledge-settings.test.ts apps/desktop/test/rag-search.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/agent-catalog.test.ts apps/desktop/test/workflow-knowledge.test.ts apps/desktop/test/knowledge-isolation.test.ts apps/desktop/test/settings-knowledge-pane.test.tsx`
- [ ] **Step 5: 提交。** `git commit -m "refactor(knowledge): drop sparkiionto backend from knowledge.search"`

---

## Task 6: 设置页（绑定判定 + 图谱自检）

**Files:**
- Modify: `apps/desktop/src/shell/SettingsKnowledgePane.tsx`
- Modify: `apps/desktop/electron/main/agent-catalog.ts`、`apps/desktop/electron/main/ipc.ts`（`sparkii:listAgents` 载荷）、`apps/desktop/electron/preload/api-types.ts`、`apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/settings-knowledge-pane.test.tsx`、`apps/desktop/test/agent-catalog.test.ts`

**Interfaces:**
- Produces: `sparkii:probeOntologyGraph()` → `{ ok: boolean; nodeCount?: number; edgeCount?: number; nodeTypes?: Record<string, number>; error?: string }`；`listAgents` 的每一项新增 `declaresOntologyTools: boolean`（由 `manifest.capabilities.tools` 派生），供设置页判定；Onto 组的"默认知识域"行改为按**工具声明**判定（声明了 `ontology.*` 的智能体才出现）。
  说明：renderer 今天拿不到工具声明（`agent-catalog.ts` 的 `AgentListItem` 与 `sparkii:listAgents` 只回 `knowledge`），所以判定必须先打通这条链路，否则本任务无法实现（这是 Task 6 的前置改动，不是可选优化）。

- [ ] **Step 1: 写失败测试。**
```tsx
it('无本体智能体时默认域行不渲染', () => { /* 四个现存 agent → 不出现 onto-default-domain */ });
it('声明 ontology.search_documents 的智能体出现并写入 sparkiionto.bindings', () => { /* 假 agent 列表 */ });
it('图谱自检行展示节点与边数量', async () => { /* mock probeOntologyGraph → 6 / 5 */ });
it('图里没有数据时给出"图谱暂无数据"', async () => { /* mock → 0 / 0 */ });
```
- [ ] **Step 2: 运行，确认失败。**
- [ ] **Step 3: 实现。** 判定函数取智能体 `capabilities.tools` 里是否存在 `ontology.search_documents`；自检行读新 IPC；自检失败不阻断保存。
- [ ] **Step 4: 运行，确认通过。**
- [ ] **Step 5: 提交。** `git commit -m "feat(settings): bind ontology default domain by tool declaration and show graph self-check"`

---

## Task 7: 真实服务端到端

**Files:**
- Create: `apps/desktop/test/ontology-e2e.test.ts`

**Interfaces:**
- Consumes: `executeOntologyTool`（Task 3）
- Produces: 在存在 `SPARKII_ONTO_E2E_BASE_URL` 与 `SPARKII_ONTO_E2E_TOKEN` 时执行、否则 `describe.skip` 的端到端用例。

- [ ] **Step 1: 写用例。** 断言：`ontology.search_documents` 命中；`ontology.search_nodes` 命中；`ontology.graph_summary` 返回非零计数；`ontology.provenance` 返回至少一条记录；`ontology.decisions` 返回空且 `empty === true`；`ontology.path` 在真实服务上**要么返回路径、要么返回 `empty`，不得抛异常**（对端缺陷口径，spec §13）。
- [ ] **Step 2: 无凭据时确认跳过。** `node node_modules/vitest/vitest.mjs run apps/desktop/test/ontology-e2e.test.ts` → 全部 skipped。
- [ ] **Step 3: 有服务时跑通。** 在 WSL 起服务、导出 `SPARKII_ONTO_E2E_BASE_URL=http://127.0.0.1:9380` 与 `SPARKII_ONTO_E2E_TOKEN=$(cat ~/sparkiionto-deploy/token-desktop)`，再跑同一条命令，记录输出末行。
- [ ] **Step 4: 提交。** `git commit -m "test(desktop): add opt-in ontology end-to-end against a real service"`

---

## Task 8: 文档与交付说明

**Files:**
- Modify: `docs/references/sparkiionto-api.md`（§6 按实测修正：清单不全，需补 `/api/v1/onto/graph/*`、`/compliance`、词汇与记忆族，并澄清血缘端点两处并存）
- Modify: `docs/superpowers/specs/2026-09-22-sparkiionto-ontology-tools-design.md`（回填实施期事实，例如 `limit` 上限、响应体上限取值）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 修正契约文档 §6。** 补 `/api/v1/onto/graph/*`、修正血缘端点、补 Explorer 面的方法判权说明与用户管理现状。
- [ ] **Step 2: 回填 spec。** §12 的待确认项逐条给出结论；§5 的工具表补 `limit` 上限与 `query` 响应体上限的实际取值。
- [ ] **Step 3: 写交付说明（已知边界）。** 至少三条：① 图里暂无本体数据，因果结论需图谱内容就绪；② `path` / `distance_matrix` / `reason` / `query` 在对端修复前会返回 `empty` 或 403；③ 本体文档检索改由 `ontology.search_documents` 承担，`knowledge.search` 不再连本体。
- [ ] **Step 4: 提交。** `git commit -m "docs(ontology): record the ontology tool surface and its delivery boundaries"`

---

## Task 9: 连接器层其余只读能力族（**独立任务**，仅依赖 Task 1，可在其之后任意时间执行）

**Files:**
- Create/Modify: `packages/connectors/src/sparkiionto/read-families.ts`（或并入 `graph.ts`，二选一，提交信息写明）
- Test: `packages/connectors/test/sparkiionto-read-families.test.ts`
- Fixtures: `packages/connectors/test/fixtures/sparkiionto/`（新增 `analytics.body`、`temporal-bounds.body`、`temporal-snapshot.body`、`vocabulary-schemes.body`、`vocabulary-concepts.body`、`vocabulary-hierarchy.body`、`audit-denied.body`、`annotations.body`、`memories.body`、`markdown-read.body`）

**Interfaces:**
- Consumes: `SparkiiOntoClient` 的传输（Task 1 已放宽）
- Produces: 类型化只读方法，每族至少 1 个——`analytics()`、`temporalBounds()`、`temporalSnapshot(at)`、`vocabularySchemes()`、`vocabularyConcepts()`、`vocabularyHierarchy()`、`auditEntries()`、`annotations()`、`memories()`、`markdown(kind, resourceId)`。
  **它们不注册为工具**（模型不可见，D3）；`auditEntries()` 在本轮凭据下恒 403（缺 `audit:read`），只做离线映射契约测试。

- [ ] **Step 1: 抓 fixture。** 有服务时逐端点抓真实响应（`audit` 抓到的就是 403 `{"detail":"action denied"}`）；无服务时按 Task 1 Step 2 的退路处理并标记 `pending-live-capture`。
- [ ] **Step 2: 写失败测试。** 每族 1 例：成功响应按类型裁剪；`auditEntries()` 断言 `code: 'CONNECTOR_DENIED'` 且文案提到权限（这条证明 F12 的边界：审计族只做离线契约，不作为产品能力承诺）。
- [ ] **Step 3: 实现。** 复用 `requestJson`；结果裁剪为各族的类型化形状，不返回服务端原始信封。
- [ ] **Step 4: 运行。** `node node_modules/vitest/vitest.mjs run packages/connectors/test/sparkiionto-read-families.test.ts`
- [ ] **Step 5: 提交。** `git commit -m "feat(connectors): cover remaining ontology read families at the connector layer"`

---

## Self-review

| Spec 条目 | 覆盖任务 |
| --- | --- |
| D1 只读、凭据不升级 | Task 3、Task 4 |
| D2/D15 对端缺口不裁剪本端能力 | Task 1（404 归一化）、Task 2（11 个工具全量）、Task 7 |
| D3 工具层 / 连接器层分离 | Task 1、Task 2、**Task 9** |
| D4 命名空间 `ontology.*` | Task 2 |
| D5 优先产品面 | Task 1 |
| D6 路由分层 | Task 5 |
| D7 不静默跨后端回退 | Task 5 |
| D8 空结果语义 | Task 1、Task 3 |
| D9 host main、凭据不出 Main | Task 4 |
| D10 不改智能体 | 全局约束 + Task 5 的逐字段一致断言 |
| D11 两套错误封装 | Task 1 |
| D12 不引入 MCP | 无任务（非目标） |
| D13/D14 摘除本体文档检索、删除枚举 | Task 5 |
| D16 `ontology.query` 高级定位与护栏 | Task 2、Task 3、Task 6 |
| §13 移交项 1/2/6/7 | Task 1、Task 7、Task 8 |
| §13 移交项 3/4/5 | Task 8 交付说明 |
| §8 审计（含 `ontology.query` 全文豁免） | Task 4 Step 3b |
| §11 契约测试 / 唯一性 / 隔离 / E2E / 回归 | Task 1、2、4、5、7、**9** |

**任务顺序：** Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8；**Task 9 独立**（仅依赖 Task 1），可在 Task 1 之后任意时间执行，不阻塞主线。

**类型一致性**：`executeOntologyTool` 的返回形状（`ok` / `data` / `empty` / `truncated` / `error`）在 Task 3 定义、Task 4 与 Task 7 消费；`SparkiiOntoGraph` 的方法签名在 Task 1 定义、Task 3 消费；工具名在 Task 2 定义、Task 3 的 `switch` 与 Task 4 的 `startsWith('ontology.')` 分发共用同一字面前缀。
