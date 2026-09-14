# 财务采购审核 — Minor 收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉架构师终审留下的 M1–M13，以及复审记下的单价残差（`|dev|>15%` 但薄样本/过期时仍应发中风险），全部留在智能体侧。

**Architecture:** 引擎 cite / 行 id / 日历减法 / 单价降级是纯函数改动。准备页错误、`documents` 只传计划路径、窗口选择上提、`setChatTitle` / `appendError` 只调用已有 `window.sparkii`。分析进度读 `session.streaming` + `meta.currentStep`。导出、主题、CSS、夹具、隔离测试不碰平台。

**Tech Stack:** 现有 React 19 + Vitest + Testing Library；不新增依赖；不改 `electron/`、`packages/`、`apps/desktop/src/**`。

**Spec:** `docs/superpowers/specs/2026-09-14-procurement-review-agent.md`（产品：`…-design.md`；逻辑：`…-logic.md`）。本计划附带必须写入 agent spec 的补丁，见文末「Spec patches」。

## Global Constraints

- 智能体是智能体，底座是底座。只改 `apps/desktop/agents/procurement-review/**`、`apps/desktop/test/procurement-*.ts(x)`、以及本计划点名的 spec / fixture。
- 禁止改 `LinearRunner`、connector-registry、Electron 架构、`apps/desktop/src/**`、`electron/**`、`packages/**`。
- `setChatTitle` / `appendError` / `getPathForFile` 只经已有 `window.sparkii`，与合同审核同一桥。禁止 `agentId === 'procurement-review'` 特判。
- 量价时杠只来自 `rules.yaml` + `evaluatePack`。模型不得改 `level` / `dim`。
- `canStartFull` = 计划 + 任一对照维；完整性审核传空 facts。
- `knowledge.backend: bm25`，`picker: hidden`。
- 冲突：`conflicts` 两侧都留，计算用 upload。
- 测试：`pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts test/procurement-findings.test.ts test/procurement-surface.test.tsx test/procurement-isolation.test.ts`。不为桌面包原有 typecheck 失败去改底座。
- 禁止引入 `@testing-library/jest-dom`。断言用 `textContent` / 本文件已有的 `expect.extend` 自定义匹配器。

---

## File Structure

```text
apps/desktop/agents/procurement-review/engine/join.ts          # M13 subtractMonths
apps/desktop/agents/procurement-review/engine/evaluate.ts      # M1 cite, M2 hit ids, residual price
apps/desktop/agents/procurement-review/engine/parse.ts         # M2 line ids, M9 extractPlanNo
apps/desktop/agents/procurement-review/engine/types.ts         # 不新增字段，除非 Task 1 需要 usageCount 局部变量
apps/desktop/agents/procurement-review/surface/pack.tsx        # M3 M4 错误与 documents
apps/desktop/agents/procurement-review/surface/index.tsx       # M8 上提 prefs
apps/desktop/agents/procurement-review/surface/workbench.tsx   # M5 进度, M6 html 无 h1
apps/desktop/agents/procurement-review/surface/title.ts        # 已有；M9 只改调用方
apps/desktop/agents/procurement-review/surface/progress.ts     # 新建：分析进度纯函数
apps/desktop/agents/procurement-review/surface/report-docx.ts  # M6 fallback
apps/desktop/agents/procurement-review/surface/styles.css      # M11
apps/desktop/agents/procurement-review/ui/theme/tokens.json    # M7
apps/desktop/agents/procurement-review/fixtures/demo-pack.json # M10
apps/desktop/agents/procurement-review/fixtures/plan.csv       # M10 引用
apps/desktop/agents/procurement-review/agent/skills/procurement_write_findings/SKILL.md  # hitId 示例
docs/superpowers/specs/2026-09-14-procurement-review-agent.md  # Spec patches
apps/desktop/test/procurement-engine.test.ts
apps/desktop/test/procurement-parse.test.ts
apps/desktop/test/procurement-surface.test.tsx
apps/desktop/test/procurement-isolation.test.ts
```

**不改：** `workflow.yaml`、`LinearRunner`、bindings 生成脚本、连接器。

---

### Task 1: 引擎 — cite、行/命中 id、日历、单价降级

覆盖：M1、M2（hit id）、M13、残差（高偏离 + 薄样本/过期 → mid）。

**Files:**
- Modify: `apps/desktop/agents/procurement-review/engine/join.ts` (`subtractMonths`)
- Modify: `apps/desktop/agents/procurement-review/engine/evaluate.ts` (`buildStockCite`, hit `id`, `evaluatePriceRules`)
- Modify: `apps/desktop/agents/procurement-review/engine/parse.ts` (`parsePlanTable` id)
- Modify: `apps/desktop/agents/procurement-review/agent/skills/procurement_write_findings/SKILL.md`（示例 `hitId`）
- Modify: `docs/superpowers/specs/2026-09-14-procurement-review-agent.md`（§3.1 cite、§3.2 价、parse id）
- Test: `apps/desktop/test/procurement-engine.test.ts`
- Test: `apps/desktop/test/procurement-parse.test.ts`

**Interfaces:**
- Consumes: 现有 `evaluatePack(input: PackInput): EvaluationSnapshot`、`parsePlanTable(rows, source): PlanLine[]`、`subtractMonths(dateStr, months): string`
- Produces: 同上签名。Hit `id` 改为 `h-{dim}-{line.id}-{suffix}`。`parsePlanTable` 的 `id` 恒为 `plan-${index+1}`（1-based）。`buildStockCite` 不导出。

