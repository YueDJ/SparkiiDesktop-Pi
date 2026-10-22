# 平台统一权限模式与 Shell 自动审查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用统一、可测试的最小实现提供 Ask/AutoReview 两档权限模式，让 Workspace 普通 CRUD 直通，让宿主 Git Bash 在人工审批或独立 Reviewer 判断后受控执行。

**Architecture:** 复用现有 Main、ApprovalGate、AuditStore、Pi SDK 和 Agent Frame。Main 继续完成 Action 重算、硬拒绝、最终复核和执行；Reviewer 使用一个独立的无工具 Pi worker 进程，只做单次结构化审查，不是新 Agent。Windows Shell 直接使用宿主 Portable Git Bash 加 Job Object，AppContainer 仅保留研究代码。

**Tech Stack:** TypeScript、Node.js 22、Electron 44、Pi SDK 1.0.2、React 19、Vitest、better-sqlite3、Windows Win32 API、Portable Git Bash。

**Spec:** `docs/superpowers/specs/2026-10-21-platform-permission-modes-and-auto-review-design.md`

## Global Constraints

- 平台仅提供 `ask` 和 `auto_review`；不提供 Full、YOLO 或等价模式。
- `ask` 是默认模式；新建任务默认 Ask。
- Workspace 内普通 CRUD 在两种模式下直接执行，不创建 Proposal。
- `process.exec` 的基础决策固定为 `ASK`。
- Reviewer 只能返回严格 JSON：`allow+low|medium`、`ask+high`、`deny+critical`。
- Reviewer 是独立、无工具的 Pi worker 进程，不是用户可见 Agent，不得使用主 Agent 的会话或隐藏思维链。
- 类型化外部写、消息、邮件、工单、部署、发布和远端 Git Push 始终人工审批。
- 灾难目标、信任锚、凭据、系统目录和整个 Workspace Root 始终 DENY。
- 宿主 Git Bash 不是 OS 沙箱；UI 与审计不得宣称“沙箱内”或“无网络”。
- 超时、Task revoke、Workspace 改变、模式改变和应用退出必须终止 Shell 进程树。
- Main 必须从可信工具定义重算 Capability、目标、风险、副作用、摘要和 `payloadHash`。
- AppContainer 不得继续作为 `process.exec` 的默认依赖。
- 每个 Task 独立测试、独立提交、可单独 revert。

---

## 简化决策

这版方案刻意减少抽象和状态：

1. Reviewer 使用一个专用的无工具 Pi worker 进程，串行处理审查请求；不新建 Reviewer Agent 包、会话、工作区、进程池或 UI。
2. 不新增 Reviewer 审计表列；复用现有审计字段，把策略版本、风险、耗时和回退原因写进 `payloadSummary`。
3. 不实现独立 Reviewer 时间线状态机；UI 只显示最近一次 Reviewer 结果，完整历史继续由现有审计页提供。
4. “本任务允许 Shell”只用一个 `Set<taskId>`，因为 `TaskGrant` 已经绑定 Session、用户、Profile、Workspace 和模式。
5. circuit breaker 只实现 3 次连续 deny；精确拒绝动作用 `actionFingerprint` 阻止同载荷重放。
6. Reviewer 首版不拥有任何工具；它只消费 Main 提供的当前请求和最多 4 条紧凑工具证据。
7. 复用 `ApprovalGate`、`ProposalDecision`、`WorkspaceExecutor`、`ActionNormalizer` 和现有 UI 组件，不新增第二套审批协议。

---

## 文件结构映射

| 文件 | 责任 |
| --- | --- |
| `packages/approval/src/security/types.ts` | 权限模式、Reviewer 输出和 Action 最小扩展 |
| `packages/approval/src/security/reviewer.ts` | 严格 JSON 解析与 Reviewer 输入类型 |
| `packages/approval/src/security/policy.ts` | Workspace CRUD 直通和 Shell 基础 ASK |
| `packages/config/src/types.ts` / `schema.ts` | Profile 默认/允许模式与旧配置兼容 |
| `apps/desktop/electron/main/security/action-normalizer.ts` | 可信 Action、外部写和灾难命令分类 |
| `apps/desktop/electron/main/security/host-shell.ts` | Host Git Bash adapter |
| `apps/desktop/native/windows-sandbox/HostShellRunner.cpp` | suspended CreateProcess、Job Object、进程树终止 |
| `apps/desktop/electron/main/security/shell-reviewer.ts` | 专用 Pi Reviewer 进程、超时、串行调用 |
| `apps/desktop/electron/main/security/runtime-action-router.ts` | Ask/AutoReview 分流、Task Shell Grant、最终复核 |
| `apps/desktop/electron/main/chat-session-store.ts` | 会话级权限模式 |
| `apps/desktop/electron/main/runtime.ts` / `ipc.ts` | Host Shell、Reviewer、Task 生命周期和 IPC |
| `apps/desktop/src/trust/PermissionModeBar.tsx` | 所有 Agent 共用的模式选择、Host 和 Reviewer 状态 |
| `apps/desktop/src/trust/ApprovalCard.tsx` | Shell 的允许一次/本任务允许/拒绝 |
| `apps/desktop/src/App.tsx` | 在统一 Agent Frame 中装配权限条 |

### 目标流程

```text
RuntimeActionRequest
  -> Main 重算 SecurityAction
  -> Task 身份/过期检查
  -> 硬拒绝、信任锚和外部写检查
  -> Workspace CRUD: ALLOW
  -> process.exec: ASK
      -> Ask: 用户
      -> AutoReview: 独立 Pi Reviewer 进程
  -> Main 复核 Task/目标/payloadHash
  -> Host Git Bash + Job Object
  -> 审计
```

### Task 边界

当前产品没有跨会话持久 Task。本计划沿用一次 prompt run 作为安全 Task：

- 新 `prompt` 开始新 Task；
- 同轮 `steer`/`followUp` 复用 Task；
- `agent_settled`、abort、Workspace 改变、模式改变、会话删除、Runtime 释放和应用退出结束 Task；
- Shell Grant 只在该 Task 内有效。

---

## Task 1: 添加最小权限模式、Reviewer 输出和 Profile 配置契约

**Files:**
- Create: `packages/approval/src/security/permission-mode.ts`
- Create: `packages/approval/src/security/reviewer.ts`
- Modify: `packages/approval/src/security/types.ts`
- Modify: `packages/approval/src/security/index.ts`
- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/src/loader.ts`
- Modify: `apps/desktop/agents/general/security/approval.yaml`
- Modify: `apps/desktop/agents/contract-review/security/approval.yaml`
- Modify: `apps/desktop/agents/procurement-review/security/approval.yaml`
- Modify: `apps/desktop/agents/knowledge-qa/security/approval.yaml`
- Test: `packages/approval/test/permission-mode.test.ts`
- Test: `packages/approval/test/reviewer-contract.test.ts`
- Test: `packages/config/test/approval-policy.test.ts`

**Interfaces:**
- Consumes: 旧 `ApprovalPolicy.requireApproval/autoApprove/timeoutMs/highRiskDoubleConfirm`。
- Produces: `PlatformPermissionMode`、`ReviewerDecision`、`parseReviewerDecision(raw)`、`resolvePermissionMode(input)`；`ApprovalPolicy.defaultPermissionMode`、`allowedPermissionModes`。

**Rollback:** revert 本 Task；尚无 Runtime 行为变化。

- [ ] **Step 1: 写失败测试**

```ts
// packages/approval/test/permission-mode.test.ts
import { describe, expect, it } from 'vitest';
import { resolvePermissionMode } from '../src/security/index.js';

describe('resolvePermissionMode', () => {
  it('defaults to ask and accepts only allowed modes', () => {
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('ask');
    expect(resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      requestedMode: 'auto_review',
      allowedModes: ['ask', 'auto_review'],
    })).toBe('auto_review');
    expect(() => resolvePermissionMode({
      sessionId: 's1',
      profileId: 'general',
      requestedMode: 'auto_review',
      allowedModes: ['ask'],
    })).toThrow(/not allowed/);
  });
});
```

```ts
// packages/approval/test/reviewer-contract.test.ts
import { describe, expect, it } from 'vitest';
import { parseReviewerDecision } from '../src/security/index.js';

describe('parseReviewerDecision', () => {
  it('accepts only the fixed decision/risk pairs', () => {
    expect(parseReviewerDecision(
      '{"decision":"allow","risk":"low","reason":"普通测试命令"}',
    )).toEqual({ decision: 'allow', risk: 'low', reason: '普通测试命令' });
    expect(() => parseReviewerDecision(
      '{"decision":"allow","risk":"critical","reason":"x"}',
    )).toThrow();
    expect(() => parseReviewerDecision(
      '{"decision":"allow","risk":"low","reason":"x","extra":true}',
    )).toThrow();
  });
});
```

```ts
// packages/config/test/approval-policy.test.ts
import { describe, expect, it } from 'vitest';
import { parseApprovalPolicy } from '../src/schema.js';

