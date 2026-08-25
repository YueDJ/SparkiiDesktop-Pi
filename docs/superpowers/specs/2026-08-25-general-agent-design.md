# 通用智能体（General Agent）设计规格

- 日期：2026-08-25
- 状态：设计决策已与用户逐项确认，本文档待用户审阅
- 范围：Sparkii Desktop 第二个智能体「通用智能体」——Codex 风格对话界面 + 会话工作区内的编程能力

## 1. 目标与定位

在现有合同审核 pilot（任务流表面）之外，新增一个**通用智能体**（profile id：`general`，界面名「通用智能体」）。它提供类 Codex 的对话界面：既能纯问答，也能在**会话工作区**内编程——读代码、搜索、跑命令、改文件、git 操作、跑测试。所有写操作沿用产品硬约束「提议—执行分离」：**只读免审批，写必逐条审批，拒绝即不写**，全程审计。

设计遵循产品原则：权威状态是唯一事实源（工具执行结果来自主进程/审计，LLM 叙述只是旁注）；配置驱动、壳层同构；安全合规层（审批/审计/RBAC）全局共享。

### 现状差距（从现状到目标）

| 现状 | 目标 |
| --- | --- |
| 运行时只加载单个 profile（合同审核） | 多 profile 加载；统一进程池 + 会话级配置（鞍） |
| `sparkii:prompt(text)` 一次性会话，用完即弃 | 持久会话：注册表 + Pi session 文件 + 恢复 |
| Pi 子进程工具被覆写为只读连接器工具 | 统一进程池 + 鞍：合同审核只注册连接器工具；通用智能体注册编码工具（写操作经 Main） |
| ChatWorkbench 未接入（裸输入框） | GeneralChatSurface 落地（C1 规格扩展） |
| 审批门单策略、单 RBAC | 按 profileId 查策略/RBAC |
| 模型任务只有 chat/extract/report/default | 增加 `coding` 任务；Composer 内模型选择器 |

> 现状代码依据：`packages/agent-host/src/pi-sdk-runtime.ts` 的 `adaptSession()` 直接覆写 `session.agent.state.tools = [...piTools, readTool]`，把 Pi 默认编码工具（bash/edit/write）整体替换为三连接器工具 + read。本次把这种「子进程特例」消除：统一内核 + 鞍装配（§5.3、§6.1）。

## 2. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 默认工作区 | 每会话打开时**计算并记录**路径 `桌面/Sparkii<4位随机字母数字><YYYYMMDDHHmm>`（时间=会话打开时刻，精确到分钟），**不创建目录** |
| 懒创建 | 全程无写操作 → 文件夹不出现；首个写操作被批准后由主进程执行器先 `mkdir` 再执行 |
| 用户指定工作区 | Composer 上方提供工作区选择，会话级优先；已存在直接使用，不存在则同样首次写时创建 |
| 写审批 | 逐条审批，命令/diff 预览；只读免审批；拒绝/超时即不执行 |
| 会话槽位 | v1 会话打开期间占用进程槽位；空闲超时回收留后续 |
| 模型选择 | Composer 内模型下拉：默认「默认（跟随配置）」；用户选择会话级粘性生效并持久化 |
| 模型路由 | `coding` 任务配 deepseek-v4-pro 优先 + deepseek-v4-flash 兜底 |
| 界面名 | 「通用智能体」 |
| 设置页任务路由接线 | **不纳入本次**（用户模型选择权落在 Composer） |

## 3. 架构总览

```
Renderer
  ├─ GeneralChatSurface（消息流 + 工具卡片 + 模型/工作区选择 + 会话抽屉）
  ├─ 审批面板/模态（含 diff 预览）· 审批中心 · 审计
  │
  ▼ Electron IPC（typed，新增会话/模型/工作区接口）
Main Process
  ├─ profiles: Map<profileId, { profile, router, rbac }>   ← 多 profile 加载
  ├─ ApprovalGate（按 profileId 查策略/RBAC）· AuditStore（全局）
  ├─ ChatSessionStore（SQLite）· GeneralExecutor（bash/edit/write 确定性执行）
  └─ PiRuntimePool（统一加固 Pi 子进程池，上限 4）
        └─ Pi 子进程（同一份运行时；工具按鞍注册，cwd=会话锚点目录）
              bash/edit/write 执行后端**固定路由 Main**（池级系统保障）
```