- [ ] **Step 1: Write the failing tests**

在 `procurement-engine.test.ts` 追加：

```ts
import { subtractMonths } from '../agents/procurement-review/engine/join.js';

it('qty cite includes stock date, usage count, and cover band', () => {
  const snap = evaluatePack({
    plan: [coal], facts: baseFacts(), rules: DEFAULT_RULES,
    policyKb: null, ranges, asOf: '2026-09-14',
  });
  const label = snap.hits.find((h) => h.ruleId === 'qty.over-cover')!.cite.label;
  expect(label).toMatch(/库存 2026-09-13/);
  expect(label).toMatch(/领用 1 笔/);
  expect(label).toMatch(/覆盖>4个月/);
});

it('uses unique hit ids when two plan rows share a material code', () => {
  const snap = evaluatePack({
    plan: [
      { ...coal, id: 'plan-1' },
      { ...coal, id: 'plan-2', qty: 3000 },
    ],
    facts: baseFacts(), rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
  });
  const hits = snap.hits.filter((h) => h.ruleId === 'qty.over-cover');
  expect(hits.map((h) => h.id).sort()).toEqual(['h-qty-plan-1-over', 'h-qty-plan-2-over']);
  expect(hits.map((h) => h.rowId).sort()).toEqual(['plan-1', 'plan-2']);
});

it('emits price.dev-mid when |dev| > highPct but samples are thin or stale', () => {
  const thin = evaluatePack({
    plan: [coal],
    facts: {
      stock: [], usage: [], transit: [],
      deals: [{ code: 'RM-001', unitPrice: 780, at: '2026-06-01', source: 'upload' }],
    },
    rules: DEFAULT_RULES, policyKb: null, ranges, asOf: '2026-09-14',
  });
  expect(thin.hits.find((h) => h.ruleId === 'price.dev-mid')).toMatchObject({ rowId: 'M-煤', level: 'mid' });
  expect(thin.hits.some((h) => h.ruleId === 'price.dev-high')).toBe(false);

  const stale = evaluatePack({
    plan: [coal],
    facts: {
      stock: [], usage: [], transit: [],
      deals: Array.from({ length: 4 }, () => ({
        code: 'RM-001', unitPrice: 780, at: '2025-01-01', source: 'upload' as const,
      })),
    },
    rules: DEFAULT_RULES, policyKb: null,
    ranges: { usageDays: 90, priceMonths: 24, transitDays: 30 },
    asOf: '2026-09-14',
  });
  expect(stale.hits.find((h) => h.ruleId === 'price.dev-mid')).toMatchObject({ level: 'mid' });
  expect(stale.hits.some((h) => h.ruleId === 'price.dev-high')).toBe(false);
});

it('subtractMonths clamps to the last day of the target month', () => {
  expect(subtractMonths('2026-08-31', 6)).toBe('2026-02-28');
  expect(subtractMonths('2024-08-31', 6)).toBe('2024-02-29');
  expect(subtractMonths('2026-09-14', 12)).toBe('2025-09-14');
});
```

把现有 `does not raise price.dev-high when the last deal is older…` 改成仍断言无 `dev-high`，并断言有 `dev-mid`（与上面 stale 用例合并亦可，不要留两条互相打架的 stale 断言）。

在 `procurement-parse.test.ts` 追加：

```ts
it('gives unique plan ids when two rows share a material code', () => {
  const lines = parsePlanTable([
    { 物资编码: 'RM-001', 物资名称: '烟煤', 申请数量: '1' },
    { 物资编码: 'RM-001', 物资名称: '烟煤B', 申请数量: '2' },
  ], 'upload');
  expect(lines.map((l) => l.id)).toEqual(['plan-1', 'plan-2']);
  expect(lines.map((l) => l.code)).toEqual(['RM-001', 'RM-001']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts`
Expected: 新用例 FAIL（cite 无领用；hit id 仍含 code；8/31-6 不是 02-28；高偏离薄样本无 hit；parse id 仍是 `RM-001`）。

- [ ] **Step 3: Implement**

`join.ts` — 用年月日分量减月，钳到目标月最后一天；**不要** `Date.setMonth`，也**不要** `toISOString()`（UTC 会把东八区日期推前一天）：

```ts
export function subtractMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  const nd = Math.min(d, last);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}
```

`parse.ts` — `id: \`plan-${index + 1}\``。手写夹具（`id: 'M-煤'`）不受影响。

`evaluate.ts` — hit id 用 `line.id`：

```ts
id: `h-qty-${line.id}-over`   // under / price-high / price-mid / time-dup 同理
```

`buildStockCite` 改为（冲突与过期句保留）：

```
库存 {stockAsOf 或 缺省时 stockQty}
· 领用 {usedUsageRows.length} 笔
· 覆盖>4个月 | 覆盖<0.5个月 | 覆盖约 {round}个月   // 阈值取 input.rules.qty
· 库存可能不是当天（若 stale）
```

冲突时第一段仍是 `拉取库存 {pull} · 上传库存 {upload}`，其后仍接领用笔数与覆盖带。

