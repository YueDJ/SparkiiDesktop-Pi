# Session Title Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有会话标题只写 Pi jsonl；Agent 起名；平台只负责写入、用户锁、侧栏立刻显示。

**Architecture:** 平台把 `setChatTitle` 收成「公布标题」：trim、按 `source` 上锁或拒锁、写 `set_session_name`、广播 `session_title`；界面 upsert 侧栏。合同与通用各自在自己的 Agent 包里决定叫什么。主进程删除 `maybeGenerateTitle`。`standard-chat` 不起名。

**Tech Stack:** Electron IPC、better-sqlite3 `sessions.db`、React surfaces、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-04-session-title-source-of-truth-design.md`

## Global Constraints

- 平台生产代码不按 `'general'` / `'contract-review'` 做起名或锁名分支。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- 平台不起名、不截断、不写起名 prompt；不新开 `generateTitle`。
- 标题字符串只进 Pi jsonl；`sessions.db` 只多一比特 `title_locked_by_user`。
- 能放 Agent 且别的 Agent 用不到的逻辑，不放平台。
- 不改运行池、审批、JSONL 业务行、侧栏改名交互、`ModelTask` 路由表、`AgentSurfaceActions`。
- 不改 `standard-chat` 的发送 / 队列 / 模型（它只继续 `openSession(id)`）。
- 测试：Vitest。相关用例按新语义改，不放宽。

---

## Ownership (do not blur)

### 平台必须改（所有 Agent 共用）

| 改动 | 为什么是平台 | 不改什么 |
| --- | --- | --- |
| `setChatTitle(id, title, source)` | 唯一写入 + 广播口 | 不猜文件名、不起短名 |
| `title_locked_by_user` | 用户改名后挡住**任何** Agent | 不存标题字符串 |
| 删除 `maybeGenerateTitle` / `titledSessions` | 平台不再偷偷起名 | — |
| `listChatSessions.title` 只来自 Pi `name` | 列表真相 | 不把 `firstMessage` 塞进 title |
| `sessionDisplayName` 兜底 | 无 name 的旧会话只读显示 | 不写回 Pi |
| `session_title` upsert | 侧栏插入/改名 | 不编「新对话」当产品名 |
| `openSession` / `startWorkflow` 只绑 id | 绑定当前会话 | 不再用一段话插侧栏 |
| 手动改名传 `source: "user"` | 上锁 | 不改右键菜单 UI |
| 把当前显示名传给**所有** Agent 的 `title` | 合同/通用都要判断「已有名字」 | 不为 workflow 编默认「新对话」 |
| `completeText(sessionId, text)` | 通用补全通道，无标题语义；以后别的 Agent 也可能问模型一句 | 主进程禁止出现起名 prompt |

### Agent 必须改（策略，别的 Agent 用不到）

| 改动 | 包 | 不放平台的原因 |
| --- | --- | --- |
| 去扩展名 + ≤20 的文件名 | `agents/contract-review` | 只有合同用文件名 |
| 有 `sessionId` 且还没有名字才公布 | `agents/contract-review` | 合同自己的时机 |
| `placeholderOf` / 两步比较 / 短名 prompt | `agents/general` | 只有通用两步起名 |
| 包装 `StandardChatSurface` 看 entries + title | `agents/general` | 不要写进 `src/surface/standard-chat.tsx` |

### 明确不改

- `src/surface/standard-chat.tsx` 发送与队列
- `AgentSurfaceActions` 方法集
- Pi `set_session_name` 协议
- 运行池、审批、置顶/归档/拖拽
- 旧会话批量补标题
- 合同短名补全

---

## File Structure

```text
# 平台
apps/desktop/electron/main/chat-session-store.ts
apps/desktop/electron/main/ipc.ts
apps/desktop/electron/preload/api-types.ts
apps/desktop/electron/preload/api.ts
apps/desktop/src/App.tsx
apps/desktop/test/chat-session-store.test.ts
apps/desktop/test/ipc.test.ts
apps/desktop/test/app-general.test.tsx
apps/desktop/test/app-workflow.test.tsx
apps/desktop/test/preload-api.test.ts

# 合同 Agent
apps/desktop/agents/contract-review/surface/title.ts          # 新建
apps/desktop/agents/contract-review/surface/index.tsx
apps/desktop/test/contract-surface.test.tsx
apps/desktop/test/contract-title.test.ts                     # 新建