## 4. profile：`profiles/general/`

新配置包，结构与 contract-review 对齐：

```text
profiles/general/
  manifest.yaml     # name: general, displayName: 通用智能体, modelRouting
  agent/
    prompts/system.md   # 系统提示（身份/工作区规则/审批说明/行为准则）
    tools.yaml          # bash / edit / write（Pi 原生工具，执行后端委托 Main）
  security/
    roles.yaml          # reviewer/admin 可批准 write；admin 可批准 high-risk
    approval.yaml       # timeoutMs 300000, highRiskDoubleConfirm true
```

- `manifest.yaml`：`modelRouting.tasks` 配 `coding: [deepseek-v4-pro, deepseek-v4-flash]`、`default: [deepseek-v4-flash]`。`manifestSchema` 增加可选 `displayName`（渲染层展示名，缺省回退 `name`）。
- 系统提示要点（`agent/prompts/system.md`）：
  - 身份与通用能力：问答、代码阅读、命令执行、文件修改、git；
  - 工作区规则：会话工作区路径（未创建时提示「尚无写操作，文件夹尚未生成」）；用户指定优先；不得越界；
  - 审批说明：只读直接执行；写操作会弹出审批，需给出清晰、小步、可审的操作（先读后写、一次改动聚焦、说明理由）；
  - 行为准则：先勘察再动手；命令注意超时与输出量；git 写操作（commit/push/checkout 等）与破坏性命令（rm -rf、git reset --hard）会被标记为高风险。
- `roles.yaml`：`reviewer.canApprove: [write]`、`admin.canApprove: [write, high-risk]`（沿用现有角色模型；页面权限沿用 home/audit）。

### 4.1 合同审核鞍的迁移（业务不动，装配统一）

现有合同审核在子进程侧是特例：`pi-sdk-runtime` 硬编码注册三连接器 + read，无身份系统提示，cwd 无归属。统一池后收敛为与通用智能体同一条「profile 声明 → 工具注册表解析 → 鞍装配」路径：

| 项 | 现在 | 统一后 |
| --- | --- | --- |
| 工具 | pi-sdk-runtime 硬编码 document/knowledge/report + read | 按 `tools.yaml` 声明经注册表解析：`document.read / knowledge.search / report.export / read` |
| 系统提示 | 无身份提示 | 新增 `agent/prompts/system.md`（身份 + 流程 + 行为） |
| cwd | 进程启动目录 | 会话锚点目录（内部，无工作区 UI） |
| 审批/RBAC/模型路由 | profile 驱动 | 不变，由鞍自动携带 |
| workflow/skills/审计/ContractSurface | 已就绪 | **完全不动** |

约束：合同审核 pilot e2e 作为回归基线必须原样通过；不改变业务流程与审批语义。

## 5. 多 profile 运行时

### 5.1 assemble 与 Runtime

`assemble` 改为接收多个 profile：`{ profiles: [{ id, dir }], dataDir, ... }`，产出 `Runtime.profiles: Map<profileId, ProfileRuntime>`，其中 `ProfileRuntime = { profile, router, rbac }`。现有 `rt.profile` 单数引用改为 `rt.profileOf(profileId)` 或按调用处注入。

`apps/desktop/electron/main/index.ts`：开发环境扫描 `profiles/*/`，打包环境扫描 `resourcesPath/profiles/*/`；新增 IPC `sparkii:listAgents` 返回 `[{ id, name }]`（来自各 profile 的 displayName）。

### 5.2 审批门多策略

`ApprovalGate` 从单 `{ policy, rbac }` 改为按 profileId 查找：

- 构造时接受空策略，新增 `configureProfile(profileId, { policy, rbac })`；
- `submit`/`decide`/`expire` 通过 `meta.profileId` / proposal 的 `profileId` 查对应策略与 RBAC（超时、可批准风险级均按 profile 生效）；
- `Proposal` 已携带 `profileId` 与 `sessionId`，审计可回溯，无需改动。

### 5.3 统一进程池 + 会话级「鞍」（configure_session）

