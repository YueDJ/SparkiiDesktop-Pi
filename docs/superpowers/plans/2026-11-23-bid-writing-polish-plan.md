# 标书写作智能体体验完善 — 实施计划（v3.1，架构终审修订版）

**日期:** 2026-11-23
**状态:** 待实施（v1 不通过 → v2 有条件通过 → v3 大幅简化 → v3.1 补 C1–C4；待终审确认）
**范围:** 标书写作智能体 4 项体验问题

> v3 → v3.1 修订摘要（架构终审 C1–C4）：
> - **C1（阻塞）**：空会话标题兜底明确走 **fenced `workspace-file-service.read({sessionId, path:'project.json'})`**，禁止按 workspacePath 裸读 fs；限定仅 title 缺失时读、读不到静默走原逻辑。
> - **C2（阻塞）**：侧栏项目组名**固定取项目名**（兜底后的 project.json.name）；"取最新会话"只决定点击打开哪个会话，不影响组名；用户对单条会话改名不改变项目组名。
> - **C3**：复合锚点 `<chapterId>::<blockId>` 只作渲染 DOM 的 `data-*` 属性、不写回 markdown；点击块经 chapterId 反查 chapters[].file 进入该章源码编辑；WysiwygEditor props 扩展为多章只读输入。
> - **C4**：明确删除语义——删最后一条会话即隐藏项目入口、磁盘文件保留（验收标准写明）。

> v2 → v3 修订摘要（架构师复审意见）：
> - **删除 projects 实体**（N3）：不新增表/IPC/事件。侧栏按 `workspacePath` **派生分组**，组名取会话显示名。没有第二份状态，M1（双真相源）/M2（搬迁联动）/M7（新事件）全部消解。
> - **修 N1（重启丢名）**：阶段 2 原论断错误——空会话 `set_session_name` 只写内存不落盘。改为在 `listChatSessions` 对**标题缺失的会话**从 `<workspacePath>/project.json` 只读兜底取 `name`，重启可靠。
> - **定 M3/M4/M5/M6**：B 方案收敛为"**全文只读显示层 + 单章文件编辑/patch/快照**"。全文仅渲染与定位，编辑仍按单章文件，因此块 id 冲突、按章写回、dirty 按章化、快照 key 问题基本消解。
> - 统一阶段 5/6 的编辑模型为单章；用 capability flag 而非 surfaceType 判定聚合。

## 背景与问题

1. 新建项目后侧边栏显示 `(no messages)` 而非项目名。
2. 已生成标书编辑交互别扭：点击渲染块原位替换 textarea；顶部两个 tab（所见即所得 / 查看源码）。
3. 章节大纲平铺无层级，不能定位到正文对应位置。
4. 右侧对话面板标题显示 `No messages`，缺 general chat 自动标题；对话组件与 general chat 共用，必须隔离。

## 真相源契约

| 数据 | 唯一真相源 | 写入方 | 说明 |
|---|---|---|---|
| 会话标题 | Pi jsonl `name` | agent 经 `setChatTitle`；用户改名置 `titleLockedByUser` | 遵守 2026-09-04 spec，平台不存副本 |
| 空会话显示名 | `project.json.name`（**只读单字段兜底**） | agent 向导写 `project.json` | 平台仅在会话无标题时读取，不解析其他字段、不回写 |
| 项目业务真相 | `project.json` | agent（renderer surface + Pi 工具） | 平台不解析结构 |

**平台只读例外声明**：`listChatSessions` 在会话 `title` 缺失时，用该会话 `rec.id` 经 **fenced `workspace-file-service.read({ sessionId, path: 'project.json' })`**（绝不可按 workspacePath 裸读 fs）读取 `name` 单个字段作为显示兜底。这是 2026-09-04 spec 第 36 条"只读兜底"的具体化（把兜底源从 `firstMessage` 换成更有意义的 `project.json.name`），不按 agent id 分支——任何会话工作区下有 `project.json` 都适用，读不到则静默走原逻辑。平台**不写** `project.json`，不构成第二真相源。

## 核心设计决策

### 决策 1：`listChatSessions` 补 `workspacePath`（前置基础，修既有 bug）

现状 `index.tsx:342-346` 用 `r.workspacePath` 过滤对话记录，但 IPC 返回对象与 preload 透传都没有该字段——该过滤恒为空、"对话记录"列表实际是坏的。

