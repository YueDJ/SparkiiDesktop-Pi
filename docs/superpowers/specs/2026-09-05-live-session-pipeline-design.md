# Live Session Pipeline（起步 + 透传 + 与历史同源）— Design Spec

**Status:** Draft（第 1–4 条已和产品讨论锁定；第 5–7 条待逐条讨论）
**Date:** 2026-09-05
**Depends on:** 薄契约 / live-history 同源（`2026-09-02-agent-surface-template-and-contract-review-design.md`）；合同 JSONL 显示（`2026-09-03-contract-review-jsonl-display-design.md`）；Runtime ⊥ Viewport（`2026-09-04-runtime-viewport-decoupling-design.md`）
**Amends:** runtime-viewport spec 第 4、5 条里「回来只重读 JSONL、事件只是尾巴」——进程仍活着时，起步改为 `getBranch()` + `streamingMessage`，不是读磁盘。
**Does not replace:** JSONL 仍是**已提交、可持久化**的唯一事实；运行池管理与显示仍冻结；不按 agent id 分叉管道。

## Goal

通用聊天、合同审核、以及之后任何 Agent，共用同一条实时管道。live 已提交部分和从历史打开必须是同一套画面；live 只比历史多「当前这句还没入树」。管道对齐 Pi TUI：凡 TUI `subscribe` 能收到并处理的事件，全部原样透传，不裁功能。

合同审核「必须等跑完、切走再回来才看到结果」，是这条管道把 Pi 事件压扁、且没把未落盘的 in-flight 算进起步的症状，不是某个 Agent 自己的进度 IPC 缺失。

## Pi Facts（`@earendil-works/pi-coding-agent@0.84.4`）

| 名字 | 实际是什么 |
| --- | --- |
| RPC `get_session_entries` | `session.sessionManager.getBranch()`：当前 leaf→根的已 `_appendEntry` 节点（含 `custom` 步骤行） |
| `getBranch()` | 每次调用走一遍树，返回拷贝。不是订阅。无 compaction 时与 `buildContextEntries()` 相同 |
| `buildContextEntries()` | 同一条 path，若有 compaction 则切掉 `firstKeptEntryId` 之前的前缀。TUI 起步用这个当「给模型看的工作上下文」 |
| RPC `get_messages` | `session.messages` = `agent.state.messages`：喂给模型的线性对话。**不含**正在生成的 assistant，也**不含** `custom` 步骤行 |
| in-flight | `session.agent.state.streamingMessage`。`message_start` / `message_update` 覆盖全文；`message_end` 先清空它，再 `messages.push`，然后 `appendMessage` 入树 |
| JSONL | `fileEntries` 落盘。第一条 assistant 之前可能还不写文件；文件含 header 与废枝 |
| `entry_appended` | `appendCustomEntry` 之后需 `_emit` 才会进 subscribe（`pi.appendEntry` / 我们的 `appendCustomEntryAndEmit`）。`appendMessage` **不**发这条 |
| `message_end` vs 入树 | 事件先于 `appendMessage`。TUI 注释：此时树上可能还没有这句 |

`get_messages` 与 `getBranch()` 不是两份重复时间线：前者是 Agent 工作内存，后者是会话树。平台时间线不用 `get_messages`。

## Architecture

```text
Production（Pi 子进程）
  会话树 SessionManager + streamingMessage
  subscribe(AgentSession 事件)

        │  整包事件 + sessionId
        ▼

Pipeline（Electron main）
  扇入 N 个 slot，打 sessionId，送到当前窗口
  不另存一份权威时间线
  没在看的 session：只写文件，不在内存排队重放

        │
        ▼

Consumption（renderer / 各 Agent Surface）
  视口只折叠「当前这条 session」
  投影可丢；再进来重新起步
```

三层：

- **已提交真相：** Pi 会话树；落盘后即 JSONL 正文。
- **未提交真相：** `streamingMessage`（进程死了就没有）。
- **窗口列表：** 派生投影，不是第二真相源。对不上就再起步一次，整份换掉。

不把 slot 因为用户正在看而留下。不为合同另开进度通道。不为没在看的 session 重放 token。

---

## 第 1 条（已锁定）：起步合成

进程活着时 **不要读磁盘** 当起步。磁盘在首条 assistant 落盘前可能是空的，树上已有步骤行。

### 进程活着（slot 仍在）

```text
起步 = getBranch() + streamingMessage（可空）
之后 = subscribe（见第 2 条）
get_messages 不参与时间线
```

`getBranch()` 是当前分支上已 commit 的节点（含 `workflow_step_*`）。`streamingMessage` 是当前未入树的那句全文。没有 in-flight 就只有树。

