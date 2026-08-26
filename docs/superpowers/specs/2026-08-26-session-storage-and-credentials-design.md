# 会话记录存储、标题生成、身份与凭据统一设计

- 日期：2026-08-26
- 状态：spec，待用户评审
- 范围：本地会话/聊天记录存储与读取、会话标题自动生成、移除自建登录、模型凭据统一与 Pi 运行时隔离

## 1. 背景

桌面端框架与通用智能体已经搭好，但会话历史存在三处断裂：

1. **会话列表为空**：`sessions.db` 只存会话元数据，且合同审核旧流程从不写入；真正的对话内容寄存在 Pi 运行时自己的 jsonl 里，桌面端从不读取，所以打开「对话记录」列表是空的。
2. **标题缺失**：Pi 支持 `session_info` 条目存显示名，但当前未接入，无法自动生成标题，也没有历史标题的展示逻辑。
3. **凭据分裂**：设置页的 API key 存明文 `settings.json`，只被探测按钮使用；Pi 推理实际读 `~/.pi/agent/auth.json`，两套互不相通；`Keyring`（Electron `safeStorage`）是已定义但从未被实例化的死代码。

## 2. 目标与非目标

### 目标

- 把 Pi 的 jsonl 作为「消息 + 标题」的唯一权威，桌面端只读、不重复存储。
- 会话可枚举、可打开历史；标题可生成并自动回显；列表无标题时有合理回退。
- 移除自建登录，以 OS 用户作为单一本地主体，审批/审计行为不变。
- 统一凭据到 `keyring`（`safeStorage` 加密），Pi 运行时从 keyring 取 key，并与用户本机 `~/.pi` 彻底隔离。
- 「测试连接」与「拉取模型列表」走 Pi 同一套凭据与模型路径。

### 非目标

- 不做消息正文的 SQLite 落库（避免重复存储）。
- 不引入多用户 / SSO（本次砍登录后为单用户本机主体）。
- 不做 OS 级硬沙箱。
- 不迁移用户本机 `~/.pi` 里已有的、属于其个人 Pi 的会话（只处理 Sparkii 自己的目录）。

## 3. 现状与问题根因

### 3.1 会话存储

- 元数据：`apps/desktop/electron/main/chat-session-store.ts` 用 better-sqlite3 写 `sessions.db`（`chat_sessions` 表：id/profileId/title/workspaceKind/workspacePath/model/piSessionFile/createdAt/updatedAt）。
- 消息与状态：`@earendil-works/pi-coding-agent` 的 `SessionManager` 落盘在 `getAgentDir()/sessions/<cwd 桶>/<时间戳>_<uuid>.jsonl`，目前默认是 `~/.pi/agent/sessions/`。
- 读取：`openChatSession` 要先打开运行时才能 `get_messages`；`getChatMessages` 在会话未打开时直接返回 `[]`。

### 3.2 凭据

- 设置页 API key：`saveSettings` 明文写入 `settings.json`，只被 `model-probe.ts` 的 `listModels` / `testModel` 使用。
- Pi 推理凭据：`ModelRuntime.create()` 读 `~/.pi/agent/auth.json`，Sparkii 未把设置页 key 桥接给 Pi。
- `Keyring`（`safeStorage`）在 `apps/desktop/electron/main/keyring.ts` 已定义，但无任何实例化调用。

### 3.3 身份

- `LocalIdentityProvider` 把用户存进 `users.json`（scrypt 哈希，非明文），并硬编码种子 `admin/admin123`。
- 登录页 + `sparkii:login` + `rt.subject` 组成自建账密体系；`Rbac` / `ApprovalGate` 依赖 `rt.subject` 的角色做审批鉴权。

### 3.4 探测按钮

- `model-probe.ts` 里「测试连接」与「拉取模型列表」打的是同一个 `GET /models`；「测试连接」只验 HTTP 200 + 延迟，未发任何补全请求，验证不到「key 能否让模型真正出字」。