- 所有 Pi 子进程以**完整内核**启动，不预装任何 profile 的工具/skills；槽位不绑定 profile，可跨智能体复用。
- **池级系统保障（与鞍无关）**：子进程是加固的统一 Pi——内核能力完整、不裁剪，但 `bash`/`edit`/`write` 的 operations 在子进程运行时层面**固定路由 Main**；无论鞍如何配置（甚至配置失败），有风险操作的审批与执行都由 Main 完成，子进程在任何情况下都不拥有本地写原语。鞍只决定工具**可见性**（注册哪些工具）、skills、cwd/工作区、系统提示与模型。
- `PiRuntimePool.acquire(sessionId, { profileId, resumeSessionFile?, saddle })`：空闲槽位直接复用；无空闲且未达 `SPARKII_MAX_AGENTS` 则新建；有上限时排队（沿用现有队列）。
- 会话绑定后 Main 发送新 RPC `configure_session`（载荷：工具清单、skillsDir、cwd/工作区、系统提示），子进程按鞍装配当前会话；继续会话（`switch_session` 恢复）时重发同一份鞍。
- 释放槽位：`new_session` 重置（清除会话与工具状态），槽位回到无 profile 状态；下个会话重新配置。
- 安全不变量：**未配置 = 无工具**（fail closed）；**鞍不残留**（释放即重置）；**写安全不依赖鞍**（池级兜底）；测试断言跨 profile 无泄漏。
- 取消 transports 按 profile 注入 env 的方案：skillsDir/cwd 等经 `configure_session` 下发，避免进程级全局 env 竞态。
- `pi-sdk-runtime` 按当前会话的鞍装配工具：经注册表解析工具清单，区分连接器工具与编码工具（见 §6）。

## 6. 通用智能体工具集（coding 模式）

### 6.1 统一工具注册表与鞍装配

所有工具定义集中在**统一工具注册表**，按名字解析，分两侧：

| 侧 | 内容 | 用途 |
| --- | --- | --- |
| 子进程侧工具目录（agent-host） | 名字 → 工具定义：Pi 原生（read / ls / grep / find / bash / edit / write）+ Sparkii 连接器（document.read / knowledge.search / report.export） | 鞍装配时按名注册进当前会话；未选中的不注册 |
| Main 侧执行器目录（desktop main） | 名字 → 真实执行 handler：report.export、bash、edit、write（含连接器既有 handler） | 审批通过后由 Main 确定性执行 |

Sparkii 连接器工具行为（业务层，非 Pi 内核）：

- `document.read`（read）：解析本地文档为纯文本——PDF（pdfjs-dist）/ DOCX（mammoth）/ XLSX（xlsx 转 CSV）/ txt/md/csv；
- `knowledge.search`（read）：本地法规知识库 BM25 检索（profile `agent.knowledge` 语料，启动时载入内存）；
- `report.export`（write）：把审核结论导出为 Word（docx 库生成），当前仅 `format: docx`，审批后由 Main 写文件。

鞍装配流程：profile `tools.yaml` 声明工具名 → 子进程侧目录解析（未知名报错，fail closed）→ `configure_session` 下发 → 子进程把选中的定义注册进当前会话。

**未选中工具为何不可见、不可调（内核强制，非提示词约束）**：

- 看不见：Pi 每轮只把**已注册工具**的 schema 放入模型请求，未注册的定义不进上下文；
- 调不到：agent 循环按工具名在注册表 dispatch，未命中直接报错，不执行任何东西；
- 即使注册了写工具，执行也只在 Main（见 §6.2–§6.4）。

#### 通用智能体鞍注册的工具（coding 模式）

| 工具 | 行为 | 审批 |
| --- | --- | --- |
| read / ls / grep / find | Pi 原生只读工具，本地执行；包装层做路径白名单与「工作区未创建」提示 | 免审批（审计 tool.read） |
| bash | Pi 原生工具定义 + `BashOperations.exec` 委托 Main | 只读白名单免审批；其余审批 |
| edit | Pi 原生工具定义 + `EditOperations` 委托 Main | 必审批，带 diff |
| write | Pi 原生工具定义 + `WriteOperations` 委托 Main | 必审批，带 diff |

注册进子进程的就是 **Pi 原生工具定义本身**：`createBashToolDefinition` / `createEditToolDefinition` / `createWriteToolDefinition`，工具名与 schema 与 Codex 完全一致；仅通过 Pi 官方提供的可插拔 operations 插槽（`BashOperations.exec`、`EditOperations.readFile/writeFile/access`、`WriteOperations.writeFile/mkdir`，官方注释即「委托到远程系统执行」的用途）把**真正的执行**委托给 Main。参数校验、diff 生成（edit）、输出截断、tool_call/tool_result 事件、渲染信息仍由 Pi 原生处理。