领用笔数：与计算同源——有 upload 领用则数 upload 行，否则数 pull 行（该编码）。`usage[].days` 不进公式；cite 用笔数，与 spec 示例 `领用 14 笔` 对齐。不要把 `ranges.usageDays` 写进 cite（那是分母，不是笔数）。

`evaluatePriceRules` 第二支改为：

```ts
if (absDev > highPct && line.dealCount >= minSamples && !stale) {
  // price.dev-high
} else if (absDev > midPct) {
  // price.dev-mid  （含 |dev|>highPct 但被样本/过期门挡住的情况）
}
```

非冲突分支的 cite 不再带库存数量，数量只留在 `metrics` / `lines`，由模型写进 `reason` —— 与 mock `库存 2026-09-13 · 领用 14 笔 · 覆盖>4个月` 一致，不要回填。

`subtractDays` 本轮不动（`toISOString()` 在负时区会差一天，属既有问题，已列 Out of scope）。`subtractMonths` 已导出，不要改导出表。

SKILL.md 示例 `hitId` 改为 `h-qty-M-煤-over`（夹具行 id 仍是 `M-煤`）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts`
Expected: PASS。现有冲突 cite 仍同时匹配 `100` 与 `4200`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/engine/join.ts \
  apps/desktop/agents/procurement-review/engine/evaluate.ts \
  apps/desktop/agents/procurement-review/engine/parse.ts \
  apps/desktop/agents/procurement-review/agent/skills/procurement_write_findings/SKILL.md \
  docs/superpowers/specs/2026-09-14-procurement-review-agent.md \
  apps/desktop/test/procurement-engine.test.ts \
  apps/desktop/test/procurement-parse.test.ts
git commit -m "fix(procurement): unique row hits, qty cite, and mid-price fallback"
```

---

### Task 2: 准备页 — 可见错误、只传计划路径、窗口上提、会话标题

覆盖：M3、M4、M8、M9。

**Files:**
- Modify: `apps/desktop/agents/procurement-review/engine/parse.ts`（新增 `extractPlanNo`）
- Modify: `apps/desktop/agents/procurement-review/surface/pack.tsx`
- Modify: `apps/desktop/agents/procurement-review/surface/index.tsx`
- Unchanged: `apps/desktop/agents/procurement-review/surface/workbench.tsx` —— 标题回退 `workbench.tsx:245` 已经是 `sessionTitle?.trim() || procurementSessionTitle(null, session.meta.inputs?.[0]?.name ?? null)`，M9 只在 `pack.tsx` 侧发 `setChatTitle`，本任务**不改** workbench。
- Modify: `docs/superpowers/specs/2026-09-14-procurement-review-agent.md`（§5：路径、documents、标题、错误）
- Test: `apps/desktop/test/procurement-parse.test.ts`
- Test: `apps/desktop/test/procurement-surface.test.tsx`

**Interfaces:**
- Consumes: `startPackWorkflow`、`PackPage`、`procurementSessionTitle(planNo, fileName)`
- Produces:

```ts
export function extractPlanNo(rows: Record<string, string>[]): string | null;

export type PackPrefs = {
  policyKb: 'default' | null;
  planRange: string;
  usageDays: '30' | '90' | '180';
  priceMonths: '6' | '12' | '24';
  transitDays: '15' | '30' | '60';
};
export const DEFAULT_PACK_PREFS: PackPrefs;

export async function startPackWorkflow(
  mode: 'thin' | 'full',
  files: PackFiles,
  ctx: { policyKb: PolicyKb; ranges: PackInput['ranges'] },
  actions: AgentSurfaceActions,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
```

`PackPage` 改为受控：`prefs: PackPrefs` + `onPrefs: (next: PackPrefs) => void`。`index.tsx` 持有 `files` 与 `prefs`；`sessionId` 变化时两者一起重置。

- [ ] **Step 1: Write the failing tests**

`procurement-parse.test.ts`：

```ts
import { extractPlanNo } from '../agents/procurement-review/engine/parse.js';

it('extracts planNo from 计划单号 / planNo', () => {
  expect(extractPlanNo([{ 计划单号: 'PR-202609-01', 物资编码: 'RM-001' }])).toBe('PR-202609-01');
  expect(extractPlanNo([{ planNo: 'P-9', 物资编码: 'RM-001' }])).toBe('P-9');
  expect(extractPlanNo([{ 物资编码: 'RM-001' }])).toBe(null);
});
```

`procurement-surface.test.tsx`（沿用现有 `csvFile` / `upload`）：