不在每个事件上再调 `getBranch()`。`getBranch()` 只用于起步，以及第 6 条里的整树重建（compaction / 换 session / 投影对不上）。

**微缝：** `streamingMessage` 先清空，然后才 `appendMessage`。夹在中间读会两边都没有这句（此时 `get_messages` 里已经有）。主路径仍是树 + `streamingMessage`；这条缝若碰到，用 `get_messages` 最后一条 assistant 补一次即可，不是合成主源。

### 进程已死（slot 已释放）

```text
只读 JSONL 正文（去掉 type: session 的 header）
没有 preview
```

未落盘的那句按约定放弃。

### 从历史打开再续问

1. 打开时进程通常已死 → 用 JSONL 画已提交部分（与当时的树正文一致）。
2. 用户再发一句 → `pool.acquire` + `switch_session(同一 jsonl)`，进程用同一文件重建树。
3. **已画的留下**，开始 subscribe，只追加新事件。不要清屏、不要换成另一套数据、不要把 JSONL 里已有的行再插一遍。
4. 之后这条就是普通 live session。`mode: 'history'` 只表示从目录进来，不切断数据面（与 JSONL-display spec 第 4 条一致）。

同一 session、进程还活着时再点进列表：仍走「活着」起步，**不要**改读 JSONL。

### live 与历史必须一样的部分

已提交部分走同一套归一化。允许 live 多出来的只有流式槽里那句。不允许 live 一套扁事件、历史一套树节点。

`buildContextEntries()` **不**用于第 1 条起步。那是 compaction 后的工作上下文切片；压缩前的 `custom` 步骤行可能被切掉，live 会和 JSONL 历史分叉。是否两边一起切，留给第 6 条。

---

## 第 2 条（已锁定）：线上帧 = TUI 全量透传

仍走现有 `sparkii:event:chat-event`，每帧带 `sessionId`。不新开 IPC，不发明 `preview` / `committed` 两种新 `type`。

### 原则

管道是 Pi TUI `session.subscribe` 的透明转发。

禁止：

- 丢掉未知 `type`（今日 `normalizeEvent` 的 `unknown` 就是在裁）
- 改写成另一套形状（`message_update` → 只剩 `delta`；`tool_execution_*` → `tool_call` / `tool_result`；user 的 `entry_appended` → `{ role:'user', text }`）
- 按智能体裁事件。通用、合同、以后新 Agent 同一管道

窗口按 TUI `handleEvent` 投影。TUI 能画的，我们都要能画。渲染可以对齐分批做，但事件不得在管道里先砍掉。

### 必须原样透传

TUI `InteractiveMode.handleEvent` 用到的类型（字段跟 Pi，不要抽子集）：

`agent_start` · `turn_start` · `queue_update` · `entry_appended` · `session_info_changed` · `thinking_level_changed` · `message_start` · `message_update` · `message_end` · `bash_execution_update` · `tool_execution_start` · `tool_execution_update` · `tool_execution_end` · `agent_end` · `agent_settled` · `compaction_start` · `compaction_end` · `auto_retry_*` · `summarization_retry_*`

关键字段：

- `message_*`：完整 `message`。`message_update` 里的 `assistantMessageEvent` 留下，**投影用 `message` 全文换槽，不用 `delta` 拼接**。
- 工具三件套：`toolCallId` / `toolName` / `args` / `partialResult` / `result` / `isError`。
- `entry_appended`：完整 `entry`（`id` / `parentId` / `type` / `customType` / `data`…）。

Pi 以后新加、TUI 会处理的类型：默认同样整包转发，不要再维护一份允许名单去裁。

`normalizeEvent` 不再当裁剪层；最多加 `sessionId`。

### 投影（与 TUI 对齐）

起步之后：

| 事件 | 投影 |
| --- | --- |
| `message_start` assistant | 新建流式槽，内容 = `message` |
| `message_update` | 槽里整句换成 `message` |
| `message_end` | 再用全文刷一次，标完成，清槽指针；气泡留在列表。**不等树 id** |
| `message_start` user | 追加 user；随后同一次 `entry_appended`（`type:message` + user）丢掉 |
| `entry_appended` 且 `entry.type === 'custom'` | 已有 `entry.id` 则跳过，否则追加 |
| `tool_execution_start` | 按 `toolCallId` 开工具块 |
| `tool_execution_update` | 同一块上刷 `partialResult` |
| `tool_execution_end` | 最终结果并结束该块 |
| `compaction_end` 成功 | 第 6 条整树重建 |

`delta` 仍是 Pi 内部「这一 tick 新字」，不到消费侧当合成规则。漏拍时下一帧全文会把槽校正过来。