describe('approval permission config', () => {
  it('defaults legacy profiles to Ask with both modes available', () => {
    expect(parseApprovalPolicy({
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
    })).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
    });
  });

  it('makes legacy strict profiles Ask-only', () => {
    expect(parseApprovalPolicy({
      mode: 'strict',
      requireApproval: [],
      timeoutMs: 300000,
      highRiskDoubleConfirm: true,
    })).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask'],
    });
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run:

```bash
pnpm exec vitest run packages/approval/test/permission-mode.test.ts packages/approval/test/reviewer-contract.test.ts packages/config/test/approval-policy.test.ts
```

Expected: FAIL because the new exports and config fields do not exist.

- [ ] **Step 3: 写最小实现**

```ts
// packages/approval/src/security/types.ts
export type PlatformPermissionMode = 'ask' | 'auto_review';
export type ReviewerDecision =
  | { decision: 'allow'; risk: 'low' | 'medium'; reason: string }
  | { decision: 'ask'; risk: 'high'; reason: string }
  | { decision: 'deny'; risk: 'critical'; reason: string };
```

```ts
// packages/approval/src/security/permission-mode.ts
export function resolvePermissionMode(input: {
  sessionId: string;
  profileId: string;
  requestedMode?: PlatformPermissionMode;
  sessionMode?: PlatformPermissionMode;
  profileDefaultMode?: PlatformPermissionMode;
  allowedModes: readonly PlatformPermissionMode[];
}): PlatformPermissionMode {
  if (!input.allowedModes.includes('ask')) {
    throw new Error('Ask must remain allowed');
  }
  const mode = input.requestedMode
    ?? input.sessionMode
    ?? input.profileDefaultMode
    ?? 'ask';
  if (!input.allowedModes.includes(mode)) {
    throw new Error(`permission mode ${mode} is not allowed`);
  }
  return mode;
}
```

```ts
// packages/approval/src/security/reviewer.ts
export function parseReviewerDecision(raw: string): ReviewerDecision {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Reviewer output is not JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('invalid reviewer output');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'decision,reason,risk') {
    throw new Error('reviewer fields are invalid');
  }
  if (typeof row.reason !== 'string' || !row.reason.trim()) {
    throw new Error('reviewer reason is required');
  }
  const reason = row.reason.trim().slice(0, 500);
  if (row.decision === 'allow' && (row.risk === 'low' || row.risk === 'medium')) {
    return { decision: 'allow', risk: row.risk, reason };
  }
  if (row.decision === 'ask' && row.risk === 'high') {
    return { decision: 'ask', risk: 'high', reason };
  }
  if (row.decision === 'deny' && row.risk === 'critical') {
    return { decision: 'deny', risk: 'critical', reason };
  }
  throw new Error('reviewer decision/risk pair is invalid');
}
```

```ts
export interface ShellReviewInput {
  taskId: string;
  sessionId: string;
  actionId: string;
  userTask: string;
  toolName: string;
  capability: string;
  risk: string;
  command: string;
  cwd: string;
  workspaceRoot: string;
  targets: string[];
  recentEvidence: Array<{
    toolName: string;
    status: 'executed' | 'denied' | 'failed';
    summary: string;
    exitCode?: number | null;
  }>;
  hardDenyPolicyVersion: string;
  payloadHash: string;
  unattended: boolean;
}
```

Config 采用可选字段兼容旧 YAML，加载时归一化：

```ts
export interface ApprovalPolicy {
  autoApprove?: string[];
  requireApproval: string[];
  timeoutMs: number;
  highRiskDoubleConfirm: boolean;
  defaultPermissionMode?: 'ask' | 'auto_review';
  allowedPermissionModes?: Array<'ask' | 'auto_review'>;
  /** Legacy hint only. */
  mode?: 'standard' | 'strict';
}
```

`parseApprovalPolicy()` 的规则：

```ts
const allowedPermissionModes = value.allowedPermissionModes
  ?? (value.mode === 'strict'
    ? ['ask']
    : ['ask', 'auto_review']);
const defaultPermissionMode = value.defaultPermissionMode ?? 'ask';
if (!allowedPermissionModes.includes('ask')) {
  throw new Error('allowedPermissionModes must include ask');
}
if (!allowedPermissionModes.includes(defaultPermissionMode)) {
  throw new Error('defaultPermissionMode must be allowed');
}
```

四个内置 Agent 的 `approval.yaml` 显式增加：

```yaml
defaultPermissionMode: ask
allowedPermissionModes: [ask, auto_review]
```

- [ ] **Step 4: 再跑测试**

Run:

```bash
pnpm exec vitest run packages/approval/test/permission-mode.test.ts packages/approval/test/reviewer-contract.test.ts packages/config/test/approval-policy.test.ts packages/config/test/loader.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/approval/src/security/types.ts packages/approval/src/security/permission-mode.ts packages/approval/src/security/reviewer.ts packages/approval/src/security/index.ts packages/approval/test/permission-mode.test.ts packages/approval/test/reviewer-contract.test.ts packages/config/src/types.ts packages/config/src/schema.ts packages/config/src/loader.ts packages/config/test/approval-policy.test.ts apps/desktop/agents/general/security/approval.yaml apps/desktop/agents/contract-review/security/approval.yaml apps/desktop/agents/procurement-review/security/approval.yaml apps/desktop/agents/knowledge-qa/security/approval.yaml
git commit -m "feat(approval): add permission mode contracts"
```

---

## Task 2: 让 Workspace CRUD 直通并把 Shell 固定为基础 ASK

**Files:**
- Modify: `packages/approval/src/security/types.ts`
- Modify: `packages/approval/src/security/policy.ts`
- Modify: `apps/desktop/electron/main/security/action-normalizer.ts`
- Modify: `apps/desktop/electron/main/security/profile-policy.ts`
- Modify: `apps/desktop/electron/main/security/task-grant-factory.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/test/action-normalizer.test.ts`
- Modify: `apps/desktop/test/profile-policy.test.ts`
- Modify: `apps/desktop/test/task-grant-factory.test.ts`
- Modify: `apps/desktop/test/task-lifecycle.test.ts`
- Modify: `apps/desktop/test/runtime-action-router.test.ts`
- Modify: `apps/desktop/test/workspace-executor.test.ts`
- Modify: `apps/desktop/test/task-capability-status.test.tsx`
- Modify: `apps/desktop/test/ipc.test.ts`
- Test: `packages/approval/test/security-policy.test.ts`
- Test: `packages/approval/test/task-grant-registry.test.ts`
- Test: `packages/approval/test/capability-gateway.test.ts`

**Interfaces:**
- Consumes: `PlatformPermissionMode`、Profile 的 `requireApproval/autoApprove`。
- Produces: `TaskGrant.planMode`、`TaskGrant.permissionMode`、`TaskGrant.actorId`、`TaskGrant.unattended`；`SecurityAction.approvalClass`、`hardDenyRule`；`evaluatePolicy()`。

**Rollback:** revert 本 Task；旧 AppContainer 拒绝行为恢复。

- [ ] **Step 1: 写失败策略测试**

