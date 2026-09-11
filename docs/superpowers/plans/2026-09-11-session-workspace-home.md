# Session Workspace Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动工作区改到 `Documents/Sparkii/workspaces/<agentId>/<uuid>`；每条新 session 一条新路径；开始审核不建目录；工作区仍是一个按钮，对话框停在当前目录。

**Architecture:** Main 用 `allocateAutoWorkspace(documents, agentId)` 只算路径。Renderer 草稿向 Main 要路径并显示。`chooseWorkspace({ defaultPath })` 对绝对路径先 mkdir 再打开选文件夹对话框。`runWorkflow` 删除 `ensureWorkspaceDir`。`report.export` 写文件前创建父目录。UI 不拆第二个按钮。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron `dialog`、`node:fs/promises`。

**Spec:** `docs/superpowers/specs/2026-09-11-session-workspace-home-design.md`（v4：工作区仍是一个按钮）

## Global Constraints

- 自动路径公式唯一：`join(documents, 'Sparkii', 'workspaces', agentId, workspaceKey)`。`workspaceKey` 是星火物名 `adj-noun-tag`（如 `glow-fox-k7m`）。
- 生产代码不以 `'general'` / `'contract-review'` / `'knowledge-qa'` 决定路径。
- 生产禁止 `autoWorkspacePath` / `app.getPath('desktop')` 作为工作区父目录。
- `runWorkflow` 禁止 `ensureWorkspaceDir`。
- 分配路径不 `mkdir`。mkdir 只许：点工作区按钮（`chooseWorkspace` 绝对 defaultPath）、导出报告、附件、已批准写工具。
- Renderer 不得 `join(documents, ...)`。只调用 `allocateAutoWorkspace` / `chooseWorkspace({ defaultPath })`。
- 不新增 `openWorkspace` IPC，不拆工作区次要按钮，不改 `ChatComposer` 的 `onChooseWorkspace`。
- `agentId` 含 `..` 或 `/` `\` 时 `allocateAutoWorkspace` 抛错。
- `chooseWorkspace` 的 `defaultPath` 非绝对：不 mkdir、对话框不带 defaultPath。
- App **不 remount** 合同表面。`sessionId` 变为 `null` / `startNewSession` 必须就地清空 `runPrefs` + bar，再 allocate。禁止 `draft.epoch`。
- `sessionId == null` 禁止从 `session.meta.workspacePath` 回写。
- 新建会话入库 `workspaceKind`：context/input 带 `user` 则为 `user`，否则 `auto`。IPC **不得**因「有路径」推断为 `user`。
- `workflow.ts` 禁止 `dataDir/sessions` 当工作区兜底。
- 测试 mock `app.getPath` 必须按 name 返回；`documents` 指向临时目录；禁止 `getPath: () => ''`。`desktop` 若仍返回 `''`，Task 8 grep 必须证明生产不再读它。
- 每任务提交前跑该任务点名的 vitest。Windows 用 `pnpm exec vitest run <files>`。

## File Structure

```text
apps/desktop/electron/main/workspace.ts
apps/desktop/electron/main/ipc.ts
apps/desktop/electron/preload/api.ts
apps/desktop/electron/preload/api-types.ts
packages/connectors/src/report/index.ts
packages/ui/src/patterns/ChatComposer.tsx
apps/desktop/src/surface/standard-chat.tsx
apps/desktop/src/workbench/Composer.tsx
apps/desktop/agents/contract-review/surface/index.tsx
apps/desktop/electron/main/workflow.ts
apps/desktop/test/workspace.test.ts
apps/desktop/test/ipc.test.ts
apps/desktop/test/preload-api.test.ts
apps/desktop/test/contract-surface.test.tsx
apps/desktop/test/standard-chat.test.tsx
apps/desktop/test/chat-composer.test.tsx
apps/desktop/test/chat-composer-toolbar.test.tsx
packages/connectors/test/report.test.ts
```

建议自检：

```text
pnpm exec vitest run apps/desktop/test/workspace.test.ts packages/connectors/test/report.test.ts apps/desktop/test/preload-api.test.ts
pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/contract-surface.test.tsx apps/desktop/test/standard-chat.test.tsx apps/desktop/test/chat-composer.test.tsx apps/desktop/test/chat-composer-toolbar.test.tsx
```

---

### Task 1: 路径分配（不 mkdir）

**Files:**
- Modify: `apps/desktop/electron/main/workspace.ts`
- Test: `apps/desktop/test/workspace.test.ts`

**Interfaces:**
- Consumes: 现有 `defaultWorkspacePath(documents, agentId, sessionId)`
- Produces:
  ```ts
  export function assertAgentId(agentId: string): string;
  export function allocateAutoWorkspace(documents: string, agentId: string): { workspaceKey: string; workspacePath: string };
  ```

- [ ] **Step 1: Write the failing test**

在 `workspace.test.ts` 追加：

```ts
import { existsSync } from 'node:fs';
import { allocateAutoWorkspace, assertAgentId } from '../electron/main/workspace.js';

