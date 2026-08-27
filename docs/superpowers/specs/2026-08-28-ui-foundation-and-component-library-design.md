# Sparkii Desktop UI 底座与组件库设计规格

- 日期：2026-08-28
- 状态：方向已确认，待用户审阅
- 范围：Sparkii Desktop 渲染层 UI/UX 统一底座、设计令牌、React 组件库，以及现有所有表面的迁移
- 前置文档：
  - `PRODUCT.md`
  - `DESIGN.md`
  - `docs/superpowers/specs/2026-08-25-sparkii-desktop-ux-design.md`
  - `docs/superpowers/specs/2026-08-25-surface-archetypes.md`

## 1. 背景与目标

Sparkii Desktop 当前已有明确的视觉方向和 token 起点，但实现层没有形成统一的组件库。颜色、间距、控件尺寸和状态表达散落在 `apps/desktop/src/styles.css` 与各组件中，导致：

- 按钮、图标按钮、标签、开关、tab 等控件样式不一致；
- composer 内控件大小和排布不均衡；
- 存在大量装饰性而非语义性的圆点和符号；
- 新增智能体时缺少可复用的 UI 底座，容易继续复制不一致的实现；
- 用户旅程、空态、加载态、错误态和审批打断体验不够系统。

本规格的目标是把已有的设计方向落成可执行的工程底座，而不是更换视觉世界。视觉基线仍以 `DESIGN.md` 的“现代亲和 + 蓝色主色 + 大圆角”为准。

### 已确认决策

1. 视觉基线：继续以现有 `DESIGN.md` 为唯一权威，只收敛、补齐，不做方向性换肤。
2. composer：高级控制（工作区、模型、思考强度）始终可见，但所有控件统一尺寸和排布。
3. 迁移范围：采用渐进式统一底座，但本轮覆盖所有现有界面，不再保留局部修补的旧实现。

## 2. 非目标

- 不更换现有品牌视觉方向。
- 不重做底层 Electron、IPC、审批执行器、审计存储等非 UI 逻辑。
- 不新增未在 `PRODUCT.md` 中承诺的智能体或业务能力。
- 不为了“组件化”而把明显一次性、无复用价值的局部实现抽象成组件。
- 不引入新的第三方大型 UI 框架；组件库以项目内自研为主，避免为了统一而引入额外依赖负担。

## 3. 现状盘点

### 3.1 设计令牌

- 已有：`packages/theme` 提供 light/dark token，包含 `color`、`spacing`、`radius`、`shadow`、`font`。
- 问题：
  - token 组不够完整，缺少字号层级、字重、控件高度、z-index、动效时长；
  - 语义状态色只有主色、风险、等待、完成，缺少 hover、active、disabled、focus、border-strong 之外的层次；
  - `styles.css` 中同时存在 token 变量和硬编码颜色，例如 `#E8EEF6`、`#F1F5FB`、`#2563EB`、`#B91C1C`，容易出现视觉漂移。

### 3.2 组件与样式

- 现有组件均为手写 JSX + 全局 CSS 类，缺少稳定的 props API。
- `.composer` 在 `styles.css` 中被定义了两次，`msg` 与 `bubble`、`toolcard` 与 `tool-card` 并存，说明样式在迭代中已经分叉。
- 按钮通过 `.btn`、`.btn.primary`、`.btn.sm`、`.btn.ic` 组合；图标按钮是 `.icon-btn`；导航项是 `.agent`；pill 是 `.pill`。同一种语义有多种实现入口。
- 大量内联样式散落在 `HomeView`、`ContractSurface`、`SettingsView`、`Shell` 等文件中，尺寸和间距无法统一约束。

### 3.3 关键表面

