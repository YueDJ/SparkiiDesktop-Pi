# 记忆模块设计与实施计划（Memory Module）

- 日期：2026-11-23（v2，已按首轮架构评审修订）
- 状态：评审修订完成，待用户拍板开工（本文档不含任何代码改动）
- 范围：Sparkii Desktop 全平台（general / bid-writing / contract-review / knowledge-qa / procurement-review 五个智能体，未来新增智能体自动适用）
- 约束：实施期间另有 agent 在同仓库做标书打磨，开工前需协调挂点文件占用；本模块全部为**新增文件 + 平台层挂点修改**，不改签名 agent 包、不改 Pi SDK。

---

## 1. 背景与目标

现状：平台已有三类"准记忆"——工作区 AGENTS.md（SDK 自动加载）、skills（能力包）、知识库 RAG（远端检索）。三者都要人主动编写/构建，**没有任何机制自动沉淀"用户的使用习惯"与"项目的历史经验"**。每开一条新会话，智能体对用户的了解归零。

目标：
1. 用户层记忆：任何智能体、任何项目都了解本机用户的偏好与习惯（语气、汇报格式、审美标准等）。
2. 项目层记忆：同一项目工作区内，所有智能体共享同一份项目事实与决策记忆。
3. 智能体习惯层：每个智能体各自的"干活习惯"分开积累，互不污染。
4. 情景层：会话历史自动提炼摘要，作为上层记忆的原料、证据链与跨项目回忆的检索基底。
5. 记忆生命周期：自动提炼（系统代管）→ 用户确认 → 注入使用 → 使用强化 / 时间衰减 → 压缩合并 / 降权 / 作废 → 用户显式删除（真删）。

非目标（本期不做）：
- 向量检索 / embedding（规模到不了，FTS 全文检索足够；留作后续扩展位）。
- 远端同步、多设备共享（记忆永远留在本机）。
- agent 自主编辑记忆的完全放开（Letta 路线）——第一版系统代管，agent 只有"用户显式要求记住/忘掉"的执行工具与只读检索工具。
- 跨项目的项目记忆合并（项目记忆跟随项目文件夹，不跨项目聚合）。
- 会话中途记忆热更新（技术上零 SDK 改动可做，见 §6.4，第一版不做是平台取舍）。

## 2. 已拍板决策记录（2026-11-23 与用户讨论确认）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 分层 | 用户层（全局）/ 智能体习惯层（各 agent 分开）/ 项目层（工作区内跨 agent 共享）/ 情景层（基底） |
| D2 | 项目记忆归属 | 共享：同一项目里标书、审核等智能体看到同一份项目记忆；agent 干活习惯分开 |
| D3 | 写入权 | 系统代管：会话结束后后台提炼；agent 仅持有"用户显式说记住/忘掉"的执行工具 |
| D4 | 提炼模型 | 第一版走用户已配置的大模型 API（复用现有模型路由），设置里给开关 |
| D5 | 遗忘终点 | 降权 + 作废为主，不自动物理删除；用户显式遗忘 / 隐私清理走真删 |
| D6 | 衰减机制 | 艾宾浩斯式指数衰减，读取时算分；被使用即强化（时钟重置）；pinned 豁免 |
| D7 | 情景层必要性 | 保留：它是提炼原料、证据链、跨项目模糊回忆的索引；原始 JSONL 已存在，只补摘要+索引 |

## 3. 现状代码事实（只读核实 + 首轮评审对码复核，含行号）

以下事实是设计的承重点。标注【评审修正】的条目为首轮架构评审抓出、经本人二次对码确认的修正。

**注入链（system prompt 如何组装）**
- `apps/desktop/electron/main/saddle.ts:6-40`：`buildProfileSaddle` / `buildAgentSaddle` 在主进程组装 `SessionSaddle`，`systemPrompt` 来自 agent 清单。**记忆块在此处追加，SDK 零改动。**
- `packages/agent-host/src/pi-sdk-runtime.ts:175-184`：`before_agent_start` 钩子调用 `applySaddleSystemPrompt`；`:385` 钩子**每次 run 活读 `pendingSaddle`**；`:403-411` 会话创建用 `customTools` + `noTools:"builtin"`。
- `packages/agent-host/src/skill-prompt.ts:50-70`：最终 prompt 顺序 = **鞍文本（含记忆块）+ skills 目录 + cwd 行**。记忆块在鞍文本末尾，但不是最终 prompt 的末尾。
- 【评审修正】"systemPrompt 会话中途固定"是**平台行为而非 SDK 限制**：`configure_session` 消息可随时发送（`pi-runtime.ts:156-157`），钩子每次 run 活读鞍。平台目前只在 acquire 时配鞍（`pi-runtime-pool.ts:149-156`），所以中途不重注入。热更新零 SDK 改动可做（重发 configure_session），第一版不做是取舍（§6.4）。

