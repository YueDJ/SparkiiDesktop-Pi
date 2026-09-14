# 财务采购审核智能体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 克隆合同审核，落地财务采购审核智能体：准备页组证据包，TypeScript 按物资编码对齐并套规则，模型只写已命中发现的人话，分析/复核两页同一布局，导出走现有审批门。

**Architecture:** 渲染进程用 `<input type="file">` 读 csv/txt/xlsx，`evaluatePack` 在 `startWorkflow` 之前算完，放入载荷的 `evaluation`。线性引擎无条件步：`document.read` → `knowledge.search`（manifest `backend: bm25`，避免未配置 RAG 时跑死）→ `procurement_write_findings` → `procurement_report`（草稿，不含人的采纳）。发现从 `extractWorkflowResult(entries).review` 读；快照用 `actions.review('evaluation', …)` 落 JSONL。导出走 `actions.requestExport`。不新增连接器，不写 agentId 特判。

**Tech Stack:** React 19 + Vite + Vitest + `@testing-library/react` + `@sparkii/ui` + `xlsx`（`@sparkii/desktop` 依赖，与 connectors 相同）+ 现有 `document.read` / `knowledge.search` / `report.export`。

**Spec:** `docs/superpowers/specs/2026-09-14-procurement-review-agent.md`（产品/界面：`docs/superpowers/specs/2026-09-14-procurement-review-design.md`；逻辑：`docs/superpowers/specs/2026-09-14-procurement-review-logic.md`；视觉：`docs/superpowers/mocks/procurement-review-v1.html`）

## Global Constraints

- `apps/desktop/src/surface/**` 不 import `apps/desktop/agents/**`。
- `apps/desktop/src/platform/agent-surface-bindings.ts` 只许由 `node apps/desktop/scripts/generate-surface-bindings.mjs` 生成。
- 平台 / packages 生产代码禁止 `agentId === 'procurement-review'`（及 `profileId` / `agent.id` 等价特判）。
- 量价时杠只来自 `agent/rules.yaml` + `evaluatePack`；模型不得改 `level` / `dim` / 阈值。
- 没有 `cite.label` 的发现不准进 UI。
- 拉取与上传冲突：`conflicts` 保留两侧，**计算用 upload**。
- v1 获取按钮 disabled；上传用 file input，不用 `readDocumentBytes`。
- `knowledge.backend: bm25`，`picker: hidden`。制度下拉只有默认 / 不使用；`policyKb` 为 `'default' | null`。
- `canStartFull` = 计划 + 任一对照维；完整性审核传空 facts。
- 复核：`actions.review('risk_confirmed', { stepId: 'review', payload: { riskId } })`（ignored / escalated / comment 同合同审核）。
- 测试：Vitest；`pnpm --filter @sparkii/desktop typecheck` 必须过。
- 夹具用合成烟煤 / 石膏 / 镁铬砖 / 硅砂。客户方案不入库。

---

## File Structure

```text
apps/desktop/agents/procurement-review/manifest.yaml
apps/desktop/agents/procurement-review/security/approval.yaml
apps/desktop/agents/procurement-review/security/roles.yaml
apps/desktop/agents/procurement-review/agent/capabilities.ts
apps/desktop/agents/procurement-review/agent/tools.yaml
apps/desktop/agents/procurement-review/agent/workflow.yaml
apps/desktop/agents/procurement-review/agent/rules.yaml
apps/desktop/agents/procurement-review/agent/prompts/system.md
apps/desktop/agents/procurement-review/agent/skills/procurement_write_findings/SKILL.md
apps/desktop/agents/procurement-review/agent/skills/procurement_report/SKILL.md
apps/desktop/agents/procurement-review/agent/knowledge/corpus.json
apps/desktop/agents/procurement-review/ui/pages/home.json
apps/desktop/agents/procurement-review/ui/theme.yaml
apps/desktop/agents/procurement-review/ui/theme/tokens.json
apps/desktop/agents/procurement-review/engine/types.ts
apps/desktop/agents/procurement-review/engine/default-rules.ts
apps/desktop/agents/procurement-review/engine/join.ts
apps/desktop/agents/procurement-review/engine/evaluate.ts
apps/desktop/agents/procurement-review/engine/parse.ts
apps/desktop/agents/procurement-review/fixtures/demo-pack.json
apps/desktop/agents/procurement-review/fixtures/plan.csv
apps/desktop/agents/procurement-review/surface/index.tsx
apps/desktop/agents/procurement-review/surface/pack.tsx
apps/desktop/agents/procurement-review/surface/workbench.tsx
apps/desktop/agents/procurement-review/surface/findings.ts
apps/desktop/agents/procurement-review/surface/title.ts
apps/desktop/agents/procurement-review/surface/styles.css
apps/desktop/agents/procurement-review/surface/report-docx.ts
apps/desktop/test/procurement-engine.test.ts
apps/desktop/test/procurement-parse.test.ts
apps/desktop/test/procurement-findings.test.ts
apps/desktop/test/procurement-surface.test.tsx
apps/desktop/test/procurement-isolation.test.ts
apps/desktop/test/surface-bindings.test.ts
```

