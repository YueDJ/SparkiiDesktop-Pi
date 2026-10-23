# 平台统一审批与安全执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在平台层建立所有 Agent 共用的 Task Grant、Policy Engine、Workspace Admission 和 Action 执行边界，使 Standard 模式下普通工作区操作零逐次审批，同时保留越界、外部副作用、信任锚和灾难目标保护。

**Architecture:** 平台层拥有全部强制机制；Agent/Profile 只能声明能力需求、默认模式和更严格策略。第一阶段先落地纯策略与准入基础并在 feature flag 后保持旧行为；后续切片再接入 Runtime、结构化文件执行、外部 Capability Gateway 和 Windows 沙箱。

**Tech Stack:** TypeScript、Node.js 22、Electron 44、Pi SDK 1.0.2、Vitest、SQLite（better-sqlite3）、React 19

**Spec:** `docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`

## Global Constraints

- 审批机制属于平台层；不得在 `apps/desktop/agents/**` 写审批判定分支。
- Agent Runtime 和模型输出都不可信；Main 必须重新计算 Capability、目标、风险和展示摘要。
- Standard 模式下，普通 Workspace CRUD、测试、构建和本地 Git 不创建 Proposal、不产生审批弹窗、不写审批 JSONL。
- 快照与恢复不是授权前置条件。
- 硬拒绝优先于 RBAC、Task Grant、`requireApproval` 和 `autoApprove`。
- 外部系统副作用必须经过 Main 侧 Capability Gateway。
- Workspace Admission 必须处理受保护闭包根、完整祖先链和路径别名。
- 当前交付以 Windows 为主；macOS 和 Debian/Ubuntu 只能依赖平台适配接口，不在核心策略中写 OS 分支。
- Windows 原生沙箱原型通过前，Standard 模式不得自动执行未受限 Shell。
- 旧 Agent/Workflow 业务人工复核保持不变。
- 所有新行为必须默认关闭或保持旧结果，直到对应切片完成全量回归。

---

## 1. 分层与所有权

```text
Platform Layer
  packages/approval
    Capability · TaskGrant · PolicyEngine · WorkspaceAdmission · Proposal/Audit
  apps/desktop/electron/main/security
    ActionNormalizer · TaskGrantRegistry · WorkspaceExecutor · Platform Adapter
  apps/desktop/electron/main
    Session lifecycle · IPC · Capability Gateway · Runtime orchestration
  apps/desktop/src/trust
    审批收件箱 · 例外审批 UI · 权限状态 · 审计展示

Agent Layer
  apps/desktop/agents/<id>
    manifest · tools/capabilities · default policy · surface
```

### 1.1 平台层职责

- 创建和撤销 Task Grant。
- 执行 Workspace Admission。
- 从可信工具目录重新计算 Action 语义。
- 计算 `ALLOW / ASK / DENY`。
- 执行结构化文件操作、沙箱进程和外部 Capability Gateway。
- 管理审批、RBAC、超时、审计和恢复。
- 提供跨平台 Workspace Sandbox Adapter 契约。

### 1.2 Agent 层职责

- 声明需要哪些工具和 Capability。
- 声明默认运行模式。
- 声明比平台底线更严格的审批规则。
- 提供业务 Surface 和业务人工复核。
- 展示平台提供的安全状态或嵌入平台审批组件。

Agent 不得：

- 自行判断 Action 是否获批；
- 自行执行外部副作用；
- 放宽灾难目标、信任锚或平台沙箱规则；
- 通过 `agentId` 条件进入平台策略分支。

## 2. 交付切片

| 切片 | 交付物 | 用户可见变化 |
| --- | --- | --- |
| M1 安全基础 | Capability、Task Grant、Policy、Workspace Admission 纯模块 | 无，feature flag 关闭 |
| M2 Runtime 接线 | Action 协议、Main 语义重算、Task 生命周期 | 默认无变化 |
| M3 工作区写入 | 结构化文件操作走 `ALLOW` 和审计，不再创建 Proposal | 普通新增/修改文件不再审批 |
| M4 Windows 沙箱 | 原生沙箱原型、Shell 和 scratch 隔离 | Standard 下测试、构建和 Shell 自动执行 |
| M5 外部与 UI | Capability Gateway、例外审批、权限状态、JSONL 迁移 | 只有越界和外部副作用打断用户 |
| M6 跨平台契约 | macOS、Debian/Ubuntu Adapter 一致性套件 | Windows 行为不变 |