```ts
// packages/approval/test/security-policy.test.ts
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type SecurityAction, type TaskGrant } from '../src/security/index.js';

const grant: TaskGrant = {
  taskId: 't1', sessionId: 's1', agentId: 'general', profileId: 'general',
  actorId: 'u1', unattended: false, planMode: 'execute', permissionMode: 'ask',
  workspaceRoot: 'C:/ws', workspaceIdentity: 'dir:1',
  inputRoots: [], scratchRoot: 'C:/scratch/t1',
  networkDomains: [], externalCapabilities: [], createdAt: 1, expiresAt: 2000,
};
const write: SecurityAction = {
  id: 'a1', subjectId: 'u1', taskId: 't1', sessionId: 's1',
  agentId: 'general', profileId: 'general', toolName: 'write',
  capability: 'fs.write', approvalClass: 'auto',
  resources: [{ kind: 'path', value: 'C:/ws/a.txt', identity: 'f1', scope: 'workspace' }],
  payload: {}, payloadHash: 'h', risk: 'write', reason: 'workspace write',
};
const policy = {
  defaultPermissionMode: 'ask' as const,
  allowedPermissionModes: ['ask', 'auto_review'] as const,
  requireApproval: ['fs.write'],
  autoApprove: [],
};

describe('evaluatePolicy', () => {
  it('allows workspace CRUD in both modes before requireApproval', () => {
    expect(evaluatePolicy({ action: write, grant, profilePolicy: policy, platformReady: true, now: 1000 }))
      .toMatchObject({ decision: 'allow', ruleId: 'workspace.crud' });
    expect(evaluatePolicy({
      action: write,
      grant: { ...grant, permissionMode: 'auto_review' },
      profilePolicy: policy,
      platformReady: true,
      now: 1000,
    })).toMatchObject({ decision: 'allow', ruleId: 'workspace.crud' });
  });

  it('keeps shell as base ask and never uses autoApprove as allow', () => {
    const shell = {
      ...write,
      toolName: 'bash',
      capability: 'process.exec' as const,
      approvalClass: 'shell' as const,
      resources: [{ kind: 'process', value: 'bash', identity: 'host', scope: 'workspace' as const }],
    };
    expect(evaluatePolicy({
      action: shell,
      grant: { ...grant, permissionMode: 'auto_review' },
      profilePolicy: { ...policy, autoApprove: ['process.exec'] },
      platformReady: true,
      now: 1000,
    })).toMatchObject({ decision: 'ask', ruleId: 'platform.base-ask' });
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run:

```bash
pnpm exec vitest run packages/approval/test/security-policy.test.ts
```

Expected: FAIL because the old model uses `RunMode`, permits `process.exec`, and applies `requireApproval` to workspace writes.

- [ ] **Step 3: 实现最小策略**

```ts
// packages/approval/src/security/types.ts
export type PlanMode = 'plan' | 'execute';
export type ActionApprovalClass = 'auto' | 'shell' | 'human_required';

export interface TaskGrant {
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  actorId: string;
  unattended: boolean;
  planMode: PlanMode;
  permissionMode: PlatformPermissionMode;
  workspaceRoot: string;
  workspaceIdentity: string;
  inputRoots: Array<{ path: string; identity: string }>;
  scratchRoot: string;
  networkDomains: string[];
  externalCapabilities: string[];
  createdAt: number;
  expiresAt: number;
}

export interface SecurityAction {
  id: string;
  subjectId: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  profileId: string;
  toolName: string;
  capability: CapabilityKind;
  approvalClass: ActionApprovalClass;
  resources: ResourceRef[];
  payload: unknown;
  payloadHash: string;
  risk: SecurityRisk;
  reason: string;
  externalEffect?: string;
  hardDenyRule?: string;
}
```

```ts
// packages/approval/src/security/policy.ts
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { action, grant } = input;
  const now = input.now ?? Date.now();

  if (
    action.subjectId !== grant.actorId
    || action.taskId !== grant.taskId
    || action.sessionId !== grant.sessionId
    || action.agentId !== grant.agentId
    || action.profileId !== grant.profileId
  ) {
    return { decision: 'deny', ruleId: 'task-grant.identity', reason: '任务身份不匹配' };
  }
  if (grant.expiresAt <= now) {
    return { decision: 'deny', ruleId: 'task-grant.expired', reason: '任务授权已过期' };
  }
  if (action.resources.some((r) => r.scope === 'critical' || r.trustAnchor)) {
    return { decision: 'deny', ruleId: 'platform.hard-deny', reason: '目标属于不可覆盖保护范围' };
  }
  if (action.hardDenyRule) {
    return { decision: 'deny', ruleId: action.hardDenyRule, reason: '命中确定性硬拒绝规则' };
  }
  if (grant.planMode === 'plan' && action.capability !== 'fs.read') {
    return { decision: 'deny', ruleId: 'plan-mode.read-only', reason: '计划模式只允许读取' };
  }
  if (!input.platformReady) {
    return { decision: 'deny', ruleId: 'platform.not-ready', reason: '执行器不可用' };
  }
  if (action.approvalClass === 'auto' && withinGrant(grant, action)) {
    return { decision: 'allow', ruleId: 'workspace.crud', reason: 'Workspace 普通文件操作' };
  }
  if (action.approvalClass === 'auto') {
    return { decision: 'deny', ruleId: 'workspace.write-outside', reason: '结构化写工具不能扩大 Workspace' };
  }
  if (action.approvalClass === 'human_required') {
    return { decision: 'ask', ruleId: 'platform.human-required', reason: '该动作只能人工审批' };
  }
  if (action.capability === 'process.exec') {
    return { decision: 'ask', ruleId: 'platform.base-ask', reason: 'Shell 需要审批或独立审查' };
  }
  if (matchesProfileApproval(input.profilePolicy, action)) {
    return { decision: 'ask', ruleId: 'profile.require-approval', reason: 'Profile 要求审批' };
  }
  if (withinGrant(grant, action)) {
    return { decision: 'allow', ruleId: 'task-grant', reason: '任务已有授权' };
  }
  return { decision: 'ask', ruleId: 'platform.capability-expansion', reason: '需要扩大任务能力' };
}
```

`withinGrant()` 不接受 `process.exec`；`autoApprove` 不参与 `allow`。ActionNormalizer 将：

- `write/edit/delete/move` 标为 `auto`；
- `bash` 标为 `shell`；
- `git push` 标为 `human_required`；
- `report.export` 等外部写标为 `human_required`；
- 明确指向 `/`、`~` 或盘符根的 `rm -rf` 标记 `hardDenyRule`。

`TaskGrant` 构造增加 `actorId`、`unattended`、`planMode`、`permissionMode`；现有测试 fixture 同步更新。`getTaskCapabilities` 返回 `permissionMode`、`planMode`，移除旧 `mode`。

- [ ] **Step 4: 运行策略和类型测试**

Run:

```bash
pnpm exec vitest run packages/approval/test/security-policy.test.ts packages/approval/test/task-grant-registry.test.ts packages/approval/test/capability-gateway.test.ts apps/desktop/test/action-normalizer.test.ts apps/desktop/test/profile-policy.test.ts apps/desktop/test/task-grant-factory.test.ts apps/desktop/test/task-lifecycle.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/workspace-executor.test.ts apps/desktop/test/task-capability-status.test.tsx apps/desktop/test/ipc.test.ts
```

Expected: PASS；Workspace 两模式直通，Shell 基础 ASK，外部写人工审批，确定性硬拒绝优先。

- [ ] **Step 5: 提交**

```bash
git add packages/approval/src/security/types.ts packages/approval/src/security/policy.ts packages/approval/test/security-policy.test.ts packages/approval/test/task-grant-registry.test.ts packages/approval/test/capability-gateway.test.ts apps/desktop/electron/main/security/action-normalizer.ts apps/desktop/electron/main/security/profile-policy.ts apps/desktop/electron/main/security/task-grant-factory.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/preload/api-types.ts apps/desktop/test/action-normalizer.test.ts apps/desktop/test/profile-policy.test.ts apps/desktop/test/task-grant-factory.test.ts apps/desktop/test/task-lifecycle.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/workspace-executor.test.ts apps/desktop/test/task-capability-status.test.tsx apps/desktop/test/ipc.test.ts
git commit -m "feat(policy): simplify permission mode decisions"
```

---

## Task 3: 用 Host Git Bash 和 Job Object 执行 Shell

**Files:**
- Create: `packages/approval/src/security/host-shell.ts`
- Create: `apps/desktop/electron/main/security/host-shell.ts`
- Create: `apps/desktop/native/windows-sandbox/HostShellRunner.cpp`
- Modify: `packages/approval/src/security/index.ts`
- Modify: `apps/desktop/native/windows-sandbox/build.cmd`
- Modify: `apps/desktop/electron-builder.yml`
- Test: `apps/desktop/test/host-shell-adapter.test.ts`
- Test: `apps/desktop/test/host-shell-integration.test.ts`

**Interfaces:**
- Consumes: Portable Git `bashPath`、Workspace、Task scratch、command、timeout。
- Produces: `HostShellAdapter`、`createHostShellAdapter(opts)`、`HostShellReport`。

**Rollback:** revert 本 Task；Runtime 尚未使用新 adapter。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/test/host-shell-adapter.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHostShellEnvironment,
  createHostShellAdapter,
} from '../electron/main/security/host-shell.js';

it('drops credentials from environment', () => {
  const env = buildHostShellEnvironment(
    { SystemRoot: 'C:/Windows', DEEPSEEK_API_KEY: 'secret' },
    'C:/portable-git',
    'C:/task/scratch',
  );
  expect(env.PATH).toContain('C:/portable-git/bin');
  expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
  expect(env.HOME).toBe('C:/task/scratch/home');
});

it('reports host semantics without sandbox claims', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-shell-'));
  const bashPath = join(root, 'bash.exe');
  const helperPath = join(root, 'HostShellRunner.exe');
  writeFileSync(bashPath, 'stub');
  writeFileSync(helperPath, 'stub');
  const adapter = createHostShellAdapter({ bashPath, helperPath, platform: 'win32' });
  await expect(adapter.probe()).resolves.toMatchObject({
    status: 'available',
    backend: 'host-git-bash',
    executionBoundary: 'host',
  });
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/host-shell-adapter.test.ts
```

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: 实现 adapter 和 native helper**

