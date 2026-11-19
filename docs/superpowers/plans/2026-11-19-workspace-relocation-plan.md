# 标书写作智能体 · 准备阶段可改「存放位置」实施计划

- 日期：2026-11-19
- 决策来源：工作区管理 UI/UX 设计讨论第 ⑥ 项（存放位置，方案 C）；第 ⑦ 项（知识库绑定入口，本次新增设计）
- 状态：**架构师评审 + 统一复审完成（需修改后通过，修订已合入）+ 技术验证完成（2 项放行条件已解除）→ 待知识库设计专项确认后放行**
- 架构师评审：`docs/superpowers/reviews/2026-11-19-workspace-relocation-arch-review.md`
- 技术验证：`docs/superpowers/reviews/2026-11-19-workspace-relocation-tech-verification.md`
- 统一复审：`docs/superpowers/reviews/2026-11-19-unified-review.md`
- 关联：`docs/workspace-management-ui-design.html`（UI 设计稿）、`2026-11-17-bid-writing-agent-technical-design.md`（P1/P9 设计）

> 本稿已根据架构师评审的 5 条 MUST-FIX、4 条 SHOULD-FIX 与遗漏边界修订。修订点以「【评审修订】」标注。

---

## 1. 背景与决策

用户在通用聊天里见过 WorkspaceButton 的「更换工作区」，问标书场景是否也应提供。

经代码核实，两者语义本质不同（详见设计稿第 1 节）：

| | 通用聊天 | 标书写作 |
|---|---|---|
| 工作区是什么 | 会话上一个可替换字段 | 一份标书的全部交付物 |
| 换的含义 | 改字段，不搬文件，新目录是空的 | 等于换项目 / 必须整体搬迁 |
| 风险 | 低（临时工棚可丢弃） | 高（交付物不可丢） |

**结论：不做通用式「更换工作区」。** 但保留一个真实诉求——用户想把标书放到自己指定的位置（网盘、归档目录）。因此采纳方案 C：

> 准备阶段（setup）可改「存放位置」；一旦开始写作（drafting/exported）即锁定。

术语约定：界面上叫**「存放位置」**，不叫「更换工作区」。底层能力是 relocate workspace root。

---

## 2. 目标 / 非目标

### 目标

1. setup 阶段，用户可在工作区抽屉点「更改存放位置」，选一个空目录，把整个项目工作区搬过去。
2. 搬迁后：正文、资料、版本、索引、章节文件、project.json 完整可用；会话历史、知识库绑定不丢。
3. drafting / exported 阶段不暴露该入口，且包内有守卫拒绝调用。
4. 平台侧不改任何 bid-writing 业务语义，作为通用能力提供。

### 非目标

- 不做通用聊天的「切换到已有工作区」（不把项目指向一个非空旧目录）。
- 不做写作中的热搬迁。
- 不做跨项目的批量搬迁。
- 不修改 B1/B2/B3 的修复计划（独立的前置 bug 修复）。

---

## 3. 关键事实（均已逐行核对代码 + 评审复核）