# 通用 Agent
apps/desktop/agents/general/surface/title.ts                 # 新建
apps/desktop/agents/general/surface/index.tsx
apps/desktop/test/general-title.test.ts                      # 新建
apps/desktop/test/general-surface.test.tsx                   # 新建
```

---

### Task 1: 平台 — `sessions.db` 用户锁比特

**Files:**
- Modify: `apps/desktop/electron/main/chat-session-store.ts`
- Test: `apps/desktop/test/chat-session-store.test.ts`

**Interfaces:**
- Produces: `ChatSessionRecord.titleLockedByUser: boolean`（默认 `false`）
- `update` 的 patch 增加 `'titleLockedByUser'`
- 旧库 `ALTER TABLE ... ADD COLUMN title_locked_by_user INTEGER NOT NULL DEFAULT 0`
- `SELECT` / `INSERT` / `UPDATE` 都带上这一列
- **仍然没有 title 字符串列**

- [ ] **Step 1: Write the failing test**

在 `chat-session-store.test.ts` 增加：

```ts
it('persists titleLockedByUser and defaults to false', () => {
  const s = store();
  s.create({ id: 'pi-1', profileId: 'general', workspaceKind: 'auto', workspacePath: 'C:/a' });
  expect(s.get('pi-1')?.titleLockedByUser).toBe(false);
  s.update('pi-1', { titleLockedByUser: true });
  expect(s.get('pi-1')?.titleLockedByUser).toBe(true);
  s.close();
});

it('migrates title_locked_by_user onto an existing db', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'sessions-lock-')), 'sessions.db');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'chat',
      current_step TEXT,
      workspace_kind TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      model TEXT,
      thinking_level TEXT,
      pi_session_file TEXT,
      inputs TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      sort_order REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  raw.prepare(`INSERT INTO chat_sessions (id, profile_id, kind, workspace_kind, workspace_path, pinned, archived, created_at, updated_at)
    VALUES ('old', 'general', 'chat', 'auto', 'C:/a', 0, 0, 1, 1)`).run();
  raw.close();
  const s = new ChatSessionStore(dbPath);
  expect(s.get('old')?.titleLockedByUser).toBe(false);
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop test test/chat-session-store.test.ts`
Expected: FAIL（没有 `titleLockedByUser`）

- [ ] **Step 3: Minimal implementation**

在 `ChatSessionRecord` 加 `titleLockedByUser: boolean`。`toRecord` 用 `!!row.titleLockedByUser`。构造函数里若无该列则 `ADD COLUMN`。`create` 默认 `false`。`update` 的 `Pick` 与 SQL 带上 `title_locked_by_user=@titleLockedByUser`。所有 SELECT 加 `title_locked_by_user AS titleLockedByUser`。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop test test/chat-session-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/chat-session-store.ts apps/desktop/test/chat-session-store.test.ts
git commit -m "feat(desktop): persist titleLockedByUser on chat sessions"
```

---

### Task 2: 平台 — 公布口 + 删掉自动起名

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/ipc.test.ts`
- Test: `apps/desktop/test/preload-api.test.ts`

**Interfaces:**
- `setChatTitle(sessionId: string, title: string, source?: 'user' | 'agent'): Promise<{ ok: boolean; reason?: 'locked' }>`
- 漏传 `source` 视为 `'agent'`
- `completeText(sessionId: string, text: string): Promise<{ ok: boolean; text?: string }>`
- 删除 `maybeGenerateTitle`、`titledSessions`、`agent_end` 自动起名
- `listChatSessions` 返回 `{ title: s.name, firstMessage: s.firstMessage, ... }`（`title` 不再 fallback 到 firstMessage）

- [ ] **Step 1: Write the failing tests**

改现有 `setChatTitle notifies...`：调用改为 `setChatTitle(null, 'wf-1', '采购合同.pdf', 'agent')`。

新增：

```ts
it('setChatTitle rejects empty titles and agent writes after a user lock', async () => {
  // makeRuntime + 已有 chatSession wf-1
  const handlers = await registeredHandlers();
  const setTitle = handlers.get('sparkii:setChatTitle')!;
  expect(await setTitle(null, 'wf-1', '   ', 'agent')).toEqual({ ok: false });
  expect(windowSent.filter((c) => c[1]?.type === 'session_title')).toHaveLength(0);

  expect(await setTitle(null, 'wf-1', '我改的名字', 'user')).toEqual({ ok: true });
  expect(send).toHaveBeenCalledWith({ type: 'set_session_name', name: '我改的名字' });

  send.mockClear();
  windowSent.length = 0;
  expect(await setTitle(null, 'wf-1', '采购合同', 'agent')).toEqual({ ok: false, reason: 'locked' });
  expect(send).not.toHaveBeenCalled();
  expect(windowSent.some((c) => c[1]?.type === 'session_title')).toBe(false);
});

