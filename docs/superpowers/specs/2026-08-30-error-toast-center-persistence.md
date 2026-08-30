# 报错统一展示、报错中心与持久化 设计说明

日期：2026-08-30
状态：已确认，待实现

## 1. 背景与问题

当前应用的报错展示分散在各处，样式与位置不一致：

- `App.tsx` 在 `<Shell>` 之外渲染 `globalError`，出现在整屏最上方（且该状态目前只有清空、从未被赋值，已半废弃）。
- `GeneralChatSurface.tsx` 用 `.chat-error` 把错误渲染在队列/composer 正上方。
- `ChatWorkbench.tsx` 渲染裸的 `role="alert"` div，无样式。
- `RuntimeCenter.tsx` 用 `.ui-error` 内联显示。
- `SettingsView.tsx` 用 `info`/`connStatus` 状态展示失败信息；`WorkflowStatus.tsx` 内联显示「审核失败」。

需求：

1. 统一报错展示方式与位置。
2. 报错有显示时长，超时自动消失。
3. 所有报错进入「报错中心」，可统一查看。
4. 只做 error 级别，不做 warning。
5. 报错中心持久化（应用重启后仍可查看）。
6. 保留策略：最近 30 天。
7. 未读状态持久化（重启不清零），提供「全部标为已读」。

## 2. 目标与非目标

目标：

- 一个全局错误中心（`ErrorProvider` + `useErrors()`）作为唯一写入入口。
- 统一 toast：右上角、顶栏下方，5 秒自动消失，悬停暂停。
- 顶栏右侧入口（审批按钮旁）+ 未读角标，点击打开右侧抽屉。
- 错误历史落盘 `errors.db`（SQLite），保留 30 天，未读状态持久化。

非目标：

- 不做 warning 级别。
- 不重构与报错无关的现有代码。
- 不改变审批、审计、会话存储的既有行为。

## 3. 交互决策（已确认）

- 报错中心形态：顶栏右侧图标 + 右侧抽屉（与审批/账号抽屉同风格）。
- toast 位置：右上角、顶栏下方（`top: 56px; right: 16px`），从右滑入。
- 自动消失：5 秒；悬停暂停倒计时；手动关闭按钮。
- 级别：仅 `error`。
- 持久化：是；`dataDir/errors.db`；保留 30 天。
- 未读：持久化；角标 = `read === 0` 条数；打开抽屉不清零，仅「全部标为已读」清零。
- 来源标签：`通用智能体 / 运行中心 / 系统设置 / 合同审核`。

## 4. 架构

错误中心是一个 React Context，置于 `packages/ui`（`RuntimeCenter` 与桌面端都能引用）。

- `ErrorProvider`：持有 `records`、`toast`，封装 `reportError / clearOne / clearAll / markAllRead`，并渲染 `ErrorToaster`。通过 `store` 适配器接入持久化。
- `useErrors()`：读取上下文；无 Provider 时返回稳定的 no-op 单例，保证 `Shell` 等组件可独立渲染。
- `ErrorToaster`：读取最新 `toast`，5 秒自动消失，悬停暂停。
- `ErrorCenterPanel`：抽屉内容，倒序列表 + 操作按钮。

持久化在主进程，沿用 `better-sqlite3`（同 `audit.db` / `sessions.db`）：

- `ErrorStore`（`apps/desktop/electron/main/error-store.ts`）。
- 通过 IPC 暴露 `listErrors / appendError / clearError / clearErrors / markAllErrorsRead`。
- preload 增加对应 `SparkiiApi` 方法。

`App.tsx` 拆成两层：外层 `App` 构建 `store` 适配器并包裹 `<ErrorProvider>`，内层 `AppShell` 使用 `useErrors()`。这样 `AppShell` 自身也能上报错误（如 workflow 失败）。

## 5. 数据模型

`ErrorRecord`：

