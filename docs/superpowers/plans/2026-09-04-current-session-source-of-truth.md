# Current Session Source of Truth Implementation Plan

> **For agentic workers:** 本 plan 在 spec 经人工审核通过前 **不得执行**。审核通过后，用 superpowers:executing-plans 按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 全应用只留一份 `current`（会话或壳页面）；左边高亮和右边显示都从它派生；删掉按 Agent 分叉的三份当前状态和平行的 `screen`。

**Architecture:** `current` 是可判别联合：`{ type: 'page', page }` 或 `{ type: 'session', agentId, sessionId, mode }`。`sessions` 只做已落盘目录，不存 `active`。渲染前 `active ⇔ current.type === 'session' && current.sessionId === row.id`。点历史、点智能体、打开首页 / 设置、绑定 id、公布标题、删除，都只改 `current` 或目录本身。

**Tech Stack:** React 壳（`App.tsx`）、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-04-current-session-source-of-truth-design.md`

## Global Constraints

- **先审后改。** 未批准前不改 `App.tsx` 或测试。
- 只动平台壳。不改 `SessionList` 交互、Agent 起名、合同业务、运行池、审批、置顶 / 归档 / 拖拽。
- 平台生产代码不按 `'general'` / `'contract-review'` 做打开或高亮分支。`mode` 只看 `surfaceType === 'workflow'`。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- 能用纯函数表达的规则（高亮、打开历史 / 新会话 / 绑定 id）放进 `current-work.ts`，不要散落在 JSX 里再写一份。
- 废代码是删除，不是改名留着。
- 测试：Vitest。相关用例按新语义改，不放宽。现有标题 upsert / 新会话不插行 / 合同可合并必须保持。

---

## Ownership (do not blur)

### 平台必须改

| 改动 | 为什么是平台 | 不改什么 |
| --- | --- | --- |
| 一份 `current` 替换三份 map 和平行的 `screen` | 壳才知道右边是会话还是首页 / 设置 | Agent 业务 |
| 渲染前派生 `active` | 高亮是壳的显示规则 | `SessionList` 仍吃 `s.active` |
| 打开 / 新建 / 导航 / 删除 / 绑定 id | 用户动作发生在壳 | Surface 内部仍调 `actions.openSession` / `startWorkflow` |
| `session_title` 插入不再写 `active: true` | 避免第二份高亮 | upsert 归属和插行位置保持标题 spec |
| `ApprovalPanel.currentSessionId` | 审批要挂真正的当前会话 | 不改审批 UI |

### Agent 不改

- 合同 Surface、通用起名、`setChatTitle`、`standard-chat` 发送。
- `useAgentSession` 仍吃 `(agentId, sessionId, mode)`。

### 明确删除（生产代码）

`App.tsx` 落地后必须为 0 引用：

```text
workflowByAgent
setWorkflowByAgent
workflowByAgentRef
workflowFor
activeSessionByAgent
setActiveSessionByAgent
activeSessionByAgentRef
activeSessionFor
setActiveSessionFor
titleByAgent
titleFor
setTitleFor
bindChatSession
useState<ScreenId>('home')   // 不再与 current 并行
```

以及这些逻辑，不得换种写法留下：

- `onNewSession` / `onOpenSession` 的 `isChatAgent` 分叉
- `refreshSessions` 里 `currentActive = activeSessionByAgentRef.current[profileId]`
- `refreshSessions` 结束时按 `liveActive` 写标题
- `session_title` 对两份 map 循环 `setTitleFor`
- `session_title` 插入 `{ active: true }`
- `onNewSession` 里 `list.map(s => active: false)`
- `AgentFrame` 上 `surfaceType === 'chat' ? activeSessionFor : workflowFor`
- 「每个 Agent 保留自己的 live/history session」这类注释

---

## File Structure

```text
apps/desktop/src/platform/current-work.ts          # 新建：CurrentWork + 派生
apps/desktop/test/current-work.test.ts             # 新建
apps/desktop/src/App.tsx                           # 替换三份 map，派生高亮
apps/desktop/test/app-general.test.tsx             # 补高亮 / 新会话无高亮
apps/desktop/test/app-workflow.test.tsx            # 补合同历史高亮、点通用后灭高亮
```

不改：

```text
packages/ui/src/patterns/SessionList.tsx
apps/desktop/src/surface/**
apps/desktop/agents/**
apps/desktop/electron/**
```

---

### Task 1: 纯函数 — `CurrentWork` 与派生高亮

**Files:**
- Create: `apps/desktop/src/platform/current-work.ts`
- Test: `apps/desktop/test/current-work.test.ts`

**Interfaces:**

```ts
export type SessionMode = 'live' | 'history';

export type CurrentWork =
  | { type: 'page'; page: string }
  | { type: 'session'; agentId: string; sessionId: string | null; mode: SessionMode };

export function openPage(page: string): CurrentWork
// { type: 'page', page }。page 是 'home' 这种短名，不是 UUID，也不枚举今天有哪几页。

export function openHistory(agentId: string, sessionId: string, surfaceType?: string): CurrentWork
// { type: 'session', ..., mode: surfaceType === 'workflow' ? 'history' : 'live' }

export function openNew(agentId: string): CurrentWork
// { type: 'session', agentId, sessionId: null, mode: 'live' }

export function bindSession(current: CurrentWork, sessionId: string): CurrentWork
// 仅 type==='session' 时改 sessionId + mode:'live'；page 原样返回

export function clearCurrentSession(current: CurrentWork): CurrentWork
// session → sessionId: null, mode: 'live'；page 原样返回

export function highlightedSessionId(current: CurrentWork): string | null
// 仅 type==='session' 且 sessionId 有值时返回该 id

export function shellActive(current: CurrentWork): string
// page 或 agentId，给 Shell 的 active

export function rowIsActive(highlightedId: string | null, sessionId: string): boolean

export function isSession(current: CurrentWork): current is Extract<CurrentWork, { type: 'session' }>
```

- [ ] **Step 1: Write the failing tests**

```ts
import {
  openPage, openHistory, openNew, bindSession, clearCurrentSession,
  highlightedSessionId, shellActive, rowIsActive,
} from '../src/platform/current-work.js';

it('opens workflow history as history mode and chat as live', () => {
  expect(openHistory('contract-review', 'c1', 'workflow')).toEqual({
    type: 'session', agentId: 'contract-review', sessionId: 'c1', mode: 'history',
  });
  expect(openHistory('general', 'g1', 'chat')).toEqual({
    type: 'session', agentId: 'general', sessionId: 'g1', mode: 'live',
  });
});

it('new work has no session id', () => {
  expect(openNew('general')).toEqual({
    type: 'session', agentId: 'general', sessionId: null, mode: 'live',
  });
});

it('highlights only a persisted session view, never a shell page', () => {
  const cur = openHistory('contract-review', 'c1', 'workflow');
  expect(highlightedSessionId(cur)).toBe('c1');
  expect(shellActive(cur)).toBe('contract-review');
  expect(highlightedSessionId(openNew('contract-review'))).toBeNull();
  expect(highlightedSessionId(openPage('home'))).toBeNull();
  expect(highlightedSessionId(openPage('settings'))).toBeNull();
  expect(highlightedSessionId(openPage('knowledge'))).toBeNull();
  expect(shellActive(openPage('knowledge'))).toBe('knowledge');
  expect(rowIsActive('c1', 'c1')).toBe(true);
  expect(rowIsActive('c1', 'g1')).toBe(false);
  expect(rowIsActive(null, 'c1')).toBe(false);
});

it('bindSession then clearCurrentSession', () => {
  const draft = openNew('general');
  const bound = bindSession(draft, 'g1');
  expect(bound).toEqual({ type: 'session', agentId: 'general', sessionId: 'g1', mode: 'live' });
  expect(clearCurrentSession(bound)).toEqual(openNew('general'));
  expect(bindSession(openPage('home'), 'g1')).toEqual(openPage('home'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: Minimal implementation**

只放纯函数，不碰 React。`openHistory` 用 `surfaceType === 'workflow'`，不要写 agent id。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/platform/current-work.ts apps/desktop/test/current-work.test.ts
git commit -m "feat(desktop): add CurrentWork helpers for a single current session"
```

---

### Task 2: 壳 — 一份 current 替换三份 map

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`
- Test: `apps/desktop/test/app-workflow.test.tsx`

**Interfaces（AppShell 内）：**

```ts
const [current, setCurrent] = useState<CurrentWork>(() => openPage('home'));
const currentRef = useRef<CurrentWork>(current);
function commitCurrent(next: CurrentWork) {
  currentRef.current = next;
  setCurrent(next);
}
```

动作对照：

| 动作 | 实现 |
| --- | --- |
| `onOpenSession(agentId, sessionId)` | `commitCurrent(openHistory(agentId, sessionId, surfaceType))` |
| `onNewSession(agentId)` | `commitCurrent(openNew(agentId))`；不要改 `sessions[].active` |
| `onNavigate(agentId)` | `commitCurrent(openNew(agentId))` |
| `onNavigate(非 Agent 的短名，如 home)` | `commitCurrent(openPage(page))` |
| 聊天 `actions.openSession(id)` | `commitCurrent(bindSession(currentRef.current, id))` |
| `startWorkflow` 回写 `res.sessionId` | 同上 `bindSession` |
| `review` / `requestExport` / `readDocumentBytes` | 仅 `isSession(current) && current.agentId === agentId` 时用 `current.sessionId` |
| 删除 / 释放当前 id | `commitCurrent(clearCurrentSession(current))` |
| `ApprovalPanel.currentSessionId` | `isSession(current) ? current.sessionId ?? '' : ''` |
| `Shell active` | `shellActive(current)` |

`AgentFrame`：

```ts
const mine = isSession(current) && current.agentId === a.id ? current : null;
sessionId={mine?.sessionId ?? null}
mode={mine?.mode ?? 'live'}
draft={a.surfaceType === 'chat' && Boolean(mine) && mine.sessionId == null}
title={mine?.sessionId ? (sessions[a.id] ?? []).find(s => s.id === mine.sessionId)?.name : undefined}
active={Boolean(mine)}
```

`session_title` upsert 归属：覆盖 / 已有分组 / `list` 的 `profileId`；再否则 `isSession(currentRef.current) && currentRef.current.sessionId === p.sessionId ? currentRef.current.agentId : undefined`。插入行不要带 `active: true`。不要 `setTitleFor`。

`refreshSessions`：不要算 `currentActive`，不要写 `item.active`。不要结束时写标题 state。无 `profileId` 时不要再用 `workflowByAgent` 猜主人；只在 current 是 session 且 id 对得上时用 `current.agentId`。

传给 `Shell`：

```ts
const highlightedId = highlightedSessionId(current);
const sessionsView = /* 各行 active: rowIsActive(highlightedId, s.id) */;
<Shell active={shellActive(current)} sessions={sessionsView} ...>
```

- [ ] **Step 1: Write / update the failing tests first**

`app-workflow.test.tsx` 增加（`listChatSessions` 同时返回一条合同历史和一条通用历史）：

```ts
it('highlights only the opened contract history row', async () => {
  api.listChatSessions.mockResolvedValue([
    { id: 'c1', profileId: 'contract-review', title: '合同 A', updatedAt: 2 },
    { id: 'g1', profileId: 'general', title: '通用旧会话', updatedAt: 1 },
  ]);
  render(<App />);
  await screen.findByText(/工作台 · 上午好/);
  fireEvent.click(await screen.findByText('合同 A'));
  await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('c1'));
  expect(screen.getByTestId('session-c1').className).toMatch(/current/);
  expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
});

