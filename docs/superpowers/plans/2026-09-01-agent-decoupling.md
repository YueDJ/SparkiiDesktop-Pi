# Agent Decoupling & Contract Review Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平台从硬编码智能体中解耦，建立统一 Agent Registry、模型能力目录、session/workspace 恢复和合同审核 workflow surface。

**Architecture:** 平台核心提供 Pi 能力、session、审批、审计、运行池、模型目录和 workspace；每个 Agent 以 manifest + surface + capabilities 的形式注册；`general` 和 `contract-review` 是两个同等级 Agent。

**Tech Stack:** Electron、React、TypeScript、Vite、Vitest、better-sqlite3、pnpm workspace。

**Spec:** [2026-09-01-agent-decoupling-and-contract-review-surface-design.md](../specs/2026-09-01-agent-decoupling-and-contract-review-surface-design.md)

## Global Constraints

- 不直接在 `main` 分支实现；当前分支为 `codex/agent-decoupling`。
- 不新增运行时插件加载或动态 import 任意 profile 代码。
- 中间步骤产出不重复落盘；Pi JSONL 是步骤过程和结果事实源。
- 用户选择不满足 Agent 能力的模型时，允许但警告。
- 所有写操作继续走审批门，拒绝即不执行。
- 现有测试必须保持绿色；新行为先写失败测试再实现。

---

## Task 1: Agent 契约类型与 Manifest Schema

**Files:**
- Create: `packages/config/src/agent.ts`
- Create: `packages/config/test/agent.test.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**
- Produces: `AgentManifest`, `AgentSurfaceDescriptor`, `AgentCapabilitiesDescriptor`, `ModelRequirement`, `parseAgentManifest`.

- [ ] **Step 1: Write failing tests**

```ts
import { parseAgentManifest } from '../src/agent.js';

test('parses a standard chat agent manifest', () => {
  const manifest = parseAgentManifest({
    id: 'general',
    displayName: '通用智能体',
    version: '1.0.0',
    surface: { type: 'chat' },
    capabilities: { tools: ['read', 'bash'] },
    modelRequirements: { requires: ['chat', 'toolCall'] },
  });
  expect(manifest.id).toBe('general');
  expect(manifest.surface.type).toBe('chat');
});

test('accepts a custom surface entry', () => {
  const manifest = parseAgentManifest({
    id: 'contract-review',
    displayName: '合同审核智能体',
    version: '1.0.0',
    surface: { type: 'workflow', entry: 'surface.tsx' },
    capabilities: { tools: ['document.read'] },
    modelRequirements: { requires: ['reasoning'] },
  });
  expect(manifest.surface.entry).toBe('surface.tsx');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @sparkii/config test`
Expected: FAIL because `../src/agent.js` does not exist.

- [ ] **Step 3: Implement types and schema**

```ts
import { z } from 'zod';

export type SurfaceType = 'chat' | 'workflow' | 'dashboard' | 'custom';
export interface AgentSurfaceDescriptor {
  type: SurfaceType;
  entry?: string;
}
export interface AgentCapabilitiesDescriptor {
  entry?: string;
  tools?: string[];
}
export interface ModelRequirement {
  requires: string[];
  prefers?: string[];
}
export interface AgentManifest {
  id: string;
  displayName?: string;
  version: string;
  sortOrder?: number;
  surface: AgentSurfaceDescriptor;
  capabilities: AgentCapabilitiesDescriptor;
  workflow?: string;
  skills?: string;
  prompts?: string;
  security?: { roles?: string; approval?: string };
  modelRequirements?: ModelRequirement;
}

const surfaceSchema = z.object({
  type: z.enum(['chat', 'workflow', 'dashboard', 'custom']),
  entry: z.string().optional(),
});
const capabilitiesSchema = z.object({
  entry: z.string().optional(),
  tools: z.array(z.string()).optional(),
});
const modelRequirementSchema = z.object({
  requires: z.array(z.string()),
  prefers: z.array(z.string()).optional(),
});

export const agentManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sortOrder: z.number().optional(),
  surface: surfaceSchema,
  capabilities: capabilitiesSchema,
  workflow: z.string().optional(),
  skills: z.string().optional(),
  prompts: z.string().optional(),
  security: z.object({ roles: z.string().optional(), approval: z.string().optional() }).optional(),
  modelRequirements: modelRequirementSchema.optional(),
});