| # | 事实 | 代码依据 | 对方案的影响 | 评审结论 |
|---|---|---|---|---|
| F1 | workspacePath 存两份：`chat_sessions.workspace_path`（P1 文件服务唯一真相）与 `project.json.workspacePath`（agent 私有，供 refreshProjects 分组） | `chat-session-store.ts:15,34`、`project-store.ts:35,97-105` | 搬迁后两处必须同步；顺序：先 session record，后 project.json | ✅ 准确 |
| F2 | 文件服务明确禁止 move/rename workspace root | `workspace-file-service.ts:272-274` | 不能靠 P1 的 `workspaceMove` 搬根目录，必须新增独立能力 | ✅ 准确 |
| F3 | `setChatWorkspace` 只改字段、不搬文件，还会 `taskLifecycle.end` | `ipc.ts:1522-1538` | 不能直接复用；但它展示了 configure_session 重绑 saddle 的做法 | ✅ 准确 |
| F4 | P1 IPC 全部 session-relative，路径从 session record 派生 | `workspace-file-service.ts:109-133` | 包内无法写「另一个目录」，root 搬迁必须平台做 | ✅ 准确 |
| F5 | setup 阶段无 LLM 流、composer 被拦截、无正文/版本；**但处于 B1 迟到 `agent_settled` 窗口，仍需防并发写入** | `index.tsx:235-238,296-344`、设计稿 `:208-209` | 搬迁窗口相对干净，但不可假设「无活跃 Grant」，需平台通用 idle 前置校验 | ⚠️ 已按评审修订 |
| F6 | 资料索引在工作区内 `input/.index/chunks.json` | `project-index.ts:31,51-60` | 整体搬目录时索引自动跟随，**无需重建** | ✅ 准确 |
| F7 | 知识库绑定按 sessionId（`sessionKnowledgeSelections` 内存 Map），与路径无关；但该 Map 重启即失（既有问题，非搬迁引入） | `ipc.ts:606,2216-2218`、`index.tsx:393-397` | sessionId 不变则绑定自动保留 | ✅ 准确（补注内存态） |
| F8 | 多个 session 可能共享同一 workspacePath（`startNewConversation` 用同路径建新会话） | `index.tsx:185-190,411-434` | relocate 必须批量更新所有引用该路径的 session record | ✅ 准确 |
| F9 | 开放会话重绑需要 `configure_session` + `buildSaddle`；须为每个 open session 用其自身 profileId 调 buildSaddle | `ipc.ts:631-634`、`pi-runtime.ts:156-158` | 搬迁后对每个 open 会话重发 | ✅ 准确（补注 profileId） |
| F10 | 二进制资料在 setup 只写占位文本，原文留在工作区外（用户本地路径），按需由文档解析工具读取 | `index.tsx:265-274` | 工作区内无大二进制，搬迁代价小；目标是「工作区内文件树完整」，不含工作区外原文 | ⚠️ 措辞已修订 |

---

## 4. 技术路径选型

### 路径 A：平台新增通用 IPC `sparkii:relocateWorkspace`（**采纳**）

平台负责整体搬迁 + session record 批量更新 + saddle 重绑 + 审计；包内只负责 UI 与 project.json 同步。

- 优点：sessionId 不变 → 会话历史（F7）、知识库绑定（F7）、索引（F6）全部自动跟随；原子性可设计；语义清晰。
- 缺点：改平台核心，需全 agent 回归；新增 IPC 要补测试。

### 路径 B：包内「重建 session」搬迁（**否决**）

`chooseWorkspace` → `createSession` 建新会话 → 逐文件读写搬运 → 删旧会话 → `openSession`。

- 否决理由：sessionId 变化会断会话历史、知识库绑定要重绑、多 session 关系（F8）更难处理；逐文件非原子；本质是用通用 IPC 拼凑 root 搬迁，语义不清。

### 选型结论

**路径 A。** F6/F7/F8 决定「sessionId 不变 + 整体搬目录」是唯一干净解。**但执行顺序必须按评审的 MUST-FIX 重做**（见 5.1）。平台保持通用（无 agentId/标书语义），setup 限制放包内并辅以平台通用 idle 校验。

---

## 5. 详细设计

### 5.1 平台新增 IPC：`sparkii:relocateWorkspace(sessionId, newPath)`

> 【评审修订】MUST-FIX 1/2/3/4/5 已合入。核心变化：
> - **复制优先 + 末位删源**（不再是 rename 后事务失败就删目标——那会删掉唯一副本）
> - **不主动 `taskLifecycle.end`**，改为平台通用「无活跃流 / 无活跃 Grant」前置校验（与 B1 共用原语）
> - **复制优先 + 末位删源**（【技术验证修订】原"Pi 进程 cwd 锁工作区"前提已被推翻，见验证报告；configure_session 保留但目的是更新工具可见的 workspaceRoot，不是释放句柄）
> - **显式 reparse point / canonical / 循环嵌套校验**（`admitWorkspace` 不覆盖这些）