子进程内**没有可执行的写原语**：operations 的实现只发请求等决定；真实执行全部发生在 Main 侧确定性执行器。这条 operations→Main 路由是**池级统一运行时的一部分**，对每个 profile/鞍都成立（合同审核也一样，只是它的鞍不把 bash/edit/write 注册给模型可见）。沿用现有 proposal 通道（proposal envelope → Main → decision envelope 回传）。被拒绝时：edit/write 的 operations 抛错、bash 返回拒绝标记，工具结果呈「未执行」，不会出现「显示成功但没写」。

### 6.2 bash 命令分类（Main 侧，安全相关逻辑不放子进程）

`bash` 经 `BashOperations.exec` 到达 Main 后，由 `isReadOnlyBashCommand(command)` 判定：

- **只读判定（严格）**：单条命令；不含 shell 元字符（`;` `&&` `||` `|` `>` `>>` `<` `$(` `)` 反引号、换行、`&`）；整命令以白名单前缀开头（实现时可扩展，只增不减）：
  - 文件：`ls` `cat` `head` `tail` `wc` `grep` `rg` `cut` `sort` `uniq` `diff`
  - 环境/信息：`pwd` `echo` `which` `type` `env` `date` `printf` `true` `false`
  - git 只读：`git status` `git diff` `git log` `git show` `git branch` `git stash list`（仅状态/历史查询；索引刷新视为内部行为）
- 命中 → Main 直接执行，输出经 `onData` 流回 Pi（工作区未创建时返回「工作区尚未创建（尚无写操作）。请先让智能体创建文件，或在输入框上方指定工作区。」），审计 `tool.read`，不弹审批。
- 未命中 → `gate.submit`（`risk: write`；破坏性模式如 `rm -rf`、`git reset --hard`、`drop`、格式化命令标记 `high-risk`，触发二次确认）。
- 白名单是**精确前缀/整命令匹配**，任何含元字符或未知动词的命令一律走审批——宁可多审，不可漏放。

> 不纳入白名单的常见例子：`find`（可带 `-exec` 执行写操作）、`sed`（可带 `w`/`i` 写文件）、`awk`（可重定向或调系统命令）、`tr` 等；需要时一律走审批。

### 6.3 edit / write 与 diff 预览

- 提议载荷（冻结）：`{ path, args, diff }`。Main 在提交提案前**只读地**计算 diff（Pi 侧也会为自己的结果展示计算一份 diff，两者并存；审批展示以 Main 计算为准）：
  - edit：读现有文件 → 按 old_string 匹配位置生成 unified diff（`generateUnifiedPatch` 复用 Pi 能力或自实现等价逻辑）；
  - write：新文件 = 全量新增行；覆盖 = 删除旧全文 + 新增新全文；
  - 路径不在工作区内或 `..` 逃逸 → 直接拒绝（`CONNECTOR_DENIED` 语义），不产生提案。
- 审批面板渲染 `payload.diff`（见 §9）。
- 批准后执行：`ensureWorkspace()`（首次写时 `mkdir -p` 工作区根，桌面文件夹在此刻出现）→ edit 按精确 old_string 匹配（不匹配则执行失败、错误回传模型重试）→ write 全量写入（父目录 `mkdir -p`）。

### 6.4 GeneralExecutor（Main 侧）

新文件 `apps/desktop/electron/main/general-executor.ts`，向 `ConnectorExecutor` 注册：

- `bash`：`child_process.spawn`（shell 执行），cwd=工作区根；**写命令**执行前先 `ensureWorkspace()` 创建目录；**只读命令**在工作区未创建时按 §6.2 返回提示、不创建目录；支持 `timeout`（默认 60s，超时 kill）；stdout/stderr 合并输出并经 `onData` 流回子进程，截断（上限 128KB，超限提示 `fullOutputPath` 语义，v1 只截断+提示）；返回 `{ exitCode, output, timedOut }`。
- `edit` / `write`：文件变更（见 §6.3），返回 `{ path, diff }`。
- 执行器通过 `ChatSessionStore` 由 `proposal.sessionId` 解析会话工作区；执行结果作为 proposal execution 回传子进程（沿用现有 proposal decision 通道）。
- 所有执行（含只读直通）写审计：`tool.read` / `proposal.created` / `proposal.approved` / `proposal.denied` / `proposal.executed` / `proposal.failed` / `workspace.created`，均带 `sessionId`、`profileId`。

