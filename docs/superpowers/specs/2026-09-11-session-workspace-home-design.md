# Session Workspace Home — Design Spec

**Status:** Approved（架构师三审通过；产品更正：工作区仍是一个按钮）  
**Date:** 2026-09-11  
**Amends:**
- `docs/superpowers/specs/2026-08-25-general-agent-design.md` §2 / §7.2（自动工作区不再放桌面 `Sparkii*`）
- `docs/superpowers/specs/2026-09-01-agent-decoupling-and-contract-review-surface-design.md` 决策 7 / Subsystem 6（落地 `Documents/Sparkii/workspaces/...`，并补齐每会话一条路径、选文件夹停在当前目录、懒创建）
- `docs/superpowers/specs/2026-09-05-desktop-e2e-coverage-design.md` G1（桌面仍不得新增 `Sparkii*`；合同审核不再在「开始审核」时 `ensureWorkspaceDir`）

**Does not amend:** 会话锚点 `dataDir/sessions/<sessionId>/`（内部 cwd / Pi JSONL，用户不可见）。

---

## Goal

把「自动工作区」从桌面随机文件夹，改成用户能一眼找到的 `Documents\Sparkii\workspaces\...`，并且：

1. **每个新 session 一条新路径**（合同审核与通用智能体同一规则）。
2. **开始审核 / 纯打开窗口不建目录**。
3. **工作区仍是原来那一个按钮。** 点下去还是系统选文件夹对话框，但必须停在当前显示的那个工作区里（没有目录就先建再打开）。不拆成「打开 + 更换」两个控件。

---

## Background / Current State

| 现状 | 问题 |
| --- | --- |
| `autoWorkspacePath(app.getPath('desktop'), now)` → `桌面/Sparkii<4字符><YYYYMMDDHHmm>` | 污染桌面；开发时 `ipc.test.ts` mock `getPath('')` 还会把相对路径泄到仓库根 |
| `sparkii:runWorkflow` 在开始审核时 `ensureWorkspaceDir` | 空文件夹在审核写出任何文件之前就出现 |
| 合同审核草稿把上一次 `runPrefs.workspacePath` 传进 `startWorkflow` | 新 session 复用启动后第一条审核的工作区 |
| 工作区按钮 = `chooseWorkspace()`，无 `defaultPath` | 点下去不是进入显示中的目录，而是系统上次用过的位置 |
| `defaultWorkspacePath(documents, agentId, sessionId)` 已实现 | 生产创建点未调用 |

内部锚点已经在 `%LOCALAPPDATA%\SparkiiDesktop\data\sessions\<id>\`，本规格不改它。

---

## Confirmed Decisions

1. **自动工作区根固定为用户文档下的 Sparkii 主文件夹。**  
   `join(app.getPath('documents'), 'Sparkii', 'workspaces', agentId, workspaceKey)`  
   Windows 即 `Documents\Sparkii\workspaces\<agentId>\<workspaceKey>\`。
2. **`workspaceKey` 在「新 session」诞生时分配，之后不再改名。** 用短的星火物名 `形容词-名词-3位`（如 `glow-fox-k7m`），不用 UUID。不等于、也不重命名为 Pi `sessionId`（草稿阶段还没有 Pi id；改名会丢用户已放进去的文件）。
3. **每个新 session 必须分配一条新的自动路径。** 禁止复用上一条 session、禁止应用级单例工作区。历史 session 打开时只读自己入库的 `workspacePath`。
4. **路径先显示、后落盘。** 分配路径不 `mkdir`。创建只发生在「第一次碰到」：点工作区按钮、导出报告、附件物化、已批准的写工具。
5. **「开始审核」不是第一次碰到。** `runWorkflow` 禁止 `ensureWorkspaceDir`。审核过程写在 Pi JSONL，不预建用户工作区。
6. **工作区按钮保持原形态（一个）。** 单击仍是 `chooseWorkspace`。Main 先对绝对 `defaultPath` `ensureWorkspaceDir`，再 `showOpenDialog({ defaultPath })`，让对话框进到当前显示的目录。取消则路径不变；选了别的目录则 `workspaceKind='user'`。不新增 `openWorkspace` / `shell.openPath` 按钮，不拆次要按钮。
7. **草稿在按钮可点之前必须已经 allocate**，因此 `defaultPath` 在可点时非空。Renderer 不得自己拼 Documents 根。
8. **清空 / 恢复自动工作区**（`setChatWorkspace(null)`）再分配一条**新的**自动路径，父目录仍是 Documents，不是桌面。
9. **同一套公式，禁止按 agent id 分支。** 知识问答继续 `hideWorkspace`，但仍按同一公式在 Main 侧给会话记账（附件/写工具需要根）；界面不画按钮。
10. **生产代码删除对 `autoWorkspacePath` / `app.getPath('desktop')` 的工作区调用。** 桌面不再出现自动 `Sparkii*`。

---

## Path Model

```text
用户可见工作区（本规格）
  Documents/Sparkii/workspaces/<agentId>/<workspaceKey>/

会话锚点（已有，不改）
  %LOCALAPPDATA%/SparkiiDesktop/data/sessions/<piSessionId>/