最小接口：

```ts
export interface HostShellAdapter {
  probe(): Promise<{
    backend: 'host-git-bash';
    status: 'available' | 'unavailable';
    executionBoundary: 'host';
    version: 'host-job-v1';
    limitations: string[];
  }>;
  run(request: {
    taskId: string;
    workspaceRoot: string;
    scratchRoot: string;
    command: string;
    timeoutMs: number;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>;
  terminate(taskId: string): Promise<void>;
}
```

Node adapter：

- 使用 `spawn(HostShellRunner.exe, args, { windowsHide: true })`；
- 将命令 base64 传入；
- 只传白名单环境变量：`PATH/SystemRoot/ComSpec/HOME/TEMP/TMP/APPDATA/LOCALAPPDATA/LANG/GIT_TERMINAL_PROMPT/GIT_CONFIG_NOSYSTEM`；
- stdout/stderr 各自截断到 128 KiB；
- 按 `taskId` 保存 helper 子进程，`terminate()` 调用 `child.kill()`，由 Job 关闭触发完整进程树终止。

`HostShellRunner.cpp` 的核心：

```cpp
HANDLE job = CreateJobObjectW(nullptr, nullptr);
JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));

CreateProcessW(..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, ...);
AssignProcessToJobObject(job, process.hProcess);
ResumeThread(process.hThread);
WaitForSingleObject(process.hProcess, timeoutMs);
if (timedOut) TerminateJobObject(job, 1);
```

helper 不继承父环境，只构造显式环境块；stdout/stderr 写入 Task scratch，向父进程返回 JSON。

- [ ] **Step 4: 构建并验证**

Run:

```bash
pnpm --dir apps/desktop build:native-sandbox
pnpm exec vitest run apps/desktop/test/host-shell-adapter.test.ts apps/desktop/test/host-shell-integration.test.ts
```

Expected: 白名单和环境测试 PASS；Windows 上 `printf host-ok` 返回 `exitCode: 0` 和 `stdout: "host-ok"`。

- [ ] **Step 5: 提交**

```bash
git add packages/approval/src/security/host-shell.ts packages/approval/src/security/index.ts apps/desktop/electron/main/security/host-shell.ts apps/desktop/native/windows-sandbox/HostShellRunner.cpp apps/desktop/native/windows-sandbox/build.cmd apps/desktop/electron-builder.yml apps/desktop/test/host-shell-adapter.test.ts apps/desktop/test/host-shell-integration.test.ts
git commit -m "feat(shell): add host git bash job runner"
```

---

## Task 4: 实现单个无工具 Pi Reviewer 进程

**Files:**
- Create: `apps/desktop/electron/main/security/shell-reviewer.ts`
- Modify: `packages/agent-host/src/types.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `apps/desktop/test/shell-reviewer.test.ts`

**Interfaces:**
- Consumes: `parseReviewerDecision()`、`PiRuntimeSupervisor`、`createUtilityHostHandle`、`keyFor(provider)`。
- Produces: `createPiShellReviewer(opts)`；`.review(input)`、`.cancel(taskId)`、`.dispose()`。

**Rollback:** revert 本 Task；Router 尚未调用 Reviewer。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/test/shell-reviewer.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPiShellReviewer } from '../electron/main/security/shell-reviewer.js';

it('uses a serial no-tool worker and parses fixed JSON', async () => {
  const send = vi.fn(async (command: any) => {
    if (command.type === 'complete') {
      return {
        success: true,
        data: '{"decision":"allow","risk":"low","reason":"普通测试命令"}',
      };
    }
    return { success: true };
  });
  const reviewer = createPiShellReviewer({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    timeoutMs: 1000,
    keyFor: async () => 'test-key',
    makeClient: async () => ({
      send,
      stop: vi.fn(async () => {}),
    }),
  });

  await expect(reviewer.review({
    taskId: 't1',
    sessionId: 's1',
    actionId: 'a1',
    userTask: '运行测试',
    toolName: 'bash',
    capability: 'process.exec',
    risk: 'write',
    command: 'pnpm test',
    cwd: 'C:/ws',
    workspaceRoot: 'C:/ws',
    targets: [],
    recentEvidence: [],
    hardDenyPolicyVersion: 'hard-deny-v1',
    payloadHash: 'h',
    unattended: false,
  })).resolves.toEqual({
    decision: 'allow',
    risk: 'low',
    reason: '普通测试命令',
  });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'complete',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    system: expect.stringContaining('Return one JSON object'),
  }));
});

it('kills the worker after timeout', async () => {
  const stop = vi.fn(async () => {});
  const reviewer = createPiShellReviewer({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    timeoutMs: 1,
    keyFor: async () => 'test-key',
    makeClient: async () => ({
      send: vi.fn(() => new Promise(() => {})),
      stop,
    }),
  });
  await expect(reviewer.review({
    taskId: 't1', sessionId: 's1', actionId: 'a1',
    userTask: 'x', toolName: 'bash', capability: 'process.exec', risk: 'write',
    command: 'x', cwd: 'C:/ws', workspaceRoot: 'C:/ws', targets: [],
    recentEvidence: [], payloadHash: 'h', unattended: false,
    hardDenyPolicyVersion: 'hard-deny-v1',
  })).rejects.toThrow(/timed out/);
  expect(stop).toHaveBeenCalled();
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/shell-reviewer.test.ts
```

Expected: FAIL because Reviewer worker does not exist.

- [ ] **Step 3: 实现单 worker、单队列**

```ts
export function createPiShellReviewer(opts: {
  provider: string;
  modelId: string;
  timeoutMs: number;
  keyFor(provider: string): Promise<string | null>;
  makeClient(): Promise<{
    send(command: any): Promise<{ success: boolean; data?: unknown; error?: string }>;
    stop(): Promise<void>;
  }>;
}) {
  let client: Awaited<ReturnType<typeof opts.makeClient>> | null = null;
  let queue = Promise.resolve();
  let currentTaskId: string | null = null;
  const cancelledTasks = new Set<string>();

  const ensure = async () => {
    if (client) return client;
    client = await opts.makeClient();
    const key = await opts.keyFor(opts.provider);
    if (key) {
      await client.send({ type: 'set_api_key', provider: opts.provider, apiKey: key });
    }
    return client;
  };

  const reset = async () => {
    const current = client;
    client = null;
    currentTaskId = null;
    await current?.stop().catch(() => {});
  };

  return {
    review(input: ShellReviewInput) {
      const run = async () => {
        if (cancelledTasks.delete(input.taskId)) {
          throw new Error('Reviewer canceled');
        }
        const worker = await ensure();
        currentTaskId = input.taskId;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            worker.send({
              type: 'complete',
              provider: opts.provider,
              modelId: opts.modelId,
              system: REVIEWER_SYSTEM_PROMPT,
              text: JSON.stringify(input),
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Reviewer timed out')), opts.timeoutMs);
            }),
          ]);
          if (!response.success) throw new Error(response.error ?? 'Reviewer failed');
          return parseReviewerDecision(String(response.data ?? ''));
        } catch (error) {
          await reset();
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
          currentTaskId = null;
        }
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async cancel(taskId: string) {
      cancelledTasks.add(taskId);
      if (currentTaskId === taskId) await reset();
    },
    dispose: reset,
  };
}
```

`complete` RPC 增加可选 `system` 字段；Pi SDK 使用 system+user 两条 message 调用 `completeSimple`。Reviewer 进程不配置 saddle，因此没有 bash、edit、write、连接器或 Skill。

- [ ] **Step 4: 运行 Reviewer 测试**

Run:

```bash
pnpm exec vitest run packages/approval/test/reviewer-contract.test.ts apps/desktop/test/shell-reviewer.test.ts
```

