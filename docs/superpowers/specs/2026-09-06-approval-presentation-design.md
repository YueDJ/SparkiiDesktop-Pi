# 审批展示（平台）— Design Spec

**Status:** 已确认（2026-09-06；展示契约：`summary` + 可选 `preview`，审批端不猜 payload）
**Date:** 2026-09-06
**Plan:** `docs/superpowers/plans/2026-09-06-approval-presentation.md`
**Depends on:** `PRODUCT.md`（无事不打扰，有事必清楚；写操作必须人工把关）；`DESIGN.md` Approval Ritual；`packages/approval` 提案模型
**Amends:** `DESIGN.md` Approval Ritual 的例行字段清单；`PRODUCT.md` 审批倒计时可见性（例行隐藏主视觉、超时仍生效）；`docs/superpowers/specs/2026-08-25-sparkii-desktop-ux-design.md` §4 审批条目的例行呈现

## Goal

把「一条提案在审批 UI 里长什么样」收成**平台契约**：提交端填好给人看的字段，审批端原样展示。所有智能体走同一套卡片，审批 UI 不理解某个智能体的业务 payload。

本轮只改**弹出内容**：标题、可审物件、按钮文案、例行/高风险各显示哪些字段。不改何时弹、弹几次、会不会自动拉开抽屉、超时是否拒绝。

硬约束不变：提议与执行分离、拒绝即不写、参数在提议时冻结、全程审计。

## Confirmed Decisions

1. **展示走显式契约，不猜 payload。** 审批端不解析工具参数 JSON，不从 `diff` / `command` / `sections` 里抽取预览，不改写 `summary`。模型不写审批文案。
2. **契约只有三块给人看的数据：** `summary`（标题）、可选 `preview`（可审行）、`risk`（壳层）。`payload` 只给执行和审计，对 UI 不透明。
3. **`summary` 原样当标题。** 提交端填好人话一行。审批端不剥路径、不加「新建/修改」前缀、不 `JSON.stringify`。空则显示「需要你确认」。
4. **`preview` 是可选的已切好的行。** `{ kind: 'diff' | 'text'; lines: string[] }`。审批端只做 `lines.slice(0, 5)` 和「还有 N 行 · 展开」。`kind === 'diff'` 用现有着色；`text` 为纯文本。没有 `preview` 或 `lines` 为空：只有标题和按钮。
5. **按钮文案统一为「拒绝」「允许」。** 高风险第二次确认为「再次确认允许」。
6. **外观只看 `risk`。** `write` 为例行抽屉；`high-risk` 为居中模态 + 二次确认，并显示高风险徽标、倒计时、审批意见。例行不显示「中风险」、倒计时数字、审批意见、工具名、目标系统、会话 UUID。**例行超时仍生效**：主视觉不放倒计时，但 UI 必须保留隐藏到期回调（现有 `onDecide(id, false, 'timeout')`），因为 Main `gate.expire` 不会推 renderer。
7. **「技术细节」始终存在、默认关上**，内容是冻结 `payload` 的 JSON。这是排查入口，不是默认可审物件，也不是契约的一部分。
8. **填契约的是 `propose()` 的调用方（平台工具包装 / 连接器），不是模型。** 新智能体只要在提议时带上 `summary` + 可选 `preview`。
9. **edit/write 的 preview 只在 Main 算出 diff 的那一处填写。** Pi `coding-tools` 只填 `summary`，不填 `preview`。`broker.route` 仅当 `toolName` 为 `edit`/`write` 且 `preview` 为空时，用刚算出的 diff 字符串生成 `preview.lines`。禁止扫描任意 payload 的 `diff`/`command`/`sections`。新智能体不要指望 broker 代填。

## Non-Goals

- 不改审批频率、会话授权、`evaluate` 规则表、只读白名单。
- 不改自动弹出抽屉、聊天 ToolCard 就地批准。
- 不改超时自动拒绝（例行不把倒计时放在主视觉，但必须保留隐藏到期回调）。
- 不让模型为审批生成摘要或大纲。
- 不把合同导出改成系统保存对话框（那是后续切片）。
- 不为单个智能体写 `if (toolName === …)` 展示模板。
- 不在审批端从业务 payload 推断标题或大纲。

## Current State

今日所有写提案都进同一套 UI，但**没有展示契约**：

- 卡片把 `summary`、工具名、目标、会话短 ID、「中风险」、倒计时、「冻结参数」JSON、审批意见摊在一起。
- `summary` 由各提交点机械拼接：`edit C:\…\a.txt`、命令原文、`JSON.stringify(params)`。
- 可审内容（若有）埋在 `payload` 里（`diff` / `command` / `sections`），UI 若要展示只能去猜形状——这正是本 spec 要关掉的路。
- `ApprovalModal` 已有高风险二次确认，壳层实际只挂 `ApprovalPanel`。

`payload` 在协议里是对象（哈希时做 canonical JSON）。智能体**不必**、也**不该**给 UI 丢一段 JSON 字符串当正文。