**工具链与审批门（首轮评审的阻塞项所在）**
- `packages/agent-host/src/tool-registry.ts:107`：`resolveToolDefinitions(toolNames, ctx)` 按名字解析工具；**未知工具名抛错并清空整盘工具**（`pi-sdk-runtime.ts:295-321` fail-closed）⇒ 工具定义与鞍附加必须原子改动。
- `packages/agent-host/src/pi-sdk-runtime.ts:258-284`：工具必须进会话注册表（`registerTool` + `setActiveTools`）。
- `apps/desktop/electron/main/ipc.ts:384-403`：`bindRuntimeActions` 把 `onAction` 请求交给 `actionRouter.route`（`:209`）。**平台可信分支的挂点就在 `:389` 的回调内、route 之前。**
- 【评审修正】走现有审批门登记新工具**不可行**，证据链：
  - dataDir 是 closure 保护根（`security/windows-platform.ts:187`）⇒ 落入其中的路径 scope=critical ⇒ 硬拒（`packages/approval/src/security/policy.ts:94-99`）；
  - 不带路径参数的动作 resources 为空 ⇒ `withinGrant=false`（`policy.ts:21-22`）；fs.write 再中 `workspace.write-outside` 硬拒（`:140-146`）；其余落 `platform.capability-expansion` ask（`:171-175`）；
  - 未登记工具直接 `UNKNOWN_TOOL` 抛错（`security/action-normalizer.ts:299-305`）；
  - `CapabilityKind` 是闭联合（`approval/types.ts`），扩展能力需动 types/policy 穷举 switch/profile-policy 多处；
  - 非 win32 时 `rt.security` 为空（`runtime.ts:238`），一切 requestAction 被拒（`ipc.ts:390-399`）。
  ⇒ **结论：记忆工具走平台可信分支（§10），不扩展审批能力联合，不登记 DEFAULT_TOOL_DESCRIPTORS。**
- agent 的工具清单来自签名包清单（`agent-registry.ts:43`；`runtime.ts:170` 验签）。**不改签名包**：记忆工具由平台在鞍组装时统一附加。

**轻量补全通道（提炼管道复用）**
- `apps/desktop/electron/main/ipc.ts:1564-1578`：`sparkii:completeText` 先例——槽位 → `resolveModelTarget(settings,'title') ?? ('default')` → `slot.client.send({type:'complete'})`。
- `packages/agent-host/src/pi-sdk-runtime.ts:471-483`：`complete()` = `modelRuntime.completeSimple`，**单轮、无工具、无状态、不进会话历史** ⇒ 提炼不需要重建/恢复会话，只需要一个配好 key 的槽位。
- 【评审修正】`ModelTask` 是闭联合（`packages/model-router/src/types.ts:1`：chat/extract/report/default/coding/title）⇒ 新增 'memory' 路由任务**必须改这个文件**（挂点清单已列）。routes 本身是 `Record<string,string>`，设置存储无需迁移。
- 内部槽位先例：`withProbeSlot`（`ipc.ts:650-660`，meta.internal=true 不污染队列 UI）+ `injectProbeKey`（`:662-665`）。

**会话事件、槽位池与生命周期**
- `apps/desktop/electron/main/ipc.ts:738-781`：`ensureProcessPipe` 事件流；`:744` `agent_settled`（每轮 prompt 结束）触发 Grant 收尾、`persistHitTurn`、`scheduleIdleRelease`。提炼触发器挂这条流（debounce），不新增事件类型。
- 【评审修正】空闲释放仅 **15 秒**（`ipc.ts:624` `sessionIdleReleaseMs=15_000`）⇒ 90 秒 debounce 期满时槽位早已释放，提炼必须自借内部槽位（§7.2）。
- 【评审修正】池满时 `acquire` **排队等待而非失败**（`pi-runtime-pool.ts:135-138`）⇒ "池满放弃"必须显式实现：先查 `snapshot()`（`:63`）有无空闲槽，竞态落入排队后用 `cancelPending(queueId)`（`:96`）超时撤销。
- `apps/desktop/electron/main/chat-session-store.ts:9-30`：`chat_sessions` 含 `profileId / workspaceKind('auto'|'user') / workspacePath / piSessionFile`——归属判定字段齐全。
- 【评审修正】JSONL 是**树结构**（parentId/分支）且含 compaction 条目；现成读取先例 `readPiSessionMessages` / `readPiSessionEntries` + SDK `parseSessionEntries`（`packages/agent-host/src/session-catalog.ts:34-44`）⇒ 素材位点用 **entry-id**，不用字节偏移。