it('clears the only highlight when opening a new general session', async () => {
  // 先点合同 A 使其高亮，再点 agent-nav-general
  fireEvent.click(screen.getByTestId('agent-nav-general'));
  await screen.findByTestId('composer-input');
  expect(screen.getByTestId('session-c1').className).not.toMatch(/current/);
  expect(screen.getByTestId('session-g1').className).not.toMatch(/current/);
});
```

`app-general.test.tsx`：

- 「打开历史」：点「旧会话」后 `session-g1` 有 `current`，`session-g2` 没有。
- 「打开历史再点 agent-nav-general」：已有「标题回到新对话」；补上 `session-g1` 没有 `current`。
- 「session_title 插入」：插入后该行有 `current`，且只有这一行。
- 「仅绑定 id、无 session_title」：没有对应 testid，也就没有高亮。
- 「点 Sparkii 回首页」：历史行若还在，都没有 `current`；右边是首页问候，不是会话。
- 再点首页 Agent 卡片：新会话，无高亮（不再恢复刚才那条）。
- 打开设置：同样无高亮；目录行仍在。

现有用例（发送、删会话、标题 upsert、合同开始审核、合并导出）保持原断言。

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sparkii/desktop test test/app-general.test.tsx test/app-workflow.test.tsx`  
Expected: 新高亮用例 FAIL（合同行没有 `current`；点通用后若合同已亮也不会灭）。

