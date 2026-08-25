# 通用智能体运行时（Runtime）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Sparkii Desktop 落地「通用智能体」的运行时底座：多 profile 加载、统一加固 Pi 进程池 + 会话级鞍（configure_session）、编码工具经 Main 审批执行、持久会话与工作区、通用智能体 profile。

**Architecture:** 池内所有 Pi 子进程是同一份「加固统一内核」——bash/edit/write 的 operations 固定路由 Main，写安全是池级不变量、与鞍无关。每个会话由 Main 下发鞍（工具清单/skills/cwd/系统提示/工作区根），子进程按鞍注册工具（未注册即不可见、不可调）。写操作（bash 写命令 / edit / write）经 proposal 通道由 Main 审批后由确定性执行器执行；只读命令按严格白名单由 Main 直通执行。

**Tech Stack:** TypeScript（strict，ESM，import 带 `.js` 后缀）、Node ≥ 22、pnpm workspaces、vitest、better-sqlite3、Electron main process、`@earendil-works/pi-coding-agent`。

**Spec:** [2026-08-25-general-agent-design.md](../specs/2026-08-25-general-agent-design.md)（本计划从 spec 论证，执行者必须同时阅读）

## Global Constraints

- ESM + strict TS：新文件一律 `"type": "module"` 语义，import 相对路径带 `.js` 后缀；遵循现有包内代码风格（agent-host 用分号，renderer 不用，本计划涉及后端一律分号）。
- 测试：`pnpm test`（vitest projects 配置，packages 走 node 环境，apps 走 jsdom 环境）；单测不得依赖真实 LLM。
- 安全不变量（spec §5.3/§10，必须用测试锁定）：未配置 = 无工具（fail closed）；鞍不残留（release 后 `new_session` 重置）；写安全不依赖鞍（池级）；拒绝即不写。
- 业务不回归：合同审核的 workflow/skills/审批语义/ContractSurface 不动；pilot e2e 必须原样通过。
- 用户可见文案用中文；内部标识沿用现有命名（sessionId / profileId / toolName）。
- 本计划不新增运行时依赖；渲染层依赖（react-markdown 等）属于 UI 计划。

---

## File Structure

**packages/model-router**
- `src/types.ts`、`src/router.ts`：`ModelTask` 增加 `coding`，normalizeRouting 增加 coding 回退。

**packages/config**
- `src/schema.ts`、`src/types.ts`：manifest 可选 `displayName`。
- `src/loader.ts`：读取可选 `agent/prompts/system.md` 到 `prompts.system` 并纳入 integrity 文件集。

**packages/approval**
- `src/gate.ts`：按 profileId 查策略/RBAC（兼容旧构造器）。

**packages/agent-host**
- `src/workspace-guard.ts`（新）：`isPathInside(root, target)`。
- `src/edit-diff.ts`（新）：`computeEditDiff(oldText, newText, filePath)`。
- `src/coding-tools.ts`（新）：bash/edit/write 的 Pi 原生定义 + operations 委托 Main。
- `src/tool-registry.ts`（新）：鞍工具名 → 工具定义（子进程侧目录）。
- `src/types.ts`：`SessionSaddle`、RPC `configure_session`。
- `src/pi-runtime.ts`：`get_state`/`get_messages` 返回数据；`configure_session` 分发；`PiRuntimeSessionHost.configureSaddle`。
- `src/pi-sdk-runtime.ts`：pendingSaddle、鞍装配（工具/skillsDir/cwd/systemPrompt）。
- `src/pi-runtime-pool.ts`：acquire 带 `{ saddle, resumeSessionFile }`，绑定后先 configure 再 switch。
- `test/fixtures/pi-runtime-saddle-child.mjs`（新）：池级集成测试用桩子进程。

**apps/desktop/electron/main**
- `src` 无；`workspace.ts`（新）：自动工作区命名/懒创建。
- `chat-session-store.ts`（新）：SQLite 会话注册表。
- `general-executor.ts`（新）：只读命令分类器 + edit/write/bash 确定性执行 + diff。
- `runtime.ts`：多 profile assemble + ProfileRuntime + gate 多策略接线 + ChatSessionStore + GeneralExecutor 注册。
- `workflow.ts`：改用 `profileOf('contract-review')`；broker 带 profileId。
- `ipc.ts`：broker.route（coding 工具分类）、listAgents、会话/模型/工作区 IPC。
- `index.ts`：扫描 profiles 目录（兼容 SPARKII_PROFILE_DIR）。
- `preload/api-types.ts`、`preload/api.ts`：新增 API。

**profiles**
- `profiles/general/**`（新配置包）。
- `profiles/contract-review/agent/tools.yaml`（加 `read`）、`agent/prompts/system.md`（新）。

---

### Task 1: model-router 支持 coding 任务

**Files:**
- Modify: `packages/model-router/src/types.ts`
- Modify: `packages/model-router/src/router.ts`
- Test: `packages/model-router/test/router.test.ts`

**Interfaces:**
- Consumes: 现有 `ModelTask`/`ModelRouter.resolve`。
- Produces: `ModelTask` 含 `'coding'`；`normalizeRouting` 对 `coding` 未配置时回退 `default`。

- [ ] **Step 1: 追加失败测试**

在 `packages/model-router/test/router.test.ts` 末尾加入：

```ts
it('resolves coding task, falling back to default when absent', () => {
  const router = new ModelRouter(normalizeRouting({ default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] }));
  expect(router.resolve('coding')).toEqual({ provider: 'local', modelId: 'qwen2.5:7b' });
  const withCoding = new ModelRouter(normalizeRouting({
    default: [{ provider: 'local', modelId: 'qwen2.5:7b' }],
    coding: [{ provider: 'cloud', modelId: 'deepseek-v4-pro' }],
  }));
  expect(withCoding.resolve('coding')).toEqual({ provider: 'cloud', modelId: 'deepseek-v4-pro' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/model-router/test/router.test.ts`
Expected: FAIL——`coding` 不在 `ModelTask` 联合类型中（类型错误）或 resolve 返回 null。

- [ ] **Step 3: 实现**

`packages/model-router/src/types.ts`：

```ts
export type ModelTask = 'chat' | 'extract' | 'report' | 'default' | 'coding';
```

`packages/model-router/src/router.ts`：

```ts
export function normalizeRouting(raw: Record<string, ModelTarget[]>): Record<ModelTask, ModelTarget[]> {
  const out = { default: raw.default ?? [], chat: [], extract: [], report: [], coding: [] } as Record<ModelTask, ModelTarget[]>;
  for (const key of ['chat', 'extract', 'report', 'coding'] as const) {
    out[key] = raw[key] ?? out.default;
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/model-router/test/router.test.ts`
Expected: PASS（原 3 例 + 新增 1 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/model-router/src/types.ts packages/model-router/src/router.ts packages/model-router/test/router.test.ts
git commit -m "feat(model-router): add coding task"
```

---

### Task 2: config 支持 displayName 与 agent/prompts/system.md

**Files:**
- Modify: `packages/config/src/schema.ts`、`packages/config/src/types.ts`、`packages/config/src/loader.ts`
- Test: `packages/config/test/display-name.test.ts`（新）、`packages/config/test/system-prompt.test.ts`（新）

**Interfaces:**
- Consumes: 现有 `parseProfileManifest`、`loadProfile`、`writeProfile` 测试助手模式。
- Produces: `ProfileManifest.displayName?: string`；`ResolvedProfile.agent.prompts.system?: string`（存在 `agent/prompts/system.md` 时）；system.md 纳入 integrity 文件集（key `agent/prompts/system.md`）。

- [ ] **Step 1: 追加失败测试**

`packages/config/test/display-name.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseProfileManifest } from '../src/schema.js';

describe('manifest displayName', () => {
  it('parses optional displayName', () => {
    const m = parseProfileManifest({
      name: 'general', version: '1.0.0', displayName: '通用智能体',
      modelRouting: { tasks: { default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] } },
    });
    expect(m.displayName).toBe('通用智能体');
  });
  it('is absent when not declared', () => {
    const m = parseProfileManifest({ name: 'x', version: '1.0.0', modelRouting: { tasks: {} } });
    expect(m.displayName).toBeUndefined();
  });
});
```

`packages/config/test/system-prompt.test.ts`（复用 loader.test.ts 的 writeProfile 助手写法，完整最小 profile）：

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '../src/loader.js';

function writeProfile(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, c);
  }
  return dir;
}

const BASE = {
  'manifest.yaml': 'name: general\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n',
  'agent/tools.yaml': 'tools: [read, bash]\n',
  'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
  'ui/pages/home.json': '{}',
  'ui/theme.yaml': 'file: theme/tokens.json\n',
  'ui/theme/tokens.json': '{}',
  'security/roles.yaml': 'roles: []\n',
  'security/approval.yaml': 'requireApproval: []\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
  'agent/knowledge/corpus.json': '[]',
};

describe('agent/prompts/system.md', () => {
  it('loads system.md into prompts.system and integrity files', async () => {
    const dir = writeProfile({ ...BASE, 'agent/prompts/system.md': '你是通用智能体。' });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.agent.prompts.system).toBe('你是通用智能体。');
  });
  it('tolerates missing system.md', async () => {
    const dir = writeProfile({ ...BASE });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.agent.prompts.system).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/config/test/display-name.test.ts packages/config/test/system-prompt.test.ts`
Expected: FAIL——`displayName` 校验不通过 / `prompts.system` undefined。

- [ ] **Step 3: 实现**

`packages/config/src/schema.ts`（manifestSchema 内加一行）：

```ts
  displayName: z.string().optional(),
```

`packages/config/src/types.ts`：

```ts
export interface ProfileManifest {
  name: string;
  version: string;
  displayName?: string;
  extends?: string;
  modelRouting: {
    tasks: Record<string, Array<{ provider: string; modelId: string }>>;
  };
  integrity?: { sha256: string };
}
```

`packages/config/src/loader.ts`（在 skill 加载之后、`toolsCfg` 之前插入）：

```ts
  const systemPromptRaw = await readFile(join(dir, 'agent', 'prompts', 'system.md'), 'utf8').catch(() => null);
  if (systemPromptRaw !== null) {
    files['agent/prompts/system.md'] = Buffer.from(systemPromptRaw);
    prompts.system = systemPromptRaw;
  }
```

并在文件顶部 import `readFile`（若尚未引入）：

```ts
import { readFile } from 'node:fs/promises';
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/config/test/display-name.test.ts packages/config/test/system-prompt.test.ts`
Expected: PASS（2 + 2 例）。

- [ ] **Step 5: 提交**

```bash
git add packages/config/src/schema.ts packages/config/src/types.ts packages/config/src/loader.ts packages/config/test/display-name.test.ts packages/config/test/system-prompt.test.ts
git commit -m "feat(config): profile displayName and optional system prompt"
```

---

### Task 3: ApprovalGate 多策略（按 profileId）

**Files:**
- Modify: `packages/approval/src/gate.ts`
- Test: `packages/approval/test/gate-multiprofile.test.ts`（新）

**Interfaces:**
- Consumes: 现有 `ApprovalPolicy`、`Rbac`、`AuditStore`、`Subject`。
- Produces: `new ApprovalGate({ audit, policy?, rbac? })`（旧构造兼容）；`gate.configureProfile(profileId, { policy, rbac })`；`submit`/`decide`/`expire` 按 `profileId` 查策略与 RBAC。

- [ ] **Step 1: 追加失败测试**

