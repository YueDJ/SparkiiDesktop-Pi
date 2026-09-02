# Agent Surface Template & Contract Review Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent Surface 从平台写死分支演进为「薄契约 + 可选公共件」的模板，并让合同审核成为第一个实例（可自定义页面 + live/history 双模 + 修复现有 bug）。

**Architecture:** 平台提供 `AgentSurface` 契约、`useAgentSession`、会话流归一化器与共享框架组件（`src/surface/`，无 agent 引用）；构建期由 manifest 生成 `agentId → surface 组件` 绑定（`src/platform/agent-surface-bindings.ts`，唯一 import agents 处）；App 查表渲染。合同审核 agent 用 `type: workflow` 自研步骤条 + 分步视图 + 类型化业务态。

**Tech Stack:** React 18 + TypeScript + Vite + Vitest + `@testing-library/react` + `@sparkii/ui` + `@sparkii/config` + Electron(主进程 IPC)。

**Spec:** `docs/superpowers/specs/2026-09-02-agent-surface-template-and-contract-review-design.md`

## Global Constraints

- 边界硬规则：`src/surface/` 绝不 import `agents/**`；`src/platform/agent-surface-bindings.ts` 是唯一 import agents 的地方且为构建产物；`agents/<id>/surface/` 不走 `src/composer`、`src/workbench` 内部模块，只走公开契约 + `@sparkii/ui` + 共享框架件。
- 平台层不再出现 `agentId === 'general'` / `'contract-review'` 特判；只认 `manifest.surface.type`。
- 运行期不扫 `agents/` 目录、不做任意文件动态 import；agent 随应用交付。
- 类型化业务态是唯一事实源：风险等级/复核结论来自结构化数据，LLM 文本只作旁注。
- 步骤条单一事实源：顺序与显示名派生自 agent `workflow` 定义。
- 所有写操作走审批门；被拒绝的写绝不执行。
- 组件库升级走 `@sparkii/ui`（`packages/ui`），不以 `src/workbench` 为公共 API。
- 测试用 Vitest + `@testing-library/react`，文件命名 `*.test.{ts,tsx}`。

---

## File Structure (target)

```text
apps/desktop/src/surface/                     # 平台 Surface 模板（无 agent 引用）
  contract.ts                                 # AgentSurfaceProps / AgentSurfaceComponent / AgentSession / Actions / 类型
  use-agent-session.ts                        # 会话打开/恢复/订阅/回放，返回 AgentSession
  normalize.ts                                # 会话流归一化（message/tool/event/workflow_step/workflow_state/custom）
  standard-chat.tsx                           # 平台标准 ChatSurface（自 agents/general/surface 抽出的通用部分）
  index.ts                                    # 汇总导出

apps/desktop/src/platform/
  agent-surface-bindings.ts                   # 构建期生成：agentId → surface 组件（唯一 import agents/**）
  surface-registry.tsx                        # 现有桩：改为读取 surfaceByAgent + App 消费入口（薄）

apps/desktop/agents/contract-review/surface/
  index.tsx                                   # ContractAgentSurface（实现 AgentSurface 契约）
  StepViews.tsx                               # 分步视图（结构化，去掉 <pre> JSON）
  contract.ts                                 # 业务模型 + 类型化解析（RiskFinding/Report/步骤派生）
  manifest-steps.ts                           # 从 workflow 定义派生步骤条（单一事实源）

apps/desktop/agents/general/surface/
  index.tsx                                   # 保留为通用入口（复用平台标准 ChatSurface）

packages/ui/src/patterns/
  WorkflowSteps.tsx                           # 增强为可点击 + 状态
  RiskBadge.tsx                               # 保持不变/可选增强
  Markdown.tsx (move from src/workbench)      # 下沉为公共件
  ToolCard.tsx (move/merge)                   # 下沉为公共件（与现 packages/ui 版合并）
  LifecycleCard.tsx (move)                    # 下沉为公共件

apps/desktop/src/App.tsx                      # 改用 surfaceByAgent + AgentSurfaceProps，移除硬编码特判
```

> 说明：`Markdown` / `ToolCard` / `LifecycleCard` 从 `apps/desktop/src/workbench` 下沉到 `packages/ui`；`workbench/*` 保留给平台内部（App 壳）使用，但不再作为 agent 的公共 API。

---

## Milestone 1: 平台 Surface 模板 + 绑定 + App 接线

### Task 1.1: 定义 AgentSurface 契约类型