## 7. 会话机制

### 7.1 ChatSessionStore

SQLite（dataDir/sessions.db，表 `chat_sessions`）：

```sql
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,            -- sessionId (uuid)
  profile_id TEXT NOT NULL,
  title TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,   -- 'auto' | 'user'
  workspace_path TEXT NOT NULL,
  model TEXT,                     -- 用户选择（可空 = 跟随配置）
  pi_session_file TEXT,           -- Pi session 文件路径（可空）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

默认标题：首条用户消息前 24 字符；无消息则为「会话 MM-DD HH:mm」。

### 7.2 工作区路径

- 自动工作区：会话创建时生成 `join(app.getPath('desktop'), 'Sparkii' + rand4 + ts)`：
  - `rand4`：`crypto.randomInt` 从 `[A-Za-z0-9]` 排除易混字符（`0 O 1 l I`）取 4 位；
  - `ts`：`YYYYMMDDHHmm`（会话打开时刻，精确到分钟）；
  - 只计算并入库，**不创建目录**。
- 用户指定：`setChatWorkspace` 后 `workspace_kind='user'`、`workspace_path=用户路径`；已存在直接使用，不存在则首次写时创建。
- 会话锚点目录：`dataDir/sessions/<sessionId>/`（始终存在，子进程 cwd、Pi session 文件、日志落点；不污染桌面）。工具层把「用户可见工作区根」与「锚点」分开解析：路径解析与执行一律以工作区根为准，锚点仅承载进程/历史。
- 工作区未创建时的只读行为：read/ls/grep/find 与只读 bash 返回统一提示（§6.2）；写操作正常提议，批准后先建目录。

### 7.3 槽位与恢复

- 新会话：`acquire(sessionId, { profileId, saddle })`；首次 turn 后经 `get_state` 捕获 `pi_session_file` 入库；会话打开期间不释放槽位。
- 关闭会话：先 `get_state` 更新 `pi_session_file`，再 `release`（`new_session` 重置槽位）。
- 应用重启后继续会话：`acquire(..., { resumeSessionFile })` → 绑定后 `switch_session` 恢复历史。
- RPC 扩展（agent-host）：`get_state` 响应携带 `{ sessionId, sessionFile }`；`get_messages` 响应携带消息数组（供会话抽屉/首屏历史，避免解析 Pi 内部文件格式）。

### 7.4 IPC 清单（preload + main）

| IPC | 说明 |
| --- | --- |
| `sparkii:newChatSession` | 新建会话，返回 `{ sessionId, workspacePath, model }` |
| `sparkii:listChatSessions` | 会话列表（标题/时间/状态） |
| `sparkii:getChatSession` | 单会话元数据 + 消息历史 |
| `sparkii:getChatMessages(sessionId)` | 消息历史（RPC `get_messages`） |
| `sparkii:prompt(sessionId, text)` | 发消息；事件流 `chat-event` 附 `sessionId`（tool_call/tool_result/message 透传） |
| `sparkii:abortChat(sessionId)` | 中断当前轮 |
| `sparkii:setChatTitle / setChatModel / setChatWorkspace` | 会话级设置（模型可空=跟随配置） |
| `sparkii:chooseWorkspace` | 文件夹选择对话框（复用 dialog） |
| `sparkii:getModelOptions` | `{ defaultModel, models[] }`（复用设置页拉取逻辑） |
| `sparkii:listAgents` | 已安装智能体列表 |
| `sparkii:deleteChatSession` | 关闭并删除会话记录（**不删除工作区文件夹**） |

## 8. 模型路由

- `@sparkii/model-router`：`ModelTask` 增加 `'coding'`；`normalizeRouting` 增加 `coding` 回退 `default`。`manifestSchema` 的 `tasks` 是 `z.record`，无需改 schema。
- 每轮开始前选模型优先级：**会话 `model`（用户选择）> `router.resolve('coding')`**；有用户选择直接 `set_model`，否则走 `selectModel(rt, 'coding', sessionId)`。
- `getModelOptions`：读 settings（provider/baseUrl/defaultModel）+ `listModels` 拉取当前节点模型，返回给 Composer 下拉。
- v1 不做健康检查式自动降级：`set_model` 失败即报错并提示（沿用现状）。

## 9. UI：GeneralChatSurface

落地 C1 对话表面规格并扩展，复用壳层（顶栏/左栏/状态栏/抽屉）与 V3 token：

```
表面头部:通用智能体 · <会话标题> [会话▾] [新会话]
消息流:
  用户气泡(右) / 助手气泡(左, Markdown + 代码块复制 + 流式光标)
  工具卡片:命令(bash) / 文件 diff(edit/write) / 只读结果(read/grep/ls/find)
    - 状态:运行中(蓝) → 等待审批(琥珀, 倒计时) → 已执行(绿) / 已拒绝·未执行(红)