`packages/approval/test/gate-multiprofile.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { AuditStore } from '../src/audit.js';
import { Rbac, type Subject } from '@sparkii/identity';

const admin: Subject = { userId: 'u1', roles: ['admin'] };
const reviewer: Subject = { userId: 'u2', roles: ['reviewer'] };

function makeGate() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const audit = new AuditStore(join(dir, 'audit.db'));
  const gate = new ApprovalGate({ audit });
  gate.configureProfile('general', {
    policy: { requireApproval: [], timeoutMs: 0, highRiskDoubleConfirm: false },
    rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
  });
  gate.configureProfile('contract', {
    policy: { requireApproval: [], timeoutMs: 60_000, highRiskDoubleConfirm: true },
    rbac: new Rbac([{ name: 'reviewer', pages: [], tools: [], canApprove: ['write'] }]),
  });
  return gate;
}

describe('ApprovalGate multi-profile', () => {
  it('applies per-profile rbac for approval', async () => {
    const gate = makeGate();
    const p = await gate.submit({ toolName: 'edit', targetSystem: 'general', summary: 'x', payload: { path: '/tmp/x' }, risk: 'write' }, { profileId: 'general', sessionId: 's1', actor: 'agent' });
    await expect(gate.decide(p.id, reviewer, true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const ok = await gate.decide(p.id, admin, true);
    expect(ok.status).toBe('approved');
  });

  it('applies per-profile timeout for expiry', async () => {
    const gate = makeGate();
    const p = await gate.submit({ toolName: 'bash', targetSystem: 'general', summary: 'x', payload: { command: 'rm -rf x' }, risk: 'high-risk' }, { profileId: 'general', sessionId: 's1', actor: 'agent' });
    const expired = await gate.expire(p.id);
    expect(expired?.status).toBe('expired');
  });

  it('keeps legacy constructor working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const audit = new AuditStore(join(dir, 'audit.db'));
    const gate = new ApprovalGate({
      audit,
      policy: { requireApproval: [], timeoutMs: 60_000, highRiskDoubleConfirm: true },
      rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
    });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'default', sessionId: 's1', actor: 'agent' });
    const ok = await gate.decide(p.id, admin, true);
    expect(ok.status).toBe('approved');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/approval/test/gate-multiprofile.test.ts`
Expected: FAIL——`configureProfile` 不存在。

- [ ] **Step 3: 实现**

`packages/approval/src/gate.ts` 改为：

```ts
import type { ApprovalPolicy } from '@sparkii/config';
import { Rbac, type Subject } from '@sparkii/identity';
import { createProposal, transition, summarizePayload, type Proposal, type ProposalRequest } from './proposal.js';
import { AuditStore } from './audit.js';

export class GateError extends Error {
  constructor(public code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_PENDING', message: string) { super(message); }
}

interface ProfilePolicy { policy: ApprovalPolicy; rbac: Rbac; }

export class ApprovalGate {
  private proposals = new Map<string, Proposal>();
  private profiles = new Map<string, ProfilePolicy>();

  constructor(private opts: { audit: AuditStore; policy?: ApprovalPolicy; rbac?: Rbac }) {
    if (opts.policy && opts.rbac) this.profiles.set('default', { policy: opts.policy, rbac: opts.rbac });
  }

  configureProfile(profileId: string, cfg: ProfilePolicy): void {
    this.profiles.set(profileId, cfg);
  }

  private profileOf(profileId: string): ProfilePolicy {
    const p = this.profiles.get(profileId);
    if (!p) throw new GateError('NOT_FOUND', `no policy for profile ${profileId}`);
    return p;
  }

  async submit(req: ProposalRequest, meta: { profileId: string; sessionId: string; actor: string }): Promise<Proposal> {
    const p = createProposal(req, { profileId: meta.profileId, sessionId: meta.sessionId });
    this.proposals.set(p.id, p);
    await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload), sessionId: meta.sessionId });
    return p;
  }

  async decide(id: string, by: Subject, approved: boolean, note?: string): Promise<Proposal> {
    const p = this.proposals.get(id);
    if (!p) throw new GateError('NOT_FOUND', id);
    if (p.status !== 'pending') throw new GateError('NOT_PENDING', id);
    if (approved && p.risk !== 'read' && !this.profileOf(p.profileId).rbac.canApprove(by, p.risk)) throw new GateError('UNAUTHORIZED', 'approver lacks permission');
    const out = transition(p, approved ? 'approved' : 'denied');
    out.decisionBy = by.userId; out.decisionNote = note;
    this.proposals.set(id, out);
    await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied', sessionId: p.sessionId });
    return out;
  }

  async expire(id: string): Promise<Proposal | undefined> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') return p;
    if (Date.now() - p.createdAt > this.profileOf(p.profileId).policy.timeoutMs) {
      const out = transition(p, 'expired');
      this.proposals.set(id, out);
      await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired', sessionId: p.sessionId });
      return out;
    }
    return p;
  }

  get(id: string) { return this.proposals.get(id); }
  listPending() { return [...this.proposals.values()].filter((p) => p.status === 'pending'); }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/approval/test/gate-multiprofile.test.ts packages/approval/test/gate.test.ts`
Expected: PASS（新增 3 例 + 旧 gate 测试不回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/approval/src/gate.ts packages/approval/test/gate-multiprofile.test.ts
git commit -m "feat(approval): per-profile policy and rbac in gate"
```

---

### Task 4: agent-host workspace-guard（路径白名单原语）

**Files:**
- Create: `packages/agent-host/src/workspace-guard.ts`
- Test: `packages/agent-host/test/workspace-guard.test.ts`（新）

**Interfaces:**
- Produces: `isPathInside(root: string, target: string): boolean`——target 解析后等于 root 或位于 root 内为 true；`..` 逃逸与无关前缀（如 `/root2` vs `/root`）为 false。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/workspace-guard.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isPathInside } from '../src/workspace-guard.js';

describe('isPathInside', () => {
  it('accepts exact root and nested paths', () => {
    expect(isPathInside('C:/ws', 'C:/ws')).toBe(true);
    expect(isPathInside('C:/ws', 'C:/ws/a/b.txt')).toBe(true);
    expect(isPathInside('C:/ws', 'C:/ws/../ws/c.txt')).toBe(true);
  });
  it('rejects parent escape and sibling prefixes', () => {
    expect(isPathInside('C:/ws', 'C:/ws/../evil.txt')).toBe(false);
    expect(isPathInside('C:/ws', 'C:/ws2/x.txt')).toBe(false);
    expect(isPathInside('C:/ws', 'C:/')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/workspace-guard.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`packages/agent-host/src/workspace-guard.ts`：

```ts
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== '.');
}
```

并在 `packages/agent-host/src/index.ts` 导出：

```ts
export * from "./workspace-guard.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/workspace-guard.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/workspace-guard.ts packages/agent-host/src/index.ts packages/agent-host/test/workspace-guard.test.ts
git commit -m "feat(agent-host): path containment guard"
```

---

### Task 5: agent-host edit-diff（审批预览用 diff）

**Files:**
- Create: `packages/agent-host/src/edit-diff.ts`
- Test: `packages/agent-host/test/edit-diff.test.ts`（新）

**Interfaces:**
- Produces: `computeEditDiff(oldText: string, newText: string, filePath?: string): string`——行级 diff，输出 `--- a/<path>` / `+++ b/<path>` 头 + 逐行前缀（空格=未变、`-`=删、`+`=增）。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/edit-diff.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { computeEditDiff } from '../src/edit-diff.js';

describe('computeEditDiff', () => {
  it('shows added lines for a new file', () => {
    const d = computeEditDiff('', 'hello\nworld\n', 'a.txt');
    expect(d).toContain('--- a/a.txt');
    expect(d).toContain('+hello');
    expect(d).toContain('+world');
  });
  it('marks removed and added lines', () => {
    const d = computeEditDiff('old line\nkeep\n', 'new line\nkeep\n', 'b.txt');
    expect(d).toContain('-old line');
    expect(d).toContain('+new line');
    expect(d).toContain(' keep');
  });
  it('is empty-ish for identical content', () => {
    const d = computeEditDiff('same\n', 'same\n', 'c.txt');
    expect(d).toContain('--- a/c.txt');
    expect(d).not.toContain('+same');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/edit-diff.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`packages/agent-host/src/edit-diff.ts`：

```ts
export function computeEditDiff(oldText: string, newText: string, filePath = 'file'): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { lines.push(`+${b[j]}`); j++; }
    else { lines.push(`-${a[i]}`); i++; }
  }
  return lines.join('\n');
}
```

并在 `packages/agent-host/src/index.ts` 追加：

```ts
export * from "./edit-diff.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/edit-diff.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/edit-diff.ts packages/agent-host/src/index.ts packages/agent-host/test/edit-diff.test.ts
git commit -m "feat(agent-host): line diff for approval preview"
```

---

### Task 6: agent-host coding-tools（bash/edit/write operations 委托 Main）

**Files:**
- Create: `packages/agent-host/src/coding-tools.ts`
- Test: `packages/agent-host/test/coding-tools.test.ts`（新）

**Interfaces:**
- Consumes: `createBashToolDefinition`/`createEditToolDefinition`/`createWriteToolDefinition`（pi-coding-agent）、`isPathInside`、`ProposalRequest`、`ProposalDecision`。
- Produces:
  ```ts
  export interface CodingToolsContext {
    cwd: string;
    workspaceRoot: string;
    propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
  }
  export function createCodingToolDefinitions(ctx: CodingToolsContext): ToolDefinition[];
  ```
  返回工具名 `bash`/`edit`/`write`；bash 的 `BashOperations.exec` 通过 `propose({ toolName: 'bash', payload: { command, cwd, workspaceRoot } })` 发 Main，拒绝时返回 exitCode 1 + 「操作未执行」输出；edit/write 的 operations 在拒绝时抛错；`writeFile` 提议载荷 `{ path, content }`；所有写路径先做 `isPathInside` 校验。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/coding-tools.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createCodingToolDefinitions, type CodingToolsContext } from '../src/coding-tools.js';
import type { ProposalDecision } from '../src/pi-runtime-transport.js';

function ctx(over: Partial<CodingToolsContext> = {}): CodingToolsContext & { proposes: ReturnType<typeof vi.fn> } {
  const proposes = vi.fn(async () => ({ approved: true, proposalId: 'p', status: 'executed', result: { exitCode: 0, output: 'ok' } }) as ProposalDecision);
  return {
    cwd: join(tmpdir(), 'cwd'),
    workspaceRoot: mkdtempSync(join(tmpdir(), 'ws-')),
    propose: proposes,
    proposes,
    ...over,
  };
}

describe('createCodingToolDefinitions', () => {
  it('registers bash/edit/write with native names', () => {
    const defs = createCodingToolDefinitions(ctx());
    expect(defs.map((d) => d.name).sort()).toEqual(['bash', 'edit', 'write']);
  });

  it('bash exec proposes and streams output on approval', async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const bash = defs.find((d) => d.name === 'bash')!;
    const onData = vi.fn();
    const ops = (bash as any).options.operations ?? (bash as any).opts?.operations;
    // 通过 execute 调用 bash 工具（参数 {command}），内部会走 operations.exec
    const result = await (bash as any).execute('t1', { command: 'echo hi' }, undefined, undefined, {});
    expect(c.proposes).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'bash' }));
    expect((result as any).content?.[0]?.text).toContain('ok');
  });

  it('writeFile proposes with path/content and rejects on denial', async () => {
    const denied = ctx({ propose: vi.fn(async () => ({ approved: false, proposalId: 'p', status: 'denied' }) as ProposalDecision) });
    const defs = createCodingToolDefinitions(denied);
    const write = defs.find((d) => d.name === 'write')!;
    const ops = (write as any).options.operations;
    await expect(ops.writeFile(join(denied.workspaceRoot, 'a.txt'), 'x')).rejects.toThrow(/未执行/);
    expect(denied.proposes).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'write', payload: expect.objectContaining({ path: expect.stringContaining('a.txt') }) }));
  });

  it('blocks writes outside workspace before proposing', async () => {
    const c = ctx();
    const defs = createCodingToolDefinitions(c);
    const write = defs.find((d) => d.name === 'write')!;
    const ops = (write as any).options.operations;
    await expect(ops.writeFile(join(tmpdir(), 'outside.txt'), 'x')).rejects.toThrow(/不在工作区/);
    expect(c.proposes).not.toHaveBeenCalled();
  });
});
```