it('listChatSessions does not put firstMessage into title', async () => {
  vi.mocked(listPiSessions).mockResolvedValueOnce([
    { id: 's1', name: undefined, firstMessage: 'A'.repeat(80), path: '/tmp/s.jsonl', cwd: '', created: new Date(), modified: new Date(), messageCount: 1 },
  ] as any);
  const result = await handlers.get('sparkii:listChatSessions')!(null, 'general');
  expect(result[0].title).toBeUndefined();
  expect(result[0].firstMessage).toBe('A'.repeat(80));
});

it('completeText forwards text to complete and does not mention 标题', async () => {
  const result = await handlers.get('sparkii:completeText')!(null, 's1', '只是一句普通补全');
  expect(result).toEqual({ ok: true, text: '模型回答' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'complete', text: '只是一句普通补全' }));
  expect(String(send.mock.calls.find((c) => c[0]?.type === 'complete')?.[0]?.text)).not.toMatch(/标题/);
});
```

保留并收紧：workflow `agent_end` 之后没有 `complete` / `set_session_name`。再加一条 **chat** 会话 `agent_end` 同样不再自动 `complete`。

preload：`setChatTitle` 传第三参；`Object.keys(api)` 含 `completeText`。

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @sparkii/desktop test test/ipc.test.ts test/preload-api.test.ts`

- [ ] **Step 3: Implement**

`setChatTitle`：

1. `title = String(title ?? '').trim()`；空 → `{ ok: false }`，不写不广播。
2. `origin = source === 'user' ? 'user' : 'agent'`。
3. `rec = rt.chatSessions.get(sessionId)`；`origin === 'agent' && rec?.titleLockedByUser` → `{ ok: false, reason: 'locked' }`。
4. `origin === 'user' && rec` → `rt.chatSessions.update(sessionId, { titleLockedByUser: true })`。
5. 广播 `session_title`（乐观）。
6. 现有 acquire / `set_session_name` 路径，把 `name` 换成 trim 后的字符串。
7. 删掉 `titledSessions.add`。

删除整个 `maybeGenerateTitle` 函数，以及 `pipeSessionEvents` 里 `agent_end && rec?.kind !== 'workflow'` 分支。

`listChatSessions`：`title: s.name`（不要 `?? s.firstMessage`），另加 `firstMessage: s.firstMessage`。

`completeText`：`ensureOpenSession` + `resolveModelTarget(settings, 'title') ?? resolveModelTarget(settings, 'default')` + `send({ type: 'complete', provider, modelId, text })`。无模型或失败 → `{ ok: false }`。**文件里不能出现「请为以下对话生成」或「标题」prompt。**

preload / types 同步。`SparkiiApi.setChatTitle` 第三参可选；返回可带 `reason`。

- [ ] **Step 4: Tests pass + grep**

Run: `pnpm --filter @sparkii/desktop test test/ipc.test.ts test/preload-api.test.ts`
Expected: PASS。`ipc.ts` 无 `maybeGenerateTitle`、无「请为以下对话」。

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): publish titles with user lock and drop auto-title"
```

---

### Task 3: 平台 — 列表兜底 + 侧栏 upsert

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`
- Test: `apps/desktop/test/app-workflow.test.tsx`（若有标题相关断言则跟上）

**Interfaces:**
- `sessionDisplayName`：有 `title` 原样；否则 `firstMessage.slice(0, 20)`；否则时间；否则 `'会话'`
- `session_title`：已有行改名；没有行则插入到拥有该 sessionId 的 Agent（`activeSessionByAgent` 或 `workflowByAgent`）；置顶组之后、未置顶之前
- `openSession(id)` 只 `setActiveSessionFor` + `refreshSessions`，**不**用「新对话」插行
- `onRenameSession` → `setChatTitle(sessionId, title, 'user')`
- 所有 Agent 的 `title` prop = `titleFor(id) || 列表里该 session 的 name`（workflow 也传；不要给合同硬塞「新对话」）
- `session_title` 时：`activeSessionByAgent` **和** `workflowByAgent.sessionId` 匹配则 `setTitleFor`

