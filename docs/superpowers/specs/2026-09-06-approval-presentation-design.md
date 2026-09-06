# 审批展示（平台）— Design Spec

**Status:** Draft（待用户审阅；本轮只写规格，不改运行时）
**Date:** 2026-09-06
**Depends on:** `PRODUCT.md`（无事不打扰，有事必清楚；写操作必须人工把关）；`DESIGN.md` Approval Ritual；`packages/approval` 提案模型
**Amends:** `DESIGN.md` Approval Ritual 的例行字段清单；`docs/superpowers/specs/2026-08-25-sparkii-desktop-ux-design.md` §4 审批条目的例行呈现

## Goal

把「一条提案在审批 UI 里长什么样」收成**平台规则**，所有智能体提交的审批都走同一套呈现，而不是按智能体或工具名写卡片。

本轮只改**弹出内容**：标题、可审物件、按钮文案、例行/高风险各显示哪些字段。不改何时弹、弹几次、会不会自动拉开抽屉、超时是否拒绝。

硬约束不变：提议与执行分离、拒绝即不写、参数在提议时冻结、全程审计。

## Confirmed Decisions

1. **展示只读提案已有字段，不按 `toolName` / `profileId` 分支。** 新智能体不必为审批再提炼标题或章节；也不新增 `preview` / `headline` 之类字段。
2. **标题就是 `summary`。** 平台原样显示。唯一允许的加工：若上下文里有工作区根路径，剥掉 `summary` 里的该绝对前缀。模型不写审批文案。
3. **可审物件只认 payload 上三个约定键，按固定顺序取第一个命中：** `diff` → `command` → `sections`。都没有：卡片只有标题和按钮，不把整份 JSON 当正文。
4. **默认可审物件最多 5 行，可展开看全部。** `diff` / `command` 按换行计；`sections` 计标题行。超出显示「还有 N 行 · 展开」。展开后可收回到 5 行。没有第三档，也不按智能体调额度。
5. **按钮文案统一为「拒绝」「允许」。** 高风险第二次确认为「再次确认允许」。不用「先别」「先不」「批准」。
6. **外观只看 `risk`。** `write` 为例行抽屉；`high-risk` 为居中模态 + 二次确认，并显示高风险徽标、倒计时、审批意见。例行不显示「中风险」、倒计时、审批意见、工具名、目标系统、会话 UUID。
7. **「技术细节」始终存在、默认关上**，内容是冻结 payload 的 JSON。这是排查入口，不是默认可审物件。
8. **智能体的调用面仍是现有 `ProposalRequest`。** 便利来自约定，而不是新 API：把人话写进 `summary`，把要给人看的东西放进三个键之一。

## Non-Goals

- 不改审批频率、会话授权、`evaluate` 规则表、只读白名单。
- 不改自动弹出抽屉、聊天 ToolCard 就地批准。
- 不改超时自动拒绝（例行只是不把倒计时放在主视觉）。
- 不让模型为审批生成摘要或大纲。
- 不把合同导出改成系统保存对话框（那是后续切片）。
- 不为单个智能体写 `if (toolName === …)` 展示模板。

## Current State

今日所有写提案（通用智能体的 `bash` / `edit` / `write`、合同审核的 `report.export`、以及以后任意 `sideEffect !== read` 的工具）都进同一套 UI：

- 抽屉标题固定「写操作审批」。
- 卡片展示 `summary`、工具名、目标、会话短 ID、「中风险」、倒计时、「冻结参数」JSON、审批意见、「拒绝 / 批准」。
- `payload.diff` 已有，但藏在「冻结参数」里，默认不展开；且当前 diff 经常是整份文件对照，一打开就很长。
- `ApprovalModal` 已实现高风险二次确认，但壳层 `App.tsx` 实际只挂 `ApprovalPanel`，高风险也走抽屉。
- `summary` 由各提交点各自拼接（`edit C:\…\a.txt`、命令原文、`JSON.stringify(params)`），平台没有统一呈现函数。

问题是呈现，不是门。Gate / Executor / 审计保持原样。

## Platform Contract（智能体怎么提交）

提交通道不变：