> 注：工具定义上的 operations 通过 `(def as any).options.operations` 读取；若实现时 pi-coding-agent 的 createXxxToolDefinition 把 options 放在别处，测试改为通过工具 `execute` 间接断言（bash 已用 execute 断言；edit/write 的 execute 需构造 Pi 上下文，故直接读 options——实现时若不可行，把 execute 调用改为以最小 ctx 调用并断言 propose）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/coding-tools.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`packages/agent-host/src/coding-tools.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { ProposalRequest } from '@sparkii/approval';
import type { ProposalDecision } from './pi-runtime-transport.js';
import { isPathInside } from './workspace-guard.js';

export interface CodingToolsContext {
  cwd: string;
  workspaceRoot: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
}

function guardPath(ctx: CodingToolsContext, absolutePath: string): void {
  if (!isPathInside(ctx.workspaceRoot, absolutePath)) {
    throw new Error(`拒绝访问:${absolutePath} 不在工作区内`);
  }
}

export function createCodingToolDefinitions(ctx: CodingToolsContext): ToolDefinition[] {
  const bash = createBashToolDefinition(ctx.cwd, {
    operations: {
      exec: async (command: string, cwd: string, opts: { onData: (data: Buffer) => void }) => {
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: 'bash',
          targetSystem: 'general',
          summary: command.slice(0, 512),
          payload: { command, cwd, workspaceRoot: ctx.workspaceRoot },
          risk: 'write',
        });
        if (!decision.approved) {
          opts.onData(Buffer.from(`操作未执行:${decision.status}\n`));
          return { exitCode: 1 };
        }
        const result = (decision.result ?? {}) as { exitCode?: number | null; output?: string };
        if (result.output) opts.onData(Buffer.from(result.output));
        return { exitCode: result.exitCode ?? 0 };
      },
    },
  });

  const edit = createEditToolDefinition(ctx.cwd, {
    operations: {
      readFile: async (absolutePath: string) => {
        guardPath(ctx, absolutePath);
        return readFile(absolutePath);
      },
      access: async (absolutePath: string) => {
        guardPath(ctx, absolutePath);
        await access(absolutePath);
      },
      writeFile: async (absolutePath: string, content: string) => {
        guardPath(ctx, absolutePath);
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: 'edit',
          targetSystem: 'general',
          summary: `edit ${absolutePath}`,
          payload: { path: absolutePath, content },
          risk: 'write',
        });
        if (!decision.approved) throw new Error(`编辑未执行:${decision.status}`);
      },
    },
  });

  const write = createWriteToolDefinition(ctx.cwd, {
    operations: {
      mkdir: async (dir: string) => {
        guardPath(ctx, dir);
      },
      writeFile: async (absolutePath: string, content: string) => {
        guardPath(ctx, absolutePath);
        const decision = await ctx.propose({
          requestId: randomUUID(),
          toolName: 'write',
          targetSystem: 'general',
          summary: `write ${absolutePath}`,
          payload: { path: absolutePath, content },
          risk: 'write',
        });
        if (!decision.approved) throw new Error(`写入未执行:${decision.status}`);
      },
    },
  });

  return [bash, edit, write];
}
```

> 实现时核对 `createBashToolDefinition` 的 BashOperations.exec 签名（`exec(command, cwd, { onData, signal, timeout, env })`）与 edit/write 的 options 字段名；若类型不匹配，以 pi-coding-agent `dist/core/tools/*.d.ts` 为准微调（Task 6 范围：仅签名适配，不改行为）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/coding-tools.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/coding-tools.ts packages/agent-host/test/coding-tools.test.ts
git commit -m "feat(agent-host): coding tools delegate execution to main"
```

---

### Task 7: agent-host tool-registry（子进程侧工具目录）

**Files:**
- Create: `packages/agent-host/src/tool-registry.ts`
- Test: `packages/agent-host/test/tool-registry.test.ts`（新）

**Interfaces:**
- Consumes: `createReadToolDefinition`/`createLsToolDefinition`/`createGrepToolDefinition`/`createFindToolDefinition`（pi-coding-agent）、`buildPiRuntimeTools`、三连接器、`createCodingToolDefinitions`、`isPathInside`。
- Produces:
  ```ts
  export interface RegistryContext {
    cwd: string;
    workspaceRoot?: string;
    propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
  }
  export function resolveToolDefinitions(toolNames: string[], ctx: RegistryContext): ToolDefinition[];
  ```
  支持名：`read`/`ls`/`grep`/`find`（Pi 原生 + workspaceRoot 守卫）、`bash`/`edit`/`write`（coding-tools）、`document.read`/`knowledge.search`/`report.export`（连接器包装）；未知名抛 `Error('unknown tool in saddle: <name>')`。workspaceRoot 未创建时只读工具返回统一提示文本（导出 `WORKSPACE_NOT_CREATED`）。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/tool-registry.test.ts`：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { resolveToolDefinitions, WORKSPACE_NOT_CREATED } from '../src/tool-registry.js';
import type { ProposalDecision } from '../src/pi-runtime-transport.js';

const propose = vi.fn(async () => ({ approved: false, proposalId: 'x', status: 'denied' }) as ProposalDecision);

