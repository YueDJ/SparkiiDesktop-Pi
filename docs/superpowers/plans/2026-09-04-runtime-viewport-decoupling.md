# Runtime ⊥ Viewport Implementation Plan

> **For agentic workers:** 本 plan 在 spec 经人工审核通过前 **不得执行**。审核通过后，用 superpowers:executing-plans 按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 运行时和视口垂直。点火是对 runtime 的命令；`current` 只在仍是该 Agent 草稿时跟随；离开不停止运行；回来读 JSONL；标题和侧栏不依赖 Surface 仍挂着这条会话；失败对用户可见。

**Architecture:** `sessionId` 出生在 `runWorkflow` / `promptSession`。`bindCurrentSession` 永远 stamp owner，仅草稿才改 `current`。workflow 用 `mode` 区分「草稿跟随（live）」和「从草稿打开历史（history）」——不要用裸的 `null→id` 当 bind。标题在点火回调闭包里直接 `setChatTitle`（合同 `onClick`；通用占位走 `onSessionCreated`），不依赖 Surface 还挂着。`openChatSession` ENOENT 仍带会话记录里的 inputs。不恢复 per-agent map，不让 loop 等视口，不用 `setBusy` 当在跑。

**Tech Stack:** React 壳、Electron IPC、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-04-runtime-viewport-decoupling-design.md`

## Global Constraints

- spec / plan 已经架构师 Approve with nits，可以改产品代码。
- 不恢复 `workflowByAgent` / `activeSessionByAgent` / `titleByAgent`，不新开第三份 current。
- 不改 `runWorkflow` 的点火顺序：返回 id 时 loop 可以已经在跑。不把 loop 推迟到 `openChatSession` 之后。
- 平台生产代码不按 `'general'` / `'contract-review'` 写 bind / 标题 / 高亮 / 报错。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- 起名字符串规则、用户锁、截断不改。平台不起名。
- 不改合同审核步骤、合并、导出、运行池、审批、`SessionList` 交互。
- 测试：Vitest。相关用例按新语义改，不放宽。发送 / 标题 upsert / 高亮 / 合同合并与导出断言必须保持。

---

## Ownership (do not blur)

### 平台必须改

| 改动 | 为什么是平台 | 不改什么 |
| --- | --- | --- |
| `bindSession` / `bindCurrentSession` 只跟草稿 | 视口跟随是壳的规则 | 不按 agent id 特判 |
| `startWorkflow` 把 `runWorkflow` Promise 交还 | 和 `promptSession` 一样，命令返回 id | 不起名 |
| `startWorkflow` 失败走现有 `useErrors().reportError` | 和聊天同一条错误中心 | 不新开 toast / 不直接 `appendError` |
| `openChatSession` ENOENT 带 `inputs` | 回来读会话记录是平台 IPC | 不编时间线 |
| `sessionIdChange` 纯函数 | leave / switch / stay / assign | **不**把裸 `null→id` 叫 bind；workflow 用 `mode` 拆 bind vs open |

### Agent 必须改（只有合同用得到的本地态）

| 改动 | 包 | 不放平台的原因 |
| --- | --- | --- |
| `null→id` + live 保留已选文件；`null→id` + history / leave / switch 重置 | `agents/contract-review` | 只有合同有本地 `documents` / `localFileName` |
| 「开始审核」`onClick` 里用返回 id 立刻 `setChatTitle` | `agents/contract-review` | 文件名策略在 Agent；必须能在卸挂后仍公布 |
| `onSessionCreated` 上公布占位名 | `agents/general` | 占位 / 短名字符串规则仍在 general；本轮短名仍只在挂着时升级 |

### 本轮要删掉的代码（用不上就清，不要改名留着）

上一轮已经清掉的 per-agent map（`workflowByAgent` 等）现在仓库里没有，不必再删一遍，也不要写回来。本轮清的是**今天还在、改完就没用的路径**：删掉，不要注释掉，不要留一条废分支。

| 现在还在 | 为什么废 | 怎么清 |
| --- | --- | --- |
| `App.startWorkflow` 的 `.catch(() => {})` | 吞掉点火失败 | 整段空 catch 删掉，换成现有 `useErrors().reportError` |
| `App.startWorkflow` 里 `mode !== 'live'` 就 `commitCurrent({ ...work, mode: 'live' })` | 点火去改别人的历史视口 | 整个 `if` 删掉；`live` 只由草稿 `bindSession` 带上 |
| `bindSession` 覆盖已有 `sessionId` | 抢焦点 | 已有 id 的 session 原样返回；不要留「先覆盖再判断」 |
| 合同 `[sessionId]` 里「id 变了就清本地文件 / `leftSession` 一把梭」 | bind 会清掉已选文件 | 换成 `sessionIdChange` + `mode`；旧的一律重置不要和新政并列留着 |
| 合同标题只靠 `useEffect([sessionId, selectedName])` 当**唯一**公布口 | Surface 卸挂就不公布 | 主路径改到「开始审核」`onClick` 闭包；effect 只留同一挂载周期补发，不要两套都当主路径 |

改完后扫一眼改过的文件：没有引用的 import、变量、`leftSession` / 旧注释，一并删掉。别的空 catch（`requestExport`、`getRuntimePool`、`workflow.ts` loop）本轮不动。

---

## File Structure

```text
apps/desktop/src/platform/current-work.ts          # bindSession 只绑草稿
apps/desktop/test/current-work.test.ts             # 补：历史 / page / 已有 id 不跟
apps/desktop/src/surface/session-id.ts             # sessionIdChange（leave/switch/stay/assign）
apps/desktop/src/surface/contract.ts               # startWorkflow: void | Promise<{ sessionId?: string }>
apps/desktop/src/surface/standard-chat.tsx         # 可选 onSessionCreated
apps/desktop/src/App.tsx                           # 草稿才 bind；失败 reportError；交还 Promise；点火不改历史 mode
apps/desktop/electron/main/ipc.ts                  # ENOENT 仍带 inputs
apps/desktop/agents/contract-review/surface/index.tsx
apps/desktop/agents/general/surface/index.tsx      # 占位名跟 onSessionCreated
apps/desktop/test/app-workflow.test.tsx
apps/desktop/test/app-general.test.tsx
apps/desktop/test/contract-surface.test.tsx
apps/desktop/test/general-surface.test.tsx
apps/desktop/test/ipc.test.ts
apps/desktop/test/session-id.test.ts              # 若 sessionIdChange 不并进 current-work.test
```

不改：

```text
packages/agent-host/**
apps/desktop/electron/main/workflow.ts             # 点火顺序保持
packages/ui/src/patterns/SessionList.tsx
合同审核步骤 / 合并 / 导出实现
通用两步起名字符串规则
```

---

### Task 1: 纯函数 — 草稿才 bind、三种 id 变化

**Files:**
- Modify: `apps/desktop/src/platform/current-work.ts`
- Test: `apps/desktop/test/current-work.test.ts`
- Create: `apps/desktop/src/surface/session-id.ts`
- Test: 可并进 `current-work.test.ts`，或 `apps/desktop/test/session-id.test.ts`

**Interfaces:**

```ts
// bindSession：仅当前是 session 且 sessionId == null 时写入新 id、mode:'live'
// 已有 id 的 session、page → 原样返回。不要把 agentId 判断塞进这个函数。
export function bindSession(current: CurrentWork, sessionId: string): CurrentWork

export type SessionIdChange = 'assign' | 'leave' | 'switch' | 'stay';
export function sessionIdChange(prev: string | null, next: string | null): SessionIdChange
// null→id = assign（调用方再用 mode 拆 bind vs open，不要在这里叫 bind）
// id→null = leave；idA→idB = switch；相同 = stay

export function isWorkflowDraftBind(change: SessionIdChange, mode: 'live' | 'history'): boolean
// change==='assign' && mode==='live'

export function isWorkflowOpenFromDraft(change: SessionIdChange, mode: 'live' | 'history'): boolean
// change==='assign' && mode==='history'
```

- [ ] **Step 1: Write the failing tests**

现有 `bindSession then clearCurrentSession` 里「草稿 → 绑定」保持。追加：

```ts
it('bindSession follows a draft only', () => {
  const history = openHistory('contract-review', 'old', 'workflow');
  expect(bindSession(history, 'new')).toEqual(history);
  expect(bindSession(openPage('home'), 'new')).toEqual(openPage('home'));
  expect(bindSession(openNew('contract-review'), 'new')).toEqual({
    type: 'session', agentId: 'contract-review', sessionId: 'new', mode: 'live',
  });
});

it('classifies session id changes without calling null→id bind', () => {
  expect(sessionIdChange(null, 'a')).toBe('assign');
  expect(isWorkflowDraftBind('assign', 'live')).toBe(true);
  expect(isWorkflowOpenFromDraft('assign', 'history')).toBe(true);
  expect(isWorkflowDraftBind('assign', 'history')).toBe(false);
  expect(sessionIdChange('a', null)).toBe('leave');
  expect(sessionIdChange('a', 'b')).toBe('switch');
  expect(sessionIdChange('a', 'a')).toBe('stay');
  expect(sessionIdChange(null, null)).toBe('stay');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts`  
Expected: FAIL（历史也会被 bindSession 改掉）

- [ ] **Step 3: Minimal implementation**

收窄 `bindSession`。`sessionIdChange` 是纯函数，不要放进 JSX。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop test test/current-work.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```text
narrow bindSession to drafts; add sessionIdChange
```

---

### Task 2: 壳 — 跟随草稿、失败可见、命令把 id 交还

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/surface/contract.ts`（`startWorkflow` 返回类型）
- Test: `apps/desktop/test/app-workflow.test.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`（确认通用发送 / 标题 upsert / 高亮不放宽）

**Behavior:**

```ts
// bindCurrentSession 保持：先 stamp，再
if (isSession(work) && work.agentId === agentId)
  commitCurrent(bindSession(work, sessionId));
// bindSession 收窄后，历史 / 已有 id 自然不跟

startWorkflow: (payload) => {
  const p = api.runWorkflow(agentId, payload).then((res) => {
    if (res?.sessionId) bindCurrentSession(agentId, res.sessionId);
    return res;
  }).catch((e) => {
    reportError(String(e?.message ?? e), { source: agents.find((a) => a.id === agentId)?.name ?? agentId });
    // 不再 throw：合同 onClick 的 .then(setChatTitle) 没有 catch，reject 会变成未处理拒绝；失败本来也不该公布标题
  });
  return p;
}
```

报错必须接**现有**错误中心，不要另开一条：

```text
AppShell 已有 const { reportError } = useErrors();
ErrorProvider（App 外层）→ toast（ErrorToaster，右上 5s）+ 报错中心抽屉 + store.append
store.append = api.appendError → 主进程 errors.db
```

对照：`docs/superpowers/specs/2026-08-30-error-toast-center-persistence.md`；聊天 `standard-chat.tsx` 的 `promptSession` catch 已经是 `reportError(..., { source: agent.name })`。`review` 已走 `reportError`。

| 做 | 不做 |
| --- | --- |
| `useErrors().reportError(message, { source })` | `window.alert` / 新 toast 组件 / 合同页内联「启动失败」当唯一出口 |
| `source` = 该 Agent 的 `name`（已有 `agents` 列表），和聊天一致 | 写死 `'contract-review'` / `'合同审核'`；按 agent id 分叉 |
| 让 ErrorProvider 去 `appendError`（测试里会看到 mock 被调） | App 里直接 `api.appendError(...)`（合同导出今天这样写，**跳过 toast**，点火不要学） |
| 沿用现有 `ErrorProvider` / `errors.db` / IPC | 新开 Provider、新 IPC、改 schema |

`AgentSurfaceActions.startWorkflow` 定为 `void | Promise<{ sessionId?: string }>`。不要 `Promise<unknown>`。聊天那条空实现继续 `() => {}`。

**删掉**今日点火时的 `if (mode !== 'live') commitCurrent({ ...work, mode: 'live' })`。`mode: 'live'` 只由草稿 `bindSession` 带上。留下会在历史页误点开始时把别人的 history 改成 live。

不要：在 `App.tsx` 里读文件名、调 `setChatTitle`、写 `if (agentId === 'contract-review')`。
`requestExport` 的 `.catch(() => {})` 本轮不动。

- [ ] **Step 1: Write the failing tests**

`app-workflow.test.tsx` 追加（先写断言，再改壳）：

1. **不抢焦点。** 打开合同 → 选文件 → 开始审核 → 在 `runWorkflow` resolve 之前点一条已有合同历史（先 `listChatSessions` 放好一行）→ resolve 之后右边仍是那条历史（`openChatSession` 叫的是历史 id），新 `ws1` 在 `session_title` 后出现在目录但**没有** `current` class。
2. **卸挂仍公布。** 点开始 → 立刻首页或另一个 Agent（合同 Surface 已卸）→ `setChatTitle` 仍带着新 id 被调用，随后 `session_title` upsert 进合同组且不亮。不要只在仍挂着的 Surface 单测里证明「离开后还能起名」。
3. **二次开始不覆盖。** 草稿上开始并 bind 之后，再点一次开始（若 UI 还允许）：第二个 id stamp 但不改 `current.sessionId`。
4. **开始失败进错误中心。** `runWorkflow` reject → 现有 `ErrorProvider` 路径被走通：`api.appendError` 被调用（`makeErrorStore.append`），`source` 是合同 Agent 的 **name**（`合同审核智能体`），`message` 含 reject 文本。不要断言一个新的内联横幅。生产代码不得再出现 **`startWorkflow` 的** `.catch(() => {})`（不要误扫 `requestExport`）。
5. 现有「开始后 `session_title` 插入且高亮」保持：用户仍停在草稿时，这一行仍是唯一 `current`。
6. bind 后 JSONL 未到：允许短暂 idle；**不要**为了按钮状态加视口 `setBusy` 当运行真相。运行池用例已有则保持。

`app-general.test.tsx`：现有发送 / `openSession` 不插行 / `session_title` 才插且高亮不放宽。**必须补**「发出后立刻点历史或回家」：current 不抢；占位名仍经 `setChatTitle` 公布（见 Task 3b）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop test test/app-workflow.test.tsx test/app-general.test.tsx`  
Expected: 新用例 FAIL；旧用例仍应尽量绿（本步还没改 Surface）

- [ ] **Step 3: Minimal implementation**

按上面改 `App.tsx` + `contract.ts`。空 catch 和 `mode !== 'live'` 那刀是删除，不是再包一层。`review` / `requestExport` 保持。

- [ ] **Step 4: Run tests**

Run: 同上  
Expected: 壳侧「不抢焦点 / 二次开始 / 失败进错误中心」PASS。  
「卸挂仍公布标题」「通用发出后立刻离开仍占位」这两条本步可以仍红——分别等 Task 3 / 3b，**不要**为了先绿把 `setChatTitle` 塞进 `App.tsx`。通用旧用例 PASS。

- [ ] **Step 5: Commit**

```text
follow draft only; surface startWorkflow errors
```

---

### Task 3: 合同 Surface — bind 不清草稿；标题跟命令 id

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Test: `apps/desktop/test/contract-surface.test.tsx`

**Behavior:**

`[sessionId]` effect 用 `sessionIdChange` + `mode`：

| 变化 | 本地态 |
| --- | --- |
| assign + `mode==='live'`（bind） | 保留 `documents` / `localFileName`；不要用当时可能仍空的 `inputs` 盖掉已选文件 |
| assign + `mode==='history'`（从草稿打开历史） | **重置**，按 B 的 inputs 装，不得留草稿文件 |
| `leave` / `switch` | 与今天一样：清筛选、选择、笔记、本地文件名；`leave` 清 documents，并继续用 `discardSession` 丢掉上一会话 timeline（`useAgentSession` 第一帧还会吐旧条目） |
| `stay` | 不把这次当导航 |

`inputsKey` merge effect（约 301–312 行）在 assign+live 时**不要**用当时可能为空的 `inputs` 盖本地 `documents`。bind 当帧 `inputsKey` 仍为空则只更新 ref，不要 `setDocuments(inputs)`。

不要用「`startWorkflow` 的 then 里写 `startedId` ref、再拿去和 props 比」当 bind 判定：App 会先 `setState`，ref 还是空的。

标题（必须写在「开始审核」`onClick` 闭包，禁止只改 effect）：

```ts
void Promise.resolve(actions.startWorkflow(payload)).then((res) => {
  const id = res?.sessionId;
  if (!id || !selectedName) return;
  void sparkiiApi().setChatTitle?.(id, contractSessionTitle(selectedName), 'agent');
});
```

现有 `useEffect([sessionId, selectedName])` 可留作同一挂载周期的补发（历史不发、已有 `props.title` 不发、`titledSessions` 防双写）。现有「有 id 就按文件名公布」单测继续成立。未点开始、没有命令返回值 → 仍不公布。

不要把文件名策略搬进 `App.tsx`。

- [ ] **Step 1: Write the failing tests**

1. **bind 保留草稿。** 草稿态选了本地文件 → rerender `sessionId='s-new'`、`mode='live'`、`inputs` 仍空 → 文件名还在。
2. **从草稿打开历史要重置。** 草稿态选了本地文件 → rerender `sessionId='s-hist'`、`mode='history'`、历史 inputs 为 `b.pdf` → 不得再显示草稿文件名，应装 B。
3. **switch / leave 仍重置。** 现有 `s-a→s-b`、`s-b→null` 保持。
4. **onClick 闭包公布。** mock `startWorkflow` resolved `{ sessionId: 'ws-left' }`；草稿选文件后点开始；**不要**把 `props.sessionId` 改成 `ws-left`，也**不要**依赖随后的 effect → `setChatTitle` 仍以 `ws-left` + 去扩展名被调用。
5. 现有：历史不回填、已有 title 不覆盖、没有 session 不公布。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test test/contract-surface.test.tsx`  
Expected: bind 保留 / 命令返回即公布 FAIL

- [ ] **Step 3: Minimal implementation**

只改合同 Surface 对 id 变化和标题时机的处理。旧的 `leftSession` / 「id 变了就清文件」整段换成新判定，不要两套并存。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop test test/contract-surface.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```text
keep contract draft on bind; title from start result
```

---

### Task 3b: 通用占位名跟命令返回，不跟 viewport id

**Files:**
- Modify: `apps/desktop/src/surface/standard-chat.tsx`（可选回调，**不起名**）
- Modify: `apps/desktop/agents/general/surface/index.tsx`
- Test: `apps/desktop/test/general-surface.test.tsx` 和 / 或 `app-general.test.tsx`

**Behavior:**

```ts
// StandardChatProps
onSessionCreated?(sessionId: string, userText: string): void

// promptSession.then（已有 openSession 的那一行旁边）
if (!sessionId && res?.sessionId) {
  actions.openSession(res.sessionId);
  onSessionCreated?.(res.sessionId, display);
}
```

`agents/general`：`onSessionCreated` 里 `setChatTitle(id, placeholderOf(userText), 'agent')`。`placeholderOf` / 截断 / 短名比较仍只在 `agents/general/surface/title.ts`。

短名（助手回复后那一步）仍走现有 entries effect，仅 Surface 还挂着时升级。本轮不在卸挂后补短名。`decideTitle` 的 placeholder 分支留下当同一挂载周期补发（现有 `general-surface`「有 entries 就公布占位」单测仍走这条）。不要只留 `onSessionCreated`、把 effect 占位删掉。

不要：把 `placeholderOf` 写进 `standard-chat.tsx` 或 `App.tsx`。不要为了起名让 loop / `openChatSession` 等待。

- [ ] **Step 1: Write the failing tests**

1. 通用发出首条，`promptSession` 返回 id，**不**把 `sessionId` 改成该 id（模拟未 follow / 已离开）→ `setChatTitle` 仍以占位名被调用。
2. `app-general`：发出后立刻回家或点合同 → 侧栏仍因 `session_title` / `setChatTitle` 出现占位行，且不抢右边。
3. 现有：未出标题不插行、已有 title 不覆盖、短名只在占位匹配时升级。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop test test/general-surface.test.tsx test/app-general.test.tsx`  
Expected: 新用例 FAIL

- [ ] **Step 3: Minimal implementation**

只加可选回调 + general 占位时机。不改短名字符串规则。

- [ ] **Step 4: Run tests**

Run: 同上  
Expected: PASS

- [ ] **Step 5: Commit**

```text
publish general placeholder from promptSession id
```

---

### Task 4: 回来读 JSONL — ENOENT 仍带 inputs

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`（`sparkii:openChatSession` ENOENT 分支）
- Test: `apps/desktop/test/ipc.test.ts`

**Behavior:**

```ts
if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
  return {
    messages: [],
    entries: [],
    inputs: parseSessionInputs((rec as { inputs?: string }).inputs),
  };
}
```

有文件但读成功的路径已经带 `inputs`，不要改语义。`useAgentSession` 已会把 `res.inputs` 写进 `meta`；不必为了本任务改 hook，除非发现它丢掉空数组。

- [ ] **Step 1: Write the failing test**

`ipc.test.ts`：会话记录有 inputs、`piSessionFile` 指向不存在的文件 → `openChatSession` 返回 `messages: []` 且 `inputs` 与记录一致。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test test/ipc.test.ts`（或对该用例的 describe 过滤）  
Expected: FAIL（今日只回 `{ messages: [] }`）

- [ ] **Step 3: Minimal implementation**

只改 ENOENT 返回值。不要改 `runWorkflow` 点火顺序。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop test test/ipc.test.ts test/use-agent-session.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```text
keep session inputs on openChatSession ENOENT
```

---

### Task 5: 回归与缝对缝

**Files:** 本 plan 已改过的测试 + 现有回归

必须保持的断言（改测试适配新语义时不得删掉这些意图）：

| 文件 | 保持 |
| --- | --- |
| `app-general.test.tsx` | 发送、`openSession` 不插行、`session_title` 才 upsert、高亮派生、点智能体回新会话 |
| `app-workflow.test.tsx` | 草稿上开始后标题行出现且亮、状态从 `chat-event` 进时间线、合并 / 导出 |
| `current-work.test.ts` | 高亮公式、page / 新会话无高亮 |
| `contract-surface.test.tsx` | 合并到报告、导出、历史可合并、选文件后 `startWorkflow` 带 documents |

补一条壳级「回来」：点开始 → 去首页 → 再点目录里因 `session_title` 出现的那一行 → `openChatSession` 被调用（JSONL 路径）。不必真起 Pi。

- [ ] **Step 1: Run the suite**

Run:

```text
pnpm --filter @sparkii/desktop test \
  test/current-work.test.ts \
  test/app-workflow.test.tsx \
  test/app-general.test.tsx \
  test/contract-surface.test.tsx \
  test/ipc.test.ts \
  test/use-agent-session.test.ts
```

Expected: PASS

- [ ] **Step 2: 确认该删的已经删掉**

```text
# 本轮点名要删的还在就是没清干净
rg "mode !== 'live'" apps/desktop/src/App.tsx          # startWorkflow 里那刀必须没了
rg "leftSession" apps/desktop/agents/contract-review  # 合同旧导航判定必须没了
# startWorkflow 不得再空吞；不要误修 requestExport
rg -n "catch\\(\\(\\) => \\{\\}\\)" apps/desktop/src/App.tsx
```

生产壳里按 `'contract-review'` / `'general'` 写的 bind / 标题 / 高亮分支应为 0。
`standard-chat.tsx` 里不得出现 `placeholderOf` 或起名 prompt。

- [ ] **Step 3: Commit**（仅当本任务还有测试修补）

```text
regress start/bind/title/jsonl paths
```

---

## Suggested Implementation Order

1. 纯函数（草稿 bind + `sessionIdChange` / workflow mode 拆分）
2. 壳（跟随、报错、交还 Promise、点火不改历史 mode）
3. 合同 Surface（live bind 保留草稿、history open 重置、onClick 公布标题）
4. 通用占位（`onSessionCreated`）
5. `openChatSession` ENOENT
6. 回归

不要先改 `workflow.ts` 去等视口。不要先加握手。

## Self-Review Notes

- 按层拆，不按「修合同按钮」拆。通用占位和合同标题是同一条缝，不能口头「同一协议」只修合同。
- 测试先于实现。旧测试里「只在 bind 之后打事件」可以留，但必须再有「视口已不在草稿 / Surface 已卸」和「ENOENT 带 inputs」。
- 拒绝清单写进 Global Constraints 和 Task 5 grep，避免执行时拣回握手或 `setBusy`。
- `null→id` 在纯函数里叫 `assign`，避免执行者把「从草稿点历史」写成保留文件。