```ts
interface ProposalRequest {
  toolName: string;
  targetSystem: string;
  summary: string;
  payload: unknown;
  risk: 'write' | 'high-risk';
}
```

平台呈现**不读取** `toolName` / `targetSystem` 来决定卡片长什么样。这两个字段继续进提案和审计，只是例行 UI 不展示。

### 标题：`summary`

提交端写一行人话后果，例如「新建 hello.txt」「运行 mkdir -p reports」「导出《采购合同审核报告》」。

约定：

- 说后果，不要用工具名当动词前缀（不要 `edit …` / `write …`）。
- 路径尽量相对工作区；平台会再剥一次工作区绝对前缀（若提供）。
- 写不好就原样显示，没有第二套文案表，也没有 LLM 改写。

### 可审物件：payload 三个键

payload 是普通对象时，按下面顺序取**第一个存在且可用**的键。只展示这一种。

| 键 | 可用条件 | 默认展示 | 现有谁已经在填 |
| --- | --- | --- | --- |
| `diff` | 非空字符串 | 按行截断的文本 diff（沿用现有 `DiffView` 着色） | 平台对 `edit` / `write` 已在 Main 附加 |
| `command` | 非空字符串 | 等宽命令文本 | `bash` |
| `sections` | 非空数组 | 每个元素的 `heading`（trim 后非空才算一行） | `report.export` |

`content`、`cwd`、`workspaceRoot`、`path`、章节 `body`、表格行**都不是**默认可审物件。它们留在冻结 payload 里，需要时进「技术细节」。

`sections` 里没有 `heading` 的元素跳过。数组为空或没有可用标题 → 视为未命中，继续往后找；三个都未命中则无预览。

不要为审批单独再生成一份大纲。导出报告的 `sections` 是**真正要写进文件的参数**，平台只把已有 `heading` 列出来。

### 可选上下文（不是新提案字段）

呈现函数可以接收：

```ts
type PresentContext = {
  workspaceRoot?: string;
};
```

仅用于从 `summary` 里剥路径前缀。智能体不必、也不该为此改 `ProposalRequest`。桌面壳从当前会话工作区传入即可。

### 新智能体清单

新工具要对齐审批展示，只做这三件事：

1. 写好人话 `summary`。
2. 若有可审内容，放进 `diff` 或 `command` 或 `sections`（已有参数对上即可，不要复制一份 UI 专用 payload）。
3. 破坏性操作设 `risk: 'high-risk'`；其余写操作为 `'write'`。

不调用呈现函数、不注册卡片模板、不要求用户再确认「标题和章节是否已提炼」。

## Presentation Function

所有审批表面只通过一个纯函数得到视图模型，禁止在 `ApprovalPanel` / `ApprovalModal` / `ApprovalCenter` / `HomeView` 里各自拼接字段。

建议位置：`apps/desktop/src/trust/present.ts`（与现有审批 UI 同层）。不要放进某个 Agent 包。`packages/approval` 继续只负责提案状态机、门、执行器、审计。

```ts
type PreviewKind = 'diff' | 'command' | 'outline' | 'none';

type ApprovalViewModel = {
  title: string;
  subtitle: string | null;          // 仅 high-risk：「可能无法恢复」；例行为 null
  preview: {
    kind: PreviewKind;
    lines: string[];                // 未截断的全部行
    visibleLines: string[];         // 默认 min(5, lines)
    hiddenCount: number;            // max(0, lines.length - 5)
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
    confirmAllow: '再次确认允许';     // 仅 high-risk 第二次
  };
};
```

规则：

- `title`：`summary`（剥工作区前缀后）。空 summary 时显示「需要你确认」，不回退到 toolName。
- `preview.lines`：`diff`/`command` 按 `\n` 拆行，去掉末尾空行；`sections` 为标题列表。
- 默认 5 行是**展示**截断，不改冻结 payload，也不改现有 `computeEditDiff`。
- `risk === 'high-risk'` → `mode: 'modal'`，`showRisk/showCountdown/showNote = true`。否则抽屉，三者均为 false。
- 例行副文案不做「将写入当前工作区」这类按工具猜的句子（那会滑回工具分支）。高风险固定一句「可能无法恢复」。

展开状态是各卡片的局部 UI state，不进提案。

