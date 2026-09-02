# 交接：Agent Surface — M-C 遗留项（消除 App 层 agent-id 字面量）

**接手者起点**
- 分支：`codex/agent-surface-template-contract-review`（分叉自 `main`）
- HEAD：`193bbb7 refactor(app): render agent surfaces by manifest surface type`
- 工作区干净；全量验证通过：vitest 115 文件 / 459 测试，renderer + electron `tsc` 通过。

> 在新会话中，先 `git status` 确认分支与干净度，再跑一次相关环境检查（见文末命令）。

## 已完成（请勿重做）

- **M-A / M-B**：类型化业务态为权威源（`parseRiskFindings`/`formatReport`/`parseClauseGroups` + 三个 SKILL 严格 JSON）；`ContractAgentSurface(AgentSurfaceProps)` + `ContractSurface` 薄适配器；App 经 `useAgentSession` + 绑定喂会话，不再传 `state/workflow` 专属 props。
- **M-D**：`@sparkii/ui` 已成为共享公共件（`Markdown`/`ToolCard`/`LifecycleCard`/`ChatComposer`/`pi-timeline`/`thinking-levels`/`chat-detail-level`）；`src/surface/standard-chat.tsx` 是平台标准 ChatSurface（消费 `AgentSurfaceProps`，传输走 `window.sparkii`，会话生命周期用 `actions.newSession/openSession`）；`agents/general/surface/index.tsx` 默认导出 `StandardChatSurface` 并保留 `GeneralChatSurface` 适配器；general 不再 import `src/workbench`/`src/composer`。
- **M-C 主体**：App 渲染按 manifest `surfaceType` 分支（`activeAgentIsChat`），不再用 `screen === 'general'` 字面量控制显隐；合同与通用都走 `useAgentSurface`(绑定) + `AgentSurfaceProps`。
- **meta.inputs**：平台用可迁移 `inputs` 列持久化工作流输入文件；`runWorkflow` 写入，`openChatSession` 解析返回，`useAgentSession` 填充 `session.meta.inputs`。

## 本次遗留项

**目标：让 `App.tsx` 彻底不再出现 `'general'` / `'contract-review'` 字面量（含组件解析、navigate 分支、会话接线的硬编码）。**

### 现状与根因

`apps/desktop/src/App.tsx` 仍有多处 agent-id 字面量：

- `const ContractAgentSurface = useAgentSurface('contract-review').Surface;`（~L433）
- `const { Surface: GeneralChatSurface } = useAgentSurface('general');`（~L434）
- `navigate` 内 `s === 'general'` / `s === 'contract-review'` 分支（~L417-429）
- 会话接线按 agent 区分：`activeSessionFor('general')`、`workflowSessionId`、`onOpenSession('general'/'contract-review')` 等。

根因：通用 chat 依赖「surface 常挂载（隐藏）以保留本地流式 `entries`」，因此 App 需要区分 chat 与 workflow 两条渲染/会话路径；而 `standard-chat.tsx` 目前**自拉流**（用 `window.sparkii` + `@sparkii/ui` 的 `pi-timeline` 维护本地 `entries`），并不消费 `props.session`。

### 推荐路线（二选一）

**路线 A（推荐，最贴近设计原意，工作量更大）**：让 `standard-chat` **真正消费 `AgentSurfaceProps.session`**，不再自拉流。

1. 让 `useAgentSession` 的 `session.entries` 承载完整 chat 时间线。当前 `src/surface/normalize.ts` 只归一 `message`/`workflow_step`/`workflow_state`，缺 `tool`/`event`/`thinking`。可增强 `normalize.ts`（对齐 `@sparkii/ui/pi-timeline`），或让 `use-agent-session.ts` 直接复用 `@sparkii/ui` 的 `normalizeSessionEntries`/`applyChatEvent`（`pi-timeline` 已在公共件内）。
2. `standard-chat` 用 `props.session.entries` 渲染、`props.session.streaming` 控制 busy；队列/草稿/上下文等仍从 `window.sparkii` 订阅。
3. 完成后 general 可卸载/重挂，App 无需常挂载。
4. `App.tsx` 改为：`activeAgent = derivedAgents.find(a => a.id === screen)` → `useAgentSurface(activeAgent.id)` 单一 `Surface`；会话/动作按 `activeAgent.surfaceType` 组装；`navigate` 用「agent id 集合 / manifest 表面类型」判断，去掉逐字面量分支。

**路线 B（轻量，只去 App 渲染层）**：保留 general 常挂载，仅把 `useAgentSurface('general'/'contract-review')` 换成 `useAgentSurface(activeAgent.id)`（`activeAgent` 来自 `derivedAgents.find(a => a.id === screen)`），渲染用单个 `Surface` + `surfaceType` 组装 props。接受 `navigate`/会话接线仍按 agent 区分（App-shell 固有职责）。

### 边界硬规则（不可破）

- `src/surface/**` 绝不 import `agents/**`；只走公开契约 + `@sparkii/ui`。
- `agents/*/surface/**` 绝不 import `src/composer`、`src/workbench`。
- `src/platform/agent-surface-bindings.ts` 是**唯一** import agents 处，且为 codegen 产物（改完跑 `node apps/desktop/scripts/generate-surface-bindings.mjs`；manifest 无变化时内容不变）。
- 每步 TDD：写失败测试 → 跑通确认失败 → 实现 → 跑通 → 提交；renderer + electron `tsc` 必须过。

### 相关文件

- `apps/desktop/src/App.tsx`（遗留点主体）
- `apps/desktop/src/surface/standard-chat.tsx`（标准 chat，当前自拉流）
- `apps/desktop/src/surface/use-agent-session.ts`、`normalize.ts`、`contract.ts`（契约/归一化）
- `apps/desktop/agents/general/surface/index.tsx`（general 入口/适配器）
- 主 spec：`docs/superpowers/specs/2026-09-02-agent-surface-template-and-contract-review-design.md`
- 跟进计划：`docs/superpowers/plans/2026-09-02-agent-surface-followups.md`（M-C Task C1 / M-D D3）

## 环境与命令（新会话必读）

- 本机 node/pnpm 不在 PATH；用捆包运行时：
  `node = C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- vitest（仓库根跑，配置在根 `vitest.config.ts`，include `apps/**/test/**`）：
  `& "<node>" "node_modules\.pnpm\vitest@4.1.11_@opentelemetr_4306a01ba193ef520fa0967e53d8b0d7\node_modules\vitest\vitest.mjs" run <filter>`（全量：`run`）
- tsc（cwd=`apps/desktop`）：
  `& "<node>" "node_modules\.pnpm\typescript@6.0.3\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json`（及 `-p tsconfig.electron.json`）
- 跑测试/类型检查需**提权**（沙箱拦 `node_modules`）；`git add/commit` 需**提权**（沙箱拦 `.git`）。
- 常用命令：codegen `node apps/desktop/scripts/generate-surface-bindings.mjs`。