Expected: PASS；请求串行、输出严格、超时会关闭 worker。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/security/shell-reviewer.ts apps/desktop/test/shell-reviewer.test.ts packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts
git commit -m "feat(review): add dedicated pi reviewer worker"
```

---

## Task 5: 在现有 Router 中加入 Ask、AutoReview 和轻量 Task Shell Grant

**Files:**
- Create: `apps/desktop/electron/main/security/shell-grant-store.ts`
- Modify: `apps/desktop/electron/main/security/runtime-action-router.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Modify: `packages/agent-host/src/pi-runtime-transport.ts`
- Test: `apps/desktop/test/shell-grant-store.test.ts`
- Test: `apps/desktop/test/runtime-action-router.test.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Consumes: `ShellReviewInput`、Reviewer worker、`TaskGrant.permissionMode`。
- Produces: `ShellGrantStore`；`ApprovalResolution = { choice: 'once'|'task'|'deny' }`；`RuntimeActionRouterOptions.reviewShell(action, grant)`；最终 `PolicyOutcome` 和 Action 结果。

**Rollback:** revert 本 Task；Reviewer 与 Host Shell 保留但不接线。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/test/shell-grant-store.test.ts
import { describe, expect, it } from 'vitest';
import { ShellGrantStore } from '../electron/main/security/shell-grant-store.js';

it('stores only the current task id and revokes it', () => {
  let now = 100;
  const store = new ShellGrantStore(() => now);
  store.grant('t1', 200);
  expect(store.allows('t1')).toBe(true);
  expect(store.allows('t2')).toBe(false);
  store.revoke('t1');
  expect(store.allows('t1')).toBe(false);
  store.grant('t1', 200);
  now = 200;
  expect(store.allows('t1')).toBe(false);
});
```

```ts
// apps/desktop/test/runtime-action-router.test.ts
it('uses Reviewer for shell in auto_review', async () => {
  const h = await harness({ permissionMode: 'auto_review' });
  h.review.mockResolvedValue({
    decision: 'allow',
    risk: 'low',
    reason: '普通测试命令',
  });
  const result = await h.router.route({
    requestId: 'r1',
    toolName: 'bash',
    args: { command: 'pnpm test' },
  }, 's1');
  expect(result).toMatchObject({
    status: 'executed',
    decision: { decision: 'allow', ruleId: 'reviewer.allow' },
  });
  expect(h.requestApproval).not.toHaveBeenCalled();
});

it('falls back to Ask when Reviewer is unavailable', async () => {
  const h = await harness({ permissionMode: 'auto_review' });
  h.review.mockRejectedValue(new Error('timed out'));
  const result = await h.router.route({
    requestId: 'r2',
    toolName: 'bash',
    args: { command: 'pnpm build' },
  }, 's1');
  expect(result.status).toBe('executed');
  expect(h.requestApproval).toHaveBeenCalledTimes(1);
});

it('reuses task shell approval without asking again', async () => {
  const h = await harness({ approvalChoice: 'task' });
  await h.router.route({
    requestId: 'r3',
    toolName: 'bash',
    args: { command: 'pnpm test' },
  }, 's1');
  h.requestApproval.mockClear();
  await h.router.route({
    requestId: 'r4',
    toolName: 'bash',
    args: { command: 'pnpm lint' },
  }, 's1');
  expect(h.requestApproval).not.toHaveBeenCalled();
  expect(h.execute).toHaveBeenCalledTimes(2);
});

it('never sends external writes or git push to Reviewer', async () => {
  const h = await harness({ permissionMode: 'auto_review' });
  await h.router.route({
    requestId: 'e1',
    toolName: 'report.export',
    args: { path: 'C:/out/report.docx' },
  }, 's1');
  await h.router.route({
    requestId: 'p1',
    toolName: 'bash',
    args: { command: 'git push origin main' },
  }, 's1');
  expect(h.review).not.toHaveBeenCalled();
  expect(h.requestApproval).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/shell-grant-store.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/workflow-broker.test.ts
```

Expected: FAIL because Router only supports a boolean user approval.

- [ ] **Step 3: 实现 20 行 Shell Grant Store**

```ts
export class ShellGrantStore {
  private grants = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  grant(taskId: string, expiresAt: number): void {
    this.grants.set(taskId, expiresAt);
  }
  allows(taskId: string): boolean {
    const expiresAt = this.grants.get(taskId);
    if (expiresAt !== undefined && expiresAt > this.now()) return true;
    this.grants.delete(taskId);
    return false;
  }
  revoke(taskId: string): void {
    this.grants.delete(taskId);
  }
}
```

TaskGrant 已绑定 Session、用户、Profile、Workspace 和权限模式，因此这里只需保存 Task ID。

- [ ] **Step 4: 在 Router 内实现明确分支**

```ts
export interface RuntimeActionRouterOptions {
  // existing lifecycle/normalizer/profilePolicyOf/platformReady/... options remain
  shellGrants: ShellGrantStore;
  reviewerModel: string;
  reviewerPolicyVersion: string;
  userTaskOf(sessionId: string): string;
  reviewShell(
    input: ShellReviewInput,
  ): Promise<ReviewerDecision>;
  requestApproval(
    action: SecurityAction,
    grant: TaskGrant,
    riskOverride?: SecurityRisk,
  ): Promise<ApprovalResolution>;
}

// createRuntimeActionRouter() 内只初始化一次
const {
  shellGrants,
  lifecycle,
  reviewShell,
  requestApproval,
} = options;
const deniedFingerprints = new Map<string, Set<string>>();
const reviewerDenials = new Map<string, number>();
const evidenceByTask = new Map<string, ShellReviewInput['recentEvidence']>();

if (outcome.decision === 'ask') {
  const fingerprint = actionFingerprint(action);
  if (deniedFingerprints.get(action.taskId)?.has(fingerprint)) {
    return denied(request.requestId, {
      decision: 'deny',
      ruleId: 'reviewer.replay-denied',
      reason: 'Reviewer 已拒绝相同动作',
    }, 'USER_DENIED', 'denied action replay');
  }

  if (
    action.capability === 'process.exec'
    && action.approvalClass === 'shell'
    && action.risk !== 'high-risk'
    && shellGrants.allows(action.taskId)
  ) {
    outcome = {
      decision: 'allow',
      ruleId: 'task-shell-grant',
      reason: '当前任务已允许普通 Shell',
    };
  } else if (
    grant.permissionMode === 'auto_review'
    && action.approvalClass === 'shell'
  ) {
    try {
      const started = Date.now();
      const reviewed = await reviewShell(buildReviewInput(action, grant));
      await auditReview(action, reviewed, Date.now() - started);
      if (reviewed.decision === 'deny') {
        const denied = deniedFingerprints.get(action.taskId) ?? new Set<string>();
        denied.add(fingerprint);
        deniedFingerprints.set(action.taskId, denied);
        const count = (reviewerDenials.get(action.taskId) ?? 0) + 1;
        reviewerDenials.set(action.taskId, count);
        if (count >= 3) {
          await lifecycle.end(sessionId, 'reviewer-circuit-open');
        }
        return denied(request.requestId, {
          decision: 'deny',
          ruleId: 'reviewer.deny',
          reason: reviewed.reason,
        }, 'USER_DENIED', reviewed.reason);
      }
      reviewerDenials.delete(action.taskId);
      if (reviewed.decision === 'ask') {
        const approval = await requestApproval(action, grant, 'high-risk');
        if (approval.choice === 'deny') {
          return denied(request.requestId, outcome, 'USER_DENIED', 'user denied');
        }
        outcome = { decision: 'allow', ruleId: 'reviewer.ask-approved', reason: reviewed.reason };
      } else {
        outcome = { decision: 'allow', ruleId: 'reviewer.allow', reason: reviewed.reason };
      }
    } catch (error) {
      await audit.append({
        actor: `reviewer:${options.reviewerModel}`,
        action: 'reviewer.fallback',
        resource: action.toolName,
        payloadSummary: JSON.stringify({
          policyVersion: options.reviewerPolicyVersion,
          error: error instanceof Error ? error.message : String(error),
          fallback: grant.unattended ? 'deny' : 'ask',
        }),
        sessionId: action.sessionId,
        taskId: action.taskId,
        actionId: action.id,
        payloadHash: action.payloadHash,
        decision: grant.unattended ? 'denied' : 'ask',
        ruleId: 'reviewer.fallback',
      });
      if (grant.unattended) {
        return denied(request.requestId, outcome, 'USER_DENIED',
          'Reviewer unavailable for unattended task');
      }
      const approval = await requestApproval(action, grant, 'high-risk');
      if (approval.choice === 'deny') {
        return denied(request.requestId, outcome, 'USER_DENIED', 'user denied');
      }
      outcome = { decision: 'allow', ruleId: 'reviewer.fallback-ask', reason: 'Reviewer 不可用，已转人工' };
    }
  } else {
    const approval = await requestApproval(action, grant);
    if (approval.choice === 'deny') {
      return denied(request.requestId, outcome, 'USER_DENIED', 'user denied');
    }
    if (approval.choice === 'task') {
      if (
        action.capability !== 'process.exec'
        || action.approvalClass !== 'shell'
        || action.risk === 'high-risk'
      ) {
        return denied(request.requestId, outcome, 'INVALID_APPROVAL_SCOPE',
          'Task scope is only valid for ordinary shell');
      }
      shellGrants.grant(action.taskId, grant.expiresAt);
    }
    outcome = { decision: 'allow', ruleId: 'user.approved', reason: '用户已批准' };
  }
}
```

