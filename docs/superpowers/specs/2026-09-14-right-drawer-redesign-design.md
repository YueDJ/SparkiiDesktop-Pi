# 右侧抽屉改版设计规格

- 日期：2026-09-14
- 状态：设计已确认，待实施
- 范围：壳层右侧抽屉的共用骨架与四个画面（审批、账号、报错中心、运行中心）
- 前置文档：
  - `PRODUCT.md`
  - `DESIGN.md`
  - `docs/superpowers/specs/2026-08-25-sparkii-desktop-ux-design.md`
  - `docs/superpowers/specs/2026-08-28-runtime-pool-management-design.md`
  - `docs/superpowers/specs/2026-09-06-approval-presentation-design.md`
  - `docs/superpowers/specs/2026-09-10-document-parse-design.md`

## 1. 背景与目标

现有右侧抽屉能完成信息显示，但共用骨架弱、密度乱、说明文字抢主内容。四个画面各自堆键值或扁平列表，看起来像同一套「标题 + 清单」，运行中心尤其把智能体占用和文档解析排成三级并列。

目标：

1. 四个抽屉共用同一套页头与宽度档位，视觉跟现有「现代亲和」token 走。
2. 页头只留标题和关闭，不再写情境说明。
3. 运行中心拆成两套占用：智能体（底层 Pi 进程池）与文档解析（独立认字进程）。用户可见文案不出现 Pi / OCR / 进程池。
4. 不改审批门、运行时池、文档解析 supervisor、账号鉴权、错误持久化的数据契约。

## 2. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 共用骨架 | 页头 = 标题 + 关闭。不要情境说明、不要副标题、不要「N 处改动等你看」一类摘要句 |
| 宽度 | 账号 `360px`；审批 / 报错中心 / 运行中心 `420px`；`max-width: 92%` |
| 默认宽 | 抽屉默认改为 `420px`，不再用 `320px` |
| 关闭控件 | 使用现有 `CloseIcon`，可访问名称仍为「关闭」 |
| `Drawer` API | 只加 `size`。不加 `toolbar` 槽 |
| 报错工具条 | 仍由 `ErrorCenterPanel` 自管；`position: sticky` 钉在滚动区顶部，不随列表滚走 |
| 底栏 | 这四个抽屉不需要全局底栏；动作跟在条目或卡片上 |
| 审批分组 | 保留「当前会话 / 其他会话」 |
| 审批摘要 | 删除队列「N 处改动等你看 / 暂无待确认」。空态只留 `EmptyState`「没有待确认的事项」 |
| 运行中心结构 | 两块卡片：智能体、文档解析。删除「运行中 / 排队中 / 等待中的文件」分组标题 |
| 运行中心摘要句 | 删除「运行 2/4 · 排队 1 · 空闲 2」「两套占用，互不影响」「单独一路 · 正在解析」 |
| 智能体容量 | 格数 = `maxAgents`。先填运行，剩余格表示排队，多出的排队不增格。`idle = max(0, maxAgents - active)`。`aria-label` = `运行 ${active}，排队 ${queued}，空闲 ${idle}`。排队格是占用压力的可视化，不改变 idle 公式 |
| 智能体危险按钮 | 保持「释放线程」。文档解析保持「释放」。两者不得同名 |
| 用户可见名 | 「智能体」「文档解析」。禁止 Pi、OCR、worker、sidecar、进程池、释放槽位 |
| 确认框 | 允许继续出现「释放线程」「工作进程将被复用」 |
| 状态栏 | 保持现有 `运行 {active}/{max} · {queued} 排队`；解析忙碌时追加 ` · 文档解析进行中` |
| 账号动作 | 「修改密码」「导出审计记录」做成菜单行；本轮不接真实流程 |
| 账号图标 | 信任行用现有 `ShieldIcon`；菜单行用现有 `ChevronRightIcon`。不新增 `LockIcon` |
| 高风险审批 | 继续走居中模态，不进右侧抽屉 |
| 运行池加载失败 | `2026-08-28` §10 的「正在读取运行状态 / 失败+重试」本轮仍不实现 |

### 取代关系

