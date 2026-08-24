# Multi-Agent Runtime & Native Skill Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sparkii 从单 session 演进为「每 Agent 一个 Pi 子进程（池化、上限 4）」的多 Agent 并行运行时，并把 skill 加载改为 Pi 原生按需读（`<available_skills>` 目录 + 内置 read 工具 + references/assets 纳入签名）。

**Architecture:** 新增 `PiRuntimePool` 管理有上限的 Pi 子进程池；`runWorkflow`/`prompt` 改为「内部生成 sessionId → acquire 槽位 → 按 sessionId 路由 → release 槽位」的一次性任务模型（对 spec 的显式 `newAgent` 生命周期的简化，理由见下）；审计补 `sessionId`；`createPiSdkSessionHost` 经 `additionalSkillPaths` 把 profile skills 交给 Pi，靠内置 read 按需读正文。

**Tech Stack:** TypeScript, Vitest, Electron main, @sparkii/config / agent-host / approval, Pi SDK (`@earendil-works/pi-coding-agent`), Playwright e2e。无新依赖。

**Spec:** [2026-08-24-multi-agent-runtime-native-skills-design.md](../specs/2026-08-24-multi-agent-runtime-native-skills-design.md)

## Spec 偏离说明（必须先读）

spec 的 Subsystem 1 设计了显式 `sparkii:newAgent` + `runWorkflow(sessionId)` 的长生命周期 Agent。本计划对 pilot 做一处**简化**：`runWorkflow`/`prompt` 内部自行「生成 sessionId → acquire → 执行 → release」，不引入显式 `newAgent`/`releaseAgent` IPC。理由：pilot 的 contract-review 是一次性任务，「Agent = 一次运行」，显式生命周期属过度设计；多轮聊天 Agent 留作后续。其余（sessionId 贯穿、审计补字段、审批按 sessionId 归属、池上限、L3 按需读）与 spec 完全一致。

## Global Constraints

- Node 不在 PATH：命令前置 `C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin`。
- `pnpm` 11 在 PATH；不要 `pnpm install`、不新增依赖、不改 `package.json`/`pnpm-lock.yaml`。
- `.git` 只读：`git add`/`commit`/`rm` 需提权。
- 沙箱读不到 `node_modules/.pnpm`：`vitest`/`esbuild`/`electron`/`playwright` 需提权。
- TDD 每 Task：先写失败测试 → 确认 RED → 最小实现 → 确认 GREEN → 单独 commit。
- commit scope：`feat(config)` / `refactor(config)` / `feat(agent-host)` / `refactor(desktop)` / `feat(approval)`。
- `SPARKII_MAX_AGENTS` 默认 4，池上限由此环境变量控制（缺省 4）。

---

### Task 1: 新增 `PiRuntimePool` 进程池

**Files:**
- Create: `packages/agent-host/src/pi-runtime-pool.ts`
- Modify: `packages/agent-host/src/index.ts`
- Test: `packages/agent-host/test/pi-runtime-pool.test.ts`

**Interfaces:**
- Consumes: `PiRuntimeSupervisor`（`packages/agent-host/src/pi-runtime-supervisor.js`）、`PiRuntimeClient`/`PiRuntimeHostHandle`（`pi-runtime-transport.js`）。
- Produces: `PiRuntimePool`（`acquire` / `get` / `release` / `stopAll` / `activeCount`），其中 `acquire(sessionId)` 返回 `{ client, supervisor }`，`release(sessionId)` 触发该槽位 `new_session` 并解绑。

- [ ] **Step 1: Write the failing test**