最终仍执行原有的 Task 再校验、路径身份复核和 `execute()`。Reviewer 审计复用现有字段：

```ts
const auditReview = (
  action: SecurityAction,
  reviewed: ReviewerDecision,
  durationMs: number,
) => audit.append({
  actor: `reviewer:${options.reviewerModel}`,
  action: 'reviewer.decision',
  resource: action.toolName,
  payloadSummary: JSON.stringify({
    policyVersion: options.reviewerPolicyVersion,
    risk: reviewed.risk,
    durationMs,
    reason: reviewed.reason,
    fallback: false,
  }),
  sessionId: action.sessionId,
  taskId: action.taskId,
  actionId: action.id,
  payloadHash: action.payloadHash,
  decision: reviewed.decision,
  ruleId: `reviewer.${reviewed.decision}`,
});
```

`ProposalDecision` 增加 `approvalScope?: 'once' | 'task'`；未提供时为 `once`。只有 RuntimeActionRouter 可以把 `task` 转为 Shell Grant。

IPC 的 `requestApproval()` 在收到 `riskOverride: 'high-risk'` 时克隆 Action 并把 Proposal 风险设为 `high-risk`，使 Reviewer 返回 `ask` 时使用现有高风险二次确认；原 Action 和 `payloadHash` 不变。

Router 在内存中按 Task 保留最多 4 条 `{toolName,status,summary,exitCode}` 证据；`summary` 截断到 256 字。`buildReviewInput()` 只传当前用户请求、当前命令/cwd/Workspace、这 4 条紧凑证据和 `payloadHash`，不传完整会话、文件内容或凭据。

```ts
function buildReviewInput(
  action: SecurityAction,
  grant: TaskGrant,
): ShellReviewInput {
  const payload = action.payload as { command?: unknown };
  return {
    taskId: grant.taskId,
    sessionId: grant.sessionId,
    actionId: action.id,
    userTask: options.userTaskOf(grant.sessionId).slice(0, 4_000),
    toolName: action.toolName,
    capability: action.capability,
    risk: action.risk,
    command: String(payload.command ?? ''),
    cwd: grant.workspaceRoot,
    workspaceRoot: grant.workspaceRoot,
    targets: action.resources.map((resource) => resource.value),
    recentEvidence: evidenceByTask.get(grant.taskId) ?? [],
    hardDenyPolicyVersion: 'hard-deny-v1',
    payloadHash: action.payloadHash,
    unattended: grant.unattended,
  };
}
```

Router 在执行成功、失败或拒绝后更新 `evidenceByTask`，并对外提供 `clearTask(taskId)`；Task revoke 时同时清理证据、拒绝指纹和拒绝计数。

- [ ] **Step 5: 运行 Router 测试**

Run:

```bash
pnpm exec vitest run apps/desktop/test/shell-grant-store.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/workflow-broker.test.ts apps/desktop/test/ipc.test.ts
```

Expected: PASS；AutoReview allow/ask/deny、Reviewer 失败回退、Ask 本任务授权、外部写人工审批和精确拒绝重放全部覆盖。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/security/shell-grant-store.ts apps/desktop/electron/main/security/runtime-action-router.ts apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts packages/agent-host/src/pi-runtime-transport.ts apps/desktop/test/shell-grant-store.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/workflow-broker.test.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(router): route ask and auto review"
```

---

## Task 6: 接好会话模式、Reviewer worker、Host Shell 和 Task 生命周期

**Files:**
- Create: `apps/desktop/electron/main/security/session-permission-mode.ts`
- Modify: `apps/desktop/electron/main/chat-session-store.ts`
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/settings.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/chat-session-store.test.ts`
- Test: `apps/desktop/test/session-permission-mode.test.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `HostShellAdapter`、Pi Reviewer worker、`ShellGrantStore`、`resolvePermissionMode()`。
- Produces: `ChatSessionRecord.permissionMode`、`getPermissionModeState()`、`setChatPermissionMode()`、Host Shell 执行和统一 Task revoke。

**Rollback:** revert 本 Task；数据库新增列可安全保留并忽略。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/test/session-permission-mode.test.ts
import { describe, expect, it } from 'vitest';
import { resolveSessionPermissionMode } from '../electron/main/security/session-permission-mode.js';

it('uses stored mode and rejects disallowed overrides', () => {
  const policy = {
    defaultPermissionMode: 'ask' as const,
    allowedPermissionModes: ['ask', 'auto_review'] as const,
  };
  expect(resolveSessionPermissionMode('s1', 'general', policy, 'auto_review'))
    .toBe('auto_review');
  expect(() => resolveSessionPermissionMode(
    's1',
    'strict-agent',
    { ...policy, allowedPermissionModes: ['ask'] },
    'auto_review',
  )).toThrow(/not allowed/);
});
```

```ts
// apps/desktop/test/chat-session-store.test.ts
it('persists permission mode with Ask as legacy default', () => {
  const store = new ChatSessionStore(join(mkdtempSync(join(tmpdir(), 'mode-')), 'sessions.db'));
  store.create({
    id: 's1', profileId: 'general', workspaceKind: 'auto',
    workspacePath: 'C:/ws', permissionMode: 'auto_review',
  });
  expect(store.get('s1')?.permissionMode).toBe('auto_review');
  store.update('s1', { permissionMode: 'ask' });
  expect(store.get('s1')?.permissionMode).toBe('ask');
});
```

```ts
// apps/desktop/test/ipc.test.ts
it('reads and writes session permission mode', async () => {
  const state = await handlers.get('sparkii:getPermissionModeState')!(null, 'general', 's1');
  expect(state).toMatchObject({ mode: 'ask', allowedModes: ['ask', 'auto_review'] });
  expect(await handlers.get('sparkii:setChatPermissionMode')!(null, 's1', 'auto_review'))
    .toEqual({ ok: true, mode: 'auto_review' });
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/session-permission-mode.test.ts apps/desktop/test/chat-session-store.test.ts apps/desktop/test/ipc.test.ts
```

Expected: FAIL because session permission mode and IPC do not exist.

- [ ] **Step 3: 持久化模式并接入 Runtime**

`ChatSessionStore` 增加：

```sql
permission_mode TEXT NOT NULL DEFAULT 'ask'
```

如果旧数据库没有该列，使用 `ALTER TABLE` 增加。`create()` 和 `update()` 接受 `permissionMode`。

```ts
// session-permission-mode.ts
export function resolveSessionPermissionMode(
  sessionId: string,
  profileId: string,
  policy: Pick<PlatformProfilePolicy, 'defaultPermissionMode' | 'allowedPermissionModes'>,
  requestedMode?: PlatformPermissionMode,
): PlatformPermissionMode {
  return resolvePermissionMode({
    sessionId,
    profileId,
    requestedMode,
    profileDefaultMode: policy.defaultPermissionMode,
    allowedModes: policy.allowedPermissionModes,
  });
}
```

Runtime 组装：

```ts
// settings.json，未配置时使用当前 provider/default model
permissionModes?: {
  reviewer?: {
    provider?: string;
    modelId?: string;
    timeoutMs?: number;
    policyVersion?: string;
  };
};

const reviewerConfig = {
  provider: settings.permissionModes?.reviewer?.provider
    ?? settings.activeProviderId
    ?? 'deepseek',
  modelId: settings.permissionModes?.reviewer?.modelId
    ?? settings.defaultModel
    ?? 'deepseek-v4-flash',
  timeoutMs: settings.permissionModes?.reviewer?.timeoutMs ?? 15_000,
  policyVersion:
    settings.permissionModes?.reviewer?.policyVersion ?? 'shell-review-v1',
};

const hostShell = createHostShellAdapter({
  bashPath: runtimePaths.bashPath,
  helperPath: join(process.resourcesPath, 'windows-sandbox', 'HostShellRunner.exe'),
});
const hostShellReport = await hostShell.probe();
const shellGrants = new ShellGrantStore();
const reviewer = createPiShellReviewer({
  provider: reviewerConfig.provider,
  modelId: reviewerConfig.modelId,
  timeoutMs: reviewerConfig.timeoutMs,
  keyFor: keyStore.keyFor,
  makeClient: async () => {
    const supervisor = new PiRuntimeSupervisor(() => createUtilityHostHandle(entry, env));
    const client = await supervisor.start();
    return { send: (command) => client.send(command), stop: () => supervisor.stop() };
  },
});
```

`RuntimeSecurity` 新增且仅新增：

```ts
hostShell: HostShellAdapter;
hostShellReport: Awaited<ReturnType<HostShellAdapter['probe']>>;
shellGrants: ShellGrantStore;
reviewer: ReturnType<typeof createPiShellReviewer>;
reviewerModel: string;
reviewerPolicyVersion: string;
```

