# 合同审核智能体（SparkiiDesktop-Pi MVP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可私有化部署的 Windows 桌面应用：上传合同 → 跑「文档解析 → 条款抽取 → 风险比对 → 生成报告 → 人工复核」流程 → 对写操作审批 → 审计留痕；被拒绝的写绝不发生。

**Architecture:** Electron 主进程（控制层）spawn 一个 `pi --mode rpc` 子进程（Agent 内核），通过 JSONL stdio 通信；Renderer（React）经 `contextBridge` 只拿类型化 API。连接器读工具在 Pi 子进程内执行，写工具在 Pi 内只「提议」，真正的写由 Main 侧确定性执行器按权威审批状态放行。配置包（profile）以版本化目录驱动页面/流程/skills/主题/权限/模型路由。

**Tech Stack:** Electron（稳定版）+ electron-builder；React + Vite + Radix/shadcn 风格无头原语 + 自有皮肤层；TypeScript 全链路；pnpm workspace；Pi RPC 子进程（`@earendil-works/pi-coding-agent` 扩展，typebox 注册工具）；SQLite WAL（better-sqlite3）审计；Vitest + Playwright；本地模型默认（Ollama/vLLM OpenAI 兼容端点）+ 云端可选。

**Spec:** [docs/2026-08-22-design.md](../../2026-08-22-design.md)（相对路径；实现者需与 spec 同读，本计划从 spec 论证）

## Global Constraints

- 全链路 TypeScript；Electron 稳定版（≥33）+ electron-builder；React + Vite + Radix/shadcn 风格无头组件原语 + 自有皮肤层。
- Pi 子进程通过 `pi --mode rpc`（JSONL over stdin/stdout，LF 分隔，不做 Unicode 换行分割）通信；扩展经 `--extension` 加载，用 `registerTool` / `registerProvider` / `ctx.ui`。
- 本地模型默认（Ollama/vLLM，OpenAI 兼容端点），云端可选；模型路由按 profile 配置并按任务降级切换。
- 写操作「提议—执行分离」：Pi 只暴露提议工具，无写原语；Main 侧确定性连接器执行器只读权威审批状态放行/阻止；参数在提议时冻结；拒绝 = 直接不写。
- 审计：SQLite（WAL）追加写 + 可导出；每次写尝试恰好产生一条审计记录；被拒绝的写永远到不了连接器执行器。
- better-sqlite3 是原生模块：开发/测试阶段用包内预编译二进制（`pnpm-workspace.yaml` 中 `allowBuilds.better-sqlite3 = false`，避免在无 VS Build Tools 的机器上触发 node-gyp 编译）；Electron 打包阶段再用 `electron-builder install-app-deps` 重建 Electron ABI。
- MVP 本地账号 + 角色 RBAC（角色 → 可见页面/可用工具/可批事项）；SSO/LDAP/AD 预留 `IdentityProvider` 接口，不提前实现。
- 页面 = 组件注册表 + JSON schema 驱动；页面 schema 校验只能引用注册表内 widget 与允许的数据绑定，配置包不得在渲染层执行任意代码。
- Renderer 沙箱化：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；无 Node 能力，无凭证访问。
- 密钥用 Electron `safeStorage` 加密落盘（Windows DPAPI/凭据管理器），绝不明文，绝不暴露给 Renderer。
- 数据目录按用户隔离；敏感数据加密落盘；审计本地 + 可导出；无退出遥测（除非显式开启）。
- 平台：Windows 优先（NSIS + MSIX），跨平台（macOS DMG / Linux AppImage+deb）后续打磨。
- 版本地板：Node ≥ 22（工具链）、Bun ≥ 1.2（Pi 运行时，若走 Bun）、Electron ≥ 33、TypeScript ≥ 5.6、pnpm ≥ 9。
- Pilot 范围：连接器只做文档解析（PDF/Word/Excel）、法规知识库 RAG、报告导出（Word/PDF）；ERP/MES/DCS、外部数据、本地工具连接器留接口。
- 测试原则：行为契约优先于快照；安全不变量测试优先级最高；无 API key 时 LLM 依赖测试跳过；多数测试用假 provider/录制响应。

---

## 文件结构（先锁定分解决策）

```
package.json                          # pnpm workspace 根，scripts: build/test/lint
pnpm-workspace.yaml                   # packages/*、apps/*
tsconfig.base.json                    # 共享 TS 编译选项
.gitignore                            # node_modules/dist/out/密钥/数据目录
vitest.config.ts                      # 根测试聚合

apps/desktop/
  package.json
  electron/
    main/index.ts                     # 窗口、生命周期、装配（config/workflow/chat/approval/audit）
    main/ipc.ts                       # ipcMain.handle 注册，转发到各模块
    main/keyring.ts                   # safeStorage 加密存储密钥
    preload/index.ts                  # contextBridge 暴露 sparkii 类型化 API
  src/                                # Renderer（React + Vite）
    main.tsx / App.tsx
    shell/                            # 应用外壳、导航（主题化）
    composer/                         # 页面组合引擎 + widget 注册表
    workbench/                        # 对话工作台
    approval/                         # 审批弹窗/面板
    audit/                            # 审计视图
  index.html
  vite.config.ts
  electron-builder.yml

packages/config/                      # profile schema、加载、校验、继承、delta、验签
packages/model-router/                # 模型路由选择 + 降级
packages/connectors/                  # A/B/C/D 连接器接口 + 纯逻辑（pilot 三类）
packages/identity/                    # 本地账号 + RBAC（预留 IdentityProvider）
packages/approval/                    # 审批门 + 审计 + 确定性执行器
packages/agent-host/                  # Pi 子进程封装：RPC client、事件流、控制通道、桥扩展
packages/theme/                       # 设计 token / 组件皮肤 / 主题（一等交付物）

skills/agent-bridge/                  # Pi 桥扩展源（被打包成单文件 JS）
profiles/contract-review/             # pilot profile（manifest/agent/ui/security）
docs/superpowers/plans/               # 本计划
```

责任边界：
- `packages/config` 是唯一知道「profile 目录/YAML/文件布局」的包；其它包只消费它导出的类型化 `ResolvedProfile`（或其片段），反向不依赖 config。
- `packages/connectors` 只含纯 Node 逻辑（解析/检索/导出字节），**不 import Electron**；读 handler 在 Pi 子进程执行，写 handler 在 Main 执行。
- `packages/approval` 只依赖 config 片段类型、identity 的 RBAC、connectors 的 `ToolHandler`；它是安全边界的落点。
- `packages/agent-host` 是唯一和 `pi` 可执行文件打交道的包；Renderer 永远不 import 它。

## 核心类型词汇表（全计划引用，保持命名一致）

```ts
// 副作用等级
type SideEffect = 'read' | 'write' | 'high-risk';

// 连接器工具（packages/connectors）
type JSONSchema = Record<string, unknown>;
interface ToolContext { profileId: string; sessionId: string; actor: string; requestId: string; }
interface ToolResult { ok: boolean; data?: unknown; error?: { code: string; message: string }; }
type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
interface ToolDef { name: string; description: string; params: JSONSchema; sideEffect: SideEffect; handler: ToolHandler; }
interface Connector { id: string; tools: ToolDef[]; init(cfg: unknown): Promise<void>; }

// 审批（packages/approval）
type ProposalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
interface ProposalRequest { toolName: string; targetSystem: string; summary: string; payload: unknown; risk: SideEffect; }
interface Proposal {
  id: string; profileId: string; sessionId: string;
  toolName: string; targetSystem: string; summary: string;
  payloadHash: string; payload: unknown; risk: SideEffect;
  status: ProposalStatus; createdAt: number;
  decidedAt?: number; decisionBy?: string; decisionNote?: string;
  execution?: { ok: boolean; result?: unknown; error?: string };
}
interface AuditEvent {
  id: string; ts: number; actor: string; action: string;
  resource?: string; payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired';
  modelRoute?: string;
}

// 身份（packages/identity）
interface Subject { userId: string; roles: string[]; }
interface IdentityProvider {
  authenticate(username: string, password: string): Promise<Subject>;
  listUsers(): Promise<Array<{ id: string; username: string; roles: string[] }>>;
}

// 模型路由（packages/model-router）
type ModelTask = 'chat' | 'extract' | 'report' | 'default';
interface ModelTarget { provider: string; modelId: string; }

// 流程（packages/agent-host/workflow，接口定义见 Task 7.1）
type WorkflowEvent =
  | { type: 'step_started'; stepId: string }
  | { type: 'step_completed'; stepId: string; output: unknown }
  | { type: 'tool_call'; stepId: string; toolName: string }
  | { type: 'approval_required'; stepId: string; proposalId: string }
  | { type: 'workflow_completed'; result: unknown }
  | { type: 'workflow_failed'; stepId: string; error: { code: string; message: string } };
```

（`WorkflowDef`、`WorkflowRunner`、`RunContext` 的完整定义在 Task 7.1 给出。）

---

## 里程碑总览（MVP 边界）

| 里程碑 | 内容 | 交付可测产物 |
|---|---|---|
| M0 | monorepo 脚手架 + 测试/CI | `pnpm test` 绿 |
| M1 | 配置包系统（schema/加载/继承/delta/验签） | 非法 profile 拒绝加载、继承/delta 正确叠加 |
| M2 | 模型路由 + 降级 | 任务→模型选择与降级正确 |
| M3 | 连接器纯逻辑（文档/知识库/报告） | 解析/检索/导出的字节产物正确 |
| M4 | 本地账号 + RBAC | 登录 + 权限判定正确 |
| M5 | 审批门 + 审计 + 确定性执行器 | 安全不变量契约测试全绿 |
| M6 | Agent 宿主（Pi RPC + 桥扩展 + 控制通道） | 真实 spawn Pi 跑通读工具、写被门控 |
| M7 | 流程编排（WorkflowRunner + LinearRunner） | 线性流程事件序列正确 |
| M8 | UI + 主题 + Electron 壳装配 | 页面组合/对话/审批/审计可交互 |
| M9 | 打包 + E2E + pilot 验收 | 离线包跑通 pilot 验收标准 |

M1–M7 是「后端安全核心」，M8 是 UI 装配，M9 是打包验收。M0–M9 全部落在 MVP 范围内；spec 第 12 节的后续能力只留接口，见文末「Deferred（仅接口，不实现）」。

---

## M0 — 仓库与工具链

### Task 0: pnpm workspace 脚手架 + 测试/CI

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`、`vitest.config.ts`、`.github/workflows/ci.yml`
- Create: `packages/config/package.json`（空包占位，后续任务填内容）

**Interfaces:**
- Produces: 根命令 `pnpm build`、`pnpm test`、`pnpm lint`；所有 workspace 包统一用 `@sparkii/<name>` 命名，ESM（`"type":"module"`），`exports` 指向 `./src/index.ts` 与 `./dist/index.js`。

- [ ] **Step 1: 写根配置文件**

`package.json`：

```json
{
  "name": "sparkii-desktop-pi",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22", "pnpm": ">=9" },
  "scripts": {
    "build": "pnpm -r --if-present run build",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "pnpm -r --if-present run typecheck"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - packages/*
  - apps/*
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`：

```text
node_modules/
dist/
out/
*.tsbuildinfo
.env
.sparkii-data/
*.key
*.sig
```

- [ ] **Step 2: 写冒烟测试并确认失败**

Create `vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/**/test/**/*.test.ts'], pool: 'forks' },
});
```

Create `packages/config/test/smoke.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { ping } from '../src/index.js';

describe('smoke', () => {
  it('ping returns pong', () => {
    expect(ping()).toBe('pong');
  });
});
```

Create `packages/config/package.json`：

```json
{
  "name": "@sparkii/config",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run", "build": "tsc -p tsconfig.json" },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm install && pnpm test`
Expected: FAIL（`Cannot find module '../src/index.js'` / `ping is not a function`）。

- [ ] **Step 4: 最小实现使测试通过**

Create `packages/config/src/index.ts`：

```ts
export function ping(): string {
  return 'pong';
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test`
Expected: PASS（1 passed）。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore vitest.config.ts packages/config .github
git commit -m "chore: scaffold pnpm workspace, vitest, and CI baseline"
```

---

## M1 — 配置包系统（packages/config）

### Task 1: Profile 类型 + zod schema

**Files:**
- Create: `packages/config/src/types.ts`、`packages/config/src/schema.ts`
- Test: `packages/config/test/schema.test.ts`

**Interfaces:**
- Consumes: `ping()`（Task 0，仅证明包可运行）。
- Produces（后续任务与其它包都引用）：
  - `type ProfileManifest`
  - `type ResolvedProfile = { manifest: ProfileManifest; agent: AgentConfig; ui: UiConfig; security: SecurityConfig; }`
  - `type AgentConfig = { skills: SkillRef[]; tools: string[]; prompts: Record<string,string>; workflow: WorkflowDefLoose; knowledge: Array<{ id: string; text: string }>; }`
  - `type UiConfig = { pages: Record<string, PageSchema>; theme: ThemeRef; }`
  - `type SecurityConfig = { roles: RoleConfig[]; approval: ApprovalPolicy; }`
  - `parseProfileManifest(raw: unknown): ProfileManifest`（校验 manifest.yaml）

`packages/config/src/types.ts`：

```ts
export interface ProfileManifest {
  name: string;
  version: string;
  extends?: string;
  modelRouting: {
    tasks: Record<string, Array<{ provider: string; modelId: string }>>;
  };
  integrity?: { sha256: string };
}

export interface SkillRef { name: string; file: string; params?: Record<string, unknown>; }
export type PageSchema = Record<string, unknown>;
export interface ThemeRef { file: string; }

export interface RoleConfig { name: string; pages: string[]; tools: string[]; canApprove: Array<'write' | 'high-risk'>; }
export interface ApprovalPolicy {
  autoApprove?: string[];
  requireApproval: string[];
  timeoutMs: number;
  highRiskDoubleConfirm: boolean;
}

export interface AgentConfig {
  skills: SkillRef[];
  tools: string[];
  prompts: Record<string, string>;
  workflow: Record<string, unknown>;
  knowledge: Array<{ id: string; text: string }>;
}
export interface UiConfig { pages: Record<string, PageSchema>; theme: ThemeRef; }
export interface SecurityConfig { roles: RoleConfig[]; approval: ApprovalPolicy; }
export interface ResolvedProfile {
  manifest: ProfileManifest;
  agent: AgentConfig;
  ui: UiConfig;
  security: SecurityConfig;
}
```

`packages/config/src/schema.ts`：

```ts
import { z } from 'zod';
import type { ProfileManifest } from './types.js';

const modelTarget = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  extends: z.string().optional(),
  modelRouting: z.object({
    tasks: z.record(z.array(modelTarget)),
  }),
  integrity: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});

export function parseProfileManifest(raw: unknown): ProfileManifest {
  return manifestSchema.parse(raw);
}
```

Update `packages/config/package.json`：加入 `"dependencies": { "zod": "^3.24.0" }`。

- [ ] **Step 1: 写失败测试**

`packages/config/test/schema.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseProfileManifest } from '../src/schema.js';