```ts
it('passes only the plan path as documents even when facts are uploaded', async () => {
  const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-docs' });
  const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n', 'C:/tmp/plan.csv');
  const stock = csvFile('stock.csv', '物资编码,库存数量,快照日期\nRM-001,4200,2026-09-13\n', 'C:/tmp/stock.csv');
  const usage = csvFile('usage.csv', '物资编码,领用数量,天数\nRM-001,2100,90\n', 'C:/tmp/usage.csv');
  render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
  upload('上传计划', plan);
  upload('上传库存', stock);
  upload('上传领用', usage);
  fireEvent.click(screen.getByRole('button', { name: '开始分析' }));
  await waitFor(() => expect(startWorkflow).toHaveBeenCalled());
  expect(startWorkflow.mock.calls[0][0].documents).toEqual(['C:/tmp/plan.csv']);
});

it('shows an alert when startWorkflow fails', async () => {
  const startWorkflow = vi.fn().mockRejectedValue(new Error('start failed'));
  const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n', 'C:/tmp/plan.csv');
  render(<ProcurementSurface sessionId="prev" mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
  upload('上传计划', plan);
  fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
  // @testing-library/jest-dom is NOT installed (see test/setup.ts); use textContent.
  await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/未能开始|start failed/));
});

it('shows an alert when the plan path cannot be resolved', async () => {
  const startWorkflow = vi.fn();
  const plan = csvFile('plan.csv', '物资编码,物资名称,申请数量,单位,预估单价\nRM-001,烟煤,2800,吨,920\n'); // 无 path，无 sparkii
  render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
  upload('上传计划', plan);
  fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toMatch(/路径/));
  expect(startWorkflow).not.toHaveBeenCalled();
});

it('publishes the session title via window.sparkii.setChatTitle after start', async () => {
  const setChatTitle = vi.fn().mockResolvedValue({ ok: true });
  (window as any).sparkii = { getPathForFile: (file: File) => `C:/tmp/${file.name}`, setChatTitle };
  try {
    const startWorkflow = vi.fn().mockResolvedValue({ sessionId: 'wf-title' });
    const plan = csvFile('plan.csv', '计划单号,物资编码,物资名称,申请数量,单位,预估单价\nPR-202609-01,RM-001,烟煤,2800,吨,920\n');
    render(<ProcurementSurface sessionId={null} mode="live" title="" session={idleSession} actions={{ startWorkflow, review: vi.fn() } as any} agent={agent} />);
    upload('上传计划', plan);
    fireEvent.click(screen.getByRole('button', { name: '完整性审核' }));
    await waitFor(() => expect(setChatTitle).toHaveBeenCalledWith('wf-title', 'PR-202609-01', 'agent'));
  } finally {
    delete (window as any).sparkii;
  }
});

it('keeps pack window prefs after returning to 准备', () => {
  // 复用本文件顶部已有的 `session`（含 evaluation + workflow_step_end/review）。
  // 不要用 /准备/：分析页同时有步骤条「1 准备 计划与对照」和门槛「返回准备」。
  render(<ProcurementSurface sessionId="s1" mode="live" title="" session={session as any} actions={{ review: vi.fn() } as any} agent={agent} />);
  fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
  fireEvent.change(screen.getByLabelText('领用范围'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('本次用哪套制度'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '返回分析' }));
  fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
  expect((screen.getByLabelText('领用范围') as HTMLSelectElement).value).toBe('30');
  expect((screen.getByLabelText('本次用哪套制度') as HTMLSelectElement).value).toBe('');
});
```

现有「无 sessionId / start 失败不 persist」两条保留，并补上 alert 断言。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx test/procurement-parse.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: Implement**

`extractPlanNo`：别名 `计划单号` / `计划编号` / `planNo`。扫行，返回第一个非空 trim。不要用「单号」（在途字段）。

`startPackWorkflow`：

```ts
const planPath = electronPath(files.plan);
if (!planPath) return { ok: false, message: '无法解析文件路径' };
const documents = [planPath]; // 只传计划。事实表已进 evaluation。
const planRows = await readRows(files.plan);
const plan = parsePlanTable(planRows, 'upload');
// facts 解析不变
try {
  const started = await Promise.resolve(actions.startWorkflow(prepared));
  sessionId = ...
} catch (err) {
  return { ok: false, message: err instanceof Error && err.message ? err.message : '未能开始分析' };
}
if (!sessionId) return { ok: false, message: '未能开始分析' };
const planNo = extractPlanNo(planRows); // 必须用原始 rows：PlanLine 上没有单号字段
void sparkiiApi().setChatTitle?.(sessionId, procurementSessionTitle(planNo, files.plan.name), 'agent');
actions.review('evaluation', { stepId: 'review', payload: prepared.evaluation });
return { ok: true, sessionId };
```

`sparkiiApi` 扩成：

```ts
function sparkiiApi(): {
  getPathForFile?(file: File): string;
  setChatTitle?(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>;
  appendError?(rec: { id: string; message: string; source: string; createdAt: number }): Promise<unknown>;
}
```

`PackPage.onStart` 读返回值：

```ts
void startPackWorkflow(mode, files, startCtx(), actions).then((r) => {
  if (r.ok) setError(null);
  else {
    setError(r.message);
    void sparkiiApi().appendError?.({
      id: `procurement-start-${Date.now()}`,
      message: r.message,
      source: '财务采购审核',
      createdAt: Date.now(),
    });
  }
}).finally(() => setStarting(false));
```

`appendError` 与合同审核同一写法（可选调用、不 await、不抛），只写在上面的 `else` 里，不要再写第二份。`sessionChanged` 时也清空 error：`<PackPage key={props.sessionId ?? 'new'} … />`。门槛旁渲染：

```tsx
{error ? <p className="miss warn" role="alert">{error}</p> : null}
```

`index.tsx` 增加 `prefs` state，默认：

```ts
{ policyKb: 'default', planRange: 'month', usageDays: '90', priceMonths: '12', transitDays: '30' }
```

`sessionChanged` 时 `setPrefs(DEFAULT_PACK_PREFS)` 与 `setFiles(EMPTY_PACK_FILES)` 一起做。