**存储基建**
- `apps/desktop/electron/main/paths.ts:6-16`：数据根 `%LOCALAPPDATA%\SparkiiDesktop\data\<userId>`（按用户隔离）。
- `apps/desktop/electron/main/runtime.ts:198-214`：audit.db / sessions.db / errors.db / keyring / pi-agent 均在 dataDir 下；better-sqlite3 已在用。
- 【评审补证】better-sqlite3@13.0.3 内置 SQLite **3.53.4**（`node_modules/better-sqlite3/deps/sqlite3/sqlite3.h:149`）+ `SQLITE_ENABLE_FTS5`（`deps/defines.gypi:24`）⇒ trigram（需 ≥3.34）编译期证据满足；预构建二进制一致性属推断，M1 仍做运行时探测。
- `runtime.ts:228-234`：`PiRuntimePool`（maxAgents 默认 4）。

**项目实体与文件可见性（标书先例）**
- `apps/desktop/agents/bid-writing/surface/project-store.ts:44`：`PROJECT_FILE='project.json'` 位于工作区根；会话按 workspacePath 分组；搬迁先迁会话记录再写文件（surface/index.tsx:521-524）。
- 【评审修正】`surface/index.tsx:611` 的点文件过滤**只作用于 input 资料清单**；工作区文件树走 `workspace-file-service.ts:250-252` 的裸 `readdir`，**无过滤** ⇒ `.sparkii/` 会出现在根目录树。对策改为平台层围栏（§5.2）：list 操作过滤 `.sparkii` + 守卫禁止 agent 工具写 `.sparkii/**`。不改标书 surface（避免触碰 agent 包）。

**设置页与 preload**
- `apps/desktop/src/shell/SettingsView.tsx:126-146`：四组九 pane；「模型与知识」组加 `memory` pane，组件参照 SettingsKnowledgePane，深色主题。
- 【评审修正】preload 是**修改现有三件套**（`apps/desktop/electron/preload/api.ts / api-types.ts / index.ts`），不是新增文件。

**其他**
- `pi-sdk-runtime.ts:64-69`：cacheWarming 已显式关闭（无额外计费请求）。记忆块变更的缓存影响按"system prompt 前缀变更"表述（§14）。
- `ipc.ts:428`：`rt.subject.userId` 可得。
- `persistHitTurn`（ipc.ts:794-810）只追加本地会话自定义条目，不构成记忆内容外发通道（评审核实）。

## 4. 总体架构

```
                    ┌────────────────────────────────────────────┐
                    │              主进程 memory-service          │
                    │  (新增 electron/main/memory/ 目录)          │
                    ├────────────────────────────────────────────┤
 会话开始 ──────────►│ 读取：scope 过滤 → 衰减打分 → 预算内注入     │──► saddle.systemPrompt 追加 <memory> 块
                    ├────────────────────────────────────────────┤
 agent_settled ────►│ 写入：debounce → parseSessionEntries 增量   │──► 提炼 ops → pending 队列 → 用户确认
 (debounce 90s)     │   → 内部槽位 complete() → ADD/UPDATE/       │
                    │     SUPERSEDE/NOOP（fail closed）           │
                    ├────────────────────────────────────────────┤
 空闲定时 ─────────►│ 维护：压缩合并 / 情景摘要归档（M3）          │──► 整合提案同样进 pending 队列
                    ├────────────────────────────────────────────┤
 设置页 IPC ◄──────►│ CRUD / pending 审批 / pinned / 真删 / 开关   │
 memory_* 工具 ────►│ 平台可信分支（bindRuntimeActions 内拦截）    │──► forget 先走 propose 审批
                    └────────────────────────────────────────────┘
 存储：文件为真相源（JSON） + memory.db 为派生索引（FTS5 trigram + 使用统计）
```

四层记忆与归属：

| 层 | scope key | 真相源文件 | 注入范围 | 半衰期（初始值，可调） |
|---|---|---|---|---|
| 用户层 | `user` | `dataDir/memory/user.json` | 所有 agent、所有会话 | 180 天 |
| 智能体习惯层 | `agent:<agentId>` | `dataDir/memory/agents/<agentId>.json` | 仅该 agent 的会话 | 90 天 |
| 项目层 | `project:<projectId>`（索引按规范化路径定位） | `<workspace>/.sparkii/memory.json` | 打开该工作区的所有 agent | 60 天（归档后停注入） |
| 情景层 | `episode:<sessionId>` | `dataDir/memory/episodes.jsonl`（追加） | 不主动注入；M3 起可检索 | 14 天（摘要压缩后原文降冷） |

项目身份规则：
- 项目记忆**跟随工作区文件夹**（`.sparkii/memory.json` 随文件夹拷贝/搬迁移动），文件内写死 `projectId`（uuid，创建时生成）。pending 提案与索引条目都带 projectId。
- **搬迁自愈**：会话打开时若工作区存在 `.sparkii/memory.json` 但索引无此路径 ⇒ 按 projectId 重索引该文件。不依赖标书 relocate 流程挂钩子（评审指出该流程不在挂点清单，自愈方案绕开它）。
- 仅 `workspaceKind='user'` 的工作区积累项目记忆；`auto` 临时工作区不建项目层（提炼出的通用偏好归用户层）。
- 不依赖 project.json 存在；标书项目天然满足。