执行顺序：

1. **基础校验**：session 存在；newPath 绝对路径；大小写不敏感 FS 下 `resolve(old) !== resolve(new)`（用 canonical 比较）；源目录存在。
2. **循环嵌套校验**：`isSameOrDescendant(old, new)` 或反向为真则拒绝（防止 `cp recursive` 自我嵌套爆炸）。
3. **准入校验（双向）**：对源与目标各跑 `admitWorkspace`（protectedRoots）+ 显式 `pathProbe.inspect`：拒绝 reparse point / junction / 符号链接 / 硬链接别名（nlink>1），并做 canonical 身份校验（复用 `verifyTarget` 语义）。注意 `admitWorkspace` 本身**不检查** reparse point 与硬链接。
4. **平台通用 idle 校验**：确认该 workspacePath 关联的会话无活跃流、无活跃 Grant——用现成的 `taskLifecycle.active(sessionId) === undefined` 配合 streaming 状态判定，不新增原语。【统一表述】不做**主动** `end` 来"制造空闲"；若实现需防御性清理，允许一次 `taskLifecycle.end(sessionId, 'workspace-relocated')`，但 `end` 幂等（无 Grant 时无副作用），且它**不是**空闲判定的手段。B1 的根因（迟到 `agent_settled` 无条件 end，ipc.ts:730-733）须在 B1 修复中独立解决，不依赖本步骤。
5. **目标空目录校验（平台侧 readdir 实做）**：目标不存在则由平台 `mkdir` 创建；存在且非空则拒绝（不依赖 UI）。理顺 `openDirectory` 契约——该流程下目标通常已存在，需明确是「用户选中已存在的空目录」还是「平台在选中父目录下新建子目录」，二选一并写死。
6. **复制到目标**：`fs.cp(src, dst, { recursive: true })`；跨盘无需 rename，天然规避 EXDEV。
7. **副本对账**：比较源/目标文件数与总字节数（必要时 hash），不一致抛错并清理目标副本。
8. **批量更新 session record（单事务）**：新增 `ChatSessionStore.updateWorkspacePathInTransaction(old, new, kind)`（`db` 为 private，须在 store 内实现事务方法），找出所有 `workspacePath === old` 的会话统一更新。事务失败 → 删目标副本，session record 未变，安全。
9. **重绑 saddle**：对每个处于 open 的会话，用其**自身 profileId** 调 `buildSaddle` 并 `configure_session`，让工具看到更新后的 `workspaceRoot`（此时 record 已更新，buildSaddle 读到新路径）。【技术验证修订】此步**不涉及 OS 句柄释放**——Pi 进程 cwd 是 app data 目录、不在工作区，configureSaddle 也不 chdir；详见验证报告。
10. **验证**：确认所有关联会话 record 已指向新路径、open 会话 saddle 已切换、无写入落回旧路径。
11. **末位删源**：确认第 10 步全通过后，才 `fs.rm(src, { recursive: true })`。若删源失败（文件句柄占用等），**保留双份副本**并告警 + 写审计，进入对账/清理流程，**绝不删除当前唯一副本**。
12. **审计**：allowed 与 failure/rollback 路径都写审计（与 P1 fail-closed 一致）。
13. 返回 `{ ok: true, workspacePath: newPath }`。

失败策略汇总（评审 MUST-FIX 1）：
- 步骤 6 复制失败 → 清理目标副本，源完好；
- 步骤 7 对账失败 → 清理目标副本，源完好；
- 步骤 8 事务失败 → 清理目标副本，record 未变；
- 步骤 11 删源失败 → 保留双份 + 告警 + 审计，不删唯一副本。

### 5.2 preload 桥接

- `api-types.ts`：新增 `relocateWorkspace(sessionId, newPath): Promise<{ ok: boolean; workspacePath?: string }>`。
- `api.ts`：新增 invoke `relocateWorkspace`。
- `test/preload-api.test.ts`：新增方法名与 channel 断言。

