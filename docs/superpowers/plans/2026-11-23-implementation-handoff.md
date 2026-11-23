# 实施交接提示词 — 标书写作智能体体验完善

> 用法：把下方 `===== 提示词开始 =====` 到 `===== 提示词结束 =====` 之间的全文，原样发给负责实施的新 Agent。它是自包含的（新 Agent 看不到之前的讨论）。

===== 提示词开始 =====

你是负责实施的工程 Agent。工作区：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`（Electron + React/TS 桌面应用，pnpm monorepo，Windows）。

## 你的任务

按已批准的架构方案，分阶段实施"标书写作智能体"的 4 项体验完善。**方案已经过四轮架构审核并放行，不要再质疑或重新设计架构**；如发现方案与代码事实冲突，停下来报告，不要自行改方向。

**唯一权威方案文档**（先完整读一遍，它是你的实施蓝图）：
`docs/superpowers/plans/2026-11-23-bid-writing-polish-plan.md`（v3.1，架构终审放行）

## 背景（4 个用户问题）

1. 新建项目后侧边栏显示 `(no messages)` 而非项目名。
2. 标书编辑交互别扭：点击渲染块原位替换 textarea；顶部有"所见即所得 / 查看源码"两个 tab。
3. 章节大纲平铺无层级，不能定位到正文对应位置。用户明确选择 B 方案：全文显示 + 点击章节跳转定位。
4. 右侧对话面板标题显示 `No messages`，缺 general chat 的自动标题；**对话组件必须与 general chat 物理隔离**（用户硬约束：宁可复制一份也不共用）。

## 关键架构约束（不可违反）

- **不引入 projects 数据库实体**：不新建表、不新增项目持久化 IPC、不新增项目事件。侧栏按 `listChatSessions` 返回的 `workspacePath` **派生分组**实现"一个项目一行"。
- **标题真相源遵守 `docs/superpowers/specs/2026-09-04-session-title-source-of-truth-design.md`**：会话标题唯一真相 = Pi jsonl 的 `name`；agent 起名，平台不按 agent id 分支；用户改名置 `titleLockedByUser` 且 agent 不得覆盖。
- **空会话重启兜底必须走 fenced 通道**：`workspace-file-service.read({sessionId, path:'project.json'})`，**严禁按 workspacePath 裸读 fs**（绕过 P1 边界校验是安全红线）。仅 title 缺失时读，读不到静默走原逻辑，general / 评审会话无 project.json 时行为必须与现网一致。
- **项目组名固定取项目名**：同一项目所有会话共享；"取最新会话"只决定点击打开哪个，不影响组名；用户对单条会话改名不改变项目组名。
- **全文只读显示 + 单章编辑**：中栏拼接所有章节做只读渲染与定位；编辑/补丁/快照/流式跟随全部仍按单章文件粒度。不引入整本内存字符串、按章切分写回、全局块 id 合并。复合锚点 `<chapterId>::<blockId>` 只作 DOM `data-*` 属性，不写回 markdown。
- **其他智能体零回归**：general / knowledge-qa（chat）、contract-review / procurement-review（workflow）的侧栏与标题行为完全不变。项目聚合用 manifest 能力声明 `projectScoped`，**不用** surfaceType 推断。

## 实施顺序（严格按此，每阶段独立可验收、可回滚）

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | `ipc.ts` 两处 `mapped.push` 补 `workspacePath`（活跃会话 `rec.workspacePath ?? s.cwd`，空会话 `rec.workspacePath`）；`api-types.ts` 会话类型补 `workspacePath?` | 标书页面内"对话记录"能列出同项目多会话；现有测试绿 |
| 2 | 标题修复：建项目后 `setChatTitle(id, 项目名, 'agent')`；空会话 title 缺失时经 fenced 通道读 `project.json.name` 兜底 | **新建项目 → 不发任何消息 → 重启 → 侧栏与右栏仍显示项目名**；general/评审无 project.json 行为不变 |
| 3 | 侧栏按 `workspacePath` 派生分组：`Shell.tsx` 对 `projectScoped` 智能体折叠成一行，组名固定项目名；manifest 加能力声明并经 agent-catalog 传到 ShellAgent | 标书一个项目一行；其他 agent 侧栏零变化；单条会话改名不改组名 |
| 4 | 对话组件隔离：复制 `src/surface/standard-chat.tsx` → `agents/bid-writing/surface/standard-chat-bid.tsx`，标书改 import，平台原组件不动；复制 `general/surface/title.ts` 为标书副本做两阶段标题 | 与 general chat 物理隔离，互不影响；副本文件头注明 forked 来源 |
| 5 | 编辑器：去 tab 与块级 onClick；点击正文进整章 Markdown 源码；右上角对勾 → `WysiwygProps` 加 `onSave` → 现有 `saveChapter` + 快照 → 回渲染态 | 交互问题解决；保存/快照/patch 行为不变 |
| 6 | 章节树 + 全文只读显示 + 锚点定位：中栏拼接全文只读渲染，块 DOM 加 `data-block-id`；左栏按 id 点分编号建树；点击章节 `scrollIntoView` 置顶；点击块经 chapterId 反查 `chapters[].file` 进该章源码编辑 | 树展开/收起；点击二级标题滚动到对应块并置顶；编辑仍按单章文件 |
| 7 | 测试与验证：typecheck / lint / test 全绿；补 N1 重启回归、无 project.json 兜底、侧栏分组、编辑器对勾、章节定位用例 | 全部通过 |
| 8 | 完成后交架构师复核，再向用户汇报 | — |

## 你可用的验证命令

- `pnpm typecheck`（根目录，或 `apps/desktop` 下 `npx tsc --noEmit -p tsconfig.json`）
- `pnpm test` / `pnpm lint`
- 相关测试文件：`apps/desktop/test/ipc.test.ts`、`bid-writing-surface.test.tsx`、`app-*.test.tsx`、`workspace-relocation.test.ts`

## 工作纪律（重要）

- 本工作区有 `.codex-handoff/CURRENT.md` 交接约定（见 `AGENTS.md`）：若该文件存在且首部 `status: open`，以它的正文为任务、逐字执行、不改不删，并在最终回复引用其 task-id。当前该文件**不存在**，按本提示词执行。
- **不要修改 general chat、contract-review、procurement-review 的任何行为**；改平台公共文件（`ipc.ts`、`App.tsx`、`Shell.tsx`、`standard-chat.tsx`）时，任何分支都必须用能力声明或通用条件，不得按 agent id 特判。
- 每个阶段做完先跑 typecheck/相关测试，再进下一阶段；某阶段受阻就停下报告，不要跨阶段堆改动。
- 不要动与本任务无关的文件。提交由用户决定，你不必主动 commit（除非用户另行指示）。

## 完成后请汇报

1. 每阶段的完成情况与验收结果。
2. 改动文件清单。
3. typecheck / lint / test 结果。
4. 任何偏离计划的地方及原因。

===== 提示词结束 =====