Standard v2 只能在 M4 通过平台沙箱验收后开启。M1–M3 可以分阶段合并，但必须由 feature flag 保持旧行为。

## 3. 核心接口

### 3.1 Capability 与 Action

```ts
export type CapabilityKind =
  | 'fs.read'
  | 'fs.write'
  | 'process.exec'
  | 'net.connect'
  | 'connector.invoke'
  | 'task.delegate';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface ResourceRef {
  kind: 'path' | 'domain' | 'connector' | 'process' | 'task';
  value: string;
  identity?: string;
  scope: 'workspace' | 'input' | 'scratch' | 'external' | 'critical';
}

export interface SecurityAction {
  id: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  toolName: string;
  capability: CapabilityKind;
  resources: ResourceRef[];
  payload: unknown;
  payloadHash: string;
  risk: 'read' | 'write' | 'high-risk';
  reason: string;
}
```

`SecurityAction` 由 Main 生成。Pi Runtime 只提交原始 `RuntimeActionRequest`。

### 3.2 Task Grant

```ts
export interface TaskGrant {
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  mode: 'plan' | 'standard' | 'strict';
  workspaceRoot: string;
  workspaceIdentity: string;
  inputRoots: Array<{ path: string; identity: string }>;
  scratchRoot: string;
  networkDomains: string[];
  externalCapabilities: string[];
  createdAt: number;
  expiresAt: number;
}
```

### 3.3 Policy

```ts
export interface PolicyInput {
  action: SecurityAction;
  grant: TaskGrant;
  profilePolicy: {
    mode?: 'plan' | 'standard' | 'strict';
    requireApproval?: string[];
    autoApprove?: string[];
  };
  platformReady: boolean;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  ruleId: string;
  reason: string;
  autoApproved?: boolean;
}
```

### 3.4 Platform Path Probe

```ts
export interface WorkspacePathProbe {
  inspect(target: string): Promise<{
    displayPath: string;
    canonicalPath: string;
    identity: string;
    nearestExistingAncestor: string;
    isDirectory: boolean;
    isReparsePoint: boolean;
  }>;
  isSameOrDescendant(root: string, target: string): Promise<boolean>;
  isSameObject(left: string, right: string): Promise<boolean>;
}
```

## 4. M1：安全基础

### Task 1: 定义平台安全契约和 Action 指纹

**Files:**
- Create: `packages/approval/src/security/types.ts`
- Create: `packages/approval/src/security/fingerprint.ts`
- Create: `packages/approval/src/security/index.ts`
- Modify: `packages/approval/src/index.ts`
- Test: `packages/approval/test/security-fingerprint.test.ts`

**Interfaces:**
- Consumes: `hashPayload()` from `packages/approval/src/proposal.ts`.
- Produces: `SecurityAction`, `TaskGrant`, `PolicyDecision`, `actionFingerprint()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { actionFingerprint, type SecurityAction } from '../src/security/index.js';

const action = (patch: Partial<SecurityAction> = {}): SecurityAction => ({
  id: 'a1',
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'write',
  capability: 'fs.write',
  resources: [{ kind: 'path', value: 'C:/ws/a.txt', identity: 'file:1', scope: 'workspace' }],
  payload: { content: 'x' },
  payloadHash: 'h',
  risk: 'write',
  reason: '工作区内文件修改',
  ...patch,
});

describe('actionFingerprint', () => {
  it('is stable for object key order changes', () => {
    expect(actionFingerprint(action())).toBe(actionFingerprint(action()));
  });

  it('changes when target identity changes', () => {
    expect(actionFingerprint(action())).not.toBe(actionFingerprint(action({
      resources: [{ kind: 'path', value: 'C:/ws/a.txt', identity: 'file:2', scope: 'workspace' }],
    })));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/approval/test/security-fingerprint.test.ts`

Expected: FAIL because `../src/security/index.js` does not exist.

- [ ] **Step 3: Add the minimal contracts and fingerprint**

```ts
import { hashPayload } from '../proposal.js';
import type { SecurityAction } from './types.js';

export function actionFingerprint(action: SecurityAction): string {
  return hashPayload({
    taskId: action.taskId,
    sessionId: action.sessionId,
    agentId: action.agentId,
    profileId: action.profileId,
    toolName: action.toolName,
    capability: action.capability,
    resources: action.resources,
    payloadHash: action.payloadHash,
    risk: action.risk,
  });
}
```