Composer:
  [工作区选择行: 当前工作区路径 · 选择文件夹 · 清除(回自动)]  ← 用户指定优先
  [模型下拉: 默认(跟随配置) / 模型列表]
  [多行输入(Ctrl+Enter 发送) · 发送/停止三态]
```

- 消息渲染新增依赖（`react-markdown` 或 `marked`，实现时二选一，以体积与 TS 类型为准）；代码块带复制按钮。
- 审批：general 提案沿用 `ApprovalPanel`/`ApprovalModal`（高风险居中 + 二次确认），面板内增加 diff 视图（`payload.diff` 高亮增删行）。
- 会话抽屉：会话列表（标题/状态/时间）、新建、重命名、删除（关闭不删文件夹）；继续会话时先 `getChatMessages` 恢复历史再允许输入。
- 左栏：`AGENTS` 来自 `listAgents`（合同审核 + 通用智能体），状态点/排队徽标沿用。
- 空态与引导：未配置模型端点 → 引导去设置；工作区未创建 → 状态行提示「工作区将在首次写操作时生成」。
- 错误：prompt 失败显示 alert 行可重发；工具失败以卡片呈现（错误摘要可展开）。

## 10. 安全模型

1. 只读免审批，写必逐条审批（`risk: write`），破坏性操作 `high-risk` 二次确认；拒绝/超时即不执行。
2. 工具可见性由内核强制（三层）：未注册工具 schema 不进模型上下文（**看不见**）；agent 循环按名 dispatch 未命中即报错（**调不到**）；写工具的 operations 固定路由 Main（**执行在 Main**）。
3. 子进程无写能力（**池级系统保障**）：`bash`/`edit`/`write` 的 operations 只把请求发往 Main——该路由固定于统一子进程运行时，与鞍无关；执行只在 Main 侧、且仅当 gate 状态为 `approved` 时发生（确定性执行器，LLM 无法绕过）。
4. 命令分类在白名单式严格判定（§6.2），宁可多审不可漏放。
5. 路径白名单：所有文件操作 resolve 后必须位于会话工作区根内；`..`/越界直接拒绝并审计。符号链接逃逸防护不在 v1 范围（标注为后续硬沙箱项）。
6. 审计全程：读工具调用、写提议、批准/拒绝、执行结果、工作区创建均落审计（带 sessionId/profileId）。
7. Renderer 仍不接触密钥与系统权限（沿用 contextIsolation + sandbox）。

## 11. 错误处理

- 子进程崩溃：槽位 failPending → 会话标记失败并提示重试；沿用现有 recovery。
- 命令超时：kill 并返回 `{ exitCode: null, timedOut: true }`，审计 `proposal.failed`；模型可见超时信息。
- edit old_string 不匹配：执行失败，错误回传模型重试；不部分写入。
- 工作区创建失败（磁盘/权限）：执行失败 + 审计，不伪造成功。
- 模型不可用：`set_model` 失败 → 报错并提示检查设置（v1 不自动降级）。
- 只读路径越界/未创建：确定性错误消息，不弹审批、不执行。

## 12. 测试策略

### 单元

- 工作区命名：格式 `Sparkii<4字符><14位时间戳>`、排除易混字符、同分钟多会话不冲突（随机段）。
- `isReadOnlyBashCommand`：白名单命中 / 元字符注入（`;` `&&` `|` `>` `$()` 反引号）/ 未知动词 / 破坏性命令归类。
- 路径白名单：合法相对/绝对路径、`..` 逃逸、越界拒绝。
- ChatSessionStore CRUD 与默认标题；模型优先级（用户选择 > 路由）。
- ApprovalGate 多策略：不同 profile 超时/可批准风险级独立生效。
- 工具注册表：未知工具名解析失败（fail closed）；鞍只注册选中的工具。

### 集成（desktop / agent-host）

- 统一池：槽位跨智能体复用；`configure_session` 按会话下发鞍（工具清单/skills/cwd/系统提示）。
- **写安全不依赖鞍（池级不变量）**：即使 `configure_session` 缺失或失败，子进程的 `bash`/`edit`/`write` 也无法本地执行（只读工具除外）；跨 profile 无工具/skills 泄漏（合同会话结束后，同槽位新通用会话看不到合同工具/skills）。
- GeneralExecutor：bash 只读直通、bash 写审批后执行、edit diff 计算与应用、write 懒创建工作区、超时 kill。
- RPC：`get_state` 返回 sessionFile；`get_messages` 返回历史；事件带 sessionId。
- 合同审核鞍迁移：pilot e2e 原样通过（业务行为不变，仅装配方式统一）。

### E2E（Playwright + Electron，假 provider / `SPARKII_SKIP_LLM` 若可用，沿用 pilot 模式）

1. 纯问答会话 → 桌面上**不出现**任何 `Sparkii*` 文件夹。
2. 请求「创建 hello.txt」→ 出现审批卡（diff）→ 批准 → 桌面出现 `SparkiiXXXX<ts>` 文件夹与文件，审计含 `workspace.created` + `proposal.executed`。
3. 同上但拒绝 → 无文件、无文件夹，审计 `proposal.denied`。
4. Composer 指定工作区 → 写入发生在指定目录（桌面不生成默认文件夹）。
5. 模型选择器选择模型 → 该轮 `set_model` 使用所选模型（mock 断言）。
6. 安全不变量：拒绝后执行器不执行（复用现有审批契约测试模式）。

## 13. 范围边界

**本次做**：§4–§12 全部。

**本次不做（接口/文档预留）**：文件树侧栏与在线 diff 编辑器；附件上传；硬沙箱（容器/微 VM）与符号链接逃逸防护；空闲槽位超时回收；命令健康检查式模型降级；git 专用面板（提交/历史 UI）；会话共享/多用户；工作区文件夹的删除与清理策略；`dashboard`/`chat` 占位表面接入。

## 14. 实现影响面（文件清单）

**新增**

- `profiles/general/`（manifest / prompts/system.md / security）
- `packages/agent-host/src/tool-registry.ts`（统一工具注册表：子进程侧工具目录）
- `packages/agent-host/src/coding-tools.ts`（Pi 原生工具定义 + 委托 Main 的 operations + 只读工具路径白名单包装）
- `apps/desktop/electron/main/chat-session-store.ts`、`workspace.ts`、`general-executor.ts`
- `apps/desktop/src/surfaces/GeneralChatSurface.tsx`、`src/workbench/ToolCard.tsx`、`src/workbench/Composer.tsx`（或并入 surface）
- 依赖：`react-markdown`（或 `marked`）

**修改**

- `packages/model-router`：types（`coding`）、normalizeRouting
- `packages/config`：manifest schema 增加可选 `displayName`
- `packages/approval`：ApprovalGate 多策略
- `packages/agent-host`：pool（跨智能体复用/会话恢复）、RPC `configure_session`、pi-sdk-runtime（鞍装配 + 池级 operations 路由）、RPC types（get_state/get_messages 返回数据）
- `profiles/contract-review/`：tools.yaml 显式声明 `read`、新增 `agent/prompts/system.md`（鞍迁移，见 §4.1）
- `apps/desktop/electron`：runtime.ts（多 profile）、ipc.ts、index.ts（profiles 发现）、preload api-types
- `apps/desktop/src`：App.tsx（agents/路由/surfaces）、Shell.tsx（ScreenId `general`）、styles.css

## 15. 自检记录

- 无 TBD/TODO；白名单初始清单与易混字符排除规则已给出，扩展点已注明。
- 一致性：§2 决策与 §5/§6/§7/§8 行为一一对应；统一工具注册表（§6.1）与鞍装配、合同审核鞍迁移（§4.1）、三层保障（§10）在正文与测试中一致。
- 范围：聚焦单个智能体的完整落地，无跨子系统蔓延；设置页 routes 接线、健康降级等明确排除。
- 歧义收敛：删除会话不删文件夹；用户指定工作区后 auto 路径作废；命令分类采用严格白名单而非启发式。