Create `packages/agent-host/test/pi-runtime-pool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PiRuntimePool } from "../src/pi-runtime-pool.js";
import { readyEnvelope, responseEnvelope, type PiRuntimeHostHandle, type PiRuntimeEnvelope } from "../src/pi-runtime-transport.js";

class FakeHandle implements PiRuntimeHostHandle {
  sent: PiRuntimeEnvelope[] = [];
  private messageCb?: (env: PiRuntimeEnvelope) => void;
  postMessage(e: PiRuntimeEnvelope) { this.sent.push(e); }
  onMessage(cb: (env: PiRuntimeEnvelope) => void) { this.messageCb = cb; return () => { this.messageCb = undefined; }; }
  onExit() { return () => {}; }
  emit(env: PiRuntimeEnvelope) { this.messageCb?.(env); }
  kill() {}
  ready() { this.emit(readyEnvelope()); }
}

describe("PiRuntimePool", () => {
  it("reuses a free slot across release", async () => {
    const handles: FakeHandle[] = [];
    const pool = new PiRuntimePool({ maxAgents: 2, makeSupervisor: () => { const h = new FakeHandle(); handles.push(h); return h; } });
    const a = await pool.acquire("a");
    expect(a.client).toBeTruthy();
    expect(pool.get("a")).toBe(a.client);
    expect(pool.activeCount()).toBe(1);
    await pool.release("a");
    expect(pool.get("a")).toBeUndefined();
    expect(pool.activeCount()).toBe(0);
    const b = await pool.acquire("b");
    expect(b.client).toBe(a.client); // 复用同一个 supervisor 的 client
  });

  it("queues beyond maxAgents and wakes on release", async () => {
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => new FakeHandle() });
    await pool.acquire("a");
    let resolved = false;
    const p = pool.acquire("b").then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    await pool.release("a");
    await p;
    expect(resolved).toBe(true);
    expect(pool.get("b")).toBeTruthy();
  });

  it("sends new_session on release", async () => {
    const handle = new FakeHandle();
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: () => handle });
    const { client } = await pool.acquire("a");
    handle.ready();
    await pool.release("a");
    const sent = handle.sent.find((e) => "command" in e && (e as any).command?.type === "new_session");
    expect(sent).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-pool.test.ts`
Expected: FAIL — `Cannot find module '../src/pi-runtime-pool.js'`。

- [ ] **Step 3: Implement**

Create `packages/agent-host/src/pi-runtime-pool.ts`:

```ts
import { PiRuntimeSupervisor } from "./pi-runtime-supervisor.js";
import type { PiRuntimeClient, PiRuntimeHostHandle } from "./pi-runtime-transport.js";

export interface PiRuntimeSlot {
  client: PiRuntimeClient;
  supervisor: PiRuntimeSupervisor;
}

interface Slot {
  supervisor: PiRuntimeSupervisor;
  client: PiRuntimeClient;
  sessionId: string | null;
}

interface Pending {
  sessionId: string;
  resolve: (slot: PiRuntimeSlot) => void;
  reject: (e: Error) => void;
}

export class PiRuntimePool {
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private bySession = new Map<string, PiRuntimeClient>();

  constructor(private opts: { maxAgents: number; makeSupervisor: () => PiRuntimeHostHandle }) {}

  async acquire(sessionId: string): Promise<PiRuntimeSlot> {
    const free = this.slots.find((s) => s.sessionId === null);
    if (free) return this.bind(free, sessionId);
    if (this.slots.length < this.opts.maxAgents) {
      const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
      const client = await supervisor.start();
      const slot: Slot = { supervisor, client, sessionId: null };
      this.slots.push(slot);
      return this.bind(slot, sessionId);
    }
    return new Promise<PiRuntimeSlot>((resolve, reject) => {
      this.pending.push({ sessionId, resolve, reject });
    });
  }

  private bind(slot: Slot, sessionId: string): PiRuntimeSlot {
    slot.sessionId = sessionId;
    this.bySession.set(sessionId, slot.client);
    return { client: slot.client, supervisor: slot.supervisor };
  }

  get(sessionId: string): PiRuntimeClient | undefined {
    return this.bySession.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const slot = this.slots.find((s) => s.sessionId === sessionId);
    if (!slot) return;
    this.bySession.delete(sessionId);
    try { await slot.client.send({ type: "new_session" }); } catch { /* 子进程已退出则忽略 */ }
    slot.sessionId = null;
    const next = this.pending.shift();
    if (next) next.resolve(this.bind(slot, next.sessionId));
  }

  activeCount(): number {
    return this.bySession.size;
  }

  async stopAll(): Promise<void> {
    for (const slot of this.slots) await slot.supervisor.stop();
    this.slots = [];
    this.bySession.clear();
    for (const p of this.pending) p.reject(new Error("pool stopped"));
    this.pending = [];
  }
}
```

