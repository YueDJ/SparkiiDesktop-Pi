# 财务采购审核智能体 — 规格（已确认）

- 日期：2026-09-14
- 状态：**已确认，实现计划按本文拆任务。**
- 产品 / 界面：`2026-09-14-procurement-review-design.md`
- 审核逻辑：`2026-09-14-procurement-review-logic.md`
- 界面稿：`docs/superpowers/mocks/procurement-review-v1.html`
- 对标实现：`apps/desktop/agents/contract-review/`（克隆并改，不另起炉灶）

冲突时：逻辑稿 > 本稿的算法数字；界面稿 > 本稿的布局（门槛与制度下拉以本稿 + 逻辑稿为准，见下方「相对界面稿的例外」）；本稿 > 计划里的文件切分。

**相对界面稿的例外（实现必须遵守）：**

1. 完整性审核不跳过分析页。
2. **开始分析** 在「计划 + 任一量/价/时维已开」时可点，只评已开维；稿里「三维全齐才可点」是演示完整包，不是 v1 门槛。
3. 制度下拉 v1 只有 `采购制度（默认）` 与 `不使用`。稿里的「集团采购办法」不是 v1 能力。
4. 稿里获取按钮全亮、`data-goto="thin"` 直达复核，都是演示。

---

## 1. Agent 身份

| 字段 | 值 |
|---|---|
| `name` | `procurement-review` |
| `displayName` | 财务采购审核 |
| `sortOrder` | `25` |
| `surface.type` | `workflow` |
| `surface.entry` | `surface/index.tsx` |
| `knowledge.enabled` | `true` |
| `knowledge.picker` | `hidden`（平台顶栏不出选库） |
| `knowledge.backend` | `bm25`（与合同审核相同。workflow 里 `knowledge.search` 必跑；未配置 SparkiiRAG 也不会 `CONNECTOR_DENIED`） |
| `capabilities.tools` | `document.read` `knowledge.search` `report.export` |
| `modelRequirements` | `reasoning` |
| 审批 | `report.export` 必须审批；`highRiskDoubleConfirm: true` |

v1 **不**把准备页下拉写入 `setSessionKnowledge`。`picker: hidden` 时 `executeKnowledgeSearch` 只用该 agent 的 `defaultDatasetId` / 本地 BM25 语料。下拉只影响 `policyKb`：`default` 用检索结果写合规；`null`（不使用）时 `query=""`，Surface 丢弃合规发现。

平台层禁止 `agentId === 'procurement-review'` 的组件级特判。Surface 只经生成物 `apps/desktop/src/platform/agent-surface-bindings.ts` 挂上。`apps/desktop/src/surface/**` 不得 import `agents/**`。

改完 manifest 后必须跑：`pnpm --filter @sparkii/desktop gen:surfaces`。

---

## 2. 用户可见流程 vs 引擎

用户只看见三页：**准备 → 分析 → 复核**。UI 页码是 `pack | run | review`，与 `session.meta.currentStep`（引擎步 id，如 `load`/`review`）不是一回事。

线性引擎 **没有条件步**，也没有「停在复核再跑 report」。不要改 `LinearRunner`，不要加 `human` 门。

```
准备页
    ↓  <input type="file"> 读字节（不要 readDocumentBytes：xlsx 被判 unsupported）
parseCsv / parseXlsxBuffer → evaluatePack
    ↓
actions.startWorkflow({ documents, evaluation, query })
    隐藏 load:   document.read（只读 documents[0]，给 skill 原文；数字以 evaluation 为准）
    隐藏 search: knowledge.search（必跑；bm25；policyKb===null 则 query=""）
    skill review: procurement_write_findings（inputs.from = load, search, evaluation）
    skill report: procurement_report（inputs.from = review；此时还没有人的采纳，只出草稿）
分析页：有 workflow_step_end 且 stepId=review 即可「进入复核」（不必等 report）
复核页：actions.review(...) 记采纳
导出：actions.requestExport(...) → report.export 审批门（与合同审核相同）
```

`workflow.yaml`：

```yaml
version: 1
engine: linear
steps:
  - { id: load,    type: tool,  ref: document.read, map: { documents: documents } }
  - { id: search,  type: tool,  ref: knowledge.search, map: { query: query } }
  - { id: review,  type: skill, ref: procurement_write_findings, inputs: { from: [load, search, evaluation] } }
  - { id: report,  type: skill, ref: procurement_report, inputs: { from: review } }
```

`LinearRunner` state 初始是 `ctx.input`，所以 `evaluation` 放在 start 载荷里即可，不是一步。

`startWorkflow` 返回 `sessionId` 之后，立刻：