不要把 prefs 写进 `startWorkflow` 载荷的新键；ranges 仍按现有 `startCtx()` 传入 `evaluatePack`。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx test/procurement-parse.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/engine/parse.ts \
  apps/desktop/agents/procurement-review/surface/pack.tsx \
  apps/desktop/agents/procurement-review/surface/index.tsx \
  docs/superpowers/specs/2026-09-14-procurement-review-agent.md \
  apps/desktop/test/procurement-parse.test.ts \
  apps/desktop/test/procurement-surface.test.tsx
git commit -m "fix(procurement): surface start errors, plan-only documents, and session title"
```

---

### Task 3: 分析进度、导出标题、主题与合规卡高度

覆盖：M5、M6、M7、M11。

**Files:**
- Create: `apps/desktop/agents/procurement-review/surface/progress.ts`
- Modify: `apps/desktop/agents/procurement-review/surface/index.tsx`
- Modify: `apps/desktop/agents/procurement-review/surface/workbench.tsx`
- Modify: `apps/desktop/agents/procurement-review/surface/report-docx.ts`
- Modify: `apps/desktop/agents/procurement-review/surface/styles.css`
- Modify: `apps/desktop/agents/procurement-review/ui/theme/tokens.json`
- Test: `apps/desktop/test/procurement-surface.test.tsx`（进度 + 导出不双标题）

**Interfaces:**
- Consumes: `AgentSession.streaming`、`session.status`、`session.meta.currentStep`
- `thin = snap.closed.qty && snap.closed.price && snap.closed.time`
- `policyClosed = snap.closed.compliance`
- `reviewReady`：把 `hasReviewOutput` 从 `index.tsx` **搬进本任务新建的 `progress.ts`** 并导出，`index.tsx` 与 `workbench.tsx` 都从 `./progress.js` 导入，各自对 `session.entries` 算一遍（不为进度新增 prop；两处同一函数）。**不要**让 `workbench.tsx` 从 `./index.js` 导入 —— `index.tsx` 已经 `import { Workbench } from './workbench.js'`，反向导入会形成 `index ↔ workbench` 循环。`progress.ts` 需要的 `SessionEntry` 用 `import type { SessionEntry } from '../../../src/surface/contract.js'`，只取类型。
- Produces:

```ts
export type ProgState = 'done' | 'skip' | 'on' | 'wait';
export function analysisProgress(input: {
  streaming: boolean;
  status?: 'idle' | 'running' | 'done' | 'failed';
  currentStep?: string | null;
  thin: boolean;
  policyClosed: boolean;
  reviewReady: boolean;
}): Array<{ id: 'align' | 'complete' | 'rules' | 'policy' | 'write'; label: string; state: ProgState }>;
```

映射（分析页；复核页进度条保持现有高风险/已处理，不动）：

| id | 标签 | 规则 |
|---|---|---|
| align | 对齐编码 | 始终 `done`（`evaluatePack` 在 start 前已跑） |
| complete | 完整性 | 始终 `done` |
| rules | 套规则 | `thin` → `skip`；否则 `done` |
| policy | 制度 | `policyClosed` → `skip`；`streaming && currentStep==='search'` → `on`；`reviewReady \|\| currentStep==='review' \|\| currentStep==='report' \|\| status==='done'` → `done`；否则 `wait` |
| write | 撰写发现 | `streaming && currentStep==='review'` → `on`；`reviewReady \|\| currentStep==='report' \|\| status==='done'` → `done`；否则 `wait` |

Workbench 用 `className={\`prog ${step.state}\`}`。`state === 'skip'` 时仍渲染 ` · 跳过` 后缀，保持现有文案。`styles.css` 增加 `.procurement .prog.on { color: var(--primary); font-weight: 650; }`。`wait` 走默认 `.prog` 色，不要再加规则。

M5 还要让分析页在跑的时候就能看见。`index.tsx` 现在是 `if (!reviewReady) return packPage;`，所以 `load` / `search` 流式期间用户还停在准备页，等 `review` step_end 落地时 `currentStep` 已是 `review`/`report`、`status` 已是 `done` —— `on` 分支在产品里永远不会出现。改为：

```ts
// hasReviewOutput 落在 progress.ts；index.tsx 从 './progress.js' 导入。不要在 index 再导出一份。

const live = props.session.streaming || props.session.status === 'running';
const reviewReady = hasReviewOutput(props.session.entries);
if (!reviewReady && !live) return packPage;
```

`page` 初值改为 `reviewReady || live ? 'run' : 'pack'`；`返回准备` 仍可回准备页。`useEffect` 里的 `setPage` 改为下面这个确切形式，依赖数组仍是 `[props.sessionId, reviewReady]` —— `live` 只在回调里读、**不进依赖**，否则流式开关一翻就把用户从准备页拽走：

```ts
setPage((current) => {
  if (!reviewReady && !live) return 'pack';
  if (sessionChanged || becameReady) return 'run';
  return current;
});
```

**同一次改动必须把「已完成」文案和复核入口挡在 `reviewReady` 之后。** 否则 `live && !reviewReady` 时分析页会显示「分析完成 · 0 条发现」并放行「进入复核」，复核页 `findings` 为空、`blocking` 为 false，用户能在工作流还在跑时写入意见并导出空 docx。

- `Workbench` 复用已算的 `reviewReady`：分析页 gate 在 `!reviewReady` 时文案改为 `<b>分析进行中</b>` + 「正在生成结论，完成后可进入复核。」，并给「进入复核」加 `disabled={!reviewReady}`。「返回准备」不加限制。
- `index.tsx` 的 `page === 'pack'` 分支同理：`!reviewReady` 时 pack-resume 卡片文案改为 `<b>分析进行中</b>` + 「稍后可返回分析查看进度。」，「进入复核」`disabled`，「返回分析」保留。
- **复核入口一共三个，步骤条第 3 步也要挡。** `workbench.tsx` 步骤条第 3 步今天永远可点。路由放开后，`live && !reviewReady` 时点它同样进复核页：`findings` 为空 → `blocking` 为 false → 写入意见 / 导出空 docx。两处一起改：
  - `workbench.tsx` 步骤条第 3 步加 `disabled={!reviewReady}`（第 1、2 步不动）。
  - `index.tsx` 收口：`const goReview = () => { if (reviewReady) setPage('review'); };`

现有用例不受影响：点击「进入复核」的用例都跑在 `reviewReady === true` 上。

已有用例仍过：无计划 / session 切换用例都是 `streaming: false` / `status: 'idle'`（`live === false`）；复核/导出用例都是 `reviewReady === true`。

M6：

- `reportHtml` 移到 `report-docx.ts` 并导出，签名去掉标题参数：`export function reportHtml(findings: Finding[], states: Record<string, string>): string`。**不输出 `<h1>`**，表格直接开始；标题由 `documentFromHtml(title, html)` 单独产出一段。`workbench.tsx` 的 `exportReport` 改为 `reportHtml(findings, states)`。`Finding` 从 `./findings.js` 引入。`states` 用 `Record<string, string>`，**不要**从 `workbench.tsx` import `ReviewState`（会环依赖）。复核文案在 `report-docx.ts` 内本地映射：`confirmed→已采纳` `ignored→已忽略` `escalated→已升级` 其余 `未处理`。搬走后把 `workbench.tsx` 里只服务 `reportHtml` 的 `reviewLabel` 与 `esc` 一起删掉，不要留两份。
- **M6 的另一半：改掉标题兜底文案。** `report-docx.ts` 现在是 `paragraph(run(title || '合同审核报告', { bold: true, color: TEXT, size: 36 }), pStyle('ReportTitle'))`，把 `'合同审核报告'` 改成 `'财务采购审核'`。没有这一行，`falls back to 财务采购审核, not 合同审核报告, when the title is empty` 永远红。
- 保留对 `contract-report-mock-title` 的跳过逻辑（死代码但无害）；不要重写 zip/docx 引擎。

M7：`tokens.json` 的 `color.primary` 改为 `#2563EB`（与 `styles.css` `--primary` 一致）。

M11：把

```css
.procurement .conds > .cond { min-height: 100%; }
```

改成

```css
.procurement .conds > .cond:not(.rule-bar) { min-height: 100%; }
.procurement .conds > .cond.rule-bar { min-height: 0; align-self: start; }
```

`.rule-bar { min-height: 0 }` 保留。

- [ ] **Step 1: Write the failing tests**

```ts
import { analysisProgress } from '../agents/procurement-review/surface/progress.js';
import { documentFromHtml, reportHtml } from '../agents/procurement-review/surface/report-docx.js';

it('marks 制度 on and 撰写发现 waiting while search is streaming', () => {
  const steps = analysisProgress({
    streaming: true, status: 'running', currentStep: 'search',
    thin: false, policyClosed: false, reviewReady: false,
  });
  expect(steps.find((s) => s.id === 'policy')).toMatchObject({ state: 'on' });
  expect(steps.find((s) => s.id === 'write')).toMatchObject({ state: 'wait' });
  expect(steps.find((s) => s.id === 'rules')).toMatchObject({ state: 'done' });
});

it('skips 套规则 on a thin pack and skips 制度 when policy is closed', () => {
  const steps = analysisProgress({
    streaming: false, status: 'done', currentStep: 'report',
    thin: true, policyClosed: true, reviewReady: true,
  });
  expect(steps.find((s) => s.id === 'rules')).toMatchObject({ state: 'skip' });
  expect(steps.find((s) => s.id === 'policy')).toMatchObject({ state: 'skip' });
});

it('shows live analysis progress on ProcurementSurface while search is streaming', () => {
  const liveSession = {
    entries: [
      { kind: 'custom', id: 'e1', customType: 'workflow_state', data: { action: 'evaluation', payload: {
        lines: [], hits: [], closed: { qty: false, price: false, time: false, compliance: false }, conflicts: [],
      } } },
      { kind: 'custom', id: 'e2', customType: 'workflow_step_start', data: { stepId: 'search' } },
    ],
    streaming: true,
    status: 'running' as const,
    meta: { currentStep: 'search' },
  };
  render(<ProcurementSurface sessionId="s-live" mode="live" title="" session={liveSession as any} actions={{ review: vi.fn() } as any} agent={agent} />);
  const bar = screen.getByLabelText('分析进度');
  const policy = Array.from(bar.querySelectorAll('.prog')).find((n) => (n.textContent ?? '').includes('制度'));
  const write = Array.from(bar.querySelectorAll('.prog')).find((n) => (n.textContent ?? '').includes('撰写发现'));
  expect(policy?.className).toMatch(/\bon\b/);
  expect(write?.className).not.toMatch(/\bdone\b/);
  expect((screen.getByRole('button', { name: '进入复核' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('分析进行中')).toBeTruthy();
});

it('does not write the title twice into the docx', async () => {
  const html = reportHtml([], {});
  expect(html.includes('<h1>')).toBe(false);
  const xml = new TextDecoder().decode(await documentFromHtml('财务采购审核', html));
  expect(xml.split('财务采购审核').length - 1).toBe(1);
});

it('falls back to 财务采购审核, not 合同审核报告, when the title is empty', async () => {
  // 必须传空标题才会走 fallback 分支；传非空标题时这条断言是空转的
  const xml = new TextDecoder().decode(await documentFromHtml('', reportHtml([], {})));
  expect(xml).not.toContain('合同审核报告');
  expect(xml).toContain('财务采购审核');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`
Expected: FAIL（`progress.ts` 不存在；html 仍有 h1；docx 含两份标题或「合同审核报告」）。

- [ ] **Step 3: Implement** as specified. Workbench 分析进度改为 map `analysisProgress(...)`。`reportHtml` 移到 `report-docx.ts` 并导出，避免 workbench 与测试各写一份。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-surface.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/procurement-review/surface/progress.ts \
  apps/desktop/agents/procurement-review/surface/index.tsx \
  apps/desktop/agents/procurement-review/surface/workbench.tsx \
  apps/desktop/agents/procurement-review/surface/report-docx.ts \
  apps/desktop/agents/procurement-review/surface/styles.css \
  apps/desktop/agents/procurement-review/ui/theme/tokens.json \
  apps/desktop/test/procurement-surface.test.tsx
git commit -m "fix(procurement): live analysis progress, single export title, and rule-bar height"
```

---

### Task 4: 夹具引用与隔离测试加宽

覆盖：M10、M12。

**Files:**
- Unchanged (仅新增引用): `apps/desktop/agents/procurement-review/fixtures/demo-pack.json`
- Unchanged (仅新增引用): `apps/desktop/agents/procurement-review/fixtures/plan.csv`
- Modify: `apps/desktop/test/procurement-engine.test.ts`
- Modify: `apps/desktop/test/procurement-parse.test.ts`
- Modify: `apps/desktop/test/procurement-isolation.test.ts`

**Interfaces:**
- Consumes: 现有 `evaluatePack`、`parseCsv` / `parsePlanTable`
- Produces: 无新 API

- [ ] **Step 1: Write the failing tests**

`demo-pack.json` 的 镁铬砖目前只有 1 笔成交。先写测试再改夹具：

```ts
import demoPack from '../agents/procurement-review/fixtures/demo-pack.json';
import type { PackInput } from '../agents/procurement-review/engine/types.js';

it('evaluates the demo pack to coal over-cover, brick mid-price, and brick transit', () => {
  // 断言是故意的：JSON import 会把 source / usageDays / policyKb 放宽成 string / number；不要改夹具去迁就类型。
  const snap = evaluatePack({ ...demoPack, rules: DEFAULT_RULES } as PackInput);
  expect(snap.hits.some((h) => h.ruleId === 'qty.over-cover' && h.rowId === 'M-煤')).toBe(true);
  expect(snap.hits.some((h) => h.ruleId === 'price.dev-mid' && h.rowId === 'M-砖')).toBe(true);
  expect(snap.hits.some((h) => h.ruleId === 'time.duplicate' && h.rowId === 'M-砖')).toBe(true);
});
```

`parse`：

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // 包是 "type": "module"，没有 __dirname

it('parses fixtures/plan.csv', () => {
  const text = readFileSync(join(here, '../agents/procurement-review/fixtures/plan.csv'), 'utf8');
  const lines = parsePlanTable(parseCsv(text), 'upload');
  expect(lines.map((l) => l.code)).toEqual(['RM-001', 'RM-014', 'SP-203', 'RM-008']);
  expect(lines[0].id).toBe('plan-1');
});
```

隔离：把正则换成同时匹配 `===` / `==` / 左右对调 / `case 'procurement-review'`，且**仍然不**把生成绑定文件算进去（绑定文件含字符串但不是分支）。在测试里加一段注释说明：命中即失败。实现：

```ts
const BRANCH = /(?:agent\.id|profileId|agentId)\s*===?\s*['"]procurement-review['"]|['"]procurement-review['"]\s*===?\s*(?:agent\.id|profileId|agentId)|case\s+['"]procurement-review['"]/;
```

`walk` 继续跳过 `*.test.ts(x)`。`agent-surface-bindings.ts` 若只是 `procurement-review: lazy(...)` 映射，**不会**匹配上述 BRANCH。不要用裸 `/procurement-review/` 扫全仓库。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-parse.test.ts test/procurement-isolation.test.ts test/procurement-engine.test.ts`
Expected: 只有 `parses fixtures/plan.csv` 这一条 FAIL —— 它是 M10 里唯一真正新增覆盖的断言（`plan.csv` 今天没有任何测试读过）。
`evaluates the demo pack …` 是 **回归钉子**，不是 TDD 红灯：夹具内容不改（镁铬砖 1 笔 2410 vs 本次 2680 ≈ 11.2% → `price.dev-mid`；烟煤覆盖 10 个月 > 4 且库存天数 180 > 30 → `qty.over-cover`；镁铬砖在途 36 于 30 天窗口内 → `time.duplicate`），新增 import 即算 M10 的「被测试引用」，首跑即绿。
隔离正则加宽后现网仍应空命中：`agent-surface-bindings.ts` 是 `"procurement-review": Surface_procurement_review,` 的 Record 字面量，不含 `===` / `==` / `case`，不会被 `BRANCH` 命中。若误伤，收窄 `BRANCH`，不要删绑定。

- [ ] **Step 3: Implement**

- `demo-pack.json`：**不改内容**（镁铬砖保持 1 笔 2410）。不要加 `$comment`。
- `plan.csv`：测试读文件。不必改内容。
- 隔离正则按上替换。

- [ ] **Step 4: Run the full procurement suite**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/procurement-engine.test.ts test/procurement-parse.test.ts test/procurement-findings.test.ts test/procurement-surface.test.tsx test/procurement-isolation.test.ts`
Expected: 全过。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test/procurement-engine.test.ts \
  apps/desktop/test/procurement-parse.test.ts \
  apps/desktop/test/procurement-isolation.test.ts
git commit -m "test(procurement): pin fixtures and widen isolation branch scan"
```

---

## Spec patches（必须与代码同一批提交，权威仍是 logic > agent spec）

写入 `docs/superpowers/specs/2026-09-14-procurement-review-agent.md`，不要另起 spec 文件：

1. **§3.1 cite（量）：** 引擎生成的 `cite.label` 必须能读出库存日期（或冲突两侧）、领用笔数、覆盖带；过期加「库存可能不是当天」。示例：`库存 2026-09-13 · 领用 1 笔 · 覆盖>4个月`。`usage[].days` 仍不进公式。
2. **§3.2 价：** `|dev| > highPct` 且样本 ≥ minSamples 且未过期 → `price.dev-high`。其余 `|dev| > midPct`（含超过 15% 但被样本/过期门挡住）→ `price.dev-mid`。禁止「价格正常」。
3. **§3 parse + §4.1 示例：** `parsePlanTable` 行 id 为 `plan-${n}`，不因编码重复而碰撞。Hit id 为 `h-{dim}-{line.id}-{suffix}`。同时把 §4.1 示例 JSON 里的 `"hitId": "h-qty-RM-001"` 改为 `"hitId": "h-qty-M-煤-over"`，与 SKILL.md 示例一致；否则 spec 自带一个与新格式矛盾的例子。
4. **§5 start：** `documents` **只含计划路径**。Electron 路径仍先 `getPathForFile`。失败必须在门槛旁 `role="alert"` 出中文原因，并 `appendError`。拿到 `sessionId` 后 `setChatTitle(id, procurementSessionTitle(extractPlanNo(rows), fileName), 'agent')`。`extractPlanNo` 别名：计划单号 / 计划编号 / planNo。
5. **§5 准备页状态：** 制度与三个窗口是 session 级，返回准备不丢；换 session 才重置。
6. **§5 分析进度：** 对齐/完整性/套规则来自已算完的 evaluation；制度/撰写发现跟 `currentStep` / `streaming`。`streaming || status==='running'` 时即使还没有 `review` step_end，也进入分析页，否则 live `on` 状态不可达。进入分析页 ≠ 分析完成：没有 `review` step_end 之前，门槛文案是「分析进行中」，**所有复核入口（分析页门槛按钮、准备页 pack-resume 卡片、步骤条第 3 步）一律禁用**，不得写入意见或导出。

---

## Out of scope（明确不做）

- OA / U8 真连接器、多制度库、自动放行。
- 动态 `import('xlsx')`（I3 残余观感；改打包不在本轮）。
- `subtractDays` 的 `toISOString()` 时区问题（只修 `subtractMonths`）。
- 为桌面包历史 typecheck 失败改 knowledge-qa / standard-chat / connectors。
- 改 `LinearRunner`、新增平台 tool、`agentId` 特判。
- 写入意见后的可见确认（复审新记的 cosmetic，不是 M1–M13）。
- 模型自拟 `Finding.id` 碰撞（与 M2 的引擎 hit/row id 不是一类）。

---

## Self-review

| Finding | Task |
|---|---|
| M1 qty cite | T1 |
| M2 colliding ids | T1 parse + hit id |
| M3 silent start | T2 |
| M4 five documents | T2 |
| M5 static progress | T3 |
| M6 double title / 合同审核报告 | T3 |
| M7 teal token | T3 |
| M8 prefs reset | T2 |
| M9 title / planNo | T2 |
| M10 unused fixtures | T4 |
| M11 rule-bar height | T3 |
| M12 narrow isolation | T4 |
| M13 month overflow | T1 |
| Residual high+thin/stale → mid | T1 |

无 TBD：所有夹具、消息文案、`appendError` 字段、`extractPlanNo` 调用形式都在正文给了确切值。T2 的 `extractPlanNo` 与 T1 的 `parsePlanTable` id 不冲突：T1 先改 id，T2 只加函数。T3 导出 `reportHtml` 若 T2 已碰 workbench 标题行，以 T3 搬函数为准，不要两份 `reportHtml`。T3 改 `index.tsx` 路由时，保留 T2 已落地的 prefs 上提，不要回滚。