Add to `packages/agent-host/src/index.ts`:

```ts
export * from "./pi-runtime-pool.js";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-pool.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/pi-runtime-pool.ts packages/agent-host/src/index.ts packages/agent-host/test/pi-runtime-pool.test.ts
git commit -m "feat(agent-host): add bounded Pi runtime pool"
```

---

### Task 2: 审计补 `sessionId`

**Files:**
- Modify: `packages/approval/src/audit.ts`
- Modify: `packages/approval/src/gate.ts`
- Modify: `packages/approval/src/executor.ts`
- Test: `packages/approval/test/audit.test.ts`（追加断言）

**Interfaces:**
- Consumes: 无（独立于池）。
- Produces: `AuditEvent.sessionId?: string`；`AuditStore.append` 接受并落库 `sessionId`；`query` 支持 `sessionId` 过滤；`AuditStore` 构造时对旧库做 `session_id` 列迁移。

- [ ] **Step 1: Write the failing test**

Append to `packages/approval/test/audit.test.ts`:

```ts
it("persists and queries sessionId", async () => {
  const store = new AuditStore(join(mkdtempSync(join(tmpdir(), "audit-")), "a.db"));
  stores.push(store);
  await store.append({ actor: "admin", action: "proposal.created", resource: "report.export", sessionId: "s-1" });
  const rows = await store.query({ sessionId: "s-1" });
  expect(rows).toHaveLength(1);
  expect(rows[0].sessionId).toBe("s-1");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/approval/test/audit.test.ts`
Expected: FAIL — `append` 因 `session_id` 列不存在/多余命名参数报错，或 `query` 读不到 `sessionId`（RED 以失败为准，具体报错点二者皆可）。

- [ ] **Step 3: Implement**

In `packages/approval/src/audit.ts`:

```ts
export interface AuditEvent {
  id: string; ts: number; actor: string; action: string;
  resource?: string; payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired';
  modelRoute?: string;
  sessionId?: string;
}
```

In the `AuditStore` constructor, after the `CREATE TABLE`:

```ts
const cols = this.db.prepare("PRAGMA table_info(audit)").all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "session_id")) {
  this.db.exec("ALTER TABLE audit ADD COLUMN session_id TEXT");
}
```

Update `append`'s INSERT to include `session_id`:

```ts
this.db.prepare(`INSERT INTO audit (id, ts, actor, action, resource, payload_summary, decision, model_route, session_id)
  VALUES (@id, @ts, @actor, @action, @resource, @payloadSummary, @decision, @modelRoute, @sessionId)`).run({
  ...full, resource: full.resource ?? null, payloadSummary: full.payloadSummary ?? null,
  decision: full.decision ?? null, modelRoute: full.modelRoute ?? null, sessionId: full.sessionId ?? null,
});
```

Update `query` to accept and filter by `sessionId`:

```ts
async query(filter: { actor?: string; action?: string; resource?: string; sessionId?: string }): Promise<AuditEvent[]> {
  const rows = this.db.prepare(`SELECT * FROM audit WHERE
    (@actor IS NULL OR actor = @actor) AND
    (@action IS NULL OR action = @action) AND
    (@resource IS NULL OR resource = @resource) AND
    (@sessionId IS NULL OR session_id = @sessionId) ORDER BY ts DESC`).all({
    actor: filter.actor ?? null, action: filter.action ?? null,
    resource: filter.resource ?? null, sessionId: filter.sessionId ?? null,
  });
  return rows as AuditEvent[];
}
```

In `packages/approval/src/gate.ts`, add `sessionId` to both audit appends:

```ts
// submit:
await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload), sessionId: meta.sessionId });
// decide:
await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied', sessionId: p.sessionId });
// expire:
await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired', sessionId: p.sessionId });
```