- [ ] **Step 4: Re-run the test**

Run: `pnpm exec vitest run packages/approval/test/security-fingerprint.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/approval/src/security packages/approval/src/index.ts packages/approval/test/security-fingerprint.test.ts
git commit -m "feat(approval): add platform security contracts"
```

### Task 2: 实现纯 Policy Engine

**Files:**
- Create: `packages/approval/src/security/policy.ts`
- Modify: `packages/approval/src/security/index.ts`
- Test: `packages/approval/test/security-policy.test.ts`

**Interfaces:**
- Consumes: `SecurityAction`, `TaskGrant`, `PolicyInput`.
- Produces: `evaluatePolicy(input: PolicyInput): PolicyOutcome`.

- [ ] **Step 1: Write failing policy tests**

```ts
import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/security/index.js';

const grant = {
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  mode: 'standard' as const,
  workspaceRoot: 'C:/ws',
  workspaceIdentity: 'dir:1',
  inputRoots: [],
  scratchRoot: 'C:/scratch/t1',
  networkDomains: [],
  externalCapabilities: [],
  createdAt: 1,
  expiresAt: 2,
};

const workspaceWrite = {
  id: 'a1',
  taskId: 't1',
  sessionId: 's1',
  agentId: 'general',
  profileId: 'general',
  toolName: 'write',
  capability: 'fs.write' as const,
  resources: [{ kind: 'path' as const, value: 'C:/ws/a.txt', identity: 'file:1', scope: 'workspace' as const }],
  payload: {},
  payloadHash: 'h',
  risk: 'write' as const,
  reason: '工作区内文件修改',
};

describe('evaluatePolicy', () => {
  it('allows ordinary workspace writes in standard mode', () => {
    expect(evaluatePolicy({
      action: workspaceWrite,
      grant,
      profilePolicy: { mode: 'standard' },
      platformReady: true,
    })).toMatchObject({ decision: 'allow', ruleId: 'workspace.write' });
  });

  it('hard-denies a critical target before profile policy', () => {
    expect(evaluatePolicy({
      action: {
        ...workspaceWrite,
        resources: [{ kind: 'path', value: 'C:/', identity: 'dir:root', scope: 'critical' }],
      },
      grant,
      profilePolicy: { autoApprove: ['*'] },
      platformReady: true,
    })).toMatchObject({ decision: 'deny', ruleId: 'platform.critical-target' });
  });

  it('uses requireApproval to elevate a normally allowed action', () => {
    expect(evaluatePolicy({
      action: workspaceWrite,
      grant,
      profilePolicy: { mode: 'standard', requireApproval: ['fs.write'] },
      platformReady: true,
    })).toMatchObject({ decision: 'ask', ruleId: 'profile.require-approval' });
  });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `pnpm exec vitest run packages/approval/test/security-policy.test.ts`

Expected: FAIL because `evaluatePolicy` is not defined.

- [ ] **Step 3: Implement deterministic evaluation order**

```ts
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { action, grant, profilePolicy, platformReady } = input;
  if (isCriticalResource(action)) {
    return { decision: 'deny', ruleId: 'platform.critical-target', reason: '目标属于不可覆盖灾难范围' };
  }
  if (grant.expiresAt <= Date.now()) {
    return { decision: 'deny', ruleId: 'task-grant.expired', reason: '任务授权已过期' };
  }
  if (!platformReady) {
    return { decision: 'deny', ruleId: 'platform.not-ready', reason: '平台安全能力不可用' };
  }
  if (grant.mode === 'plan' && (action.capability === 'fs.write' || action.capability === 'process.exec')) {
    return { decision: 'deny', ruleId: 'plan-mode.read-only', reason: '计划模式不允许修改工作区' };
  }
  if (grant.mode === 'strict' && (action.capability === 'fs.write' || action.capability === 'process.exec')) {
    return { decision: 'ask', ruleId: 'strict-mode.confirmation', reason: '严格模式要求人工确认写操作' };
  }
  if (profilePolicy.requireApproval?.includes(action.capability)) {
    return { decision: 'ask', ruleId: 'profile.require-approval', reason: 'Profile 要求人工确认' };
  }
  if (grantsAction(grant, action)) {
    return { decision: 'allow', ruleId: 'task-grant', reason: '能力属于当前任务授权' };
  }
  if (profilePolicy.autoApprove?.includes(action.capability)) {
    return {
      decision: 'allow',
      ruleId: 'profile.auto-approve',
      reason: '命中受控自动通过规则',
      autoApproved: true,
    };
  }
  return { decision: 'ask', ruleId: 'platform.capability-expansion', reason: '需要扩大任务能力' };
}