### 5.3 包内 UI（bid-writing surface）

- 工作区抽屉头部，「复制路径」「在文件夹中打开」之后新增「更改存放位置」按钮。**仅 `activeProject.status === 'setup'` 时渲染**。
- 点击流程：`sparkii.chooseWorkspace({ defaultPath: 当前路径的父目录 })` → `sparkii.relocateWorkspace(sessionId, newPath)`。
- 成功后：更新 `activeProject.workspacePath` → `writeProject`（此时 session record 已指向新路径，写入落点正确，F1）→ `refreshProjects()` → 状态提示。
- 失败后：显示具体错误码/消息（复用 B3 的错误回显改进）。

### 5.4 写作后锁定（仅限「存放位置」）

- UI 层：drafting/exported 不渲染**存放位置**入口。
- 包内守卫：`changeStorageLocation()` 首行检查 `activeProject.status !== 'setup'` 直接 return。
- 【评审修订】平台侧增加**通用「会话空闲 / 无活跃 Grant」前置校验**（5.1 步骤 4），作为非业务特判的兜底。仅 UI+包内守卫仍不足以防真实数据问题。
- 说明：这是本地桌面应用的 UX 约束，不是安全边界（用户本可直接改磁盘文件）。

**【v2 修订 · 知识库绑定不适用此锁定】**：用户验收指出，写作后无法改知识库绑定是设计缺陷。知识库绑定是低风险检索源配置，与高风险目录搬迁性质不同。因此：

- 知识库入口放**顶栏常驻**（与"工作区"并列，popover），setup / drafting / exported 全程可改。
- 准备阶段面板内只保留摘要 +「前往设置」指引；该面板 drafting 后不渲染，不影响顶栏入口。
- 写作中改绑定：立即对后续检索生效，不影响已写正文；提交仍是 `setSessionKnowledge` + `writeProject` + 刷新 + 草稿回滚。
- 设计稿 v2 与决策⑦已同步此修订。

### 5.5 一致性顺序（关键）

```
用户选新路径
  → 平台 relocateWorkspace:
      校验(含循环嵌套/reparse/idle/空目录)
      → 复制源→目标 → 副本对账
      → 批量事务更新 session records
      → configure_session 切 cwd/释放句柄 → 验证
      → 末位删源（失败则保留双份+告警）
      → 审计
  → 包内:
      更新 activeProject.workspacePath → writeProject → refreshProjects
      → 广播 workspace-relocated 事件
```

绝不能先写 project.json：P1 会按旧 session record 把内容写回旧目录（F1/F4）。

### 5.6 跨窗口状态同步【评审 SHOULD-FIX】

批量更新 record 后，其他窗口的 `activeProject.workspacePath` 仍是旧值，后续 `writeProject` 会把旧路径写回 project.json。要求：
- 平台搬迁成功后广播 `workspace-relocated` 事件（携带 oldPath/newPath/sessionIds）。
- 各窗口监听到后强制 `refreshProjects()` 并刷新 activeProject。
- 多窗口测试覆盖。

---

## 6. 改动清单（文件级）