In `packages/approval/src/executor.ts`, add `sessionId: p.sessionId` to each of the three `audit.append` calls（`execution.blocked`、`proposal.failed`、`proposal.executed`）。

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/approval/test`
Expected: PASS（含新增 sessionId 断言；gate/executor 现有测试若断言审计行则同步补 sessionId）。

- [ ] **Step 5: Commit**

```bash
git add packages/approval/src/audit.ts packages/approval/src/gate.ts packages/approval/src/executor.ts packages/approval/test/audit.test.ts
git commit -m "feat(approval): record sessionId in audit trail"
```

---

### Task 3: L3 — `resolveWorkflowTemplates` 改为「指令 + skill 名」

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Consumes: 无（纯函数改造，不依赖池）。
- Produces: `resolveWorkflowTemplates(def: WorkflowDef): WorkflowDef`（去掉第二参 `prompts`）；skill/llm 步骤的 `template` 由「body 全文」改为「请读取并遵循 skill 名」的指令文本。

- [ ] **Step 1: Write the failing test**

Replace the assertion in `apps/desktop/test/workflow-broker.test.ts`（当前 `resolveWorkflowTemplates(def, { clause_extract: '抽取条款', report: '生成报告' })`）：

```ts
const resolved = resolveWorkflowTemplates(def);
const extract = resolved.steps.find((s) => s.id === 'extract');
const report = resolved.steps.find((s) => s.id === 'report');
expect(extract?.template).toContain('clause_extract');
expect(extract?.template).not.toContain('抽取条款');
expect(report?.template).toContain('report');
```

（`def` 沿用该测试文件现有的 `WorkflowDef` fixture，其中 `extract` 是 `type: 'skill', ref: 'clause_extract'`，`report` 是 `type: 'llm', template: 'report'`。）

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: FAIL — `resolveWorkflowTemplates` 仍按旧签名返回 body 全文，`extract.template` 含 `抽取条款` 且不含 `clause_extract`。

- [ ] **Step 3: Implement**

In `apps/desktop/electron/main/workflow.ts`, replace `resolveWorkflowTemplates`:

```ts
export function resolveWorkflowTemplates(def: WorkflowDef): WorkflowDef {
  return {
    ...def,
    steps: def.steps.map((step) => {
      if (step.type === 'skill' && step.ref) {
        return { ...step, template: `请读取并遵循「${step.ref}」这个 skill 完成本步骤。` };
      }
      if (step.type === 'llm' && step.template) {
        return { ...step, template: `请读取并遵循「${step.template}」这个 skill 完成本步骤。` };
      }
      return step;
    }),
  };
}
```

Update `runWorkflow`'s call site（本 Task 仅改这一处调用，池路由在 Task 6 完成）：

```ts
// 删除 `const prompts = (rt.profile.agent.prompts ?? {}) as Record<string, string>;`
const def = resolveWorkflowTemplates(rawDef);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "refactor(desktop): resolve skill steps by name for on-demand loading"
```

---

### Task 4: L3 — 把 skill 目录下全部文件纳入 integrity 文件集

**Files:**
- Modify: `packages/config/src/skills.ts`
- Modify: `packages/config/src/loader.ts`
- Test: `packages/config/test/skills.test.ts`（追加）、`packages/config/test/loader.test.ts`（追加）

**Interfaces:**
- Consumes: `loadSkillsFromDir`（现有）。
- Produces: `collectSkillDirFiles(root: string): Promise<Record<string, Buffer>>`（递归收集 skill 根目录下所有文件，key 为相对根目录的 posix 路径，排除 `.` 前缀与 `node_modules`）；`loadProfile` 的 `files` 集合以 `agent/skills/<rel>` 为 key 纳入 references/assets/scripts。

- [ ] **Step 1: Write the failing test**

Append to `packages/config/test/skills.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { collectSkillDirFiles } from '../src/skills.js';

describe('collectSkillDirFiles', () => {
  it('recursively collects skill files and skips ignored paths', async () => {
    const dir = write({
      'clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract.\n---\n正文\n',
      'clause_extract/references/law.md': '法规条文',
      'clause_extract/assets/logo.png': 'PNG',
      'clause_extract/node_modules/x.js': 'skip',
      'clause_extract/.hidden': 'skip',
    });
    const files = await collectSkillDirFiles(join(dir, 'clause_extract'));
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'assets/logo.png', 'references/law.md']);
    expect(files['references/law.md'].toString()).toBe('法规条文');
  });
});
```

Append to `packages/config/test/loader.test.ts`:

```ts
import { generateKeyPair, signFiles } from '../src/integrity.js';