function isCriticalResource(action: SecurityAction): boolean {
  return action.resources.some((resource) => resource.scope === 'critical');
}

function grantsAction(grant: TaskGrant, action: SecurityAction): boolean {
  if (action.resources.some((resource) => resource.scope === 'critical')) return false;
  if (action.capability === 'fs.read') {
    return action.resources.every((resource) =>
      resource.scope === 'workspace' || resource.scope === 'input' || resource.scope === 'scratch',
    );
  }
  if (action.capability === 'fs.write' || action.capability === 'process.exec') {
    return action.resources.every((resource) =>
      resource.scope === 'workspace' || resource.scope === 'scratch',
    );
  }
  if (action.capability === 'net.connect') {
    return action.resources.every((resource) =>
      resource.kind === 'domain' && grant.networkDomains.includes(resource.value),
    );
  }
  if (action.capability === 'connector.invoke') {
    return action.resources.every((resource) =>
      resource.kind === 'connector' && grant.externalCapabilities.includes(resource.value),
    );
  }
  return false;
}
```

`scope` 必须由 Main 的 Action Normalizer 根据 Platform Path Probe 生成，Runtime 不能提供或覆盖。`grantsAction()` 只接受当前 Task Grant 明确包含的作用域、网络域和外部能力。

- [ ] **Step 4: Add tests for plan mode, strict mode, and expired grant**

```ts
it('asks for workspace writes in strict mode', () => {
  expect(evaluatePolicy({
    action: workspaceWrite,
    grant: { ...grant, mode: 'strict' },
    profilePolicy: { mode: 'strict' },
    platformReady: true,
  }).decision).toBe('ask');
});

it('denies an expired grant', () => {
  expect(evaluatePolicy({
    action: workspaceWrite,
    grant: { ...grant, expiresAt: 0 },
    profilePolicy: { mode: 'standard' },
    platformReady: true,
  }).decision).toBe('deny');
});
```

- [ ] **Step 5: Run package tests and typecheck**

Run: `pnpm --filter @sparkii/approval test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/approval/src/security packages/approval/test/security-policy.test.ts
git commit -m "feat(approval): add deterministic task policy engine"
```

### Task 3: 实现 Task Grant 生命周期

**Files:**
- Create: `packages/approval/src/security/task-grant-registry.ts`
- Modify: `packages/approval/src/security/index.ts`
- Test: `packages/approval/test/task-grant-registry.test.ts`

**Interfaces:**
- Consumes: `TaskGrant`.
- Produces: `TaskGrantRegistry.start()`, `.get()`, `.revoke()`, `.onRevoke()`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
import { describe, expect, it } from 'vitest';
import { TaskGrantRegistry } from '../src/security/index.js';

const grant = {
  taskId: 't1', sessionId: 's1', agentId: 'general', profileId: 'general',
  mode: 'standard' as const, workspaceRoot: 'C:/ws', workspaceIdentity: 'dir:1',
  inputRoots: [], scratchRoot: 'C:/scratch/t1', networkDomains: [], externalCapabilities: [],
  createdAt: 1, expiresAt: Date.now() + 60_000,
};

it('keeps grants isolated by session and invokes revoke listeners once', () => {
  const registry = new TaskGrantRegistry();
  const revoked: string[] = [];
  registry.start(grant);
  registry.onRevoke((id) => revoked.push(id));
  expect(registry.get('s1')?.taskId).toBe('t1');
  expect(registry.get('s2')).toBeUndefined();
  registry.revoke('s1', 'user');
  registry.revoke('s1', 'duplicate');
  expect(registry.get('s1')).toBeUndefined();
  expect(revoked).toEqual(['t1']);
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `pnpm exec vitest run packages/approval/test/task-grant-registry.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement the registry**