## Surfaces

| 表面 | 本轮怎么用 ViewModel |
| --- | --- |
| 右侧抽屉 `ApprovalPanel` | 例行提案。标题区改为「需要你确认」；队列「N 处改动等你看」。每张卡：title、preview、技术细节、拒绝/允许。保留「当前会话 / 其他会话」分组；分组标题可以留，卡片正文不再写会话 UUID。 |
| 居中模态 `ApprovalModal` | 只渲染 `chrome.mode === 'modal'` 的提案。壳层若尚未挂上，本轮一并按 `present()` 的 `mode` 挂上。 |
| 审批中心 `ApprovalCenter` | 列表行用 `title`；高风险才显示风险徽标和倒计时；不再用 toolName、会话短 ID、「中风险」当主信息。 |
| 首页「待你处理」 | 同上，点进仍打开审批。 |

聊天里的 ToolCard 仍只显示「等待审批」，本轮不在对话内批准。

壳层文案：

- 抽屉标题：需要你确认
- 队列摘要：暂无待确认 / N 处改动等你看
- 技术细节开关：技术细节 ▸ / ▾（替代「冻结参数」）
- 空态：没有待确认的事项

## Layout

例行卡片：

```text
需要你确认                         2 处改动等你看
当前会话

┌─────────────────────────────────────┐
│ 新建 hello.txt                       │
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

`command` 与 `outline` 只替换中间预览块，外壳相同。`outline` 一行一个 `heading`，默认最多 5 个标题。

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

这些是平台自己的提交端，实现本 spec 时应把 `summary` 收到人话，但**不要**为它们做专用卡片。

| 提交点 | 已有 payload | 本轮对 summary 的期望 |
| --- | --- | --- |
| `edit` / `write`（`coding-tools` + Main `attachDiff`） | `path`、`content`、`diff` | 「修改 {相对路径}」/「新建 {相对路径}」；预览走 `diff` |
| `bash` | `command`、cwd、workspaceRoot | 可用命令本身（可截到合理长度）或「运行 {command 首行}」；预览走 `command` |
| `report.export` | `title`、`sections` | 已有「导出合同审核报告：…」可收成「导出《{title}》」；预览走 `sections` |
| 其他连接器写工具 | 参数对象 | 提交点自己写 `summary`；有 diff/command/sections 则自动有预览，否则无预览 |

`JSON.stringify(params)` 当 summary 的通用连接器路径（`pi-runtime-tools` / workflow broker）应改为：优先短人话（已有 summary 字段），不要把整份参数 JSON 当作标题。本轮至少保证：标题不再是一长串 JSON；预览仍只来自三个约定键。

## Security & Invariants

- `present()` 是纯展示。批准/拒绝仍只认 Gate 状态；执行器仍只认权威批准。
- 截断不得修改 `payload` / `payloadHash`。
- Renderer 仍不能执行写；按钮仍走现有 IPC。
- 高风险二次确认不可跳过（`highRiskDoubleConfirm` 仍生效）。

## Acceptance

- 任意智能体提交的 pending 提案，例行卡片都符合：人话标题、至多一种预览、默认 ≤5 行、拒绝/允许、无中风险/倒计时/意见/工具名/UUID。
- 带 `diff` / `command` / `sections` 的提案分别出现对应预览；三者都无时不出现假大纲。
- 超过 5 行可展开看全部，收起回到 5 行。
- 高风险走模态，先点允许不变成决定，再点「再次确认允许」才批准。
- `present()` 有单测覆盖：三键优先级、空 payload、截断计数、高风险 chrome、工作区前缀剥离。
- 现有审批相关 UI 测试改为断言新文案；不改 Gate / Executor / 安全不变量测试。
- 合同审核导出、通用智能体写文件/跑命令，都不需要为审批新增提炼步骤。

## Out of Scope Follow-ups（明确留给后续，不写进本轮实现）

- 会话/本轮授权，降审批次数。
- 对话内联批准、停止自动弹抽屉。
- 例行超时改为暂停。
- 只读管道放宽、`mkdir` 合并进工作区写。
- 导出改为系统「保存」对话框。
- `always` 持久化、分类器。