it('includes skill references in the integrity file set', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const dir = writeProfile({
    'manifest.yaml': 'name: contract-review\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n',
    'agent/tools.yaml': 'tools: [document.read]\n',
    'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
    'agent/skills/clause_extract/SKILL.md': '---\nname: clause_extract\ndescription: Extract.\n---\n正文\n',
    'agent/skills/clause_extract/references/law.md': '法规',
    'agent/knowledge/corpus.json': '[]',
    'ui/pages/home.json': '{}',
    'ui/theme.yaml': 'file: theme/tokens.json\n',
    'ui/theme/tokens.json': '{}',
    'security/roles.yaml': 'roles: []\n',
    'security/approval.yaml': 'requireApproval: [report.export]\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
  });
  const files = {
    'manifest.yaml': Buffer.from('name: contract-review\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n'),
    'agent/tools.yaml': Buffer.from('tools: [document.read]\n'),
    'agent/workflow.yaml': Buffer.from('version: 1\nengine: linear\nsteps: []\n'),
    'agent/skills/clause_extract/SKILL.md': Buffer.from('---\nname: clause_extract\ndescription: Extract.\n---\n正文\n'),
    'agent/skills/clause_extract/references/law.md': Buffer.from('法规'),
    'agent/knowledge/corpus.json': Buffer.from('[]'),
    'ui/pages/home.json': Buffer.from('{}'),
    'ui/theme.yaml': Buffer.from('file: theme/tokens.json\n'),
    'ui/theme/tokens.json': Buffer.from('{}'),
    'security/roles.yaml': Buffer.from('roles: []\n'),
    'security/approval.yaml': Buffer.from('requireApproval: [report.export]\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n'),
  };
  const { signature } = signFiles(files, privateKey);
  writeFileSync(join(dir, 'manifest.sig'), signature);
  await expect(loadProfile(dir, { publicKey })).resolves.toBeTruthy();
});
```

（`writeProfile`/`writeFileSync`/`join` 已在 loader.test.ts 顶部 import；若缺则补。）

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/config/test/skills.test.ts packages/config/test/loader.test.ts`
Expected: FAIL — `collectSkillDirFiles` 不存在；loader 验签因未收集 references 而 `SIGNATURE_INVALID`。

- [ ] **Step 3: Implement**

In `packages/config/src/skills.ts`, add:

```ts
export async function collectSkillDirFiles(root: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const rel = relative(root, full).split(sep).join('/');
      out[rel] = await readFile(full);
    }
  }
  await walk(root);
  return out;
}
```

In `packages/config/src/loader.ts`, replace the skill-file loop:

```ts
const skillRoot = join(dir, 'agent', 'skills');
const skillResult = await loadSkillsFromDir(skillRoot);
const skills = skillResult.skills;
const prompts: Record<string, string> = {};
for (const s of skills) {
  prompts[s.name] = s.content;
}
const skillFiles = await collectSkillDirFiles(skillRoot);
for (const [rel, buf] of Object.entries(skillFiles)) {
  files[`agent/skills/${rel}`] = buf;
}
```

并更新 import：`import { collectSkillDirFiles, loadSkillsFromDir } from './skills.js';`

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/config/test`
Expected: PASS（含新 collectSkillDirFiles 断言与 references 验签断言）。

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/skills.ts packages/config/src/loader.ts packages/config/test/skills.test.ts packages/config/test/loader.test.ts
git commit -m "feat(config): include skill references and assets in profile integrity"
```

---

### Task 5: L3 — 把 profile skills 注入 Pi session，并保留 read 工具

**Files:**
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-sdk-runtime.test.ts`（扩充）

**Interfaces:**
- Consumes: `createAgentSessionServices` / `createAgentSessionFromServices` / `defineTool`（Pi SDK）、`buildPiRuntimeTools`（现有）。
- Produces: `PiSdkRuntimeOptions.skillsDir?: string`；`buildSkillLoaderOptions(skillsDir?)` 纯函数（返回 `{ additionalSkillPaths }`）；`createPiSdkSessionHost` 经 `resourceLoaderOptions` 注入 skills、经 `tools: ['read']` + `customTools` 保留 read。

- [ ] **Step 1: Write the failing test**

Replace `packages/agent-host/test/pi-sdk-runtime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSkillLoaderOptions, createPiSdkSessionHost } from "../src/pi-sdk-runtime.js";