- 壳层 `Shell`：顶栏、左栏、底部状态栏、会话/队列/账号抽屉。
- 首页 `HomeView`：待办、系统状态、智能体卡片、最近会话。
- 合同审核 `ContractSurface`：上传、工作流步骤、报告/原文、风险发现、导出。
- 通用对话 `GeneralChatSurface`：消息流、工具卡片、composer。
- 审批：`ApprovalCenter`、`ApprovalPanel`、`ApprovalModal`、`Countdown`。
- 审计：`AuditView` 时间线/表格。
- 设置：`SettingsView` 左侧导航 + 右侧内容。
- profile 驱动组合：`PageComposer` 和 `registry.tsx` 目前只有基础 widget，未接入统一设计系统。

### 3.4 待清理的装饰元素

- 左栏每个智能体前固定显示状态圆点，空闲状态仍显示灰色点。
- 会话抽屉、审批列表、首页“系统状态”中大量使用 `●`、`○` 和圆点表达状态。
- 状态点和风险徽标同时出现时信息重复。

## 4. 设计令牌规格

### 4.1 令牌分层

令牌分为 primitive 和 semantic 两层。组件只消费 semantic token，不直接引用 primitive 值，除非该组件本身就是主题生成器。

primitive：

- `color.*`：品牌、中性色、状态色的原始值。
- `spacing.*`：4 / 8 / 12 / 16 / 20 / 24。
- `radius.*`：`control` 8、`button` 10、`card` 12、`overlay` 14、`pill` 999。
- `font.size.*`：11 / 12 / 13 / 14 / 15 / 18 / 22。
- `font.weight.*`：400 / 500 / 600 / 700。
- `shadow.*`：`card`、`overlay`。
- `motion.*`：`fast` 120ms、`normal` 180ms、`slow` 240ms；ease 使用 `ease-out`。

semantic：

- `color.bg`、`color.surface`、`color.border`、`color.borderStrong`。
- `color.text`、`color.textSecondary`、`color.textMuted`。
- `color.primary`、`color.primaryHover`、`color.primaryActive`、`color.primaryBg`。
- `color.risk`、`color.riskBg`、`color.warn`、`color.warnBg`、`color.ok`、`color.okBg`。
- `color.controlBg`、`color.controlBorder`、`color.controlBorderHover`、`color.controlFocusRing`。
- `color.disabled`、`color.disabledBg`。
- `control.height.sm`、`control.height.md`、`control.height.lg`。

### 4.2 统一尺寸

为解决 composer 和全局控件大小不一的问题，采用固定控件高度和间距：

| 级别 | 高度 | 主要用途 |
| --- | --- | --- |
| `sm` | 28px | 表格内操作、标签、紧凑工具条 |
| `md` | 34px | 输入框、选择器、普通按钮、图标按钮 |
| `lg` | 40px | 主发送按钮、主 CTA、模态框主操作 |

补充约束：

- 图标按钮宽度等于同级别高度，保证方形热区。
- textarea 最小高度 64px，垂直可扩展；发送按钮使用 `lg`，与 textarea 底边对齐。
- 相同行的选择器、输入框、普通按钮必须使用同一高度，不因控件类型产生高度差。
- 间距优先使用 4 / 8 / 12 / 16 / 20 / 24，禁止随意使用 5、7、9 等非刻度值；特殊情况需在组件内注明理由。

### 4.3 状态语义

状态只表达真实状态，不做装饰：

| 状态 | 视觉 |
| --- | --- |
| 运行中 | 主色或语义蓝 |
| 排队 | 等待橙 |
| 等待审批 | 琥珀/等待橙 |
| 完成 | 完成绿 |
| 失败/风险 | 风险红 |
| 空闲 | 不显示状态点，只保留文字或导航态 |

规则：

- 空闲状态不再显示灰色圆点。
- 圆点只用于“需要用户注意的瞬时状态”，当前选中项改用背景高亮 + 左侧强调条。
- 风险徽标、倒计时、审批角标各自只出现一次，不在同一行重复表达同一状态。
- 所有文本状态使用 `tabular-nums`，数字不跳动。