## 5. 数据模型

### 5.1 记忆卡片（真相源 JSON 内的条目）

```jsonc
{
  "id": "mem_<uuid>",
  "text": "用户要求汇报先给结论，正文不超过三句",   // 一句话陈述，≤200 字
  "status": "active",                          // active | pending | superseded
  "pinned": false,                             // 用户显式"记住这个"→ true，豁免衰减
  "importance": 2,                             // 1..3，提炼时评定；用户显式记住=3
  "createdAt": 1763856000000,
  "updatedAt": 1763856000000,
  "source": {                                  // 证据链
    "sessionId": "sess_xxx",
    "excerpt": "用户原话片段（≤120字）",
    "kind": "extracted"                        // extracted | explicit
  },
  "supersededBy": null,                        // 作废时指向新记忆 id
  "pendingOp": null                            // pending 条目携带：{op, targetId?, proposedText, projectId?}
}
```

使用统计（`lastAccessedAt` / `accessCount`）**只存 memory.db**，不进真相源文件——避免每次注入重写文件；索引重建时统计清零（罕见操作，设置页明示代价）。

### 5.2 文件布局与围栏

```
dataDir/
  memory/
    user.json                  # {version:1, entries:[...]}
    agents/<agentId>.json
    episodes.jsonl             # 每行 {sessionId, agentId, workspacePath, projectId?, ts, summary, topics[]}
    memory.db                  # 派生索引：memories(id, scope, project_id, status, text, pinned, importance,
                               #   last_accessed_at, access_count, source_session, file_ref)
                               # + memories_fts(FTS5, tokenize='trigram') + 提炼位点表 + 驳回黑名单表
workspace/
  .sparkii/memory.json         # {version:1, projectId, entries:[...]}
```

规则：
- **文件是真相源，db 是派生索引**：db 损坏/删除后可从真相源重建（设置页"重建索引"，M1 即做）。
- 写入原子性：临时文件 + rename（同目录）。dataDir 侧主进程是唯一写者。
- 【评审修正】**工作区侧单写者假设不成立**：agent 的 write/edit 对工作区内文件是 auto-allow（policy.ts:130-138），外部编辑器/同步盘也能改。围栏三件：
  1. `workspace-file-service.ts` 的 list 操作过滤 `.sparkii` 条目（平台保留目录，文件树不再显示它）；
  2. `workspace-guard.ts` 拒绝 agent 文件工具写 `.sparkii/**`（平台保留，读写都拒，记忆工具是唯一通道）；
  3. **漂移检测**：每次读取真相源时校验 JSON 结构；损坏 ⇒ 该 scope 停止注入 + 设置页出"修复"入口（展示原文、人工确认后重建），绝不静默覆盖。可选 fs.watch 触发重索引。
- FTS5 用 **trigram** 分词器（中文检索必需；编译期证据见 §3，M1 运行时探测，失败退化 LIKE 不阻塞）。
- episodes.jsonl 追加写，M2 生成，M3 进检索。

## 6. 读取路径（注入）

### 6.1 挂点
主进程组装鞍时（ipc.ts 内 `buildSaddle` 等调用方）先向 memory-service 求记忆文本，作为新可选参数传入 saddle.ts builder，追加到 `systemPrompt`（鞍文本）末尾。**不改 SDK、不改 skill-prompt 合并、不改签名包。**

### 6.2 选择算法（纯算术，零 LLM 成本）
1. scope 集合：`user` + `agent:<当前agentId>` + `project:<当前工作区>`（仅 user 工作区且未归档）。
2. 过滤 `status='active'`（pending/superseded 不注入）。
3. 打分：`score = importance × 0.5 ^ (daysSince(lastAccessedAt) / halfLife[scope])`。
4. 各层按字符预算截断：用户层 ≤500 字、agent 层 ≤300 字、项目层 ≤800 字。超预算低分记忆**不注入但可检索**（降权语义）。
5. 【评审修正】**强化与注入分离**：注入只 `accessCount+1`（统计），**不重置衰减时钟**；重置 `lastAccessedAt` 的强化事件仅限——memory_search 检索命中、用户显式操作（remember/批准 pending/编辑/置顶）。理由：若注入即重置，预算内条目永不衰减，衰减只作用于已被挤出的条目，与"越用越牢、不用就淡"的意图相悖；注入是"被看见"，检索命中与显式引用才是"被使用"。
6. 【评审修正】**pinned 超预算规则**：pinned 恒排最前；若 pinned 自身超预算，按 updatedAt 新者优先截断，设置页显示"置顶记忆超出注入预算"警示（不静默丢弃）。

### 6.3 注入格式