it('allocateAutoWorkspace is Documents/Sparkii/workspaces/<agent>/<uuid> and does not mkdir', () => {
  const docs = join(tmpdir(), 'docs-home');
  const a = allocateAutoWorkspace(docs, 'contract-review');
  const b = allocateAutoWorkspace(docs, 'contract-review');
  expect(a.workspaceKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(a.workspacePath).toBe(join(docs, 'Sparkii', 'workspaces', 'contract-review', a.workspaceKey));
  expect(b.workspaceKey).not.toBe(a.workspaceKey);
  expect(existsSync(a.workspacePath)).toBe(false);
});

it('assertAgentId rejects traversal', () => {
  expect(() => assertAgentId('../x')).toThrow();
  expect(() => assertAgentId('a/b')).toThrow();
  expect(assertAgentId('general')).toBe('general');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/workspace.test.ts`
Expected: FAIL（`allocateAutoWorkspace` / `assertAgentId` 未导出）。

- [ ] **Step 3: Write minimal implementation**

`workspace.ts` 增加：

```ts
import { randomUUID } from 'node:crypto';

export function assertAgentId(agentId: string): string {
  const id = String(agentId ?? '').trim();
  if (!id || id.includes('..') || /[\\/]/.test(id)) throw new Error('invalid agentId');
  return id;
}

export function allocateAutoWorkspace(documents: string, agentId: string): { workspaceKey: string; workspacePath: string } {
  const workspaceKey = randomUUID();
  return { workspaceKey, workspacePath: defaultWorkspacePath(documents, assertAgentId(agentId), workspaceKey) };
}
```

不要改 `ensureWorkspaceDir`。`autoWorkspacePath` 本任务可留着，**Task 3** 会从生产调用点删掉。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/workspace.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workspace.ts apps/desktop/test/workspace.test.ts
git commit -m "feat(workspace): allocate Documents/Sparkii session paths without mkdir"
```

---

### Task 2: report.export 写文件前创建父目录

**Files:**
- Modify: `packages/connectors/src/report/index.ts`
- Test: `packages/connectors/test/report.test.ts`

**Interfaces:**
- Consumes: 现有 `report.export` handler
- Produces: handler 在 `writeFile` 前 `mkdir(dirname(outPath), { recursive: true })`

- [ ] **Step 1: Write the failing test**

```ts
it('creates missing parent directories before write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  const out = join(dir, 'missing', 'ws', 'out.docx');
  const tool = reportConnector.tools.find((t) => t.name === 'report.export')!;
  const r = await tool.handler({ title: 'x', sections: [], format: 'docx', path: out }, { profileId: 'p', sessionId: 's', actor: 'u', requestId: 'r' });
  expect(r.ok).toBe(true);
  expect(existsSync(out)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/connectors/test/report.test.ts`
Expected: FAIL（`ENOENT` / `ok: false`）。

- [ ] **Step 3: Write minimal implementation**

`packages/connectors/src/report/index.ts`：`import { mkdir, writeFile } from 'node:fs/promises'` 与 `import { dirname } from 'node:path'`。handler 里 `writeFile` 之前：

```ts
await mkdir(dirname(outPath), { recursive: true });
```

在 base64 / `buildReportDocx` 分支**之前**写一次 `await mkdir(dirname(outPath), { recursive: true })`，覆盖两处 `writeFile`。本包不做 workspace 围栏：路径由 Desktop 在审批后传入。合同侧导出必须用 `reportExportPath(已分配或用户工作区, title)`，不得另写桌面路径。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/connectors/test/report.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/report/index.ts packages/connectors/test/report.test.ts
git commit -m "fix(report): mkdir parent before writing export docx"
```

---

### Task 3: IPC 分配 / 选目录 defaultPath；审核不再预建

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/ipc.test.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`（必须改这三处：`:176` 有路径无 kind 现期望 `'user'` → 改为 `'auto'`；`:300` 无路径现期望 `workspaceRoot` undefined → 改为已分配 Documents 路径；`:133` / `:288` 位置参数补上新的 `documentsDir`）

**Interfaces:**
- Consumes: `allocateAutoWorkspace`、`ensureWorkspaceDir`、`assertAgentId`
- Produces:
  ```ts
  sparkii:allocateAutoWorkspace(agentId: string) => { workspacePath: string }
  sparkii:chooseWorkspace(opts?: { defaultPath?: string }) => { path?: string }
  ```
  `runWorkflow` 不再调用 `ensureWorkspaceDir`；无路径时 Documents 分配。  
  `openOrCreateSession` / `setChatWorkspace(null)` 用 `allocateAutoWorkspace(app.getPath('documents'), profileId)`。

- [ ] **Step 1: Fix the electron mock so tests cannot leak into the repo**

把 `ipc.test.ts` 的

```ts
app: { getPath: () => '', on: () => {}, quit: () => {} },
```

改成：

```ts
app: {
  getPath: (name: string) => (name === 'documents' ? join(tmpdir(), 'sparkii-test-documents') : ''),
  on: () => {},
  quit: () => {},
},
```

文件顶部增加一个 `afterEach`（若已有 `dirs` 清理则并入）：对 `join(tmpdir(), 'sparkii-test-documents')` `rm(..., { recursive: true, force: true })`。

- [ ] **Step 2: Write failing IPC tests**

在 `ipc.test.ts` 追加（沿用现有 `makeRuntime` / `registeredHandlers` / `dirs` 模式）：

每个 allocate 测试必须登记 agent，禁止对空 registry 调 `'general'`：

```ts
const agents = new Map([['general', { id: 'general', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'general' } }]]);

it('allocateAutoWorkspace returns a Documents path and does not create it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  await makeRuntime({ dataDir, piAgentDir: join(dataDir, 'pi-agent'), client: { send: async () => ({ success: true }) }, agents });
  const handlers = await registeredHandlers();
  const { existsSync } = await import('node:fs');
  const { workspacePath } = await handlers.get('sparkii:allocateAutoWorkspace')!(null, 'general') as { workspacePath: string };
  expect(workspacePath.replace(/\\/g, '/')).toMatch(/Sparkii\/workspaces\/general\/[0-9a-f-]+$/i);
  expect(existsSync(workspacePath)).toBe(false);
});

it('allocateAutoWorkspace rejects unknown agent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  await makeRuntime({ dataDir, piAgentDir: join(dataDir, 'pi-agent'), client: { send: async () => ({ success: true }) }, agents });
  const handlers = await registeredHandlers();
  await expect(handlers.get('sparkii:allocateAutoWorkspace')!(null, 'nope')).rejects.toThrow(/unknown agent/);
});

it('chooseWorkspace mkdirs an absolute defaultPath and forwards it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const ws = join(dataDir, 'abs-ws');
  await makeRuntime({
    dataDir, piAgentDir: join(dataDir, 'pi-agent'),
    client: { send: async () => ({ success: true }) }, agents,
    getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: () => {} } }) as any,
  });
  const electron = await import('electron');
  vi.mocked(electron.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as any);
  const handlers = await registeredHandlers();
  await handlers.get('sparkii:chooseWorkspace')!(null, { defaultPath: ws });
  expect(existsSync(ws)).toBe(true);
  expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ properties: ['openDirectory'], defaultPath: ws }),
  );
});

it('chooseWorkspace ignores a relative defaultPath without mkdir', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  await makeRuntime({
    dataDir, piAgentDir: join(dataDir, 'pi-agent'),
    client: { send: async () => ({ success: true }) }, agents,
    getWindow: () => ({ on: () => {}, isDestroyed: () => false, webContents: { send: () => {} } }) as any,
  });
  const electron = await import('electron');
  vi.mocked(electron.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as any);
  const handlers = await registeredHandlers();
  const rel = 'SparkiiRelChooseWs';
  await handlers.get('sparkii:chooseWorkspace')!(null, { defaultPath: rel });
  expect(existsSync(rel)).toBe(false);
  expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(
    expect.anything(),
    expect.not.objectContaining({ defaultPath: rel }),
  );
});

it('runWorkflow without workspacePath allocates Documents path and does not mkdir', async () => {
  const created: Array<{ workspacePath?: string; workspaceKind?: string }> = [];
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const contractAgents = new Map([['contract-review', { id: 'contract-review', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'contract-review' } }]]);
  const rt = await makeRuntime({
    dataDir, piAgentDir: join(dataDir, 'pi-agent'),
    client: { send: async () => ({ success: true }) },
    agents: contractAgents,
  });
  (rt as any).chatSessions.create = (rec: { workspacePath?: string; workspaceKind?: string }) => { created.push(rec); return { id: 's1' }; };
  const handlers = await registeredHandlers();
  await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [] });
  expect(created[0].workspacePath?.replace(/\\/g, '/')).toMatch(/Sparkii\/workspaces\/contract-review\//);
  expect(created[0].workspaceKind).toBe('auto');
  expect(existsSync(created[0].workspacePath!)).toBe(false);
});

it('runWorkflow with an allocated path keeps workspaceKind auto', async () => {
  const created: Array<{ workspaceKind?: string; workspacePath?: string }> = [];
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const contractAgents = new Map([['contract-review', { id: 'contract-review', tools: [], skillsDir: '', systemPrompt: '', manifest: { name: 'contract-review' } }]]);
  const rt = await makeRuntime({
    dataDir, piAgentDir: join(dataDir, 'pi-agent'),
    client: { send: async () => ({ success: true }) },
    agents: contractAgents,
  });
  (rt as any).chatSessions.create = (rec: { workspaceKind?: string; workspacePath?: string }) => { created.push(rec); return { id: 's1' }; };
  const handlers = await registeredHandlers();
  const allocated = 'C:/docs/Sparkii/workspaces/contract-review/ws-auto';
  await handlers.get('sparkii:runWorkflow')!(null, 'contract-review', { documents: [], workspacePath: allocated });
  expect(created[0].workspacePath).toBe(allocated);
  expect(created[0].workspaceKind).toBe('auto');
});
```

`makeRuntime` 只登记 `agents`（该文件 `makeRuntime` 的 `profiles` 写死空 Map，不要用 profile 替代）。禁止只写注释不断言。沿用该文件里已有 workflow 测试的 stub（broker / client）若上面骨架不够。

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/test/ipc.test.ts -t "allocateAutoWorkspace|chooseWorkspace|runWorkflow without workspacePath|runWorkflow with an allocated path"`
Expected: FAIL（handler 不存在或仍不 mkdir defaultPath / 仍桌面 / kind 仍由路径推断）。

- [ ] **Step 4: Implement IPC**

`ipc.ts`：

```ts
import { allocateAutoWorkspace, ensureWorkspaceDir, assertAgentId } from './workspace.js';
// 删除 autoWorkspacePath 的 import
```

```ts
const documentsDir = () => app.getPath('documents');

ipcMain.handle('sparkii:allocateAutoWorkspace', (_e, agentId: string) => {
  assertAgentId(agentId);
  if (!rt.agents.has(agentId) && !rt.profiles.has(agentId)) throw new Error('unknown agent');
  return { workspacePath: allocateAutoWorkspace(documentsDir(), agentId).workspacePath };
});

`import { isAbsolute, join } from 'node:path'`（`join` 已有则只加 `isAbsolute`）。

`chooseWorkspace` 改为接收 `opts?: { defaultPath?: string }`：

```ts
ipcMain.handle('sparkii:chooseWorkspace', async (_e, opts?: { defaultPath?: string }) => {
  const defaultPath = String(opts?.defaultPath ?? '').trim();
  const dialogOpts: { properties: ['openDirectory']; defaultPath?: string } = { properties: ['openDirectory'] };
  const win = getWindow();
  if (!win) return {};
  if (defaultPath && isAbsolute(defaultPath)) {
    await ensureWorkspaceDir(defaultPath);
    dialogOpts.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(win, dialogOpts);
  return result.canceled ? {} : { path: result.filePaths[0] };
});
```

不新增 `sparkii:openWorkspace`。null window 时不 mkdir。

`openOrCreateSession` 新建分支：

```ts
const workspacePath = context.workspacePath?.trim()
  || allocateAutoWorkspace(documentsDir(), profileId).workspacePath;
const workspaceKind = context.workspacePath?.trim()
  ? (context.workspaceKind === 'user' ? 'user' : 'auto')
  : 'auto';
// create({ ..., workspaceKind, workspacePath })
```

`DraftPromptContext` 增加 `workspaceKind?: 'auto' | 'user'`。同时改 `ipc.ts` 里 `openOrCreateSession`（约 542）和 `promptSession` handler（约 705）的两处内联 context 字面量，补上 `workspaceKind?: 'auto' | 'user'`（或两处都改用 `DraftPromptContext`）。只改类型定义、不改这两处签名会 typecheck 失败。

`workflow.ts`：

- 删除 `workspacePath ?? join(rt.dataDir, 'sessions', sessionId)`。禁止用锚点当工作区。
- `runWorkflow` **必须**增加参数 `documentsDir: string`（不要在 `workflow.ts` 里 `import { app } from 'electron'`——`workflow-broker.test.ts` 没有 electron mock）。签名：`runWorkflow(rt, getWindow, input, broker, profileId, opts, documentsDir: string)`。
- 函数体：`const workspacePath = requested ?? allocateAutoWorkspace(documentsDir, profileId).workspacePath;`
- `workspaceKind = input.workspaceKind === 'user' ? 'user' : 'auto'`。有路径但没 kind 不得推成 `user`。
- `sparkii:runWorkflow` 调用时传入 `app.getPath('documents')`，并转发 kind：`workspaceKind: input.workspaceKind === 'user' ? 'user' : 'auto'`。**禁止** `requestedWorkspace ? 'user' : 'auto'`。

`setChatWorkspace` 的 `else`：

```ts
const next = allocateAutoWorkspace(documentsDir(), rec.profileId).workspacePath;
rt.chatSessions.update(sessionId, { workspaceKind: 'auto', workspacePath: next });
```

`runWorkflow`：

```ts
const workspacePath = requestedWorkspace
  ?? allocateAutoWorkspace(documentsDir(), profileId).workspacePath;
// 删除 await ensureWorkspaceDir(workspacePath);
```

未知 agent 的 `allocateAutoWorkspace` IPC：用 `rt.agents` / `rt.profiles`。单测只登记 `agents`（`makeRuntime` 的 `profiles` 写死空 Map）。没有 `general` 时在该测试的 `makeRuntime` 里登记一个空 agent。

- [ ] **Step 5: Run IPC tests**

Run: `pnpm exec vitest run apps/desktop/test/ipc.test.ts`
Expected: PASS。仓库根不得出现新的 `Sparkii*` 目录。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/workflow.ts apps/desktop/test/ipc.test.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "feat(desktop): Documents workspaces and chooseWorkspace defaultPath"
```

---

### Task 4: Preload API

**Files:**
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Test: `apps/desktop/test/preload-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  allocateAutoWorkspace(agentId: string): Promise<{ workspacePath: string }>;
  chooseWorkspace(opts?: { defaultPath?: string }): Promise<{ path?: string }>;
  ```
  `DraftPromptContext.workspaceKind?: 'auto' | 'user'`。不增加 `openWorkspace`。

- [ ] **Step 1: Write the failing test**

`preload-api.test.ts` 的方法名单加入 `'allocateAutoWorkspace'`。现有 `'chooseWorkspace'` 保留。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/preload-api.test.ts`
Expected: FAIL（名单多了 `allocateAutoWorkspace`，实现没有）。

- [ ] **Step 3: Write minimal implementation**

`api-types.ts` 的 `SparkiiApi` 增加 `allocateAutoWorkspace`；`chooseWorkspace` 补可选参数。

`api.ts`：

```ts
allocateAutoWorkspace: (agentId) => invoke('allocateAutoWorkspace', agentId) as Promise<{ workspacePath: string }>,
chooseWorkspace: (opts) => invoke('chooseWorkspace', opts) as Promise<{ path?: string }>,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run apps/desktop/test/preload-api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/preload/api.ts apps/desktop/electron/preload/api-types.ts apps/desktop/test/preload-api.test.ts
git commit -m "feat(preload): allocateAutoWorkspace and chooseWorkspace defaultPath"
```

---

### Task 5: ChatComposer 保持原来一个按钮

**Files:** 通常不改。若有人已拆 props，改回去。

- Test: `apps/desktop/test/chat-composer.test.tsx`
- Test: `apps/desktop/test/chat-composer-toolbar.test.tsx`

**Interfaces:** 保持现有 `onChooseWorkspace()`。禁止 `onOpenWorkspace` / `onChangeWorkspace` / `workspace-change`。

- [ ] **Step 1: Confirm existing tests still describe one button**

现有「点击 `composer-workspace` → `onChooseWorkspace`」测试保留。`hideWorkspace` 只断言这一个按钮不在。不要写「主按钮打开 / 次按钮更换」测试。

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run apps/desktop/test/chat-composer.test.tsx apps/desktop/test/chat-composer-toolbar.test.tsx apps/desktop/test/ui-chat-patterns.test.tsx`
Expected: PASS。`rg "workspace-change|openWorkspace|onOpenWorkspace|onChangeWorkspace" packages/ui apps/desktop/src apps/desktop/agents` 无匹配。

- [ ] **Step 3: Commit only if files changed**

无改动则不提交。

---

### Task 6: 通用聊天草稿分配路径；按钮仍是选文件夹

**Files:**
- Modify: `apps/desktop/src/surface/standard-chat.tsx`
- Test: `apps/desktop/test/standard-chat.test.tsx`

**Interfaces:**
- Consumes: `allocateAutoWorkspace`、`chooseWorkspace`、`setChatWorkspace`
- Produces: 草稿（`!sessionId`）挂载时分配一次；`promptSession` context 带该 `workspacePath`；单击仍 `chooseWorkspace({ defaultPath: 当前路径 })`

- [ ] **Step 1: Write the failing tests**

```ts
it('allocates a workspace path for a new draft and chooses from that folder', async () => {
  const allocateAutoWorkspace = vi.fn().mockResolvedValue({ workspacePath: 'C:/Users/x/Documents/Sparkii/workspaces/general/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const chooseWorkspace = vi.fn().mockResolvedValue({});
  api.allocateAutoWorkspace = allocateAutoWorkspace;
  api.chooseWorkspace = chooseWorkspace;
  render(<StandardChatSurface {...draftProps} />);
  expect(await screen.findByTestId('workspace-path')).toHaveTextContent('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  fireEvent.click(screen.getByTestId('composer-workspace'));
  await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledWith({
    defaultPath: 'C:/Users/x/Documents/Sparkii/workspaces/general/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  }));
});

it('allocates a new path when sessionId becomes null', async () => {
  const allocateAutoWorkspace = vi.fn()
    .mockResolvedValue({ workspacePath: 'C:/docs/Sparkii/workspaces/general/id-new' });
  api.allocateAutoWorkspace = allocateAutoWorkspace;
  api.getChatSession = vi.fn().mockResolvedValue({ workspacePath: 'C:/docs/Sparkii/workspaces/general/old' });
  const { rerender } = render(<StandardChatSurface {...draftProps} sessionId="old" />);
  expect(allocateAutoWorkspace).not.toHaveBeenCalled();
  rerender(<StandardChatSurface {...draftProps} sessionId={null} />);
  expect(await screen.findByTestId('workspace-path')).toHaveTextContent('id-new');
  expect(allocateAutoWorkspace).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('workspace-path').textContent).not.toContain('old');
});
```

禁止 `draft.epoch`。`App.draft` 是 boolean。锁定：`sessionId` 变为 `null` 时重新 allocate；从 `null` 挂载也分配；有 `sessionId` 时只信 `getChatSession`。首条 prompt context 带 `workspaceKind: 'auto' | 'user'`。取消选文件夹则路径不变。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/desktop/test/standard-chat.test.tsx -t "allocates a workspace"`
Expected: FAIL。

- [ ] **Step 3: Implement standard-chat**

该 effect 必须写在 `standard-chat.tsx` 现有 reset effect（约 457 行，`setWorkspacePath(null)` 且 `!sessionId` 早退）**之后**，顺序上先清空再分配。

```ts
useEffect(() => {
  if (sessionId) return;
  let cancelled = false;
  void Promise.resolve(api.allocateAutoWorkspace?.(agent.id)).then((r) => {
    if (!cancelled && r?.workspacePath) {
      setWorkspacePath(r.workspacePath);
      setWorkspaceKind('auto');
    }
  }).catch(() => {});
  return () => { cancelled = true; };
}, [agent.id, sessionId]);
```

`allocateAutoWorkspace?.` 必须可选调用：未 mock 的测试挂载草稿时不得抛 `TypeError`。

单击仍走原来的选文件夹（allocate 后为 `'auto'`，用户选出另一条路径后为 `'user'`）：

```ts
const onChooseWorkspace = () => {
  void api.chooseWorkspace({ defaultPath: workspacePath ?? undefined }).then(({ path } = {}) => {
    if (!path) return;
    setWorkspacePath(path);
    setWorkspaceKind('user');
    if (sessionId) void api.setChatWorkspace(sessionId, path);
  });
};
```

`promptSession` 草稿 context：`{ profileId: agent.id, workspacePath, workspaceKind, model, thinkingLevel }`。

`ChatComposer` 继续接 `onChooseWorkspace`。不调用 `openWorkspace`。

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/desktop/test/standard-chat.test.tsx apps/desktop/test/standard-chat-knowledge.test.tsx apps/desktop/test/knowledge-citations.test.tsx apps/desktop/test/general-surface.test.tsx apps/desktop/test/app-general.test.tsx apps/desktop/test/approval-shell.test.tsx`
Expected: PASS。给测试 api mock 补上 `allocateAutoWorkspace: async () => ({ workspacePath: 'C:/ws' })`（`app-general.test.tsx` / `approval-shell.test.tsx` 手写 `window.sparkii` 也必须能挂载：可选链 + 或补 stub）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/surface/standard-chat.tsx apps/desktop/test/standard-chat.test.tsx apps/desktop/test/standard-chat-knowledge.test.tsx apps/desktop/test/knowledge-citations.test.tsx apps/desktop/test/general-surface.test.tsx apps/desktop/test/app-general.test.tsx apps/desktop/test/approval-shell.test.tsx
git commit -m "feat(chat): allocate per-draft workspace and pass it as choose defaultPath"
```

---

### Task 7: 合同审核每 session 新路径；按钮仍是选文件夹

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Test: `apps/desktop/test/contract-surface.test.tsx`

**Interfaces:**
- Consumes: `allocateAutoWorkspace`、`chooseWorkspace`、`setChatWorkspace`
- Produces: `sessionId == null` 时分配并显示；`sessionId` 变化为 `null` 时丢掉 `runPrefs` 并再分配；`data-testid="workspace"` 仍调 `chooseWorkspace({ defaultPath })`；`startWorkflow` 带当前显示路径

- [ ] **Step 1: Write the failing tests**

保留「click workspace then start」：点 `workspace` 仍是选文件夹，但必须带上当前 `defaultPath`。

新增：

```ts
it('does not reuse a stale session.meta workspace after newSession', async () => {
  const allocateAutoWorkspace = vi.fn()
    .mockResolvedValue({ workspacePath: 'C:/docs/Sparkii/workspaces/contract-review/ws-new' });
  (window as any).sparkii = {
    getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
    allocateAutoWorkspace,
    chooseWorkspace: async () => ({}),
    on: () => () => {},
  };
  const startWorkflow = vi.fn();
  const stale = {
    entries: [], streaming: false, status: 'idle' as const,
    meta: { currentStep: null, workspacePath: 'C:/docs/Sparkii/workspaces/contract-review/ws-old' },
  };
  const actions = { ...makeActions(), startWorkflow, chooseDocument: vi.fn().mockResolvedValue({ path: 'C:/tmp/a.pdf' }) };
  const { rerender } = render(
    <ContractAgentSurface agent={agent} sessionId="s-old" mode="live" session={stale} actions={actions} />,
  );
  expect(allocateAutoWorkspace).not.toHaveBeenCalled();
  rerender(
    <ContractAgentSurface agent={agent} sessionId={null} mode="live" session={stale} actions={actions} />,
  );
  expect(await screen.findByTestId('workspace')).toHaveTextContent('ws-new');
  expect(allocateAutoWorkspace).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('upload'));
  await screen.findByTestId('remove-document');
  fireEvent.click(screen.getByTestId('review'));
  await waitFor(() => expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
    workspacePath: 'C:/docs/Sparkii/workspaces/contract-review/ws-new',
    workspaceKind: 'auto',
  })));
});

it('opens the folder picker at the displayed workspace', async () => {
  const chooseWorkspace = vi.fn().mockResolvedValue({});
  (window as any).sparkii = {
    getModelOptions: async () => ({ models: [], defaultModel: null, provider: 'deepseek' }),
    allocateAutoWorkspace: async () => ({ workspacePath: 'C:/docs/Sparkii/workspaces/contract-review/ws-1' }),
    chooseWorkspace,
    on: () => () => {},
  };
  render(<ContractAgentSurface agent={agent} sessionId={null} mode="live" session={emptySession} actions={makeActions()} />);
  await screen.findByText('ws-1');
  fireEvent.click(screen.getByTestId('workspace'));
  await waitFor(() => expect(chooseWorkspace).toHaveBeenCalledWith({
    defaultPath: 'C:/docs/Sparkii/workspaces/contract-review/ws-1',
  }));
});
```

`startWorkflow` 测试：不点选文件夹时，payload.workspacePath 等于分配结果（`ws-1`），不是 `undefined`、也不是上一条。点选文件夹并选中后才变成用户路径。

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run apps/desktop/test/contract-surface.test.tsx -t "workspace"`
Expected: FAIL。

- [ ] **Step 3: Implement contract surface**

禁止假设 remount。侧栏「新会话」只调 `openNew`（`sessionId` A→null），**不一定**走 `startNewSession`。因此 `runPrefs` 清空必须写在与 bar 相同的 **leave 路径**（`sessionId` 非空→`null`），不能只写在 `startNewSession` 点击里。`startNewSession` / `resetDraft` 仍应清文件草稿，并顺带清 `runPrefs`。

`ModelEffortBar`：

- `sessionId` 从非空变 `null`：先 `setWorkspacePath(null)`，再 `void Promise.resolve(api.allocateAutoWorkspace?.(agentId)).then(...)`。未 mock 不得抛 `TypeError`。
- `sessionId == null`：**禁止** `setWorkspacePath(session.meta.workspacePath)`。
- `sessionId` 有值：只跟 `getChatSession` / `session.meta.workspacePath`。
- 单击 `workspace`：`chooseWorkspace({ defaultPath: workspacePath })`（按钮可点时路径已在）。取消不改；选出另一条则 `workspaceKind='user'`。

`SparkiiWindowApi` 补 `allocateAutoWorkspace` / `chooseWorkspace(opts?)`。不补 `openWorkspace`。

所有 idle-draft 测试必须 mock `allocateAutoWorkspace`（稳定路径）。`contract-surface.test.tsx` 现有 `sessionId={null}` 约在 48、285、327、348、465、679、695、722、757、785、821 行；`app-workflow.test.tsx` 凡挂 `ContractAgentSurface` / 合同 AgentFrame 的同样补 mock。

`startWorkflow` 带 `workspacePath` 与 `workspaceKind`。导出 `path` 必须是 `reportExportPath(当前工作区, title)`。

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/desktop/test/contract-surface.test.tsx apps/desktop/test/app-workflow.test.tsx`
Expected: PASS。给其它合同测试的 `window.sparkii` 补 `allocateAutoWorkspace`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/agents/contract-review/surface/index.tsx apps/desktop/test/contract-surface.test.tsx apps/desktop/test/app-workflow.test.tsx
git commit -m "feat(contract): per-session Documents workspace with choose defaultPath"
```

---

### Task 8: 全量回归与桌面泄漏检查

**Files:** 无新文件（只跑测试、确认 `ipc.ts` 无 `autoWorkspacePath`）。

- [ ] **Step 1: Grep production imports（必做，不是可选）**

Run: `rg "autoWorkspacePath|getPath\\('desktop'\\)|workspacePath \\?\\? join\\(rt.dataDir" apps/desktop/electron packages/ui apps/desktop/src apps/desktop/agents --glob "!**/*.test.*"`
Expected: 生产无匹配（含 `workflow.ts` 不得再 `workspacePath ?? join(rt.dataDir, 'sessions', sessionId)`）。有匹配则本任务失败。

- [ ] **Step 2: Run the named vitest set**

Run:

```text
pnpm exec vitest run apps/desktop/test/workspace.test.ts packages/connectors/test/report.test.ts apps/desktop/test/preload-api.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/contract-surface.test.tsx apps/desktop/test/standard-chat.test.tsx apps/desktop/test/chat-composer.test.tsx apps/desktop/test/chat-composer-toolbar.test.tsx
```

Expected: PASS。

- [ ] **Step 3: Confirm repo root has no new Sparkii* folders**

Expected: 仓库根没有 `Sparkii` + 4 字符 + 12 位数字的目录。

- [ ] **Step 4: Commit only if Step 1–3 改动了文件**（例如漏网 import）。否则不空提交。