## 4. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 消息正文 | Pi jsonl 是唯一权威，桌面端只读、不重复存储 |
| 会话标题 | 存 Pi 的 `session_info`（`appendSessionInfo`），不落 `sessions.db` |
| `sessions.db` | 瘦身为最小索引：`id`（对齐 Pi 会话 id）/ `piFile` / `profileId` / `workspaceKind` / `workspacePath`（+「下次用哪个模型」偏好） |
| 读历史 | 纯文件读（`SessionManager.list` / `open` 或 `parseSessionEntries`），不进 Pi 线程池 |
| 列表标题 | 有标题用标题；否则首条用户消息（截断）；再否则「会话 MM-DD HH:mm」 |
| 标题生成 | `title` 模型路由 + `ModelRuntime.completeSimple` 一次性补全 + `appendSessionInfo` 写回 |
| 标题触发 | 第一轮回复结束（`agent_end`）跑一次，布尔标志防重复覆盖 |
| 身份 | 砍自建登录；OS 用户名做单一本地主体；roles 给全量 `['admin','reviewer']` |
| 审批/审计 | `Rbac` / `ApprovalGate` 保留；审计 `actor` = OS 用户名 |
| 凭据存储 | API key 入 `keyring`（`safeStorage`），`settings.json` 不再存 key |
| Pi 取 key | fork 时注入 + `ModelRuntime.setRuntimeApiKey`（内存态，不写盘） |
| Pi 隔离 | `PI_CODING_AGENT_DIR` 指到 Sparkii 自己目录，不碰用户本机 `~/.pi` |
| key 变更 | 低频；用 `setRuntimeApiKey` 热更新，不重启 Pi 进程 |
| 测试连接 | `ModelRuntime.checkAuth` + `completeSimple` 发 1 token 真补全 |
| 拉取模型 | `ModelRuntime.refresh` + `getModels` / `getAvailable` |

## 5. 目标架构

### 5.1 会话记录（A）

- Pi jsonl（Sparkii 自己的 agent 目录）= 消息 + 标题权威。
- `sessions.db` 瘦身为最小索引，不存消息、不存标题。
- 读历史纯文件读，不占用 Pi 线程池。
- 列表 = `SessionManager.list(cwd, sessionDir)`（含 `name` / `firstMessage`）+ `sessions.db` 的 `profileId` 做按智能体过滤。

### 5.2 标题生成（B）

1. `ModelTask` 增加 `'title'`，`normalizeRouting` 加入默认继承链；两个 profile 的 `manifest.yaml` 加 `title` 便宜模型路由。
2. 第一轮 `agent_end` 后，取「第一条 user + 第一条 assistant」文本。
3. 用 `ModelRuntime.completeSimple`（一次性补全，不追加到 `session.messages`）生成 20 字内标题。
4. `appendSessionInfo(name)` 写回 jsonl；前端事件推送 `{ sessionId, title }`，更新抽屉列表项与 surface 标题。

### 5.3 身份（C）

- 删除登录页、`sparkii:login`、`users.json`、`LocalIdentityProvider`、`admin/admin123` 种子。
- `rt.subject = { userId: os.userInfo().username, roles: ['admin','reviewer'] }`，启动即固定。
- 删除 `decideApproval` 里 `if (!rt.subject) throw 'not authenticated'` 判断。
- 账号抽屉显示 OS 用户名，去掉角色下拉（或仅留只读标签）。

### 5.4 凭据（D）

- `saveSettings` 把 `apiKey` 交给 `Keyring.set('apiKey', …)`（`safeStorage` 加密）；`settings.json` 只保留 `provider/baseUrl/defaultModel/routes`。
- fork Pi 子进程前，主进程从 keyring 读 key，通过环境变量传入；子进程 `ModelRuntime.create` 用 `setRuntimeApiKey` 或内存 `CredentialStore` 注入。
- fork 时设 `PI_CODING_AGENT_DIR`（以 SDK 导出的 `ENV_AGENT_DIR` 常量为准，不硬编码字符串），使 `getAgentDir()/getAuthPath()/getModelsPath()/getSessionsDir()` 全部切到 Sparkii 自己的目录。