```
<memory>
以下是关于用户、你的工作习惯与本项目的已确认记忆。与当前对话冲突时以当前对话为准；
引用记忆做重要判断前，如记忆陈旧（标注了日期），先向用户核实。
[用户] (2026-11-23) 用户要求汇报先给结论，正文不超过三句
[项目] (2026-11-20) 本项目评标办法采用综合评分法，技术分占 60%
[习惯] (2026-11-18) 标书正文逐章推进，每章完成后等待用户确认
</memory>
```

每条带日期供判断陈旧度。空记忆整块不注入。位置在鞍文本末尾（最终 prompt 中其后还有 skills 目录与 cwd 行，见 §3）。

### 6.4 生效时机（评审修正后的表述）
第一版记忆在**会话打开/换鞍时**注入，更新从下一条会话生效。这不是 SDK 限制——`configure_session` 可随时重发、钩子每次 run 活读鞍（§3），热更新零 SDK 改动可做。第一版不做的理由：避免会话中途 system prompt 漂移打断模型注意力与 provider 缓存，且"新会话生效"语义对用户更可预期。设置页文案明示。后续如需热更，重发 configure_session 即可，列为二期可选项。

## 7. 写入路径（系统代管提炼，M2）

### 7.1 触发
- 挂 `ensureProcessPipe` 的 `agent_settled` 事件流（ipc.ts:744）：每轮结束重置 debounce 计时器（初始 90 秒），静默期满且满足门槛才提炼。
- 门槛：距上次提炼 ≥3 个用户轮次且含用户文本；`auto` 工作区只提用户层候选。
- 会话关闭/应用退出时若有未提炼增量，下次启动补一次（位点持久化在 memory.db）。
- 设置页总开关 + "自动提炼"开关（默认开，隐私文案见 §12）。

### 7.2 素材与调用（评审修正后）
- **素材**：`parseSessionEntries` 解析 `piSessionFile`（先例 session-catalog.ts:34-44），取**上次提炼位点（entry-id）之后**的用户/助手消息文本，截断 ≤6000 字；跳过 compaction/工具输出条目。位点存 memory.db。不用字节偏移（JSONL 是树且有 compaction）。
- **槽位**：idle 释放仅 15s（ipc.ts:624），debounce 期满时原槽位必已释放 ⇒ 提炼自借**内部槽位**：仿 `withProbeSlot`（ipc.ts:650-660，meta.internal=true）acquire + `injectProbeKey`（:662-665）+ `complete`。completeSimple 无状态，**不需要 configure_session/switch_session 重建会话**。
- **礼让（显式实现）**：acquire 前查 `pool.snapshot()` 有无空闲槽；无 ⇒ 跳过本窗口、下个 settled 再试。竞态落入排队 ⇒ 5 秒超时 `cancelPending` 撤销。绝不排在交互会话前面。
- **模型**：路由任务新增 `memory`（改 `model-router/types.ts` 闭联合），回退链 memory → default。

### 7.3 提炼输出协议（fail closed）
提示词要求模型只输出 JSON：

```jsonc
{
  "sessionSummary": "≤150字会话摘要",
  "topics": ["标书", "评标办法"],
  "ops": [
    {"op":"ADD","scope":"user","text":"...","importance":2,"excerpt":"用户原话"},
    {"op":"UPDATE","targetId":"mem_x","text":"...","excerpt":"..."},
    {"op":"SUPERSEDE","targetId":"mem_y","reason":"...","replacementText":"..."},
    {"op":"NOOP"}
  ]
}
```

- 解析失败/字段非法 ⇒ **整批丢弃 + errors.db 记录**，绝不半批写入（choke point 抛错落库）。
- ops 每批 ≤5 条；提示词附现有 active 记忆清单（id+text）供比对；"宁缺毋滥：只记稳定偏好与项目事实，不记一次性任务细节、不记可从 project.json/文件直接读到的内容、只记陈述性事实不记指令"。
- `sessionSummary` 追加 episodes.jsonl（M2 即生成）。

### 7.4 确认队列（pending）与全部出口
- 提炼 ADD/UPDATE/SUPERSEDE 落 `status='pending'`，不注入；设置页"待确认"区逐条批准/驳回（显示来源 excerpt）。
- 显式工具记住跳过 pending 直接 active（用户当场意图即确认）。
- 驳回候选进黑名单（文本归一化哈希），不再重复提案。
- 【评审修正】出口穷举：
  | 出口 | 行为 |
  |---|---|
  | 批准 ADD | 转 active |
  | 批准 UPDATE/SUPERSEDE 且 targetId 仍 active | 改旧条目 + 新条目转 active |
  | 批准时 targetId 已被删/已 superseded | 降级为 ADD 候选重新待确认，界面提示"原目标已变化" |
  | 驳回 | 删除 pending + 进黑名单 |
  | 源会话被删（含隐私清理） | 相关 pending 自动失效并提示；已 active 条目的来源链接显示"来源已删除" |
  | 项目搬迁 | pending 按 projectId 关联，索引自愈（§4），提案不悬空 |
  | 索引重建 | pending 存于真相源文件（status=pending 条目），重建不丢 |