## 5. 组件库架构

### 5.1 包结构

新增 workspace 包：

```text
packages/ui/
  package.json
  tsconfig.json
  src/
    index.ts
    styles.css
    primitives/
      Button.tsx
      IconButton.tsx
      Badge.tsx
      StatusBadge.tsx
      Tag.tsx
      Card.tsx
      TextField.tsx
      TextArea.tsx
      Select.tsx
      Switch.tsx
      Tabs.tsx
      Drawer.tsx
      Modal.tsx
      ListRow.tsx
      EmptyState.tsx
      Toolbar.tsx
      Divider.tsx
      Spinner.tsx
      Toast.tsx
    icons/
      index.tsx
    patterns/
      Shell.tsx
      AgentNav.tsx
      SessionList.tsx
      StatusBar.tsx
      ChatMessage.tsx
      ToolCard.tsx
      ChatComposer.tsx
      WorkflowSteps.tsx
      ApprovalItem.tsx
      AuditTimeline.tsx
      SettingsLayout.tsx
      SettingsRow.tsx
      RiskBadge.tsx
      Countdown.tsx
```

`@sparkii/ui` 依赖 `@sparkii/theme` 和 `react`。应用侧通过 `import { Button } from '@sparkii/ui'` 和 `import '@sparkii/ui/styles.css'` 使用，不再在 `apps/desktop` 保留大型全局样式文件。

### 5.2 基础组件 API 约定

- 组件接受 `className`、`children`、`variant`、`size`、`disabled`、`loading` 等常规 props。
- 所有交互元素保留 `data-testid` 透传，避免破坏现有测试定位。
- 图标按钮、关闭按钮、状态徽标必须包含可访问名称（`aria-label` / `title`）。
- 颜色、尺寸、圆角、阴影只从 token 取，不接受组件内硬编码值。
- 弹层组件统一处理点击外部关闭、Esc 关闭、焦点返回和基本焦点管理。
- 业务模式组件通过明确的 props 接入数据，不在组件内部直接调用 IPC。

### 5.3 组件清单

基础组件：

- `Button`：`primary` / `secondary` / `ghost` / `danger`，`sm` / `md` / `lg`，支持 `icon`、`fullWidth`、`loading`。
- `IconButton`：方形热区，`sm` / `md` / `lg`，带无障碍名称。
- `Badge`：数字角标，用于审批、排队等计数。
- `StatusBadge`：运行中、排队、等待审批、完成、失败。
- `Tag`：低信息密度标签。
- `Card`：表面容器，可控制 padding 和边框。
- `TextField` / `TextArea` / `Select`：统一高度、focus ring、错误态。
- `Switch`：统一开关。
- `Tabs`：统一页签交互。
- `Drawer` / `Modal`：统一遮罩、动画、关闭和焦点管理。
- `ListRow`：列表行，支持当前态、操作按钮、次信息。
- `EmptyState`：无内容时的引导。
- `Toolbar` / `ToolbarGroup`：工具条布局。
- `Divider`：分隔线。
- `Spinner` / `Toast`：加载和轻提示。

业务组件：

- `Shell`：顶栏 + 左栏 + 表面区 + 底部状态栏。
- `AgentNav`：智能体导航项，含图标、名称、排队角标、当前态。
- `SessionList`：会话列表、重命名、删除、当前会话态。
- `StatusBar`：底部状态与队列入口。
- `ChatMessage`：用户/助手消息、Markdown、思考过程、流式光标。
- `ToolCard`：内联工具卡片，等待审批 / 运行 / 完成状态。
- `ChatComposer`：工作区、模型、思考强度、输入框、发送/停止。
- `WorkflowSteps`：任务流步骤。
- `ApprovalItem` / `ApprovalCenter` / `ApprovalPanel` / `ApprovalModal`：审批三态呈现。
- `AuditTimeline` / `AuditTable`：审计视图。
- `SettingsLayout` / `SettingsRow`：设置页结构。
- `RiskBadge` / `Countdown`：风险与倒计时。