describe('resolveToolDefinitions', () => {
  it('resolves coding and connector tool names', () => {
    const defs = resolveToolDefinitions(['read', 'bash', 'document.read'], {
      cwd: tmpdir(), workspaceRoot: mkdtempSync(join(tmpdir(), 'ws-')), propose,
    });
    expect(defs.map((d) => d.name).sort()).toEqual(['bash', 'document.read', 'read']);
  });

  it('fails closed on unknown tool names', () => {
    expect(() => resolveToolDefinitions(['read', 'nope'], { cwd: tmpdir(), propose })).toThrow(/unknown tool in saddle: nope/);
  });

  it('read tool returns WORKSPACE_NOT_CREATED when workspace missing', async () => {
    const ws = join(tmpdir(), 'missing-ws-' + Date.now());
    const defs = resolveToolDefinitions(['read'], { cwd: tmpdir(), workspaceRoot: ws, propose });
    const read = defs[0];
    const result = await (read as any).execute('t1', { path: join(ws, 'a.txt') }, undefined, undefined, {});
    expect((result as any).content?.[0]?.text).toBe(WORKSPACE_NOT_CREATED);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/tool-registry.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`packages/agent-host/src/tool-registry.ts`：

```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createReadToolDefinition,
  createLsToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalRequest } from '@sparkii/approval';
import { buildPiRuntimeTools } from './pi-runtime-tools.js';
import { createCodingToolDefinitions } from './coding-tools.js';
import type { ProposalDecision } from './pi-runtime-transport.js';
import { isPathInside } from './workspace-guard.js';

export const WORKSPACE_NOT_CREATED = '工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。';

export interface RegistryContext {
  cwd: string;
  workspaceRoot?: string;
  propose(request: ProposalRequest & { requestId: string }): Promise<ProposalDecision>;
}

const CONNECTOR_TOOLS = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

function withWorkspaceGuard(def: ToolDefinition, root: string): ToolDefinition {
  const original = def.execute.bind(def);
  return {
    ...def,
    execute: async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => {
      if (!existsSync(root)) {
        return { content: [{ type: 'text', text: WORKSPACE_NOT_CREATED }], details: {} };
      }
      const path: unknown = params?.path;
      if (typeof path === 'string' && !isPathInside(root, resolve(ctx?.cwd ?? root, path))) {
        return { content: [{ type: 'text', text: `拒绝访问:${path} 不在工作区内` }], details: {} };
      }
      return original(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function resolveToolDefinitions(toolNames: string[], ctx: RegistryContext): ToolDefinition[] {
  const codingByName = new Map(createCodingToolDefinitions({ cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot ?? ctx.cwd, propose: ctx.propose }).map((d) => [d.name, d]));
  const out: ToolDefinition[] = [];
  for (const name of toolNames) {
    if (name === 'bash' || name === 'edit' || name === 'write') {
      const def = codingByName.get(name);
      if (def) out.push(def);
      else throw new Error(`unknown tool in saddle: ${name}`);
      continue;
    }
    if (name === 'read' || name === 'ls' || name === 'grep' || name === 'find') {
      const factory = { read: createReadToolDefinition, ls: createLsToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition }[name];
      const def = factory(ctx.cwd) as ToolDefinition;
      out.push(ctx.workspaceRoot ? withWorkspaceGuard(def, ctx.workspaceRoot) : def);
      continue;
    }
    const connector = CONNECTOR_TOOLS.get(name);
    if (connector) {
      const wrapped = buildPiRuntimeTools({ tools: [connector], propose: ctx.propose })[0];
      out.push(wrapped as unknown as ToolDefinition);
      continue;
    }
    throw new Error(`unknown tool in saddle: ${name}`);
  }
  return out;
}
```

> 实现时核对 `buildPiRuntimeTools` 返回类型与 `ToolDefinition` 的兼容性（现有 pi-sdk-runtime 已把其产物 `defineTool(...)` 后使用；若类型不兼容，套一层 `defineTool` 并 `as unknown as ToolDefinition`）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/tool-registry.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/tool-registry.ts packages/agent-host/test/tool-registry.test.ts
git commit -m "feat(agent-host): saddle tool registry with fail-closed resolution"
```

---

### Task 8: agent-host RPC 返回数据（get_state / get_messages）

**Files:**
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Test: `packages/agent-host/test/pi-runtime-command-data.test.ts`（新）

**Interfaces:**
- Produces: `get_state` 响应 `data = { sessionId, sessionFile, ... }`（来自 `PiRuntimeSession.getState()`）；`get_messages` 响应 `data = unknown[]`（来自 `getMessages()`）。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/pi-runtime-command-data.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { createPiRuntime, type PiRuntimeSession, type PiRuntimeSessionHost } from '../src/pi-runtime.js';
import { commandEnvelope, type PiRuntimeEnvelope } from '../src/pi-runtime-transport.js';

function makeHost() {
  const session = {
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}),
    setAutoCompaction: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    getMessages: vi.fn(() => [{ role: 'user', text: 'hi' }]),
    getState: vi.fn(() => ({ sessionId: 's1', sessionFile: '/tmp/s.json' })),
    dispose: vi.fn(),
  } as unknown as PiRuntimeSession;
  const host = {
    current: () => session,
    newSession: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    configureSaddle: vi.fn(async () => {}),
  } as unknown as PiRuntimeSessionHost;
  return { host, session };
}

describe('pi runtime command data', () => {
  it('returns state data for get_state', async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope('1', { type: 'get_state' }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => 'response' in e && e.id === '1');
    expect((resp as any)?.response?.data).toMatchObject({ sessionFile: '/tmp/s.json' });
  });

  it('returns messages for get_messages', async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    handler(commandEnvelope('2', { type: 'get_messages' }));
    await new Promise((r) => setTimeout(r, 0));
    const resp = posted.find((e) => 'response' in e && e.id === '2');
    expect((resp as any)?.response?.data).toEqual([{ role: 'user', text: 'hi' }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-command-data.test.ts`
Expected: FAIL——`data` 为 undefined（当前 get_state/get_messages 空实现）。

- [ ] **Step 3: 实现**

`packages/agent-host/src/pi-runtime.ts`：

```ts
  const send = (id: string, command: RpcCommand, response: RpcResponse): void => {
    opts.transport.postMessage(responseEnvelope(id, response));
  };

  opts.transport.onMessage(async (envelope) => {
    if (!("command" in envelope)) return;
    const { id, command } = envelope;
    try {
      const data = await handleCommand(opts.host, command);
      if (command.type === "new_session" || command.type === "switch_session") {
        resubscribe();
      }
      send(id, command, { id, type: "response", command: command.type, success: true, data });
    } catch (error) {
      send(id, command, {
        id, type: "response", command: command.type, success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
```

`handleCommand` 签名改为 `Promise<unknown>`，并在 switch 中：

```ts
    case "get_state":
      return session.getState();
    case "get_messages":
      return session.getMessages();
```

其余 case 的 `return;` 改为 `return undefined;`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-command-data.test.ts packages/agent-host/test/pi-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/pi-runtime.ts packages/agent-host/test/pi-runtime-command-data.test.ts
git commit -m "feat(agent-host): rpc returns state and message data"
```

---

### Task 9: agent-host configure_session 与鞍装配（pi-sdk-runtime）

**Files:**
- Modify: `packages/agent-host/src/types.ts`、`packages/agent-host/src/pi-runtime.ts`、`packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-runtime-command-data.test.ts`（追加 configure_session 用例）

**Interfaces:**
- Consumes: `resolveToolDefinitions`（Task 7）、RPC data（Task 8）。
- Produces:
  ```ts
  export interface SessionSaddle {
    tools: string[];
    skillsDir?: string;
    cwd?: string;
    systemPrompt?: string;
    workspaceRoot?: string;
  }
  ```
  RpcCommand 增加 `{ type: 'configure_session'; saddle: SessionSaddle }`；`PiRuntimeSessionHost` 增加 `configureSaddle(saddle: SessionSaddle | null): Promise<void>`；子进程按鞍设置 `session.agent.state.tools`（未配置或空 = 无工具）；skillsDir 经 `resourceLoaderOptions.additionalSkillPaths`、系统提示经 `extensionFactories` 的 `before_agent_start` 注入。

- [ ] **Step 1: 追加失败测试（RPC 分发层）**

在 `packages/agent-host/test/pi-runtime-command-data.test.ts` 追加：

```ts
  it('dispatches configure_session to the host', async () => {
    const { host } = makeHost();
    const posted: PiRuntimeEnvelope[] = [];
    let handler: (e: PiRuntimeEnvelope) => void = () => {};
    const transport = {
      postMessage: (e: PiRuntimeEnvelope) => posted.push(e),
      onMessage: (cb: (e: PiRuntimeEnvelope) => void) => { handler = cb; return () => {}; },
    };
    createPiRuntime({ host, transport });
    const saddle = { tools: ['read', 'bash'], skillsDir: '/tmp/skills' };
    handler(commandEnvelope('3', { type: 'configure_session', saddle }));
    await new Promise((r) => setTimeout(r, 0));
    expect(host.configureSaddle).toHaveBeenCalledWith(saddle);
  });
```

并在 `makeHost` 的 host 对象中保留 `configureSaddle: vi.fn(async () => {})`（Task 8 已加）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-command-data.test.ts`
Expected: FAIL——`configure_session` 不在 RpcCommand 联合类型（类型错误）或未分发。

- [ ] **Step 3: 实现**

`packages/agent-host/src/types.ts`：

```ts
export interface SessionSaddle {
  tools: string[];
  skillsDir?: string;
  cwd?: string;
  systemPrompt?: string;
  workspaceRoot?: string;
}

export type RpcCommand =
  | { type: 'prompt'; message: string; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'new_session' }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'configure_session'; saddle: SessionSaddle };
```

`packages/agent-host/src/pi-runtime.ts`：`PiRuntimeSessionHost` 增加

```ts
  configureSaddle(saddle: SessionSaddle | null): Promise<void>;
```

（import `SessionSaddle` from `./types.js`），handleCommand 增加：

```ts
    case "configure_session":
      await host.configureSaddle(command.saddle);
      return undefined;
```

`packages/agent-host/src/pi-sdk-runtime.ts`：

```ts
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SessionSaddle } from './types.js';
import { resolveToolDefinitions } from './tool-registry.js';

export interface PiSdkRuntimeOptions {
  transport: PiRuntimeChildTransport;
  tools?: ToolDef[];
  cwd?: string;
  skillsDir?: string;
  workspaceRoot?: string;
}

function systemPromptExtensionFactory(getSystemPrompt: () => string | undefined) {
  return (pi: ExtensionAPI) => {
    pi.on('before_agent_start', () => {
      const systemPrompt = getSystemPrompt();
      return systemPrompt ? { systemPrompt } : undefined;
    });
  };
}
```

`createPiSdkSessionHost` 内：

```ts
  let pendingSaddle: SessionSaddle | null = null;

  const currentCwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const currentWorkspaceRoot = options.workspaceRoot ?? process.env.SPARKII_WORKSPACE_ROOT ?? currentCwd;

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
    const saddle = pendingSaddle;
    const services = await createAgentSessionServices({
      cwd: effectiveCwd,
      resourceLoaderOptions: {
        additionalSkillPaths: saddle?.skillsDir ? [saddle.skillsDir] : options.skillsDir ? [options.skillsDir] : [],
        extensionFactories: [systemPromptExtensionFactory(() => pendingSaddle?.systemPrompt)],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
```

`adaptSession()` 内替换工具赋值：

```ts
    const saddleTools: ToolDefinition[] = pendingSaddle
      ? resolveToolDefinitions(pendingSaddle.tools, {
          cwd: currentCwd,
          workspaceRoot: pendingSaddle.workspaceRoot ?? currentWorkspaceRoot,
          propose: async (request) => new Promise<ProposalDecision>((resolve, reject) => {
            pendingProposals.set(request.requestId, { resolve, reject });
            options.transport.postMessage(proposalEnvelope(request));
          }),
        })
      : [];
    session.agent.state.tools = saddleTools;
```

（`pendingProposals` 与 `proposalEnvelope` 已存在，保持复用。）host 返回对象增加：

```ts
    configureSaddle: async (saddle: SessionSaddle | null) => {
      pendingSaddle = saddle;
      adaptSession();
    },
```

> 实现时确认 `resourceLoaderOptions` 允许 `extensionFactories` 字段（`DefaultResourceLoaderOptions`）；若 Omit 类型不含该字段，改为在 createPiSdkSessionHost 中自行 `new DefaultResourceLoader(...)` 后传入 `createAgentSessionServices({ resourceLoader: loader })`（类型以 `dist/core/agent-session-services.d.ts` 为准）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-command-data.test.ts packages/agent-host/test/pi-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-runtime-command-data.test.ts
git commit -m "feat(agent-host): configure_session saddle assembly"
```

---

### Task 10: agent-host pool 鞍/恢复接线（acquire + 集成）

**Files:**
- Modify: `packages/agent-host/src/pi-runtime-pool.ts`
- Create: `packages/agent-host/test/fixtures/pi-runtime-saddle-child.mjs`
- Test: `packages/agent-host/test/pi-runtime-pool-saddle.test.ts`（新）

**Interfaces:**
- Consumes: `SessionSaddle`（Task 9）。
- Produces:
  ```ts
  acquire(sessionId: string, opts?: { resumeSessionFile?: string; saddle?: SessionSaddle }): Promise<PiRuntimeSlot>
  ```
  绑定后顺序：先 `configure_session`（失败则抛错并解绑）→ 再 `switch_session`（有 resumeSessionFile 时）；`bind` 返回前完成。

- [ ] **Step 1: 追加失败测试**

`packages/agent-host/test/fixtures/pi-runtime-saddle-child.mjs`：

```js
let configured = false;
process.on("message", (env) => {
  if (!env || env.direction !== "main-to-runtime") return;
  const cmd = env.command;
  const respond = (success, data, error) => {
    process.send({
      direction: "runtime-to-main",
      id: env.id,
      response: { id: env.id, type: "response", command: cmd.type, success, data, error },
    });
  };
  if (cmd.type === "configure_session") {
    if (cmd.saddle && cmd.saddle.tools.includes("__unknown__")) {
      respond(false, undefined, "unknown tool: __unknown__");
      return;
    }
    configured = true;
    respond(true);
    return;
  }
  if (cmd.type === "switch_session" && !configured) {
    respond(false, undefined, "switch before configure");
    return;
  }
  if (cmd.type === "get_state") {
    respond(true, { sessionId: "s1", sessionFile: "/tmp/session.json" });
    return;
  }
  respond(true);
});
process.send({ direction: "runtime-to-main", ready: true });
process.stdin.resume();
```

`packages/agent-host/test/pi-runtime-pool-saddle.test.ts`：

```ts
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PiRuntimePool } from '../src/pi-runtime-pool.js';
import type { PiRuntimeEnvelope, PiRuntimeHostHandle } from '../src/pi-runtime-transport.js';

const childPath = fileURLToPath(new URL('./fixtures/pi-runtime-saddle-child.mjs', import.meta.url));

function forkHandle(): PiRuntimeHostHandle {
  const child: ChildProcess = fork(childPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  return {
    postMessage: (envelope) => child.send(envelope),
    onMessage: (callback) => {
      const listener = (envelope: PiRuntimeEnvelope) => callback(envelope);
      child.on('message', listener);
      return () => child.removeListener('message', listener);
    },
    onExit: (callback) => {
      const listener = (code: number | null) => callback(code);
      child.on('exit', listener);
      return () => child.removeListener('exit', listener);
    },
    kill: () => child.kill(),
  };
}

describe('PiRuntimePool saddle wiring', () => {
  it('configures saddle then switches to resume file', async () => {
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: forkHandle });
    const slot = await pool.acquire('s1', {
      saddle: { tools: ['read', 'bash'] },
      resumeSessionFile: '/tmp/session.json',
    });
    const state = await slot.client.send({ type: 'get_state' });
    expect(state.data).toMatchObject({ sessionFile: '/tmp/session.json' });
    await pool.release('s1');
    await pool.stopAll();
  });

  it('fails closed when configure_session rejects', async () => {
    const pool = new PiRuntimePool({ maxAgents: 1, makeSupervisor: forkHandle });
    await expect(pool.acquire('s2', { saddle: { tools: ['__unknown__'] } })).rejects.toThrow(/unknown tool/);
    await pool.stopAll();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-pool-saddle.test.ts`
Expected: FAIL——acquire 不接受 opts（类型错误）或未发送 configure_session。

- [ ] **Step 3: 实现**

`packages/agent-host/src/pi-runtime-pool.ts`：

```ts
import type { SessionSaddle } from "./types.js";

export interface AcquireOptions {
  resumeSessionFile?: string;
  saddle?: SessionSaddle;
}

  async acquire(sessionId: string, opts: AcquireOptions = {}): Promise<PiRuntimeSlot> {
    const free = this.slots.find((s) => s.sessionId === null);
    if (free) return this.bind(free, sessionId, opts);
    if (this.slots.length < this.opts.maxAgents) {
      const supervisor = new PiRuntimeSupervisor(this.opts.makeSupervisor);
      const client = await supervisor.start();
      const slot: Slot = { supervisor, client, sessionId: null };
      this.slots.push(slot);
      return this.bind(slot, sessionId, opts);
    }
    return new Promise<PiRuntimeSlot>((resolve, reject) => {
      this.pending.push({ sessionId, resolve, reject });
    });
  }

  private async bind(slot: Slot, sessionId: string, opts: AcquireOptions): Promise<PiRuntimeSlot> {
    slot.sessionId = sessionId;
    this.bySession.set(sessionId, slot.client);
    try {
      if (opts.saddle) {
        const r = await slot.client.send({ type: 'configure_session', saddle: opts.saddle });
        if (!r.success) throw new Error(`configure_session failed: ${r.error ?? 'unknown'}`);
      }
      if (opts.resumeSessionFile) {
        const r = await slot.client.send({ type: 'switch_session', sessionPath: opts.resumeSessionFile });
        if (!r.success) throw new Error(`switch_session failed: ${r.error ?? 'unknown'}`);
      }
    } catch (e) {
      this.bySession.delete(sessionId);
      slot.sessionId = null;
      throw e;
    }
    return { client: slot.client, supervisor: slot.supervisor };
  }
```

`bind` 原同步签名改为 async；`pending` 队列中的 resolve 处调用改为 `resolve(this.bind(slot, next.sessionId, {}))`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/agent-host/test/pi-runtime-pool-saddle.test.ts packages/agent-host/test/pi-runtime-pool.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/pi-runtime-pool.ts packages/agent-host/test/pi-runtime-pool-saddle.test.ts packages/agent-host/test/fixtures/pi-runtime-saddle-child.mjs
git commit -m "feat(agent-host): pool acquires with saddle and session resume"
```

---

### Task 11: desktop workspace.ts（自动工作区命名与懒创建）

**Files:**
- Create: `apps/desktop/electron/main/workspace.ts`
- Test: `apps/desktop/test/workspace.test.ts`（新）

**Interfaces:**
- Consumes: `isPathInside`（@sparkii/agent-host）。
- Produces:
  ```ts
  export function randomWorkspaceToken(len?: number): string;
  export function formatWorkspaceTimestamp(d: Date): string;   // YYYYMMDDHHmm
  export function workspaceName(now: Date): string;             // Sparkii<4字符><14位时间戳>
  export function autoWorkspacePath(desktop: string, now: Date): string;
  export async function ensureWorkspaceDir(path: string): Promise<void>;
  ```

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/workspace.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { workspaceName, autoWorkspacePath, ensureWorkspaceDir, randomWorkspaceToken, formatWorkspaceTimestamp } from '../electron/main/workspace.js';

describe('workspace naming', () => {
  it('matches Sparkii + 4 token chars + minute timestamp', () => {
    const d = new Date('2026-08-25T17:10:00');
    const name = workspaceName(d);
    expect(name).toMatch(/^Sparkii[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{4}202608251710$/);
  });
  it('formats timestamp to the minute', () => {
    expect(formatWorkspaceTimestamp(new Date('2026-01-02T03:04:59'))).toBe('202601020304');
  });
  it('token excludes ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(randomWorkspaceToken()).not.toMatch(/[0O1lI]/);
    }
  });
  it('auto path joins desktop', () => {
    expect(autoWorkspacePath('C:/Users/x/Desktop', new Date('2026-08-25T17:10:00'))).toMatch(/^C:[\\/]Users[\\/]x[\\/]Desktop[\\/]Sparkii[^\\/]+202608251710$/);
  });
  it('ensureWorkspaceDir creates the folder lazily', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ws-test-')), 'SparkiiXyZ9202608251710');
    await ensureWorkspaceDir(dir);
    const { statSync } = await import('node:fs');
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/workspace.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/electron/main/workspace.ts`：

```ts
import { randomInt } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function randomWorkspaceToken(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) out += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
  return out;
}

export function formatWorkspaceTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export function workspaceName(now: Date): string {
  return `Sparkii${randomWorkspaceToken()}${formatWorkspaceTimestamp(now)}`;
}

export function autoWorkspacePath(desktop: string, now: Date): string {
  return join(desktop, workspaceName(now));
}

export async function ensureWorkspaceDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
```

`apps/desktop/electron/main/workspace.ts` 同时 re-export 路径守卫（供主进程使用，单一事实来源）：

```ts
export { isPathInside } from '@sparkii/agent-host';
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/workspace.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/workspace.ts apps/desktop/test/workspace.test.ts
git commit -m "feat(desktop): lazy session workspace naming"
```

---

### Task 12: desktop chat-session-store.ts（SQLite 会话注册表）

**Files:**
- Create: `apps/desktop/electron/main/chat-session-store.ts`
- Test: `apps/desktop/test/chat-session-store.test.ts`（新）

**Interfaces:**
- Produces:
  ```ts
  export type WorkspaceKind = 'auto' | 'user';
  export interface ChatSessionRecord {
    id: string; profileId: string; title: string;
    workspaceKind: WorkspaceKind; workspacePath: string;
    model: string | null; piSessionFile: string | null;
    createdAt: number; updatedAt: number;
  }
  export class ChatSessionStore {
    constructor(dbPath: string);
    create(rec: { id: string; profileId: string; title: string; workspaceKind: WorkspaceKind; workspacePath: string; model?: string | null }): ChatSessionRecord;
    list(profileId?: string): ChatSessionRecord[];
    get(id: string): ChatSessionRecord | undefined;
    update(id: string, patch: Partial<Pick<ChatSessionRecord, 'title' | 'model' | 'workspaceKind' | 'workspacePath' | 'piSessionFile'>>): ChatSessionRecord | undefined;
    delete(id: string): void;
    close(): void;
  }
  ```

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/chat-session-store.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ChatSessionStore } from '../electron/main/chat-session-store.js';

function store() {
  return new ChatSessionStore(join(mkdtempSync(join(tmpdir(), 'sessions-')), 'sessions.db'));
}

describe('ChatSessionStore', () => {
  it('creates and reads a session', () => {
    const s = store();
    const rec = s.create({ id: 's1', profileId: 'general', title: '会话 08-25 17:10', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710' });
    expect(s.get('s1')).toMatchObject({ id: 's1', title: '会话 08-25 17:10', model: null, piSessionFile: null });
    expect(rec.createdAt).toBeGreaterThan(0);
    s.close();
  });
  it('updates model and workspace', () => {
    const s = store();
    s.create({ id: 's1', profileId: 'general', title: 't', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.update('s1', { model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    expect(s.get('s1')).toMatchObject({ model: 'deepseek-v4-pro', workspaceKind: 'user', workspacePath: 'C:/user-ws' });
    s.close();
  });
  it('lists by profile and deletes', () => {
    const s = store();
    s.create({ id: 'a', profileId: 'general', title: 't', workspaceKind: 'auto', workspacePath: 'C:/a' });
    s.create({ id: 'b', profileId: 'contract', title: 't', workspaceKind: 'auto', workspacePath: 'C:/b' });
    expect(s.list('general').map((r) => r.id)).toEqual(['a']);
    s.delete('a');
    expect(s.get('a')).toBeUndefined();
    s.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/chat-session-store.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/electron/main/chat-session-store.ts`：

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkspaceKind = 'auto' | 'user';

export interface ChatSessionRecord {
  id: string;
  profileId: string;
  title: string;
  workspaceKind: WorkspaceKind;
  workspacePath: string;
  model: string | null;
  piSessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = ChatSessionRecord;

export class ChatSessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace_kind TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        model TEXT,
        pi_session_file TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  create(rec: { id: string; profileId: string; title: string; workspaceKind: WorkspaceKind; workspacePath: string; model?: string | null }): ChatSessionRecord {
    const now = Date.now();
    const row: Row = {
      id: rec.id, profileId: rec.profileId, title: rec.title,
      workspaceKind: rec.workspaceKind, workspacePath: rec.workspacePath,
      model: rec.model ?? null, piSessionFile: null, createdAt: now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO chat_sessions (id, profile_id, title, workspace_kind, workspace_path, model, pi_session_file, created_at, updated_at)
       VALUES (@id, @profileId, @title, @workspaceKind, @workspacePath, @model, @piSessionFile, @createdAt, @updatedAt)`,
    ).run(row);
    return row;
  }

  list(profileId?: string): ChatSessionRecord[] {
    const sql = 'SELECT id, profile_id AS profileId, title, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, pi_session_file AS piSessionFile, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions';
    if (profileId) {
      return this.db.prepare(`${sql} WHERE profile_id = ? ORDER BY updated_at DESC`).all(profileId) as unknown as Row[];
    }
    return this.db.prepare(`${sql} ORDER BY updated_at DESC`).all() as unknown as Row[];
  }

  get(id: string): ChatSessionRecord | undefined {
    return this.db.prepare(
      'SELECT id, profile_id AS profileId, title, workspace_kind AS workspaceKind, workspace_path AS workspacePath, model, pi_session_file AS piSessionFile, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions WHERE id = ?',
    ).get(id) as unknown as Row | undefined;
  }

  update(id: string, patch: Partial<Pick<ChatSessionRecord, 'title' | 'model' | 'workspaceKind' | 'workspacePath' | 'piSessionFile'>>): ChatSessionRecord | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: Row = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.prepare(
      `UPDATE chat_sessions SET title=@title, workspace_kind=@workspaceKind, workspace_path=@workspacePath, model=@model, pi_session_file=@piSessionFile, updated_at=@updatedAt WHERE id=@id`,
    ).run(next);
    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/chat-session-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/chat-session-store.ts apps/desktop/test/chat-session-store.test.ts
git commit -m "feat(desktop): chat session store"
```

---

### Task 13: desktop general-executor.ts（分类器 + diff + 确定性执行）

**Files:**
- Create: `apps/desktop/electron/main/general-executor.ts`
- Test: `apps/desktop/test/general-executor.test.ts`（新）

**Interfaces:**
- Consumes: `isPathInside`、`computeEditDiff`（@sparkii/agent-host）、`ConnectorExecutor`、`ToolResult`。
- Produces:
  ```ts
  export const WORKSPACE_NOT_CREATED: string;
  export function isReadOnlyBashCommand(command: string): boolean;
  export function riskOfCommand(command: string): 'write' | 'high-risk';
  export interface GeneralExecutorOptions {
    getWorkspace(sessionId: string): { workspacePath: string } | undefined;
    markWorkspaceCreated(sessionId: string): void;
  }
  export function registerGeneralExecutor(executor: ConnectorExecutor, opts: GeneralExecutorOptions): void;
  ```
  注册 `bash`/`edit`/`write` handler：bash 只读命令在工作区未创建时返回提示、写命令先 `ensureWorkspaceDir`；edit 按内容全量替换（Main 已持有最新文件内容）、write 全量写入并 `mkdir` 父目录；全部返回 `ToolResult`。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/general-executor.test.ts`：

```ts
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isReadOnlyBashCommand, riskOfCommand, registerGeneralExecutor, WORKSPACE_NOT_CREATED } from '../electron/main/general-executor.js';
import { ConnectorExecutor } from '@sparkii/approval';
import { AuditStore } from '@sparkii/approval';

function makeExecutor(workspacePath: string) {
  const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.db'));
  const executor = new ConnectorExecutor(audit);
  const created: string[] = [];
  registerGeneralExecutor(executor, {
    getWorkspace: (sid) => (sid === 's1' ? { workspacePath } : undefined),
    markWorkspaceCreated: (sid) => created.push(sid),
  });
  return { executor, created };
}

describe('isReadOnlyBashCommand', () => {
  it('accepts whitelisted read-only commands', () => {
    expect(isReadOnlyBashCommand('ls -la')).toBe(true);
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('rg pattern .')).toBe(true);
  });
  it('rejects metacharacters and write verbs', () => {
    expect(isReadOnlyBashCommand('cat a; rm b')).toBe(false);
    expect(isReadOnlyBashCommand('ls | grep x')).toBe(false);
    expect(isReadOnlyBashCommand('echo hi > f')).toBe(false);
    expect(isReadOnlyBashCommand('rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('git commit -m x')).toBe(false);
  });
  it('classifies destructive commands as high-risk', () => {
    expect(riskOfCommand('rm -rf /tmp/x')).toBe('high-risk');
    expect(riskOfCommand('git reset --hard')).toBe('high-risk');
    expect(riskOfCommand('echo hi')).toBe('write');
  });
});

describe('general executor handlers', () => {
  it('write creates the workspace folder and file', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-parent-')), 'ws-child');
    const { executor, created } = makeExecutor(ws);
    const p = {
      id: 'p1', profileId: 'general', sessionId: 's1', toolName: 'write', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { path: join(ws, 'a/b.txt'), content: 'hello' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect(out.status).toBe('executed');
    expect(existsSync(join(ws, 'a/b.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'a/b.txt'), 'utf8')).toBe('hello');
    expect(created).toEqual(['s1']);
  });

  it('bash read-only on missing workspace returns WORKSPACE_NOT_CREATED', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'ws-')), 'not-created');
    const { executor } = makeExecutor(ws);
    const p = {
      id: 'p2', profileId: 'general', sessionId: 's1', toolName: 'bash', targetSystem: 'general',
      summary: '', payloadHash: 'x', payload: { command: 'ls' }, risk: 'write' as const,
      status: 'approved' as const, createdAt: 0,
    };
    const out = await executor.execute(p as any, { actor: 'admin' });
    expect((out as any).execution?.result?.output).toContain('尚未创建');
    expect(existsSync(ws)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/general-executor.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/electron/main/general-executor.ts`：

```ts
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConnectorExecutor } from '@sparkii/approval';
import type { ToolHandler, ToolResult } from '@sparkii/connectors';
import { isPathInside } from '@sparkii/agent-host';

export const WORKSPACE_NOT_CREATED = '工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。';

const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'cut', 'sort', 'uniq', 'diff',
  'pwd', 'echo', 'which', 'type', 'env', 'date', 'printf', 'true', 'false',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git stash list',
];
const SHELL_META = /[;&|><`\n]|\$\s*\(/;

export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_META.test(trimmed)) return false;
  return READ_ONLY_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p} `));
}

const HIGH_RISK = /\brm\s+-rf\b|\bgit\s+reset\s+--hard\b|\bdrop\s+(table|database)\b|\bmkfs\b|\bformat\s+/i;

export function riskOfCommand(command: string): 'write' | 'high-risk' {
  return HIGH_RISK.test(command) ? 'high-risk' : 'write';
}

export interface GeneralExecutorOptions {
  getWorkspace(sessionId: string): { workspacePath: string } | undefined;
  markWorkspaceCreated(sessionId: string): void;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: output.slice(0, 128 * 1024), timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: output.slice(0, 128 * 1024), timedOut });
    });
  });
}

export function registerGeneralExecutor(executor: ConnectorExecutor, opts: GeneralExecutorOptions): void {
  const bash: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const command = String(args.command ?? '');
    const readOnly = isReadOnlyBashCommand(command);
    if (readOnly && !existsSync(ws.workspacePath)) {
      return { ok: true, data: { exitCode: 0, output: WORKSPACE_NOT_CREATED } };
    }
    if (!readOnly) {
      await mkdir(ws.workspacePath, { recursive: true });
      opts.markWorkspaceCreated(ctx.sessionId);
    }
    const timeoutMs = Number(args.timeout ?? 60_000);
    const result = await runCommand(command, ws.workspacePath, timeoutMs);
    return { ok: true, data: result };
  };

  const edit: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const path = String(args.path);
    if (!isPathInside(ws.workspacePath, path)) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'path outside workspace' } };
    await mkdir(ws.workspacePath, { recursive: true });
    opts.markWorkspaceCreated(ctx.sessionId);
    await writeFile(path, String(args.content ?? ''), 'utf8');
    return { ok: true, data: { path } };
  };

  const write: ToolHandler = async (args: Record<string, unknown>, ctx) => {
    const ws = opts.getWorkspace(ctx.sessionId);
    if (!ws) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'session workspace missing' } };
    const path = String(args.path);
    if (!isPathInside(ws.workspacePath, path)) return { ok: false, error: { code: 'CONNECTOR_DENIED', message: 'path outside workspace' } };
    await mkdir(ws.workspacePath, { recursive: true });
    opts.markWorkspaceCreated(ctx.sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(args.content ?? ''), 'utf8');
    return { ok: true, data: { path } };
  };

  executor.register('bash', bash);
  executor.register('edit', edit);
  executor.register('write', write);
}
```

> diff 展示：Main 在提交提案前计算 diff（见 Task 15 broker.route），本任务不重复实现；`computeEditDiff` 已在 Task 5 由 agent-host 提供，Task 15 使用。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/general-executor.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/general-executor.ts apps/desktop/test/general-executor.test.ts
git commit -m "feat(desktop): deterministic general executor for bash/edit/write"
```