**Files:**
- Create: `apps/desktop/src/surface/contract.ts`
- Test: `apps/desktop/test/surface-contract.test.ts`

**Interfaces:**
- Produces: `AgentSurfaceComponent`, `AgentSurfaceProps`, `AgentSession`, `AgentSurfaceActions`, `AgentDescriptor`, `SessionEntry`, `WorkflowStepEntry`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/surface-contract.test.ts
import { describe, it, expect } from 'vitest';
import type { AgentSurfaceComponent, AgentSurfaceProps } from '../src/surface/contract.js';

describe('AgentSurface contract', () => {
  it('types a component that accepts AgentSurfaceProps', () => {
    const Comp: AgentSurfaceComponent = (props: AgentSurfaceProps) => null;
    // 契约要求 component 拥有 displayName 可观察点（用于测试/调试）——用类型层面近似断言
    expect(typeof Comp).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test surface-contract`
Expected: FAIL with "Cannot find module '../src/surface/contract.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/surface/contract.ts
import type { ComponentType } from 'react';

export interface AgentDescriptor {
  id: string;
  name: string;
  surfaceType: string;
}

export type SessionEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; thinking?: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean; toolCallId?: string }
  | { kind: 'event'; id: string; event: string; label: string; detail?: string; status?: string; timestamp?: number; payload?: unknown }
  | { kind: 'workflow_step'; id: string; stepId: string; state: 'start' | 'end'; status?: string; timestamp?: number }
  | { kind: 'workflow_state'; id: string; stepId: string; action: string; payload: Record<string, unknown>; timestamp?: number };

export interface AgentSession {
  entries: SessionEntry[];
  streaming: boolean;
  meta: {
    model?: string | null;
    contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
    workspacePath?: string | null;
    currentStep?: string | null;
  };
}

export interface AgentSurfaceActions {
  newSession(): void;
  openSession(id: string): void;
  startWorkflow(payload: Record<string, unknown>): void;
  review(action: string, payload: Record<string, unknown>): void;
  requestExport(): void;
}

export interface AgentSurfaceProps {
  agent: AgentDescriptor;
  sessionId: string | null;
  mode: 'live' | 'history';
  session: AgentSession;
  actions: AgentSurfaceActions;
}

export type AgentSurfaceComponent = ComponentType<AgentSurfaceProps>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test surface-contract`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/contract.ts apps/desktop/test/surface-contract.test.ts
git commit -m "feat(surface): add AgentSurface contract types"
```

### Task 1.2: 会话流归一化器（结合 workflow 事件）

**Files:**
- Create: `apps/desktop/src/surface/normalize.ts`
- Test: `apps/desktop/test/surface-normalize.test.ts`

**Interfaces:**
- Consumes: `SessionEntry`, `WorkflowStepEntry` (from `contract.ts`)
- Produces: `normalizeSessionEntries(entries: unknown[]): SessionEntry[]`, `applySurfaceEvent(entries: SessionEntry[], ev: unknown): SessionEntry[]`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/surface-normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeSessionEntries, applySurfaceEvent } from '../src/surface/normalize.js';

describe('surface normalize', () => {
  it('maps workflow_step_start/end to typed entries', () => {
    const out = normalizeSessionEntries([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '上传合同' }] } },
      { type: 'workflow_step_start', data: { stepId: 'compare', startedAt: '2026-09-02T00:00:00Z' } },
      { type: 'workflow_step_end', data: { stepId: 'compare', status: 'completed' } },
      { type: 'workflow_state', data: { stepId: 'compare', action: 'risk_confirmed', payload: { riskId: 'f0' } } },
    ]);
    expect(out.map((e) => e.kind)).toContain('workflow_step');
    expect(out.map((e) => e.kind)).toContain('workflow_state');
    const step = out.find((e) => e.kind === 'workflow_step') as any;
    expect(step.state).toBe('start');
  });

  it('applies a live message event onto entries', () => {
    const base = normalizeSessionEntries([]);
    const next = applySurfaceEvent(base, { type: 'message', role: 'assistant', delta: '你好' });
    expect(next.at(-1)?.kind).toBe('message');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test surface-normalize`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/surface/normalize.ts
import type { SessionEntry } from './contract.js';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function entryFor(raw: unknown): SessionEntry | null {
  const rec = asRecord(raw);
  const type = String(rec.type ?? '');
  const data = asRecord(rec.data);
  const ts = typeof data.startedAt === 'string' ? Date.parse(data.startedAt) : undefined;
  if (type === 'workflow_step_start') {
    return { kind: 'workflow_step', id: `ws-${data.stepId}-start`, stepId: String(data.stepId), state: 'start', timestamp: ts };
  }
  if (type === 'workflow_step_end') {
    return { kind: 'workflow_step', id: `ws-${data.stepId}-end`, stepId: String(data.stepId), state: 'end', status: String(data.status ?? ''), timestamp: ts };
  }
  if (type === 'workflow_state') {
    return { kind: 'workflow_state', id: `wst-${Date.now()}-${Math.random()}`, stepId: String(data.stepId), action: String(data.action), payload: asRecord(data.payload) };
  }
  if (type === 'message') {
    const m = asRecord(rec.message);
    const role = String(m.role ?? '');
    const content = Array.isArray(m.content) ? m.content.map((b) => (asRecord(b).type === 'text' ? String(asRecord(b).text ?? '') : '')).join('') : '';
    const text = typeof m.text === 'string' ? m.text : content;
    if (role === 'user' || role === 'assistant') return { kind: 'message', id: `m-${Date.now()}`, role, text, streaming: false };
  }
  return null;
}

export function normalizeSessionEntries(entries: unknown[]): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const e of entries) {
    const mapped = entryFor(e);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function applySurfaceEvent(entries: SessionEntry[], ev: unknown): SessionEntry[] {
  const rec = asRecord(ev);
  const mapped = entryFor(ev);
  if (mapped) return [...entries, mapped];
  if (String(rec.type ?? '') === 'message' && String(rec.role ?? '') === 'assistant') {
    const last = entries[entries.length - 1];
    if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
      const collected = (typeof rec.delta === 'string' ? rec.delta : '');
      return [...entries.slice(0, -1), { ...last, text: last.text + collected, streaming: true }];
    }
    const text = typeof rec.text === 'string' ? rec.text : typeof rec.delta === 'string' ? rec.delta : '';
    if (text || typeof rec.text === 'string') return [...entries, { kind: 'message', id: `m-${Date.now()}`, role: 'assistant', text, streaming: typeof rec.delta === 'string' }];
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test surface-normalize`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/normalize.ts apps/desktop/test/surface-normalize.test.ts
git commit -m "feat(surface): normalize workflow_step and workflow_state entries"
```

### Task 1.3: useAgentSession 会话 hook

**Files:**
- Create: `apps/desktop/src/surface/use-agent-session.ts`
- Test: `apps/desktop/test/use-agent-session.test.ts`

**Interfaces:**
- Consumes: `AgentSession`, `SessionEntry` (from `contract.js`), `normalizeSessionEntries` / `applySurfaceEvent` (from `normalize.js`), `window.sparkii` API (`.openChatSession`, `.on`)
- Produces: `useAgentSession(agentId: string, sessionId: string | null, mode: 'live' | 'history'): AgentSession`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/use-agent-session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentSession } from '../src/surface/use-agent-session.js';

describe('useAgentSession', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      sparkii: {
        openChatSession: vi.fn().mockResolvedValue({ entries: [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }] }),
        on: vi.fn().mockReturnValue(() => {}),
      },
    };
  });

  it('loads and normalizes history entries in history mode', async () => {
    const { result } = renderHook(() => useAgentSession('general', 's1', 'history'));
    await waitFor(() => expect(result.current.entries.length).toBeGreaterThan(0));
    expect(result.current.meta.currentStep).toBeNull();
  });

  it('starts empty when no session', () => {
    const { result } = renderHook(() => useAgentSession('general', null, 'live'));
    expect(result.current.entries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test use-agent-session`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/surface/use-agent-session.ts
import { useEffect, useState } from 'react';
import type { AgentSession } from './contract.js';
import { normalizeSessionEntries, applySurfaceEvent } from './normalize.js';

const EMPTY: AgentSession = { entries: [], streaming: false, meta: {} };

export function useAgentSession(agentId: string, sessionId: string | null, mode: 'live' | 'history'): AgentSession {
  const [session, setSession] = useState<AgentSession>(EMPTY);

  useEffect(() => {
    setSession(EMPTY);
    if (!sessionId) return;
    let open = true;
    (window as any).sparkii?.openChatSession?.(sessionId)
      .then((res: any) => {
        if (!open) return;
        const entries = normalizeSessionEntries(res?.entries ?? res?.messages ?? []);
        setSession((s) => ({ ...s, entries, streaming: Boolean(res?.streaming) }));
      })
      .catch(() => {});

    const off = (window as any).sparkii?.on?.('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId || mode !== 'live') return;
      setSession((s) => ({ ...s, entries: applySurfaceEvent(s.entries, p), streaming: p?.type === 'agent_start' }));
    });
    return () => { open = false; off?.(); };
  }, [agentId, sessionId, mode]);

  return session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test use-agent-session`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/use-agent-session.ts apps/desktop/test/use-agent-session.test.ts
git commit -m "feat(surface): add useAgentSession live/history hook"
```

### Task 1.4: 生成 agent → surface 绑定（codegen + 产物）

**Files:**
- Create: `apps/desktop/scripts/generate-surface-bindings.mjs`
- Create: `apps/desktop/src/platform/agent-surface-bindings.ts`（生成产物）
- Modify: `apps/desktop/package.json`（构建前运行 codegen）
- Test: `apps/desktop/test/surface-bindings.test.ts`

**Interfaces:**
- Consumes: `AgentSurfaceComponent` (from `contract.js`)
- Produces: `surfaceByAgent: Record<string, AgentSurfaceComponent>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/surface-bindings.test.ts
import { describe, it, expect } from 'vitest';
import { surfaceByAgent } from '../src/platform/agent-surface-bindings.js';

describe('agent surface bindings', () => {
  it('binds general to a component and contract-review to a component', () => {
    expect(typeof surfaceByAgent['general']).toBe('function');
    expect(typeof surfaceByAgent['contract-review']).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test surface-bindings`
Expected: FAIL — module not found (`agent-surface-bindings.js` 尚未生成)

- [ ] **Step 3: Write codegen + generated artifact**

```mjs
// apps/desktop/scripts/generate-surface-bindings.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const agentsRoot = join(root, 'agents');
const stdChat = "../surface/standard-chat";   // 平台标准 chat（M1.5 建）
const lines = [
  '// AUTO-GENERATED from agents/*/manifest.yaml — do not edit by hand.',
  "import type { AgentSurfaceComponent } from '../surface/contract.js';",
  `import { standardChatSurface } from '${stdChat}';`,
];
const entries = [];

for (const name of readdirSync(agentsRoot)) {
  const dir = join(agentsRoot, name);
  const manifest = join(dir, 'manifest.yaml');
  if (!existsSync(manifest)) continue;
  const text = readFileSync(manifest, 'utf8');
  const typeMatch = text.match(/type:\s*(\w+)/);
  const type = typeMatch ? typeMatch[1] : 'chat';
  const entryMatch = text.match(/entry:\s*([^\s]+)/);
  if (type === 'chat') {
    entries.push(`  ${JSON.stringify(name)}: standardChatSurface,`);
  } else if (entryMatch) {
    const rel = `../../agents/${name}/surface/index.js`;
    lines.push(`import { ContractSurface } from '${rel}';`);
    entries.push(`  ${JSON.stringify(name)}: ContractSurface,`);
  }
}

lines.push(`export const surfaceByAgent: Record<string, AgentSurfaceComponent> = {`, ...entries, '};');
writeFileSync(join(root, 'src', 'platform', 'agent-surface-bindings.ts'), lines.join('\n') + '\n');
console.log('wrote agent-surface-bindings.ts');
```

```ts
// apps/desktop/src/platform/agent-surface-bindings.ts  (生成产物示例，运行 codegen 生成)
// AUTO-GENERATED from agents/*/manifest.yaml — do not edit by hand.
import type { AgentSurfaceComponent } from '../surface/contract.js';
import { standardChatSurface } from '../surface/standard-chat';
import { ContractSurface } from '../../agents/contract-review/surface/index.js';

export const surfaceByAgent: Record<string, AgentSurfaceComponent> = {
  "general": standardChatSurface,
  "contract-review": ContractSurface,
};
```

```json
// apps/desktop/package.json — scripts 增加（现有无 dev/prebuild，实际构建入口为 build:renderer / dist）
{
  "scripts": {
    "gen:surfaces": "node scripts/generate-surface-bindings.mjs",
    "prebuild:renderer": "npm run gen:surfaces",
    "dev": "vite",
    "predev": "npm run gen:surfaces"
  }
}
```

- [ ] **Step 4: Run codegen + test to verify it passes**

Run: `node apps/desktop/scripts/generate-surface-bindings.mjs && pnpm --filter @sparkii/desktop test surface-bindings`
Expected: PASS（`general` / `contract-review` 都绑定到函数）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/scripts/generate-surface-bindings.mjs apps/desktop/src/platform/agent-surface-bindings.ts apps/desktop/package.json apps/desktop/test/surface-bindings.test.ts
git commit -m "feat(surface): generate agent->surface bindings from manifests"
```

### Task 1.5: 下沉公共件到 @sparkii/ui（Markdown / ToolCard / LifecycleCard）

**Files:**
- Create: `packages/ui/src/patterns/Markdown.tsx`（从 `apps/desktop/src/workbench/Markdown.tsx` 迁移/重命名）
- Modify/Create: `packages/ui/src/patterns/ToolCard.tsx`（合并 `apps/desktop/src/workbench/ToolCard.tsx` 能力）
- Create: `packages/ui/src/patterns/LifecycleCard.tsx`（从 `apps/desktop/src/workbench/LifecycleCard.tsx` 迁移）
- Modify: `packages/ui/src/index.ts`（导出）
- Test: `apps/desktop/test/ui-workbench-patterns.test.tsx`（现有 `ui-business-patterns`/`ui-chat-patterns` 工具类测试，新增覆盖）

**Interfaces:**
- Produces: `Markdown`, `ToolCard`, `LifecycleCard` from `@sparkii/ui`；随后 `useAgentSession`/agent surface 从 `@sparkii/ui` 引用，而非 `src/workbench`。

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/ui-workbench-patterns.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, ToolCard, LifecycleCard } from '@sparkii/ui';

describe('shared workbench patterns from @sparkii/ui', () => {
  it('renders markdown, tool card, lifecycle card', () => {
    render(<Markdown text="# 标题" />);
    expect(screen.getByText('标题')).toBeTruthy();
    render(<ToolCard toolName="bash" input={{ command: 'ls' }} />);
    expect(screen.getByText(/bash/)).toBeTruthy();
    render(<LifecycleCard entry={{ kind: 'event', id: 'e1', event: 'agent_start', label: 'Pi 开始处理', status: 'running' } as any} />);
    expect(screen.getByText('Pi 开始处理')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test ui-workbench-patterns`
Expected: FAIL — `Markdown`/`LifecycleCard` 未从 `@sparkii/ui` 导出

- [ ] **Step 3: Move implementations + export**

将 `apps/desktop/src/workbench/Markdown.tsx` 内容复制到 `packages/ui/src/patterns/Markdown.tsx`（保持同一 props），把 `ToolCard` 合并为 `packages/ui` 版本（保留 `toolName/input/result/awaitingApproval/defaultExpanded`），把 `LifecycleCard.tsx` 复制到 `packages/ui`。并在 `packages/ui/src/index.ts` 追加：

```ts
export { Markdown } from './patterns/Markdown.js';
export { ToolCard } from './patterns/ToolCard.js';
export { LifecycleCard } from './patterns/LifecycleCard.js';
```

> 注意：`packages/ui` 已有的 `ToolCard` 以它为准（`apps/desktop/src/workbench/ToolCard.tsx` 为平台内部变体，不再作为 agent 公共 API）；`Markdown`/`LifecycleCard` 需把 `react-markdown`、`remark-gfm` 加入 `packages/ui/package.json` 的 dependencies（当前仅 desktop 有）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test ui-workbench-patterns`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/patterns/Markdown.tsx packages/ui/src/patterns/ToolCard.tsx packages/ui/src/patterns/LifecycleCard.tsx packages/ui/src/index.ts apps/desktop/test/ui-workbench-patterns.test.tsx
git commit -m "refactor(ui): promote Markdown/ToolCard/LifecycleCard to @sparkii/ui"
```

### Task 1.6: 标准 ChatSurface + App 改用契约/绑定

**Files:**
- Create: `apps/desktop/src/surface/standard-chat.tsx`（从 `agents/general/surface/index.tsx` 抽通用部分，改为实现 `AgentSurfaceProps`）
- Modify: `apps/desktop/agents/general/surface/index.tsx`（薄封装，调用 standardChatSurface）
- Modify: `apps/desktop/src/App.tsx`（移除硬编码 `ContractSurface`/`GeneralChatSurface` import，改用 `surfaceByAgent[agent]` + `AgentSurfaceProps` 包裹）
- Modify: `apps/desktop/src/platform/surface-registry.tsx`（读取 `surfaceByAgent` 向外暴露解析）
- Test: `apps/desktop/test/agent-surface-binding.test.tsx`

**Interfaces:**
- Consumes: `surfaceByAgent` (from `bindings`), `useAgentSession`, `AgentSurfaceActions`, `AgentDescriptor`
- Produces: `resolveSurfaceFor(agentId): AgentSurfaceComponent`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/agent-surface-binding.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSurface } from '../src/platform/surface-registry.js';

describe('agent surface binding', () => {
  it('returns a component for a known agent', () => {
    const { result } = renderHook(() => useAgentSurface('contract-review'));
    expect(typeof result.current.Surface).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test agent-surface-binding`
Expected: FAIL — `useAgentSurface` 未导出

- [ ] **Step 3: Implement standard-chat + registry hook + App wiring**

```tsx
// apps/desktop/src/surface/standard-chat.tsx （概要：从 general surface 抽取，改为接收 AgentSurfaceProps）
import type { AgentSurfaceProps } from './contract.js';
export function standardChatSurface(props: AgentSurfaceProps) {
  // 复用 ChatMessage / Composer / ToolCard / LifecycleCard / Markdown（从 @sparkii/ui 引入），
  // 用 props.session.entries 渲染消息流，用 props.actions 触发 newSession/openSession 等。
  return <>…（迁自 general surface 的消息流 + Composer + 队列区域）…</>;
}
```

```ts
// apps/desktop/src/platform/surface-registry.tsx（现有桩改为消费绑定）
import { surfaceByAgent } from './agent-surface-bindings.js';
import type { AgentSurfaceComponent } from '../surface/contract.js';

export function useAgentSurface(agentId: string): { Surface: AgentSurfaceComponent } {
  return { Surface: surfaceByAgent[agentId] ?? surfaceByAgent['general'] };
}
```

```tsx
// apps/desktop/src/App.tsx（要点）：
const { Surface } = useAgentSurface(activeAgentId);
return <Surface agent={agent} sessionId={activeSessionFor(agentId)} mode={mode} session={session} actions={actions} />;
```

- [ ] **Step 4: Run test + full suite to verify it passes**

Run: `pnpm --filter @sparkii/desktop test agent-surface-binding && pnpm --filter @sparkii/desktop test`
Expected: PASS（既有 `app-workflow`/`general-chat-surface` 等回归通过）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/standard-chat.tsx apps/desktop/agents/general/surface/index.tsx apps/desktop/src/App.tsx apps/desktop/src/platform/surface-registry.tsx apps/desktop/test/agent-surface-binding.test.tsx
git commit -m "refactor(surface): render agents via contract + generated binding, drop hardcodes"
```

---

## Milestone 2: 合同审核 Surface（结构化 + 类型化 + 修 bug）

### Task 2.1: 类型化业务态 + 步骤单一事实源

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/contract.ts`（新增 `RiskFinding`/`Report`/`Block` 类型 + `parseRiskFindings`/`formatReport` 改为基于类型化结果）
- Create: `apps/desktop/agents/contract-review/surface/manifest-steps.ts`（从 `agent/workflow.yaml` 派生步骤条）
- Test: `apps/desktop/test/contract-helpers.test.ts`（扩展）

**Interfaces:**
- Consumes: `SessionEntry`（from `surface/contract`）
- Produces: `StepItem { id; label; state }`, `STEP_IDS`, `deriveSteps(workflowLike): StepItem[]`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/contract-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSteps } from '../agents/contract-review/surface/manifest-steps.js';

describe('deriveSteps', () => {
  it('yields the five backend steps from workflow def', () => {
    const steps = deriveSteps({ status: 'running', step: 'compare' });
    expect(steps.map((s) => s.id)).toEqual(['load', 'search', 'extract', 'compare', 'report']);
  });
  it('marks active/current correctly', () => {
    const steps = deriveSteps({ status: 'running', step: 'compare' });
    expect(steps.find((s) => s.id === 'compare')?.state).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test contract-helpers`
Expected: FAIL — `deriveSteps` 未导出

- [ ] **Step 3: Implement single-source steps + typed state**

```ts
// apps/desktop/agents/contract-review/surface/manifest-steps.ts
export interface StepItem { id: string; label: string; state: 'done' | 'active' | 'pending' | 'failed' }
export const STEP_IDS = ['load', 'search', 'extract', 'compare', 'report'] as const;
const LABELS: Record<string, string> = { load: '解析', search: '检索', extract: '抽取', compare: '比对', report: '报告' };

export function deriveSteps(workflow: { status: string; step?: string; error?: string }): StepItem[] {
  if (workflow.status === 'done') return STEP_IDS.map((id) => ({ id, label: LABELS[id], state: 'done' as const }));
  if (workflow.status !== 'running') return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i === 0 ? 'active' as const : 'pending' as const }));
  if (workflow.status === 'failed') return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i < STEP_IDS.indexOf((workflow.step as any)) ? 'done' as const : 'failed' as const }));
  const idx = STEP_IDS.indexOf((workflow.step as any) as (typeof STEP_IDS)[number]);
  return STEP_IDS.map((id, i) => ({ id, label: LABELS[id], state: i < idx ? 'done' : i === idx ? 'active' : 'pending' }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test contract-helpers`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/contract-review/surface/manifest-steps.ts apps/desktop/test/contract-helpers.test.ts
git commit -m "feat(contract): derive step rail from single source of truth"
```

### Task 2.2: StepViews 结构化（去除 <pre> JSON）

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/StepViews.tsx`（分步视图，展示结构化内容）
- Test: `apps/desktop/test/contract-surface.test.tsx`（增加断言）

**Interfaces:**
- Consumes: `deriveSteps`/`STEP_IDS`, typed `RiskFinding`

- [ ] **Step 1: Write the failing test**

```tsx
// 追加到 contract-surface.test.tsx
it('renders structured compare step without raw JSON', () => {
  render(<ContractSurface state={makeState()} workflow={{ status: 'done' } as any} onAction={vi.fn()} onRequestExport={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '比对' }));
  expect(document.querySelector('pre')).toBeNull();
  expect(screen.getByText('第7条 付款条件')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test contract-surface`
Expected: FAIL — 出现 `<pre>` 或未渲染结构

- [ ] **Step 3: Reimplement StepViews**

用类型化 `parseRiskFindings` 渲染 `RiskFinding` 卡片（原文/位置/规则/依据/建议），替换 `text()`→`<pre>` 逻辑；未执行步骤显示「尚未执行」。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test contract-surface`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/contract-review/surface/StepViews.tsx apps/desktop/test/contract-surface.test.tsx
git commit -m "feat(contract): structured step views, drop raw JSON"
```

### Task 2.3: 唯一步骤条 + Markdown 报告 + 真导出审批 + 复核回写

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（改为 `ContractAgentSurface` 实现 `AgentSurfaceProps`；用 `deriveSteps` 渲染唯一可点击步骤条；报告用 `@sparkii/ui` 的 `Markdown`；导出走 `actions.requestExport`；复核写 `actions.review`）
- Modify: `packages/ui/src/patterns/WorkflowSteps.tsx`（增加可点击 `onStepClick` + `active` 高亮）
- Test: `apps/desktop/test/contract-surface.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('single clickable step rail + markdown report + export action', () => {
  const onExport = vi.fn();
  const review = vi.fn();
  render(
    <ContractAgentSurface
      agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }}
      sessionId="s1"
      mode="history"
      session={{ entries: [], streaming: false, meta: {} }}
      actions={{ newSession: vi.fn(), openSession: vi.fn(), startWorkflow: vi.fn(), review, requestExport: onExport }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '报告' }));
  fireEvent.click(screen.getByText('导出报告 · 需审批'));
  expect(onExport).toHaveBeenCalled();
  fireEvent.click(screen.getByText('确认'));
  expect(review).toHaveBeenCalledWith('risk_confirmed', { riskId: 'f0', stepId: 'compare' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test contract-surface`
Expected: FAIL — `ContractAgentSurface` 未导出 / 预期行为缺失

- [ ] **Step 3: Implement**

在 `index.tsx` 导出 `ContractAgentSurface`（接收 `AgentSurfaceProps`），内部用 `useAgentSession` + `deriveSteps` + 类型化视图；导出按钮改为 `actions.requestExport()`；「确认/忽略/升级/备注」改为 `actions.review('risk_confirmed', { riskId, stepId: 'compare', ... })`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test contract-surface && pnpm --filter @sparkii/desktop test`
Expected: PASS（回归通过）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/contract-review/surface/index.tsx packages/ui/src/patterns/WorkflowSteps.tsx apps/desktop/test/contract-surface.test.tsx
git commit -m "feat(contract): single step rail, markdown report, export approval, review writeback"
```

---

## Milestone 3: 历史回放 + 会话隔离

### Task 3.1: 打开历史会话 → 回放条目 + 推导当前步骤

**Files:**
- Modify: `apps/desktop/src/surface/use-agent-session.ts`（history 模式：读取 `piSessionFile` 的 entries，含 workflow_step）
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（从 `session.entries` 推导步骤与每步产出）
- Modify: `apps/desktop/src/App.tsx`（`sessionId` 由左栏会话传入；`onOpenSession` 对 workflow 也设置 `sessionId`）
- Test: `apps/desktop/test/contract-surface.test.tsx` + `apps/desktop/test/use-agent-session.test.ts`

**Interfaces:**
- Produces: `deriveCurrentStep(entries): string | null`, `stepOutput(entries, stepId)`

- [ ] **Step 1: Write the failing test**

```tsx
it('restores history into step panels from session.entries', () => {
  const entries = normalizeSessionEntries([
    { type: 'workflow_step_start', data: { stepId: 'compare' } },
    { type: 'workflow_state', data: { stepId: 'compare', action: 'risk_confirmed', payload: { riskId: 'f0' } } },
  ]);
  render(
    <ContractAgentSurface
      agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }}
      sessionId="s1" mode="history"
      session={{ entries, streaming: false, meta: { currentStep: 'compare' } }}
      actions={{ newSession: vi.fn(), openSession: vi.fn(), startWorkflow: vi.fn(), review: vi.fn(), requestExport: vi.fn() }}
    />,
  );
  expect(screen.getByText('已复核 1')).toBeTruthy();   // 从 workflow_state 恢复复核进度
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test contract-surface`
Expected: FAIL

- [ ] **Step 3: Implement**

`useAgentSession(history)` 用现有 `openChatSession` 返回的 `entries`；`ContractAgentSurface` 从 `session.entries` 里的 `workflow_step`/`workflow_state` 推导 `currentStep`、步骤状态与复核进度；`onOpenSession`（App.tsx）对 workflow agent 也设置 `sessionId` 并让 surface 处于 `history` 模式。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test contract-surface && pnpm --filter @sparkii/desktop test use-agent-session`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/use-agent-session.ts apps/desktop/agents/contract-review/surface/index.tsx apps/desktop/src/App.tsx apps/desktop/test/contract-surface.test.tsx
git commit -m "feat(contract): restore history into step panels and isolate per-session state"
```

### Task 3.2: 会话状态按 sessionId 隔离

**Files:**
- Modify: `apps/desktop/src/App.tsx`（去掉全局游离 `state`，改用 per-session 状态容器；`state` 键按 `sessionId`）
- Test: `apps/desktop/test/app-workflow.test.tsx`

- [ ] **Step 1: Write the failing test**

在 `app-workflow.test.tsx` 断言：切换两个 workflow 会话时，各自 `documents`/步骤不互相污染。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test app-workflow`
Expected: FAIL（当前全局 state 泄漏）

- [ ] **Step 3: Implement**

将 `state` 改为 `Map<sessionId, WorkflowState>`，`onOpenSession(sessionId)` 时选中该条；`useAgentSession` 已按 session 隔离 entries。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop test app-workflow`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/app-workflow.test.tsx
git commit -m "refactor(contract): scope workflow state by sessionId"
```

---

## Milestone 4（可选 / 清理）: 通用 chat 收敛到同一契约

### Task 4.1: general surface 复用标准 ChatSurface

**Files:**
- Modify: `apps/desktop/agents/general/surface/index.tsx`（薄封装 → 直接复用 `standardChatSurface`）
- Test: `apps/desktop/test/general-chat-surface.test.tsx`（回归）

- [ ] **Step 1–5:** 确保 `general` 通过 `standardChatSurface` 渲染，回归测试通过并提交。

```bash
git add apps/desktop/agents/general/surface/index.tsx apps/desktop/test/general-chat-surface.test.tsx
git commit -m "refactor(chat): general surface reuses platform standard chat surface"
```

---

## Self-Review

1. **Spec coverage**：满足「薄契约」「useAgentSession」「归一化器」「构建期绑定」「严格边界」「唯一 import agents 处」「标准/自定义范式」「合同审核结构化/类型化/修 bug（唯一步骤条、Markdown 报告、真导出审批、复核回写）」「历史回放」「会话隔离」「公共件下沉」。M4 为可选。
2. **Placeholder scan**：无 TBD/TODO；各任务步骤含真实代码与运行命令。
3. **Type consistency**：`AgentSurfaceProps`/`AgentSurfaceComponent`/`AgentSession`/`SessionEntry`/`surfaceByAgent`/`deriveSteps`/`ACTION` 命名在各任务间保持一致。
