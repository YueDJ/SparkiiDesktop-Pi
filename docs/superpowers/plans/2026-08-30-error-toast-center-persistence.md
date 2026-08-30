# 报错统一展示、报错中心与持久化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将分散的报错统一为「右上角 toast + 顶栏抽屉报错中心」，并持久化最近 30 天、未读状态可持久化。

**Architecture:** 主进程新增 SQLite `ErrorStore` 并通过 IPC 暴露；渲染层在 `packages/ui` 新增 `ErrorProvider`/`useErrors`/`ErrorToaster`/`ErrorCenterPanel`，`App` 拆两层接入 Provider，各 surface 的 `setError` 改为 `reportError`。

**Tech Stack:** TypeScript、React 19、better-sqlite3、Electron IPC、vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-08-30-error-toast-center-persistence.md`

## Global Constraints

- 只做 `error`，不做 `warning`。
- 保留策略：`created_at < now - 30*24*3600*1000` 即删除；`append` 与 `list` 时都执行。
- toast 位置：`top: 56px; right: 16px`；自动消失 5000ms；悬停暂停。
- 未读角标 = `read === 0` 条数；打开抽屉不清零，仅 `markAllRead` 清零。
- `useErrors()` 无 Provider 时返回稳定 no-op 单例，不抛错。

---

### Task 1: 主进程 ErrorStore

**Files:**
- Create: `apps/desktop/electron/main/error-store.ts`
- Test: `apps/desktop/test/error-store.test.ts`

**Interfaces:**
- Produces: `ErrorEvent`、`ErrorStore`（`append / list / clearOne / clear / markAllRead / close`）

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/error-store.test.ts`（参考 `chat-session-store.test.ts`，用 `mkdtempSync` 临时目录）：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ErrorStore } from '../electron/main/error-store.js';

function store(now?: () => number) {
  return new ErrorStore(join(mkdtempSync(join(tmpdir(), 'errors-')), 'errors.db'), now ? { now } : undefined);
}