---

### Task 14: desktop 多 profile 运行时 + gate 接线 + listAgents

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`、`apps/desktop/electron/main/workflow.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/main/index.ts`
- Test: 无新单测（由 Task 17 的 e2e 回归覆盖）；必须通过 `pnpm typecheck`。

**Interfaces:**
- Consumes: `ApprovalGate.configureProfile`（Task 3）、`ChatSessionStore`（Task 12）、`registerGeneralExecutor`（Task 13）。
- Produces:
  ```ts
  export interface ProfileRuntime { profile: Awaited<ReturnType<typeof loadProfile>>; router: ModelRouter; rbac: Rbac; dir: string; }
  export interface Runtime {
    profiles: Map<string, ProfileRuntime>;
    profileOf(id: string): ProfileRuntime;
    gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
    pool: PiRuntimePool; identity: LocalIdentityProvider; subject: Subject | null;
    chatSessions: ChatSessionStore; dataDir: string;
  }
  assemble(opts: { profiles: Array<{ id: string; dir: string }>; dataDir: string; publicKey?: string; allowUnsigned?: boolean }): Promise<Runtime>
  ```
  broker：`route(req, { sessionId, profileId })`——`bash` 只读直通（审计 `tool.read`）、`bash` 写/`edit`/`write` 在提交前计算 diff（`computeEditDiff`）并走 `request`；`request(req, { sessionId, profileId })` 按 profile 的 timeout 过期。

- [ ] **Step 1: 实现 runtime.ts 多 profile**

`apps/desktop/electron/main/runtime.ts` 改为：

```ts
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProfile } from '@sparkii/config';
import { ModelRouter, normalizeRouting } from '@sparkii/model-router';
import { Rbac, LocalIdentityProvider, type Subject } from '@sparkii/identity';
import { ApprovalGate, ConnectorExecutor, AuditStore } from '@sparkii/approval';
import { PiRuntimePool } from '@sparkii/agent-host';
import { knowledgeConnector } from '@sparkii/connectors';
import { createUtilityHostHandle, createForkHostHandle } from '../pi-runtime/transports.js';
import { registerConnectorHandlers } from './connector-registry.js';
import { ChatSessionStore } from './chat-session-store.js';
import { registerGeneralExecutor } from './general-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ProfileRuntime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter;
  rbac: Rbac;
  dir: string;
}

