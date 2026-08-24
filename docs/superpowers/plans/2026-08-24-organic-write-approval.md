# Organic Write Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make write approval organic: the agent proposes writes (without choosing a destination), the user approves/denies, and only after approval does a save dialog appear to choose where to write. Remove the redundant `review` (human) workflow step and the export button.

**Architecture:** Keep the propose-execute separation (agent proposes, Main executes only on approval). Move destination-path selection from the agent/export-button into `decideApproval` after the user approves. The workflow ends at the report step, whose model proposes `report.export`; approval is the single organic dialog.

**Tech Stack:** TypeScript, Vitest, @sparkii/connectors, @sparkii/approval, Electron dialog, Playwright e2e.

**Spec:** This plan is the spec. The current problems and target flow are documented below.

## Current Problems (confirmed)

1. `workflow.approval` (the `review` human step) is a redundant second approval; the `report.export` write approval already gates writing.
2. The agent-facing `report.export` tool requires `path`, so the agent chooses where to write (non-deterministic, leaked outside the sandbox).
3. The export button chooses the path BEFORE approval, and duplicates the agent's organic write.

## Target Flow

```
load → search → extract → compare → report (model generates text + proposes report.export)
  → approval dialog (allow / deny)
       ├─ deny → no write, no save dialog
       └─ allow → save dialog (choose path) → Main writes to that path
```

## Global Constraints

- Node is not on PATH. Prepend: `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- `pnpm` 11 is on PATH. No new dependencies; no `pnpm install`.
- `.git` is read-only: `git add` / `git commit` require escalation.
- Sandbox denies `node_modules/.pnpm`: `vitest` / `esbuild` / `electron` / `playwright` / `electron-builder` require escalation.
- TDD per task. Commit messages use conventional-commit scope `connectors`, `desktop`, or `docs`.
- Do not modify `package.json` / `pnpm-lock.yaml`.

---

### Task 1: Remove `path` from the agent-facing `report.export` tool

**Files:**
- Modify: `packages/connectors/src/report/index.ts`
- Test: `packages/connectors/test/report.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/connectors/test/report.test.ts`, add:

```ts
it('does not require a path from the agent', () => {
  const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
  expect((tool.params as any).required).not.toContain('path');
  expect((tool.params as any).properties?.path).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/connectors/test/report.test.ts`
Expected: FAIL — `path` is currently required and present in `properties`.

- [ ] **Step 3: Implement**

In `packages/connectors/src/report/index.ts`, remove `path` from `params`:

```ts
params: {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } } } },
    format: { type: 'string', enum: ['docx'] },
  },
  required: ['title', 'sections', 'format'],
},
```

Keep the `handler` unchanged (it still reads `args.path`, now injected by Main after approval).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/connectors/test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/report/index.ts packages/connectors/test/report.test.ts
git commit -m "fix(connectors): drop path from agent-facing report.export params"
```

---

### Task 2: Choose the export path after approval in `decideApproval`

**Files:**
- Create: `apps/desktop/electron/main/export-path.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/export-path.test.ts`

**Interfaces:**
- Produces: `resolveExportPath(getWindow, env, showSaveDialog): Promise<string | undefined>` — returns the destination path, or `undefined` when the user cancels / no window / no env dir.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/export-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveExportPath } from '../electron/main/export-path.js';

const picker = async (o: unknown) => ({ canceled: false, filePath: 'C:/tmp/chosen.docx' });