## Platform Contract

```ts
interface ApprovalPreview {
  kind: 'diff' | 'text';
  lines: string[];          // 一行一项，提交端已切好
}

interface ProposalRequest {
  toolName: string;         // 审计用；例行 UI 不展示
  targetSystem: string;    // 审计用；例行 UI 不展示
  summary: string;         // 标题，原样显示
  preview?: ApprovalPreview;
  payload: unknown;       // 冻结执行参数；UI 不当预览源
  risk: SideEffect;        // 现有类型含 read；present() 把非 high-risk 当例行抽屉
}

interface Proposal {
  // …现有字段
  preview?: ApprovalPreview;   // 从 Request 原样拷贝；不进 payloadHash
}
```

`preview` **不进入** `payloadHash`。哈希仍只盖 `payload`。

### 审批端允许做的事（仅此）

- 把 `summary` 放到标题。
- 把 `preview.lines` 默认显示前 5 行，其余折叠。
- `kind === 'diff'` 时用现有 `DiffView` 着色，否则当纯文本。
- 按 `risk` 选抽屉或模态、要不要**显示**倒计时/意见/二次确认。
- 例行仍注册隐藏到期回调，到期 `onDecide(id, false, 'timeout')`。
- 「技术细节」里把 `payload` 格式化成 JSON 供排查。

### 审批端不做的事

- 不读 `payload.diff` / `payload.command` / `payload.sections`。
- 不从 `sections[].heading` 抽大纲。
- 不剥工作区路径、不把 `edit C:\...` 改写成「新建 hello.txt」。
- 不把 `payload` 或 `JSON.stringify(args)` 当作标题或预览。
- 不按 `toolName` / `profileId` 换卡片模板。

### 谁填契约

`propose()` / `gate.submit` 的调用方。今天就是平台包装层，不是 LLM。模型继续只调工具；包装层把工具结果**翻译成契约**再提交。

新智能体不必给审批一份特殊 JSON。调用 `propose` 时带上：

1. 一行 `summary`
2. 若有可审内容，再带 `preview: { kind, lines }`
3. `risk`

业务参数仍放 `payload`，形状由该工具的执行器自己定。

### 提交端约定

- `summary`：一行人话后果。不要工具名前缀，不要 JSON。
- `preview.lines`：已经是展示行。diff 一行一条；命令按换行切开；大纲就是标题字符串数组。
- 没有可给人看的内容：省略 `preview`。
- 破坏性：`risk: 'high-risk'`。

## Presentation Function

所有审批表面只通过一个纯函数得到视图模型。它只读契约字段。

建议位置：`apps/desktop/src/trust/present.ts`。不要放进某个 Agent 包。`packages/approval` 的 `Proposal` / `ProposalRequest` 增加可选 `preview`；Gate / Executor 不解释它。

```ts
type ApprovalViewModel = {
  title: string;
  subtitle: string | null;          // 仅 high-risk：「可能无法恢复」
  preview: {
    kind: 'diff' | 'text' | 'none';
    lines: string[];
    visibleLines: string[];         // 默认 min(5, lines)
    hiddenCount: number;
  };
  chrome: {
    mode: 'panel' | 'modal';
    showRisk: boolean;
    showCountdown: boolean;
    showNote: boolean;
  };
  actions: {
    reject: '拒绝';
    allow: '允许';
    confirmAllow: '再次确认允许';
  };
};
```

规则：

- `title` = `summary.trim()` 或「需要你确认」。
- `preview.lines` = 请求里的 `preview.lines`（缺省 `[]`）。
- 5 行截断只作用在 ViewModel。
- `risk === 'high-risk'` → `mode: 'modal'`，三项 show* 为 true。其它 `risk`（含 `write`、`read`）一律例行抽屉。
- 展开状态是卡片局部 UI state。
- 例行提案到达仍自动拉开抽屉（本轮不改打断时机）。高风险到达改为打开模态，不把高风险再塞进抽屉列表。两者同时 pending 时：抽屉只列例行，模态叠高风险。

## Surfaces

| 表面 | 本轮怎么用 ViewModel |
| --- | --- |
| 右侧抽屉 `ApprovalPanel` | 例行提案。标题「需要你确认」；队列「N 处改动等你看」。每张卡：title、preview、技术细节、拒绝/允许。保留「当前会话 / 其他会话」分组；卡片正文不写会话 UUID。 |
| 居中模态 `ApprovalModal` | 只渲染 `chrome.mode === 'modal'` 的提案。壳层若尚未挂上，本轮按 `mode` 挂上。 |
| 审批中心 `ApprovalCenter` | 列表行用 `title`；高风险才显示风险徽标和倒计时。 |
| 首页「待你处理」 | 同上，点进仍打开审批。 |

聊天 ToolCard 仍只显示「等待审批」，本轮不在对话内批准。

壳层文案：