```ts
export class TaskGrantRegistry {
  private grants = new Map<string, TaskGrant>();
  private listeners = new Set<(taskId: string, reason: string) => void>();

  start(grant: TaskGrant): void {
    this.revoke(grant.sessionId, 'replaced');
    this.grants.set(grant.sessionId, grant);
  }

  get(sessionId: string): TaskGrant | undefined {
    const grant = this.grants.get(sessionId);
    if (grant && grant.expiresAt <= Date.now()) {
      this.revoke(sessionId, 'expired');
      return undefined;
    }
    return grant;
  }

  revoke(sessionId: string, reason: string): void {
    const grant = this.grants.get(sessionId);
    if (!grant) return;
    this.grants.delete(sessionId);
    for (const listener of this.listeners) listener(grant.taskId, reason);
  }

  onRevoke(listener: (taskId: string, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run packages/approval/test/task-grant-registry.test.ts packages/approval/test/security-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/approval/src/security packages/approval/test/task-grant-registry.test.ts
git commit -m "feat(approval): add task grant lifecycle"
```

### Task 4: 实现 Workspace Admission 核心

**Files:**
- Create: `packages/approval/src/security/workspace-admission.ts`
- Modify: `packages/approval/src/security/index.ts`
- Test: `packages/approval/test/workspace-admission.test.ts`

**Interfaces:**
- Consumes: `WorkspacePathProbe`.
- Produces: `admitWorkspace(input): Promise<WorkspaceAdmissionResult>`.

```ts
export interface ProtectedRoot {
  path: string;
  policy: 'boundary' | 'closure';
}

export interface WorkspaceAdmissionResult {
  ok: boolean;
  canonicalPath?: string;
  identity?: string;
  ruleId?: string;
  reason?: string;
}
```

- [ ] **Step 1: Write failing Admission tests**

```ts
import { expect, it } from 'vitest';
import { admitWorkspace, type WorkspacePathProbe } from '../src/security/index.js';

function fakeProbe(): WorkspacePathProbe {
  return {
    inspect: async (target) => ({
      displayPath: target,
      canonicalPath: target,
      identity: `path:${target.toLowerCase()}`,
      nearestExistingAncestor: target,
      isDirectory: true,
      isReparsePoint: false,
    }),
    isSameOrDescendant: async (root, target) => {
      const r = root.replace(/\\/g, '/').toLowerCase();
      const t = target.replace(/\\/g, '/').toLowerCase();
      return t === r || t.startsWith(`${r}/`);
    },
    isSameObject: async (left, right) =>
      left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase(),
  };
}

it('rejects a workspace below a closure root', async () => {
  const result = await admitWorkspace({
    target: 'C:/Windows/Temp/project',
    protectedRoots: [{ path: 'C:/Windows', policy: 'closure' }],
    probe: fakeProbe(),
  });
  expect(result).toMatchObject({ ok: false, ruleId: 'workspace.closure-root' });
});

it('allows a normal project below the home boundary root', async () => {
  const result = await admitWorkspace({
    target: 'C:/Users/me/Desktop/project',
    protectedRoots: [
      { path: 'C:/Users/me', policy: 'boundary' },
      { path: 'C:/Users/me/AppData', policy: 'closure' },
    ],
    probe: fakeProbe(),
  });
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm exec vitest run packages/approval/test/workspace-admission.test.ts`

Expected: FAIL because `admitWorkspace` does not exist.

- [ ] **Step 3: Implement Admission**

```ts
export async function admitWorkspace(input: {
  target: string;
  protectedRoots: ProtectedRoot[];
  probe: WorkspacePathProbe;
}): Promise<WorkspaceAdmissionResult> {
  const inspected = await input.probe.inspect(input.target);
  for (const root of input.protectedRoots) {
    const same = await input.probe.isSameOrDescendant(root.path, inspected.canonicalPath);
    if (!same) continue;
    if (root.policy === 'closure') {
      return { ok: false, ruleId: 'workspace.closure-root', reason: '工作区位于受保护闭包根内' };
    }
    const equal = await input.probe.isSameObject(root.path, inspected.canonicalPath);
    if (equal) {
      return { ok: false, ruleId: 'workspace.boundary-root', reason: '工作区不能是边界根本身' };
    }
  }
  return {
    ok: true,
    canonicalPath: inspected.canonicalPath,
    identity: inspected.identity,
  };
}
```

The implementation must compare canonical object identity, not only display strings. It must also validate that every existing ancestor is outside every closure root.

- [ ] **Step 4: Add tests for ancestors, aliases, non-existent workspaces, and control roots**