- [ ] **Step 3: Implement App.tsx only on the current / highlight path**

按上面的对照表改。不要重排置顶 / 拖拽 / 运行池。改完后：

```bash
rg -n "activeSessionByAgent|workflowByAgent|titleByAgent|setActiveSessionFor|workflowFor|bindChatSession|titleFor|useState<ScreenId>" apps/desktop/src/App.tsx
```

必须无匹配。

- [ ] **Step 4: Tests pass**

Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts test/app-general.test.tsx test/app-workflow.test.tsx test/contract-surface.test.tsx`

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(desktop): drive sidebar highlight and workbench from one current session"
```

---

### Task 3: 回归与自检

- [ ] Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts test/app-general.test.tsx test/app-workflow.test.tsx test/contract-surface.test.tsx test/general-surface.test.tsx test/general-title.test.ts`
- [ ] `rg -n "activeSessionByAgent|workflowByAgent|titleByAgent|setActiveSessionFor|workflowFor|bindChatSession" apps/desktop/src apps/desktop/test` → 仅允许出现在旧文档，或本 plan / spec 的删除清单；**生产与测试代码为 0**
- [ ] `rg -n "agentId === 'contract-review'|agentId === 'general'" apps/desktop/src/App.tsx` → 无匹配
- [ ] `pnpm --filter @sparkii/desktop exec tsc --noEmit`
- [ ] 若还有测试修复，单独 commit

---

## Spec coverage (self-review)

| Spec | Task |
| --- | --- |
| 一份 `current` | 1, 2 |
| 高亮派生、目录不存 active | 1, 2 |
| 点历史只亮一行 | 2 |
| 点智能体新会话、无 id、无高亮 | 1, 2 |
| 绑定 id 不插行 | 2（已有用例 + 无高亮） |
| `session_title` 后只亮新行 | 2 |
| 壳页面写进 current、灭高亮 | 1 `openPage` + 2 导航 |
| 删除当前 → 新会话 | 2 |
| 删掉三份 map、`screen`、分叉 | 2, 3 |
| 不按 agent id 分支 | 1, 3 |
| 不改 SessionList / Agent 起名 / 合同业务 | 全程 |

无 TBD。类型名：`CurrentWork` / `openPage` / `openHistory` / `openNew` / `bindSession` / `highlightedSessionId` / `shellActive` 前后任务一致。