### 5.4 图标库

将 `apps/desktop/src/shell/icons.tsx` 迁移到 `@sparkii/ui/icons`，统一 `IconProps`。补齐当前界面所需图标：Home、Sessions、Plus、Send、Stop、Clip、Gear、Moon、Sun、User、Shield、Audit、Close、ChevronDown、ChevronRight、Search、Check、Warning、Info。图标统一 16px 基础尺寸，颜色继承 `currentColor`。

## 6. 信息架构与用户旅程

主旅程：

```text
启动
→ 首页总览：待办、系统状态、智能体入口、最近会话
→ 选择智能体，进入单一焦点表面
→ 完成任务 / 对话
→ 触发审批时以面板或模态打断
→ 审批后继续；审计入口常驻
→ 设置中配置模型、权限、外观
```

壳层保持同构：

- 顶栏：应用身份、当前智能体、本机运行、审计状态、审批角标、账号、主题、设置。
- 左栏：智能体导航 + 全局审批/审计入口。
- 表面区：三种智能体表面之一，不使用全局页面跳转。
- 底部状态栏：一句话状态 + 运行/排队入口。

### 6.1 首页

- 顶部问候与上下文。
- “待你处理”卡片优先呈现审批事项，空态直接引导到审批中心。
- “系统状态”卡片使用图标 + 文本，不使用原始 `●` 符号。
- 智能体卡片显示图标、名称、一句话说明、状态徽标。
- 最近会话在数据就绪后接入，未就绪时提供明确空态，不显示占位性假数据。

### 6.2 对话表面

- 消息流：用户消息靠右，助手消息靠左；助手消息支持 Markdown 和可折叠思考过程。
- 工具卡片：等待审批、运行中、完成三种状态只显示必要信息，详情按需展开。
- composer：高级控制始终可见，统一尺寸，具体见第 7 节。

### 6.3 任务流表面

- 工作流步骤、报告/原文页签、风险发现保持现有信息结构。
- 步骤圆点只表达完成/进行中/失败/等待，不使用无状态灰点。
- 风险发现使用统一风险徽标，不在同一行重复状态点。

### 6.4 审批

- 默认右侧面板，高风险升级居中模态并二次确认。
- 风险、倒计时、冻结参数、意见、拒绝/批准统一布局。
- 超时自动拒绝继续作为硬约束，UI 明确提示。

### 6.5 审计

- 时间线默认，表格作为查看/导出视图。
- 时间线节点用语义色表达结果，而不是纯装饰灰点。
- 筛选、导出、空态统一。

### 6.6 设置

- 左侧导航使用与左栏一致的选中态，右侧内容统一行高和字段宽度。
- 每个字段行采用 `SettingsRow`，标签、控件、说明的层级一致。
- 模型列表、连接状态、拉取/测试按钮统一控件高度。

## 7. ChatComposer 具体设计

目标：高级控制始终可见，但消除大小不均衡，形成一个清晰的输入卡片。

结构：

```text
┌ ChatComposer ──────────────────────────────────────┐
│ [工作区] /path/to/workspace  [选择文件夹] [清除]     │
│ [模型 ▾] [思考强度 ▾]                               │
│ ────────────────────────────────────────────────── │
│ textarea（min-height 64px）              [发送/停止] │
└─────────────────────────────────────────────────────┘
```

约束：

- 工作区行、模型/思考行、输入行使用统一的 8px 间距。
- `选择文件夹`、`清除`、模型选择器、思考选择器高度统一为 `md`。
- 发送/停止按钮高度为 `lg`，与 textarea 底边对齐。
- textarea 占满可用宽度，发送按钮固定宽度并保持方形或最小宽度。
- 窄宽度下允许工作区行折行，但控件高度不变；桌面默认宽度不折行。
- 停止按钮只在使用中可见或作为发送按钮的状态替换，不额外增加一个按钮位。