export interface Runtime {
  profiles: Map<string, ProfileRuntime>;
  gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  pool: PiRuntimePool; identity: LocalIdentityProvider; subject: Subject | null;
  chatSessions: ChatSessionStore; dataDir: string;
}

function resolvePiRuntimeEntry(): string {
  const explicit = process.env.SPARKII_PI_RUNTIME_ENTRY;
  if (explicit && existsSync(explicit)) return explicit;
  return join(__dirname, '../pi-runtime/utility-entry.js');
}

export async function assemble(opts: {
  profiles: Array<{ id: string; dir: string }>;
  dataDir: string; publicKey?: string; allowUnsigned?: boolean;
}): Promise<Runtime> {
  const profiles = new Map<string, ProfileRuntime>();
  for (const { id, dir } of opts.profiles) {
    const profile = await loadProfile(dir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
    profiles.set(id, {
      profile,
      router: new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks)),
      rbac: new Rbac(profile.security.roles),
      dir,
    });
  }
  const audit = new AuditStore(join(opts.dataDir, 'audit.db'));
  const gate = new ApprovalGate({ audit });
  for (const [id, pr] of profiles) {
    gate.configureProfile(id, { policy: pr.profile.security.approval, rbac: pr.rbac });
  }
  const executor = new ConnectorExecutor(audit);
  registerConnectorHandlers(executor);
  const chatSessions = new ChatSessionStore(join(opts.dataDir, 'sessions.db'));
  registerGeneralExecutor(executor, {
    getWorkspace: (sessionId) => {
      const rec = chatSessions.get(sessionId);
      return rec ? { workspacePath: rec.workspacePath } : undefined;
    },
    markWorkspaceCreated: () => {},
  });
  const identity = new LocalIdentityProvider(join(opts.dataDir, 'users.json'));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: 'admin', username: 'admin', password: 'admin123', roles: ['admin', 'reviewer'] });
  }
  const contract = profiles.get('contract-review');
  if (contract) await knowledgeConnector.init({ corpus: contract.profile.agent.knowledge });
  const entry = resolvePiRuntimeEntry();
  const pool = new PiRuntimePool({
    maxAgents: Number(process.env.SPARKII_MAX_AGENTS ?? 4),
    makeSupervisor: () =>
      process.env.SPARKII_PI_USE_FORK === '1'
        ? createForkHostHandle(entry)
        : createUtilityHostHandle(entry),
  });
  return {
    profiles, gate, executor, audit, pool, identity, subject: null, chatSessions, dataDir: opts.dataDir,
    profileOf: (id) => {
      const pr = profiles.get(id);
      if (!pr) throw new Error(`unknown profile ${id}`);
      return pr;
    },
  };
}
```

- [ ] **Step 2: 更新 workflow.ts 与 ipc.ts 适配**

`apps/desktop/electron/main/workflow.ts`：

- `createBroker(rt, getWindow)` 的 `request(req, sessionId)` 改为 `request(req, meta: { sessionId: string; profileId: string })`，gate.submit 的 profileId 用 `meta.profileId`，超时用 `rt.profileOf(meta.profileId).profile.security.approval.timeoutMs`；
- 新增 `route(req, meta)`：

```ts
  route(req: ProposalRequest & { requestId: string }, meta: { sessionId: string; profileId: string }): Promise<ProposalDecision> {
    if (req.toolName === 'bash' && isReadOnlyBashCommand(String((req.payload as any)?.command ?? ''))) {
      return this.requestReadOnly(req, meta);
    }
    if (req.toolName === 'edit' || req.toolName === 'write' || req.toolName === 'bash') {
      req = { ...req, payload: attachDiff(rt, req), risk: req.toolName === 'bash' ? riskOfCommand(String((req.payload as any)?.command ?? '')) : req.risk };
    }
    return this.request(req, meta);
  }

  async requestReadOnly(req: ProposalRequest & { requestId: string }, meta: { sessionId: string; profileId: string }): Promise<ProposalDecision> {
    const result = await rt.executor.execute({
      ...req,
      id: req.requestId, profileId: meta.profileId, sessionId: meta.sessionId,
      payloadHash: '', status: 'approved', createdAt: Date.now(),
    } as any, { actor: rt.subject?.userId ?? 'agent' });
    await rt.audit.append({ actor: rt.subject?.userId ?? 'agent', action: 'tool.read', resource: req.toolName, sessionId: meta.sessionId });
    return { approved: true, proposalId: req.requestId, status: result.status, result: result.execution?.result };
  }