| 层 | 文件 | 改动 |
|---|---|---|
| 平台 | `apps/desktop/electron/main/ipc.ts` | 新增 `sparkii:relocateWorkspace`；idle 校验；广播 `workspace-relocated` |
| 平台 | `apps/desktop/electron/main/workspace.ts`（或新 helper） | 搬迁 helper：循环嵌套/reparse/canonical 校验、空目录校验、cp+对账、末位删源 |
| **平台** | **`apps/desktop/electron/main/chat-session-store.ts`【评审新增】** | **新增 `updateWorkspacePathInTransaction(old, new, kind)` 单事务批量更新方法** |
| 桥接 | `apps/desktop/electron/preload/api.ts`、`api-types.ts` | 暴露 `relocateWorkspace`、`workspace-relocated` 事件订阅 |
| 包内 | `apps/desktop/agents/bid-writing/surface/index.tsx` | 抽屉按钮、chooseWorkspace、relocate 调用、project.json 同步、status 守卫、事件监听刷新 |
| 包内（知识库 ⑦） | `apps/desktop/agents/bid-writing/surface/index.tsx` | 准备阶段加载 dataset 列表（`listRagDatasets`）；从 `activeProject.knowledgeBases` 派生选中态；「应用绑定」同时调 `setSessionKnowledge`+`writeProject`+刷新；草稿态取消回滚；打开会话时按 project.json 恢复绑定（补内存 Map 重启丢失） |
| 包内 | `apps/desktop/agents/bid-writing/surface/styles.css` | 按钮、提示、知识库标签/勾选区样式 |
| 测试 | `apps/desktop/test/ipc.test.ts` | relocate 行为、批量事务更新、空目录拒绝、循环嵌套、reparse、跨盘对账、句柄占用 mock(EBUSY)、多窗口、部分事务失败、审计 |
| 测试 | `apps/desktop/test/preload-api.test.ts` | channel 断言 |
| 测试 | `apps/desktop/test/bid-writing-surface.test.tsx` | setup 显示/drafting 隐藏、同步顺序、status 守卫、事件刷新；**知识库：应用绑定调用链、取消回滚、空绑定态、无连接降级、按 project.json 恢复绑定、多 session 一致性** |
| 设计稿 | `docs/workspace-management-ui-design.html` | 补第 ⑥⑦ 项决策、知识库绑定区与向导 mockup（v2 已完成） |
| 文档 | `docs/superpowers/specs/...bid-writing-agent-design.md` | 平台改动清单登记 P10 |
| 文档 | `docs/superpowers/plans/...bid-writing-agent-technical-design.md` | 新增 P10 章节 |

---

## 7. 测试策略

1. **IPC 单测**：同盘/跨盘搬迁；副本对账；目标非空拒绝；循环嵌套拒绝；reparse point 拒绝；批量事务更新（部分失败回滚）；idle 校验；句柄占用 mock(EBUSY)；末位删源失败保留双份；审计（含失败路径）。
2. **preload 单测**：方法存在、channel 正确、事件订阅。
3. **surface 单测**：setup 渲染入口、drafting/exported 不渲染；调用链顺序（relocate → writeProject → 广播刷新）；status 守卫拦截；失败错误回显；跨窗口事件刷新。
4. **知识库 UI 单测（⑦）**：准备阶段加载 dataset；勾选草稿态 ↔ 已绑定态区分；「应用绑定」调用链（setSessionKnowledge + writeProject + 刷新）；「取消」回滚到 committed 状态；空绑定（空数组）显示；无连接降级文案；打开会话按 project.json 恢复绑定；多 session 共享 workspacePath 时绑定一致性。
5. **回归**：全 agent 测试套件（当前 175/175）+ `pnpm typecheck` 双端 0 错误 + 真实 profile loader 加载。
6. **手工验收**：建 setup 项目 → 加资料 → 改存放位置 → 打开新路径确认文件树完整；准备阶段更换知识库 → 重启应用确认绑定保留 → 开始写作 → 确认入口消失且写作正常。
7. **B1 前置依赖**：B1 修复（ipc.ts:730-733 agent_settled 归属判断）须与搬迁同批或更早合入，否则 idle 校验语义不可靠。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 目录搬迁与 record 更新非原子 | 复制优先 + 事务更新 + 各失败路径不删唯一副本；最坏留双份副本并告警/对账 |
| 多 session 共享路径（F8）漏更新 | 按 workspacePath 批量事务更新，写单测；新增 store 事务方法 |
| 删源时被未知进程占用（资源管理器/杀软等） | 【技术验证修订】Pi 进程不锁工作区；末位删源，失败则保留双份 + 告警 + 审计 |
| 用户选到非空目录被覆盖 | 平台侧 readdir 实做空目录校验 |
| 循环嵌套 / reparse / 硬链接 | 双向 isSameOrDescendant + pathProbe.inspect + canonical 校验 |
| 跨盘 cp 中断留半副本 | 文件数/字节数/hash 对账；不一致清理目标 |
| 写作中误触搬迁 | UI + 包内 status 守卫 + 平台通用 idle 校验 |
| 与 B1 Task Grant 竞态叠加 | relocate 不主动 end，复用 B1 修复后的空闲原语 |
| 跨窗口状态不同步 | 广播 workspace-relocated + 强制刷新 + 多窗口测试 |
| 仅前端锁定可被绕过 | 明确定位为 UX 约束而非安全边界 |