```ts
actions.review('evaluation', { stepId: 'review', payload: evaluation });
```

历史重放只靠 JSONL：`extractWorkflowResult(entries).review` 取 skill 输出；`customType === 'workflow_state'` 且 `data.action === 'evaluation'` 取快照。不要发明 `kind: 'skill'` 条目。

分析页进度：对齐编码 → 完整性 → 套规则（`closed.qty && closed.price && closed.time` 则跳过）→ 制度（`policyKb===null` 则跳过）→ 撰写发现。没有「报告」点。

---

## 3. 证据包与引擎 API

```ts
export type Dim = 'qty' | 'price' | 'time' | 'compliance' | 'completeness';
export type Level = 'high' | 'mid';
export type SourceKind = 'pull' | 'upload';
export type PolicyKb = 'default' | null;

export interface Cite {
  label: string;
  refs: Array<{ kind: string; id?: string; text?: string }>;
}

export interface PlanLine {
  id: string;
  code: string | null;
  name: string;
  qty: number | null;
  unit: string | null;
  unitPrice: number | null;
  requestDate?: string;
  applicant?: string;
}

export interface JoinedLine extends PlanLine {
  stockQty: number | null;
  usageQty: number | null;
  medianPrice: number | null;
  dealCount: number;
  transitQty: number | null;
  transitRef: string | null;
  qtyOpen: boolean;
  priceOpen: boolean;
  timeOpen: boolean;
}

export interface FactTables {
  stock: Array<{ code: string; qty: number; asOf: string; source: SourceKind }>;
  usage: Array<{ code: string; qty: number; days: number; source: SourceKind }>;
  deals: Array<{ code: string; unitPrice: number; at: string; qty?: number; vendor?: string; source: SourceKind }>;
  transit: Array<{ code: string; qty: number; ref: string; at?: string; source: SourceKind }>;
}

export interface Rules {
  qty: { coverMonthsHigh: number; stockDaysMin: number; coverMonthsLow: number };
  price: { highPct: number; midPct: number; minSamples: number; staleMonths: number };
  time: { defaultWindowDays: number };
  stockStaleDays: number;
}

export interface RuleHit {
  id: string;
  rowId: string;
  dim: Dim;
  level: Level;
  ruleId: string;
  metrics: Record<string, number | string | null>;
  cite: Cite;
}

export interface Conflict {
  code: string;
  field: 'stock' | 'usage' | 'deal' | 'transit' | 'planQty' | 'planPrice';
  pull: number | string;
  upload: number | string;
}

export interface EvaluationSnapshot {
  lines: JoinedLine[];
  hits: RuleHit[];
  closed: { qty: boolean; price: boolean; time: boolean; compliance: boolean };
  conflicts: Conflict[];
  banner?: string;
}

export interface PackInput {
  plan: PlanLine[];
  facts: FactTables;
  rules: Rules;
  policyKb: PolicyKb;
  ranges: { usageDays: 30 | 90 | 180; priceMonths: 6 | 12 | 24; transitDays: 15 | 30 | 60 };
  asOf: string;
}

export function evaluatePack(input: PackInput): EvaluationSnapshot;

export function prepareWorkflowInput(pack: PackInput, documents: string[]): {
  documents: string[];
  evaluation: EvaluationSnapshot;
  query: string;
};

export function parseCsv(text: string): Record<string, string>[];
export function parseXlsxBuffer(buf: ArrayBuffer): Record<string, string>[];
export function parsePlanTable(rows: Record<string, string>[], source: SourceKind): PlanLine[];
export function parseFactTable(
  kind: 'stock' | 'usage' | 'deals' | 'transit',
  rows: Record<string, string>[],
  source: SourceKind,
): FactTables[typeof kind];
```

`query`：`policyKb === null` 为 `""`；否则用各行 `name`、`qty * unitPrice`、`applicant` 拼一句，≤200 字。

默认 `rules.yaml` 与 `DEFAULT_RULES` 相同：

```yaml
qty:
  coverMonthsHigh: 4
  stockDaysMin: 30
  coverMonthsLow: 0.5
price:
  highPct: 0.15
  midPct: 0.05
  minSamples: 3
  staleMonths: 18
time:
  defaultWindowDays: 30
stockStaleDays: 7
```

`ranges.*` 覆盖窗口。`rules.time.defaultWindowDays` 仅在测试未传 ranges 时的后备；产品路径必传 ranges。

领用：界面选的 `ranges.usageDays` 是公式分母。事实表视为「已经是该窗口的合计」；`usage[].days` 只进 cite，不重算。