```

| 字段 | 规则 |
| --- | --- |
| `workspaceKind` | `auto` 默认；用户选目录后为 `user` |
| `workspacePath` | 绝对路径；草稿阶段就有；写入 `chat_sessions` 后不可因 Pi id 变更而改 |
| `workspaceKey` | 星火物名 `adj-noun-tag`（如 `glow-fox-k7m`）；只用于拼自动路径最后一段 |

`defaultWorkspacePath(documents, agentId, workspaceKey)` 是唯一拼装函数。新增 `allocateAutoWorkspace(documents, agentId)`：生成 key + 调用前者。两者都不 `mkdir`。

Renderer 不得自己 `join` 文档路径。一律问 Main：`sparkii:allocateAutoWorkspace(agentId)`。

---

## Session Lifecycle

### 新 session（`sessionId == null` 的草稿）

进入「新会话」时（合同审核点新会话、通用智能体空草稿、导航到某 agent 的新 live）：

1. 丢掉上一条的 `runPrefs.workspacePath` / Composer 工作区 state。
2. 调用 `allocateAutoWorkspace(agentId)`，把返回路径显示在工作区按钮上。
3. 不建目录。

**App 不会在「新会话」时 remount 表面**（`AgentFrame` 的 `key` 是 `agent.id`；`openNew` 只把 `sessionId` 置 `null`）。禁止用 remount / `draft.epoch` 当重置手段。

必须在**同一实例**上：

1. `sessionId` 从非空变为 `null`（含合同审核 `startNewSession` / `actions.newSession`）时，先把 bar + `runPrefs` **同步**设成 `{ workspacePath: null, model: null, thinkingLevel: null }`，**再** `allocateAutoWorkspace`。
2. `sessionId == null` 时禁止用 `session.meta.workspacePath` 初始化或回写（历史 props 会脏）。
3. 同一次 `sessionId == null` 的纯重渲染不得再分配。
4. `sessionId` 非空：只信 `getChatSession` / 入库路径。

### 草稿变成真 session

- **通用 / 知识问答：** `promptSession(null, ...)` 必须把草稿 `workspacePath` 和 `workspaceKind`（`auto` | `user`）放进 context。Main 有 context 路径就用它并按 kind 入库；没有才 `allocateAutoWorkspace` 且 `kind='auto'`。
- **合同审核：** `startWorkflow({ workspacePath, workspaceKind })` 必须带上草稿已显示的路径。IPC **不得**再算桌面路径。未带路径时唯一兜底是 `allocateAutoWorkspace(profileId)`（Documents）。**不 mkdir。** `workflow.ts` 禁止再 fallback 到 `dataDir/sessions/<id>`；缺路径就按上面兜底或抛错，不得写锚点当工作区。

真 session 创建后路径不变。Pi `sessionId` 只用于锚点和会话库主键。

### 打开历史 session

`getChatSession` / `openChatSession` 的 `workspacePath` 是权威。禁止用「应用启动时那一条」覆盖。

### 用户更换工作区

同一个工作区按钮 → `chooseWorkspace({ defaultPath: 当前路径 })`。取消不改；选出另一条路径则 `setChatWorkspace` / 草稿 prefs，`workspaceKind='user'`。不自动删旧自动目录。

---

## When the directory is created

| 事件 | mkdir？ |
| --- | --- |
| 启动应用 | 否 |
| 新 session / 显示路径 | 否 |
| 开始审核 / 首条纯问答（无附件） | 否 |
| 单击工作区按钮（选文件夹，带当前 defaultPath） | 是（先建再打开对话框；取消后空目录可留在 `Documents/Sparkii/workspaces/…`，本期不清理） |
| 导出报告（`report.export` 写入 `workspacePath`） | 是（写文件前） |
| 附件物化 | 是（已有 `stageAttachments`） |
| 已批准的 bash 写 / edit / write | 是（已有 `general-executor`） |
| 只读工具且目录不存在 | 否（保持 `WORKSPACE_NOT_CREATED`） |

`ensureWorkspaceDir` 只许出现在上表「是」的实现里。禁止出现在 `runWorkflow` 开头。

`chooseWorkspace` 的 `defaultPath` 若不是绝对路径，不 mkdir，对话框不带 `defaultPath`。

---

## Workspace Control (UI)

合同审核顶栏与 `ChatComposer` **保持原来一个按钮**：

```text
[📁  <显示名> ]
     ▲ 单击 = chooseWorkspace({ defaultPath: 当前路径 })