```ts
{
  id: string;
  message: string;
  source: string;
  createdAt: number; // epoch ms
  read: boolean;
}
```

SQLite 表 `error_events`：

```sql
CREATE TABLE IF NOT EXISTS error_events (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at);
```

保留策略：`append` 与 `list` 时删除 `created_at < now - 30*24*3600*1000` 的记录。

## 6. 组件与接口

### 6.1 UI 包（`packages/ui/src/patterns/ErrorCenter.tsx`）

导出：

- `ErrorRecord`
- `ErrorStoreAdapter`（`load/append/clearOne/clearAll/markAllRead`）
- `createMemoryErrorStore()`（内存实现，供测试/默认使用）
- `ErrorProvider`
- `useErrors()`
- `ErrorToaster`
- `ErrorCenterPanel`

`useErrors()` 返回：

```ts
{
  records: ErrorRecord[];
  unreadCount: number;
  reportError(message: string, opts?: { source?: string }): void;
  clearOne(id: string): void;
  clearAll(): void;
  markAllRead(): void;
}
```

### 6.2 主进程（`apps/desktop/electron/main/error-store.ts`）

`ErrorStore` 方法：`append / list / clearOne / clear / markAllRead / close`，内部含 30 天淘汰。

### 6.3 IPC 与 preload

IPC：

- `sparkii:listErrors` → `ErrorRecord[]`
- `sparkii:appendError` → `ErrorRecord`
- `sparkii:clearError` → `{ ok: true }`
- `sparkii:clearErrors` → `{ ok: true }`
- `sparkii:markAllErrorsRead` → `{ ok: true }`

`SparkiiApi` 新增同名方法（`clearError(id)`、其余无参或按上述签名）。

## 7. 改造映射

- `apps/desktop/electron/main/error-store.ts`：新增。
- `apps/desktop/electron/main/runtime.ts`：`Runtime.errors` + 实例化。
- `apps/desktop/electron/main/ipc.ts`：新增 5 个 handler。
- `apps/desktop/electron/preload/api-types.ts`：`ErrorRecord` + 新方法。
- `apps/desktop/electron/preload/api.ts`：新方法实现。
- `packages/ui/src/patterns/ErrorCenter.tsx`：新增。
- `packages/ui/src/index.ts`：导出 `ErrorCenter.js`。
- `packages/ui/src/patterns/Shell.tsx`：顶栏加入口 + 角标 + 抽屉。
- `packages/ui/src/styles.css`：toast 与报错中心列表样式。
- `apps/desktop/src/App.tsx`：拆两层、接入 Provider、移除 `globalError`、workflow 失败上报。
- `apps/desktop/src/surfaces/GeneralChatSurface.tsx`：`setError` → `reportError`，移除内联 `.chat-error`。
- `packages/ui/src/patterns/RuntimeCenter.tsx`：`setError` → `reportError`，移除内联 `.ui-error`。
- `apps/desktop/src/shell/SettingsView.tsx`：错误分支 → `reportError`，保留 `connStatus` 持续状态。
- `apps/desktop/src/workbench/ChatWorkbench.tsx`：`setError` → `reportError`。
- `apps/desktop/src/workbench/WorkflowStatus.tsx`：`failed` 状态在 effect 中上报一次。

## 8. 测试

- `ErrorStore`：append/list/clearOne/clear/markAllRead、30 天淘汰（可注入 now）。
- `ErrorCenter`（ui）：reportError 写入、未读计数、markAllRead、clearAll、toast 5 秒消失（fake timers）。
- IPC：新 handler 注册与行为（如已有 ipc 测试风格）。
- 更新现有断言：`app-general`、`general-chat-surface`、`chat-workbench` 中错误显示改为通过 `ErrorProvider` 包装并断言 toast/中心。

## 9. 验证命令

- `pnpm test`
- `pnpm -C apps/desktop typecheck`
- `pnpm -C packages/ui typecheck`
- `pnpm lint`