### 5.5 模型访问（E）

- 「测试连接」→ `ModelRuntime.checkAuth(providerId)` + `completeSimple` 发极小补全。
- 「拉取模型列表」→ `ModelRuntime.refresh(options)` + `getModels` / `getAvailable`。
- 与标题生成共用同一个 `ModelRuntime` / 凭据链。

## 6. SDK 能力核对结论

以下均来自对 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 类型定义的实际读取：

| 能力 | SDK 入口 |
| --- | --- |
| 凭据注入 | `ModelRuntime.create({ credentials?, authPath?, modelsPath?, modelsStore?, allowModelNetwork? })` |
| key 热更新 | `ModelRuntime.setRuntimeApiKey(providerId, apiKey)` / `removeRuntimeApiKey`（内存态，不写盘） |
| 按次覆盖 | `ModelRuntime.getAuth(providerId \| model, overrides?: { apiKey?, env? }) → AuthResult` |
| 一次性补全 | `ModelRuntime.complete(model, context, opts?)` / `completeSimple(model, context, opts?) → Promise<AssistantMessage>` |
| 鉴权探测 | `ModelRuntime.checkAuth(providerId)` / `hasConfiguredAuth(providerId)` |
| 模型列表 | `ModelRuntime.getModels(providerId?)` / `getModel(providerId, modelId)` / `getAvailable(providerId?)` / `refresh(options?)` |
| 内存凭据 | `AuthStorage.inMemory(data?)` / `AuthStorage.create(authPath?)` / `readStoredCredential(providerId, authPath?)` |
| 目录隔离 | 环境变量 `PI_CODING_AGENT_DIR`（`ENV_AGENT_DIR`）、`PI_CODING_AGENT_SESSION_DIR`（`ENV_SESSION_DIR`） |
| 会话创建 | `createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager, sessionStartEvent? })`；`createAgentSession({ cwd?, agentDir?, modelRuntime?, sessionManager?, settingsManager?, model?, tools?, … })` |
| 会话枚举 | `SessionManager.list(cwd, sessionDir?, onProgress?)` / `listAll(sessionDir?, onProgress?) → SessionInfo[]` |
| 打开/恢复 | `SessionManager.open(path, sessionDir?, cwdOverride?)` / `continueRecent(cwd, sessionDir?)` / `inMemory(cwd?)` / `forkFrom(...)` |
| 标题写/读 | `SessionManager.appendSessionInfo(name)` / `getSessionName()`；`AgentSession.setSessionName(name)` / `session.sessionName` |
| 直接解析 | `parseSessionEntries(content)` / `loadEntriesFromFile(filePath)` |
| 会话结构 | `SessionHeader { type, version, id, timestamp, cwd, parentSession? }`；`SessionInfoEntry { type:"session_info", name? }`；`SessionInfo { path, id, cwd, name?, firstMessage, messageCount, created, modified }` |
| 凭据模型 | `Credential = ApiKeyCredential({type:"api_key", key?, env?}) \| OAuthCredential({type:"oauth", refresh, access, expires})`；`CredentialStore { read, list, modify, delete }`，`modify` 是唯一写路径（串行 + 文件锁） |
| 鉴权解析 | `resolveProviderAuth`：存储 credential 优先，无则回落 ambient 环境变量（`getEnvApiKey`），运行时 overrides 覆盖 |

## 7. Pi 进程启动流程与 key 变更生命周期

### 7.1 启动流程（进程最多懒启动 4 个，之后复用）