```

`attachDiff`（同文件内）：

```ts
function attachDiff(rt: Runtime, req: ProposalRequest & { requestId: string }): unknown {
  const payload = (req.payload ?? {}) as { path?: string; content?: string };
  if ((req.toolName === 'edit' || req.toolName === 'write') && payload.path) {
    let oldText = '';
    try { oldText = readFileSync(payload.path, 'utf8'); } catch { oldText = ''; }
    return { ...payload, diff: computeEditDiff(oldText, String(payload.content ?? ''), payload.path) };
  }
  return payload;
}
```

`runWorkflow` 内 `rt.profile` 引用改为 `const pr = rt.profileOf('contract-review')`，broker 调用改为 `broker.route(req, { sessionId, profileId: 'contract-review' })`。

`apps/desktop/electron/main/ipc.ts`：

- `sparkii:runWorkflow` 与 `sparkii:prompt` 内 `slot.supervisor.onProposal((req) => broker.request(req, sessionId))` 改为 `broker.route(req, { sessionId, profileId })`（runWorkflow 用 `'contract-review'`）；
- `decideApproval` 的 `report.export` 分支保留；新增 `sparkii:listAgents`：

```ts
  ipcMain.handle('sparkii:listAgents', () =>
    [...rt.profiles.values()].map((pr) => ({
      id: pr.profile.manifest.name,
      name: pr.profile.manifest.displayName ?? pr.profile.manifest.name,
    })),
  );
```

- `sparkii:getProfile` 改为返回第一个 profile（现有 renderer 兼容）：

```ts
  ipcMain.handle('sparkii:getProfile', () => {
    const first = [...rt.profiles.values()][0];
    return { manifest: first.profile.manifest, pages: first.profile.ui.pages, theme: first.profile.ui.theme, tools: first.profile.agent.tools };
  });
```

- [ ] **Step 3: 更新 index.ts 扫描 profiles**

`apps/desktop/electron/main/index.ts`：

```ts
import { readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

  const single = process.env.SPARKII_PROFILE_DIR;
  const profileRoot = single
    ? dirname(single)
    : (app.isPackaged ? join(process.resourcesPath, 'profiles') : join(__dirname, '../../../../profiles'));
  const profileDirs = single
    ? [{ id: basename(single), dir: single }]
    : readdirSync(profileRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(profileRoot, e.name, 'manifest.yaml')))
        .map((e) => ({ id: e.name, dir: join(profileRoot, e.name) }));
  rt = await assemble({ profiles: profileDirs, dataDir, allowUnsigned: process.env.NODE_ENV !== 'production' });
```

- [ ] **Step 4: 类型检查**

Run: `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.electron.json && pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS（无类型错误；若有调用点遗漏，按错误逐个改为 `profileOf`/`route`）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/index.ts
git commit -m "feat(desktop): multi-profile runtime with coding-aware broker"
```

---

### Task 15: desktop 会话/模型/工作区 IPC + preload

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/preload/api-types.ts`、`apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`（扩展）

**Interfaces:**
- Consumes: `ChatSessionStore`、`autoWorkspacePath`/`ensureWorkspaceDir`（Task 11/12）、`buildSaddle`（本任务定义）、`selectModel`/`router`（Task 14）。
- Produces: preload API 新增：
  ```ts
  newChatSession(profileId: string): Promise<{ sessionId: string; workspacePath: string; model: string | null }>;
  openChatSession(sessionId: string): Promise<{ messages: unknown[] }>;
  listChatSessions(profileId?: string): Promise<unknown[]>;
  getChatSession(sessionId: string): Promise<unknown>;
  getChatMessages(sessionId: string): Promise<unknown[]>;
  promptSession(sessionId: string, text: string): Promise<{ ok: boolean }>;
  abortChat(sessionId: string): Promise<{ ok: boolean }>;
  setChatTitle(sessionId: string, title: string): Promise<{ ok: boolean }>;
  setChatModel(sessionId: string, model: string | null): Promise<{ ok: boolean }>;
  setChatWorkspace(sessionId: string, path: string | null): Promise<{ ok: boolean }>;
  chooseWorkspace(): Promise<{ path?: string }>;
  getModelOptions(): Promise<{ defaultModel: string | null; models: string[] }>;
  deleteChatSession(sessionId: string): Promise<{ ok: boolean }>;
  listAgents(): Promise<Array<{ id: string; name: string }>>;
  ```

- [ ] **Step 1: 扩展 preload-api.test.ts**

在 `apps/desktop/test/preload-api.test.ts` 中追加（沿用该文件现有 mock `IpcLike` 模式）：

```ts
  it('exposes chat session and agent APIs', () => {
    const calls: string[] = [];
    const ipc = {
      invoke: (channel: string) => { calls.push(channel); return Promise.resolve({ ok: true }); },
      on: () => {},
      removeListener: () => {},
    };
    const api = buildApi(ipc as any);
    void api.newChatSession('general');
    void api.listChatSessions();
    void api.getModelOptions();
    void api.listAgents();
    void api.promptSession('s1', 'hi');
    expect(calls).toEqual([
      'sparkii:newChatSession', 'sparkii:listChatSessions', 'sparkii:getModelOptions',
      'sparkii:listAgents', 'sparkii:promptSession',
    ]);
  });
```

（先确认该文件现有 import 与 helper 名，按其结构追加；若测试文件已导出 `buildApi` mock 工厂，复用。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/preload-api.test.ts`
Expected: FAIL——新方法不存在。

- [ ] **Step 3: 实现 preload 类型与 api**

`apps/desktop/electron/preload/api-types.ts` 追加：

```ts
  newChatSession(profileId: string): Promise<{ sessionId: string; workspacePath: string; model: string | null }>;
  openChatSession(sessionId: string): Promise<{ messages: unknown[] }>;
  listChatSessions(profileId?: string): Promise<unknown[]>;
  getChatSession(sessionId: string): Promise<unknown>;
  getChatMessages(sessionId: string): Promise<unknown[]>;
  promptSession(sessionId: string, text: string): Promise<{ ok: boolean }>;
  abortChat(sessionId: string): Promise<{ ok: boolean }>;
  setChatTitle(sessionId: string, title: string): Promise<{ ok: boolean }>;
  setChatModel(sessionId: string, model: string | null): Promise<{ ok: boolean }>;
  setChatWorkspace(sessionId: string, path: string | null): Promise<{ ok: boolean }>;
  chooseWorkspace(): Promise<{ path?: string }>;
  getModelOptions(): Promise<{ defaultModel: string | null; models: string[] }>;
  deleteChatSession(sessionId: string): Promise<{ ok: boolean }>;
  listAgents(): Promise<Array<{ id: string; name: string }>>;
```

`apps/desktop/electron/preload/api.ts` 的返回对象追加：

```ts
    newChatSession: (profileId) => invoke('newChatSession', profileId),
    openChatSession: (sessionId) => invoke('openChatSession', sessionId) as Promise<{ messages: unknown[] }>,
    listChatSessions: (profileId) => invoke('listChatSessions', profileId),
    getChatSession: (sessionId) => invoke('getChatSession', sessionId),
    getChatMessages: (sessionId) => invoke('getChatMessages', sessionId),
    promptSession: (sessionId, text) => invoke('promptSession', sessionId, text) as Promise<{ ok: boolean }>,
    abortChat: (sessionId) => invoke('abortChat', sessionId) as Promise<{ ok: boolean }>,
    setChatTitle: (sessionId, title) => invoke('setChatTitle', sessionId, title) as Promise<{ ok: boolean }>,
    setChatModel: (sessionId, model) => invoke('setChatModel', sessionId, model) as Promise<{ ok: boolean }>,
    setChatWorkspace: (sessionId, path) => invoke('setChatWorkspace', sessionId, path) as Promise<{ ok: boolean }>,
    chooseWorkspace: () => invoke('chooseWorkspace') as Promise<{ path?: string }>,
    getModelOptions: () => invoke('getModelOptions') as Promise<{ defaultModel: string | null; models: string[] }>,
    deleteChatSession: (sessionId) => invoke('deleteChatSession', sessionId) as Promise<{ ok: boolean }>,
    listAgents: () => invoke('listAgents') as Promise<Array<{ id: string; name: string }>>,