describe('ErrorStore', () => {
  it('appends, lists newest-first, and keeps read state', () => {
    const s = store();
    s.append({ id: 'e1', message: 'a', source: '通用智能体', createdAt: 1 });
    s.append({ id: 'e2', message: 'b', source: '运行中心', createdAt: 2 });
    expect(s.list().map((r) => r.id)).toEqual(['e2', 'e1']);
    expect(s.list()[0]).toMatchObject({ id: 'e2', read: false });
    s.markAllRead();
    expect(s.list().every((r) => r.read)).toBe(true);
    s.close();
  });
  it('clears one or all', () => {
    const s = store();
    s.append({ id: 'e1', message: 'a', source: 'x', createdAt: 1 });
    s.append({ id: 'e2', message: 'b', source: 'x', createdAt: 2 });
    s.clearOne('e1');
    expect(s.list().map((r) => r.id)).toEqual(['e2']);
    s.clear();
    expect(s.list()).toEqual([]);
    s.close();
  });
  it('prunes records older than 30 days on append and list', () => {
    const now = 1_000_000;
    const s = store(() => now);
    s.append({ id: 'old', message: 'old', source: 'x', createdAt: now - 31 * 24 * 3600 * 1000 });
    s.append({ id: 'new', message: 'new', source: 'x', createdAt: now });
    expect(s.list().map((r) => r.id)).toEqual(['new']);
    s.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**：`pnpm vitest run apps/desktop/test/error-store.test.ts`（模块缺失）
- [ ] **Step 3: 最小实现** `apps/desktop/electron/main/error-store.ts`

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ErrorEvent {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}

type Row = { id: string; message: string; source: string; created_at: number; read: number };

function toEvent(row: Row): ErrorEvent {
  return { id: row.id, message: row.message, source: row.source, createdAt: row.created_at, read: !!row.read };
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ErrorStore {
  private db: Database.Database;
  private now: () => number;

  constructor(dbPath: string, opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS error_events (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at)');
    this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM error_events WHERE created_at < ?').run(this.now() - RETENTION_MS);
  }

  append(rec: { id: string; message: string; source: string; createdAt: number }): ErrorEvent {
    this.prune();
    this.db.prepare(
      'INSERT INTO error_events (id, message, source, created_at, read) VALUES (@id, @message, @source, @createdAt, 0)',
    ).run(rec);
    return { ...rec, read: false };
  }

  list(limit = 500): ErrorEvent[] {
    this.prune();
    const rows = this.db.prepare(
      'SELECT id, message, source, created_at, read FROM error_events ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as unknown as Row[];
    return rows.map(toEvent);
  }

  clearOne(id: string): void {
    this.db.prepare('DELETE FROM error_events WHERE id = ?').run(id);
  }

  clear(): void {
    this.db.prepare('DELETE FROM error_events').run();
  }

  markAllRead(): void {
    this.db.prepare('UPDATE error_events SET read = 1').run();
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交**：`git add apps/desktop/electron/main/error-store.ts apps/desktop/test/error-store.test.ts && git commit -m "feat(desktop): add persisted error store"`

### Task 2: Runtime 接入 ErrorStore

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`

**Interfaces:**
- Consumes: `ErrorStore`
- Produces: `Runtime.errors: ErrorStore`

- [ ] **Step 1:** `Runtime` 接口加 `errors: ErrorStore;`，导入 `ErrorStore`。
- [ ] **Step 2:** `assemble` 中实例化 `const errors = new ErrorStore(join(opts.dataDir, 'errors.db'));`，返回对象加 `errors`。
- [ ] **Step 3:** `pnpm -C apps/desktop typecheck` 通过。
- [ ] **Step 4: 提交**

### Task 3: IPC handler 与 preload API

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`

**Interfaces:**
- Consumes: `Runtime.errors`
- Produces: `SparkiiApi.listErrors/appendError/clearError/clearErrors/markAllErrorsRead`

- [ ] **Step 1:** `ipc.ts` 在 `registerIpc` 内注册：

```ts
ipcMain.handle('sparkii:listErrors', () => rt.errors.list());
ipcMain.handle('sparkii:appendError', (_e, rec: { id: string; message: string; source: string; createdAt: number }) => rt.errors.append(rec));
ipcMain.handle('sparkii:clearError', (_e, id: string) => { rt.errors.clearOne(id); return { ok: true }; });
ipcMain.handle('sparkii:clearErrors', () => { rt.errors.clear(); return { ok: true }; });
ipcMain.handle('sparkii:markAllErrorsRead', () => { rt.errors.markAllRead(); return { ok: true }; });
```

- [ ] **Step 2:** `api-types.ts` 加：

```ts
export interface ErrorRecord {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}
```

并在 `SparkiiApi` 加：

```ts
listErrors(): Promise<ErrorRecord[]>;
appendError(rec: { id: string; message: string; source: string; createdAt: number }): Promise<ErrorRecord>;
clearError(id: string): Promise<{ ok: boolean }>;
clearErrors(): Promise<{ ok: boolean }>;
markAllErrorsRead(): Promise<{ ok: boolean }>;
```

- [ ] **Step 3:** `preload/api.ts` 导入 `ErrorRecord` 并加实现：

```ts
listErrors: () => invoke('listErrors') as Promise<ErrorRecord[]>,
appendError: (rec) => invoke('appendError', rec) as Promise<ErrorRecord>,
clearError: (id) => invoke('clearError', id) as Promise<{ ok: boolean }>,
clearErrors: () => invoke('clearErrors') as Promise<{ ok: boolean }>,
markAllErrorsRead: () => invoke('markAllErrorsRead') as Promise<{ ok: boolean }>,
```

- [ ] **Step 4:** `pnpm -C apps/desktop typecheck`。
- [ ] **Step 5: 提交**

### Task 4: UI 错误中心（Provider / Hook / Toaster / Panel）

**Files:**
- Create: `packages/ui/src/patterns/ErrorCenter.tsx`
- Test: `apps/desktop/test/error-center.test.tsx`

**Interfaces:**
- Produces: `ErrorRecord`、`ErrorStoreAdapter`、`createMemoryErrorStore`、`ErrorProvider`、`useErrors`、`ErrorToaster`、`ErrorCenterPanel`

- [ ] **Step 1: 写失败测试**（覆盖：reportError 进列表、未读计数、markAllRead、clearAll、toast 显示；用 `vi.useFakeTimers` 验证 5 秒消失）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 最小实现** `packages/ui/src/patterns/ErrorCenter.tsx`

关键接口：

```ts
export interface ErrorRecord {
  id: string;
  message: string;
  source: string;
  createdAt: number;
  read: boolean;
}

export interface ErrorStoreAdapter {
  load(): Promise<ErrorRecord[]>;
  append(rec: Omit<ErrorRecord, 'read'>): Promise<ErrorRecord>;
  clearOne(id: string): Promise<void>;
  clearAll(): Promise<void>;
  markAllRead(): Promise<void>;
}

export function createMemoryErrorStore(): ErrorStoreAdapter {
  let records: ErrorRecord[] = [];
  return {
    load: async () => records,
    append: async (rec) => { const r = { ...rec, read: false }; records = [r, ...records]; return r; },
    clearOne: async (id) => { records = records.filter((r) => r.id !== id); },
    clearAll: async () => { records = []; },
    markAllRead: async () => { records = records.map((r) => ({ ...r, read: true })); },
  };
}
```

`useErrors()` 无 Provider 时返回 `NOOP`（`records: [], unreadCount: 0, reportError/clearOne/clearAll/markAllRead 均为 no-op`）。

`ErrorProvider` 内部：
- `records` state；启动 `store.load()` 灌入。
- `reportError(message, { source = '通用智能体' })`：本地生成 `crypto.randomUUID()` + `createdAt = Date.now()`，先 `setRecords` + `setToast`，再异步 `store.append`（`.catch` 忽略）。
- `unreadCount = records.filter(r => !r.read).length`。
- `clearOne / clearAll / markAllRead`：乐观更新 + 异步 `store.*`。
- 渲染 `{children}` + `<ErrorToaster />`。

`ErrorToaster`：`useEffect` 在 `toast` 变化时启动 5 秒计时器，悬停暂停，显示 `role="alert"`，右上角定位。

`ErrorCenterPanel`：倒序列出 `records`，含时间、来源、文案；按钮「全部标为已读」「全部清空」；单条删除。

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交**

### Task 5: 导出 + Shell 入口 + 样式

**Files:**
- Modify: `packages/ui/src/index.ts`
- Modify: `packages/ui/src/patterns/Shell.tsx`
- Modify: `packages/ui/src/styles.css`

- [ ] **Step 1:** `index.ts` 加 `export * from './patterns/ErrorCenter.js';`
- [ ] **Step 2:** `Shell.tsx`：
  - `import { WarningIcon }`（已有）。
  - `DrawerKind` 加 `'errors'`。
  - 顶栏右侧、审批按钮旁加 `<IconButton label="报错中心" onClick={() => openDrawer('errors')}><WarningIcon />{unreadCount > 0 && <Badge>{unreadCount}</Badge>}</IconButton>`；`Shell` 内 `const { unreadCount } = useErrors();`。
  - 底部加 `<Drawer open={drawer === 'errors'} title="报错中心" onClose={closeDrawer}><ErrorCenterPanel /></Drawer>`。
- [ ] **Step 3:** `styles.css` 加：

```css
.ui-error-toast { position: fixed; top: 56px; right: 16px; z-index: var(--z-toast); display: flex; gap: var(--spacing-xs); align-items: flex-start; max-width: 360px; background: var(--color-riskBg); color: var(--color-risk); border: 1px solid var(--color-riskBorder); border-radius: var(--radius-card); padding: var(--spacing-sm) var(--spacing-md); box-shadow: var(--shadow-overlay); animation: ui-error-in var(--motion-fast) var(--motion-ease); }
.ui-error-toast-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ui-error-toast-close { border: none; background: none; color: inherit; cursor: pointer; }
.ui-error-center-row { display: flex; gap: var(--spacing-sm); padding: var(--spacing-xs) 0; border-bottom: 1px dashed var(--color-border); }
.ui-error-center-main { flex: 1; min-width: 0; }
.ui-error-center-meta { color: var(--color-textMuted); font-size: var(--font-size-xs); }
@keyframes ui-error-in { from { transform: translateX(8px); opacity: 0; } to { transform: none; opacity: 1; } }
```

- [ ] **Step 4:** `pnpm -C packages/ui typecheck`。
- [ ] **Step 5: 提交**

### Task 6: App 拆两层并接入 Provider

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1:** 导入 `ErrorProvider`、`useErrors`、`type ErrorStoreAdapter`、`type SparkiiApi`。
- [ ] **Step 2:** 新增 `makeErrorStore(api)` 适配器。
- [ ] **Step 3:** `App` 改为渲染 `<ErrorProvider store={makeErrorStore(window.sparkii)}><AppShell /></ErrorProvider>`；原 `App` 函数体更名为 `AppShell`，内部 `const { reportError } = useErrors();`。
- [ ] **Step 4:** 删除 `globalError` state 与其渲染；`workflow_failed` 处理中加 `reportError(e.error?.message ?? '审核失败', { source: '合同审核' })`。
- [ ] **Step 5:** `pnpm -C apps/desktop typecheck`。
- [ ] **Step 6: 提交**

### Task 7: GeneralChatSurface 收口

**Files:**
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`

- [ ] **Step 1:** 移除 `error` state，改为 `const { reportError } = useErrors();`。
- [ ] **Step 2:** 所有 `setError(...)` → `reportError(..., { source: '通用智能体' })`；`setError('')` 删除。
- [ ] **Step 3:** 删除 composer 上方 `{error && <div className="chat-error" ...>}`。
- [ ] **Step 4:** `pnpm -C apps/desktop typecheck`。
- [ ] **Step 5: 提交**

### Task 8: RuntimeCenter 收口

**Files:**
- Modify: `packages/ui/src/patterns/RuntimeCenter.tsx`

- [ ] **Step 1:** 移除 `error` state，`const { reportError } = useErrors();`。
- [ ] **Step 2:** `catch` 里 `reportError(msg, { source: '运行中心' })`；删除内联 `.ui-error` 渲染。
- [ ] **Step 3:** `pnpm -C packages/ui typecheck`。
- [ ] **Step 4: 提交**

### Task 9: SettingsView 收口

**Files:**
- Modify: `apps/desktop/src/shell/SettingsView.tsx`

- [ ] **Step 1:** `const { reportError } = useErrors();`。
- [ ] **Step 2:** 错误分支改为 `reportError`（`source: '系统设置'`）并保留 `setInfo`/`connStatus` 的持续状态：
  - `setInfo('配置加载失败')` → 追加 `reportError('配置加载失败', { source: '系统设置' })`
  - `setInfo('拉取失败：…')` → 追加 `reportError('拉取失败：…', ...)`
  - `setInfo('测试失败')` → 追加 `reportError(probeError(r) …)`
  - `IPC 未连接` 三个守卫 → `reportError`
  - `save` 加 try/catch，失败 `reportError`
- [ ] **Step 3:** `pnpm -C apps/desktop typecheck`。
- [ ] **Step 4: 提交**

### Task 10: ChatWorkbench 与 WorkflowStatus 收口

**Files:**
- Modify: `apps/desktop/src/workbench/ChatWorkbench.tsx`
- Modify: `apps/desktop/src/workbench/WorkflowStatus.tsx`

- [ ] **Step 1:** `ChatWorkbench` 移除 `error` state，`reportError(String(...), { source: '通用智能体' })`，删除内联 alert。
- [ ] **Step 2:** `WorkflowStatus` 增加 `useEffect`，当 `state.status === 'failed'` 且 `state.error` 存在时 `reportError(state.error, { source: '合同审核' })`（注意用 ref 防重复上报）。
- [ ] **Step 3:** `pnpm -C apps/desktop typecheck`。
- [ ] **Step 4: 提交**

### Task 11: 更新现有测试

**Files:**
- Modify: `apps/desktop/test/app-general.test.tsx`
- Modify: `apps/desktop/test/general-chat-surface.test.tsx`
- Modify: `apps/desktop/test/chat-workbench.test.tsx`

- [ ] **Step 1:** `app-general` 的 `makeApi` 增加 `listErrors/appendError/clearError/clearErrors/markAllErrorsRead` mock；错误用例断言改为 toast（`role="alert"` 内容含错误文案）。
- [ ] **Step 2:** `general-chat-surface` 的错误用例用 `<ErrorProvider store={createMemoryErrorStore()}>` 包裹。
- [ ] **Step 3:** `chat-workbench` 两个用例用 `<ErrorProvider store={createMemoryErrorStore()}>` 包裹，错误断言不变。
- [ ] **Step 4: 提交**

### Task 12: 全量验证与修复

- [ ] **Step 1:** `pnpm test`
- [ ] **Step 2:** `pnpm -C apps/desktop typecheck`
- [ ] **Step 3:** `pnpm -C packages/ui typecheck`
- [ ] **Step 4:** `pnpm lint`
- [ ] **Step 5:** 修复失败项后重跑，直到全绿。
- [ ] **Step 6:** 提交收尾。