- 抽屉标题：需要你确认
- 队列摘要：暂无待确认 / N 处改动等你看
- 技术细节开关：技术细节 ▸ / ▾
- 空态：没有待确认的事项

## Layout

例行卡片：

```text
需要你确认                         2 处改动等你看
当前会话

┌─────────────────────────────────────┐
│ 写入 hello.txt                       │
│                                     │
│ + Hello, Sparkii                     │
│ + 第二行                            │
│ + 第三行                            │
│ + 第四行                            │
│ + 第五行                            │
│ 还有 12 行 · 展开                    │
│                                     │
│ 技术细节 ▸                           │
│                                     │
│ [拒绝]                      [允许]  │
└─────────────────────────────────────┘
```

`kind: 'text'` 只换中间预览（命令或标题列表），外壳相同。

高风险模态：

```text
永久删除 reports/
可能无法恢复              高风险  ·  剩余 4:32

$ rm -rf reports

审批意见（可选）
[        ]

[拒绝]          [允许]   → 再点一次「再次确认允许」
超时自动拒绝 · 拒绝即不写
```

同一时刻既有例行又有高风险：抽屉列例行，模态叠在高风险那张上。决定仍逐条、仍走现有 `decideApproval`。

## Existing Producers（平台已有提交点）

翻译发生在这些 `propose` 调用处，**不是** `present()`。各提交点继续用自己的业务 payload 执行；同时填契约。

平台连接器写工具（今日即 `report.export`）在 agent-host 提供一个很小的 `writeToolPresentation(toolName, args)`：只为已知工具填 `summary`/`preview`，其它工具 `summary = toolName`、无 preview。`pi-runtime-tools`、`runTool`、`requestExportReport` 都走它，避免同一工具两套标题。

| 提交点 | payload（执行，不变） | 本轮填入契约 |
| --- | --- | --- |
| `edit` / `write` | `path`、`content`；Main `attachDiff` 仍写入 `payload.diff` 供执行/排查 | Pi `coding-tools` **只**填 `summary`（相对工作区的「修改 {rel}」/「写入 {rel}」），不填 `preview`。Main `broker.route` 仅当 `toolName === 'edit'\|'write'` 且 `preview` 为空，用**刚算出的** diff 字符串 `toPreviewLines(diff)`。禁止 `payload.diff` 泛扫描。 |
| `bash` | `command`、cwd、workspaceRoot | `coding-tools` 填 `summary`（命令首行，截 120）和 `preview: { kind: 'text', lines }`。broker 已有 preview 则不覆盖。 |
| `report.export`（Pi 工具、`runTool`、导出 IPC） | `title`、`sections`、format | 一律 `writeToolPresentation`：`导出《{title}》` 或「导出报告」；`preview.lines` = 非空 `heading`。 |
| 其他连接器写工具 | 该工具自己的参数 | `summary = toolName`；无 preview。禁止 `JSON.stringify(params)` 当标题。 |

`broker.route` **禁止**对任意 payload 扫描 `diff`/`command`/`sections` 来补 `preview`。新智能体在自己的 `propose()` 带齐字段，不要指望 broker 代填。已有 `preview` 则原样传递。

## Security & Invariants

- `present()` 是纯展示。批准/拒绝仍只认 Gate 状态；执行器仍只认权威批准。
- 截断不得修改 `payload` / `payloadHash`。`preview` 不参与哈希。
- Renderer 仍不能执行写；按钮仍走现有 IPC。
- 高风险二次确认不可跳过（`highRiskDoubleConfirm` 仍生效）。

## Acceptance

- 例行卡片：标题来自 `summary` 原文、预览来自 `preview.lines`（默认 ≤5 行）、拒绝/允许；无中风险徽标/可见倒计时/意见/工具名/UUID。隐藏到期仍会拒绝。
- 无 `preview` 时不出现假 diff / 假大纲。payload 里有 `diff` 但无 `preview` 时，预览区没有 `DiffView`。
- `present()` **不**因 payload 里有 `diff`/`sections` 就自动出预览——没带 `preview` 字段就不显示预览。
- 超过 5 行可展开，收起回到 5 行。
- 高风险走模态；先点允许不成决定，再点「再次确认允许」才批准。只剩高风险时不留空抽屉。
- `present()` 单测：原样 summary、截断计数、无 preview、diff vs text、高风险 chrome。不测路径剥离或 heading 抽取。
- 现有审批 UI 测试改新文案，并**反转**「payload.diff 即出 DiffView」。
- 不改 Gate / Executor / 安全不变量测试语义。
- `report.export` 无论经 Pi 工具、`runTool` 还是导出按钮，标题和大纲一致。

## Out of Scope Follow-ups

- 会话/本轮授权，降审批次数。
- 对话内联批准、停止自动弹抽屉。
- 例行超时改为暂停。
- 只读管道放宽、`mkdir` 合并进工作区写。
- 导出改为系统「保存」对话框。
- `always` 持久化、分类器。
