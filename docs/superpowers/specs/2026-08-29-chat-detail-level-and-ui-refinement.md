# Chat Detail Level and Timeline Refinement

## Goal

让通用聊天界面的信息展示可切换为“简洁 / 标准 / 调试”三档，同时将 Pi 生命周期事件和工具调用改成更轻、更贴边的视觉形态，减少对聊天流的打断。

## Scope

本 spec 只覆盖前端展示与全局设置：

- 新增全局聊天信息详细程度设置，保存到现有 `settings.json`。
- 按详细程度过滤 `ChatEntry` 的渲染，不删除、不重写底层事件数据。
- 将生命周期事件从居中大卡片改为左对齐轻量时间线条目。
- 将工具调用改为默认单行折叠，详情在展开时显示。
- 历史会话复用同一渲染路径，不需要迁移数据。

本 spec 不覆盖：

- session 级别的详细程度设置。
- 后端事件采集、Pi 运行时日志格式变化。
- 消息正文、Markdown、Composer 的重新设计。

## Detail Levels

### 简洁（minimal）

- 用户消息：显示。
- 助手消息：显示。
- 运行时错误：显示。
- 需要审批的工具调用：显示。
- 其他工具调用：隐藏。
- 其他 Pi 生命周期事件：隐藏。

### 标准（standard，默认）

- 用户消息、助手消息、运行时错误：显示。
- 工具调用：每条独立显示，默认折叠为一行，可展开详情。
- 上下文压缩：显示 `compaction_start`、`compaction_end`、`compaction`。
- 用户/智能体产生的摘要与标记：显示 `custom_message`、`branch_summary`、`session_info`、`custom`、`label`。
- 会话生命周期、模型切换、思考强度调整、轮次开始/结束、自动重试、摘要重试：隐藏。

### 调试（debug）

- 显示所有 `ChatEntry`。
- 工具调用默认展开详情，便于查看输入、结果和 diff。

## Event Visibility Matrix

| Event | 简洁 | 标准 | 调试 |
| --- | --- | --- | --- |
| message | 显示 | 显示 | 显示 |
| runtime_error | 显示 | 显示 | 显示 |
| agent_start | 隐藏 | 隐藏 | 显示 |
| agent_end | 隐藏 | 隐藏 | 显示 |
| agent_settled | 隐藏 | 隐藏 | 显示 |
| compaction_start | 隐藏 | 显示 | 显示 |
| compaction_end | 隐藏 | 显示 | 显示 |
| compaction | 隐藏 | 显示 | 显示 |
| custom_message | 隐藏 | 显示 | 显示 |
| branch_summary | 隐藏 | 显示 | 显示 |
| session_info | 隐藏 | 显示 | 显示 |
| custom | 隐藏 | 显示 | 显示 |
| label | 隐藏 | 显示 | 显示 |
| turn_start | 隐藏 | 隐藏 | 显示 |
| turn_end | 隐藏 | 隐藏 | 显示 |
| model_change | 隐藏 | 隐藏 | 显示 |
| thinking_level_change | 隐藏 | 隐藏 | 显示 |
| auto_retry_start | 隐藏 | 隐藏 | 显示 |
| auto_retry_end | 隐藏 | 隐藏 | 显示 |
| summarization_retry_scheduled | 隐藏 | 隐藏 | 显示 |
| summarization_retry_attempt_start | 隐藏 | 隐藏 | 显示 |
| summarization_retry_finished | 隐藏 | 隐藏 | 显示 |

工具调用的可见性：

| 工具状态 | 简洁 | 标准 | 调试 |
| --- | --- | --- | --- |
| awaitingApproval | 显示 | 显示 | 显示 |
| 结果包含非零 exitCode、`ok: false`、`success: false` 或 `error` | 显示 | 显示 | 显示 |
| 其他工具调用 | 隐藏 | 显示 | 显示 |

## UI Requirements

### Lifecycle Event

- 左对齐，不再 `align-self: center`。
- 不显示大卡片背景、阴影和最小宽度。
- 使用细小的左侧状态色条、小图标、小字号。
- 标签与详情保持同一视觉层级，状态徽标仍保留。

### Tool Call

- 头部为单行：图标、工具名、摘要、状态徽标、展开按钮。
- 展开按钮不再单独占一整行。
- 默认折叠；调试档默认展开。
- 宽度与消息、生命周期事件一致，最大宽度为 `min(680px, 92%)`。

## Settings

- 设置在“智能体与运行”面板中。
- 字段名：`chatDetailLevel`。
- 类型：`'minimal' | 'standard' | 'debug'`。
- 默认值：`'standard'`。
- 持久化位置：现有 `settings.json`。
- 读取入口：`SparkiiApi.getSettings()`，与现有设置读取方式一致。

## Data Integrity

- 过滤只发生在渲染层，不修改 `ChatEntry[]`。
- 切换详细程度后，已发生的调试事件仍能从原数据重新显示。
- 历史会话打开时仍通过 `normalizeHistoricalSessionEntries` 或 `normalizeMessages` 归一化，然后走同一过滤与渲染逻辑。

## Acceptance Criteria

- “智能体与运行”设置面板中可以保存“简洁 / 标准 / 调试”三档之一。
- 默认详细程度为“标准”。
- 标准档不显示模型切换事件，调试档显示。
- 简洁档只显示消息、运行时错误和需要审批或失败的工具调用。
- 工具调用默认折叠，调试档默认展开，且展开按钮与工具头部同处一行。
- 生命周期事件不再居中，历史会话打开后自动使用新样式。
- 相关单元测试与现有桌面测试全部通过。