1. 主进程 `rt.pool.acquire(sessionId, …)`。
2. `PiRuntimePool`：有空闲 slot 则复用；无空闲且 `slots.length < maxAgents(4)` 则 `new PiRuntimeSupervisor` + `supervisor.start()`；否则排队。
3. `supervisor.start()` → `makeHandle()` → `utilityProcess.fork(entry)` 拉起子进程（fork 模式为 `child_process.fork`）。
4. 子进程 `createPiSdkSessionHost`：`ModelRuntime.create()`（一次性加载凭据 + 模型）+ `createAgentSessionRuntime(...)` + `SessionManager.create(cwd)`。
5. 子进程发 `ready`，父进程 `PiRuntimeClientImpl` 完成握手。
6. `bind()` 发 `configure_session`（saddle），必要时 `switch_session`（恢复历史）。
7. 之后才能 `set_model` + `prompt`。

`release` 只对同一进程发 `new_session`（重置会话）并让给下一个排队者；**进程不重启、`ModelRuntime` 不重建**，所以 key/模型在 slot 生命周期内驻留。

### 7.2 key 变更

- 改 key 是低频事件。保存后主进程通过 RPC 对所有运行中的 `ModelRuntime` 调 `setRuntimeApiKey(providerId, newKey)` 热更新，**不重启 Pi 进程**。
- 正常启动路径（fork → `ModelRuntime.create`）不关心 key 变更；热更新仅覆盖极低频的改 key 场景。

## 8. 数据归属

| 数据 | 权威存储 | 说明 |
| --- | --- | --- |
| 消息正文 | Pi jsonl | 不重复 |
| 会话标题 name | Pi jsonl（`session_info`） | `appendSessionInfo` |
| 模型变更 / 时间戳 / 会话 id / cwd | Pi jsonl | 会话头与 `model_change` |
| profileId（属于哪个智能体） | `sessions.db` | Pi 不知道 agent |
| workspaceKind / workspacePath | `sessions.db` | Sparkii 独有概念 |
| piFile 引用 | `sessions.db` | 指向 jsonl |
| 审批 / 审计 / 执行流水 | `audit.db` | 产品信任层，不进 Pi |
| 本地账号 | 移除 `users.json` | 以 OS 用户替代 |
| 系统设置（baseUrl/defaultModel/routes） | `settings.json` | `apiKey` 除外 |
| API key | `keyring`（`safeStorage`） | 唯一机密源 |

## 9. 范围与边界

覆盖：会话存储与读取、标题生成与回显、移除自建登录、凭据统一与 Pi 隔离、测试连接/拉取模型走 Pi。

不覆盖（接口预留）：多用户 / SSO、OS 级硬沙箱、智能体市场、历史 `~/.pi` 数据迁移、深色模式。

## 10. 开放问题

- `PI_CODING_AGENT_DIR` 的精确字符串在实现时以 SDK 导出的 `ENV_AGENT_DIR` 常量为准（本次已确认其存在与作用）。
- 标题生成模型的 provider/modelId 在 profile `manifest.yaml` 中默认给 `deepseek-v4-flash`，可后续在设置页调整。
- `sessions.db` 是否需要保留 `model` 偏好列（当前用于「下次用哪个模型」），实现时一并确认。

## 11. 落地顺序建议

1. 凭据层：接线 `Keyring`，`saveSettings` 改走 `safeStorage`；新增 fork 注入与 `PI_CODING_AGENT_DIR` 隔离。
2. agent-host：新增 `list_sessions` / `read_session` / `set_session_name` / `complete`（或 `generate_title`）/ `set_api_key` 等 RPC，底层落到 `SessionManager` 与 `ModelRuntime`。
3. IPC + 前端：`listChatSessions` / `openChatSession` 改读 Pi；修复 agent id 映射；标题回退展示与自动更新。
4. 身份：砍登录，OS 用户单一主体。
5. 标题生成：`title` 模型路由 + `completeSimple` + `appendSessionInfo` + 前端事件。
6. 测试连接/拉取模型：改为走 `ModelRuntime`。