```

- 显示名 = 路径最后一段。`title` = 绝对路径。
- `data-testid="workspace"` / `composer-workspace` 不变。`onChooseWorkspace` 不变，只是带上 `defaultPath`。
- 不增加第二个按钮，不拆 `onOpenWorkspace` / `onChangeWorkspace`。
- `hideWorkspace === true`：这个按钮不渲染。

合同审核「选择合同」仍是选文件，本期不改它的 `defaultPath`。

---

## IPC

| Channel | 行为 |
| --- | --- |
| `sparkii:allocateAutoWorkspace(agentId)` | `{ workspacePath }`。只算路径。`agentId` 必须是已安装 agent，否则抛错。 |
| `sparkii:chooseWorkspace(opts?: { defaultPath?: string })` | `defaultPath` 为绝对路径时先 `ensureWorkspaceDir`，再 `showOpenDialog({ properties:['openDirectory'], defaultPath })`。非绝对则不 mkdir、对话框不带 defaultPath。 |
| `sparkii:setChatWorkspace(id, path\|null)` | `path` → user；`null` → 新 `allocateAutoWorkspace(rec.profileId)`，不 mkdir。 |
| `sparkii:runWorkflow` | 使用 input 路径或 Documents 兜底。**删除 `ensureWorkspaceDir`。** 转发 `workspaceKind`：仅当 input 显式 `'user'` 才入库 `user`，有路径不等于 user。`workflow.ts` 的 Documents 根由 IPC 以 `documentsDir` 参数传入，禁止在该文件 `import { app }`。 |
| `sparkii:promptSession` 新建 | 优先 context.workspacePath + context.workspaceKind，否则 Documents 分配且 `auto`。禁止桌面。 |

`allocateAutoWorkspace` 进 preload。`chooseWorkspace` 增加可选 `{ defaultPath }`。不新增 `openWorkspace`。

测试里 `app.getPath` 必须按 name 返回：`documents` → 临时目录，禁止再 `() => ''`。`runWorkflow` 单测不得在仓库根留下文件夹。

---

## Agent-specific notes

**通用智能体：** 空草稿一出现就分配并显示。首条 `promptSession` 带上该路径。写/附件才建目录。G1 继续成立（桌面无新 `Sparkii*`）。

**合同审核：** 新草稿分配并显示。`startWorkflow` 带该路径。开始审核不建目录。导出报告才把 `report.docx` 写入该工作区（此时 mkdir）。打开历史审核用该条入库路径。

**企业知识问答：** `hideWorkspace`。Main 仍按公式记账。界面不出现按钮。

---

## Out of scope

- 清理已存在的桌面 / 仓库根 `Sparkii*` 空目录（可手工删；不做迁移向导）。
- 卸载时删除 `Documents/Sparkii`（那是用户文档，不是 `data\`）。
- 工作区文件树侧栏、在线 diff。
- 把锚点与工作区合并。
- 「选择合同」对话框的 `defaultPath`。

---

## Testing

### 单元

- `defaultWorkspacePath` / `allocateAutoWorkspace`：`Documents/Sparkii/workspaces/<agent>/<adj-noun-tag>`；两次分配 key 不同；不创建目录。
- `autoWorkspacePath` 不再被 `ipc.ts` / `workflow.ts` import。

### IPC

- `runWorkflow` 不带路径 → 分配 Documents 路径且 **目录不存在**。
- `runWorkflow` 带用户路径 → 原样使用且不 mkdir。
- `allocateAutoWorkspace` 对未登记 agent 抛错；单测必须 `makeRuntime({ agents: Map([[id, stub]]) })` 并用该 id。
- `chooseWorkspace({ defaultPath })`：绝对路径则先 mkdir，再把 `defaultPath` 传给 `showOpenDialog`。相对路径不 mkdir、对话框无 defaultPath。
- `setChatWorkspace(null)` → 新 Documents 自动路径。
- `promptSession(null, ...)` 不带 workspace → Documents，不是 `join('', 'Sparkii...')`。
- mock `getPath('documents')` 为 `os.tmpdir()` 下专属目录；`afterEach` 删除。

### UI

- 新合同审核草稿：工作区按钮有非空显示名。
- 从「已有 session + 脏的 `session.meta.workspacePath`」切到 `sessionId=null`（不 remount）：显示名与 `startWorkflow.workspacePath` 必须是**新** allocate 结果，不得是旧 meta / 旧 runPrefs。
- 再开一条新会话，显示名与上一条不同。
- 单击 `workspace` / `composer-workspace` 仍只调 `chooseWorkspace({ defaultPath: 当前路径 })`。选中新路径后 `startWorkflow` / `setChatWorkspace` 带用户路径。
- `hideWorkspace` 时这个按钮不在。不存在 `workspace-change`。

### 回归

- 通用智能体纯问答：桌面快照无新 `Sparkii*`（E2E G1 口径不变）。
- 只读 bash 在目录不存在时仍返回 `WORKSPACE_NOT_CREATED`。

---

## Implementation impact

| 区域 | 文件 |
| --- | --- |
| 路径 | `apps/desktop/electron/main/workspace.ts` |
| IPC / preload | `ipc.ts`、`preload/api.ts`、`preload/api-types.ts` |
| 聊天 | `standard-chat.tsx`（`ChatComposer` 保持原 `onChooseWorkspace`，通常不用改） |
| 合同 | `agents/contract-review/surface/index.tsx` |
| 测试 | `workspace.test.ts`、`ipc.test.ts`、`contract-surface.test.tsx`、`standard-chat.test.tsx`、`chat-composer*.test.tsx`、`preload-api.test.ts` |

平台生产代码不以 `'general'` / `'contract-review'` / `'knowledge-qa'` 决定路径公式。