describe('parseProfileManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = parseProfileManifest({
      name: 'contract-review',
      version: '1.0.0',
      modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
    });
    expect(m.name).toBe('contract-review');
  });
  it('rejects missing modelRouting', () => {
    expect(() => parseProfileManifest({ name: 'x', version: '1.0.0' })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**
Expected: FAIL（`parseProfileManifest is not a function`）。

- [ ] **Step 3: 实现**（写入上述 `types.ts` 与 `schema.ts`）

- [ ] **Step 4: 运行确认通过**
Run: `pnpm --filter @sparkii/config test`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/config
git commit -m "feat(config): add profile manifest types and zod schema"
```

### Task 2: 完整性哈希 + Ed25519 验签

**Files:**
- Create: `packages/config/src/integrity.ts`
- Test: `packages/config/test/integrity.test.ts`

**Interfaces:**
- Consumes: `ProfileManifest`（Task 1）。
- Produces:
  - `computeIntegrity(files: Record<string, Buffer>): string`（sha256，先按路径排序再拼接 `path\0sha256(path内容)\n`）
  - `signFiles(files: Record<string, Buffer>, privateKey: string): { signature: string; integrity: string }`
  - `verifyFiles(files: Record<string, Buffer>, publicKey: string, signature: string): boolean`
  - `generateKeyPair(): Promise<{ publicKey: string; privateKey: string }>`（PEM，Ed25519）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { computeIntegrity, signFiles, verifyFiles, generateKeyPair } from '../src/integrity.js';

describe('profile integrity', () => {
  it('detects a tampered file', async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const files = { 'manifest.yaml': Buffer.from('v:1'), 'agent/skills.yaml': Buffer.from('a:1') };
    const { signature } = signFiles(files, privateKey);
    const tampered = { ...files, 'agent/skills.yaml': Buffer.from('a:2') };
    expect(verifyFiles(files, publicKey, signature)).toBe(true);
    expect(verifyFiles(tampered, publicKey, signature)).toBe(false);
  });
  it('is order independent', () => {
    const a = { 'b.yaml': Buffer.from('1'), 'a.yaml': Buffer.from('2') };
    const b = { 'a.yaml': Buffer.from('2'), 'b.yaml': Buffer.from('1') };
    expect(computeIntegrity(a)).toBe(computeIntegrity(b));
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

export function computeIntegrity(files: Record<string, Buffer>): string {
  const h = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    h.update(path).update('\0');
    h.update(createHash('sha256').update(files[path]).digest('hex')).update('\n');
  }
  return h.digest('hex');
}

export function signFiles(files: Record<string, Buffer>, privateKey: string): { signature: string; integrity: string } {
  const integrity = computeIntegrity(files);
  const signature = sign(null, Buffer.from(integrity, 'utf8'), privateKey).toString('base64');
  return { signature, integrity };
}

export function verifyFiles(files: Record<string, Buffer>, publicKey: string, signature: string): boolean {
  const integrity = computeIntegrity(files);
  try {
    return verify(null, Buffer.from(integrity, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { publicKey, privateKey };
}
```

（`generateKeyPairSync` 是同步函数，直接调用并返回 PEM 即可；不要用 `promisify` 包它。）

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/config/src/integrity.ts packages/config/test/integrity.test.ts
git commit -m "feat(config): add profile integrity hash and Ed25519 signature"
```

### Task 3: 加载器（目录读取 + YAML/JSON + 校验 + 失败关闭）

**Files:**
- Create: `packages/config/src/loader.ts`
- Test: `packages/config/test/loader.test.ts`

**Interfaces:**
- Consumes: `parseProfileManifest`、`computeIntegrity`、`verifyFiles`。
- Produces:
  - `loadProfile(dir: string, opts: { publicKey?: string; allowUnsigned?: boolean }): Promise<ResolvedProfile>`
  - 失败关闭：非法 manifest / 校验失败 / 验签失败时抛出带 `code` 的错误，绝不返回半成品。
  - 加载顺序：读 `manifest.yaml` → 可选 `extends` 叠加 → 读 `agent/*`、`ui/*`、`security/*` → 若 `opts.publicKey` 提供则验签。

- [ ] **Step 1: 写失败测试**（用 `node:fs` 在 `test/.tmp` 写临时 profile）

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

describe('loadProfile', () => {
  it('loads a valid profile', async () => {
    const dir = writeProfile({
      'manifest.yaml': 'name: contract-review\nversion: 1.0.0\nmodelRouting:\n  tasks:\n    default:\n      - { provider: local, modelId: qwen2.5:7b }\n',
      'agent/skills.yaml': '- { name: clause_extract, file: prompts/clause_extract.md }\n',
      'agent/tools.yaml': 'tools: [document.read, report.export]\n',
      'agent/prompts/clause_extract.md': '# extract clauses\n',
      'agent/knowledge/corpus.json': '[]',
      'agent/workflow.yaml': 'version: 1\nengine: linear\nsteps: []\n',
      'ui/pages/home.json': '{}',
      'ui/theme.yaml': 'file: theme/tokens.json\n',
      'ui/theme/tokens.json': '{}',
      'security/roles.yaml': 'roles: []\n',
      'security/approval.yaml': 'requireApproval: [report.export]\ntimeoutMs: 60000\nhighRiskDoubleConfirm: true\n',
    });
    const p = await loadProfile(dir, { allowUnsigned: true });
    expect(p.manifest.name).toBe('contract-review');
    expect(p.agent.tools).toEqual(['document.read', 'report.export']);
  });

  it('fails closed on invalid manifest', async () => {
    const dir = writeProfile({ 'manifest.yaml': 'name: x\n' });
    await expect(loadProfile(dir)).rejects.toMatchObject({ code: 'PROFILE_INVALID' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**（用 `yaml` 解析；错误统一包成 `ProfileError`）

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseProfileManifest } from './schema.js';
import { computeIntegrity } from './integrity.js';
import type { ResolvedProfile } from './types.js';

export class ProfileError extends Error {
  constructor(public code: 'PROFILE_INVALID' | 'SIGNATURE_INVALID' | 'PROFILE_NOT_FOUND', message: string) {
    super(message);
  }
}

const read = async (dir: string, rel: string) => readFile(join(dir, rel), 'utf8').catch(() => {
  throw new ProfileError('PROFILE_INVALID', `missing file: ${rel}`);
});

export async function loadProfile(
  dir: string,
  opts: { publicKey?: string; allowUnsigned?: boolean } = {},
): Promise<ResolvedProfile> {
  const manifestRaw = await read(dir, 'manifest.yaml');
  let manifest;
  try { manifest = parseProfileManifest(parseYaml(manifestRaw)); }
  catch (e) { throw new ProfileError('PROFILE_INVALID', `manifest invalid: ${(e as Error).message}`); }

  const files: Record<string, Buffer> = { 'manifest.yaml': Buffer.from(manifestRaw) };
  const skillsRaw = await read(dir, 'agent/skills.yaml');
  const toolsRaw = await read(dir, 'agent/tools.yaml');
  const workflowRaw = await read(dir, 'agent/workflow.yaml');
  const pagesRaw = await read(dir, 'ui/pages/home.json');
  const themeRaw = await read(dir, 'ui/theme.yaml');
  const rolesRaw = await read(dir, 'security/roles.yaml');
  const approvalRaw = await read(dir, 'security/approval.yaml');
  Object.assign(files, {
    'agent/skills.yaml': Buffer.from(skillsRaw), 'agent/tools.yaml': Buffer.from(toolsRaw),
    'agent/workflow.yaml': Buffer.from(workflowRaw), 'ui/pages/home.json': Buffer.from(pagesRaw),
    'ui/theme.yaml': Buffer.from(themeRaw), 'security/roles.yaml': Buffer.from(rolesRaw),
    'security/approval.yaml': Buffer.from(approvalRaw),
  });

  const skills = parseYaml(skillsRaw) as Array<{ name: string; file: string; params?: Record<string, unknown> }>;
  const prompts: Record<string, string> = {};
  for (const s of skills) {
    prompts[s.name] = await read(dir, `agent/${s.file}`);
    files[`agent/${s.file}`] = Buffer.from(prompts[s.name]);
  }

  const toolsCfg = parseYaml(toolsRaw) as { tools: string[] };
  const themeCfg = parseYaml(themeRaw) as { file: string };
  const tokens = await read(dir, `ui/${themeCfg.file}`);
  files[`ui/${themeCfg.file}`] = Buffer.from(tokens);
  const corpusRaw = await read(dir, 'agent/knowledge/corpus.json');
  files['agent/knowledge/corpus.json'] = Buffer.from(corpusRaw);
  const knowledge = JSON.parse(corpusRaw) as Array<{ id: string; text: string }>;

  if (opts.publicKey) {
    const { verifyFiles } = await import('./integrity.js');
    const sig = await read(dir, 'manifest.sig');
    if (!verifyFiles(files, opts.publicKey, sig.trim())) {
      throw new ProfileError('SIGNATURE_INVALID', 'profile signature mismatch');
    }
  } else if (!opts.allowUnsigned) {
    throw new ProfileError('SIGNATURE_INVALID', 'unsigned profile and publicKey not provided');
  }

  return {
    manifest,
    agent: { skills, tools: toolsCfg.tools, prompts, workflow: parseYaml(workflowRaw) as Record<string, unknown>, knowledge },
    ui: { pages: { home: JSON.parse(pagesRaw) }, theme: themeCfg },
    security: { roles: parseYaml(rolesRaw)?.roles ?? [], approval: parseYaml(approvalRaw) },
  };
}
```

Update `packages/config/package.json`：`"dependencies": { "yaml": "^2.5.0" }`。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/config
git commit -m "feat(config): load and validate profile directory fail-closed"
```

### Task 4: 继承（extends）+ 管理员 delta 叠加

**Files:**
- Create: `packages/config/src/compose.ts`
- Test: `packages/config/test/compose.test.ts`

**Interfaces:**
- Consumes: `ResolvedProfile`、`ProfileManifest`。
- Produces:
  - `applyDelta(base: ResolvedProfile, delta: Partial<ResolvedProfile>): ResolvedProfile`（浅合并对象，数组整体替换，`null` 字段表示删除）
  - `resolveInheritance(base: ResolvedProfile, child: ResolvedProfile): ResolvedProfile`（child.manifest.extends 已由 loader 解析为已加载的 base；本函数负责合并，child 优先）
  - 规则：`manifest.version/name/integrity` 取 child；`agent.tools` 取 child 数组整体；`security.approval` 深合并；`ui.pages` 键级合并。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { applyDelta, resolveInheritance } from '../src/compose.js';
import type { ResolvedProfile } from '../src/types.js';

const base = (): ResolvedProfile => ({
  manifest: { name: 'base', version: '1.0.0', modelRouting: { tasks: {} } },
  agent: { skills: [], tools: ['document.read'], prompts: {}, workflow: {}, knowledge: [] },
  ui: { pages: { home: { a: 1 } }, theme: { file: 'theme/tokens.json' } },
  security: { roles: [], approval: { requireApproval: ['report.export'], timeoutMs: 60000, highRiskDoubleConfirm: true } },
});

describe('profile composition', () => {
  it('delta overrides tools and deep-merges approval', () => {
    const out = applyDelta(base(), {
      agent: { tools: ['document.read', 'report.export'] },
      security: { approval: { timeoutMs: 120000 } },
    } as any);
    expect(out.agent.tools).toEqual(['document.read', 'report.export']);
    expect(out.security.approval.timeoutMs).toBe(120000);
    expect(out.security.approval.requireApproval).toEqual(['report.export']);
  });

  it('child inherits and overrides locally', () => {
    const child = base();
    child.manifest = { ...child.manifest, name: 'customerA', extends: 'base' };
    child.ui.pages = { home: { a: 2, b: 3 } };
    const out = resolveInheritance(base(), child);
    expect(out.ui.pages).toEqual({ home: { a: 2, b: 3 } });
    expect(out.manifest.name).toBe('customerA');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { ResolvedProfile } from './types.js';

function merge<T>(a: T, b: Partial<T>): T {
  return { ...a, ...b };
}

export function applyDelta(base: ResolvedProfile, delta: Partial<ResolvedProfile>): ResolvedProfile {
  return {
    manifest: merge(base.manifest, delta.manifest),
    agent: merge(base.agent, delta.agent),
    ui: {
      pages: merge(base.ui.pages, delta.ui?.pages),
      theme: merge(base.ui.theme, delta.ui?.theme),
    },
    security: {
      roles: delta.security?.roles ?? base.security.roles,
      approval: merge(base.security.approval, delta.security?.approval),
    },
  };
}

export function resolveInheritance(base: ResolvedProfile, child: ResolvedProfile): ResolvedProfile {
  return applyDelta(base, child);
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/config
git commit -m "feat(config): support profile inheritance and admin delta overlay"
```

### Task 4a: config 包公共 API 再导出（index.ts）

**Files:**
- Modify: `packages/config/src/index.ts`

**Interfaces:**
- Produces: `@sparkii/config` 的入口导出：`ping`、`parseProfileManifest`、`loadProfile`、`ProfileError`、`applyDelta`、`resolveInheritance`，以及全部类型（`ProfileManifest`、`ResolvedProfile`、`RoleConfig`、`ApprovalPolicy` 等）。后续 identity / approval / model-router / runtime 都从这里 import。

- [ ] **Step 1: 实现**

`packages/config/src/index.ts`：

```ts
export * from './types.js';
export * from './schema.js';
export * from './integrity.js';
export * from './loader.js';
export * from './compose.js';

export function ping(): string {
  return 'pong';
}
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @sparkii/config test`
Expected: PASS（原 9 个测试仍通过）。

- [ ] **Step 3: 提交**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): re-export public config API"
```

---

## M2 — 模型路由（packages/model-router）

### Task 5: 模型路由 + 降级

**Files:**
- Create: `packages/model-router/src/types.ts`、`packages/model-router/src/router.ts`、`packages/model-router/package.json`
- Test: `packages/model-router/test/router.test.ts`

**Interfaces:**
- Consumes: `ProfileManifest.modelRouting`（来自 config 类型）。
- Produces:
  - `type ModelTask`（见词汇表）
  - `class ModelRouter { constructor(routing: Record<ModelTask, ModelTarget[]>); resolve(task: ModelTask, available?: (t: ModelTarget) => boolean): ModelTarget | null; }`
  - `normalizeRouting(raw: Record<string, Array<{provider:string;modelId:string}>>): Record<ModelTask, ModelTarget[]>`（补 `default` 回退：任何任务缺失时用 `default`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { ModelRouter, normalizeRouting } from '../src/router.js';

describe('ModelRouter', () => {
  const routing = normalizeRouting({
    default: [{ provider: 'local', modelId: 'qwen2.5:7b' }],
    report: [
      { provider: 'cloud', modelId: 'gpt-5-mini' },
      { provider: 'local', modelId: 'qwen2.5:14b' },
    ],
  });

  it('falls back to default when task has no entry', () => {
    expect(new ModelRouter(routing).resolve('extract')).toEqual({ provider: 'local', modelId: 'qwen2.5:7b' });
  });

  it('degrades to the next target when the first is unavailable', () => {
    const router = new ModelRouter(routing);
    expect(router.resolve('report', (t) => t.provider !== 'cloud')).toEqual({ provider: 'local', modelId: 'qwen2.5:14b' });
  });

  it('returns null when all targets unavailable', () => {
    expect(new ModelRouter(routing).resolve('report', () => false)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`types.ts`：

```ts
export type ModelTask = 'chat' | 'extract' | 'report' | 'default';
export interface ModelTarget { provider: string; modelId: string; }
```

`router.ts`：

```ts
import type { ModelTask, ModelTarget } from './types.js';

export function normalizeRouting(raw: Record<string, ModelTarget[]>): Record<ModelTask, ModelTarget[]> {
  const out = { default: raw.default ?? [], chat: [], extract: [], report: [] } as Record<ModelTask, ModelTarget[]>;
  for (const key of ['chat', 'extract', 'report'] as const) {
    out[key] = raw[key] ?? out.default;
  }
  return out;
}

export class ModelRouter {
  constructor(private routing: Record<ModelTask, ModelTarget[]>) {}
  resolve(task: ModelTask, available: (t: ModelTarget) => boolean = () => true): ModelTarget | null {
    const chain = this.routing[task] ?? this.routing.default;
    return chain.find(available) ?? null;
  }
}
```

`package.json`：

```json
{
  "name": "@sparkii/model-router",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

Create `packages/model-router/src/index.ts`：`export * from './types.js'; export * from './router.js';`

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/model-router
git commit -m "feat(model-router): task-based routing with fallback"
```

---

## M3 — 连接器纯逻辑（packages/connectors）

### Task 6: 连接器接口 + 文档解析

**Files:**
- Create: `packages/connectors/src/types.ts`、`packages/connectors/src/document/index.ts`、`packages/connectors/src/index.ts`、`packages/connectors/package.json`
- Test: `packages/connectors/test/document.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type SideEffect`、`type ToolContext`、`type ToolResult`、`type ToolHandler`、`type ToolDef`、`type Connector`（见词汇表）
  - `interface ParsedDocument { text: string; kind: 'pdf' | 'docx' | 'xlsx' | 'text'; meta: { fileName: string; pageCount?: number; } }`
  - `parseDocument(path: string): Promise<ParsedDocument>`（按扩展名分派 pdf/docx/xlsx/txt）
  - 常量 `documentConnector: Connector`（注册 `document.read` 工具，`sideEffect: 'read'`）

- [ ] **Step 1: 写失败测试**（用最小真实字节，docx/xlsx 用 zip 结构）

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/document/index.js';

describe('parseDocument', () => {
  it('parses plain text by extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello contract');
    expect((await parseDocument(p)).text).toContain('hello contract');
  });
  it('rejects unknown extension with typed error', async () => {
    await expect(parseDocument(join(tmpdir(), 'x.unknownext'))).rejects.toMatchObject({ code: 'CONNECTOR_UNSUPPORTED' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`types.ts`（全量，作为连接器层唯一类型源）：

```ts
export type SideEffect = 'read' | 'write' | 'high-risk';
export type JSONSchema = Record<string, unknown>;
export interface ToolContext { profileId: string; sessionId: string; actor: string; requestId: string; }
export interface ToolResult { ok: boolean; data?: unknown; error?: { code: string; message: string }; }
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
export interface ToolDef { name: string; description: string; params: JSONSchema; sideEffect: SideEffect; handler: ToolHandler; }
export interface Connector { id: string; tools: ToolDef[]; init(cfg: unknown): Promise<void>; }
export class ConnectorError extends Error {
  constructor(public code: 'CONNECTOR_UNSUPPORTED' | 'CONNECTOR_IO' | 'CONNECTOR_DENIED', message: string) {
    super(message);
  }
}
```

`document/index.ts`：

```ts
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ConnectorError, type Connector, type ToolHandler } from '../types.js';

export interface ParsedDocument {
  text: string;
  kind: 'pdf' | 'docx' | 'xlsx' | 'text';
  meta: { fileName: string; pageCount?: number };
}

export async function parseDocument(path: string): Promise<ParsedDocument> {
  const ext = extname(path).toLowerCase();
  if (!['.txt', '.md', '.csv', '.pdf', '.docx', '.xlsx'].includes(ext)) {
    throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
  }
  const buf = await readFile(path).catch((e) => {
    throw new ConnectorError('CONNECTOR_IO', `cannot read ${path}: ${(e as Error).message}`);
  });
  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    return { text: buf.toString('utf8'), kind: 'text', meta: { fileName: path } };
  }
  if (ext === '.pdf') return parsePdf(path, buf);
  if (ext === '.docx') return parseDocx(path, buf);
  if (ext === '.xlsx') return parseXlsx(path, buf);
  throw new ConnectorError('CONNECTOR_UNSUPPORTED', `unsupported extension: ${ext}`);
}

async function parsePdf(path: string, buf: Buffer): Promise<ParsedDocument> {
  // 用 pdfjs-dist 提取文本；这里是确定的实现骨架
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it: any) => it.str).join(' '));
  }
  return { text: pages.join('\n'), kind: 'pdf', meta: { fileName: path, pageCount: doc.numPages } };
}

async function parseDocx(path: string, buf: Buffer): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return { text: value, kind: 'docx', meta: { fileName: path } };
}

async function parseXlsx(path: string, buf: Buffer): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const text = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  return { text, kind: 'xlsx', meta: { fileName: path } };
}

const handler: ToolHandler = async (args) => {
  try {
    const docs = args.documents as string[] | undefined;
    if (!docs || docs.length === 0) return { ok: false, error: { code: 'CONNECTOR_IO', message: 'no document provided' } };
    const doc = await parseDocument(docs[0]);
    return { ok: true, data: doc };
  } catch (e) {
    const err = e as ConnectorError;
    return { ok: false, error: { code: err.code ?? 'CONNECTOR_IO', message: err.message } };
  }
};

export const documentConnector: Connector = {
  id: 'document',
  tools: [{
    name: 'document.read',
    description: '读取并解析本地文档（PDF/Word/Excel/文本）为纯文本。',
    params: { type: 'object', properties: { documents: { type: 'array', items: { type: 'string' } } }, required: ['documents'] },
    sideEffect: 'read',
    handler,
  }],
  async init() {},
};
```

`index.ts`：`export * from './types.js'; export * from './document/index.js';`

`package.json`：`dependencies` 含 `pdfjs-dist`、`mammoth`、`xlsx`。

- [ ] **Step 4: 运行确认通过**（本任务测试只覆盖 txt 与未知扩展名，PDF/docx/xlsx 用真实样例在 Task 8 的集成用例覆盖）

- [ ] **Step 5: 提交**

```bash
git add packages/connectors
git commit -m "feat(connectors): connector interface and document parser"
```

### Task 7: 法规知识库检索（BM25）

**Files:**
- Create: `packages/connectors/src/knowledge/index.ts`
- Test: `packages/connectors/test/knowledge.test.ts`

**Interfaces:**
- Consumes: `ToolResult`、`ToolHandler`、`Connector`（Task 6）。
- Produces:
  - `interface KnowledgeChunk { id: string; text: string; score: number }`
  - `class Bm25Index { constructor(corpus: Array<{ id: string; text: string }>); search(query: string, topK: number): KnowledgeChunk[] }`
  - `buildIndexFromLines(lines: string[]): Bm25Index`
  - 常量 `knowledgeConnector: Connector`（注册 `knowledge.search`，`sideEffect: 'read'`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { Bm25Index } from '../src/knowledge/index.js';

describe('Bm25Index', () => {
  const idx = new Bm25Index([
    { id: '1', text: '逾期付款违约金按日万分之五计算' },
    { id: '2', text: '设备检修周期为每季度一次' },
  ]);
  it('ranks relevant clause first', () => {
    const hits = idx.search('违约金 逾期', 2);
    expect(hits[0].id).toBe('1');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { Connector, ToolHandler } from '../types.js';

export interface KnowledgeChunk { id: string; text: string; score: number }

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export class Bm25Index {
  private tf: Map<string, Map<string, number>> = new Map();
  private len = new Map<string, number>();
  private df = new Map<string, number>();
  private avg = 0;
  private docs: Array<{ id: string; text: string }> = [];

  constructor(corpus: Array<{ id: string; text: string }>, private k1 = 1.2, private b = 0.75) {
    this.docs = corpus;
    for (const doc of corpus) {
      const toks = tokenize(doc.text);
      this.len.set(doc.id, toks.length);
      const seen = new Set<string>();
      const counts = new Map<string, number>();
      for (const t of toks) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
        seen.add(t);
      }
      this.tf.set(doc.id, counts);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = corpus.length ? corpus.reduce((s, d) => s + (this.len.get(d.id) ?? 0), 0) / corpus.length : 0;
  }

  search(query: string, topK: number): KnowledgeChunk[] {
    const q = tokenize(query);
    const n = this.docs.length;
    return this.docs.map((doc) => {
      const toks = tokenize(doc.text);
      const score = q.reduce((sum, t) => {
        const f = this.tf.get(doc.id)?.get(t) ?? 0;
        if (f === 0) return sum;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        const dl = this.len.get(doc.id) ?? 0;
        return sum + idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (dl / (this.avg || 1)))));
      }, 0);
      return { id: doc.id, text: toks.join(' '), score };
    }).sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

export function buildIndexFromLines(lines: string[]): Bm25Index {
  return new Bm25Index(lines.map((text, i) => ({ id: `chunk-${i}`, text })));
}

let index: Bm25Index | null = null;

const handler: ToolHandler = async (args) => {
  if (!index) return { ok: false, error: { code: 'CONNECTOR_NOT_INIT', message: 'knowledge corpus not loaded' } };
  return { ok: true, data: index.search(String(args.query), Number(args.topK ?? 5)) };
};

export const knowledgeConnector: Connector = {
  id: 'knowledge',
  tools: [{
    name: 'knowledge.search',
    description: '在法规知识库中检索与查询最相关的条款片段。',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number' },
      },
      required: ['query'],
    },
    sideEffect: 'read',
    handler,
  }],
  async init(cfg: unknown) {
    const corpus = (cfg as { corpus?: Array<{ id: string; text: string }> } | undefined)?.corpus ?? [];
    index = new Bm25Index(corpus);
  },
};
```

Update `packages/connectors/src/index.ts`：追加 `export * from './knowledge/index.js';`

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/connectors
git commit -m "feat(connectors): BM25 regulatory knowledge retriever"
```

### Task 8: 报告导出（docx 写原语，纯函数）

**Files:**
- Create: `packages/connectors/src/report/index.ts`
- Test: `packages/connectors/test/report.test.ts`

**Interfaces:**
- Consumes: `ToolResult`、`Connector`（Task 6）。
- Produces:
  - `interface ReportInput { title: string; sections: Array<{ heading: string; body: string }>; format: 'docx' }`
  - `buildReportDocx(input: ReportInput): Promise<Buffer>`（返回 docx 字节，**不落盘**）
  - 常量 `reportConnector: Connector`（注册 `report.export`，`sideEffect: 'write'`；其 handler 是 Main 侧确定性执行器实际调用的实现，把 docx 字节写到冻结的 `args.path`）

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildReportDocx, reportConnector } from '../src/report/index.js';

describe('report', () => {
  it('returns a valid zip/docx byte buffer', async () => {
    const buf = await buildReportDocx({ title: '风险报告', sections: [{ heading: '结论', body: '通过' }], format: 'docx' });
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
  it('write handler saves to the frozen path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'));
    const out = join(dir, 'out.docx');
    const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
    const r = await tool.handler({ title: 'x', sections: [{ heading: 'h', body: 'b' }], format: 'docx', path: out }, { profileId: 'p', sessionId: 's', actor: 'u', requestId: 'r' });
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { writeFile } from 'node:fs/promises';
import type { Connector, ToolHandler } from '../types.js';

export interface ReportInput { title: string; sections: Array<{ heading: string; body: string }>; format: 'docx' }

export async function buildReportDocx(input: ReportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
        ...input.sections.flatMap((s) => [
          new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: s.body }),
        ]),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

const handler: ToolHandler = async (args) => {
  try {
    const buf = await buildReportDocx(args as unknown as ReportInput);
    const outPath = String((args as { path?: string }).path);
    await writeFile(outPath, buf);
    return { ok: true, data: { path: outPath, size: buf.length } };
  } catch (e) {
    return { ok: false, error: { code: 'CONNECTOR_IO', message: (e as Error).message } };
  }
};

export const reportConnector: Connector = {
  id: 'report',
  tools: [{
    name: 'report.export',
    description: '把审核结论导出为 Word 文档（写操作，需审批）。',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } } } },
        format: { type: 'string', enum: ['docx'] },
        path: { type: 'string' },
      },
      required: ['title', 'sections', 'format', 'path'],
    },
    sideEffect: 'write',
    handler,
  }],
  async init() {},
};
```

Update `packages/connectors/src/index.ts`：追加 `export * from './report/index.js';`
Update `packages/connectors/package.json`：`dependencies` 加 `docx`。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/connectors
git commit -m "feat(connectors): deterministic docx report builder as write primitive"
```

---

## M4 — 本地账号 + RBAC（packages/identity）

### Task 9: 本地账号存储 + 口令散列

**Files:**
- Create: `packages/identity/src/types.ts`、`packages/identity/src/local.ts`、`packages/identity/package.json`
- Test: `packages/identity/test/local.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface Subject { userId: string; roles: string[] }`
  - `interface IdentityProvider { authenticate(username, password): Promise<Subject>; listUsers(): Promise<Array<{id;username;roles}>> }`
  - `class LocalIdentityProvider implements IdentityProvider`（构造参数 `file: string`，`seed(user)` 创建账号）
  - 口令散列用 `node:crypto` `scrypt`（格式 `scrypt$N$r$p$salt$hash`），原子写 JSON。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LocalIdentityProvider } from '../src/local.js';

describe('LocalIdentityProvider', () => {
  it('authenticates a seeded user', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'id-')), 'users.json');
    const p = new LocalIdentityProvider(file);
    await p.seed({ id: 'u1', username: 'admin', password: 'pw123', roles: ['admin'] });
    const subj = await p.authenticate('admin', 'pw123');
    expect(subj.userId).toBe('u1');
    expect(subj.roles).toContain('admin');
  });
  it('rejects wrong password', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'id-')), 'users.json');
    const p = new LocalIdentityProvider(file);
    await p.seed({ id: 'u1', username: 'admin', password: 'pw123', roles: ['admin'] });
    await expect(p.authenticate('admin', 'bad')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`types.ts`：

```ts
export interface Subject { userId: string; roles: string[]; }
export interface UserRecord { id: string; username: string; passwordHash: string; roles: string[]; }
export interface IdentityProvider {
  authenticate(username: string, password: string): Promise<Subject>;
  listUsers(): Promise<Array<{ id: string; username: string; roles: string[] }>>;
}
export class AuthError extends Error {
  constructor(public code: 'AUTH_FAILED' | 'USER_NOT_FOUND', message: string) { super(message); }
}
```

`local.ts`：

```ts
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AuthError, type IdentityProvider, type Subject, type UserRecord } from './types.js';

const N = 16384, r = 8, p = 1;

function hash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, 64, { N, r, p }, (e, k) => (e ? rej(e) : res(k))));
}

export class LocalIdentityProvider implements IdentityProvider {
  private users = new Map<string, UserRecord>();
  constructor(private file: string) {}

  async seed(u: { id: string; username: string; password: string; roles: string[] }): Promise<void> {
    const salt = randomBytes(16);
    const key = await hash(u.password, salt);
    this.users.set(u.id, {
      id: u.id, username: u.username,
      passwordHash: `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`,
      roles: u.roles,
    });
    await this.persist();
  }

  async authenticate(username: string, password: string): Promise<Subject> {
    await this.load();
    const u = [...this.users.values()].find((x) => x.username === username);
    if (!u) throw new AuthError('USER_NOT_FOUND', 'no such user');
    const [, n, rr, pp, saltHex, hashHex] = u.passwordHash.split('$');
    const key = await hash(password, Buffer.from(saltHex, 'hex'));
    const expected = Buffer.from(hashHex, 'hex');
    if (key.length !== expected.length || !timingSafeEqual(key, expected)) throw new AuthError('AUTH_FAILED', 'bad password');
    return { userId: u.id, roles: u.roles };
  }

  async listUsers() { await this.load(); return [...this.users.values()].map(({ id, username, roles }) => ({ id, username, roles })); }

  private async load() {
    const raw = await readFile(this.file, 'utf8').catch(() => '[]');
    this.users = new Map((JSON.parse(raw) as UserRecord[]).map((u) => [u.id, u]));
  }
  private async persist() {
    const tmp = join(dirname(this.file), `.${this.file.split('/').pop()}.tmp`);
    await writeFile(tmp, JSON.stringify([...this.users.values()], null, 2));
    await rename(tmp, this.file);
  }
}
```

`package.json`（name `@sparkii/identity`）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/identity
git commit -m "feat(identity): local account store with scrypt password hashing"
```

### Task 10: RBAC 策略判定

**Files:**
- Create: `packages/identity/src/rbac.ts`
- Test: `packages/identity/test/rbac.test.ts`

**Interfaces:**
- Consumes: `Subject`、`RoleConfig`（config 类型，本包通过 `import type` 引用）。
- Produces:
  - `class Rbac { constructor(roles: RoleConfig[]); can(subject, permission: string): boolean; canApprove(subject, risk: 'write'|'high-risk'): boolean; visiblePages(subject): string[]; allowedTools(subject): string[] }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { Rbac } from '../src/rbac.js';

describe('Rbac', () => {
  const rbac = new Rbac([
    { name: 'reviewer', pages: ['home'], tools: ['document.read'], canApprove: ['write'] },
    { name: 'admin', pages: ['home', 'audit'], tools: ['document.read', 'report.export'], canApprove: ['write', 'high-risk'] },
  ]);
  it('grants only listed tools and pages', () => {
    const s = { userId: 'u1', roles: ['reviewer'] };
    expect(rbac.can(s, 'report.export')).toBe(false);
    expect(rbac.allowedTools(s)).toEqual(['document.read']);
    expect(rbac.visiblePages(s)).toEqual(['home']);
  });
  it('approval follows the union of roles', () => {
    expect(rbac.canApprove({ userId: 'u1', roles: ['reviewer'] }, 'write')).toBe(true);
    expect(rbac.canApprove({ userId: 'u1', roles: ['reviewer'] }, 'high-risk')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { RoleConfig } from '@sparkii/config';
import type { Subject } from './types.js';

export class Rbac {
  constructor(private roles: RoleConfig[]) {}
  private rolesOf(s: Subject) { return this.roles.filter((r) => s.roles.includes(r.name)); }
  can(s: Subject, permission: string): boolean {
    return this.rolesOf(s).some((r) => r.tools.includes(permission) || r.pages.includes(permission));
  }
  canApprove(s: Subject, risk: 'write' | 'high-risk'): boolean {
    return this.rolesOf(s).some((r) => r.canApprove.includes(risk));
  }
  visiblePages(s: Subject): string[] {
    return [...new Set(this.rolesOf(s).flatMap((r) => r.pages))];
  }
  allowedTools(s: Subject): string[] {
    return [...new Set(this.rolesOf(s).flatMap((r) => r.tools))];
  }
}
```

`packages/identity/package.json` 加 `"dependencies": { "@sparkii/config": "workspace:*" }`；`tsconfig.json` 用 `"moduleResolution":"Bundler"` 解析 workspace 类型。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/identity
git commit -m "feat(identity): RBAC policy evaluation for pages, tools, and approval"
```

---

## M5 — 审批门 + 审计 + 确定性执行器（packages/approval）

### Task 11: Proposal 状态机 + 载荷摘要/哈希

**Files:**
- Create: `packages/approval/src/types.ts`、`packages/approval/src/proposal.ts`、`packages/approval/package.json`
- Test: `packages/approval/test/proposal.test.ts`

**Interfaces:**
- Consumes: `SideEffect`（connectors）。
- Produces:
  - 词汇表中的 `ProposalRequest`、`Proposal`、`ProposalStatus`
  - `canonicalJson(value: unknown): string`（键排序、稳定序列化）
  - `hashPayload(value: unknown): string`（sha256 of canonicalJson）
  - `summarizePayload(value: unknown, maxLen = 512): string`
  - `createProposal(req: ProposalRequest, meta: { profileId; sessionId }): Proposal`（生成 `id = randomUUID()`、`status='pending'`、`payloadHash`、`summary`）
  - `transition(p: Proposal, to: Exclude<ProposalStatus,'pending'>): Proposal`（仅允许合法迁移：pending→approved/denied/expired，approved→executed/failed）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { createProposal, transition, canonicalJson, hashPayload } from '../src/proposal.js';

describe('proposal', () => {
  it('freezes payload hash at creation', () => {
    const p = createProposal({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: { title: 'r' }, risk: 'write' }, { profileId: 'p1', sessionId: 's1' });
    expect(p.status).toBe('pending');
    expect(p.payloadHash).toBe(hashPayload({ title: 'r' }));
  });
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it('rejects illegal transition denied→executed', () => {
    const p = transition(createProposal({ toolName: 't', targetSystem: 's', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'denied');
    expect(() => transition(p, 'executed')).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { createHash, randomUUID } from 'node:crypto';
import type { SideEffect } from '@sparkii/connectors';

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
export interface ProposalRequest { toolName: string; targetSystem: string; summary: string; payload: unknown; risk: SideEffect; }
export interface Proposal {
  id: string; profileId: string; sessionId: string;
  toolName: string; targetSystem: string; summary: string;
  payloadHash: string; payload: unknown; risk: SideEffect;
  status: ProposalStatus; createdAt: number;
  decidedAt?: number; decisionBy?: string; decisionNote?: string;
  execution?: { ok: boolean; result?: unknown; error?: string };
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sort(val)]));
    return v;
  };
  return JSON.stringify(sort(value));
}
export function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function summarizePayload(value: unknown, maxLen = 512): string {
  const s = canonicalJson(value);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function createProposal(req: ProposalRequest, meta: { profileId: string; sessionId: string }): Proposal {
  return {
    id: randomUUID(), ...meta, toolName: req.toolName, targetSystem: req.targetSystem,
    summary: req.summary, payloadHash: hashPayload(req.payload), payload: req.payload,
    risk: req.risk, status: 'pending', createdAt: Date.now(),
  };
}

const allowed: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ['approved', 'denied', 'expired'],
  approved: ['executed', 'failed'],
  denied: [], expired: [], executed: [], failed: [],
};

export function transition(p: Proposal, to: Exclude<ProposalStatus, 'pending'>): Proposal {
  if (!allowed[p.status].includes(to)) throw new Error(`illegal proposal transition ${p.status} -> ${to}`);
  return { ...p, status: to, decidedAt: to === 'denied' || to === 'expired' || to === 'executed' || to === 'failed' ? Date.now() : p.decidedAt };
}
```

`package.json`（name `@sparkii/approval`，deps：`@sparkii/connectors` workspace）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/approval
git commit -m "feat(approval): proposal state machine, payload hash, and summary"
```

### Task 12: SQLite WAL 审计存储

**Files:**
- Create: `packages/approval/src/audit.ts`
- Test: `packages/approval/test/audit.test.ts`

**Interfaces:**
- Consumes: `AuditEvent`（词汇表）。
- Produces:
  - `class AuditStore { constructor(file: string); append(ev: Omit<AuditEvent,'id'|'ts'>): Promise<AuditEvent>; query(filter: { actor?: string; action?: string; resource?: string }): Promise<AuditEvent[]>; exportJsonl(): Promise<string>; close(): void }`
  - 建表 SQL：`CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, resource TEXT, payload_summary TEXT, decision TEXT, model_route TEXT)`；`PRAGMA journal_mode=WAL`。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { AuditStore } from '../src/audit.js';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('AuditStore', () => {
  it('appends and queries an audit event', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    const ev = await s.append({ actor: 'u1', action: 'proposal.created', resource: 'report.export', payloadSummary: 'x' });
    expect(ev.id).toBeTruthy();
    expect(await s.query({ actor: 'u1' })).toHaveLength(1);
  });
  it('exports jsonl', async () => {
    const s = new AuditStore(join(mkdtempSync(join(tmpdir(), 'audit-')), 'a.db'));
    stores.push(s);
    await s.append({ actor: 'u1', action: 'proposal.denied', decision: 'denied' });
    const line = (await s.exportJsonl()).trim().split('\n')[0];
    expect(JSON.parse(line).action).toBe('proposal.denied');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface AuditEvent {
  id: string; ts: number; actor: string; action: string;
  resource?: string; payloadSummary?: string;
  decision?: 'approved' | 'denied' | 'expired';
  modelRoute?: string;
}

export class AuditStore {
  private db: Database.Database;
  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT,
      resource TEXT, payload_summary TEXT, decision TEXT, model_route TEXT)`);
  }
  async append(ev: Omit<AuditEvent, 'id' | 'ts'>): Promise<AuditEvent> {
    const full: AuditEvent = { ...ev, id: randomUUID(), ts: Date.now() };
    this.db.prepare(`INSERT INTO audit (id, ts, actor, action, resource, payload_summary, decision, model_route)
      VALUES (@id, @ts, @actor, @action, @resource, @payloadSummary, @decision, @modelRoute)`).run(full);
    return full;
  }
  async query(filter: { actor?: string; action?: string; resource?: string }): Promise<AuditEvent[]> {
    const rows = this.db.prepare(`SELECT * FROM audit WHERE
      (@actor IS NULL OR actor = @actor) AND
      (@action IS NULL OR action = @action) AND
      (@resource IS NULL OR resource = @resource) ORDER BY ts DESC`).all({ actor: filter.actor ?? null, action: filter.action ?? null, resource: filter.resource ?? null });
    return rows as AuditEvent[];
  }
  async exportJsonl(): Promise<string> {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY ts ASC').all() as AuditEvent[];
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
  close(): void { this.db.close(); }
}
```

Update `packages/approval/package.json`：`dependencies` 加 `better-sqlite3`。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/approval
git commit -m "feat(approval): SQLite WAL append-only audit store with export"
```

### Task 13: 审批门（submit/decide + RBAC + 超时 + 审计）

**Files:**
- Create: `packages/approval/src/gate.ts`
- Test: `packages/approval/test/gate.test.ts`

**Interfaces:**
- Consumes: `Proposal`、`createProposal`、`transition`、`summarizePayload`（Task 11）、`AuditStore`（Task 12）、`Rbac`（identity）、`ApprovalPolicy`（config 类型）。
- Produces:
  - `class ApprovalGate { constructor(opts: { policy: ApprovalPolicy; rbac: Rbac; audit: AuditStore }); submit(req: ProposalRequest, meta: { profileId; sessionId; actor }): Promise<Proposal>; decide(id: string, by: Subject, approved: boolean, note?: string): Promise<Proposal>; get(id): Proposal | undefined; listPending(): Proposal[] }`
  - `submit` 写 `proposal.created` 审计；`decide` 写 `proposal.approved`/`proposal.denied` 审计并强制 RBAC `canApprove(subject, risk)`；超时由调用方 `expire()` 处理（`proposal.expired` 审计）。
  - `expire(id): Promise<Proposal | undefined>`：仅当 `now - createdAt > policy.timeoutMs` 且仍 pending 时置 `expired`。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { AuditStore } from '../src/audit.js';
import { Rbac } from '@sparkii/identity';

const stores: AuditStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

const policy = { requireApproval: ['report.export'], timeoutMs: 1000, highRiskDoubleConfirm: true };
const rbac = new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]);

describe('ApprovalGate', () => {
  it('approves by an authorized actor and audits both events', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac, audit });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    const out = await gate.decide(p.id, { userId: 'u1', roles: ['admin'] }, true, 'ok');
    expect(out.status).toBe('approved');
    expect((await audit.query({})).map((e) => e.action)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.approved']));
  });
  it('denies unauthorized approver', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'g-')), 'a.db'));
    stores.push(audit);
    const gate = new ApprovalGate({ policy, rbac: new Rbac([{ name: 'viewer', pages: [], tools: [], canApprove: [] }]), audit });
    const p = await gate.submit({ toolName: 'report.export', targetSystem: 'report', summary: 'x', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await expect(gate.decide(p.id, { userId: 'u2', roles: ['viewer'] }, true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { ApprovalPolicy } from '@sparkii/config';
import { Rbac, type Subject } from '@sparkii/identity';
import { createProposal, transition, summarizePayload, type Proposal, type ProposalRequest } from './proposal.js';
import { AuditStore } from './audit.js';

export class GateError extends Error {
  constructor(public code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'NOT_PENDING', message: string) { super(message); }
}

export class ApprovalGate {
  private proposals = new Map<string, Proposal>();
  constructor(private opts: { policy: ApprovalPolicy; rbac: Rbac; audit: AuditStore }) {}

  async submit(req: ProposalRequest, meta: { profileId: string; sessionId: string; actor: string }): Promise<Proposal> {
    const p = createProposal(req, { profileId: meta.profileId, sessionId: meta.sessionId });
    this.proposals.set(p.id, p);
    await this.opts.audit.append({ actor: meta.actor, action: 'proposal.created', resource: p.toolName, payloadSummary: summarizePayload(p.payload) });
    return p;
  }

  async decide(id: string, by: Subject, approved: boolean, note?: string): Promise<Proposal> {
    const p = this.proposals.get(id);
    if (!p) throw new GateError('NOT_FOUND', id);
    if (p.status !== 'pending') throw new GateError('NOT_PENDING', id);
    if (approved && !this.opts.rbac.canApprove(by, p.risk)) throw new GateError('UNAUTHORIZED', 'approver lacks permission');
    const out = transition(p, approved ? 'approved' : 'denied');
    out.decisionBy = by.userId; out.decisionNote = note;
    this.proposals.set(id, out);
    await this.opts.audit.append({ actor: by.userId, action: approved ? 'proposal.approved' : 'proposal.denied', resource: p.toolName, decision: approved ? 'approved' : 'denied' });
    return out;
  }

  async expire(id: string): Promise<Proposal | undefined> {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'pending') return p;
    if (Date.now() - p.createdAt > this.opts.policy.timeoutMs) {
      const out = transition(p, 'expired');
      this.proposals.set(id, out);
      await this.opts.audit.append({ actor: 'system', action: 'proposal.expired', resource: p.toolName, decision: 'expired' });
      return out;
    }
    return p;
  }

  get(id: string) { return this.proposals.get(id); }
  listPending() { return [...this.proposals.values()].filter((p) => p.status === 'pending'); }
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/approval
git commit -m "feat(approval): approval gate with RBAC, timeout, and audit"
```

### Task 14: 确定性连接器执行器（被拒绝永不执行）

**Files:**
- Create: `packages/approval/src/executor.ts`
- Test: `packages/approval/test/executor.test.ts`

**Interfaces:**
- Consumes: `Proposal`（Task 11）、`AuditStore`（Task 12）、`ToolHandler`（connectors）。
- Produces:
  - `class ConnectorExecutor { register(name: string, handler: ToolHandler): void; execute(p: Proposal, ctx: { actor: string }): Promise<Proposal> }`
  - 硬不变量：`p.status !== 'approved'` 时**不调用 handler**，直接把 proposal 置为 `failed`/保持原状态并返回；handler 抛错 → `failed`；成功 → `executed` 并写 `proposal.executed`/`proposal.failed` 审计。

- [ ] **Step 1: 写失败测试**（核心安全契约）

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectorExecutor } from '../src/executor.js';
import { AuditStore } from '../src/audit.js';
import { createProposal, transition } from '../src/proposal.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ConnectorExecutor', () => {
  it('never calls the write handler for a denied proposal', async () => {
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(new AuditStore(join(mkdtempSync(join(tmpdir(), 'ex-')), 'a.db')));
    ex.register('report.export', handler);
    const p = transition(createProposal({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'denied');
    const out = await ex.execute(p, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('denied');
  });

  it('executes an approved proposal with the frozen payload', async () => {
    const handler = vi.fn(async (args) => ({ ok: true, data: { got: args } }));
    const ex = new ConnectorExecutor(new AuditStore(join(mkdtempSync(join(tmpdir(), 'ex-')), 'a.db')));
    ex.register('report.export', handler);
    const p = transition(createProposal({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: { title: 'r' }, risk: 'write' }, { profileId: 'p', sessionId: 's' }), 'approved');
    const out = await ex.execute(p, { actor: 'system' });
    expect(handler).toHaveBeenCalledWith({ title: 'r' }, expect.objectContaining({ actor: 'system' }));
    expect(out.status).toBe('executed');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { ToolHandler } from '@sparkii/connectors';
import { transition, type Proposal } from './proposal.js';
import { AuditStore } from './audit.js';

export class ConnectorExecutor {
  private handlers = new Map<string, ToolHandler>();
  constructor(private audit: AuditStore) {}
  register(name: string, handler: ToolHandler): void { this.handlers.set(name, handler); }

  async execute(p: Proposal, ctx: { actor: string }): Promise<Proposal> {
    if (p.status !== 'approved') {
      await this.audit.append({ actor: ctx.actor, action: 'execution.blocked', resource: p.toolName, decision: p.status === 'denied' ? 'denied' : 'expired' });
      return p;
    }
    const handler = this.handlers.get(p.toolName);
    if (!handler) return transition(p, 'failed');
    try {
      const result = await handler(p.payload as Record<string, unknown>, {
        profileId: p.profileId, sessionId: p.sessionId, actor: ctx.actor, requestId: p.id,
      });
      if (!result.ok) {
        const failed = transition(p, 'failed');
        failed.execution = { ok: false, error: result.error?.message };
        await this.audit.append({ actor: ctx.actor, action: 'proposal.failed', resource: p.toolName });
        return failed;
      }
      const done = transition(p, 'executed');
      done.execution = { ok: true, result: result.data };
      await this.audit.append({ actor: ctx.actor, action: 'proposal.executed', resource: p.toolName });
      return done;
    } catch (e) {
      const failed = transition(p, 'failed');
      failed.execution = { ok: false, error: (e as Error).message };
      await this.audit.append({ actor: ctx.actor, action: 'proposal.failed', resource: p.toolName });
      return failed;
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/approval
git commit -m "feat(approval): deterministic write executor that refuses non-approved proposals"
```

### Task 15: 安全不变量契约测试（横切）

**Files:**
- Create: `packages/approval/test/invariants.test.ts`

**Interfaces:**
- Consumes: `ApprovalGate`、`ConnectorExecutor`、`AuditStore`、`Rbac`。
- Produces: 无新类型；三条必须永久保持的契约，任何回归即失败。

- [ ] **Step 1: 写测试**

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalGate } from '../src/gate.js';
import { ConnectorExecutor } from '../src/executor.js';
import { AuditStore } from '../src/audit.js';
import { Rbac } from '@sparkii/identity';

const dbs: AuditStore[] = [];
afterEach(() => dbs.splice(0).forEach((d) => d.close()));

const gate = (audit: AuditStore) => new ApprovalGate({
  policy: { requireApproval: ['report.export'], timeoutMs: 10000, highRiskDoubleConfirm: true },
  rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write', 'high-risk'] }]),
  audit,
});

describe('security invariants', () => {
  it('denied write never reaches the connector executor', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(audit); ex.register('report.export', handler);
    const p = await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    await g.decide(p.id, { userId: 'u1', roles: ['admin'] }, false, 'no');
    const out = await ex.execute(g.get(p.id)!, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('denied');
  });

  it('every write attempt produces exactly one proposal.created audit record', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    expect((await audit.query({ action: 'proposal.created' }))).toHaveLength(1);
  });

  it('a hallucinated "approved" text cannot execute a write (executor reads authoritative state)', async () => {
    const audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'inv-')), 'a.db')); dbs.push(audit);
    const g = gate(audit);
    const handler = vi.fn(async () => ({ ok: true, data: {} }));
    const ex = new ConnectorExecutor(audit); ex.register('report.export', handler);
    const p = await g.submit({ toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }, { profileId: 'p', sessionId: 's', actor: 'agent' });
    // 模拟 LLM 谎报「已批准」，但权威状态仍是 pending
    const out = await ex.execute(g.get(p.id)!, { actor: 'system' });
    expect(handler).not.toHaveBeenCalled();
    expect(out.status).toBe('pending');
  });
});
```

- [ ] **Step 2: 运行确认失败（若前序未实现）→ 实现已在前序任务 → 应通过**

- [ ] **Step 3: 运行全量确认**

Run: `pnpm --filter @sparkii/approval test`
Expected: PASS（全部）。

- [ ] **Step 4: 提交**

```bash
git add packages/approval/test/invariants.test.ts
git commit -m "test(approval): security invariant contract tests"
```

### Task 15a: identity / approval 包入口导出（index.ts）

**Files:**
- Create: `packages/identity/src/index.ts`、`packages/approval/src/index.ts`

**Interfaces:**
- Produces: `@sparkii/identity` 导出 `types/local/rbac`；`@sparkii/approval` 导出 `types/proposal/audit/gate/executor`。后续 agent-host / runtime 从这里 import（如 `Rbac`、`ApprovalGate`、`ConnectorExecutor`、`AuditStore`）。

- [ ] **Step 1: 实现**

`packages/identity/src/index.ts`：

```ts
export * from './types.js';
export * from './local.js';
export * from './rbac.js';
```

`packages/approval/src/index.ts`：

```ts
export * from './types.js';
export * from './proposal.js';
export * from './audit.js';
export * from './gate.js';
export * from './executor.js';
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @sparkii/identity test` 与 `pnpm --filter @sparkii/approval test`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/identity/src/index.ts packages/approval/src/index.ts
git commit -m "feat(identity,approval): export public package APIs"
```

---

## M6 — Agent 宿主（packages/agent-host）

### Task 16: Pi RPC 客户端（JSONL 帧 + 请求/响应 + 事件归一化）

**Files:**
- Create: `packages/agent-host/src/types.ts`、`packages/agent-host/src/rpc-client.ts`、`packages/agent-host/package.json`
- Test: `packages/agent-host/test/rpc-client.test.ts`

**Interfaces:**
- Consumes: 无（纯 stdio 适配）。
- Produces:
  - `type RpcCommand = { type: 'prompt'; message: string; streamingBehavior?: 'steer'|'followUp' } | { type:'steer'; message:string } | { type:'follow_up'; message:string } | { type:'abort' } | { type:'new_session' } | { type:'get_state' } | { type:'get_messages' } | { type:'set_model'; provider:string; modelId:string }`
  - `interface RpcResponse { id?: string; type: 'response'; command: string; success: boolean; data?: unknown }`
  - `type NormalizedEvent = { type:'message'; role:'user'|'assistant'; delta?:string; text?:string } | { type:'tool_call'; toolName:string; input:unknown } | { type:'tool_result'; toolName:string; result:unknown } | { type:'agent_start' } | { type:'agent_end' } | { type:'compaction_start' } | { type:'compaction_end' } | { type:'unknown'; raw:unknown }`
  - `class PiRpcClient { constructor(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream); send(cmd: RpcCommand, id?: string): Promise<RpcResponse>; onEvent(cb: (e: NormalizedEvent) => void): () => void; close(): void }`
  - 关键细节：用 `\n` 切帧（剥离尾部 `\r`），**不用 `readline`**（会错切 U+2028/U+2029）。

- [ ] **Step 1: 写失败测试**（用内存流模拟 stdout，喂原始 JSONL）

```ts
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { PiRpcClient, normalizeEvent } from '../src/rpc-client.js';

describe('normalizeEvent', () => {
  it('maps assistant message delta', () => {
    const e = normalizeEvent({ type: 'message_update', role: 'assistant', textDelta: 'hi' });
    expect(e).toEqual({ type: 'message', role: 'assistant', delta: 'hi' });
  });
  it('keeps unknown events as unknown', () => {
    expect(normalizeEvent({ type: 'future_thing', x: 1 }).type).toBe('unknown');
  });
});

describe('PiRpcClient', () => {
  it('correlates responses by id and streams events', async () => {
    const stdin = new PassThrough(); const stdout = new PassThrough();
    const c = new PiRpcClient(stdin, stdout);
    const onEvent = vi.fn();
    c.onEvent(onEvent);
    const respP = c.send({ type: 'prompt', message: 'hi' }, 'req-1');
    stdout.write('{"id":"req-1","type":"response","command":"prompt","success":true}\n');
    stdout.write('{"type":"message_start","role":"assistant"}\n');
    const resp = await respP;
    expect(resp.success).toBe(true);
    expect(onEvent).toHaveBeenCalled();
    c.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import type { Writable, Readable } from 'node:stream';

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
  | { type: 'switch_session'; sessionPath: string };

export interface RpcResponse { id?: string; type: 'response'; command: string; success: boolean; data?: unknown }
export type NormalizedEvent =
  | { type: 'message'; role: 'user' | 'assistant'; delta?: string; text?: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; result: unknown }
  | { type: 'agent_start' } | { type: 'agent_end' }
  | { type: 'compaction_start' } | { type: 'compaction_end' }
  | { type: 'unknown'; raw: unknown };

export function normalizeEvent(raw: any): NormalizedEvent {
  switch (raw.type) {
    case 'message_update': return { type: 'message', role: raw.role, delta: raw.textDelta ?? raw.text };
    case 'message_end': return { type: 'message', role: raw.role, text: raw.text };
    case 'tool_call': return { type: 'tool_call', toolName: raw.toolName, input: raw.input };
    case 'tool_result': return { type: 'tool_result', toolName: raw.toolName, result: raw.result };
    case 'agent_start': return { type: 'agent_start' };
    case 'agent_end': return { type: 'agent_end' };
    case 'compaction_start': return { type: 'compaction_start' };
    case 'compaction_end': return { type: 'compaction_end' };
    default: return { type: 'unknown', raw };
  }
}

export class PiRpcClient {
  private pending = new Map<string, (r: RpcResponse) => void>();
  private listeners = new Set<(e: NormalizedEvent) => void>();
  private buffer = '';

  constructor(private stdin: Writable, stdout: Readable) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.consume(chunk));
  }

  send(cmd: RpcCommand, id?: string): Promise<RpcResponse> {
    const line = JSON.stringify({ ...cmd, ...(id ? { id } : {}) });
    this.stdin.write(line + '\n');
    return new Promise((resolve) => {
      if (!id) { this.pending.set('__noid__', resolve); return; }
      this.pending.set(id, resolve);
    });
  }

  onEvent(cb: (e: NormalizedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void { this.stdin.end(); }

  private consume(chunk: string) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type === 'response') {
        const key = obj.id ?? '__noid__';
        const resolve = this.pending.get(key);
        if (resolve) { this.pending.delete(key); resolve(obj); }
      } else {
        this.listeners.forEach((cb) => cb(normalizeEvent(obj)));
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host
git commit -m "feat(agent-host): Pi JSONL RPC client with event normalization"
```

### Task 17: Pi 子进程监督（spawn/restart/recover）

**Files:**
- Create: `packages/agent-host/src/process.ts`
- Test: `packages/agent-host/test/process.test.ts`

**Interfaces:**
- Consumes: `PiRpcClient`（Task 16）。
- Produces:
  - `class PiProcessSupervisor { constructor(opts: { bin?: string; args: string[] }); start(): Promise<PiRpcClient>; stop(): Promise<void>; onExit(cb: (code: number | null) => void): () => void }`（`start()` 幂等：已有存活子进程时返回同一 `PiRpcClient`）
  - 默认 `bin = process.env.PI_BIN ?? 'pi'`；崩溃（exit code 非 0）由 Main 侧决定重启策略，本类只负责 spawn/终止/事件上报。

- [ ] **Step 1: 写失败测试**（用 `node -e` 模拟一个读 stdin 的伪进程，避免依赖真 pi）

```ts
import { describe, it, expect } from 'vitest';
import { PiProcessSupervisor } from '../src/process.js';

describe('PiProcessSupervisor', () => {
  it('spawns and stops a child', async () => {
    const sup = new PiProcessSupervisor({ bin: process.execPath, args: ['-e', 'process.stdin.resume()'] });
    const client = await sup.start();
    expect(client).toBeTruthy();
    await sup.stop();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PiRpcClient } from './rpc-client.js';

export class PiProcessSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private client?: PiRpcClient;
  private exitCbs = new Set<(code: number | null) => void>();
  constructor(private opts: { bin?: string; args?: string[] } = {}) {}

  async start(): Promise<PiRpcClient> {
    if (this.client) return this.client;
    const bin = this.opts.bin ?? process.env.PI_BIN ?? 'pi';
    const args = this.opts.args ?? ['--mode', 'rpc'];
    // Windows：Node 的 spawn 直接启动 .cmd/.bat 会 EINVAL，经 cmd.exe 启动
    this.child = /\.(cmd|bat)$/i.test(bin)
      ? spawn('cmd.exe', ['/d', '/s', '/c', [bin, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')], { stdio: ['pipe', 'pipe', 'inherit'] })
      : spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.client = new PiRpcClient(this.child.stdin, this.child.stdout);
    this.child.on('exit', (code) => {
      this.client = undefined;
      this.exitCbs.forEach((cb) => cb(code));
    });
    return this.client;
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill();
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/process.ts packages/agent-host/test/process.test.ts
git commit -m "feat(agent-host): Pi subprocess supervisor"
```

### Task 18: 控制通道（loopback HTTP + bearer token）与提议桥

**Files:**
- Create: `packages/agent-host/src/control-server.ts`
- Test: `packages/agent-host/test/control-server.test.ts`

**Interfaces:**
- Consumes: `ProposalRequest`（approval）、`NormalizedEvent`（Task 16）。
- Produces:
  - `class ControlServer { constructor(opts: { onProposal: (req: ProposalRequest & { requestId: string }) => Promise<{ approved: boolean; proposalId: string; status: string; result?: unknown }> }); start(): Promise<{ url: string; token: string }>; stop(): Promise<void> }`
  - 监听 `127.0.0.1` 随机端口，`POST /propose`（header `Authorization: Bearer <token>`）返回决定；错误 token 返回 401。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { ControlServer } from '../src/control-server.js';

describe('ControlServer', () => {
  it('proxies a proposal and enforces bearer token', async () => {
    const s = new ControlServer({ onProposal: async (req) => ({ approved: false, proposalId: 'p1', status: 'denied' }) });
    const { url, token } = await s.start();
    const r = await fetch(`${url}/propose`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r1', toolName: 'report.export', targetSystem: 'report', summary: '', payload: {}, risk: 'write' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe('denied');
    const bad = await fetch(`${url}/propose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    await s.stop();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { ProposalRequest } from '@sparkii/approval';

export interface ProposalDecision { approved: boolean; proposalId: string; status: string; result?: unknown }

export class ControlServer {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  constructor(private opts: { onProposal: (req: ProposalRequest & { requestId: string }) => Promise<ProposalDecision> }) {}

  async start(): Promise<{ url: string; token: string }> {
    this.server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/propose') { res.writeHead(404); res.end(); return; }
      if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401); res.end('unauthorized'); return; }
      const body = await new Promise<string>((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
      const decision = await this.opts.onProposal(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}`, token: this.token };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host
git commit -m "feat(agent-host): loopback proposal control channel with bearer token"
```

### Task 19: Pi 桥扩展（注册读工具 + 提议工具 + provider）

**Files:**
- Create: `packages/agent-host/src/bridge/extension.ts`、`packages/agent-host/src/bridge/typebox.ts`
- Test: `packages/agent-host/test/bridge.test.ts`（只测 `jsonSchemaToTypeBox` 与 `connectorId`）

**Interfaces:**
- Consumes: `Connector`/`ToolDef`（connectors）、`ProposalRequest`（approval）、`ControlServer` 决策类型（Task 18）。
- Produces:
  - `jsonSchemaToTypeBox(schema: JSONSchema): unknown`（只支持 object/string/number/boolean/array/enum，其余抛错——fail closed）
  - `connectorId(toolName: string): string`（取 `toolName.split('.')[0]`）
  - `default function(pi: ExtensionAPI)`（扩展入口）：读工具 `execute` 直调 `handler`；写工具 `execute` 只 POST `/propose` 并等待决定，把 `{proposalId,status,result}` 作为信息性结果返回给 LLM。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { jsonSchemaToTypeBox, connectorId } from '../src/bridge/typebox.js';

describe('bridge helpers', () => {
  it('maps object/string/enum to typebox-ish nodes', () => {
    expect(jsonSchemaToTypeBox({ type: 'string' })).toMatchObject({ kind: 'string' });
    expect(jsonSchemaToTypeBox({ type: 'object', properties: { a: { type: 'string' } } })).toMatchObject({ kind: 'object' });
  });
  it('derives connector id from tool name', () => {
    expect(connectorId('report.export')).toBe('report');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`bridge/typebox.ts`：

```ts
import type { JSONSchema } from '@sparkii/connectors';

export function connectorId(toolName: string): string { return toolName.split('.')[0]; }

export function jsonSchemaToTypeBox(schema: JSONSchema): unknown {
  // 本函数不 import typebox，产出与 Type.Object 等价的描述对象，供 registerTool 的运行时适配
  const t = schema.type;
  if (t === 'string') return { kind: 'string', enum: schema.enum };
  if (t === 'number' || t === 'integer') return { kind: 'number' };
  if (t === 'boolean') return { kind: 'boolean' };
  if (t === 'array') return { kind: 'array', items: jsonSchemaToTypeBox((schema.items ?? { type: 'string' }) as JSONSchema) };
  if (t === 'object') {
    const props = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, JSONSchema>).map(([k, v]) => [k, jsonSchemaToTypeBox(v)]));
    return { kind: 'object', properties: props, required: schema.required ?? Object.keys(props) };
  }
  throw new Error(`unsupported JSON schema type: ${String(t)}`);
}
```

`bridge/extension.ts`：

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import { connectorId, jsonSchemaToTypeBox } from './typebox.js';

const controlUrl = process.env.SPARKII_CONTROL_URL!;
const controlToken = process.env.SPARKII_CONTROL_TOKEN!;

async function propose(payload: unknown) {
  const r = await fetch(`${controlUrl}/propose`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`control channel error: ${r.status}`);
  return r.json();
}

export default function (pi: ExtensionAPI) {
  const connectors = [documentConnector, knowledgeConnector, reportConnector];
  for (const c of connectors) {
    for (const def of c.tools) {
      if (def.sideEffect === 'read') {
        pi.registerTool({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: jsonSchemaToTypeBox(def.params) as any,
          async execute(_id, params, _signal, _onUpdate, ctx) {
            const r = await def.handler(params as Record<string, unknown>, {
              profileId: process.env.SPARKII_PROFILE_ID ?? 'dev',
              sessionId: process.env.SPARKII_SESSION_ID ?? 'session',
              actor: 'agent', requestId: _id,
            });
            return { content: [{ type: 'text', text: JSON.stringify(r) }], details: {} };
          },
        });
      } else {
        pi.registerTool({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: jsonSchemaToTypeBox(def.params) as any,
          async execute(_id, params) {
            const decision = await propose({
              requestId: _id, toolName: def.name, targetSystem: connectorId(def.name),
              summary: JSON.stringify(params).slice(0, 512), payload: params, risk: def.sideEffect,
            });
            return { content: [{ type: 'text', text: JSON.stringify(decision) }], details: {} };
          },
        });
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**（`bridge.test.ts` 不加载真实 pi，只测纯函数）

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host
git commit -m "feat(agent-host): Pi bridge extension registers read and proposal tools"
```

### Task 20: 真实 Pi 集成测试（spawn + 读工具 + 写被门控）

**Files:**
- Create: `packages/agent-host/test/pi.integration.test.ts`

**Interfaces:**
- Consumes: `PiProcessSupervisor`、`PiRpcClient`、`ControlServer`、`ApprovalGate`、`ConnectorExecutor`、`AuditStore`。
- Produces: 无；验证真实协议与安全边界的端到端闭环。

- [ ] **Step 1: 写测试**（无 `PI_BIN` 或 `RUN_PI_INTEGRATION=1` 时跳过）

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PiProcessSupervisor } from '../src/process.js';
import { ControlServer } from '../src/control-server.js';
import { ApprovalGate } from '@sparkii/approval';
import { ConnectorExecutor } from '@sparkii/approval';
import { AuditStore } from '@sparkii/approval';
import { Rbac } from '@sparkii/identity';

const skip = !process.env.PI_BIN && process.env.RUN_PI_INTEGRATION !== '1';

describe.skipIf(skip)('Pi integration', () => {
  let sup: PiProcessSupervisor, gate: ApprovalGate, ex: ConnectorExecutor, audit: AuditStore;
  beforeAll(async () => {
    sup = new PiProcessSupervisor();
    audit = new AuditStore(join(mkdtempSync(join(tmpdir(), 'pi-it-')), 'a.db'));
    gate = new ApprovalGate({ policy: { requireApproval: ['report.export'], timeoutMs: 60000, highRiskDoubleConfirm: true }, rbac: new Rbac([{ name: 'admin', pages: [], tools: [], canApprove: ['write'] }]), audit });
    ex = new ConnectorExecutor(audit); ex.register('report.export', async () => ({ ok: true, data: { bytes: 'e30=' } }));
    const control = new ControlServer({ onProposal: async (req) => {
      const p = await gate.submit(req, { profileId: 'p', sessionId: 's', actor: 'agent' });
      return { approved: false, proposalId: p.id, status: p.status };
    }});
    const { url, token } = await control.start();
    process.env.SPARKII_CONTROL_URL = url; process.env.SPARKII_CONTROL_TOKEN = token;
  });
  afterAll(async () => { await sup.stop(); audit.close(); });

  it('starts RPC mode and answers get_state', async () => {
    const c = await sup.start();
    const r = await c.send({ type: 'get_state' });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认跳过**（无 PI_BIN 时 `skipped`）

- [ ] **Step 3: 在 CI 手工加 PI_BIN 后运行**（执行者按 Pi 仓库安装说明准备 `pi` 二进制）

- [ ] **Step 4: 提交**

```bash
git add packages/agent-host/test/pi.integration.test.ts
git commit -m "test(agent-host): real Pi spawn integration test (skippable)"
```

---

## M7 — 流程编排（packages/agent-host 内 workflow 子模块）

### Task 21: WorkflowRunner 接口 + LinearRunner

**Files:**
- Create: `packages/agent-host/src/workflow/types.ts`、`packages/agent-host/src/workflow/linear.ts`
- Test: `packages/agent-host/test/workflow.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`（Task 16）、`ApprovalGate`（Task 13）、`Connector`（Task 6）。
- Produces:
  - `type WorkflowStep = { id: string; type: 'tool'|'skill'|'llm'|'human'; ref: string; inputs?: { from: string | string[] }; template?: string }`
  - `interface WorkflowDef { version: 1; engine: 'linear'; steps: WorkflowStep[] }`
  - `interface RunContext { profileId: string; sessionId: string; actor: string; input: Record<string, unknown>; sendPrompt(text: string): Promise<string>; runTool(toolName: string, args: unknown): Promise<ToolResult>; requestApproval(req: ProposalRequest): Promise<Proposal> }`
  - `interface WorkflowRunner { run(def: WorkflowDef, ctx: RunContext): AsyncIterable<WorkflowEvent> }`
  - `class LinearRunner implements WorkflowRunner`：顺序执行 steps，`tool` 调 `ctx.runTool`，`skill`/`llm` 调 `ctx.sendPrompt`（注入 `template` + 输入），`human` 调 `ctx.requestApproval`（`type='human'` 以 `workflow.approval` 工具名提交，`risk='high-risk'`）。

- [ ] **Step 1: 写失败测试**（假 ctx，收集事件）

```ts
import { describe, it, expect } from 'vitest';
import { LinearRunner } from '../src/workflow/linear.js';
import type { RunContext, WorkflowDef } from '../src/workflow/types.js';

async function collect(def: WorkflowDef, ctx: RunContext) {
  const events = [];
  for await (const e of new LinearRunner().run(def, ctx)) events.push(e);
  return events;
}

const def: WorkflowDef = {
  version: 1, engine: 'linear',
  steps: [
    { id: 'load', type: 'tool', ref: 'document.read' },
    { id: 'extract', type: 'skill', ref: 'clause_extract', inputs: { from: 'load' } },
    { id: 'review', type: 'human', inputs: { from: 'extract' } },
  ],
};

describe('LinearRunner', () => {
  it('runs steps in order and emits lifecycle events', async () => {
    const ctx: RunContext = {
      profileId: 'p', sessionId: 's', actor: 'u1', input: {},
      runTool: async () => ({ ok: true, data: { text: 'clauses' } }),
      sendPrompt: async (t) => `echo:${t}`,
      requestApproval: async (req) => ({ id: 'p1', ...req, status: 'pending', payloadHash: 'h', createdAt: 1 } as any),
    };
    const events = await collect(def, ctx);
    expect(events.map((e) => e.type)).toEqual(['step_started', 'tool_call', 'step_completed', 'step_started', 'step_completed', 'step_started', 'approval_required', 'step_completed', 'workflow_completed']);
  });

  it('fails workflow on tool error', async () => {
    const ctx: RunContext = { ...({} as RunContext), runTool: async () => ({ ok: false, error: { code: 'CONNECTOR_IO', message: 'x' } }) };
    const events = await collect(def, ctx);
    expect(events.at(-1)).toMatchObject({ type: 'workflow_failed' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`workflow/types.ts`：

```ts
import type { ProposalRequest, Proposal } from '@sparkii/approval';
import type { ToolResult } from '@sparkii/connectors';

export interface WorkflowStep {
  id: string;
  type: 'tool' | 'skill' | 'llm' | 'human';
  ref: string;
  inputs?: { from: string | string[] };
  map?: Record<string, string>;
  template?: string;
}
export interface WorkflowDef { version: 1; engine: 'linear'; steps: WorkflowStep[] }
export interface RunContext {
  profileId: string; sessionId: string; actor: string; input: Record<string, unknown>;
  sendPrompt(text: string): Promise<string>;
  runTool(toolName: string, args: unknown): Promise<ToolResult>;
  requestApproval(req: ProposalRequest): Promise<Proposal>;
}
export type WorkflowEvent =
  | { type: 'step_started'; stepId: string }
  | { type: 'step_completed'; stepId: string; output: unknown }
  | { type: 'tool_call'; stepId: string; toolName: string }
  | { type: 'approval_required'; stepId: string; proposalId: string }
  | { type: 'workflow_completed'; result: unknown }
  | { type: 'workflow_failed'; stepId: string; error: { code: string; message: string } };
export interface WorkflowRunner { run(def: WorkflowDef, ctx: RunContext): AsyncIterable<WorkflowEvent>; }
```

`workflow/linear.ts`：

```ts
import type { RunContext, WorkflowDef, WorkflowEvent, WorkflowRunner } from './types.js';

export class LinearRunner implements WorkflowRunner {
  async *run(def: WorkflowDef, ctx: RunContext): AsyncIterable<WorkflowEvent> {
    const state: Record<string, unknown> = { ...ctx.input };
    for (const step of def.steps) {
      yield { type: 'step_started', stepId: step.id };
      try {
        if (step.type === 'tool') {
          yield { type: 'tool_call', stepId: step.id, toolName: step.ref };
          const r = await ctx.runTool(step.ref, resolveToolArgs(step, state));
          if (!r.ok) throw new Error(`${r.error?.code ?? 'ERROR'}: ${r.error?.message}`);
          state[step.id] = r.data;
        } else if (step.type === 'skill' || step.type === 'llm') {
          const text = await ctx.sendPrompt(`${step.template ?? ''}\n\n${JSON.stringify(resolveInputs(step, state))}`);
          state[step.id] = text;
        } else if (step.type === 'human') {
          const p = await ctx.requestApproval({ toolName: 'workflow.approval', targetSystem: 'workflow', summary: `step ${step.id}`, payload: { stepId: step.id, data: resolveInputs(step, state) }, risk: 'high-risk' });
          yield { type: 'approval_required', stepId: step.id, proposalId: p.id };
          state[step.id] = { proposalId: p.id, status: p.status };
        }
        yield { type: 'step_completed', stepId: step.id, output: state[step.id] };
      } catch (e) {
        yield { type: 'workflow_failed', stepId: step.id, error: { code: 'WORKFLOW_STEP_FAILED', message: (e as Error).message } };
        return;
      }
    }
    yield { type: 'workflow_completed', result: state };
  }
}

function resolveInputs(step: WorkflowDef['steps'][number], state: Record<string, unknown>): unknown {
  if (!step.inputs) return state;
  const refs = Array.isArray(step.inputs.from) ? step.inputs.from : [step.inputs.from];
  const picked = Object.fromEntries(refs.map((r) => [r, state[r]]));
  return picked;
}

function getPath(state: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[key] : undefined,
    state,
  );
}

function resolveToolArgs(step: WorkflowDef['steps'][number], state: Record<string, unknown>): unknown {
  if (step.map) return Object.fromEntries(Object.entries(step.map).map(([k, path]) => [k, getPath(state, path)]));
  return resolveInputs(step, state);
}
```

（`requestApproval` 返回的 proposal 在 Main 侧被真正的审批门消费；LinearRunner 只产出事件，不执行写。）

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/workflow packages/agent-host/test/workflow.test.ts
git commit -m "feat(agent-host): WorkflowRunner interface and LinearRunner"
```

### Task 21a: agent-host 包入口导出（index.ts）

**Files:**
- Create: `packages/agent-host/src/index.ts`

**Interfaces:**
- Produces: `@sparkii/agent-host` 导出 `rpc-client`、`process`、`control-server`、`bridge/typebox`、`workflow/types`、`workflow/linear`（不导出 `bridge/extension`）。后续 Main 装配（Task 25）从这里 import `PiProcessSupervisor`、`ControlServer`、`LinearRunner` 等。

- [ ] **Step 1: 实现**

`packages/agent-host/src/index.ts`：

```ts
export * from './rpc-client.js';
export * from './process.js';
export * from './control-server.js';
export * from './bridge/typebox.js';
export * from './workflow/types.js';
export * from './workflow/linear.js';
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @sparkii/agent-host test`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/agent-host/src/index.ts
git commit -m "feat(agent-host): export public API from package entry"
```

---

## M8 — UI + 主题 + Electron 壳装配

### Task 22: 设计 token 与主题包（一等交付物）

**Files:**
- Create: `packages/theme/src/tokens.ts`、`packages/theme/src/registry.ts`、`packages/theme/package.json`
- Test: `packages/theme/test/tokens.test.ts`

**Interfaces:**
- Consumes: `PageSchema`（config）。
- Produces:
  - `interface DesignTokens { color: Record<string,string>; spacing: Record<string,string>; radius: Record<string,string>; shadow: Record<string,string>; font: Record<string,string>; }`
  - `resolveTheme(raw: unknown): DesignTokens`（只读校验，返回 token；非法 token 抛 `THEME_INVALID`）
  - `function cssVariables(tokens: DesignTokens): string`（生成 `:root { --color-...: ... }`）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { resolveTheme, cssVariables } from '../src/tokens.js';

describe('theme tokens', () => {
  it('resolves tokens and emits css variables', () => {
    const tokens = resolveTheme({ color: { primary: '#111' }, spacing: { md: '8px' }, radius: { md: '6px' }, shadow: { md: '0 1px 2px' }, font: { body: 'sans-serif' } });
    expect(cssVariables(tokens)).toContain('--color-primary: #111');
  });
  it('rejects missing token group', () => {
    expect(() => resolveTheme({ color: {} })).toThrow(/THEME_INVALID/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`tokens.ts`：

```ts
export interface DesignTokens {
  color: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  font: Record<string, string>;
}
const groups = ['color', 'spacing', 'radius', 'shadow', 'font'] as const;

export function resolveTheme(raw: unknown): DesignTokens {
  if (!raw || typeof raw !== 'object') throw new Error('THEME_INVALID: theme must be an object');
  for (const g of groups) {
    if (!(raw as any)[g] || typeof (raw as any)[g] !== 'object') throw new Error(`THEME_INVALID: missing ${g}`);
  }
  return raw as DesignTokens;
}

export function cssVariables(tokens: DesignTokens): string {
  const vars: string[] = [];
  for (const g of groups) {
    for (const [k, v] of Object.entries(tokens[g])) vars.push(`--${g}-${k}: ${v}`);
  }
  return `:root { ${vars.join('; ')}; }`;
}
```

`registry.ts`（组件皮肤槽位约定，MVP 只定义契约）：

```ts
export interface WidgetSlots { root?: string; header?: string; body?: string; footer?: string; }
export interface WidgetSkin { widget: string; slots: WidgetSlots; className?: string; }
```

`package.json`（name `@sparkii/theme`）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add packages/theme
git commit -m "feat(theme): design tokens and css variable generation"
```

### Task 23: 组件注册表 + 页面组合引擎（Renderer）

**Files:**
- Create: `apps/desktop/src/composer/registry.tsx`、`apps/desktop/src/composer/PageComposer.tsx`、`apps/desktop/src/composer/validate.ts`
- Test: `apps/desktop/test/composer.test.tsx`

**Interfaces:**
- Consumes: `PageSchema`（config）。
- Produces:
  - `interface WidgetProps { id: string; bind?: string; action?: string; state: Record<string, unknown>; onAction(action: string): void }`
  - `const widgetRegistry: Record<string, React.ComponentType<WidgetProps>>`（内置 `file-upload`、`action-button`、`table`、`doc-preview`、`chat-panel`、`approval-panel`）
  - `validatePageSchema(schema: PageSchema): { ok: true } | { ok: false; error: string }`（每个 widget.type 必须在 registry 内，`bind` 只能匹配 `^[a-zA-Z0-9_.]+$`，禁止任意代码）
  - `<PageComposer schema={...} state={...} onAction={...} />`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../src/composer/validate.js';

describe('validatePageSchema', () => {
  it('accepts known widgets', () => {
    expect(validatePageSchema({ page: 'home', layout: { type: 'grid', columns: 1 }, widgets: [{ id: 'u', type: 'file-upload', bind: 'documents' }] })).toEqual({ ok: true });
  });
  it('rejects unknown widget type', () => {
    expect(validatePageSchema({ widgets: [{ id: 'x', type: 'evil' }] })).toMatchObject({ ok: false });
  });
  it('rejects code-like bind', () => {
    expect(validatePageSchema({ widgets: [{ id: 'x', type: 'file-upload', bind: 'global.process' }] })).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`validate.ts`：

```ts
import type { PageSchema } from '@sparkii/config';
import { widgetRegistry } from './registry.js';

export function validatePageSchema(schema: PageSchema): { ok: true } | { ok: false; error: string } {
  const widgets = (schema.widgets as Array<{ id?: string; type?: string; bind?: string }>) ?? [];
  for (const w of widgets) {
    if (!w.type || !(w.type in widgetRegistry)) return { ok: false, error: `unknown widget: ${w.type}` };
    if (w.bind && !/^(documents|workflow|chat)(\.[a-zA-Z0-9_]+)*$/.test(w.bind)) return { ok: false, error: `invalid bind: ${w.bind}` };
  }
  return { ok: true };
}
```

`registry.tsx`：

```tsx
import type { ComponentType } from 'react';

export interface WidgetProps { id: string; bind?: string; action?: string; state: Record<string, unknown>; onAction(action: string): void }

export function getByPath(state: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return state;
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[key] : undefined,
    state,
  );
}

function FileUpload(props: WidgetProps) {
  return <button data-testid={props.id} onClick={() => props.onAction('documents.upload')}>选择合同</button>;
}
function ActionButton(props: WidgetProps) {
  return <button data-testid={props.id} onClick={() => props.onAction(props.action ?? '')}>{props.id}</button>;
}
function Table(props: WidgetProps) {
  const value = getByPath(props.state, props.bind);
  const rows = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  return (
    <table>
      {rows.map((r, i) => (
        <tr key={i}>
          {r && typeof r === 'object'
            ? Object.values(r as Record<string, unknown>).map((v, j) => <td key={j}>{String(v)}</td>)
            : <td>{String(r)}</td>}
        </tr>
      ))}
    </table>
  );
}
function DocPreview(props: WidgetProps) {
  return <pre>{JSON.stringify(getByPath(props.state, props.bind), null, 2)}</pre>;
}
function ChatPanel(props: WidgetProps) {
  return <div data-testid={props.id}>chat</div>;
}
function ApprovalPanel(props: WidgetProps) {
  return <div data-testid={props.id}>approval</div>;
}

export const widgetRegistry: Record<string, ComponentType<WidgetProps>> = {
  'file-upload': FileUpload,
  'action-button': ActionButton,
  'table': Table,
  'doc-preview': DocPreview,
  'chat-panel': ChatPanel,
  'approval-panel': ApprovalPanel,
};
```

`PageComposer.tsx`：

```tsx
import type { PageSchema } from '@sparkii/config';
import { widgetRegistry, type WidgetProps } from './registry.js';

export function PageComposer(props: { schema: PageSchema; state: Record<string, unknown>; onAction(a: string): void }) {
  const widgets = (props.schema.widgets as Array<WidgetProps>) ?? [];
  return (
    <div className="page" data-page={props.schema.page}>
      {widgets.map((w) => {
        const Widget = widgetRegistry[w.type as keyof typeof widgetRegistry];
        return <Widget key={w.id} {...w} state={props.state} onAction={props.onAction} />;
      })}
    </div>
  );
}
```

`apps/desktop/package.json` 建立 React + Vite + Vitest + jsdom 配置（见 Task 24）。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/composer apps/desktop/test/composer.test.tsx
git commit -m "feat(desktop): widget registry and JSON-schema page composer"
```

### Task 24: preload contextBridge 类型化 IPC

**Files:**
- Create: `apps/desktop/electron/preload/api.ts`、`apps/desktop/electron/preload/index.ts`、`apps/desktop/src/types/sparkii-api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`（只测纯工厂 `buildApi`，不加载 electron）

**Interfaces:**
- Consumes: `ResolvedProfile`（config）、`Proposal`（approval）、`AuditEvent`（approval）、`WorkflowEvent`（agent-host）。
- Produces:
  - `interface SparkiiApi { login(username, password): Promise<{ userId: string; roles: string[] }>; getProfile(): Promise<unknown>; chooseDocument(): Promise<{ path?: string }>; runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean }>; exportReport(input: { title: string; sections: Array<{ heading: string; body: string }> }): Promise<unknown>; prompt(text: string): Promise<{ ok: boolean }>; listPendingApprovals(): Promise<unknown[]>; decideApproval(id: string, approved: boolean, note?: string): Promise<unknown>; queryAudit(filter: object): Promise<unknown[]>; on(channel: string, cb: (payload: unknown) => void): () => void }`
  - `export function buildApi(ipc: IpcLike): SparkiiApi`（纯函数，不 import electron）；`index.ts` 只做 `contextBridge.exposeInMainWorld('sparkii', buildApi(ipcRenderer))`。身份（登录用户）由 Main 持有，Renderer 不传身份。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildApi } from '../electron/preload/api.js';

describe('sparkii api shape', () => {
  it('exposes the expected method names', () => {
    const names = ['login', 'getProfile', 'chooseDocument', 'runWorkflow', 'exportReport', 'prompt', 'listPendingApprovals', 'decideApproval', 'queryAudit', 'on'];
    const api = buildApi({ invoke: () => Promise.resolve(null), on: () => () => {}, removeListener: () => {} } as any);
    for (const n of names) expect(typeof (api as any)[n]).toBe('function');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`src/types/sparkii-api.ts`：

```ts
export interface SparkiiApi {
  login(username: string, password: string): Promise<{ userId: string; roles: string[] }>;
  getProfile(): Promise<unknown>;
  chooseDocument(): Promise<{ path?: string }>;
  runWorkflow(id: string, input: Record<string, unknown>): Promise<{ ok: boolean }>;
  exportReport(input: { title: string; sections: Array<{ heading: string; body: string }> }): Promise<unknown>;
  prompt(text: string): Promise<{ ok: boolean }>;
  listPendingApprovals(): Promise<unknown[]>;
  decideApproval(id: string, approved: boolean, note?: string): Promise<unknown>;
  queryAudit(filter: object): Promise<unknown[]>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}
```

`electron/preload/api.ts`：

```ts
import type { SparkiiApi } from '../../src/types/sparkii-api.js';

export type IpcLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (e: unknown, payload: unknown) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
};

export function buildApi(ipc: IpcLike): SparkiiApi {
  const invoke = (name: string, ...args: unknown[]) => ipc.invoke(`sparkii:${name}`, ...args);
  return {
    login: (username, password) => invoke('login', username, password) as Promise<{ userId: string; roles: string[] }>,
    getProfile: () => invoke('getProfile'),
    chooseDocument: () => invoke('chooseDocument') as Promise<{ path?: string }>,
    runWorkflow: (id, input) => invoke('runWorkflow', id, input) as Promise<{ ok: boolean }>,
    exportReport: (input) => invoke('exportReport', input),
    prompt: (text) => invoke('prompt', text) as Promise<{ ok: boolean }>,
    listPendingApprovals: () => invoke('listPendingApprovals'),
    decideApproval: (id, approved, note) => invoke('decideApproval', id, approved, note),
    queryAudit: (filter) => invoke('queryAudit', filter),
    on: (channel, cb) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(`sparkii:event:${channel}`, listener);
      return () => ipc.removeListener(`sparkii:event:${channel}`, listener as any);
    },
  };
}
```

`electron/preload/index.ts`：

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { buildApi, type IpcLike } from './api.js';

contextBridge.exposeInMainWorld('sparkii', buildApi(ipcRenderer as unknown as IpcLike));
```

`apps/desktop/src/vite-env.d.ts`：

```ts
import type { SparkiiApi } from './types/sparkii-api.js';
declare global { interface Window { sparkii: SparkiiApi } }
export {};
```

- [ ] **Step 4: 运行确认通过**（测试只 import `api.ts`，不触发 `electron` 顶层调用）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/preload apps/desktop/src/types apps/desktop/test/preload-api.test.ts
git commit -m "feat(desktop): typed contextBridge preload API"
```

### Task 25: Main 装配（窗口 + IPC + 密钥 + 数据目录 + 审批闭环）

**Files:**
- Create: `apps/desktop/electron/main/index.ts`、`apps/desktop/electron/main/ipc.ts`、`apps/desktop/electron/main/workflow.ts`、`apps/desktop/electron/main/keyring.ts`、`apps/desktop/electron/main/runtime.ts`

**Interfaces:**
- Consumes: 全部包（config/model-router/identity/approval/agent-host/theme）。
- Produces:
  - `interface Runtime { profile; router; rbac; gate; executor; audit; supervisor; identity: LocalIdentityProvider; subject: Subject | null }` 与 `assemble(opts): Promise<Runtime>`
  - `class Keyring { constructor(dir, ss = safeStorage); set(name, value): Promise<void>; get(name): Promise<string | null> }`
  - `createBroker(rt, getWindow)`（审批请求 → 提交 + 弹窗 + 等待决定/超时）与 `runWorkflow(rt, getWindow, input)`（接 LinearRunner）
  - `app.whenReady()`：创建 BrowserWindow（`contextIsolation:true, nodeIntegration:false, sandbox:true, preload`），注册 `ipc.ts`。**审批人身份只来自 Main 持有的 `rt.subject`，Renderer 不传身份。**

- [ ] **Step 1: 写失败测试**（只测 Keyring 纯逻辑，用假 safeStorage）

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Keyring } from '../electron/main/keyring.js';

describe('Keyring', () => {
  it('roundtrips encrypted secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-'));
    const fakeSafeStorage = { encryptString: (s: string) => Buffer.from(s).toString('base64'), decryptString: (b: Buffer) => b.toString('utf8') };
    const k = new Keyring(dir, fakeSafeStorage as any);
    await k.set('api', 'secret123');
    expect(await k.get('api')).toBe('secret123');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`keyring.ts`：

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export class Keyring {
  constructor(private dir: string, private ss = safeStorage) {}
  private file(name: string) { return join(this.dir, `${name}.enc`); }
  async set(name: string, value: string): Promise<void> {
    const enc = this.ss.encryptString(value).toString('base64');
    await writeFile(this.file(name), enc);
  }
  async get(name: string): Promise<string | null> {
    try {
      const enc = Buffer.from(await readFile(this.file(name), 'utf8'), 'base64');
      return this.ss.decryptString(enc);
    } catch { return null; }
  }
}
```

`runtime.ts`：

```ts
import { join } from 'node:path';
import { loadProfile } from '@sparkii/config';
import { ModelRouter, normalizeRouting } from '@sparkii/model-router';
import { Rbac, LocalIdentityProvider, type Subject } from '@sparkii/identity';
import { ApprovalGate, ConnectorExecutor, AuditStore } from '@sparkii/approval';
import { PiProcessSupervisor } from '@sparkii/agent-host';
import { knowledgeConnector } from '@sparkii/connectors';

export interface Runtime {
  profile: Awaited<ReturnType<typeof loadProfile>>;
  router: ModelRouter; rbac: Rbac; gate: ApprovalGate; executor: ConnectorExecutor; audit: AuditStore;
  supervisor: PiProcessSupervisor; identity: LocalIdentityProvider; subject: Subject | null;
}

export async function assemble(opts: { profileDir: string; dataDir: string; publicKey?: string; allowUnsigned?: boolean }): Promise<Runtime> {
  const profile = await loadProfile(opts.profileDir, { publicKey: opts.publicKey, allowUnsigned: opts.allowUnsigned });
  const router = new ModelRouter(normalizeRouting(profile.manifest.modelRouting.tasks));
  const rbac = new Rbac(profile.security.roles);
  const audit = new AuditStore(join(opts.dataDir, 'audit.db'));
  const gate = new ApprovalGate({ policy: profile.security.approval, rbac, audit });
  const executor = new ConnectorExecutor(audit);
  const identity = new LocalIdentityProvider(join(opts.dataDir, 'users.json'));
  if ((await identity.listUsers()).length === 0) {
    await identity.seed({ id: 'admin', username: 'admin', password: 'admin123', roles: ['admin', 'reviewer'] });
  }
  await knowledgeConnector.init({ corpus: profile.agent.knowledge });
  return { profile, router, rbac, gate, executor, audit, supervisor: new PiProcessSupervisor(), identity, subject: null };
}
```

`workflow.ts`（审批 broker + LinearRunner 接线；读工具在 Main 直调，写工具走 broker）：

```ts
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { LinearRunner, type RunContext } from '@sparkii/agent-host';
import { documentConnector, knowledgeConnector, reportConnector, type ToolDef } from '@sparkii/connectors';
import type { ProposalRequest } from '@sparkii/approval';
import type { Runtime } from './runtime.js';

export interface Decision { approved: boolean; proposalId: string; status: string; result?: unknown }

const allTools = new Map<string, ToolDef>(
  [documentConnector, knowledgeConnector, reportConnector].flatMap((c) => c.tools.map((t) => [t.name, t] as const)),
);

export function createBroker(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const resolvers = new Map<string, { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    async request(req: ProposalRequest, sessionId: string): Promise<Decision> {
      const p = await rt.gate.submit(req, { profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent' });
      getWindow()?.webContents.send('sparkii:event:approval', p);
      return new Promise<Decision>((resolve) => {
        const timer = setTimeout(() => {
          rt.gate.expire(p.id).then((expired) => {
            resolve({ approved: false, proposalId: p.id, status: expired?.status ?? 'expired' });
            resolvers.delete(p.id);
          });
        }, rt.profile.security.approval.timeoutMs);
        resolvers.set(p.id, { resolve, timer });
      });
    },
    decide(id: string, decision: Omit<Decision, 'proposalId'>) {
      const entry = resolvers.get(id);
      if (entry) { clearTimeout(entry.timer); entry.resolve({ ...decision, proposalId: id }); resolvers.delete(id); }
    },
  };
}

async function sendPrompt(rt: Runtime, text: string): Promise<string> {
  const client = await rt.supervisor.start();
  let acc = '';
  let off = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('prompt timeout')); }, 300_000);
    off = client.onEvent((e) => {
      if (e.type === 'message' && e.role === 'assistant') acc += e.delta ?? e.text ?? '';
      if (e.type === 'agent_end') { clearTimeout(timeout); off(); resolve(); }
    });
  });
  await client.send({ type: 'prompt', message: text });
  await done;
  return acc;
}

async function runTool(rt: Runtime, broker: ReturnType<typeof createBroker>, toolName: string, args: unknown, sessionId: string) {
  const tool = allTools.get(toolName);
  if (!tool) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: toolName } };
  if (tool.sideEffect === 'read') {
    return tool.handler(args as Record<string, unknown>, {
      profileId: rt.profile.manifest.name, sessionId, actor: rt.subject?.userId ?? 'agent', requestId: randomUUID(),
    });
  }
  const d = await broker.request({
    toolName, targetSystem: toolName.split('.')[0], summary: JSON.stringify(args).slice(0, 512), payload: args, risk: tool.sideEffect,
  }, sessionId);
  return { ok: d.approved, data: d.result };
}

export async function runWorkflow(rt: Runtime, getWindow: () => BrowserWindow | null, input: Record<string, unknown>): Promise<void> {
  const def = rt.profile.agent.workflow as unknown as { version: 1; engine: 'linear'; steps: unknown[] };
  const broker = createBroker(rt, getWindow);
  const ctx: RunContext = {
    profileId: rt.profile.manifest.name, sessionId: 'default', actor: rt.subject?.userId ?? 'agent', input,
    sendPrompt: (text) => sendPrompt(rt, text),
    runTool: (name, args) => runTool(rt, broker, name, args, 'default'),
    requestApproval: async (req) => {
      const d = await broker.request(req, 'default');
      return { id: d.proposalId, status: d.approved ? 'approved' : 'denied' } as any;
    },
  };
  const win = getWindow();
  let finalState: Record<string, unknown> = {};
  for await (const e of new LinearRunner().run(def, ctx)) {
    win?.webContents.send('sparkii:event:workflow', e);
    if (e.type === 'workflow_completed') finalState = e.result as Record<string, unknown>;
  }
  win?.webContents.send('sparkii:event:state', { workflow: { result: finalState } });
}
```

`ipc.ts`：

```ts
import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { ControlServer } from '@sparkii/agent-host';
import { createBroker, runWorkflow } from './workflow.js';
import type { Runtime } from './runtime.js';

export function registerIpc(rt: Runtime, getWindow: () => BrowserWindow | null) {
  const broker = createBroker(rt, getWindow);
  const control = new ControlServer({ onProposal: (req) => broker.request(req, 'default') });
  control.start().then(({ url, token }) => {
    process.env.SPARKII_CONTROL_URL = url;
    process.env.SPARKII_CONTROL_TOKEN = token;
  });

  ipcMain.handle('sparkii:login', async (_e, username: string, password: string) => {
    rt.subject = await rt.identity.authenticate(username, password);
    return { userId: rt.subject.userId, roles: rt.subject.roles };
  });
  ipcMain.handle('sparkii:getProfile', () => ({ manifest: rt.profile.manifest, pages: rt.profile.ui.pages, theme: rt.profile.ui.theme, tools: rt.profile.agent.tools }));
  ipcMain.handle('sparkii:chooseDocument', async () => {
    if (process.env.SPARKII_E2E_DOCUMENT) return { path: process.env.SPARKII_E2E_DOCUMENT };
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '文档', extensions: ['pdf', 'docx', 'xlsx', 'txt', 'md'] }] })
      : { canceled: true, filePaths: [] as string[] };
    return result.canceled ? { } : { path: result.filePaths[0] };
  });
  ipcMain.handle('sparkii:listPendingApprovals', () => rt.gate.listPending());
  ipcMain.handle('sparkii:decideApproval', async (_e, id: string, approved: boolean, note?: string) => {
    if (!rt.subject) throw new Error('not authenticated');
    let out = await rt.gate.decide(id, rt.subject, approved, note);
    let result: unknown;
    if (out.status === 'approved' && out.toolName !== 'workflow.approval') {
      out = await rt.executor.execute(out, { actor: rt.subject.userId });
      result = out.execution?.result;
    }
    broker.decide(out.id, { approved: out.status === 'approved' || out.status === 'executed', status: out.status, result });
    return out;
  });
  ipcMain.handle('sparkii:queryAudit', (_e, filter: object) => rt.audit.query(filter));
  ipcMain.handle('sparkii:prompt', async (_e, text: string) => {
    const c = await rt.supervisor.start();
    const win = getWindow();
    const done = new Promise<void>((resolve) => {
      const off = c.onEvent((ev) => {
        win?.webContents.send('sparkii:event:chat-event', ev);
        if (ev.type === 'agent_end') { off(); resolve(); }
      });
    });
    await c.send({ type: 'prompt', message: text });
    await done;
    return { ok: true };
  });
  ipcMain.handle('sparkii:runWorkflow', async (_e, _id: string, input: Record<string, unknown>) => {
    await runWorkflow(rt, getWindow, input);
    return { ok: true };
  });
  ipcMain.handle('sparkii:exportReport', async (_e, input: { title: string; sections: Array<{ heading: string; body: string }> }) => {
    if (!rt.subject) throw new Error('not authenticated');
    let filePath: string | undefined;
    if (process.env.SPARKII_E2E_EXPORT_DIR) {
      filePath = `${process.env.SPARKII_E2E_EXPORT_DIR}/report.docx`;
    } else {
      const win = getWindow();
      const r = win
        ? await dialog.showSaveDialog(win, { defaultPath: `${input.title || 'report'}.docx` })
        : { canceled: true, filePath: undefined };
      if (r.canceled || !r.filePath) return { ok: false, status: 'canceled' };
      filePath = r.filePath;
    }
    const d = await broker.request({
      toolName: 'report.export', targetSystem: 'report', summary: `导出报告到 ${filePath}`,
      payload: { ...input, format: 'docx', path: filePath }, risk: 'write',
    }, 'default');
    return { ok: d.approved, proposalId: d.proposalId, status: d.status, result: d.result };
  });
}
```

`index.ts`：

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { assemble, type Runtime } from './runtime.js';
import { registerIpc } from './ipc.js';

let rt: Runtime;
let win: BrowserWindow | null = null;

app.whenReady().then(async () => {
  const dataDir = process.env.SPARKII_DATA_DIR ?? join(app.getPath('userData'), 'data');
  rt = await assemble({ profileDir: process.env.SPARKII_PROFILE_DIR ?? 'profiles/contract-review', dataDir, allowUnsigned: process.env.NODE_ENV !== 'production' });
  win = new BrowserWindow({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, '../preload/index.js') },
  });
  registerIpc(rt, () => win);
  if (process.env.VITE_DEV_SERVER_URL) await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(join(__dirname, '../../dist/index.html'));
});
```

`apps/desktop/package.json` 加 `dependencies`（全部 workspace 包 + electron）与 `devDependencies`（vite/react 等）。

- [ ] **Step 4: 运行确认通过**（`pnpm --filter @sparkii/desktop test`，只测 Keyring；workflow/ipc 在 M9 E2E 验证）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron apps/desktop/package.json
git commit -m "feat(desktop): Electron main wiring, keyring, data dir, approval broker, and IPC"
```

### Task 26: 对话工作台 + 审批 UI + 审计视图 + App 装配

**Files:**
- Create: `apps/desktop/src/workbench/ChatWorkbench.tsx`、`apps/desktop/src/approval/ApprovalDialog.tsx`、`apps/desktop/src/audit/AuditView.tsx`、`apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `SparkiiApi`（Task 24）、`DesignTokens`（theme）。
- Produces: 三个可挂载组件；`ChatWorkbench` 订阅 `sparkii.on('chat-event')` 流式渲染；`ApprovalDialog` 显示载荷摘要/倒计时/批准拒绝；`AuditView` 表格化审计。

- [ ] **Step 1: 写冒烟测试**（渲染不崩溃）

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalDialog } from '../src/approval/ApprovalDialog.js';

describe('ApprovalDialog', () => {
  it('renders pending proposal summary', () => {
    render(<ApprovalDialog proposal={{ id: 'p1', summary: '导出报告', risk: 'write', payloadHash: 'h' } as any} onDecide={() => {}} />);
    expect(screen.getByText('导出报告')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**（关键逻辑，样式由主题 token 驱动）

`ApprovalDialog.tsx`：

```tsx
import { useEffect, useRef } from 'react';

export function ApprovalDialog(props: { proposal: { id: string; summary: string; risk: string; payloadHash: string; createdAt: number }; timeoutMs?: number; onDecide(id: string, approved: boolean, note?: string): void }) {
  const note = useRef('');
  useEffect(() => {
    if (!props.timeoutMs) return;
    const t = setTimeout(() => props.onDecide(props.proposal.id, false, 'timeout'), props.timeoutMs);
    return () => clearTimeout(t);
  }, [props.timeoutMs]);
  return (
    <div role="dialog" aria-label="approval">
      <p>{props.proposal.summary}</p>
      <p className="muted">risk: {props.proposal.risk} · {props.proposal.payloadHash.slice(0, 12)}</p>
      <textarea onChange={(e) => (note.current = e.target.value)} placeholder="审批意见" />
      <button onClick={() => props.onDecide(props.proposal.id, true, note.current)}>批准</button>
      <button onClick={() => props.onDecide(props.proposal.id, false, note.current)}>拒绝</button>
    </div>
  );
}
```

`ChatWorkbench.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const [items, setItems] = useState<Array<{ role: string; text?: string; tool?: string }>>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => props.api.on('chat-event', (p) => setItems((xs) => [...xs, p as any])), [props.api]);
  return (
    <div>
      <div>{items.map((m, i) => <div key={i}>{m.role}: {m.text ?? m.tool}</div>)}</div>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { props.api.prompt(draft); setDraft(''); }}>发送</button>
    </div>
  );
}
```

`AuditView.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

export function AuditView(props: { api: SparkiiApi }) {
  const [rows, setRows] = useState<unknown[]>([]);
  useEffect(() => { props.api.queryAudit({}).then(setRows); }, [props.api]);
  return <table>{rows.map((r: any, i) => <tr key={i}><td>{r.ts}</td><td>{r.actor}</td><td>{r.action}</td><td>{r.resource}</td></tr>)}</table>;
}
```

`App.tsx`（登录 → 状态订阅 → 页面组合 / 对话 / 审批 / 审计；action 分发到 `runWorkflow` 与 `exportReport`）：

```tsx
import { useEffect, useState } from 'react';
import { PageComposer } from './composer/PageComposer.js';
import { validatePageSchema } from './composer/validate.js';
import { ChatWorkbench } from './workbench/ChatWorkbench.js';
import { ApprovalDialog } from './approval/ApprovalDialog.js';
import { AuditView } from './audit/AuditView.js';

export function App() {
  const api = window.sparkii;
  const [authed, setAuthed] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<any>(null);
  const [state, setState] = useState<Record<string, unknown>>({ documents: [] });
  const [pending, setPending] = useState<any[]>([]);
  const [auditVersion, setAuditVersion] = useState(0);

  useEffect(() => api.on('state', (s) => setState(s as Record<string, unknown>)), [api]);
  useEffect(() => api.on('approval', (p) => setPending((xs) => [...xs, p])), [api]);

  const refreshApprovals = () => api.listPendingApprovals().then((xs) => setPending(xs as any[]));

  const login = async () => {
    await api.login(username, password);
    setAuthed(true);
    setProfile(await api.getProfile());
    await refreshApprovals();
  };

  const onAction = async (action: string) => {
    if (action === 'documents.upload') {
      const { path } = await api.chooseDocument();
      if (path) setState((s) => ({ ...s, documents: [path] }));
    }
    if (action === 'run-workflow:contract-review') api.runWorkflow('contract-review', { documents: state.documents });
    if (action === 'export-report') {
      const body = ((state.workflow as any)?.result?.report) ?? '';
      api.exportReport({ title: '审核报告', sections: [{ heading: '报告', body: String(body) }] });
    }
  };

  if (!authed) {
    return (
      <div>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>登录</button>
      </div>
    );
  }

  const page = profile?.pages?.['home'];
  return (
    <div>
      {page && validatePageSchema(page).ok ? <PageComposer schema={page} state={state} onAction={onAction} /> : null}
      <ChatWorkbench api={api} />
      {pending.map((p) => (
        <ApprovalDialog key={p.id} proposal={p} onDecide={(id, ok, note) => { api.decideApproval(id, ok, note).then(() => { refreshApprovals(); setAuditVersion((v) => v + 1); }); }} />
      ))}
      <AuditView key={auditVersion} api={api} />
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench apps/desktop/src/approval apps/desktop/src/audit apps/desktop/src/App.tsx
git commit -m "feat(desktop): chat workbench, approval dialog, audit view, and app shell"
```

### Task 27: 合同审核 profile 资产

**Files:**
- Create: `profiles/contract-review/manifest.yaml`、`agent/skills.yaml`、`agent/tools.yaml`、`agent/prompts/clause_extract.md`、`agent/prompts/risk_compare.md`、`agent/prompts/report.md`、`agent/workflow.yaml`、`agent/knowledge/corpus.json`、`ui/pages/home.json`、`ui/theme.yaml`、`ui/theme/tokens.json`、`security/roles.yaml`、`security/approval.yaml`

**Interfaces:**
- Consumes: `WorkflowDef`（Task 21）、`PageSchema`（Task 23）、`RoleConfig`/`ApprovalPolicy`（config）。
- Produces: 一个可被 `loadProfile('profiles/contract-review')` 加载的完整 profile；`manifest.yaml` 的 `modelRouting.tasks.default = [{provider: local, modelId: qwen2.5:7b}]`。

- [ ] **Step 1: 写加载测试**（复用 config loader，验证资产自洽）

```ts
import { describe, it, expect } from 'vitest';
import { loadProfile } from '@sparkii/config';
import { resolve } from 'node:path';

describe('contract-review profile', () => {
  it('loads without signature in dev mode', async () => {
    const p = await loadProfile(resolve(__dirname, '../../../profiles/contract-review'), { allowUnsigned: true });
    expect(p.agent.tools).toContain('report.export');
    expect(p.security.approval.requireApproval).toContain('report.export');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`manifest.yaml`：

```yaml
name: contract-review
version: 1.0.0
modelRouting:
  tasks:
    default:
      - { provider: local, modelId: qwen2.5:7b }
    report:
      - { provider: local, modelId: qwen2.5:14b }
      - { provider: local, modelId: qwen2.5:7b }
```

`agent/tools.yaml`：

```yaml
tools:
  - document.read
  - knowledge.search
  - report.export
```

`agent/skills.yaml`：

```yaml
- { name: clause_extract, file: prompts/clause_extract.md }
- { name: risk_compare, file: prompts/risk_compare.md }
```

`agent/prompts/clause_extract.md`：

```text
从给定合同文本中抽取关键条款（标的、金额、付款、违约责任、争议解决、保密、验收）。
输出严格 JSON：{"clauses":[{"type":"...","summary":"...","risk":"low|medium|high","reason":"..."}]}
```

`agent/prompts/risk_compare.md`：

```text
对比抽取条款与检索到的法规条款，逐条给出风险等级与依据。
输出严格 JSON：{"comparisons":[{"clause":"...","regulation":"...","level":"low|medium|high","advice":"..."}]}
```

`agent/prompts/report.md`：

```text
将风险比对结果组织为结构化审核报告章节（结论、风险明细、修改建议、复核意见）。
```

`agent/workflow.yaml`：

```yaml
version: 1
engine: linear
steps:
  - { id: load,    type: tool,  ref: document.read, map: { documents: documents } }
  - { id: search,  type: tool,  ref: knowledge.search, map: { query: load.text } }
  - { id: extract, type: skill, ref: clause_extract, inputs: { from: load } }
  - { id: compare, type: skill, ref: risk_compare, inputs: { from: [extract, search] } }
  - { id: report,  type: llm,   template: report, inputs: { from: [extract, compare] } }
  - { id: review,  type: human, inputs: { from: report } }
```

`agent/knowledge/corpus.json`（法规知识库示例，正式版由客户侧替换）：

```json
[
  { "id": "reg-1", "text": "买卖合同付款期限未约定的，买受人应当在收到标的物时支付。" },
  { "id": "reg-2", "text": "逾期付款违约金不得超过因违约造成的实际损失。" }
]
```

`ui/pages/home.json`：

```json
{
  "page": "contract-review/home",
  "layout": { "type": "grid", "columns": 2 },
  "widgets": [
    { "id": "upload", "type": "file-upload", "bind": "documents" },
    { "id": "review", "type": "action-button", "action": "run-workflow:contract-review" },
    { "id": "risk", "type": "table", "bind": "workflow.result.compare" },
    { "id": "report", "type": "doc-preview", "bind": "workflow.result.report" },
    { "id": "export", "type": "action-button", "action": "export-report" }
  ]
}
```

`ui/theme.yaml`：

```yaml
file: theme/tokens.json
```

`ui/theme/tokens.json`：

```json
{ "color": { "primary": "#0F766E", "surface": "#FFFFFF" }, "spacing": { "md": "8px" }, "radius": { "md": "6px" }, "shadow": { "md": "0 1px 2px rgba(0,0,0,.2)" }, "font": { "body": "system-ui, sans-serif" } }
```

`security/roles.yaml`：

```yaml
roles:
  - name: reviewer
    pages: [home]
    tools: [document.read, knowledge.search]
    canApprove: [write]
  - name: admin
    pages: [home, audit]
    tools: [document.read, knowledge.search, report.export]
    canApprove: [write, high-risk]
```

`security/approval.yaml`：

```yaml
requireApproval:
  - report.export
timeoutMs: 300000
highRiskDoubleConfirm: true
```

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**

```bash
git add profiles/contract-review packages/agent-host/test/profile.test.ts
git commit -m "feat(profiles): contract-review pilot profile assets"
```

（profile 测试放在 `packages/agent-host/test/profile.test.ts`，与主 profile 一起提交。）

---

## M9 — 打包 + E2E + pilot 验收

### Task 28: electron-builder 打包（NSIS/MSIX + 原生依赖重建）

**Files:**
- Create: `apps/desktop/electron-builder.yml`

**Interfaces:**
- Consumes: `apps/desktop` 构建产物。
- Produces: Windows NSIS + MSIX 安装包；`postinstall: electron-builder install-app-deps` 重建 `better-sqlite3`。

- [ ] **Step 1: 写配置**

```yaml
appId: com.sparkii.desktop
productName: Sparkii
directories:
  output: out
files:
  - dist/**
  - electron/**
  - package.json
asar: true
win:
  target:
    - nsis
    - appx
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
extraMetadata:
  main: electron/main/index.js
```

- [ ] **Step 2: 写打包脚本**

Update `apps/desktop/package.json`：

```json
{
  "scripts": {
    "build:renderer": "vite build",
    "build:main": "tsc -p tsconfig.electron.json",
    "dist": "pnpm build:renderer && pnpm build:main && electron-builder --win nsis appx",
    "postinstall": "electron-builder install-app-deps"
  }
}
```

- [ ] **Step 3: 构建验证**

Run: `pnpm --filter @sparkii/desktop dist`
Expected: `out/` 下出现 `.exe`（NSIS）与 `.appx`（MSIX；正式分发需企业签名）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/package.json
git commit -m "build(desktop): electron-builder NSIS/MSIX packaging"
```

### Task 29: E2E（Playwright + Electron）跑通 pilot 验收

**Files:**
- Create: `apps/desktop/e2e/pilot.spec.ts`

**Interfaces:**
- Consumes: 打包产物 + 合同审核 profile。
- Produces: 一条可复现的验收测试。

- [ ] **Step 1: 写测试**

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('contract review pilot acceptance', async () => {
  const fixture = join(mkdtempSync(join(tmpdir(), 'pilot-')), 'contract.txt');
  writeFileSync(fixture, '合同标的：设备采购。付款：验收后 30 日。违约责任：逾期按日万分之五。');
  const dataDir = mkdtempSync(join(tmpdir(), 'pilot-data-'));
  const exportDir = mkdtempSync(join(tmpdir(), 'pilot-export-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: {
      ...process.env,
      SPARKII_PROFILE_DIR: 'profiles/contract-review',
      SPARKII_DATA_DIR: dataDir,
      SPARKII_E2E_DOCUMENT: fixture,
      SPARKII_E2E_EXPORT_DIR: exportDir,
    },
  });
  const page = await app.firstWindow();
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('admin123');
  await page.getByText('登录').click();
  await page.getByTestId('upload').click();
  await page.getByTestId('review').click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 120000 });
  await page.getByRole('button', { name: '批准' }).click();
  await expect(page.getByText(/proposal.approved/)).toBeVisible();
  await app.close();
});
```

- [ ] **Step 2: 运行（有本地模型时）** `pnpm --filter @sparkii/desktop exec playwright test`；无模型时跳过（`test.skip(process.env.SPARKII_SKIP_LLM === '1')`）

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/e2e
git commit -m "test(desktop): Playwright Electron pilot acceptance"
```

### Task 30: 数据目录隔离 + 离线包说明

**Files:**
- Create: `apps/desktop/electron/main/paths.ts`
- Create: `docs/deploy.md`

**Interfaces:**
- Consumes: 无。
- Produces: `dataDirFor(userId: string): string`（`<appData>/sparkii/data/<userId>`）；离线安装说明（应用 + Pi 运行时 + Ollama 运行时，模型权重另发）。

- [ ] **Step 1: 实现 `paths.ts`**

```ts
import { join } from 'node:path';
import { app } from 'electron';

export function dataDirFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(app.getPath('userData'), 'data', safe);
}
```

- [ ] **Step 2: 写离线部署说明**（`docs/deploy.md`：Pi 二进制内置、Ollama 运行时可选离线包、模型权重按需另发、profile 签名侧载）

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/electron/main/paths.ts docs/deploy.md
git commit -m "docs(deploy): per-user data dir isolation and offline packaging notes"
```

---

### Task 31: 错误处理与可观测性（spec 8.5 收口）

**Files:**
- Create: `apps/desktop/electron/main/logger.ts`、`apps/desktop/electron/main/recovery.ts`
- Test: `apps/desktop/test/logger.test.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`（加 `sparkii:diagnostics`，启动时装配 logger/recovery）

**Interfaces:**
- Consumes: `Runtime`（Task 25）、`PiRpcClient`（Task 16）。
- Produces:
  - `class Logger { constructor(dir: string); log(entry: { level: 'info'|'warn'|'error'; msg: string; ctx?: Record<string, unknown> }): Promise<void>; export(): Promise<string> }`
  - `attachRecovery(rt: Runtime, logger: Logger): void`（Pi 非零退出时指数退避重启，重启后 `set_auto_retry`/`set_auto_compaction`，并 `switch_session` 恢复会话）
  - `sparkii:diagnostics` 返回 `{ logs: string; audit: string }`（结构化日志 + 审计可导出）。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Logger } from '../electron/main/logger.js';

describe('Logger', () => {
  it('appends structured jsonl and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const l = new Logger(dir);
    await l.log({ level: 'info', msg: 'start', ctx: { profile: 'contract-review' } });
    const exported = await l.export();
    expect(JSON.parse(exported.trim().split('\n')[0]).msg).toBe('start');
  });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`logger.ts`：

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class Logger {
  constructor(private dir: string) {}
  private file() { return join(this.dir, 'sparkii.log.jsonl'); }
  async log(entry: { level: 'info' | 'warn' | 'error'; msg: string; ctx?: Record<string, unknown> }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  }
  async export(): Promise<string> {
    try { return await readFile(this.file(), 'utf8'); } catch { return ''; }
  }
}
```

`recovery.ts`：

```ts
import type { Runtime } from './runtime.js';
import type { Logger } from './logger.js';

export function attachRecovery(rt: Runtime, logger: Logger): void {
  let attempts = 0;
  rt.supervisor.onExit(async (code) => {
    if (code === 0) return;
    const delay = Math.min(1000 * 2 ** attempts, 30_000);
    attempts += 1;
    await logger.log({ level: 'error', msg: 'pi process exited', ctx: { code, retryInMs: delay } });
    setTimeout(async () => {
      const c = await rt.supervisor.start();
      await c.send({ type: 'set_auto_retry', enabled: true });
      await c.send({ type: 'set_auto_compaction', enabled: true });
      const sessionFile = process.env.SPARKII_SESSION_FILE;
      if (sessionFile) await c.send({ type: 'switch_session', sessionPath: sessionFile });
    }, delay);
  });
}
```

在 `registerIpc` 末尾追加：

```ts
  ipcMain.handle('sparkii:diagnostics', async () => ({ logs: await logger.export(), audit: await rt.audit.exportJsonl() }));
```

并在 `index.ts` 的 `app.whenReady()` 中：`const logger = new Logger(join(dataDir, 'logs')); attachRecovery(rt, logger);`，把 `logger` 通过 `registerIpc` 的闭包注入（`registerIpc(rt, () => win, logger)`）。

- [ ] **Step 4: 运行确认通过**（`pnpm --filter @sparkii/desktop test`，只测 Logger）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/logger.ts apps/desktop/electron/main/recovery.ts apps/desktop/test/logger.test.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/index.ts
git commit -m "feat(desktop): structured logging, Pi recovery, and diagnostics export"
```

---

## Deferred（仅接口，不实现）

以下来自 spec 第 7.4/12 节，MVP 只保留类型契约，不写实现：

- `packages/identity/src/types.ts` 已含 `IdentityProvider`；SSO/LDAP/AD 未来各实现该接口，`LocalIdentityProvider` 为 MVP 实例。
- `packages/connectors/src/types.ts` 已含 `Connector`/`ToolDef`；ERP/MES/DCS（B）、外部数据（C）、本地工具（D）未来按同接口实现；写连接器必须走 Task 18 的提议通道。
- `packages/agent-host/src/workflow/types.ts` 已含 `WorkflowRunner`；Dify/完整引擎未来实现同一接口，UI 展示无需改。
- Agent 子进程硬沙箱（容器/微 VM）：预留 `PiProcessSupervisor.opts.args` 扩展，不在 MVP 实现。
- 集中审计采集/留存、防篡改（哈希链/签名追加）、等保/ISO 加固：`AuditStore` 导出接口已留，未来加采集器；不提前实现。

以上接口在对应 Task 中已用具体类型定义锁定；本计划的 Self-Review 确认无 spec 4–11 节的 MVP 需求落到「TODO」。

---

## 执行顺序与验收门

按 M0 → M9 顺序执行；每个 Task 独立可测可提交。验收门：

1. M5 完成：`pnpm --filter @sparkii/approval test` 全绿（含 3 条安全不变量）。
2. M7 完成：`LinearRunner` 事件序列测试通过；`WorkflowRunner` 接口可用于后续 Dify 接入。
3. M9 完成：离线 Windows 包 + Playwright E2E 跑通 spec 第 11 节 pilot 验收：上传合同 → 跑流程 → 得到风险报告 → 对导出/写入审批 → 审计留痕，且被拒绝的写不发生。