---

### Task 1: 确定性引擎 `evaluatePack`

**Files:**
- Create: `apps/desktop/agents/procurement-review/engine/types.ts`
- Create: `apps/desktop/agents/procurement-review/engine/default-rules.ts`
- Create: `apps/desktop/agents/procurement-review/engine/join.ts`
- Create: `apps/desktop/agents/procurement-review/engine/evaluate.ts`
- Create: `apps/desktop/agents/procurement-review/fixtures/demo-pack.json`
- Test: `apps/desktop/test/procurement-engine.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `evaluatePack(input: PackInput): EvaluationSnapshot`；`prepareWorkflowInput(pack, documents)`；`JoinedLine` 字段与规格 §3 一致

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { evaluatePack, prepareWorkflowInput } from '../agents/procurement-review/engine/evaluate.js';
import { DEFAULT_RULES } from '../agents/procurement-review/engine/default-rules.js';

const coal = { id: 'M-煤', code: 'RM-001', name: '烟煤', qty: 2800, unit: '吨', unitPrice: 920 };
const brick = { id: 'M-砖', code: 'SP-203', name: '镁铬砖', qty: 40, unit: '吨', unitPrice: 2680 };

function baseFacts() {
  return {
    stock: [
      { code: 'RM-001', qty: 4200, asOf: '2026-09-13', source: 'upload' as const },
      { code: 'SP-203', qty: 95, asOf: '2026-09-13', source: 'upload' as const },
    ],
    usage: [
      { code: 'RM-001', qty: 2100, days: 90, source: 'upload' as const },
      { code: 'SP-203', qty: 12, days: 90, source: 'upload' as const },
    ],
    deals: [
      ...Array.from({ length: 12 }, (_, i) => ({
        code: 'RM-001', unitPrice: 780, at: `2026-0${(i % 9) + 1}-15`, source: 'upload' as const,
      })),
      ...Array.from({ length: 5 }, () => ({
        code: 'SP-203', unitPrice: 2410, at: '2026-06-01', source: 'upload' as const,
      })),
    ],
    transit: [{ code: 'SP-203', qty: 36, ref: 'PO-883', at: '2026-09-02', source: 'upload' as const }],
  };
}

const ranges = { usageDays: 90 as const, priceMonths: 12 as const, transitDays: 30 as const };

describe('evaluatePack', () => {
  it('marks coal over-cover as high qty and fills joined line', () => {
    const snap = evaluatePack({
      plan: [coal, brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: 'default', ranges, asOf: '2026-09-14',
    });
    const hit = snap.hits.find((h) => h.rowId === 'M-煤' && h.ruleId === 'qty.over-cover');
    expect(hit).toMatchObject({ dim: 'qty', level: 'high' });
    expect(Number(hit!.metrics.coverMonths)).toBeCloseTo(10, 0);
    expect(snap.lines.find((l) => l.id === 'M-煤')).toMatchObject({
      stockQty: 4200, usageQty: 2100, qtyOpen: true,
    });
    expect(snap.closed.qty).toBe(false);
  });

  it('marks coal price high, brick price mid, and closes compliance when policyKb is null', () => {
    const snap = evaluatePack({
      plan: [coal, brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'price.dev-high')).toMatchObject({ rowId: 'M-煤', level: 'high' });
    expect(snap.hits.find((h) => h.ruleId === 'price.dev-mid')).toMatchObject({ rowId: 'M-砖', level: 'mid' });
    expect(snap.closed.compliance).toBe(true);
    expect(snap.hits.some((h) => h.dim === 'compliance')).toBe(false);
  });

  it('marks brick in-transit as time duplicate', () => {
    const snap = evaluatePack({
      plan: [brick], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'time.duplicate')).toMatchObject({
      rowId: 'M-砖', dim: 'time', level: 'mid',
    });
  });

  it('closes qty on a line that has stock but no usage', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: { ...baseFacts(), usage: [] },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.lines[0].qtyOpen).toBe(false);
    expect(snap.closed.qty).toBe(true);
    expect(snap.hits.some((h) => h.dim === 'qty')).toBe(false);
  });

  it('emits dims-closed on a thin pack', () => {
    const thin = evaluatePack({
      plan: [coal],
      facts: { stock: [], usage: [], deals: [], transit: [] },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(thin.closed).toEqual({ qty: true, price: true, time: true, compliance: true });
    expect(thin.hits.some((h) => h.ruleId === 'completeness.dims-closed')).toBe(true);
    expect(thin.banner).toMatch(/未评估/);
  });

  it('closes qty/price/time for a line without material code', () => {
    const snap = evaluatePack({
      plan: [{ id: 'x', code: null, name: '杂项', qty: 1, unit: '个', unitPrice: 10 }],
      facts: baseFacts(), rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.lines[0]).toMatchObject({ qtyOpen: false, priceOpen: false, timeOpen: false });
    expect(snap.hits.some((h) => h.ruleId === 'completeness.missing-code')).toBe(true);
  });

  it('uses upload stock for coverMonths and still records the pull conflict', () => {
    const facts = baseFacts();
    facts.stock.push({ code: 'RM-001', qty: 100, asOf: '2026-09-13', source: 'pull' });
    const snap = evaluatePack({
      plan: [coal], facts, rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.conflicts.some((c) => c.code === 'RM-001' && c.field === 'stock' && c.pull === 100 && c.upload === 4200)).toBe(true);
    expect(snap.lines[0].stockQty).toBe(4200);
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')!.cite.label).toMatch(/100/);
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')!.cite.label).toMatch(/4200/);
  });

  it('cites stale stock against pack.asOf when requestDate is missing', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: {
        stock: [{ code: 'RM-001', qty: 4200, asOf: '2026-08-01', source: 'upload' }],
        usage: [{ code: 'RM-001', qty: 2100, days: 90, source: 'upload' }],
        deals: [],
        transit: [],
      },
      rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
    });
    expect(snap.hits.find((h) => h.ruleId === 'qty.over-cover')?.cite.label).toMatch(/库存可能不是当天/);
  });

  it('does not raise price.dev-high when the last deal is older than staleMonths but inside priceMonths', () => {
    const snap = evaluatePack({
      plan: [coal],
      facts: {
        stock: [],
        usage: [],
        deals: Array.from({ length: 4 }, () => ({
          code: 'RM-001', unitPrice: 780, at: '2025-01-01', source: 'upload' as const,
        })),
        transit: [],
      },
      rules: DEFAULT_RULES, policyKb: null,
      ranges: { usageDays: 90, priceMonths: 24, transitDays: 30 },
      asOf: '2026-09-14',
    });
    expect(snap.hits.some((h) => h.ruleId === 'price.dev-high')).toBe(false);
  });

  it('prepareWorkflowInput blanks query when policyKb is null', () => {
    const pack = {
      plan: [coal], facts: baseFacts(), rules: DEFAULT_RULES,
      policyKb: null as const, ranges, asOf: '2026-09-14',
    };
    expect(prepareWorkflowInput(pack, ['C:/plan.csv']).query).toBe('');
    expect(prepareWorkflowInput({ ...pack, policyKb: 'default' }, ['C:/plan.csv']).query).toMatch(/烟煤/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 写最小实现**

`DEFAULT_RULES` 与规格 yaml 相同。`evaluatePack` 按规格 §3.1–3.2：join 到编码，窗口用 `ranges`，计算优先 upload。中位数偶数笔取两中值平均。`prepareWorkflowInput` 调 `evaluatePack`；`query` 在 `policyKb===null` 时为 `""`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/engine apps/desktop/agents/procurement-review/fixtures apps/desktop/test/procurement-engine.test.ts
git commit -m "feat(procurement): add deterministic evaluatePack engine"
```