```ts
it('rejects a workspace whose nearest existing ancestor maps into a closure root', async () => {
  const probe = fakeProbe();
  probe.inspect = async (target) => ({
    displayPath: target,
    canonicalPath: 'C:/Users/me/AppData/Local/Sparkii/new-workspace',
    identity: 'path:protected',
    nearestExistingAncestor: 'C:/Users/me/AppData/Local/Sparkii',
    isDirectory: false,
    isReparsePoint: true,
  });
  const result = await admitWorkspace({
    target: 'C:/Users/me/AppData/Local/Sparkii/new-workspace',
    protectedRoots: [{ path: 'C:/Users/me/AppData/Local/Sparkii', policy: 'closure' }],
    probe,
  });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 5: Run package tests**

Run: `pnpm --filter @sparkii/approval test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/approval/src/security packages/approval/test/workspace-admission.test.ts
git commit -m "feat(approval): add workspace admission"
```

### Task 5: 实现 Windows Path Probe

**Files:**
- Create: `apps/desktop/electron/main/security/windows-platform.ts`
- Test: `apps/desktop/test/windows-platform.test.ts`

**Interfaces:**
- Consumes: `WorkspacePathProbe`, `ProtectedRoot`.
- Produces: `createWindowsPathProbe(opts, deps?)`, `windowsProtectedRoots(opts)`, `windowsPathKey(path)`.

```ts
export interface WindowsPlatformOptions {
  home: string;
  windowsDir: string;
  programFiles: string;
  programFilesX86?: string;
  appData: string;
  localAppData: string;
  dataDir: string;
  volumes?: string[];
}
```

- [ ] **Step 1: Write failing Windows probe tests**

```ts
import { expect, it } from 'vitest';
import { windowsProtectedRoots } from '../electron/main/security/windows-platform.js';