- `ipc.ts` 两处 `mapped.push` 补 `workspacePath`（活跃会话取 `rec.workspacePath ?? s.cwd`，空会话取 `rec.workspacePath`）。
- `api-types.ts` 会话返回类型补 `workspacePath?`。
- 验收：标书页面内"对话记录"能列出同项目多会话。

### 决策 2：标题修复（解决 1 + 4 的标题部分，修 N1）

- 建项目后 `setChatTitle(newSessionId, 项目名, 'agent')` → `session_title` 事件即时写前端 `sessionOverridesRef`，侧栏与右栏立刻显示项目名。
- **重启可靠性（C1）**：空会话 `set_session_name` 只写内存不落盘（N1），因此**不能只靠它**。`listChatSessions` 在会话 `title` 缺失时，用该会话 `rec.id` 经 **fenced `workspace-file-service.read({ sessionId: rec.id, path: 'project.json' })`** 只读 `name` 兜底——**禁止按 `workspacePath` 裸读 fs**（绕过 P1 边界/reparse-point 校验是安全红线）。限定：仅 `title` 缺失时读；读不到静默走原逻辑；general / 评审会话无 project.json 时行为与现网一致。这样"建项目后未对话就重启"仍能显示项目名。
- 落点说明：右栏 title 直接取侧栏 `sessions[agentId].name`（`App.tsx:644`），侧栏与右栏同一条链路，兜底补一处即可两处生效。（实现可选在主进程 `listChatSessions` 内经 fenced 服务读，或在渲染层 `refreshSessions` 内经 `workspaceRead` 读——两者都走 fenced 通道；实施时按代码整洁度定，不改变契约。）
- 用户改名仍走 `setChatTitle(id, title, 'user')` 置锁，与 spec 完全一致。
- 验收必须含真实用例：**新建项目 → 不发任何消息 → 重启应用 → 侧栏与右栏仍显示项目名**；以及 **general / 评审会话无 project.json 时行为不变**。

### 决策 3：侧栏派生分组（解决方案 1 的"一个项目一行"，替代 projects 实体）

- 保留 App.tsx `sessions` 结构不变（全部 CRUD/置顶/归档/拖拽/改名路径零改动）。
- Shell.tsx 对标记 `projectScoped` 的智能体，按 `workspacePath` 把会话折叠成一行。**组名固定取项目名**（决策 2 兜底后的 `project.json.name`，同一项目所有会话共享此值）；"取 `updatedAt` 最新一条"只用于决定点击该行时打开哪个会话，**不影响组名**。用户对单条会话改名（`setChatTitle(...,'user')`）只改变该列表项，不改变项目组名——避免组名随"取哪条/何时取"漂移（C2）。该项目其他会话在页面内"对话记录"列表查看。
- 判定用显式能力声明 `surface.projectScoped: true`（manifest → agent-catalog → ShellAgent），**不用** surfaceType 推断。
- 会话级智能体（general / 知识问答 / 评审）走原路径，**行为完全不变**。当前只有标书是 projectScoped。

### 决策 4：对话组件物理隔离（解决 4 的隔离要求）

用户硬约束：general chat 与标书对话宁可复制也不共用。

- 复制 `src/surface/standard-chat.tsx` 为 `agents/bid-writing/surface/standard-chat-bid.tsx`，标书改 import；平台原组件不动。
- 复制 `agents/general/surface/title.ts` 为标书独立副本（`placeholderOf` 兜底改标书语义），新增标书包装层两阶段标题状态与 `completeText` 接入（`general/surface/index.tsx:17-54` 为范本）。
- 会话标题用 `setChatTitle(...,'agent')`，与决策 2 项目名发布同一机制、互不冲突。
- 副本文件头注明 forked 来源与日期，标书 agent owner 负责评估平台修复的同步。

### 决策 5：编辑器交互（解决 2，单章编辑模型）

- `wysiwyg.tsx` 去掉两个 tab（`:87-90`）与块级 onClick 替换（`:102-131`）。
- 默认渲染态；点击正文内部切整章 Markdown 源码编辑态；右上角对勾 → `WysiwygProps` 新增 `onSave` 回调（改 `index.tsx` 挂载处）→ 走现有 `saveChapter` + 版本快照 → 切回渲染态。
- 仍按**单章文件**读写，`saveChapter` / `snapshot` / `applyAiPatch` 行为不变。

### 决策 6：章节树 + 全文显示（解决 3，B 方案收敛版）