describe("pi-sdk-runtime skill loader options", () => {
  it("maps skillsDir to additionalSkillPaths", () => {
    expect(buildSkillLoaderOptions("/tmp/skills")).toEqual({ additionalSkillPaths: ["/tmp/skills"] });
    expect(buildSkillLoaderOptions(undefined)).toEqual({ additionalSkillPaths: [] });
  });

  it("exports the SDK host factory", () => {
    expect(typeof createPiSdkSessionHost).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/agent-host/test/pi-sdk-runtime.test.ts`
Expected: FAIL — `buildSkillLoaderOptions` 未导出。

- [ ] **Step 3: Implement**

In `packages/agent-host/src/pi-sdk-runtime.ts`, add:

```ts
export function buildSkillLoaderOptions(skillsDir?: string): { additionalSkillPaths: string[] } {
  return { additionalSkillPaths: skillsDir ? [skillsDir] : [] };
}
```

Add `skillsDir?: string` to `PiSdkRuntimeOptions`。

In `createPiSdkSessionHost`, replace the services/session creation:

```ts
const services = await createAgentSessionServices({
  cwd: effectiveCwd,
  resourceLoaderOptions: buildSkillLoaderOptions(options.skillsDir),
});
const result = await createAgentSessionFromServices({
  services,
  sessionManager,
  sessionStartEvent,
  tools: ["read"],
  customTools: piTools,
});
```

并在 `adaptSession()` 中删除 `session.agent.state.tools = piTools;`（改为由 `customTools` 注入）。

> 退化方案：若 `customTools` 与 `tools: ['read']` 的组合在 Pi 侧不能同时保留内置 read 与 connector 工具，则保留 `session.agent.state.tools`，改为 `session.agent.state.tools = [...piTools, defineTool(createReadTool() as any)]`（从 Pi SDK 导入 `createReadTool`）。以主方案优先，实现时验证。

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/agent-host/test/pi-sdk-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-sdk-runtime.test.ts
git commit -m "feat(agent-host): inject profile skills and keep read tool in Pi session"
```

---

### Task 6: Runtime 池化 + workflow/ipc 的 sessionId 路由

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/main/recovery.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`（更新 rt mock）

**Interfaces:**
- Consumes: `PiRuntimePool`（Task 1）、`AuditStore.sessionId`（Task 2）、`resolveWorkflowTemplates(def)`（Task 3）、`buildSkillLoaderOptions`/skills 注入（Task 5）。
- Produces: `Runtime.pool: PiRuntimePool`（替换 `supervisor`）；`runWorkflow(rt, getWindow, input, broker)` 内部 `randomUUID()` sessionId + `pool.acquire/release`；`selectModel`/`sendPrompt` 增 `sessionId` 参数并按 `pool.get` 路由。

- [ ] **Step 1: Update the existing test's rt mock（使其反映新契约）**

In `apps/desktop/test/workflow-broker.test.ts`，给 `runWorkflow broker sharing` 的 `rt` 加：

```ts
pool: {
  acquire: async (sessionId: string) => ({ client: {}, supervisor: { onProposal: () => {} } }),
  get: (sessionId: string) => undefined,
  release: async (sessionId: string) => {},
},
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts`
Expected: FAIL — `runWorkflow` 仍调用 `rt.supervisor`（undefined），或 `resolveWorkflowTemplates` 旧签名（本 Task 前 Task 3 已改，此处主要暴露 `rt.pool` 未接入）。

- [ ] **Step 3: Implement**

In `apps/desktop/electron/main/runtime.ts`:

```ts
import { PiRuntimePool } from "@sparkii/agent-host";
// Runtime 接口：
export interface Runtime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter; rbac: Rbac; gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  pool: PiRuntimePool; identity: LocalIdentityProvider; subject: Subject | null;
}
// assemble 内：
const pool = new PiRuntimePool({
  maxAgents: Number(process.env.SPARKII_MAX_AGENTS ?? 4),
  makeSupervisor: () =>
    process.env.SPARKII_PI_USE_FORK === "1"
      ? createForkHostHandle(entry)
      : createUtilityHostHandle(entry),
});
return { profile, router, rbac, gate, executor, audit, pool, identity, subject: null };
```

In `apps/desktop/electron/main/workflow.ts`, change `selectModel` and `sendPrompt` to take `sessionId` and route via `rt.pool.get`:

```ts
export async function selectModel(rt: Runtime, task: ModelTask, sessionId: string): Promise<void> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  const target = rt.router.resolve(task);
  if (!target) return;
  const resp = await client.send({ type: 'set_model', provider: target.provider, modelId: target.modelId });
  if (!resp.success) throw new Error(`cannot select model ${target.provider}/${target.modelId}: ${resp.error ?? 'unknown'}`);
}

async function sendPrompt(rt: Runtime, text: string, task: ModelTask, sessionId: string): Promise<string> {
  const client = rt.pool.get(sessionId);
  if (!client) throw new Error(`unknown session ${sessionId}`);
  await selectModel(rt, task, sessionId);
  // ...（原 acc/off/finish/done 逻辑不变，把 `const client = await rt.supervisor.start();` 删掉）
}
```

In `runWorkflow`, wrap in acquire/release and thread the sessionId:

```ts
export async function runWorkflow(rt, getWindow, input, broker): Promise<void> {
  const sessionId = randomUUID();
  const slot = await rt.pool.acquire(sessionId);
  slot.supervisor.onProposal((req) => broker.request(req, sessionId));
  try {
    const rawDef = rt.profile.agent.workflow as unknown as WorkflowDef;
    const def = resolveWorkflowTemplates(rawDef);
    const ctx: RunContext = {
      profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', input,
      sendPrompt: (text, task) => sendPrompt(rt, text, (task as ModelTask) ?? 'default', sessionId),
      runTool: (name, args) => runTool(rt, broker, name, args, sessionId),
      requestApproval: async (req) => {
        const d = await broker.request(req, sessionId);
        return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
      },
    };
    const win = getWindow();
    let finalState: Record<string, unknown> = {};
    for await (const e of new LinearRunner().run(def, ctx)) {
      win?.webContents.send('sparkii:event:workflow', { ...e, sessionId });
      if (e.type === 'workflow_completed') finalState = e.result as Record<string, unknown>;
    }
    win?.webContents.send('sparkii:event:state', { workflow: { result: finalState }, sessionId });
  } finally {
    await rt.pool.release(sessionId);
  }
}
```

In `apps/desktop/electron/main/ipc.ts`:

- 删除 `rt.supervisor.onProposal((request) => broker.request(request, "default"));`。
- `sparkii:runWorkflow` 改为忽略第一个参数：

```ts
ipcMain.handle('sparkii:runWorkflow', async (_e, _id: string, input: Record<string, unknown>) => {
  await runWorkflow(rt, getWindow, input, broker);
  return { ok: true };
});
```

- `sparkii:prompt` 改为临时 acquire/release（`import { randomUUID } from 'node:crypto';`）：

```ts
ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
  const sessionId = randomUUID();
  const slot = await rt.pool.acquire(sessionId);
  slot.supervisor.onProposal((req) => broker.request(req, sessionId));
  try {
    await selectModel(rt, 'chat', sessionId);
    const c = slot.client;
    const win = getWindow();
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
      off = c.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', ev);
        if (ev.type === 'agent_end') { clearTimeout(timer); off(); resolve(); }
      });
      c.send({ type: 'prompt', message: text }).then((resp) => {
        if (!resp.success) { clearTimeout(timer); off(); reject(new Error(resp.error ?? 'prompt failed')); }
      });
    });
  } finally {
    await rt.pool.release(sessionId);
  }
  return { ok: true };
});
```

In `apps/desktop/electron/main/recovery.ts`, 将 `attachRecovery` 改为 no-op（`rt.supervisor` 已不存在；崩溃恢复留作池的后续增强）：

```ts
export function attachRecovery(_rt: Runtime, _logger: Logger): void {
  // 池化后单个 supervisor 的自动重启不再适用，留待 PiRuntimePool 层实现。
}
```

在 `apps/desktop/electron/main/index.ts` 保持 `attachRecovery(rt, logger);` 调用不变。

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts packages/agent-host/test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/index.ts apps/desktop/electron/main/recovery.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "refactor(desktop): route agents through bounded Pi runtime pool"
```