---

### Task 2: 表解析

**Files:**
- Create: `apps/desktop/agents/procurement-review/engine/parse.ts`
- Create: `apps/desktop/agents/procurement-review/fixtures/plan.csv`
- Test: `apps/desktop/test/procurement-parse.test.ts`

**Interfaces:**
- Consumes: `PlanLine` `FactTables` `SourceKind`
- Produces: `parseCsv` `parseXlsxBuffer` `parsePlanTable` `parseFactTable`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { parseCsv, parsePlanTable, parseFactTable } from '../agents/procurement-review/engine/parse.js';

describe('parse tables', () => {
  it('parseCsv reads a header row', () => {
    const rows = parseCsv('物资编码,物资名称,申请数量\nRM-001,烟煤,2800\n');
    expect(rows[0]).toMatchObject({ 物资编码: 'RM-001', 物资名称: '烟煤', 申请数量: '2800' });
  });

  it('maps Chinese headers to plan lines', () => {
    const lines = parsePlanTable([
      { 物资编码: 'RM-001', 物资名称: '烟煤', 申请数量: '2800', 单位: '吨', 预估单价: '920' },
    ], 'upload');
    expect(lines[0]).toMatchObject({ code: 'RM-001', name: '烟煤', qty: 2800, unitPrice: 920 });
  });

  it('maps stock / usage / deals / transit aliases', () => {
    expect(parseFactTable('stock', [{ 物资编码: 'RM-001', 库存数量: '4200', 快照日期: '2026-09-13' }], 'pull')[0]).toMatchObject({
      code: 'RM-001', qty: 4200, asOf: '2026-09-13', source: 'pull',
    });
    expect(parseFactTable('usage', [{ 编码: 'RM-001', 领用数量: '2100', 天数: '90' }], 'upload')[0].qty).toBe(2100);
    expect(parseFactTable('deals', [{ 物资编码: 'RM-001', 单价: '780', 成交日期: '2026-01-01' }], 'upload')[0].unitPrice).toBe(780);
    expect(parseFactTable('transit', [{ 物资编码: 'SP-203', 数量: '36', 单号: 'PO-883', 日期: '2026-09-02' }], 'upload')[0].ref).toBe('PO-883');
  });

  it('skips fact rows with no code', () => {
    expect(parseFactTable('stock', [{ 物资名称: '烟煤', 库存数量: '1', 快照日期: '2026-09-13' }], 'upload')).toEqual([]);
  });
});
```

`fixtures/plan.csv` 写四行合成计划，供 Task 7 使用。`parseXlsxBuffer` 用 `xlsx` 读第一张表为 AOA 再当 csv；本任务可只测 `parseCsv`，但函数必须导出。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-parse.test.ts`