### 7.5 冲突消解
- UPDATE/SUPERSEDE 必须带 targetId；同 scope 文本 trigram 相似度 ≥0.85 的 ADD 自动降级为 UPDATE 候选。
- 新旧矛盾出 SUPERSEDE 而非并行 ADD；旧记忆作废保留（D5），`supersededBy` 指向新条目。

## 8. 遗忘、衰减与删除

| 机制 | 触发 | 行为 | 成本 |
|---|---|---|---|
| 衰减降权 | 每次注入选择时 | §6.2 公式算分，低分不注入、仍可检索 | 纯算术 |
| 使用强化 | 检索命中 / 显式操作（不含注入，§6.2-5） | 重置 lastAccessedAt | 一次 db 写 |
| pinned 豁免 | 显式记住/置顶 | 恒注入；超预算规则见 §6.2-6 | — |
| 作废 | SUPERSEDE 经确认 | status=superseded 保留可查（财务审核需要"当时口径"审计轨迹） | — |
| 压缩合并（M3） | 空闲整合 §9 | 相似记忆合并提案 → pending | 一次 LLM |
| 项目归档 | 设置页手动（M1） | 项目层停注入，文件保留可检索 | — |
| 真删 | 设置页 / memory_forget / 隐私清理 | 见下方完整性定义 | — |

【评审修正】**真删完整性定义**（普通删除与隐私删除两档）：
- **普通删除**（单条记忆）：真相源文件删条目 + db 删行 + FTS 同步删。superseded 历史副本默认保留（审计轨迹）；界面提供"连同历史版本一起删"选项。
- **隐私删除**（"连源会话一起删"，二次确认、不可恢复提示）：该 sessionId 关联的**全部**条目（含 active/pending/superseded）+ episodes.jsonl 对应行 + 黑名单中源自该会话的哈希 + JSONL 文件 + chat_sessions 行。删除后悬空引用按 §7.4 出口处理。
- 衰减不物理删除任何数据（D5）；半衰期全部存 memory-settings.json 可调。

## 9. 空闲整合（"睡眠机制"，M3）

- 触发：应用空闲 ≥10 分钟且距上次整合 ≥24h，借内部槽位（同 §7.2 礼让规则）。
- 内容：同 scope 相似记忆合并提案、>30 天情景摘要二次压缩（几百字→几句话）、过期项目事实 SUPERSEDE 提案。
- 所有产出走 pending 队列，不自动改 active 记忆。每次整合 LLM 调用上限 3 次，超出顺延。

## 10. 智能体工具面（平台可信分支，评审阻塞项的解法）

| 工具 | 版本 | 行为 | 确认方式 |
|---|---|---|---|
| `memory_remember` | M2 | 用户显式说"记住X"；写 active 记忆（scope 参数定，默认 user；项目 scope 仅 user 工作区） | 直接执行 + 审计（用户当场意图） |
| `memory_forget` | M2 | 用户显式说"忘掉X"；检索候选 → 真删 | **先走现有 propose 审批 UI**（展示将删条目），批准后执行 + 审计 |
| `memory_search` | M3 | 检索记忆+情景摘要（includeHistory 可含 superseded）；只读；命中触发强化 | 直接执行 + 审计 |

**注册与执行路线（不扩展审批能力联合）**：
1. 工具定义新增于 `tool-registry.ts`，execute 经 `ctx.requestAction` 发回主进程（与现有工具同管道；定义与鞍附加原子改动，避免 unknown-tool 清空整盘）。
2. 主进程 `bindRuntimeActions`（ipc.ts:389）在 `actionRouter.route` **之前**拦截 `memory_*`：remember/search 交 memory-service 执行；forget 先经现有 proposal broker 弹审批，批准再执行。三者全部写 audit.db。
3. 该分支**不依赖 rt.security**（非 win32 也可用），不经过 action-normalizer（不登记 DEFAULT_TOOL_DESCRIPTORS），不触碰 CapabilityKind 闭联合。
4. 鞍组装时（saddle.ts builder）平台统一附加工具名，**不改签名 agent 清单**；设置页全局开关可关闭记忆工具。
5. 工具描述纪律："仅在用户明确要求记住/忘掉时使用；不得自行决定记录对话内容"（D3 边界）。

**信任依据（为什么可以绕过审批门）**：dataDir 本就是 closure 保护根——agent 的文件工具被硬拒触碰它（§3），平台进程是唯一可信写者（sessions.db/audit.db 同等待遇）。记忆工具是平台自身存储操作的延伸，不向 agent 暴露任意路径/任意能力；forget 的破坏性由 propose 审批兜底；全量审计 + 全局开关提供事后控制。这是显式的平台信任决策，记录在案供后续安全复审。

## 11. 设置页 UI（M1 骨架，M2 补全）