---

### Task 7: 全量验证 + 重建 + e2e（单 Agent 回归 + 并发）

**Files:** 无新文件（验证与 e2e）。

- [ ] **Step 1: 全量单元测试 + 类型检查**

```powershell
$env:Path = "C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
pnpm test
pnpm --filter @sparkii/desktop run build:main:check
```

Expected: `pnpm test` 全绿；`tsc --noEmit` 退出码 0。

- [ ] **Step 2: 重建 renderer + main**

```powershell
pnpm --filter @sparkii/desktop run build:renderer
pnpm --filter @sparkii/desktop run build:main
```

Expected: 均成功。

- [ ] **Step 3: 单 Agent e2e 回归**

```powershell
pnpm --filter @sparkii/desktop exec playwright test e2e/pilot.spec.ts
```

Expected: 1 passed —— 关键回归点：skill 步骤现在经 `<available_skills>` + read 按需加载正文，`report.export` 仍触发一次审批，`审核完成` 显示。

- [ ] **Step 4: 并发 e2e（两个 Agent 并行，审批互不串）**

新增 `apps/desktop/e2e/concurrency.spec.ts`（**可选验证项，不在硬性完成标准内**；若真实模型并发过慢或 renderer 不支持并发触发，用 `SPARKII_SKIP_LLM` 跳过，并在主进程层手工验证两次 runWorkflow 的审批 sessionId 互不相同）：