价：只统计 `at >= asOf - priceMonths` 的成交。

时：只统计无日期、或 `at >= asOf - transitDays` 的在途。

### 3.1 开维

- 无计划行 → 准备页拦，不调用 `evaluatePack`。
- **行级：** 量开 = 有编码且该编码同时有库存与领用且领用合计 > 0。价开 = 有编码、有单价、窗口内成交 ≥ 1。时开 = 有编码且窗口内有在途。无编码：该行量价时全关。
- **包级** `closed.qty` = 没有任何一行 `qtyOpen`（价/时同理）。`closed.compliance` = `policyKb === null`。
- 芯片与维卡片看包级 `closed`。表里某一行该维没开，格子写「—」。
- 缺库存或缺领用：该行量关。不要用模型补。

拉取与上传数字不一致 → `conflicts[]` 必有。**计算用 upload 那一侧的数**（有 upload 时）；cite.label 必须同时写出 pull 与 upload。没有 upload 才用 pull。不得丢任一侧。

库存过期：用 `requestDate`（若缺则用 `pack.asOf`）对比 `stock.asOf`，超过 `stockStaleDays` 则量可跑，cite 含「库存可能不是当天」。成交最后一笔相对同一基准早于 `staleMonths`：**不出** `price.dev-high`。没有单独的 `low` 等级。

### 3.2 规则命中

量：

- `coverMonths = (stock + qty) / (usage / (usageDays/30))`
- `stockDays = stock / (usage / usageDays)`
- `coverMonths > coverMonthsHigh` 且 `stockDays > stockDaysMin` → `qty.over-cover` high
- `coverMonths < coverMonthsLow` → `qty.under-cover` mid

价：

- `median` = 窗口内该编码成交单价中位数（偶数笔：两中值平均）
- `dev = (unitPrice - median) / median`
- `|dev| > highPct` 且样本 ≥ minSamples 且未过期 → `price.dev-high` high
- `midPct < |dev| ≤ highPct` → `price.dev-mid` mid
- 样本 < minSamples 或过期：不编「价格正常」

时：窗口内该编码在途合计 > 0 且本行 `qty > 0` → `time.duplicate` mid。无日期则 cite 写「日期未知」。

完整性：缺编码 / 缺数量 / 缺单位 → `completeness.missing-*` mid。包级三维都关 → 另加 `completeness.dims-closed`，并设 `banner`。

合规：引擎不算条文。skill 只在 `search` 有片段且 `policyKb==='default'` 时写 `dim=compliance`，必须有 cite。Surface 丢弃无 `cite.label`、无 `rowId`、或 `closed.compliance` 的合规条。

---

## 4. Skill 契约

### 4.1 `procurement_write_findings`

`LinearRunner.resolveInputs` 实际喂给 skill 的是：

```json
{
  "load": { "text": "…", "kind": "xlsx" },
  "search": { "chunks": [] },
  "evaluation": { "lines": [], "hits": [], "closed": {}, "conflicts": [], "banner": null }
}
```

`search` 的形状以现网为准：SparkiiRAG 为 `RetrievalResult`（`chunks[].content`、`documentName`）；BM25 为 `{ id, text, score }[]`。SKILL.md 按这两个键写，**不要**指望 `policySnippets`。从 `search` 抽片段是 skill 自己的事。

输出：

```json
{
  "findings": [
    {
      "id": "r1",
      "rowId": "M-煤",
      "dim": "qty",
      "level": "high",
      "title": "烟煤可覆盖约 10 个月",
      "reason": "…",
      "advice": "…",
      "cite": { "label": "库存 2026-09-13 · 领用 14 笔 · 覆盖>4个月", "refs": [] },
      "hitId": "h-qty-RM-001"
    }
  ]
}
```

1. 量 / 价 / 时 / 完整性：`hitId` 必须在 `evaluation.hits`。多写的丢弃。
2. `level` / `dim` 以 hit 为准覆盖模型。
3. 禁止无 hit 的「价格正常」。
4. 合规：仅当 `evaluation.closed.compliance === false` 且 `search` 有片段；必须有 cite。
5. 只输出 JSON。

Surface 用 `sanitizeFindings(extractWorkflowResult(entries).review, snap)`。

### 4.2 `procurement_report`

输入只有 `{ review }`（上一步 skill 的 JSON 文本或已解析对象）。**不要**把采纳状态喂给这一步：线性引擎在人复核之前就会跑完它。

导出时 Surface 用当前 `findings` + `reviewed` 生成 DOCX，再按合同审核同一载荷：

```ts
actions.requestExport({
  title,
  format: 'docx',
  content: bytesToBase64(bytes),
  path: reportExportPath(workspace, title),
});
```

