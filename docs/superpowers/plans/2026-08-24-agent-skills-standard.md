# Agent Skills (SKILL.md) Standard Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `skills.yaml` + flat `prompts/*.md` prompt registry with the mainstream Agent Skills standard — one skill = one directory containing a `SKILL.md` with YAML frontmatter — and load them the way Pi Agent does (directory discovery, frontmatter parsing, validation, name-collision handling), keeping the deterministic workflow resolution intact.

**Architecture:** `@sparkii/config` gains a `skills.ts` module that mirrors Pi Agent's `loadSkillsFromDir` semantics (recursive `SKILL.md` discovery, root-level `.md` files, frontmatter `name`/`description`, warnings, first-wins collision handling). `loadProfile` scans `agent/skills/` instead of reading `agent/skills.yaml`, builds `profile.agent.skills` as `SkillPackage[]` and derives `profile.agent.prompts` (name → body) so the desktop `resolveWorkflowTemplates` keeps working unchanged. The sample `contract-review` profile is migrated in place. Skill content is loaded at workflow step run time by the existing resolver — the loading side matches the standard; model-driven on-demand `read` is a documented future extension, not part of this plan.

**Tech Stack:** TypeScript, Vitest, @sparkii/config, Electron main, Playwright e2e. No new dependencies (`yaml` is already used by `@sparkii/config`).

**Spec:** The Agent Skills standard as implemented by Pi Agent (`@earendil-works/pi-coding-agent`):
- Docs: `docs/skills.md` in the pi-coding-agent package (locations, discovery rules, frontmatter table, validation, progressive disclosure).
- Loader: `dist/core/skills.js` in the pi-coding-agent package (`loadSkillsFromDir`, `loadSkillFromFile`, `formatSkillsForPrompt`).
- Standard home: https://agentskills.io/specification

## Global Constraints

- Node is not on PATH. Prepend: `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- `pnpm` 11 is on PATH. No new dependencies; no `pnpm install`.
- `.git` is read-only: `git add` / `git commit` / `git rm` require escalation.
- Sandbox denies `node_modules/.pnpm`: `vitest` / `esbuild` / `electron` / `playwright` require escalation.
- Do not modify `package.json` / `pnpm-lock.yaml`.
- TDD per task. Commit messages use conventional-commit scope `config`, `profile`, or `desktop`.
- Profile stays self-contained under `agent/skills/` (portable, signable). Do NOT introduce `~/.pi/agent/skills` or `.pi/skills` multi-location discovery in this plan.

## Key Design Decisions (confirm with the parent agent before execution)

1. **Skill root = profile-local `agent/skills/`.** The profile bundle stays self-contained and signature-verifiable. Pi's multi-location discovery (global/project) is explicitly out of scope; can be added later as an extension.
2. **Runtime invocation stays workflow-driven.** The linear workflow declares exactly which skill each step uses, so full content is resolved at step run time by `resolveWorkflowTemplates` — this is the deterministic equivalent of "load on demand". We do NOT inject the `<available_skills>` XML catalog into prompts and do NOT add a `read` tool in this plan, because Sparkii's `LinearRunner` has no agent loop for the model to invoke tools between steps. Model-driven skill selection is a future architectural extension.
3. **`agent/skills.yaml` is deleted.** Nothing consumes `agent.skills` today except the type and one test fixture. `profile.agent.prompts` is kept as a derived `Record<name, content>` so the desktop resolver interface is unchanged.
4. **Validation is lenient, matching Pi:** missing/blank `description` → skill not loaded (warning); invalid `name` (charset/length/hyphens) or `description` > 1024 → warning but still loaded; same-name collision → first found wins + `collision` diagnostic.

---

### Task 1: Add `skills.ts` — SKILL.md frontmatter parsing, discovery, validation

**Files:**
- Create: `packages/config/src/skills.ts`
- Test: `packages/config/test/skills.test.ts`

**Interfaces:**
- Produces: `parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string }`
- Produces: `loadSkillsFromDir(dir: string): Promise<LoadSkillsResult>`
- Produces: `SkillPackage` and `SkillDiagnostic` types (consumed by `types.ts` in Task 2)

- [ ] **Step 1: Write the failing test**

Create `packages/config/test/skills.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadSkillsFromDir, parseSkillFrontmatter } from '../src/skills.js';