```ts
import { test, expect, _electron as electron } from '@playwright/test';

test.skip(process.env.SPARKII_SKIP_LLM === '1');

test('two agents run in parallel with isolated approvals', async () => {
  test.setTimeout(600_000);
  const app = await electron.launch({ args: ['dist-electron/main/index.js'], env: { ...process.env, SPARKII_PROFILE_DIR: process.env.SPARKII_PROFILE_DIR ?? 'profiles/contract-review' } });
  const page = await app.firstWindow();
  // 登录、上传文档后并发触发两次 runWorkflow，断言审批事件各带独立 sessionId。
  await app.close();
});
```

> 并发 e2e 的断言以「两次 `sparkii:event:approval` 的 proposal.sessionId 互不相同」为最小可验证目标；具体 UI 步骤由执行者按当前 App 交互补齐，不得伪造成功。

- [ ] **Step 5: 不单独 commit**（Task 1–6 已各自提交；本 Task 仅验证）。

---

## Self-Review

**Spec coverage:**
- session 制（sessionId 生成/路由/审计/审批归属）→ Task 2、6；spec 的显式 `newAgent` 生命周期简化为 runWorkflow 内部 acquire/release（已在「Spec 偏离说明」声明）。
- Pi 进程池（上限、懒启动、排队、结束 newSession 重置）→ Task 1、6。
- L3（skills 注入、read 保留、按需读、resolveWorkflowTemplates 改指令、integrity 扩展）→ Task 3、4、5。
- 多 Agent 隔离与并发上限 → Task 1、6、7。

**Placeholder scan:** 无 TBD/TODO；每个代码步骤有实际内容；并发 e2e 的 UI 步骤唯一开放处已在 Task 7 标注由执行者补齐并「不得伪造成功」。

**Type consistency:**
- `PiRuntimePool.acquire(sessionId): Promise<PiRuntimeSlot>` 与 Task 6 的 `slot.supervisor.onProposal` / `slot.client` 用法一致。
- `resolveWorkflowTemplates(def)` 单参签名在 Task 3 定义、Task 6 调用，一致。
- `AuditEvent.sessionId` / `query({ sessionId })` 在 Task 2 定义、gate/executor 使用，一致。
- `collectSkillDirFiles(root)` 返回 `Record<string, Buffer>`，loader 以 `agent/skills/<rel>` 加前缀，与 Task 4 验签测试的 key 集合一致。