Expected: FAIL。

- [ ] **Step 3: 写最小实现**

表头别名（去空格、大小写不敏感）：`物资编码|编码|code`，`物资名称|名称|name`，`申请数量|数量|qty`，`单位|unit`，`预估单价|单价|unitPrice`；库存 `库存数量|qty` + `快照日期|asOf`；领用 `领用数量|qty` + `天数|days`；成交 `成交单价|单价|unitPrice` + `成交日期|at`；在途 `数量|qty` + `单号|ref` + `日期|at`。数字 `Number(s.replace(/,/g, ''))`。

在 `apps/desktop/package.json` 加上 `"xlsx":` 与 `@sparkii/connectors` 相同的版本范围。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-parse.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/engine/parse.ts apps/desktop/agents/procurement-review/fixtures/plan.csv apps/desktop/test/procurement-parse.test.ts apps/desktop/package.json
git commit -m "feat(procurement): parse plan and fact tables from csv"
```

---

### Task 3: Agent 壳、skill、sanitizeFindings

**Files:**
- Create: 规格 §5 所列 manifest / security / agent / skills（无完整 surface）
- Create: `apps/desktop/agents/procurement-review/agent/knowledge/corpus.json`
- Create: `apps/desktop/agents/procurement-review/ui/pages/home.json`
- Create: `apps/desktop/agents/procurement-review/ui/theme.yaml`
- Create: `apps/desktop/agents/procurement-review/ui/theme/tokens.json`
- Create: `apps/desktop/agents/procurement-review/surface/findings.ts`
- Create: `apps/desktop/agents/procurement-review/surface/index.tsx`（先 `export default function ProcurementSurface() { return null; }`）
- Test: `apps/desktop/test/procurement-findings.test.ts`

**Interfaces:**
- Consumes: `EvaluationSnapshot` `RuleHit`
- Produces: `sanitizeFindings(raw: unknown, snap: EvaluationSnapshot): Finding[]`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeFindings } from '../agents/procurement-review/surface/findings.js';
import type { EvaluationSnapshot } from '../agents/procurement-review/engine/types.js';

const snap: EvaluationSnapshot = {
  lines: [],
  hits: [{
    id: 'h1', rowId: 'M-煤', dim: 'qty', level: 'high', ruleId: 'qty.over-cover',
    metrics: { coverMonths: 10 }, cite: { label: '覆盖>4个月', refs: [] },
  }],
  closed: { qty: false, price: true, time: true, compliance: true },
  conflicts: [],
};

describe('sanitizeFindings', () => {
  it('keeps findings whose hitId exists and forces hit level/dim', () => {
    const out = sanitizeFindings({
      findings: [
        { id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'low', title: '烟煤可覆盖约 10 个月', reason: '库里多', advice: '核减', cite: { label: '覆盖>4个月' }, hitId: 'h1' },
        { id: 'r2', rowId: 'M-煤', dim: 'price', level: 'high', title: '价格正常', reason: '我觉得还行', advice: '', cite: { label: '无' }, hitId: 'nope' },
        { id: 'r3', rowId: 'M-煤', dim: 'qty', level: 'high', title: '无依据', reason: 'x', advice: 'y', cite: { label: '' }, hitId: 'h1' },
      ],
    }, snap);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 'high', dim: 'qty', title: '烟煤可覆盖约 10 个月' });
  });

  it('accepts workflow_step_end review output as a JSON string', () => {
    const raw = JSON.stringify({
      findings: [{ id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'high', title: '烟煤可覆盖约 10 个月', reason: 'x', advice: 'y', cite: { label: '覆盖>4个月' }, hitId: 'h1' }],
    });
    expect(sanitizeFindings(raw, snap)).toHaveLength(1);
  });

  it('drops compliance when that dim is closed', () => {
    expect(sanitizeFindings({
      findings: [{ id: 'c1', rowId: 'M-煤', dim: 'compliance', level: 'mid', title: '越权', reason: '猜的', advice: '补签', cite: { label: '第12条' }, hitId: '' }],
    }, snap)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-findings.test.ts`