- [ ] **Step 1: Update / add tests**

`sessionDisplayName`：

```ts
expect(sessionDisplayName({ firstMessage: '帮我写一个合同审核流程' })).toBe('帮我写一个合同审核流程'.slice(0, 20));
expect(sessionDisplayName({ firstMessage: 'a'.repeat(30) })).toBe('a'.repeat(20));
expect(sessionDisplayName({ title: '很长的标题'.repeat(5), firstMessage: 'x' })).toBe('很长的标题'.repeat(5));
```

`app-general`：

- `makeApi().setChatTitle` 实现为：调用后立刻 `channels['chat-event']({ type: 'session_title', sessionId, title })`，这样 Agent 公布能驱动 upsert。
- 手动改名断言改为 `toHaveBeenCalledWith('g1', '新标题', 'user')`。
- 「新会话立刻出现」：发送后应出现侧栏行；名字来自 Agent 公布的占位（`你好`），**不是**平台编的「新对话」。若测试里还没有用户 message 事件，先发 `{ type: 'message', role: 'user', text: '你好', sessionId: 'g1' }`，再等 `setChatTitle` / 侧栏。
- 新增：仅 `openSession`、不发 `session_title` 时，侧栏没有「新对话」这一行（`listChatSessions` 仍为空）。
- 新增：`session_title` 对尚未在列表里的 id，插入一行。

`app-workflow`：合同 `session_title` 后侧栏出现该名字（可在现有用例上加一条）。

- [ ] **Step 2: Tests fail**

Run: `pnpm --filter @sparkii/desktop test test/app-general.test.tsx`

- [ ] **Step 3: Implement App.tsx only on the title path**

不要重排 `refreshSessions` / 置顶 / 运行池。只改：

1. `sessionDisplayName`
2. `chat-event` 里 `session_title` 改为 upsert + 同步 workflow 的 `titleFor`
3. `commitNewSession` / `openSession`：只绑 id，删掉用 `title || '新对话'` 插行
4. `onRenameSession` 第三参 `'user'`
5. `AgentFrame` 的 `title` 对 chat 与 workflow 都传当前显示名

- [ ] **Step 4: Tests pass**

Run: `pnpm --filter @sparkii/desktop test test/app-general.test.tsx test/app-workflow.test.tsx`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): upsert sidebar titles from Pi name events"
```

---

### Task 4: Agent — 合同文件名

**Files:**
- Create: `apps/desktop/agents/contract-review/surface/title.ts`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Test: `apps/desktop/test/contract-title.test.ts`
- Test: `apps/desktop/test/contract-surface.test.tsx`

**Interfaces:**
- `contractSessionTitle(fileName: string): string`
  - `stripLastExt` = `replace(/\.[^./\\]+$/, '')`
  - `trim().slice(0, 20)`；空则 `'合同审核'`
- Surface：有 `sessionId`、有文件名、且 `props.title` 为空（trim 后）才 `setChatTitle(sessionId, contractSessionTitle(name), 'agent')`
- 已有 `title`（历史 / 用户改过 / 自己写过）→ 不调用
- 未点开始、无 `sessionId` → 不调用
- 删掉「只靠 `titledSessions` Set 防重入」作为唯一判断；Set 最多当本挂载防抖

- [ ] **Step 1: Tests**

```ts
// contract-title.test.ts
expect(contractSessionTitle('采购合同.pdf')).toBe('采购合同');
expect(contractSessionTitle('合同.最终版.docx')).toBe('合同.最终版');
expect(contractSessionTitle('只有名字')).toBe('只有名字');
expect(contractSessionTitle('非常非常长的合同文件名一共二十多个字.docx').length).toBe(20);
expect(contractSessionTitle('.pdf')).toBe('合同审核');
```

Surface：

- `sessionId + 采购合同.pdf` + 无 `title` → `setChatTitle('s-title', '采购合同', 'agent')`
- 传入 `title="用户改的"` → 不调用
- `sessionId=null` → 不调用

- [ ] **Step 2–4: Implement, pass, commit**

```bash
git commit -m "feat(contract-review): publish stripped filename as session title"
```

---

### Task 5: Agent — 通用两步起名

**Files:**
- Create: `apps/desktop/agents/general/surface/title.ts`
- Modify: `apps/desktop/agents/general/surface/index.tsx`
- Test: `apps/desktop/test/general-title.test.ts`
- Test: `apps/desktop/test/general-surface.test.tsx`
- 不修改: `apps/desktop/src/surface/standard-chat.tsx`

**Interfaces:**

```ts
placeholderOf(userText: string): string  // trim.slice(0,20) || '新对话'