- **§5** 只取代 `2026-09-06-approval-presentation-design.md` Surfaces / 壳层文案里的队列摘要「N 处改动等你看 / 暂无待确认」以及 Layout 顶行的那句摘要。卡片、UUID、decide、高风险模态、分组标题不变。
- **§8** 取代 `2026-08-28-runtime-pool-management-design.md` **§7.2** 运行中心抽屉的信息架构与文案（分组「运行中 / 排队中」、摘要句、「释放槽位」「暂无运行中的智能体」）。**§7.1 状态栏保持不变。**
- **§8** 同时取代 `2026-09-10-document-parse-design.md`「抽屉」表格的单行拼接布局，以及 Copy rules 里允许的「等待中的文件」作为抽屉分组标题。底栏格式、按钮名「停止 / 释放线程 / 释放 / 停止解析 / 取消加载」、确认框原文、禁止 worker/OCR/Paddle/JSON-RPC **不改**。

## 3. 非目标

- 不改 `PiRuntimePool`、文档解析 supervisor、审批 inbox、错误存储的 IPC 与数据模型。
- 不实现修改密码、导出审计的真实后端。
- 不做常驻右栏、不做抽屉内标签页、不把四个画面合并成一个面板。
- 不把高风险审批搬进抽屉。
- 不改登录页、设置页、审批中心全页、审计全页。
- 不在抽屉可见文案中引入 OCR / Pi / 进程池术语。确认框可保留「工作进程」。
- 不实现运行池快照的加载中 / 失败重试条。

## 4. 共用抽屉骨架

### 4.1 结构

```text
┌ 标题                         ✕ ┐
│  （报错：粘性工具条，见 §7）    │
│  可滚动主内容                   │
└─────────────────────────────────┘
```

- 标题是唯一页头文字。禁止 kicker、副标题、数量说明句。可见标题可以仍是 `span`：对话框名字来自 `role="dialog"` + `aria-label={title}`，测试请查 dialog 而不是 heading。
- `Drawer` 不新增 `toolbar` 槽。报错中心的批量动作由面板自己做成粘性行。
- 点击遮罩或关闭按钮关闭；行为与现网一致。

### 4.2 `Drawer` API

```ts
type DrawerSize = 'md' | 'sm';

function Drawer(props: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  fixed?: boolean;
  className?: string;
  size?: DrawerSize; // 默认 'md' = 420px；'sm' = 360px
}): JSX.Element | null;
```

- `size="sm"` 仅账号抽屉使用。
- 默认宽写在 `.ui-drawer`（420px）。`size="sm"` 加 `.ui-drawer--sm`（360px）。不要再叠一个同宽的 `--md` 修饰类；测试查默认宽用 `.ui-drawer` 且不含 `--sm`，或查计算宽度。
- 审批抽屉现有 `ui-approval-drawer { width: 420px }` 删除。
- 关闭按钮：`<button aria-label="关闭">` + `CloseIcon`，不再写「✕」字符。

### 4.3 视觉

沿用 `DESIGN.md` token：表面白 / 暗色 `#111A2C`，边框 `#EAF0F6` / `#1E293B`，圆角 12–14，浮层阴影 `0 8px 24px rgba(15,23,42,.12)`，主色蓝，语义红/橙/绿不被装饰稀释。

## 5. 审批抽屉「需要你确认」

入口与行为不变：例行写操作从会话弹出右侧抽屉；高风险仍是居中模态。

内容：

- 页头标题：`需要你确认`。删除 `.ui-approval-qhead` 及「N 处改动等你看 / 暂无待确认」摘要。
- 空状态：主内容用 `EmptyState`，标题「没有待确认的事项」，无额外说明句。
- 有条目时按「当前会话」再「其他会话」分组。无当前会话条目则不渲染该组标题。
- 卡片：摘要标题、最多约 5 行预览、默认折叠的「技术细节」、拒绝 / 允许。
- 禁止：中风险标签、倒计时、审批意见、工具名、会话 UUID、目标系统名。

现有 `approval-trust` 用例（UUID 不出现、技术细节默认收起、`decide`、分组）必须保留，不得删掉只改摘要那一条。