assistant 不在 `message_end` 后再等一条带 id 的树节点才显示（TUI 也不等）。custom 才按树 `id` 去重。

### 场景（合同 `review` 正在生成）

起步已有 load 步骤行 + user「请审核合同」。随后：

1. `message_start` assistant → 空流式槽
2. `message_update` 全文 `"第3条"`，再一拍全文 `"第3条存在期限不对齐"` → 槽整格替换
3. `message_end` 全文定稿 → 气泡就地完成
4. `entry_appended` `{ type:custom, id:c4, customType:workflow_step_end, data:{ stepId:review, output } }` → 按 id 追加；合同卡片投影 `output`

今日 `message_update` 只剩 `delta`，晚订会拼残句；步骤行若被裁成 `unknown`，live 卡片不动、历史打开 JSONL 却看得到。

---

## 第 3 条（已锁定）：一次打开 = 先订、缓冲、一次快照

跨进程后，`invoke` 返回值和 `chat-event` 没有顺序保证。TUI 同进程同步绘制，不需要缓冲；我们需要，但这是下限，不是第二套合并代数。

```text
1. 开始听 chat-event，先放进缓冲，不画
2. 等这一次起步 RPC（getBranch + streamingMessage；进程已死则 JSONL）
3. 若这次打开已取消 / 换了 session → 快照丢掉，缓冲丢掉
4. 快照铺底
5. 缓冲按第 2 条叠上去（custom 按 id 去重）
6. 之后只走事件，不再用这次打开的快照
```

一次打开只应用 **一次** 快照。过期用 generation / 取消标志整份丢弃，不做「晚到快照按 id 并集、槽已有则保留」的补洞合并。第二次整表换树（compaction / 换 session）是第 6 条。

流式槽：每个 `sessionId` 最多一格，无树 id。快照里的 `streamingMessage` 和缓冲里的 `message_*` 是同一格。禁止先画事件再让快照整表覆盖。

---

## 第 4 条（已锁定）：步骤行投递失败必须暴露

步骤行 = workflow 引擎写入的 `workflow_step_start` / `workflow_step_end`（`stepId`、状态、`output` / `error`）。合同卡片的进度和结果从这些行投影。Agent 复核用的 `workflow_state` 走同一 `append_workflow_entry`，那条 IPC 失败已经 throw；本条要改的是循环里对 start/end 的空 `catch`。

```text
append_workflow_entry 必须等到 success
失败 → 这一步没记下，不能跑下一步
     → logger.error（sessionId、stepId、customType、错误、output 字节数；不写整份 output）
     → 现有错误中心一句人话
     → 能写则补一条很小的 step_end failed（不要再带那份巨大 output）；连这个也写不上就停循环
release 前，这一轮最后一次 append 必须结束（成功或已按上面报失败）
output 不准静默截断（截断会造成 live/历史缺 findings）
```

日志走现成 `Logger`（`sparkii.log.jsonl`）。成功用 `debug`；失败用 `error`。写盘失败不阻断主流程。不新开文件、不把 `output` 拆到侧车。

---

## 明确不做（全篇）

- 为没在看的 session 重放 token
- 因视口盯着而不释放 slot
- 合同专用进度 IPC / `sparkii:event:workflow` 当时间线
- 保证进程死后仍能看到未落盘的那句
- 主进程把 preview 代写进 JSONL
- 三路按 id 投票（JSONL / `getBranch` / `get_messages`）
- 用 `get_messages` 当 UI 时间线主源
- 用 `delta` 表示「从上次落盘到现在」
- 起步用 `buildContextEntries()` 而历史读全文 JSONL（会分叉）
- 一次打开对晚到快照做补洞并集（过期快照整份丢弃即可）
- 步骤行 append 失败用空 catch 吞掉，或静默截断 `output`

---

## 待讨论（第 5–7 条）

1. ~~Catch-up：磁盘 vs `getBranch` vs `get_messages`~~ **已锁定（第 1 条）**
2. ~~线上帧形状~~ **已锁定（第 2 条）**
3. ~~Listen-then-snapshot~~ **已锁定（第 3 条）**
4. ~~步骤行投递失败~~ **已锁定（第 4 条）**
5. **Slot 被另一条 session 复用：** 停止给旧 `sessionId` 打标，禁止串话
6. **Compaction / Pi 崩溃 / 退出：** 何时 `buildContextEntries` 重建；崩溃后只认文件
7. **消费契约：** 合同必须投影哪些 `customType`；忽略 vs 空白

第 5 条起继续逐条讨论，通过后再补进本文 Confirmed 段。