---

## 9. 分阶段交付（建议 3 个 commit）

1. **commit 1 — 平台能力**：`relocateWorkspace` IPC + 搬迁 helper + store 事务方法 + preload + IPC/preload 测试。
2. **commit 2 — 包内接入**：抽屉按钮 + chooseWorkspace + project.json 同步 + status 守卫 + 事件刷新 + surface 测试。
3. **commit 3 — 文档与回归**：设计稿补 ⑥、设计/技术文档登记 P10、全量回归。

B1/B2/B3 的前置 bug 修复建议在此之前单独成 commit。**注意 B1 与本次 relocate 的空闲原语需统一定义，不可各自实现。**

---

## 10. 架构师评审结论与放行条件

评审报告：`docs/superpowers/reviews/2026-11-19-workspace-relocation-arch-review.md`
总评：**需修改后通过**（修订已合入本稿）。

### 已合入的 MUST-FIX（5 条）
1. 回滚不再删唯一副本 → 复制优先 + 末位删源（5.1 步骤 6-11）。
2. 新增 store 单事务批量更新方法并补入改动清单（5.1 步骤 8、第 6 节）。
3. Windows 句柄占用：先切 cwd/释放句柄再删源，顺序重排（5.1 步骤 9-11）。
4. 准入选配：显式 reparse/canonical + 循环嵌套 + 平台侧空目录校验（5.1 步骤 2/3/5）。
5. 移除主动 `taskLifecycle.end`，改平台通用 idle 校验并与 B1 共用原语（5.1 步骤 4）。

### 已合入的 SHOULD-FIX（4 条）
- 跨窗口广播 `workspace-relocated` + 强制刷新（5.6）。
- 空目录校验平台侧实做、契约写死（5.1 步骤 5）。
- 「留双份副本」定义清理契约 + 失败路径审计（5.1 步骤 11/12）。
- F5/F10 措辞修订（第 3 节）。

### 放行条件（进入编码前需你/架构师确认）
1. 搬迁顺序改为复制优先 + 末位删源，所有失败路径不删唯一副本。 ✅ 已合入
2. store 增加单事务批量更新并补入清单。 ✅ 已合入
3. Windows 句柄占用方案落地且与 B1「保持槽位」协同验证。 ✅ 技术验证完成：前提不成立（Pi 进程 cwd 不在工作区），降级为兜底；见 `docs/superpowers/reviews/2026-11-19-workspace-relocation-tech-verification.md`
4. 目标准入改为显式 reparse/canonical + 循环嵌套校验。 ✅ 已合入
5. 移除主动 end，改 idle 校验并与 B1 共用原语。 ✅ 技术验证完成：原语已存在（`taskLifecycle.active`），B1 独立修复 agent_settled 误 end，与 relocate 解耦；见验证报告
6. 增加跨窗口状态同步与多窗口测试。 ✅ 已合入
7. 平台侧空目录校验 + 双份副本清理契约。 ✅ 已合入
8. 测试补循环嵌套/reparse/句柄占用/多窗口/部分事务失败/跨盘对账；清单补漏文件。 ✅ 已合入
9. 修正 F5/F10 表述。 ✅ 已合入

**剩余 2 项需在编码阶段与 B1 修复协同验证（放行条件 3、5）。请确认是否据此放行。**