不 resume workflow、不加 human 步。

---

## 5. Surface

```text
apps/desktop/agents/procurement-review/
  manifest.yaml
  security/approval.yaml
  security/roles.yaml
  agent/capabilities.ts
  agent/tools.yaml
  agent/workflow.yaml
  agent/rules.yaml
  agent/prompts/system.md
  agent/skills/procurement_write_findings/SKILL.md
  agent/skills/procurement_report/SKILL.md
  agent/knowledge/corpus.json
  ui/pages/home.json
  ui/theme.yaml
  ui/theme/tokens.json
  engine/types.ts
  engine/default-rules.ts
  engine/join.ts
  engine/evaluate.ts
  engine/parse.ts
  surface/index.tsx
  surface/pack.tsx
  surface/workbench.tsx
  surface/findings.ts
  surface/title.ts
  surface/styles.css
  surface/report-docx.ts
  fixtures/demo-pack.json
  fixtures/plan.csv
```

上传：隐藏 `<input type="file" accept=".csv,.txt,.xlsx">`。解析用 `File.text()` / `arrayBuffer()` → `parseCsv` / `parseXlsxBuffer`（`xlsx` 加到 `@sparkii/desktop`）。**不要**用 `readDocumentBytes` 做表解析。

`document.read` 的 `documents` 必须是 **非空 `string[]` 路径**。Electron 下先用 `window.sparkii.getPathForFile(file)`，测试兜底才用 `(file as File & { path?: string }).path`。没有 path 则不得 `startWorkflow`（测试优先 mock `getPathForFile`，也可 `Object.defineProperty(file, 'path', { value: 'C:/tmp/plan.csv' })`）。禁止 `documents: []`（`no document provided` 会整跑失败）。v1 获取按钮全部 `disabled`。

制度：`<select>` 两项，`default` | 不使用（`null`）。不要 `setSessionKnowledge`。

复核（照抄合同审核通道）：

```ts
actions.review(`risk_${action}`, { stepId: 'review', payload: { riskId: finding.id } });
actions.review('risk_comment', { stepId: 'review', payload: { riskId: finding.id, note } });
```

`action` 为 `confirmed` | `ignored` | `escalated`。再点同一项撤销（再写一次或写 `risk_none`，与合同审核同一套读取逻辑）。高风险未处理完，写入意见 / 导出 disabled。

门槛：

- `canStartThin(pack)` = `planReady`
- `canStartFull(pack)` = `planReady && (qtyReady || priceReady || timeReady)`
- 完整性审核：调用 `evaluatePack` 时 **facts 传空表**（即使已上传对照，本按钮也不用）。
- 开始分析：用已上传的 facts；未开维关闭。

标题：`procurementSessionTitle(planNo, fileName)`。

`loadProfile` 还要求：`ui/pages/home.json`、`ui/theme.yaml`、`ui/theme/tokens.json`、`agent/knowledge/corpus.json`。缺任一文件会 `PROFILE_INVALID`。从合同审核克隆 UI 三件套（`home.json` 的 page 改为 `procurement-review/home`，widgets 可空）。`corpus.json` 必须有合成制度片段（至少一条战略燃料集采线 200 万，与夹具烟煤金额同语义），不得 `[]`。

---

## 6. 平台与测试红线

1. `test/surface-bindings.test.ts` 增加 `procurement-review`。
2. `test/procurement-isolation.test.ts`：生产代码无 `agentId === 'procurement-review'` 特判。
3. Engine：烟煤超覆盖、烟煤价偏、镁铬砖在途、镁铬砖价偏、无编码关维、**有库存无领用关量**、薄路径 dims-closed、冲突用 upload 计算且 conflicts 保留两侧、库存过期 cite、成交过期不升 high、未选用制度无合规 hit。
4. Surface：无计划两按钮不可点；只有计划只能完整性审核；有任一对照维可开始分析；分析页无采纳；`workflow_step_end` + `review` 才进分析；复核高风险未处理不能导出；合规卡是 `.conds` 的子列。
5. 必须有一条测试：`startWorkflow` 载荷含 `documents` `evaluation` `query`，随后 `actions.review('evaluation', …)`。
6. `vitest` 与 `pnpm --filter @sparkii/desktop typecheck` 必须过。

---

## 7. 明确不做

OA/U8 真连接器、多制度库切换、规则配置后台、自动放行、发票/入库、价格预测、工艺图谱、平台级新 tool、改 `LinearRunner` / `runTool` 的 selection、扩展 `readDocumentBytes` 以支持 xlsx。