「模型与知识」组新增 pane `memory`，标签「记忆」，深色主题，参照 SettingsKnowledgePane：
- 三分区列表：用户记忆 / 智能体习惯（agent 下拉）/ 项目记忆（按工作区分组，含归档标记）。
- 每条：文本、来源会话链接（源已删则显示"来源已删除"）、日期、图钉、状态；行内编辑、删除（两档：普通/连源会话，二次确认）。
- 待确认区（M2）：pending 逐条批准/驳回 + 来源 excerpt + "原目标已变化"提示。
- 开关区：记忆总开关 / 自动提炼 / 空闲整合（M3）；模型路由下拉加「记忆」；隐私明示一句（§12）。
- 手动新增入口（M1）；"重建索引"（明示统计清零代价）；项目记忆损坏时的"修复"入口（§5.2）；pinned 超预算警示（§6.2）。
- 文案纪律：不出现 embedding/FTS/索引机制/审计等工程自证字样（"重建索引"作为用户可执行操作名保留）；顶部一句"记忆更新在新会话生效"。

## 12. 安全与隐私

1. **本地优先**：记忆文件与索引全在本机 dataDir/工作区；绝不写入远端 RAG/onto 后端。评审已核实 persistHitTurn 只写本地会话条目，无额外外发通道；memory-service 自身写入路径不含任何远端调用。
2. **提炼会出机**：自动提炼把会话素材发送到用户配置的大模型 API——与聊天同一数据通道、同一 provider，不新增第三方；开关旁明示："自动提炼会将对话内容发送给你配置的大模型"。关闭后仅手动记忆可用。
3. **删除完整性**：按 §8 两档定义执行，覆盖文件+db+FTS+episodes+pending+黑名单。
4. **多用户隔离**：dataDir 按 userId 隔离；项目记忆随文件夹权限。
5. **审计**：三个工具调用全进 audit.db；forget 走 propose 审批。
6. **注入内容纪律**：入 prompt 前长度/控制字符清洗；提炼只记陈述性事实不记指令；注入模板声明当前对话优先，降低记忆投毒面。
7. **工作区围栏**：`.sparkii` 对 agent 文件工具读写都拒（§5.2），记忆工具是唯一通道。

## 13. IPC 面（新增 handler；preload 修改现有三件套）

```
sparkii:listMemories(scope?)        → 条目+统计+pending
sparkii:addMemory({scope,text,pinned})
sparkii:updateMemory(id,{text,pinned,status})
sparkii:deleteMemory(id,{mode:'normal'|'privacy', includeHistory?})
sparkii:resolvePending(id,'approve'|'reject')
sparkii:archiveProject(workspacePath) / unarchive
sparkii:getMemorySettings / saveMemorySettings
sparkii:rebuildMemoryIndex
sparkii:repairProjectMemory(workspacePath)   # 损坏修复（§5.2）
事件：sparkii:event:memory-event {type:'pending_added'|'memory_changed'|'repair_needed', ...}
```

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| FTS5 trigram 运行时可用性 | 编译期证据已满足（SQLite 3.53.4 + FTS5 宏）；M1 第一步运行时探测，失败退化 LIKE 不阻塞 |
| system prompt 前缀变更使 provider 缓存失效 | 记忆块每会话只组装一次、追加在鞍文本末尾；cacheWarming 已关无额外计费请求；影响=缓存命中率略降，接受 |
| 提炼噪音/错误记忆 | pending 门 + 每批 ≤5 + 黑名单 + 宁缺毋滥提示词；作废可追溯 |
| JSONL 树结构/compaction/SDK 升级 | parseSessionEntries + entry-id 位点（现成先例）；解析失败整批丢弃落 errors.db；SDK 升级列回归项 |
| 提炼与交互抢槽 | snapshot 预检 + 内部 meta + cancelPending 超时撤销（§7.2）；complete 单轮短调用 |
| 工作区记忆文件被 agent/外部改动 | 平台围栏（list 过滤 + guard 拒写）+ 读取校验 + 修复入口，不静默覆盖（§5.2） |
| 项目搬迁索引失联 | projectId 随文件走 + 会话打开时自愈重索引（§4） |
| 审批门硬拒（首轮阻塞项） | 平台可信分支（§10），信任依据记录在案；forget 走 propose 兜底 |
| 同仓库并行施工冲突 | 挂点文件清单见 §15；开工前与标书任务协调占用窗口 |
| 记忆投毒 | 只记陈述性事实；explicit 需用户原话依据；当前对话优先声明 |

## 15. 实施计划（三里程碑）

**挂点文件总清单（修改，共 8 处 + preload 三件套）**：
`saddle.ts`、`ipc.ts`、`tool-registry.ts`、`SettingsView.tsx`、`packages/model-router/src/types.ts`、`workspace-guard.ts`、`workspace-file-service.ts`、preload `api.ts/api-types.ts/index.ts`。
（首轮清单中的 `action-normalizer.ts` 已移除——可信分支不经过它；新增 model-router/types.ts 与围栏两处，均为评审抓出。）
其余全部为新增文件（electron/main/memory/ 目录、SettingsMemoryPane.tsx 等）。