export function parseAgentManifest(raw: unknown): AgentManifest {
  return agentManifestSchema.parse(raw);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @sparkii/config test`
Expected: PASS.

- [ ] **Step 5: Export from index**

Add `export * from './agent.js';` to `packages/config/src/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/agent.ts packages/config/test/agent.test.ts packages/config/src/index.ts
git commit -m "feat(config): add agent manifest contract"
```

---

## Task 2: Model Capability Catalog

**Files:**
- Modify: `packages/model-router/src/types.ts`
- Modify: `packages/model-router/src/router.ts`
- Create: `packages/model-router/test/capability.test.ts`

**Interfaces:**
- Produces: `ModelCapability`, `ModelDescriptor`, `findCompatibleModels`, `recommendModel`.

- [ ] **Step 1: Write failing tests**

```ts
import { findCompatibleModels, recommendModel } from '../src/router.js';

test('filters models by required capabilities', () => {
  const models = [
    { provider: 'deepseek', modelId: 'pro', capabilities: ['chat', 'reasoning'] },
    { provider: 'deepseek', modelId: 'flash', capabilities: ['chat', 'fast'] },
  ];
  const result = findCompatibleModels(models as any, { requires: ['reasoning'] });
  expect(result.map((m) => m.modelId)).toEqual(['pro']);
});

test('recommends default when compatible', () => {
  const models = [
    { provider: 'deepseek', modelId: 'pro', capabilities: ['chat', 'reasoning'] },
    { provider: 'deepseek', modelId: 'flash', capabilities: ['chat'] },
  ];
  const result = recommendModel(models as any, { requires: ['chat'] }, 'deepseek/flash');
  expect(result?.modelId).toBe('flash');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @sparkii/model-router test`
Expected: FAIL.

- [ ] **Step 3: Implement capability routing**

```ts
export type ModelCapability = 'chat' | 'reasoning' | 'longContext' | 'vision' | 'fast' | 'toolCall' | 'thinking';
export interface ModelDescriptor {
  provider: string;
  modelId: string;
  capabilities: ModelCapability[];
  thinkingLevels?: string[];
}
export interface ModelRequirement {
  requires: string[];
  prefers?: string[];
}
export function findCompatibleModels(models: ModelDescriptor[], requirement: ModelRequirement): ModelDescriptor[] {
  return models.filter((model) => requirement.requires.every((cap) => model.capabilities.includes(cap as ModelCapability)));
}
export function recommendModel(models: ModelDescriptor[], requirement: ModelRequirement, preferredKey?: string | null): ModelDescriptor | null {
  if (preferredKey) {
    const preferred = models.find((m) => `${m.provider}/${m.modelId}` === preferredKey);
    if (preferred && requirement.requires.every((cap) => preferred.capabilities.includes(cap as ModelCapability))) return preferred;
  }
  return findCompatibleModels(models, requirement)[0] ?? null;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @sparkii/model-router test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model-router/src/types.ts packages/model-router/src/router.ts packages/model-router/test/capability.test.ts
git commit -m "feat(model-router): add capability-based model selection"
```

---

## Task 3: Main 侧 Agent Registry 与 Capabilities

**Files:**
- Create: `apps/desktop/electron/main/agent-registry.ts`
- Create: `apps/desktop/electron/main/agent-capabilities/general.ts`
- Create: `apps/desktop/electron/main/agent-capabilities/contract-review.ts`
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/saddle.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`

**Interfaces:**
- Consumes: `AgentManifest` from Task 1, `ModelDescriptor` from Task 2.
- Produces: `AgentRuntime`, `loadAgentRuntimes`, `resolveAgentCapabilities`, `buildAgentSaddle`.

- [ ] **Step 1: Write failing test for AgentRegistry**

Create `apps/desktop/test/agent-registry.test.ts`:

```ts
import { loadAgentRuntimes } from '../electron/main/agent-registry.js';

test('loads general and contract-review as agents', async () => {
  const agents = await loadAgentRuntimes([
    { id: 'general', manifest: { id: 'general', version: '1.0.0', surface: { type: 'chat' }, capabilities: { tools: ['read'] } } },
    { id: 'contract-review', manifest: { id: 'contract-review', version: '1.0.0', surface: { type: 'workflow', entry: 'surface.tsx' }, capabilities: { tools: ['document.read'] } } },
  ]);
  expect([...agents.keys()].sort()).toEqual(['contract-review', 'general']);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @sparkii/desktop test`
Expected: FAIL.

- [ ] **Step 3: Implement AgentRegistry**

```ts
import type { AgentManifest } from '@sparkii/config';

export interface AgentRuntime {
  id: string;
  manifest: AgentManifest;
  tools: string[];
}

export async function loadAgentRuntimes(inputs: Array<{ id: string; manifest: AgentManifest }>): Promise<Map<string, AgentRuntime>> {
  return new Map(inputs.map(({ id, manifest }) => [id, { id, manifest, tools: manifest.capabilities.tools ?? [] }]));
}
```

- [ ] **Step 4: Wire general and contract-review capabilities**

`general.ts` returns `['read', 'ls', 'grep', 'find', 'bash', 'edit', 'write']`.
`contract-review.ts` returns `['document.read', 'knowledge.search', 'report.export']`.

- [ ] **Step 5: Remove `firstProfileWithKnowledge` and global connector init**

In `runtime.ts`, initialize knowledge only for the contract-review agent runtime. Keep global executor registration for tool handlers but resolve tools per agent.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @sparkii/desktop test`
Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/agent-registry.ts apps/desktop/electron/main/agent-capabilities apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/saddle.ts apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/agent-registry.test.ts
git commit -m "feat(desktop): introduce main agent registry"
```

---

## Task 4: Renderer Surface Registry 与 general 拆分

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/agent/surface-registry.tsx`
- Move/Rename: `apps/desktop/src/surfaces/GeneralChatSurface.tsx` → `apps/desktop/src/surfaces/ChatSurface.tsx`
- Modify: `apps/desktop/src/surfaces/ContractSurface.tsx`
- Modify: `apps/desktop/test/app-general.test.tsx`
- Modify: `apps/desktop/test/contract-surface.test.tsx`

**Interfaces:**
- Consumes: `AgentManifest` and `AgentSurface` contract.
- Produces: `SurfaceRegistry`, `resolveSurface`, standard `ChatSurface`.

- [ ] **Step 1: Write failing test**

```tsx
import { resolveSurface } from '../src/agent/surface-registry.js';

test('resolves standard chat and custom workflow surfaces', () => {
  expect(resolveSurface({ type: 'chat' })).toBe('standard-chat');
  expect(resolveSurface({ type: 'workflow', entry: 'surface.tsx' })).toBe('custom-workflow');
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @sparkii/desktop test`
Expected: FAIL.

- [ ] **Step 3: Implement surface registry**

```ts
export function resolveSurface(surface: { type: string; entry?: string }): string {
  if (surface.entry) return `custom-${surface.type}`;
  return `standard-${surface.type}`;
}
```

- [ ] **Step 4: Rename and adapt GeneralChatSurface to standard ChatSurface**

Keep current chat implementation, but remove `general` naming assumptions and make it receive unified props instead of managing `generalTitle` in `App.tsx`.

- [ ] **Step 5: Remove `general` special cases in App.tsx**

Delete `activeGeneralSession`, `generalTitle`, `generalSurface` and the `agentId === 'general'` branches. Use agent registry + surface registry for rendering.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @sparkii/desktop test`
Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/agent/surface-registry.tsx apps/desktop/src/surfaces/ChatSurface.tsx apps/desktop/src/surfaces/GeneralChatSurface.tsx apps/desktop/src/surfaces/ContractSurface.tsx apps/desktop/test
git commit -m "feat(desktop): renderer agent surface registry"
```

---

## Task 5: 模型选择 UI 与能力警告

**Files:**
- Modify: `apps/desktop/src/workbench/Composer.tsx`
- Modify: `apps/desktop/src/surfaces/ChatSurface.tsx`
- Modify: `apps/desktop/src/surfaces/ContractSurface.tsx`
- Modify: `apps/desktop/electron/preload/api.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`

**Interfaces:**
- Consumes: `findCompatibleModels` from Task 2.
- Produces: `getModelOptions(agentId)` returning compatibility info.

- [ ] **Step 1: Write failing test for IPC capability filter**

Create `apps/desktop/test/model-options.test.ts` using a fake `findCompatibleModels` path where incompatible models are marked.

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @sparkii/desktop test`
Expected: FAIL.

- [ ] **Step 3: Extend API to return compatible/incompatible models**

Add `compatible: boolean` and `missing: string[]` to model option records.

- [ ] **Step 4: Show warning when selected model is incompatible**

Add visible warning text in Composer and ContractSurface without blocking selection.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @sparkii/desktop test`
Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/workbench/Composer.tsx apps/desktop/src/surfaces/ChatSurface.tsx apps/desktop/src/surfaces/ContractSurface.tsx apps/desktop/electron/preload/api.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/model-options.test.ts
git commit -m "feat(desktop): model capability filtering and warnings"
```

---

## Task 6: 统一 Session 与 Workspace

**Files:**
- Modify: `apps/desktop/electron/main/chat-session-store.ts`
- Modify: `apps/desktop/electron/main/workspace.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Produces: `SessionRecord` with `kind` and `currentStep`.
- Produces: `defaultWorkspacePath(agentId, sessionId)` under `Documents/Sparkii/workspaces`.

- [ ] **Step 1: Write failing test for session kind**

Create `apps/desktop/test/session-store.test.ts`:

```ts
import { ChatSessionStore } from '../electron/main/chat-session-store.js';

test('persists session kind and current step', () => {
  const store = new ChatSessionStore(':memory:');
  store.create({ id: 's1', profileId: 'contract-review', workspaceKind: 'auto', workspacePath: 'C:/tmp', kind: 'workflow', currentStep: 'compare' } as any);
  const rec = store.get('s1');
  expect(rec?.kind).toBe('workflow');
  expect(rec?.currentStep).toBe('compare');
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @sparkii/desktop test`
Expected: FAIL.

- [ ] **Step 3: Add `kind` and `currentStep` columns**

Migrate existing DB idempotently.

- [ ] **Step 4: Change default workspace path**

Implement `defaultWorkspacePath` using `app.getPath('documents')`.

- [ ] **Step 5: Create contract-review session records in workflow**

In `runWorkflow`, create a session before running and update `currentStep` after each step.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @sparkii/desktop test`
Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/chat-session-store.ts apps/desktop/electron/main/workspace.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/workflow.ts apps/desktop/src/App.tsx apps/desktop/test/session-store.test.ts
git commit -m "feat(desktop): unify session and workspace"
```

---

## Task 7: Pi JSONL Workflow Trace

**Files:**
- Modify: `packages/agent-host/src/types.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Modify: `packages/agent-host/src/session-catalog.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`

**Interfaces:**
- Produces: `appendWorkflowEntry` RPC command and `parseWorkflowTimeline`.

- [ ] **Step 1: Write failing test**

Create `packages/agent-host/test/workflow-trace.test.ts`:

```ts
import { parseWorkflowTimeline } from '../src/session-catalog.js';

test('parses workflow step markers and state entries', () => {
  const entries = [
    { type: 'workflow_step_start', stepId: 'compare' },
    { type: 'message', message: { role: 'assistant', content: 'x' } },
    { type: 'workflow_step_end', stepId: 'compare', status: 'completed' },
    { type: 'workflow_state', stepId: 'compare', action: 'risk_confirmed', riskId: 'r1' },
  ];
  const timeline = parseWorkflowTimeline(entries);
  expect(timeline.steps).toHaveLength(1);
  expect(timeline.stateEvents).toHaveLength(1);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @sparkii/agent-host test`
Expected: FAIL.

- [ ] **Step 3: Add `append_workflow_entry` command**

Extend `RpcCommand`, `PiRuntimeSession`, `handleCommand`, and `createPiSdkSessionHost`.

- [ ] **Step 4: Implement timeline parser**

Parse `workflow_step_start/end` and `workflow_state` from session entries.

- [ ] **Step 5: Emit markers from LinearRunner**

Yield `step_started` and `step_completed` events and persist corresponding entries via the new RPC command.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @sparkii/agent-host test`
Run: `pnpm --filter @sparkii/desktop test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/src/session-catalog.ts apps/desktop/electron/main/workflow.ts packages/agent-host/test/workflow-trace.test.ts
git commit -m "feat(agent-host): add workflow timeline trace"
```

---

## Task 8: 合同审核 Workflow Surface

**Files:**
- Modify: `apps/desktop/src/surfaces/ContractSurface.tsx`
- Create: `apps/desktop/src/surfaces/contract/StepViews.tsx`
- Modify: `apps/desktop/src/surfaces/contract.ts`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/test/contract-surface.test.tsx`

**Interfaces:**
- Consumes: `parseWorkflowTimeline` from Task 7.
- Produces: step bar and step views for contract review.

- [ ] **Step 1: Write failing test for step selection**

```tsx
test('renders selected workflow step view', () => {
  render(<ContractSurface state={{ workflow: { result: {} } }} workflow={{ status: 'done' }} onAction={() => {}} onRequestExport={() => {}} />);
  expect(screen.getByRole('button', { name: '比对' })).toBeTruthy();
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @sparkii/desktop test`
Expected: FAIL.

- [ ] **Step 3: Implement persistent step bar and step views**

Implement `UploadStepView`, `ParseStepView`, `SearchStepView`, `ExtractStepView`, `CompareStepView`, `ReportStepView`, `ReviewStepView`.

- [ ] **Step 4: Connect model, context, workspace and recovery**

Use unified session and workflow timeline.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @sparkii/desktop test`
Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/surfaces/ContractSurface.tsx apps/desktop/src/surfaces/contract/StepViews.tsx apps/desktop/src/surfaces/contract.ts apps/desktop/src/styles.css apps/desktop/test/contract-surface.test.tsx
git commit -m "feat(desktop): step-based contract review surface"
```

---

## Task 9: 全量回归与验证

**Files:**
- No new files expected unless tests require fixtures.

- [ ] **Step 1: Run full test suite**

Run: `$env:CI='true'; pnpm test`
Expected: 0 failures.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @sparkii/desktop typecheck`
Expected: exit 0.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Review git diff against spec**

Check that `general` is no longer special-cased, connectors are per-agent, session/workspace unified, and contract review uses step views.

- [ ] **Step 5: Commit final fixes if needed**

```bash
git add -A
git commit -m "test: final regression fixes"
```