it('marks data, system, and program roots as closure roots', () => {
  const roots = windowsProtectedRoots({
    home: 'C:/Users/me',
    windowsDir: 'C:/Windows',
    programFiles: 'C:/Program Files',
    appData: 'C:/Users/me/AppData/Roaming',
    localAppData: 'C:/Users/me/AppData/Local',
    dataDir: 'C:/Users/me/AppData/Roaming/Sparkii',
  });
  expect(roots).toEqual(expect.arrayContaining([
    { path: 'C:/Windows', policy: 'closure' },
    { path: 'C:/Program Files', policy: 'closure' },
    { path: 'C:/Users/me/AppData/Roaming/Sparkii', policy: 'closure' },
    { path: 'C:/Users/me', policy: 'boundary' },
  ]));
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run apps/desktop/test/windows-platform.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement injection-friendly roots and canonicalization**

```ts
export function windowsProtectedRoots(opts: WindowsPlatformOptions): ProtectedRoot[] {
  return [
    { path: opts.home, policy: 'boundary' },
    ...(opts.volumes ?? []).map((path) => ({ path, policy: 'boundary' as const })),
    { path: opts.windowsDir, policy: 'closure' },
    { path: opts.programFiles, policy: 'closure' },
    ...(opts.programFilesX86 ? [{ path: opts.programFilesX86, policy: 'closure' as const }] : []),
    { path: opts.appData, policy: 'closure' },
    { path: opts.localAppData, policy: 'closure' },
    { path: opts.dataDir, policy: 'closure' },
  ];
}
```

`createWindowsPathProbe()` uses `realpath` for existing objects, resolves the nearest existing ancestor for missing paths, records `dev/ino` or the platform-equivalent stable identity when available, lowercases only for Windows comparisons, and returns canonical paths for the Admission core.

```ts
export function windowsPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
```

- [ ] **Step 4: Add tests for case, separator, missing paths, and injected aliases**

```ts
import { windowsPathKey } from '../electron/main/security/windows-platform.js';

it('normalizes Windows case and separators for comparisons', async () => {
  expect(windowsPathKey('C:\\Work\\Project\\')).toBe('c:/work/project');
});
```

- [ ] **Step 5: Run tests and Electron typecheck**

Run: `pnpm exec vitest run apps/desktop/test/windows-platform.test.ts`

Run: `pnpm --dir apps/desktop typecheck`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/security/windows-platform.ts apps/desktop/test/windows-platform.test.ts
git commit -m "feat(security): add Windows workspace path probe"
```

## 5. M2：Runtime 与 Main 接线

M2 应在前一阶段通过架构复核后拆成独立执行计划。设计边界已经固定：

1. 新增 `RuntimeActionRequest` / `ActionExecutionResult` transport，替换 `coding-tools` 中“所有写都先 propose”的语义。
2. Main 的 `ActionNormalizer` 使用可信工具目录重新生成 `SecurityAction`，忽略 Runtime 自报的风险和摘要。
3. `TaskGrantRegistry` 在每次 prompt run 开始时创建任务授权，在 `agent_end`、abort、session 切换和 Workspace 变更时撤销。
4. 普通 Workspace 文件操作由 `WorkspaceExecutor` 直接执行；不创建 Proposal。
5. `ASK` 仍复用现有 `ApprovalGate` 和冻结 payload。

目标文件：

- Modify: `packages/agent-host/src/pi-runtime-transport.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Modify: `packages/agent-host/src/coding-tools.ts`
- Modify: `packages/agent-host/src/tool-registry.ts`
- Create: `apps/desktop/electron/main/security/action-normalizer.ts`
- Create: `apps/desktop/electron/main/security/task-grant-factory.ts`
- Create: `apps/desktop/electron/main/security/profile-policy.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/src/loader.ts`
- Modify: `apps/desktop/agents/general/security/approval.yaml`
- Modify: `apps/desktop/agents/contract-review/security/approval.yaml`
- Modify: `apps/desktop/agents/procurement-review/security/approval.yaml`
- Test: `packages/agent-host/test/coding-tools.test.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`
- Test: `apps/desktop/test/ipc.test.ts`
- Test: `packages/config/test/loader.test.ts`

Profile 策略只允许收窄平台默认能力：

```ts
export interface PlatformProfilePolicy {
  mode?: 'plan' | 'standard' | 'strict';
  requireApproval?: string[];
  autoApprove?: string[];
}
```

`profile-policy.ts` 的职责是把旧 `approval.yaml` 字段规范化为该结构，并验证 Profile 不能增加平台未提供的能力、不能撤掉灾难目标规则、不能覆盖凭据隔离。

M2 验收：

- Runtime 伪造 `risk`、`summary` 或目标时，Main 重新生成的 Action 不变。
- Standard Workspace 文件操作不调用 `ApprovalGate.submit()`。
- 越界或外部 Action 仍调用 `ApprovalGate.submit()`。
- Task revoke 会拒绝新 Action，并触发运行时终止回调。

## 6. M3：结构化文件操作零审批

M3 将 `edit`、`write` 和结构化删除/重命名操作从 Proposal 切换到 `ALLOW` 执行。

目标文件：

- Create: `apps/desktop/electron/main/security/workspace-executor.ts`
- Create: `packages/agent-host/src/workspace-tools.ts`
- Modify: `packages/agent-host/src/coding-tools.ts`
- Modify: `packages/agent-host/src/tool-registry.ts`
- Modify: `apps/desktop/electron/main/general-executor.ts`
- Modify: `apps/desktop/electron/main/connector-registry.ts`
- Modify: `apps/desktop/agents/general/manifest.yaml`
- Modify: `apps/desktop/agents/general/agent/tools.yaml`
- Test: `apps/desktop/test/general-executor.test.ts`
- Test: `apps/desktop/test/workspace-executor.test.ts`
- Test: `packages/agent-host/test/workspace-tools.test.ts`

M3 必须遵守：

- 操作前后重新校验 Workspace 和目标对象身份。
- 文件内容写入使用“临时文件 + 原子替换”完成同目录提交。
- 删除和重命名校验父目录身份；无法获得可靠句柄时失败关闭。
- 增加平台原生 `delete` 和 `move` 结构化工具，使普通工作区删除和移动不依赖 Shell。
- 信任锚和受保护子树优先于普通 Workspace CRUD。
- 每次执行写 `action.allowed` / `action.executed` 审计，不写审批 JSONL。

M3 验收：

- 新建、修改、移动、重命名和删除普通 Workspace 文件不弹窗。
- 不产生 Proposal。
- 目标在批准后或被替换后发生变化时拒绝执行。
- 拒绝路径不产生部分写入。

## 7. M4：Windows 原生沙箱

M4 先做独立 feasibility spike，再制定生产实现计划。原型必须回答：

1. 使用受限令牌、AppContainer 或其他原生机制时，如何启动 Git Bash、PowerShell 和普通可执行文件；
2. 如何同时约束文件系统、网络、注册表敏感区、命名管道、本机服务和宿主自动化接口；
3. 如何让子进程继承限制并完整终止进程树；
4. 如何注入任务私有 scratch，同时不开放用户缓存和凭据；
5. 如何处理 8.3 短名、DOS 设备路径、卷 GUID、UNC、扩展路径前缀、目录联接、硬链接、ADS 和卷别名；
6. 如何在 Electron utility process 和打包安装环境中无管理员权限工作。

原型验收矩阵至少包含：

| 场景 | 通过条件 |
| --- | --- |
| Workspace 内写文件 | 成功 |
| 写 Workspace 外文件 | 失败 |
| 读取 `~/.ssh` 或凭据文件 | 失败 |
| 直接联网 | 失败 |
| 通过 localhost 绕过网络 | 失败 |
| 访问命名管道或宿主服务 | 失败 |
| 启动子进程并退出 | 完整终止进程树 |
| 写 scratch | 成功且其他任务不可读 |
| 访问系统目录或控制目录 | 失败 |
| 路径别名指向受保护目标 | 失败 |

原型不通过时，Standard v2 保持关闭，Shell 继续进入严格模式或明确拒绝。不得用字符串命令白名单替代沙箱。

## 8. M5：外部 Capability Gateway 与 UI

M5 应拆成独立执行计划，目标交付：

- 外部 Action 在 Main 侧使用冻结参数和能力网关执行。
- 普通审批提供“拒绝 / 仅此次 / 本任务”。
- 高风险审批保留强制模态和二次确认。
- 自动 `ALLOW` 在工具卡或审计中显示原因。
- 普通 CRUD 不再生成 `approval_required` / `approval_resolved` JSONL。
- 权限状态可查看和撤销。
- 旧会话历史审批行保持不变。

目标文件：

- Create: `apps/desktop/electron/main/security/capability-gateway.ts`
- Modify: `packages/approval/src/gate.ts`
- Modify: `packages/approval/src/proposal.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/src/trust/ApprovalInbox.tsx`
- Modify: `apps/desktop/src/trust/ApprovalCard.tsx`
- Modify: `apps/desktop/agents/general/surface/approval-timeline.ts`
- Modify: `apps/desktop/src/workbench/ToolCard.tsx`
- Test: `apps/desktop/test/approval-inbox.test.tsx`
- Test: `apps/desktop/test/approval-timeline.test.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

## 9. M6：跨平台契约

当前不实现 macOS/Linux 行为，只建立不产生平台分支的接口和 conformance test：

- `WorkspacePathProbe`；
- `WorkspaceSandboxAdapter`；
- `PlatformSecurityProbe`；
- `ProcessController`；
- `NetworkIsolationProbe`。

未来新增 macOS 或 Debian/Ubuntu Adapter 时，Policy Engine、Task Grant、审批 UI 和 Agent 包不修改。每个平台必须通过同一组安全不变量测试。

## 10. 验证命令

阶段验证：

```bash
pnpm --filter @sparkii/approval test
pnpm --filter @sparkii/agent-host test
pnpm --dir apps/desktop typecheck
pnpm exec vitest run apps/desktop/test/general-executor.test.ts
pnpm exec vitest run apps/desktop/test/workflow-broker.test.ts
pnpm exec vitest run apps/desktop/test/ipc.test.ts
```

最终回归：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## 11. 完成定义

实现完成必须同时满足：

1. Standard 普通 Workspace CRUD 零审批、零 Proposal、零审批 JSONL。
2. 越界、网络、外部副作用、信任锚和灾难目标按设计失败关闭或请求授权。
3. Main 重新计算所有安全语义，Runtime 自报字段不被信任。
4. Task 撤销覆盖新 Action 和在途执行。
5. Windows 原生沙箱通过对抗性原型矩阵。
6. 现有合同审核、采购审核、知识问答和通用智能体回归通过。
7. 新 Agent 只需要声明能力与更严格策略，不修改平台审批分支。

## 12. 自检

- 规格覆盖：平台所有权、Task Grant、Workspace Admission、Policy、Action 权威、外部能力、UI、审计、迁移和跨平台接口均有对应切片。
- 范围拆分：M1 可直接执行；M2–M6 需要各自执行计划，避免单个计划同时改动 Runtime、沙箱、外部系统和 UI。
- 安全门禁：Windows 沙箱原型是 Standard v2 的前置条件。
- 类型一致性：Capability、Action、Task Grant、Policy Outcome 和 Path Probe 在任务间使用同一命名。
- 无占位实现：第一阶段任务包含实际测试和实现代码；后续切片明确列出文件、接口和验收边界。