```

- [ ] **Step 4: 实现 ipc 会话/模型/工作区**

`apps/desktop/electron/main/ipc.ts` 追加（import 补充：`app` from 'electron'、`mkdir` from 'node:fs/promises'、`join`、`autoWorkspacePath`/`ensureWorkspaceDir`/`workspaceName`、`SessionSaddle` from '@sparkii/agent-host'、`loadSettings`/`listModels` 已有）：

```ts
  const openSessions = new Map<string, { slot: Awaited<ReturnType<typeof rt.pool.acquire>>; profileId: string }>();

  const anchorDir = (sessionId: string) => join(rt.dataDir, 'sessions', sessionId);

  function buildSaddle(profileId: string, sessionId: string): SessionSaddle {
    const pr = rt.profileOf(profileId);
    const rec = rt.chatSessions.get(sessionId);
    return {
      tools: pr.profile.agent.tools,
      skillsDir: join(pr.dir, 'agent', 'skills'),
      cwd: anchorDir(sessionId),
      systemPrompt: pr.profile.agent.prompts.system,
      workspaceRoot: rec?.workspacePath,
    };
  }

  ipcMain.handle('sparkii:newChatSession', async (_e, profileId: string) => {
    const sessionId = randomUUID();
    const now = new Date();
    const workspacePath = autoWorkspacePath(app.getPath('desktop'), now);
    await mkdir(anchorDir(sessionId), { recursive: true });
    rt.chatSessions.create({
      id: sessionId, profileId, title: `会话 ${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      workspaceKind: 'auto', workspacePath,
    });
    return { sessionId, workspacePath, model: null };
  });

  ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    if (!openSessions.has(sessionId)) {
      const slot = await rt.pool.acquire(sessionId, {
        saddle: buildSaddle(rec.profileId, sessionId),
        resumeSessionFile: rec.piSessionFile ?? undefined,
      });
      openSessions.set(sessionId, { slot, profileId: rec.profileId });
      const state = await slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
    }
    const open = openSessions.get(sessionId)!;
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return { messages: (resp.data ?? []) as unknown[] };
  });

  ipcMain.handle('sparkii:listChatSessions', (_e, profileId?: string) => rt.chatSessions.list(profileId));
  ipcMain.handle('sparkii:getChatSession', (_e, sessionId: string) => rt.chatSessions.get(sessionId) ?? null);
  ipcMain.handle('sparkii:getChatMessages', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (!open) return [];
    const resp = await open.slot.client.send({ type: 'get_messages' });
    return (resp.data ?? []) as unknown[];
  });

  ipcMain.handle('sparkii:promptSession', async (_e, sessionId: string, text: string) => {
    const open = openSessions.get(sessionId);
    if (!open) throw new Error('session not open');
    const { slot, profileId } = open;
    slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId }));
    const rec = rt.chatSessions.get(sessionId);
    const pr = rt.profileOf(profileId);
    if (rec?.model) {
      const [provider, modelId] = rec.model.split('/');
      const resp = await slot.client.send({ type: 'set_model', provider, modelId });
      if (!resp.success) throw new Error(`cannot select model ${rec.model}: ${resp.error ?? 'unknown'}`);
    } else {
      const target = pr.router.resolve('coding') ?? pr.router.resolve('default');
      if (target) {
        const resp = await slot.client.send({ type: 'set_model', provider: target.provider, modelId: target.modelId });
        if (!resp.success) throw new Error(`cannot select model ${target.provider}/${target.modelId}: ${resp.error ?? 'unknown'}`);
      }
    }
    const win = getWindow();
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
      off = slot.client.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', { ...ev, sessionId });
        if (ev.type === 'agent_end') { clearTimeout(timer); off(); resolve(); }
      });
      slot.client.send({ type: 'prompt', message: text }).then((resp) => {
        if (!resp.success) { clearTimeout(timer); off(); reject(new Error(resp.error ?? 'prompt failed')); }
      });
    });
    const state = await slot.client.send({ type: 'get_state' });
    if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
      rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:abortChat', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) await open.slot.client.send({ type: 'abort' });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatTitle', (_e, sessionId: string, title: string) => {
    rt.chatSessions.update(sessionId, { title });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatModel', (_e, sessionId: string, model: string | null) => {
    rt.chatSessions.update(sessionId, { model });
    return { ok: true };
  });

  ipcMain.handle('sparkii:setChatWorkspace', async (_e, sessionId: string, path: string | null) => {
    const rec = rt.chatSessions.get(sessionId);
    if (!rec) throw new Error('session not found');
    if (path) {
      rt.chatSessions.update(sessionId, { workspaceKind: 'user', workspacePath: path });
    } else {
      const now = new Date();
      rt.chatSessions.update(sessionId, { workspaceKind: 'auto', workspacePath: autoWorkspacePath(app.getPath('desktop'), now) });
    }
    const open = openSessions.get(sessionId);
    if (open) {
      const resp = await open.slot.client.send({ type: 'configure_session', saddle: buildSaddle(open.profileId, sessionId) });
      if (!resp.success) throw new Error(`configure_session failed: ${resp.error ?? 'unknown'}`);
    }
    return { ok: true };
  });

  ipcMain.handle('sparkii:chooseWorkspace', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? {} : { path: result.filePaths[0] };
  });

  ipcMain.handle('sparkii:getModelOptions', async () => {
    const settings = await loadSettings(rt.dataDir);
    const models = settings.baseUrl ? (await listModels(settings.baseUrl, settings.apiKey)).models ?? [] : [];
    return { defaultModel: settings.defaultModel ?? null, models };
  });

  ipcMain.handle('sparkii:deleteChatSession', async (_e, sessionId: string) => {
    const open = openSessions.get(sessionId);
    if (open) {
      const state = await open.slot.client.send({ type: 'get_state' });
      if ((state.data as { sessionFile?: string } | undefined)?.sessionFile) {
        rt.chatSessions.update(sessionId, { piSessionFile: (state.data as { sessionFile: string }).sessionFile });
      }
      await rt.pool.release(sessionId);
      openSessions.delete(sessionId);
    }
    rt.chatSessions.delete(sessionId);
    return { ok: true };
  });
```

> 说明：既有 `sparkii:prompt(text)`（无 sessionId，一次性）与 `api.prompt(text)` 原样保留，供现有 ChatWorkbench 与测试使用；新会话走 `sparkii:promptSession(sessionId, text)`。UI 计划落地 GeneralChatSurface 后，旧 ChatWorkbench 由 UI 计划移除。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/preload-api.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/ipc.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/test/preload-api.test.ts
git commit -m "feat(desktop): chat session, model, and workspace IPC"
```

---

### Task 16: profiles（general 配置包 + 合同审核鞍迁移）

**Files:**
- Create: `profiles/general/manifest.yaml`、`profiles/general/agent/tools.yaml`、`profiles/general/agent/workflow.yaml`、`profiles/general/agent/prompts/system.md`、`profiles/general/agent/knowledge/corpus.json`、`profiles/general/ui/pages/home.json`、`profiles/general/ui/theme.yaml`、`profiles/general/ui/theme/tokens.json`、`profiles/general/security/roles.yaml`、`profiles/general/security/approval.yaml`
- Modify: `profiles/contract-review/agent/tools.yaml`、Create `profiles/contract-review/agent/prompts/system.md`
- Test: `packages/config/test/profile-dirs.test.ts`（新）

**Interfaces:**
- Consumes: loader 的 displayName/system.md 支持（Task 2）。
- Produces: `profiles/general` 可被 `loadProfile(..., { allowUnsigned: true })` 加载；`agent.tools = ['read','ls','grep','find','bash','edit','write']`；`agent.prompts.system` 存在；合同审核 tools 含 `read` 且 system.md 可加载。

- [ ] **Step 1: 追加失败测试**

`packages/config/test/profile-dirs.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProfile } from '../src/loader.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('repo profiles', () => {
  it('loads general profile with coding saddle tools and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'profiles/general'), { allowUnsigned: true });
    expect(p.manifest.displayName).toBe('通用智能体');
    expect(p.agent.tools).toEqual(['read', 'ls', 'grep', 'find', 'bash', 'edit', 'write']);
    expect(p.agent.prompts.system).toContain('通用智能体');
  });
  it('loads contract profile with read tool and system prompt', async () => {
    const p = await loadProfile(join(repoRoot, 'profiles/contract-review'), { allowUnsigned: true });
    expect(p.agent.tools).toContain('read');
    expect(p.agent.prompts.system).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/config/test/profile-dirs.test.ts`
Expected: FAIL——general profile 不存在或加载报错。

- [ ] **Step 3: 创建 profiles/general 各文件**

`profiles/general/manifest.yaml`：

```yaml
name: general
displayName: 通用智能体
version: 1.0.0
modelRouting:
  tasks:
    coding:
      - { provider: deepseek, modelId: deepseek-v4-pro }
      - { provider: deepseek, modelId: deepseek-v4-flash }
    default:
      - { provider: deepseek, modelId: deepseek-v4-flash }
```

`profiles/general/agent/tools.yaml`：

```yaml
tools:
  - read
  - ls
  - grep
  - find
  - bash
  - edit
  - write
```

`profiles/general/agent/workflow.yaml`：

```yaml
version: 1
engine: linear
steps: []
```

`profiles/general/agent/prompts/system.md`：

```markdown
你是 Sparkii Desktop 的通用智能体。
你可以与用户对话问答，也可以在会话工作区内编程：阅读代码、搜索、执行命令、修改文件、使用 git。
工作区规则：每个会话有一个工作区根目录。目录在第一个写操作被批准时才会创建；在此之前只读操作会提示「工作区尚未创建」。用户在输入框上方指定工作区时，以用户指定为准。所有文件操作必须位于工作区根内。
审批规则：只读操作直接执行；写操作（修改文件、写命令、git 写操作、安装依赖等）会弹出审批，批准后才执行，拒绝即不执行。请给出清晰、小步、可审的操作，先读后写，一次改动聚焦，并说明理由。
行为准则：先勘察再动手；命令注意超时与输出量；破坏性命令（rm -rf、git reset --hard 等）会被标记为高风险。
```

`profiles/general/agent/knowledge/corpus.json`：

```json
[]
```

`profiles/general/ui/pages/home.json`：

```json
{ "page": "general/home", "layout": { "type": "grid", "columns": 1 }, "widgets": [] }
```

`profiles/general/ui/theme.yaml`：

```yaml
file: theme/tokens.json
```

`profiles/general/ui/theme/tokens.json`：

```json
{}
```

`profiles/general/security/roles.yaml`：

```yaml
roles:
  - name: reviewer
    pages: [home]
    tools: []
    canApprove: [write]
  - name: admin
    pages: [home, audit]
    tools: []
    canApprove: [write, high-risk]
```

`profiles/general/security/approval.yaml`：

```yaml
requireApproval: []
timeoutMs: 300000
highRiskDoubleConfirm: true
```

`profiles/contract-review/agent/tools.yaml`（追加 `read`）：

```yaml
tools:
  - document.read
  - knowledge.search
  - report.export
  - read
```

`profiles/contract-review/agent/prompts/system.md`：

```markdown
你是 Sparkii Desktop 的合同审核智能体。
你的职责：解析合同文档、检索本地法规知识库、抽取条款、比对风险、生成审核报告。
工作方式：严格按工作流执行各步骤；写操作（导出报告等）必须等待用户批准，拒绝即不执行。
只使用本智能体提供的工具；不执行工作区外或未授权的操作。
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/config/test/profile-dirs.test.ts packages/config/test/loader.test.ts packages/config/test/integrity.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add profiles/general profiles/contract-review/agent/tools.yaml profiles/contract-review/agent/prompts/system.md packages/config/test/profile-dirs.test.ts
git commit -m "feat(profiles): general agent profile and contract saddle migration"
```

---

### Task 17: 全量验证与回归

**Files:** 无新增。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: PASS（全部 packages + apps 测试）。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 构建 + pilot e2e 回归**

Run:
```bash
pnpm --filter @sparkii/desktop build:renderer
pnpm --filter @sparkii/desktop build:main
pnpm exec playwright test apps/desktop/e2e/pilot.spec.ts
```
Expected: 合同审核 pilot 验收通过（需可用模型端点；无端点时以 `SPARKII_SKIP_LLM=1` 记录跳过并人工回归）。

- [ ] **Step 4: 提交（如有修复）**

```bash
git add -A
git commit -m "chore: runtime verification fixes"
```

---

## Self-Review（写作时已执行）

**Spec coverage 对照：**

- §4 general profile / §4.1 合同迁移 → Task 16
- §5.1 多 profile → Task 14；§5.2 gate 多策略 → Task 3；§5.3 统一池 + 鞍 + 池级写安全 → Task 9/10 + Task 6（operations 委托）+ Task 13/15
- §6.1 注册表/鞍装配/连接器行为 → Task 7/9；§6.2 只读白名单 → Task 13；§6.3 diff → Task 5 + Task 14（attachDiff）；§6.4 GeneralExecutor → Task 13
- §7 会话注册表/工作区/恢复 → Task 11/12/15；§7.4 IPC → Task 15
- §8 模型路由 coding + Composer 默认/用户选择 → Task 1 + Task 15（set_model 优先级）
- §10 安全模型 → Task 3/6/7/10/13（测试锁定）
- §12 测试策略 → 各任务 TDD + Task 17 回归
- §14 文件清单 → 各任务 Files 段一一对应

**Placeholder scan：** 无 TBD/TODO；两处「实现时核对」是签名适配说明（附了 .d.ts 依据与回退方案），非占位。

**Type consistency：** `SessionSaddle`（Task 9）→ pool（Task 10）→ buildSaddle（Task 15）字段一致；`broker.route` 的 `{ sessionId, profileId }` 在 Task 14/15 调用一致；`resolveToolDefinitions` 输出供 `session.agent.state.tools`（Task 9）与测试断言（Task 7）一致。

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-08-25-general-agent-runtime.md`。两种执行方式：

1. **Subagent-Driven（推荐）**——每个任务派发一个全新 subagent，任务间我做两段式审查，迭代快；
2. **Inline Execution**——在当前会话用 executing-plans 按批次执行，带检查点。

采用哪种？确认后我同时开始写 UI 计划（GeneralChatSurface / Composer / ToolCard / 会话抽屉 / 审批 diff / e2e）。