## 6. 账号抽屉

页头标题：`账号`。宽度 `sm`。

内容自上而下：

1. 身份：`userName` 首字（空则 `?`）、`userName`、角色 pill（`userRole`）。
2. 信任行：`ShieldIcon` + 「数据目录」+「本机 · 已加密」。
3. 菜单行：「修改密码」「导出审计记录」。`<button type="button">` + `ChevronRightIcon`。本轮无 `onClick`。

禁止：本机账号、登录时间、SSO、角色解释长句。

## 7. 报错中心

页头标题：`报错中心`。不要「N 条未读」页头说明。未读只靠行样式和顶栏铃铛角标。

工具条：`全部标为已读`、`全部清空`。禁用规则不变。该行放在 `ErrorCenterPanel` 内、列表之上，CSS `position: sticky; top: 0`，背景用 `--color-surface`，避免数十条时滚出视口。

列表：图标、人话消息、`来源 · MM-DD HH:mm`、删除。未读行用等待橙浅底；已读用默认表面。

空状态：`EmptyState` 标题「暂无报错记录」（`EmptyState` 已渲染 `<h3>`）。不要教学句。现网 muted 文案已是这六个字；本轮只是改成 heading，不要改句子。

打开抽屉仍关闭 toast；`markAllRead` / `clearAll` / `clearOne` 契约不变。

## 8. 运行中心

### 8.1 两套占用

底层仍是两路资源，禁止合成联合列表：

- 智能体：只读 `RuntimePoolSummary`（`sessions` + `queue`，上限 `maxAgents`）。
- 文档解析：只读 `DocumentParseSnapshot`，不占 `maxAgents`。

用户可见块标题只有「智能体」和「文档解析」。

### 8.2 智能体块

```text
智能体                    [容量条]
合同审核
采购合同复核 · 生成中          [停止] [释放线程]
法规问答
框架协议对照 · 等待审批        [停止] [释放线程]
舆情监控
晨报任务                       [1] [取消排队]
```

- 容量条格数 = `maxAgents`。运行格（蓝）= `active`。排队格（橙）= `min(queued, max(0, maxAgents - active))`。其余空闲中性。
- `aria-label`：`运行 ${active}，排队 ${queued}，空闲 ${max(0, maxAgents - active)}`。例：active=1, queued=1, max=4 → 标签「运行 1，排队 1，空闲 3」，格子 1 蓝 + 1 橙 + 2 灰。
- 不再渲染「运行中」「排队中」分组标题，也不再渲染「运行 N/M · 排队 N · 空闲 N」或「暂无运行中的智能体」。
- 运行/等待审批行：状态点 + `profileName` + `label · 状态`。状态文案：「生成中 / 等待审批 / 空闲占用」。
- 排队行：数字徽标 `aria-label="第 N 位"`（可见节点只有数字，不要再写正文「第 N 位」）+ `profileName` + `label` + 「取消排队」。
- 智能体行：`停止` + `释放线程`。确认框沿用现有「释放线程 / 工作进程将被复用」。
- 两列表都空：一行弱文案「暂无智能体占用」。

### 8.3 文档解析块

```text
文档解析                       [停止解析 | 取消加载 | 释放]
采购合同.pdf
正在解析
第 3/12 页
[进度条]
补充协议.docx
法规问答
```

动作（与 2026-09-10 相同）：

- `starting` → 取消加载
- `parsing` → 停止解析（先确认）
- `idle` / `resident` → 释放（先确认，`variant="danger"`）
- `stopped` → 无按钮

当前行（锁定，不得再写成一条长句）：

| 状态 | 主行 | 次行 | 其它 |
| --- | --- | --- | --- |
| `stopped` | 未启动 | 无 | 无按钮 |
| `starting` | 正在加载 | 有 `fileName` 则文件名 | 取消加载 |
| `parsing` | `fileName` 或「正在解析」 | 必有可见文本「正在解析」；有页则 `第 p/t 页` 或仅有 page 时 `第 p 页` | `total > 0` 时进度条 `aria-label="解析进度"` |
| `idle` | 空闲 | 有 `idleRemainingSec` 则「N分钟后释放」或「N秒后释放」 | 释放 |
| `resident` | 常驻 | 无 | 释放 |