IPC 的 `reviewShell()` 包装器调用 `reviewer.review()` 后发送一次：

```ts
const reviewed = await reviewer.review(input);
getWindow()?.webContents.send('sparkii:event:permission-event', {
  sessionId: action.sessionId,
  taskId: action.taskId,
  decision: reviewed.decision,
  risk: reviewed.risk,
  reason: reviewed.reason,
});
```

该事件只更新 UI 的“最近一次审查”；完整历史由 `reviewer.decision` 审计提供。

`process.exec` 改为调用 `hostShell.run()`；AppContainer adapter 改为可选 `researchSandbox`。Task 启动使用 `rec.permissionMode`，并注册：

```ts
taskLifecycle.registerCancellation(grant.taskId, 'shell', async () => {
  await hostShell.terminate(grant.taskId);
  await rm(grant.scratchRoot, { recursive: true, force: true });
});
taskLifecycle.registerCancellation(grant.taskId, 'reviewer', () =>
  reviewer.cancel(grant.taskId));
taskLifecycle.registerCancellation(grant.taskId, 'shell-grant', async () => {
  shellGrants.revoke(grant.taskId);
});
```

`platformReadyFor('process.exec')` 只检查 `hostShellReport.status === 'available'`；不再读取 `sandboxReport`，也不在主路径启动 AppContainer。

IPC 增加：

```ts
getPermissionModeState(agentId, sessionId)
setChatPermissionMode(sessionId, mode)
```

`getPermissionModeState()` 返回当前/允许模式、`taskActive`、`hostShellAvailable`、`reviewerAvailable` 和 Host Shell 限制；不返回 Provider Key 或其他凭据。

`setChatPermissionMode()` 先结束旧 Task，再保存新模式并写 `permission-mode.changed` 审计；已执行动作不回滚。

IPC 在 `promptSession()` 开始时把当前用户文本写入 `userTaskBySession`（最多 4000 字），传给 Router 的 `userTaskOf()`；Task 结束时删除该条目。

- [ ] **Step 4: 运行 Runtime 与 IPC 测试**

Run:

```bash
pnpm exec vitest run apps/desktop/test/chat-session-store.test.ts apps/desktop/test/session-permission-mode.test.ts apps/desktop/test/host-shell-adapter.test.ts apps/desktop/test/shell-reviewer.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/ipc.test.ts
```

Expected: PASS；模式持久化、Reviewer worker、Host Shell 和 Task revoke 接线完整。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/security/session-permission-mode.ts apps/desktop/electron/main/chat-session-store.ts apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/settings.ts apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/test/chat-session-store.test.ts apps/desktop/test/session-permission-mode.test.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(runtime): wire permission modes and host shell"
```

---

## Task 7: 添加统一权限条、Host 文案和三选一 Shell 审批

**Files:**
- Create: `apps/desktop/src/trust/PermissionModeBar.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/surface/standard-chat.tsx`
- Modify: `apps/desktop/src/trust/TaskCapabilityStatus.tsx`
- Modify: `apps/desktop/src/trust/ApprovalInbox.tsx`
- Modify: `apps/desktop/src/trust/ApprovalCard.tsx`
- Modify: `apps/desktop/src/trust/InlineApprovalCard.tsx`
- Modify: `apps/desktop/src/trust/ApprovalDrawer.tsx`
- Modify: `apps/desktop/src/trust/HighRiskApprovalDialog.tsx`
- Modify: `apps/desktop/src/types/sparkii-api.ts`
- Modify: `packages/ui/src/patterns/ToolCard.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/test/permission-mode-ui.test.tsx`
- Test: `apps/desktop/test/approval-inbox.test.tsx`
- Test: `apps/desktop/test/task-capability-status.test.tsx`
- Test: `apps/desktop/test/tool-card.test.tsx`

**Interfaces:**
- Consumes: `getPermissionModeState()`、`setChatPermissionMode()`、`permission-event`、`decideApproval(..., scope)`。
- Produces: `PermissionModeProvider`、`usePermissionMode()`、`PermissionModeBar`、Shell `once|task` 交互。

**Rollback:** revert 本 Task；底层模式与 Reviewer 仍工作，仅恢复旧 UI。

- [ ] **Step 1: 写失败 UI 测试**

```tsx
// apps/desktop/test/permission-mode-ui.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PermissionModeProvider, PermissionModeBar } from '../src/trust/PermissionModeBar.js';