Expected: FAIL。

- [ ] **Step 3: 写最小实现**

`sanitizeFindings`：若 `raw` 是 string 先 `JSON.parse`；量价时/完整性必须 `hitId ∈ snap.hits`；`level`/`dim` 用 hit；空 cite 丢弃；`closed.compliance` 丢弃合规。

`manifest.yaml`：`knowledge.backend: bm25`，`picker: hidden`，其余同规格 §1。

`workflow.yaml` 同规格 §2。SKILL.md 的输入键写 `load` `search` `evaluation`，不要写 `policySnippets`。`procurement_report` 只吃 `review`，不要写采纳状态。

`approval.yaml` / `roles.yaml` 克隆合同审核。

再克隆 `ui/pages/home.json`（`page` 改为 `procurement-review/home`，`widgets: []`）、`ui/theme.yaml`、`ui/theme/tokens.json`。`agent/knowledge/corpus.json` 至少含：

```json
[
  { "id": "pol-12", "text": "战略燃料单行金额达到或超过 200 万元的，应当走集中采购。" }
]
```

空数组会导致默认制度检索无命中。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-findings.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review apps/desktop/test/procurement-findings.test.ts
git commit -m "feat(procurement): add agent manifest, skills, and finding sanitizer"
```

---

### Task 4: 准备页门槛

**Files:**
- Create: `apps/desktop/agents/procurement-review/surface/pack.tsx`
- Create: `apps/desktop/agents/procurement-review/surface/styles.css`
- Modify: `apps/desktop/agents/procurement-review/surface/index.tsx`
- Test: `apps/desktop/test/procurement-surface.test.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `canStartThin` `canStartFull`；`PackUiState` 的 `policyKb: 'default' | null`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProcurementSurface from '../agents/procurement-review/surface/index.js';
import { canStartFull, canStartThin } from '../agents/procurement-review/surface/pack.js';

const empty = { planReady: false, qtyReady: false, priceReady: false, timeReady: false, policyKb: 'default' as const };