该组件由基础组件组合而成，不重新发明按钮和输入框。

## 8. 冗余装饰清理策略

统一执行以下替换：

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| 左栏智能体 | 每项前有状态圆点 | 图标 + 名称 + 当前态背景/左侧强调条；仅排队显示角标 |
| 会话抽屉 | 每行前有圆点 | 当前会话背景高亮；非当前项无圆点 |
| 审批中心 | 每项前有风险相关圆点 | 风险徽标承载风险，取消前置圆点 |
| 首页系统状态 | `●` / `○` 文本符号 | 图标 + `StatusBadge` |
| 任务流步骤 | 无状态灰点 | 完成/进行中/失败/等待语义表达 |
| 审计时间线 | 无状态灰点 | 执行绿 / 拒绝红 / 未知中性灰，节点表达结果 |

清理后不得损失任何真实状态信息，只移除不承载信息的装饰。

## 9. 可扩展性与 profile 组合

- profile 的 `ui/pages/*.json` 继续作为页面组合描述，不改成强制编码。
- `PageComposer` 的 widget registry 从 `@sparkii/ui` 复用基础组件，widget 只负责数据绑定和业务动作。
- 新增智能体时优先从三类表面范式中选择，壳层和通用组件由底座提供；只有确有必要时才新增 surface-specific 组件。
- 组件库通过单一出口 `@sparkii/ui` 暴露 API，避免应用直接依赖组件内部文件。

## 10. 迁移策略

即使本轮覆盖所有界面，也按以下顺序推进，便于逐步验证：

1. 扩展 `@sparkii/theme` token，更新 `resolveTheme` 和 `cssVariables`。
2. 新建 `@sparkii/ui`，实现基础组件、图标、全局样式。
3. 迁移壳层和全局基础控件，删除旧按钮/圆点/重复样式。
4. 迁移 ChatComposer 和对话表面，验证尺寸与状态。
5. 迁移首页、合同审核、审批、审计、设置。
6. 迁移 `PageComposer` widget registry，验证 profile 驱动路径。
7. 删除 `apps/desktop/src/styles.css` 中的旧实现，只保留应用级最小样式。

每一步完成后运行：

```text
pnpm typecheck
pnpm test
pnpm lint
```

并做一次桌面宽度 + 窄宽度的视觉检查。

## 11. 测试与验收

### 11.1 行为不变

- 现有 `data-testid` 保持不变，或迁移时同步更新测试定位。
- 审批、会话、主题切换、聊天、合同上传等既有行为不能回退。
- 新增组件必须覆盖禁用、loading、空态和焦点可见态。

### 11.2 视觉验收

- 同一行控件高度一致，无“有大有小”。
- 所有颜色、圆角、阴影来自 token，不再出现硬编码十六进制值。
- 左栏智能体、会话、审批、首页不再出现装饰性灰点。
- light/dark 两种主题下均可读，状态语义清晰。
- 焦点环在所有键盘可操作控件上可见。

### 11.3 回归检查

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm lint` 通过。
- 现有 e2e / 单元测试定位没有因类名变化产生无谓破坏。

## 12. 风险与应对

- 迁移范围大，容易一次性改动过多：按第 10 节顺序分批提交，保持每步可运行。
- 删除旧 CSS 可能影响测试中的类名断言：先保持 `data-testid`，再同步更新测试。
- 组件抽象过度会增加维护成本：只抽取出现 3 次以上、语义一致的 UI；一次性布局保留在具体表面。
- dark theme 下状态色不清晰：在组件库内提供 dark token 验证，不只在页面里临时调。

## 13. 开放问题

- 无阻塞性开放问题。若实施中发现某个 widget 需要超出三类表面范式的交互，先回到本规格补充 surface archetype，再实现。