**模型**：中栏是"整本正文的只读渲染视图"；编辑仍按单章文件。全文视图不承担编辑态，因此无需整本内存态，M3–M6 数据模型风险消解。

- 中栏加载并拼接所有章节文件用于只读渲染；每个块 DOM 带复合锚点 `<chapterId>::<blockId>`，**只作 `data-*` 属性、不写回 markdown**（C3）。
- 左栏章节按 `id` 点分编号构建树（一级 / 展开箭头 / 二级缩进）。
- 点击章节 → 不切页，`scrollIntoView` 到对应块并置顶（给 `wysiwyg.tsx` block div 加 `data-block-id` 并暴露滚动 ref）。
- 在该块上点击编辑 → 由 `chapterId` 反查 `activeProject.chapters[].file` → `readChapter` → 进入该章源码编辑（沿用决策 5）；对勾 → 按该章文件保存 → 回全文只读渲染。反查链路显式定义，避免多章拼接后块归属错乱（C3）。`WysiwygEditor` props 由"单章字符串"扩展为"多章只读输入 + 当前编辑章"。
- AI patch 仍按单章文件粒度（`applyAiPatch` 不变）；快照仍按章节文件 key（`version-store.ts` 不变）；流式跟随 `reloadFromWorkspace` 仍按当前章保护 dirty（单章布尔够用，无需按章化）。
- **不引入**整本内存字符串、按章切分写回、全局块 id 合并。

## 分阶段实施（独立可验收、可回滚）

| 阶段 | 任务 | 验收 | 关键文件 |
|---|---|---|---|
| 1 | `listChatSessions` 补 workspacePath；对话记录列表恢复 | 同项目多会话可见；现有测试绿 | `ipc.ts`、`api-types.ts`、`bid-writing/index.tsx` |
| 2 | 标题修复 + 空会话重启兜底 | 新建项目未对话即重启，侧栏/右栏仍显示项目名 | `bid-writing/index.tsx`、`ipc.ts` |
| 3 | 侧栏派生分组（projectScoped 能力声明） | 标书一个项目一行；其他 agent 侧栏零变化 | `App.tsx`、`Shell.tsx`、`manifest.yaml`、`agent-catalog.ts` |
| 4 | 对话组件隔离 + 两阶段标题 | 与 general chat 物理隔离，互不影响 | `standard-chat-bid.tsx`、`title.ts` |
| 5 | 编辑器交互（去 tab + 对勾保存，单章模型） | 交互问题消失；保存/快照/patch 行为不变 | `wysiwyg.tsx`、`index.tsx`、`styles.css` |
| 6 | 章节树 + 全文只读显示 + 锚点定位 | 树展开/收起；点击二级标题滚动置顶；编辑回单章 | `wysiwyg.tsx`、`index.tsx`、`block-merge.ts` |
| 7 | 测试更新与全量验证 | typecheck / lint / test 全绿 | 各阶段对应测试 |
| 8 | 架构师复审 | 通过 | — |

## 测试策略（具体用例）

- `ipc.test.ts`：补 workspacePath 后现有 firstMessage/title 断言不破；空会话 `title` 缺失时从 `project.json.name` 兜底；读不到时走原逻辑且不报错。
- `bid-writing-surface.test.tsx`：**新建项目 → 无消息 → 重启 → 显示项目名**（N1 回归）；对话记录列出多会话；编辑器去 tab + 对勾保存；章节树滚动定位。
- `app-*.test.tsx`：mock 返回值补 workspacePath；projectScoped 分组对标书生效、对 chat/workflow agent 零变化。
- 侧栏聚合：同 workspacePath 多会话折叠一行，显示项目名，点击打开最近会话。

## 验收标准

- [ ] 新建项目后侧栏与右栏显示项目名，**未对话即重启仍在**。
- [ ] 侧栏项目组名固定为项目名；用户对单条会话改名不改变项目组名；general / 评审会话无 project.json 时行为不变。
- [ ] 删除项目最后一条会话 → 侧栏与项目列表不再显示该项目，磁盘工作区文件保留（C4 产品语义）。
- [ ] general / 知识问答 / 评审的侧栏与标题行为完全不变。
- [ ] 标书对话组件与 general chat 物理隔离，互不影响。
- [ ] 点击正文进入源码编辑，对勾确认后自动保存并回到渲染态。
- [ ] 章节树展开/收起，点击二级标题滚动到全文对应块并置顶；编辑仍按单章文件。
- [ ] typecheck / lint / test 全绿。
- [ ] 架构师复审通过。