it('offers only Ask and Auto review and shows Host semantics', async () => {
  const api = {
    getPermissionModeState: vi.fn(async () => ({
      mode: 'ask',
      allowedModes: ['ask', 'auto_review'],
      taskActive: true,
      hostShellAvailable: true,
      reviewerAvailable: true,
      limitations: ['Host process is not an OS sandbox'],
    })),
    setChatPermissionMode: vi.fn(async () => ({ ok: true, mode: 'auto_review' })),
    on: vi.fn(() => () => {}),
  } as never;

  render(
    <PermissionModeProvider api={api} agentId="general" sessionId="s1">
      <PermissionModeBar />
    </PermissionModeProvider>,
  );
  expect(await screen.findByRole('button', { name: 'Ask' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Auto review' })).toBeTruthy();
  expect(screen.queryByText(/Full access/i)).toBeNull();
  expect(screen.getByText(/Host Git Bash/)).toBeTruthy();
  expect(screen.getByText(/非沙箱/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Auto review' }));
  await waitFor(() => expect((api as any).setChatPermissionMode)
    .toHaveBeenCalledWith('s1', 'auto_review'));
});
```

```tsx
// apps/desktop/test/approval-inbox.test.tsx
it('passes task scope for process.exec only', async () => {
  const decideApproval = vi.fn(async () => ({}));
  const api = makeApi({ decideApproval });
  render(
    <ApprovalInboxProvider api={api as never}>
      <InlineApprovalCard proposal={proposal({
        toolName: 'bash',
        targetSystem: 'platform:process.exec',
      }) as never} />
    </ApprovalInboxProvider>,
  );
  fireEvent.click(await screen.findByText('本任务允许 Shell'));
  await waitFor(() => expect(decideApproval)
    .toHaveBeenCalledWith('p1', true, undefined, 'task'));
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/permission-mode-ui.test.tsx apps/desktop/test/approval-inbox.test.tsx apps/desktop/test/task-capability-status.test.tsx apps/desktop/test/tool-card.test.tsx
```

Expected: FAIL because the shared bar and Shell scope do not exist.

- [ ] **Step 3: 实现一个共享 Provider/Bar 文件**

`PermissionModeBar.tsx` 同时导出 Provider 和 Bar：

```tsx
export interface PermissionModeState {
  mode: 'ask' | 'auto_review';
  allowedModes: Array<'ask' | 'auto_review'>;
  taskActive: boolean;
  hostShellAvailable: boolean;
  reviewerAvailable: boolean;
  limitations: string[];
  lastReview?: {
    decision: 'allow' | 'ask' | 'deny';
    risk: string;
    reason: string;
  };
}

const Context = createContext<{
  state: PermissionModeState;
  setMode(mode: PlatformPermissionMode): Promise<void>;
}>({
  state: {
    mode: 'ask',
    allowedModes: ['ask', 'auto_review'],
    taskActive: false,
    hostShellAvailable: false,
    reviewerAvailable: false,
    limitations: [],
  },
  async setMode() {},
});
```

Provider：

- `getPermissionModeState(agentId, sessionId)` 初始化；
- 订阅 `permission-mode` 和 `permission-event`；
- 当前 Session 切换模式时调用 IPC；
- 草稿只更新本地模式，首轮 `promptSession` 时随 Draft Context 提交；
- 失败时回退 Ask 并显示 limitation。

Bar 只渲染：

```text
[Ask] [Auto review]
Host Git Bash · 宿主执行，非沙箱 · Reviewer 可用
网络由宿主进程决定
最近审查：allow / low / 普通测试命令
```

`auto_review` 不在 `allowedModes` 时禁用按钮，不自动切换。

- [ ] **Step 4: 接入 Agent Frame 和 Shell 审批**

`AgentFrame` 在所有 Surface 外包 Provider，并渲染 Bar。`StandardChatSurface` 从 `usePermissionMode()` 读取草稿模式：

```ts
permissionMode: sessionId ? undefined : permissionModeState.mode
```

`ApprovalCard` 的 `onDecide` 增加第四个参数 `scope?: 'once'|'task'`。只有：

```ts
proposal.targetSystem === 'platform:process.exec'
```

显示“本任务允许 Shell”。普通执行按钮显示“允许一次”。

`TaskCapabilityStatus` 删除“沙箱内命令”和“无网络”：

- `Host Git Bash`；
- `网络由宿主进程决定`；
- `Auto review` 或 `Ask`；
- Reviewer 不可用提示。

`ToolCard` 对 `toolName === 'bash'` 或结果中的 `executionBoundary === 'host'` 显示 `Host` 徽标。

- [ ] **Step 5: 运行 UI 测试**

Run:

```bash
pnpm exec vitest run apps/desktop/test/permission-mode-ui.test.tsx apps/desktop/test/approval-inbox.test.tsx apps/desktop/test/task-capability-status.test.tsx apps/desktop/test/tool-card.test.tsx apps/desktop/test/general-surface.test.tsx apps/desktop/test/contract-surface.test.tsx apps/desktop/test/procurement-surface.test.tsx
```

Expected: PASS；所有 Agent 共用一套模式 UI，没有 Full 模式，Shell 显示 Host 和正确的审批选项。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/trust/PermissionModeBar.tsx apps/desktop/src/App.tsx apps/desktop/src/surface/standard-chat.tsx apps/desktop/src/trust/TaskCapabilityStatus.tsx apps/desktop/src/trust/ApprovalInbox.tsx apps/desktop/src/trust/ApprovalCard.tsx apps/desktop/src/trust/InlineApprovalCard.tsx apps/desktop/src/trust/ApprovalDrawer.tsx apps/desktop/src/trust/HighRiskApprovalDialog.tsx apps/desktop/src/types/sparkii-api.ts packages/ui/src/patterns/ToolCard.tsx apps/desktop/src/styles.css apps/desktop/test/permission-mode-ui.test.tsx apps/desktop/test/approval-inbox.test.tsx apps/desktop/test/task-capability-status.test.tsx apps/desktop/test/tool-card.test.tsx
git commit -m "feat(ui): add shared permission mode UI"
```

---

## Task 8: 跨 Agent 回归、退出旧 Shell 路径并完成全量验证

**Files:**
- Create: `apps/desktop/test/permission-mode-conformance.test.ts`
- Create: `apps/desktop/test/legacy-shell-retirement.test.ts`
- Modify: `apps/desktop/e2e/general.spec.ts`
- Modify: `apps/desktop/e2e/pilot.spec.ts`
- Modify: `apps/desktop/agents/general/agent/prompts/system.md`
- Delete: `apps/desktop/electron/main/general-executor.ts`
- Delete: `apps/desktop/test/general-executor.test.ts`

**Interfaces:**
- Consumes: 前 7 个 Task 的最终实现。
- Produces: 全 Agent 一致性证明；旧前缀分类和 `child.kill()` 直连 Shell 不再存在。

**Rollback:** revert 本 Task 可恢复旧 Shell 文件；新主路径不依赖旧文件。

- [ ] **Step 1: 写失败回归测试**

```ts
// apps/desktop/test/permission-mode-conformance.test.ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfile } from '@sparkii/config';

describe.each([
  'general',
  'contract-review',
  'procurement-review',
  'knowledge-qa',
])('%s permission mode', (agentId) => {
  it('declares Ask as default and both platform modes', async () => {
    const profile = await loadProfile(
      join(process.cwd(), 'apps', 'desktop', 'agents', agentId),
      { allowUnsigned: true },
    );
    expect(profile.security.approval).toMatchObject({
      defaultPermissionMode: 'ask',
      allowedPermissionModes: ['ask', 'auto_review'],
    });
  });
});
```

```ts
// apps/desktop/test/legacy-shell-retirement.test.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('removes the direct spawn/bash-prefix executor', () => {
  expect(existsSync(join(
    process.cwd(),
    'apps',
    'desktop',
    'electron',
    'main',
    'general-executor.ts',
  ))).toBe(false);
});
```

- [ ] **Step 2: 确认失败**

Run:

```bash
pnpm exec vitest run apps/desktop/test/permission-mode-conformance.test.ts apps/desktop/test/legacy-shell-retirement.test.ts
```

Expected: FAIL until all profiles and retirement are complete.

- [ ] **Step 3: 完成迁移和 smoke E2E**

General system prompt 改为：

```text
Workspace 内普通文件操作直接执行。
Ask：宿主 Shell 首次由用户确认，可允许一次或当前任务。
Auto review：宿主 Shell 由独立 Reviewer 判断。
Shell 不是沙箱，网络能力由宿主进程决定。
类型化外部写始终人工审批。
```

确认旧 executor 没有生产引用后删除：

```bash
rg -n "registerGeneralExecutor|general-executor" apps/desktop/electron apps/desktop/src packages
```

`general.spec.ts` 和 `pilot.spec.ts` 增加：

```ts
await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Auto review' })).toBeVisible();
await expect(page.getByText(/Host Git Bash/)).toBeVisible();
await expect(page.getByText(/Full access/i)).toHaveCount(0);
```

- [ ] **Step 4: 全量验证**

Run:

```bash
pnpm exec vitest run apps/desktop/test/permission-mode-conformance.test.ts apps/desktop/test/legacy-shell-retirement.test.ts packages/approval/test/security-policy.test.ts apps/desktop/test/runtime-action-router.test.ts apps/desktop/test/ipc.test.ts
pnpm --dir apps/desktop build:native-sandbox
pnpm test
pnpm typecheck
pnpm lint
```

Expected: 所有测试、类型检查和 lint 通过；若存在基线无关错误，需在最终报告逐项列出。

- [ ] **Step 5: 检查文档和旧语义**

Run:

```bash
git diff --check
rg -n "T[O]DO|T[B]D|F[I]XME|待[定]|待[补]充|类[似] Task" docs/superpowers/plans/2026-10-21-platform-permission-modes-auto-review-implementation.md
rg -n "Full access|yolo|沙箱内命令|无网络" apps/desktop/src apps/desktop/electron apps/desktop/agents -g '*.ts' -g '*.tsx' -g '*.yaml' -g '*.md'
```

Expected: 无占位词；产品路径无 Full 模式或误导性沙箱文案。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/test/permission-mode-conformance.test.ts apps/desktop/test/legacy-shell-retirement.test.ts apps/desktop/e2e/general.spec.ts apps/desktop/e2e/pilot.spec.ts apps/desktop/agents/general/agent/prompts/system.md apps/desktop/electron/main/general-executor.ts apps/desktop/test/general-executor.test.ts
git commit -m "test: verify permission modes across agents"
```

---

## 验收映射

| 验收点 | Task |
| --- | --- |
| 只有 Ask/AutoReview，没有 Full | 1、2、7、8 |
| Workspace CRUD 两模式直通 | 2、5 |
| Shell 基础 ASK | 2、5 |
| Ask 允许一次/本任务 | 5、7 |
| AutoReview 独立模型判断 | 4、5 |
| Reviewer 固定 JSON、无工具、不可用时失败关闭 | 1、4、5 |
| 外部写始终人工审批 | 2、5 |
| Host Git Bash + Job Object | 3、6 |
| Task/Workspace/模式改变终止 Shell | 5、6 |
| 会话模式 IPC 与 UI | 6、7 |
| 全 Agent 一致性 | 8 |
| AppContainer 退出主路径 | 6、8 |

---

## 自审

### Spec Coverage

- §2–§4 模式与边界：Task 1、2、7。
- §6 决策顺序：Task 2、5。
- §7 Ask 和 Task Shell Grant：Task 5、7。
- §8 AutoReview：Task 1、4、5。
- §9 Host Shell：Task 3、6。
- §10–§12 API、UI、审计：Task 5、6、7。
- §13–§14 配置、失败与撤销：Task 1、5、6。
- §15–§16 测试与验收：Task 8。

### Type Consistency

全计划使用：

```ts
PlatformPermissionMode
ReviewerDecision
ShellReviewInput
ShellGrantStore
HostShellAdapter
PermissionModeProvider
usePermissionMode
TaskGrant.permissionMode
TaskGrant.planMode
TaskGrant.actorId
TaskGrant.unattended
```

Reviewer 的职责始终是返回 decision/risk/reason；Main 始终负责审计、circuit breaker、失败回退和最终执行。

### Placeholder Scan

每个 Task 都有精确文件、测试、失败命令、最小实现、通过命令和唯一 commit。没有留下一段需要执行者自行补完的安全逻辑。

## 最终完成定义

1. Workspace 普通 CRUD 在 Ask/AutoReview 下零 Proposal。
2. Shell 在 Ask 下可人工允许一次或当前任务。
3. Shell 在 AutoReview 下由独立无工具 Pi worker 审查。
4. Reviewer 失败、非法 JSON 或超时时不会自动放行。
5. 外部写和灾难目标不能由 Reviewer 覆盖。
6. Host Git Bash 超时或 Task revoke 会终止完整进程树。
7. 所有 Agent 用同一权限条，不出现 Full 模式。
8. 审计足以追溯 Task、Action、模式、Reviewer 结果和 `payloadHash`。