describe('pack gates', () => {
  it('allows thin when plan is ready; full when plan plus any fact dim', () => {
    expect(canStartThin(empty)).toBe(false);
    expect(canStartFull(empty)).toBe(false);
    expect(canStartThin({ ...empty, planReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true })).toBe(false);
    expect(canStartFull({ ...empty, planReady: true, qtyReady: true })).toBe(true);
    expect(canStartFull({ ...empty, planReady: true, priceReady: true })).toBe(true);
  });

  it('disables start buttons without a plan and keeps pull disabled', () => {
    render(<ProcurementSurface
      sessionId={null} mode="live" title=""
      session={{ entries: [], streaming: false, status: 'idle', meta: { currentStep: null } }}
      actions={{} as any}
      agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }}
    />);
    expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完整性审核' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /从 OA 获取/ })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 写准备页**

按界面稿三块。计划上传 `aria-label="上传计划"`，`<input type="file" accept=".csv,.txt,.xlsx" hidden>`。v1 获取全部 disabled。制度 `<select>`：`default` / 不使用（`null`）。`canStartThin = planReady`；`canStartFull = planReady && (qtyReady || priceReady || timeReady)`。`.flow` 滚动，`.gate` 固定。本任务点上传可以先把对应维标 ready（Task 7 再接真实 parse）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/surface apps/desktop/test/procurement-surface.test.tsx
git commit -m "feat(procurement): add pack page gates for thin and partial review"
```

---

### Task 5: 分析 / 复核工作台

**Files:**
- Create: `apps/desktop/agents/procurement-review/surface/workbench.tsx`
- Modify: `apps/desktop/agents/procurement-review/surface/index.tsx`
- Modify: `apps/desktop/test/procurement-surface.test.tsx`

**Interfaces:**
- Consumes: `sanitizeFindings` `extractWorkflowResult`（从 `../../../src/surface/normalize.js` — **surface 在 agents 内可以 import src/surface，反向禁止**）
- Produces: `highRiskBlocking(findings, states): boolean`

- [ ] **Step 1: 写失败测试**

条目必须是现网形状：

```tsx
import { vi } from 'vitest';

const evaluation = {
  lines: [{ id: 'M-煤', code: 'RM-001', name: '烟煤', qty: 2800, unit: '吨', unitPrice: 920, stockQty: 4200, usageQty: 2100, medianPrice: null, dealCount: 0, transitQty: null, transitRef: null, qtyOpen: true, priceOpen: false, timeOpen: false }],
  hits: [{ id: 'h1', rowId: 'M-煤', dim: 'qty', level: 'high', ruleId: 'qty.over-cover', metrics: { coverMonths: 10 }, cite: { label: '覆盖>4个月', refs: [] } }],
  closed: { qty: false, price: true, time: true, compliance: false },
  conflicts: [],
};
const findingsJson = {
  findings: [
    { id: 'r1', rowId: 'M-煤', dim: 'qty', level: 'high', title: '烟煤可覆盖约 10 个月', reason: '超过 4 个月', advice: '核减', cite: { label: '覆盖>4个月' }, hitId: 'h1' },
    { id: 'c1', rowId: 'M-煤', dim: 'compliance', level: 'mid', title: '烟煤单行金额超集采线', reason: '超 200 万', advice: '补说明', cite: { label: '《采购管理办法》第12条' }, hitId: '' },
  ],
};
const session = {
  entries: [
    { id: 'e0', kind: 'custom', customType: 'workflow_state', data: { action: 'evaluation', payload: evaluation } },
    { id: 'e1', kind: 'custom', customType: 'workflow_step_end', data: { stepId: 'review', status: 'ok', output: findingsJson } },
  ],
  streaming: false,
  status: 'done',
  meta: { currentStep: 'report' },
};

it('hides adopt on analyze and blocks export while high risk is open', async () => {
  const user = userEvent.setup();
  const review = vi.fn();
  render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{ review } as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
  expect(screen.queryByRole('button', { name: '采纳' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '进入复核' }));
  expect(screen.getByRole('button', { name: '导出' })).toBeDisabled();
  await user.click(screen.getAllByRole('button', { name: '采纳' })[0]);
  expect(review).toHaveBeenCalledWith('risk_confirmed', { stepId: 'review', payload: { riskId: 'r1' } });
});

it('renders compliance as a sibling column not a full-width strip', () => {
  const { container } = render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{} as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
  const conds = container.querySelector('.conds');
  const rule = container.querySelector('.rule-bar');
  expect(rule && conds?.contains(rule) && rule.parentElement === conds).toBe(true);
});
```

有 `workflow_step_end`/`review` 时默认停在分析页（`pack|run|review` 自管，忽略 `meta.currentStep === 'report'`）。采纳后测试若要断言导出可点，需再渲染一条 `workflow_state` `action: 'risk_confirmed'` `payload.riskId: 'r1'`，或让组件在 `review()` 后本地乐观更新；与合同审核同一读法。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 写工作台**

用 `extractWorkflowResult(session.entries).review` + `sanitizeFindings`。分析页无 ops。复核调用 `actions.review`。合规卡放在 `.conds` 内。完整性审核与开始分析都进 `run`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/surface apps/desktop/test/procurement-surface.test.tsx
git commit -m "feat(procurement): add analyze and review workbench"
```

---

### Task 6: 绑定、隔离、标题、导出

**Files:**
- Create: `apps/desktop/agents/procurement-review/surface/title.ts`
- Create: `apps/desktop/agents/procurement-review/surface/report-docx.ts`
- Create: `apps/desktop/test/procurement-isolation.test.ts`
- Modify: `apps/desktop/test/surface-bindings.test.ts`
- Modify: `apps/desktop/src/platform/agent-surface-bindings.ts`（只通过脚本）

**Interfaces:**
- Consumes: 合同审核导出模式（复制 `documentFromHtml` / `bytesToBase64`，不 import contract-review）
- Produces: `procurementSessionTitle(planNo: string | null, fileName: string | null): string`

- [ ] **Step 1: 写失败测试**

```ts
it('binds procurement-review to a component', () => {
  expect(typeof surfaceByAgent['procurement-review']).toBe('function');
});
```

隔离测试复制 `knowledge-isolation.test.ts` 的 walk，断言无：

```ts
/if\s*\(\s*(agent\.id|profileId|agentId)\s*===\s*['"]procurement-review['"]/
```

```ts
expect(procurementSessionTitle('CG20260914021', '9月需求计划.xlsx')).toBe('CG20260914021');
expect(procurementSessionTitle(null, '9月需求计划.xlsx')).toBe('9月需求计划');
expect(procurementSessionTitle(null, null)).toBe('财务采购审核');
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/surface-bindings.test.ts test/procurement-isolation.test.ts`

Expected: FAIL，bindings 无该 key。

- [ ] **Step 3: 生成绑定**

```bash
node apps/desktop/scripts/generate-surface-bindings.mjs
```

导出：复核且 `!highRiskBlocking` 时与合同审核相同：

```ts
actions.requestExport({
  title,
  format: 'docx',
  content: bytesToBase64(bytes),
  path: reportExportPath(workspace, title),
});
```

不改 `connector-registry.ts`。

- [ ] **Step 4: 运行测试与类型检查**

Run:

```bash
pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts test/procurement-findings.test.ts test/procurement-surface.test.tsx test/procurement-isolation.test.ts test/surface-bindings.test.ts
pnpm --filter @sparkii/desktop typecheck
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review apps/desktop/src/platform/agent-surface-bindings.ts apps/desktop/test
git commit -m "feat(procurement): bind surface, isolate platform, and enable export gate"
```

---

### Task 7: 准备 → evaluate → startWorkflow

**Files:**
- Modify: `apps/desktop/agents/procurement-review/surface/index.tsx`
- Modify: `apps/desktop/agents/procurement-review/surface/pack.tsx`
- Modify: `apps/desktop/test/procurement-surface.test.tsx`

**Interfaces:**
- Consumes: `parseCsv` `parsePlanTable` `evaluatePack` `prepareWorkflowInput` `AgentSurfaceActions.startWorkflow` `AgentSurfaceActions.review`
- Produces: 开始分析 / 完整性审核的真实载荷

- [ ] **Step 1: 写失败测试**

```tsx
it('starts workflow with evaluation and persists the snapshot', async () => {
  const user = userEvent.setup();
  const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-1' });
  const review = vi.fn();
  const plan = new File(['物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n'], 'plan.csv', { type: 'text/csv' });
  Object.defineProperty(plan, 'path', { value: 'C:/tmp/plan.csv' });
  render(<ProcurementSurface sessionId={null} mode="live" title="" session={{ entries: [], streaming: false, status: 'idle', meta: {} }} actions={{ startWorkflow, review } as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
  const input = document.querySelector('input[aria-label="上传计划"]') as HTMLInputElement;
  await user.upload(input, plan);
  await user.click(screen.getByRole('button', { name: '完整性审核' }));
  expect(startWorkflow).toHaveBeenCalled();
  const payload = startWorkflow.mock.calls[0][0];
  expect(typeof payload.documents[0]).toBe('string');
  expect(payload.documents[0]).toBe('C:/tmp/plan.csv');
  expect(payload.evaluation.closed).toMatchObject({ qty: true, price: true, time: true });
  expect(payload.query).toMatch(/烟煤/);
  expect(payload.evaluation.hits.some((h: { ruleId: string }) => h.ruleId === 'completeness.dims-closed')).toBe(true);
  await vi.waitFor(() => expect(review).toHaveBeenCalledWith('evaluation', expect.objectContaining({
    stepId: 'review',
    payload: expect.objectContaining({ hits: expect.any(Array) }),
  })));
});

it('starts 开始分析 with open qty after stock and usage files', async () => {
  const user = userEvent.setup();
  const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-2' });
  const plan = new File(['物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n'], 'plan.csv', { type: 'text/csv' });
  const stock = new File(['物资编码,库存数量,快照日期\nRM-001,4200,2026-09-13\n'], 'stock.csv', { type: 'text/csv' });
  const usage = new File(['物资编码,领用数量,天数\nRM-001,2100,90\n'], 'usage.csv', { type: 'text/csv' });
  Object.defineProperty(plan, 'path', { value: 'C:/tmp/plan.csv' });
  render(<ProcurementSurface sessionId={null} mode="live" title="" session={{ entries: [], streaming: false, status: 'idle', meta: {} }} actions={{ startWorkflow, review: vi.fn() } as any} agent={{ id: 'procurement-review', name: 'procurement-review', surfaceType: 'workflow' }} />);
  await user.upload(document.querySelector('input[aria-label="上传计划"]') as HTMLInputElement, plan);
  expect(screen.getByRole('button', { name: '开始分析' })).toBeDisabled();
  await user.upload(document.querySelector('input[aria-label="上传库存"]') as HTMLInputElement, stock);
  await user.upload(document.querySelector('input[aria-label="上传领用"]') as HTMLInputElement, usage);
  expect(screen.getByRole('button', { name: '开始分析' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '开始分析' }));
  const payload = startWorkflow.mock.calls[0][0];
  expect(typeof payload.documents[0]).toBe('string');
  expect(payload.evaluation.closed.qty).toBe(false);
  expect(payload.evaluation.lines[0].stockQty).toBe(4200);
});
```

完整性审核的 `query`：若制度仍是默认，可以非空；断言不要写成必须空。facts 必须是空表。`startWorkflow` 之后用返回的 `sessionId` 再 `review('evaluation')`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`

Expected: FAIL，尚未调 `startWorkflow`。

- [ ] **Step 3: 接线**

完整性审核：`facts` 四表皆 `[]`。开始分析：按已上传文件 `parse*`。`documents` 取 Electron `file.path`，没有 path 则不调用 `startWorkflow`。`const { sessionId } = await actions.startWorkflow(prepareWorkflowInput(pack, documents))`，然后 `actions.review('evaluation', { stepId: 'review', payload: evaluation })`。给库存/领用/成交/在途各自 `aria-label`：`上传库存` `上传领用` `上传成交` `上传在途`。

- [ ] **Step 4: 运行全部采购测试 + typecheck**

Run:

```bash
pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts test/procurement-findings.test.ts test/procurement-surface.test.tsx test/procurement-isolation.test.ts test/surface-bindings.test.ts
pnpm --filter @sparkii/desktop typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/surface apps/desktop/test/procurement-surface.test.tsx
git commit -m "feat(procurement): start workflow from parsed pack and persist evaluation"
```

---

## Self-review

**Spec coverage**

| 规格要求 | 任务 |
|---|---|
| evaluatePack + JoinedLine + 冲突用 upload + 过期 | Task 1 |
| parseCsv / 表头 | Task 2 |
| manifest bm25、skill 键、sanitize 含 JSON 字符串 | Task 3 |
| 门槛：任一维可开始分析 | Task 4 |
| workflow_step_end + actions.review 通道 | Task 5 |
| bindings / 隔离 / 导出 | Task 6 |
| startWorkflow 载荷 + 落 evaluation | Task 7 |
| 不改 LinearRunner / 不特判 agentId | Global |

**Placeholder scan:** Task 4 上传可先只标 ready；Task 7 必须接 parse。无 TBD。

**Type consistency:** `policyKb: 'default' | null`；`riskId`；`EvaluationSnapshot.lines: JoinedLine[]`；skill 输入 `load|search|evaluation`。