### M1 地基与手动记忆（约 3 人日）
新增：memory-service（文件+db+FTS+打分+围栏校验）、memory-settings、SettingsMemoryPane、IPC handlers、preload 桥。
挂点：saddle.ts、ipc.ts、SettingsView.tsx、workspace-guard.ts、workspace-file-service.ts。
验收（可证伪）：
- 手动新增用户/项目记忆 → 新会话问"你记得我什么"答出；**从会话 JSONL/日志取证 <memory> 块确实进入 prompt**，不以界面绿勾为凭。
- 删除/置顶/编辑/归档/重建索引/损坏修复全通；衰减单测覆盖：pinned 豁免、半衰期边界、预算截断、pinned 超预算、注入不重置时钟/检索命中重置。
- 文件树不出现 .sparkii；agent write 工具写 .sparkii 被拒（实测取证）。
- auto 工作区不建项目记忆。
- 设置页深色主题截图 + Chrome CDP console/network 清洁。

### M2 提炼管道与显式工具（约 4–5 人日）
新增：提炼调度器（debounce+门槛+entry-id 位点）、素材读取器、ops 解析器（fail closed）、pending 队列 UI（含全部出口）、memory_remember/memory_forget 工具与可信分支、'memory' 路由任务。
挂点：ipc.ts（settled 触发器 + 可信分支）、tool-registry.ts、saddle.ts（工具附加）、model-router/types.ts。
验收（可证伪）：
- 端到端：对话表达偏好 → 静默期后 pending 出现（含 excerpt）→ 批准 → 下一条会话注入；驳回 → 同候选不再提案。
- 畸形 JSON 注入测试：整批丢弃 + errors.db 有记录，文件无半批写入（grep 取证）。
- memory_forget 弹审批；确认后文件+db+FTS 三处 grep 无残留；隐私删除后 episodes/pending/黑名单/JSONL/chat_sessions 五处无残留。
- **槽位礼让实测**：占满 maxAgents 后触发提炼窗口 ⇒ pool snapshot 无排队条目、提炼跳过（日志取证）；交互 prompt 不被阻塞。
- 开关关闭后零 LLM 出机调用（network 取证）。
- 批准时 targetId 已删 ⇒ 降级 ADD 候选（出口用例）。

### M3 情景检索与空闲整合（约 4–5 人日）
新增：memory_search、episodes 检索、空闲整合调度、superseded 历史视图、相似合并提案。
验收（可证伪）：跨项目模糊回忆用例（"上个月那个项目"）经 memory_search 命中情景摘要并定位项目；整合提案进 pending；**同一检索连跑两次，命中数与 accessCount 增量一致**；强化后衰减时钟重置可单测复算。

合计约 11–13 人日。每里程碑独立可交付：M1 手动记忆+注入+衰减，M2 自动懂你，M3 记得所有项目。

## 16. 评审记录

**首轮（2026-11-23，架构师 agent，只读对码）**：判定"有条件通过"。抓出 1 阻塞 + 6 必修 + 3 建议：
1. [阻塞] 工具走现有审批门必被硬拒（dataDir closure/critical、空 resources、UNKNOWN_TOOL、闭联合、非 win32 无 security）→ 已改平台可信分支（§10），本人二次对码确认全部证据属实。
2. [必修] 槽位礼让失真（idle 15s < debounce 90s；acquire 排队非失败）→ §7.2 改内部槽位 + snapshot 预检 + cancelPending，先例 withProbeSlot/injectProbeKey 已核实。
3. [必修] "会话中途固定是 SDK 限制"有误 → §3/§6.4 改为平台取舍，热更零 SDK 改动可做。
4. [必修] 真删完整性缺口（episodes/黑名单/superseded/悬空出口）→ §8 两档删除定义 + §7.4 出口穷举。
5. [必修] 工作区单写者假设不成立 → §5.2 围栏三件 + 漂移修复。
6. [必修] 注入即强化导致预算内永不衰减；pinned 超预算未定义 → §6.2 强化/注入分离 + 超预算规则。
7. [必修] pending 出口不全（targetId 失效/搬迁）→ §7.4 出口表 + §4 projectId 自愈。
8. [建议] prompt 末尾表述/挂点清单（model-router types、preload 修改、围栏文件）/JSONL entry-id 位点 → 均已采纳。
评审未核完项（已声明）：子进程 complete 与 in-flight prompt 的并发序列化行为——M2 实施时以实测补证；远端外发通道穷举仅限 memory-service 自身与 persistHitTurn。
评审全程只读声明：未改文件、未跑测试/构建、未开数据库；FTS 结论为编译期证据+推断，M1 运行时探测兜底。

**修订后状态**：阻塞项与必修项全部落实于 v2 正文；待用户拍板后按 M1 → M2 → M3 开工。