function write(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

describe('parseSkillFrontmatter', () => {
  it('parses frontmatter and returns the body', () => {
    const raw = '---\nname: foo\ndescription: Does foo.\n---\n# Foo\n\nDo it.\n';
    const { frontmatter, body } = parseSkillFrontmatter(raw);
    expect(frontmatter).toMatchObject({ name: 'foo', description: 'Does foo.' });
    expect(body).toBe('# Foo\n\nDo it.\n');
  });

  it('treats text without frontmatter as body', () => {
    const { frontmatter, body } = parseSkillFrontmatter('# Foo\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Foo\n');
  });
});

describe('loadSkillsFromDir', () => {
  it('discovers SKILL.md directories and root-level md files', async () => {
    const dir = write({
      'clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract clauses.\n---\n抽取条款。\n',
      'report.md': '---\nname: report\ndescription: Generate report.\n---\n生成报告。\n',
      'nested/a/SKILL.md': '---\nname: a\ndescription: Skill a.\n---\nA.\n',
      'not-a-skill/notes.txt': 'x',
    });
    const { skills } = await loadSkillsFromDir(dir);
    expect(skills.map((s) => s.name).sort()).toEqual(['a', 'clause_extract', 'report']);
    expect(skills.find((s) => s.name === 'report')?.content).toBe('生成报告。\n');
  });

  it('does not load a skill whose description is missing', async () => {
    const dir = write({ 'bad/SKILL.md': '---\nname: bad\n---\nNo description.\n' });
    const { skills, diagnostics } = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(0);
    expect(diagnostics.some((d) => d.message.includes('description'))).toBe(true);
  });

  it('keeps only the first skill on name collision and reports it', async () => {
    const dir = write({
      'aa/SKILL.md': '---\nname: dup\ndescription: First.\n---\nfirst\n',
      'bb/SKILL.md': '---\nname: dup\ndescription: Second.\n---\nsecond\n',
    });
    const { skills, diagnostics } = await loadSkillsFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(diagnostics.some((d) => d.type === 'collision')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/config/test/skills.test.ts`
Expected: FAIL — `Cannot find module '../src/skills.js'` (module does not exist yet).

- [ ] **Step 3: Implement**

Create `packages/config/src/skills.ts`:

```ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillPackage {
  name: string;
  description: string;
  raw: string;
  content: string;
  relPath: string;
  relBaseDir: string;
  disableModelInvocation?: boolean;
  metadata?: Record<string, unknown>;
}

export type SkillDiagnostic =
  | { type: 'warning'; message: string; path: string }
  | { type: 'collision'; message: string; path: string };

export interface LoadSkillsResult {
  skills: SkillPackage[];
  diagnostics: SkillDiagnostic[];
}

export function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(match[1]);
  const frontmatter = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { frontmatter, body: raw.slice(match[0].length) };
}

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > 64) errors.push(`name exceeds 64 characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name must be lowercase a-z, 0-9, hyphens only');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name must not start or end with a hyphen');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

interface LoadState {
  skills: SkillPackage[];
  diagnostics: SkillDiagnostic[];
  seen: Map<string, string>;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function loadSkillFile(filePath: string, root: string, state: LoadState): Promise<void> {
  const raw = await readFile(filePath, 'utf8');
  const { frontmatter, body } = parseSkillFrontmatter(raw);
  const relPath = relative(root, filePath).split(sep).join('/');
  const relBaseDir = relative(root, dirname(filePath)).split(sep).join('/');
  const fallbackName = basename(filePath) === 'SKILL.md' ? basename(dirname(filePath)) : basename(filePath, '.md');
  const name = typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  for (const message of validateName(name)) {
    state.diagnostics.push({ type: 'warning', message, path: relPath });
  }
  if (!description.trim()) {
    state.diagnostics.push({ type: 'warning', message: 'description is required', path: relPath });
    return;
  }
  if (description.length > 1024) {
    state.diagnostics.push({ type: 'warning', message: `description exceeds 1024 characters (${description.length})`, path: relPath });
  }
  if (state.seen.has(name)) {
    state.diagnostics.push({ type: 'collision', message: `name "${name}" collision`, path: relPath });
    return;
  }
  state.seen.set(name, relPath);
  state.skills.push({
    name,
    description,
    raw,
    content: body,
    relPath,
    relBaseDir,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    metadata: typeof frontmatter.metadata === 'object' && frontmatter.metadata !== null
      ? (frontmatter.metadata as Record<string, unknown>)
      : undefined,
  });
}

async function loadDir(dir: string, root: string, includeRootFiles: boolean, state: LoadState): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === 'SKILL.md')) {
    await loadSkillFile(join(dir, 'SKILL.md'), root, state);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(full))) {
      await loadDir(full, root, false, state);
      continue;
    }
    if (!includeRootFiles || !entry.name.endsWith('.md')) continue;
    await loadSkillFile(full, root, state);
  }
}

export async function loadSkillsFromDir(dir: string): Promise<LoadSkillsResult> {
  const state: LoadState = { skills: [], diagnostics: [], seen: new Map() };
  if (await isDirectory(dir)) await loadDir(dir, dir, true, state);
  return { skills: state.skills, diagnostics: state.diagnostics };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/config/test/skills.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/skills.ts packages/config/test/skills.test.ts
git commit -m "feat(config): add agent skills loader (SKILL.md standard)"
```

---

### Task 2: Load profile skills from `agent/skills/` via `skills.ts`

**Files:**
- Modify: `packages/config/src/loader.ts`
- Modify: `packages/config/src/types.ts`
- Test: `packages/config/test/loader.test.ts`

**Interfaces:**
- Consumes: `loadSkillsFromDir`, `SkillPackage` from `./skills.js` (Task 1)
- Produces: `AgentConfig.skills: SkillPackage[]`; `AgentConfig.prompts: Record<string, string>` derived from skill bodies (kept for the desktop resolver)

- [ ] **Step 1: Write the failing test**

In `packages/config/test/loader.test.ts`, replace the fixture lines

```ts
'agent/skills.yaml': '- { name: clause_extract, file: prompts/clause_extract.md }\n',
'agent/prompts/clause_extract.md': '# extract clauses\n',
'agent/prompts/report.md': '# generate report\n',
```

with

```ts
'agent/skills/clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract clauses.\n---\n# extract clauses\n',
'agent/skills/report/SKILL.md': '---\nname: report\ndescription: Generate report.\n---\n# generate report\n',
```

and extend the assertions to

```ts
expect(p.agent.skills.map((s) => s.name).sort()).toEqual(['clause_extract', 'report']);
expect(p.agent.skills[0]?.description).toBeTruthy();
expect(p.agent.prompts).toMatchObject({ report: '# generate report\n', clause_extract: '# extract clauses\n' });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/config/test/loader.test.ts`
Expected: FAIL — `ProfileError: PROFILE_INVALID` with `missing file: agent/skills.yaml` (loader still reads the old registry).

- [ ] **Step 3: Implement**

In `packages/config/src/types.ts`, replace `SkillRef` with the standard package type:

```ts
import type { SkillPackage } from './skills.js';

export interface AgentConfig {
  skills: SkillPackage[];
  tools: string[];
  prompts: Record<string, string>;
  workflow: Record<string, unknown>;
  knowledge: Array<{ id: string; text: string }>;
}
```

Delete the `SkillRef` interface. Keep `PageSchema`, `ThemeRef`, `RoleConfig`, `ApprovalPolicy`, `ProfileManifest`, `ResolvedProfile` unchanged.

In `packages/config/src/loader.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseProfileManifest } from './schema.js';
import { computeIntegrity } from './integrity.js';
import { loadSkillsFromDir } from './skills.js';
import type { ResolvedProfile } from './types.js';
```

Remove the `skillsRaw` read and its `Object.assign` entry:

```ts
const skillsRaw = await read(dir, 'agent/skills.yaml');
```

and

```ts
'agent/skills.yaml': Buffer.from(skillsRaw), 'agent/tools.yaml': Buffer.from(toolsRaw),
```

becomes

```ts
'agent/tools.yaml': Buffer.from(toolsRaw),
```

Replace the skills-driven prompt loop:

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

with

```ts
const skillResult = await loadSkillsFromDir(join(dir, 'agent', 'skills'));
const skills = skillResult.skills;
const prompts: Record<string, string> = {};
for (const s of skills) {
  prompts[s.name] = s.content;
  files[s.relPath] = Buffer.from(s.raw);
}
```

The return value keeps the same shape:

```ts
return {
  manifest,
  agent: { skills, tools: toolsCfg.tools, prompts, workflow: parseYaml(workflowRaw) as Record<string, unknown>, knowledge },
  ui: { pages: { home: JSON.parse(pagesRaw) }, theme: themeCfg },
  security: { roles: parseYaml(rolesRaw)?.roles ?? [], approval: parseYaml(approvalRaw) },
};
```

Note: `readdir` is no longer used in `loader.ts`; remove it from the `node:fs/promises` import. If the `readdir` import removal leaves `join` unused anywhere else, keep `join` (it is used by `loadSkillsFromDir` call and the theme/corpus reads).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/config/test`
Expected: PASS (all config tests, including the new `skills.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/loader.ts packages/config/src/types.ts packages/config/test/loader.test.ts
git commit -m "refactor(config): load agent skills from SKILL.md packages"
```

---

### Task 3: Migrate the `contract-review` profile to SKILL.md packages

**Files:**
- Create: `profiles/contract-review/agent/skills/clause_extract/SKILL.md`
- Create: `profiles/contract-review/agent/skills/risk_compare/SKILL.md`
- Create: `profiles/contract-review/agent/skills/report/SKILL.md`
- Delete: `profiles/contract-review/agent/skills.yaml`
- Delete: `profiles/contract-review/agent/prompts/` (directory: `clause_extract.md`, `risk_compare.md`, `report.md`)

`profiles/contract-review/agent/workflow.yaml` is unchanged — `ref: clause_extract`, `ref: risk_compare`, `template: report` still resolve to the same skill names.

- [ ] **Step 1: Create the three SKILL.md files**

`profiles/contract-review/agent/skills/clause_extract/SKILL.md`:

```markdown
---
name: clause_extract
description: 从给定合同文本中抽取关键条款（标的、金额、付款、违约责任、争议解决、保密、验收），输出严格 JSON。用于合同审核工作流的条款抽取步骤。
---

从给定合同文本中抽取关键条款（标的、金额、付款、违约责任、争议解决、保密、验收）。
输出严格 JSON：{"clauses":[{"type":"...","summary":"...","risk":"low|medium|high","reason":"..."}]}
```

`profiles/contract-review/agent/skills/risk_compare/SKILL.md`:

```markdown
---
name: risk_compare
description: 对比抽取条款与检索到的法规条款，逐条给出风险等级与依据，输出严格 JSON。用于合同审核工作流的风险比对步骤。
---

对比抽取条款与检索到的法规条款，逐条给出风险等级与依据。
输出严格 JSON：{"comparisons":[{"clause":"...","regulation":"...","level":"low|medium|high","advice":"..."}]}
```

`profiles/contract-review/agent/skills/report/SKILL.md`:

```markdown
---
name: report
description: 将风险比对结果组织为结构化审核报告章节并调用 report.export 导出 Word 文档。用于合同审核工作流的最终报告步骤。
---

将风险比对结果组织为结构化审核报告章节（结论、风险明细、修改建议、复核意见），然后调用 report.export 工具导出为 Word 文档。
```

- [ ] **Step 2: Delete the old registry and prompts directory**

```bash
git rm profiles/contract-review/agent/skills.yaml
git rm -r profiles/contract-review/agent/prompts
```

> `.git` is read-only on this machine: run with escalation.

- [ ] **Step 3: Verify the loader handles the real profile**

Run: `pnpm exec vitest run packages/config/test`
Expected: PASS. Then sanity-check the real profile loads:

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
node --input-type=module -e "import('./packages/config/src/loader.ts').then(async (m) => { const p = await m.loadProfile('profiles/contract-review', { allowUnsigned: true }); console.log(p.agent.skills.map((s) => s.name).sort().join(',')); console.log(JSON.stringify(p.agent.prompts)); })"
```

Expected output: `clause_extract,report,risk_compare` and a prompts map with all three names.

- [ ] **Step 4: Commit**

```bash
git add profiles/contract-review/agent/skills profiles/contract-review/agent/workflow.yaml
git commit -m "refactor(profile): migrate contract-review skills to SKILL.md packages"
```

---

### Task 4: Full verification + rebuild + e2e pilot

The desktop runtime needs no code change: `resolveWorkflowTemplates` still resolves `ref`/`template` against `profile.agent.prompts`, which the new loader derives from SKILL.md bodies.

- [ ] **Step 1: Full unit tests + type check**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm test
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: all tests pass; `tsc --noEmit` exit 0.

- [ ] **Step 2: Rebuild renderer + main**

```powershell
pnpm --filter @sparkii/desktop run build:renderer
pnpm --filter @sparkii/desktop run build:main
```

Expected: both succeed (vite build; esbuild main/preload/pi-runtime bundles).

- [ ] **Step 3: Run the e2e pilot**

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: 1 passed — report step uses the migrated `report` SKILL.md body, calls `report.export` once, one approval dialog, export path from `SPARKII_E2E_EXPORT_DIR`, then `审核完成`.

If it fails, report the exact step and `SPARKII_DATA_DIR` audit rows; do not fake success.

- [ ] **Step 4: No commit** (verification only; Task 1–3 commits already landed)

---

## Out of Scope / Future Extensions

- Multi-location skill discovery (`~/.pi/agent/skills`, `.pi/skills`, package `pi.skills`).
- `<available_skills>` XML catalog in the system prompt + model-driven `read` tool (requires an agent loop in `LinearRunner`).
- `allowed-tools` / `compatibility` / `license` enforcement.
- Loading `scripts/`, `references/`, `assets/` into the profile integrity file set (currently only `SKILL.md` files are integrity-tracked).

## Self-Review

1. **Spec coverage:** Format (SKILL.md + frontmatter) → Task 1/3. Discovery + validation + collisions → Task 1. Loader switch → Task 2. Profile migration → Task 3. Runtime compatibility → verified by Task 4. All four key design decisions are listed above for parent confirmation.
2. **Placeholder scan:** No TBD/TODO; all code blocks and file contents are concrete.
3. **Type consistency:** `SkillPackage` is defined in Task 1 and imported by `types.ts` in Task 2; `loadSkillsFromDir(dir): Promise<LoadSkillsResult>` is used identically in Task 2; `AgentConfig.skills` becomes `SkillPackage[]` and nothing else consumes it (verified by search). `profile.agent.prompts` shape is unchanged, so `resolveWorkflowTemplates` and `workflow-broker.test.ts` need no edits.

---

## Appendix: Prior Task Completion Report (2026-08-24 · workflow prompt resolution, Task 1–3)

**git log (2 new commits on top of `7a16d97`):**

```
dab6139 fix(desktop): resolve workflow skill and template prompts
3fb7698 fix(config): load all agent prompts including workflow templates
7a16d97 docs: add workflow prompt resolution plan
```

Branch `codex/pi-embedded-runtime`, ahead 2, working tree clean. `package.json` / `pnpm-lock.yaml` untouched.

**Task summaries:**
- Task 1: `loader.ts` now `readdir`s `agent/prompts/` for all `.md` files (basename minus `.md` as key), so `report.md` loads; test fixture + assertion added per plan. No deviation.
- Task 2: `workflow.ts` gains exported `resolveWorkflowTemplates`; `runWorkflow` resolves `rawDef` + `prompts` into `def`; broker test added per plan. No deviation.
- Task 3: full tests, type check, renderer/main rebuild, e2e pilot. No deviation, no separate commit.

Each task followed TDD (RED → minimal implementation → GREEN) and was committed separately with the exact plan messages.

**Verification results:**

| Command | Result |
|---|---|
| `pnpm test` | 39 files / 80 tests, all passed |
| `pnpm --filter @sparkii/desktop run build:main:check` | exit 0 (tsc --noEmit) |
| `pnpm --filter @sparkii/desktop run build:renderer` | success (22 modules) |
| `pnpm --filter @sparkii/desktop run build:main` | success (4 esbuild bundles) |
| `playwright test e2e/pilot.spec.ts` | 1 passed (51.6s); one `report.export` approval, export via `SPARKII_E2E_EXPORT_DIR`, `审核完成` shown |

**Blockers / notes:**
- No blockers. `~/.pi/agent` has DeepSeek configured (settings.json → deepseek-v4-pro; auth.json has api_key), so the pilot ran for real.
- The user's node path note (`C:\Users\YDJ.cache\...`) was a typo; actual path is `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`.
- Caution: while checking `~/.pi/agent/auth.json`, an earlier tool output exposed a prefix of the DeepSeek API key. Avoid printing that file's values in future output.
- Audit trail for the last pilot lives in `%TEMP%\pilot-data-Hmvfvf\audit.db` (3 rows: proposal.created / proposal.approved / proposal.executed for `report.export`); exported docx in `%TEMP%\pilot-export-o03Qrk\report.docx`.
