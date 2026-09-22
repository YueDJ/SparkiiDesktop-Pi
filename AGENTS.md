# AGENTS.md

## 子 agent 任务交接（本仓库约定）

本工作区在 **Codex Desktop + DeepSeek provider**（`wire_api = "responses"`）下运行，存在一个已知限制：
父线程发给子 agent 的协作 payload 被放进 `encrypted_content`（Responses API 的 content part），
DeepSeek 通路不渲染它，子 agent 只会收到一个**空信封**（`Message Type: NEW_TASK … Payload:` 后面为空）。
因此本仓库改用**文件交接**，它走纯文本通道、逐字无损：

若 `.codex-handoff/CURRENT.md` 存在，且其首部含 `status: open`：

- **你的任务就是该文件的正文**：逐字执行，不要改写、概括、补全或"优化"需求；
- 文件里的路径、命令、数值、验收标准都是权威内容，按原样使用；
- **不要修改或删除该文件**（由父线程在收活后清理/标记）；
- 在最终回复里引用该文件的 `task-id`。

其他情况（文件不存在，或 `status: consumed`）：忽略本节，按常规流程工作。