describe('resolveExportPath', () => {
  it('uses SPARKII_E2E_EXPORT_DIR when set', async () => {
    await expect(resolveExportPath(() => null, { SPARKII_E2E_EXPORT_DIR: 'C:/tmp/out' }, picker)).resolves.toBe('C:/tmp/out/report.docx');
  });
  it('returns undefined when there is no window', async () => {
    await expect(resolveExportPath(() => null, {}, picker)).resolves.toBeUndefined();
  });
  it('returns the chosen path from the dialog', async () => {
    await expect(resolveExportPath(() => ({ id: 1 }), {}, picker)).resolves.toBe('C:/tmp/chosen.docx');
  });
  it('returns undefined when the dialog is canceled', async () => {
    await expect(resolveExportPath(() => ({ id: 1 }), {}, async () => ({ canceled: true }))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/test/export-path.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helper**

Create `apps/desktop/electron/main/export-path.ts`:

```ts
export type ShowSaveDialog = (
  win: unknown,
  opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
) => Promise<{ canceled: boolean; filePath?: string }>;

export async function resolveExportPath(
  getWindow: () => unknown,
  env: NodeJS.ProcessEnv,
  showSaveDialog: ShowSaveDialog,
): Promise<string | undefined> {
  if (env.SPARKII_E2E_EXPORT_DIR) return `${env.SPARKII_E2E_EXPORT_DIR}/report.docx`;
  const win = getWindow();
  if (!win) return undefined;
  const r = await showSaveDialog(win, { defaultPath: 'report.docx', filters: [{ name: 'Word', extensions: ['docx'] }] });
  return r.canceled || !r.filePath ? undefined : r.filePath;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/test/export-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `decideApproval`**

In `apps/desktop/electron/main/ipc.ts`, import `resolveExportPath`, and change the `decideApproval` handler:

```ts
ipcMain.handle('sparkii:decideApproval', async (_e, id: string, approved: boolean, note?: string) => {
  if (!rt.subject) throw new Error('not authenticated');
  let out = await rt.gate.decide(id, rt.subject, approved, note);
  let result: unknown;
  if (out.status === 'approved' && out.toolName !== 'workflow.approval') {
    if (out.toolName === 'report.export') {
      const path = await resolveExportPath(getWindow, process.env, (win, opts) =>
        dialog.showSaveDialog(win as BrowserWindow, opts),
      );
      if (path) {
        out.payload = { ...(out.payload as Record<string, unknown>), path };
        out = await rt.executor.execute(out, { actor: rt.subject.userId });
        result = out.execution?.result;
      } else {
        await rt.audit.append({ actor: rt.subject.userId, action: 'execution.blocked', resource: out.toolName });
        out.execution = { ok: false, error: 'export path canceled' };
      }
    } else {
      out = await rt.executor.execute(out, { actor: rt.subject.userId });
      result = out.execution?.result;
    }
  }
  broker.decide(out.id, { approved: out.status === 'approved' || out.status === 'executed', status: out.status, result });
  return out;
});
```

- [ ] **Step 6: Run type check + tests**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm --filter @sparkii/desktop run build:main:check
pnpm exec vitest run apps/desktop/test
```

Expected: tsc exit 0; desktop tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/export-path.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/export-path.test.ts
git commit -m "feat(desktop): choose export path after approval"
```

---

### Task 3: Remove the redundant `review` step and instruct the model to export

**Files:**
- Modify: `profiles/contract-review/agent/workflow.yaml`
- Modify: `profiles/contract-review/agent/prompts/report.md`

- [ ] **Step 1: Edit workflow.yaml**

Remove the `review` line so the steps end at `report`:

```yaml
steps:
  - { id: load,    type: tool,  ref: document.read, map: { documents: documents } }
  - { id: search,  type: tool,  ref: knowledge.search, map: { query: load.text } }
  - { id: extract, type: skill, ref: clause_extract, inputs: { from: load } }
  - { id: compare, type: skill, ref: risk_compare, inputs: { from: [extract, search] } }
  - { id: report,  type: llm,   template: report, inputs: { from: [extract, compare] } }
```

- [ ] **Step 2: Edit report.md**

Replace the prompt text with:

```text
将风险比对结果组织为结构化审核报告章节（结论、风险明细、修改建议、复核意见），然后调用 report.export 工具导出为 Word 文档。
```

- [ ] **Step 3: Commit**

```bash
git add profiles/contract-review/agent/workflow.yaml profiles/contract-review/agent/prompts/report.md
git commit -m "feat(profile): end workflow at report and export organically"
```

---

### Task 4: Remove the export button and its IPC/preload surface

**Files:**
- Modify: `profiles/contract-review/ui/pages/home.json`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/desktop/test/preload-api.test.ts`, remove `'exportReport'` from the expected method names:

```ts
const names = ['login', 'getProfile', 'chooseDocument', 'runWorkflow', 'prompt', 'listPendingApprovals', 'decideApproval', 'queryAudit', 'on'];
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/test/preload-api.test.ts`
Expected: FAIL (the api still exposes `exportReport`).

- [ ] **Step 3: Remove the export surface**

In `apps/desktop/electron/preload/api-types.ts`, remove:

```ts
exportReport(input: { title: string; sections: Array<{ heading: string; body: string }> }): Promise<unknown>;
```

In `apps/desktop/electron/preload/api.ts`, remove:

```ts
exportReport: (input) => invoke('exportReport', input),
```

In `apps/desktop/electron/main/ipc.ts`, remove the entire `sparkii:exportReport` handler.

In `apps/desktop/src/App.tsx`, remove the `export-report` branch from `onAction`:

```ts
if (action === 'export-report') {
  const body = ((state.workflow as any)?.result?.report) ?? '';
  api.exportReport({ title: '审核报告', sections: [{ heading: '报告', body: String(body) }] });
}
```

In `profiles/contract-review/ui/pages/home.json`, remove the `export` widget:

```json
{ "id": "export", "type": "action-button", "action": "export-report" }
```

- [ ] **Step 4: Run to verify pass**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm exec vitest run apps/desktop/test
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: desktop tests pass; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add profiles/contract-review/ui/pages/home.json apps/desktop/src/App.tsx apps/desktop/electron/main/ipc.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/test/preload-api.test.ts
git commit -m "refactor(desktop): remove export button in favor of organic approval"
```

---

### Task 5: Rebuild and verify end-to-end

- [ ] **Step 1: Full unit tests + type check**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm test
pnpm --filter @sparkii/desktop run build:main:check
```

- [ ] **Step 2: Rebuild renderer + main**

```powershell
pnpm --filter @sparkii/desktop run build:renderer
pnpm --filter @sparkii/desktop run build:main
```

- [ ] **Step 3: Run the e2e pilot**

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: 1 passed — one approval dialog (`report.export`), the export path resolved via `SPARKII_E2E_EXPORT_DIR`, then `审核完成`.

If it fails, report the exact step and `SPARKII_DATA_DIR` audit rows; do not fake success.

---

## Self-Review

- **Spec coverage:** Redundant review removed (Task 3), agent no longer chooses path (Task 1), path selected after approval (Task 2), export button removed (Task 4), end-to-end verified (Task 5).
- **Placeholder scan:** No TBD/TODO; code blocks are concrete.
- **Type consistency:** `resolveExportPath` signature matches its call site in `ipc.ts`; `report.export` schema (`title`/`sections`/`format`) matches the `handler`'s `args`.