firstUserText(entries: SessionEntry[]): string | undefined
firstAssistantText(entries: SessionEntry[]): string | undefined
// 第一条 kind==='message' 且对应 role，text trim 非空；思考/工具不算

shortTitlePrompt(userText: string, assistantText: string): string
// Agent 自己的中文 prompt，含「不超过20字」「只输出标题」

type TitleDecision =
  | { action: 'placeholder'; title: string }
  | { action: 'short'; prompt: string }
  | { action: 'none' };

decideTitle(input: {
  currentTitle?: string;
  firstUserText?: string;
  firstAssistantText?: string;
}): TitleDecision
```

规则：

- 有 firstUser、没有 currentTitle（空/空白）→ `placeholder`
- 有 firstAssistant、且 `currentTitle === placeholderOf(firstUser)` → `short`
- 其他 → `none`（历史短名、用户改过、还没用户消息）

包装层：渲染 `StandardChatSurface`；`useEffect` 看 `sessionId` / `session.entries` / `title`。

- `placeholder` → `setChatTitle(id, title, 'agent')`
- `short` → `completeText(id, prompt)`，成功且 trim 非空再 `setChatTitle(id, slice(0,20), 'agent')`；失败不写
- 同一 `sessionId` + 同一 decision 用 ref 防抖，避免重复 complete
- **不把占位字符串存盘**；每次 `decideTitle` 现算

- [ ] **Step 1: Pure tests in `general-title.test.ts`**

覆盖：截断 20、空→新对话、有 title 不再占位、title===占位才短名、title 已是短名则 none、打开历史（title 是别的字）none、prompt 含用户句和助手句且含「20」。

- [ ] **Step 2: Surface tests**

喂 entries + 空 title → 调用 `setChatTitle(..., placeholder, 'agent')`。  
title 已是占位 + 助手句 + `completeText` 返回「违约责任条款修改」→ 再 `setChatTitle(..., '违约责任条款修改', 'agent')`。  
title 已是「用户改的」+ 助手句 → 不调用 complete、不再 setChatTitle。  
`completeText` 失败 → 只有占位那一次 setChatTitle。

- [ ] **Step 3–5: Implement wrapper, pass, commit**

```bash
git commit -m "feat(general): two-step session titles owned by the agent"
```

---

### Task 6: 回归与自检

- [ ] Run: `pnpm --filter @sparkii/desktop test test/chat-session-store.test.ts test/ipc.test.ts test/preload-api.test.ts test/app-general.test.tsx test/app-workflow.test.tsx test/contract-surface.test.tsx test/contract-title.test.ts test/general-title.test.ts test/general-surface.test.tsx`
- [ ] `rg -n "maybeGenerateTitle|请为以下对话生成" apps/desktop/electron/main/ipc.ts` → 无匹配
- [ ] `rg -n "placeholderOf|contractSessionTitle|shortTitlePrompt" apps/desktop/src apps/desktop/electron` → 无匹配（策略不在平台）
- [ ] `pnpm --filter @sparkii/desktop exec tsc --noEmit -p tsconfig.electron.json`
- [ ] Commit 若还有测试修复

---

## Spec coverage (self-review)

| Spec | Task |
| --- | --- |
| Pi name 唯一落盘 | 2 |
| 平台不起名 / 删 maybeGenerateTitle | 2 |
| source + 用户锁 | 1, 2 |
| 空串拒绝 | 2 |
| list title 只认 name | 2, 3 |
| session_title upsert | 3 |
| openSession 不编名 | 3 |
| 手动改名 source=user | 3 |
| 合同去扩展名 ≤20、已有名不写 | 4 |
| 通用占位现算、短名条件比较 | 5 |
| completeText 无标题语义 | 2, 5 |
| standard-chat 不起名 | 5（不改该文件） |
| 旧会话不回填 | 3 兜底只读 |
| 不按 agent id 分支起名 | 全程 |

无 TBD。类型名：`titleLockedByUser` / `source: 'user' | 'agent'` / `completeText` / `contractSessionTitle` / `placeholderOf` / `decideTitle` 前后任务一致。