`circuitOpen`：本轮抽屉不增加额外铬。恢复仍走设置页「重新加载」。

等待文件直接列在当前行下面，不要「等待中的文件」标题。每行：文件名 + `agentDisplayName`。

禁止块级说明：单独一路、两套占用、等这一路空出来。

### 8.4 状态栏

保持 2026-09-10 / 2026-08-28 §7.1：

```text
运行 {active}/{maxAgents} · {queued} 排队
运行 {active}/{maxAgents} · {queued} 排队 · 文档解析进行中   // starting | parsing
```

解析忙碌不得把 `active` 加一。

## 9. 文案黑名单（这四个抽屉的可见 DOM）

不得出现：`两套占用` `互不影响` `单独一路` `情境说明` `当前会话优先` `本机账号` `处改动等你看` `等待中的文件` `释放槽位` `暂无运行中的智能体`，以及作为分组标题的 `运行中` / `排队中`，以及 `Pi` `OCR` `worker` `sidecar` `Paddle` `JSON-RPC` `进程池`。

允许：

- 智能体按钮「释放线程」；确认框「工作进程将被复用」
- 文档解析「释放」「正在解析」「正在加载」「空闲占用」
- 与抽屉无关的既有控件（工具卡「运行中」）

## 10. 状态与范围

| 画面 | 空 | 典型 | 最大（需可滚动） |
| --- | --- | --- | --- |
| 审批 | 0 条 | 1–3 张卡片 | 多会话各数张 |
| 账号 | 不适用 | 1 个用户 | 固定 |
| 报错 | 0 条 | 数条未读 | 数十条（工具条粘性） |
| 运行·智能体 | 0 占用 | 1–4 运行 + 少量排队 | `maxAgents` + 排队（含 `queued > 空闲格`） |
| 运行·解析 | 未启动 | 1 个当前文件 + 0–2 等待 | 1 当前 + 多等待 |

加载/忙碌：沿用现有按钮 `disabled` + `busy` key，不新做骨架屏。

## 11. 测试要求

1. `Drawer` 默认 420、`size="sm"` 为 360；关闭按钮 `aria-label="关闭"`。默认档不要依赖不存在的 `--md` 类，除非实现选择加上。
2. 审批抽屉无「处改动等你看」；仍有「当前会话 / 其他会话」；既有 decide / 技术细节 / UUID 用例保留。
3. 账号抽屉：用户名、角色、「本机 · 已加密」、`修改密码` / `导出审计记录` 为 button。
4. 报错中心工具条与未读/清空行为与现网一致；空态是 heading「暂无报错记录」。
5. 运行中心块标题只有「智能体」「文档解析」；无「运行中」「排队中」「等待中的文件」「暂无运行中的智能体」「运行 N/M · 排队」摘要。
6. 智能体会话行可点到「释放线程」；解析 idle 行可点到「释放」；两者可同时存在且名字不同。
7. `parsing` 可见「正在解析」+ 文件名 + 页码；文案扫描禁止 worker/OCR/Paddle/JSON-RPC。
8. 状态栏忙碌解析时仍显示「文档解析进行中」，且不把解析算进 `运行 N/M`。
9. 覆盖 `stopped`（未启动）与 `resident`（常驻）至少各一条。排队溢出（`queued > maxAgents - active`）时容量条格数仍等于 `maxAgents`。

## 12. 文件影响（实施时）

- `packages/ui/src/primitives/Drawer.tsx`
- `packages/ui/src/styles.css`
- `packages/ui/src/patterns/RuntimeCenter.tsx`
- `packages/ui/src/patterns/ErrorCenter.tsx`
- `packages/ui/src/patterns/Shell.tsx`
- `apps/desktop/src/trust/ApprovalDrawer.tsx`
- `apps/desktop/src/styles.css`
- Vitest：`ui-overlay`、`ui-shell-patterns`、`document-parse-copy`、`shell`、`approval-trust`、`error-center-shell`
- `DESIGN.md`（已与本规格对齐）
