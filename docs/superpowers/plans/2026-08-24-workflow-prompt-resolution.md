# Workflow Prompt Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow's `skill`/`llm` steps actually use their prompt files so the report step gets clear instructions (generate report + export once), removing the double `report.export` call that hangs the pilot.

**Architecture:** Load every `agent/prompts/*.md` into `profile.agent.prompts` (keyed by basename), and resolve each workflow step's `ref` (skill) / `template` (llm) to that content inside `runWorkflow` before handing the definition to `LinearRunner`.

**Tech Stack:** TypeScript, Vitest, @sparkii/config, @sparkii/agent-host, Electron main, Playwright e2e.

**Spec:** This plan is the spec. Root cause below.

## Root Cause (confirmed)

`loadProfile` only loaded prompts listed in `agent/skills.yaml`, so `report.md` was never loaded. `LinearRunner` used `step.template` literally and ignored `step.ref`, so no prompt file content reached the model — the report step sent the literal word `"report"` plus JSON, and the model called `report.export` twice (second one hung awaiting approval).

## Global Constraints

- Node is not on PATH. Prepend: `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- `pnpm` 11 is on PATH. No new dependencies; no `pnpm install`.
- `.git` is read-only: `git add` / `git commit` require escalation.
- Sandbox denies `node_modules/.pnpm`: `vitest` / `esbuild` / `electron` / `playwright` require escalation.
- TDD per task. Commit messages use conventional-commit scope `config`, `desktop`, or `agent-host`.
- Do not modify `package.json` / `pnpm-lock.yaml`.

---

### Task 1: Load every `agent/prompts/*.md` into `profile.agent.prompts`

**Files:**
- Modify: `packages/config/src/loader.ts`
- Test: `packages/config/test/loader.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/config/test/loader.test.ts`, in the `loads a valid profile` fixture add `agent/prompts/report.md`, and assert it is loaded:

```ts
'agent/prompts/report.md': '# generate report\n',
```

Then add the assertion:

```ts
expect(p.agent.prompts).toMatchObject({ report: '# generate report\n' });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/config/test/loader.test.ts`
Expected: FAIL — `p.agent.prompts.report` is `undefined` (only skills.yaml entries are loaded).

- [ ] **Step 3: Implement**

In `packages/config/src/loader.ts`, add `readdir` to the import:

```ts
import { readFile, readdir } from 'node:fs/promises';
```

Replace the skills-driven prompt loop:

```ts
const skills = parseYaml(skillsRaw) as Array<{ name: string; file: string; params?: Record<string, unknown> }>;
const prompts: Record<string, string> = {};
for (const s of skills) {
  prompts[s.name] = await read(dir, `agent/${s.file}`);
  files[`agent/${s.file}`] = Buffer.from(prompts[s.name]);
}
```

with:

```ts
const skills = parseYaml(skillsRaw) as Array<{ name: string; file: string; params?: Record<string, unknown> }>;
const promptDir = join(dir, 'agent', 'prompts');
const promptNames = await readdir(promptDir);
const prompts: Record<string, string> = {};
for (const f of promptNames) {
  if (!f.endsWith('.md')) continue;
  const name = f.slice(0, -3);
  prompts[name] = await read(dir, `agent/prompts/${f}`);
  files[`agent/prompts/${f}`] = Buffer.from(prompts[name]);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/config/test`
Expected: PASS (skills array still returned; prompts now includes every `.md` basename).

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/loader.ts packages/config/test/loader.test.ts
git commit -m "fix(config): load all agent prompts including workflow templates"
```

---

### Task 2: Resolve workflow `ref`/`template` to prompt content

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Produces: `resolveWorkflowTemplates(def: WorkflowDef, prompts: Record<string, string>): WorkflowDef` — maps each `skill` step's `ref` and each `llm` step's `template` to the corresponding prompt text.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/test/workflow-broker.test.ts`, add:

```ts
import { createBroker, resolveWorkflowTemplates, runWorkflow } from '../electron/main/workflow.js';

it('resolves skill ref and llm template to prompt content', () => {
  const def = {
    version: 1, engine: 'linear',
    steps: [
      { id: 'extract', type: 'skill', ref: 'clause_extract', inputs: { from: 'load' } },
      { id: 'report', type: 'llm', template: 'report', inputs: { from: ['extract', 'compare'] } },
    ],
  } as any;
  const resolved = resolveWorkflowTemplates(def, { clause_extract: '抽取条款', report: '生成报告' });
  expect(resolved.steps[0].template).toBe('抽取条款');
  expect(resolved.steps[1].template).toBe('生成报告');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: FAIL — `resolveWorkflowTemplates` is not exported.

- [ ] **Step 3: Implement**

In `apps/desktop/electron/main/workflow.ts`, add:

```ts
export function resolveWorkflowTemplates(def: WorkflowDef, prompts: Record<string, string>): WorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.type === 'skill' && step.ref && prompts[step.ref] != null) {
        return { ...step, template: prompts[step.ref] };
      }
      if (step.type === 'llm' && step.template && prompts[step.template] != null) {
        return { ...step, template: prompts[step.template] };
      }
      return step;
    }),
  };
}
```

In `runWorkflow`, replace:

```ts
const def = rt.profile.agent.workflow as unknown as WorkflowDef;
```

with:

```ts
const rawDef = rt.profile.agent.workflow as unknown as WorkflowDef;
const prompts = (rt.profile.agent.prompts ?? {}) as Record<string, string>;
const def = resolveWorkflowTemplates(rawDef, prompts);
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Run type check**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "fix(desktop): resolve workflow skill and template prompts"
```

---

### Task 3: Rebuild and verify end-to-end

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

Expected: 1 passed — report step uses the real prompt, calls `report.export` once, one approval dialog, export path from `SPARKII_E2E_EXPORT_DIR`, then `审核完成`.

If it fails, report the exact step and `SPARKII_DATA_DIR` audit rows; do not fake success.

---

## Self-Review

- **Spec coverage:** Prompt loading (Task 1), prompt resolution (Task 2), end-to-end verification (Task 3).
- **Placeholder scan:** No TBD/TODO; code blocks are concrete.
- **Type consistency:** `resolveWorkflowTemplates(def: WorkflowDef, prompts: Record<string, string>): WorkflowDef` matches its call in `runWorkflow`; the loader change keeps `skills` returned while rebuilding `prompts` from the directory.
