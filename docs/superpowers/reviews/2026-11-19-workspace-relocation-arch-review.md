# 架构师评审报告 · 工作区搬迁（方案 C）

- 日期：2026-11-19
- 评审对象：`docs/superpowers/plans/2026-11-19-workspace-relocation-plan.md`
- 评审方式：独立评审 agent，逐行核对 F1-F10 事实断言与相关代码
- 处理方式：评审意见已合入计划修订稿

# 架构师评审结论

**总评**：需修改后通过

## 一、事实核对（F1-F10）

- **F1 ✅准确**。`chat-session-store.ts:15,34` 与 `project-store.ts:35,97-105` 确为两处存储；`writeProject` 经 `workspaceWrite` 从 session record 派生路径，"先 record 后 project.json"顺序成立。
- **F2 ✅准确**。`workspace-file-service.ts:272-274` 明确拒绝移动 root。
- **F3 ✅准确**。`ipc.ts:1522-1538` 仅改字段 + `taskLifecycle.end` + 对 open 会话 `configure_session`，不搬文件。
- **F4 ✅准确**。`workspace-file-service.ts:109-133` 从 session record 派生 root，包内只能传相对路径。
- **F5 ⚠️部分准确**：setup 确实无 LLM、composer 被拦截（`index.tsx:235-238`）。但"搬迁窗口干净、无活跃 Grant"不成立——B1 竞态根因正是建会话即释放槽位产生的迟到 `agent_settled`（`workspace-management-ui-design.html:208-209`），setup 恰处该窗口。
- **F6 ✅准确**。`project-index.ts:31,51-60`，索引在工作区内，整体搬迁自动跟随。
- **F7 ✅准确但需补注**：`sessionKnowledgeSelections` 是按 sessionId 的内存 Map（`ipc.ts:606,2216-2218`），与路径无关；但它是内存态，重启即失（既有问题，非搬迁引入）。
- **F8 ✅准确**。`index.tsx:185-190` 与 `411-434` 均按 `activeProject.workspacePath` 建/找会话，多 session 共享路径成立。
- **F9 ✅准确**。`buildSaddle`（`ipc.ts:631-634`）从 record 读路径，`configure_session`→`host.configureSaddle`（`pi-runtime.ts:156-158`）消费之。补充：须为每个 open session 用其自身 profileId 调 buildSaddle。
- **F10 ✅基本准确**。`index.tsx:265-274` 二进制写占位文本。但原文留在工作区外（用户本地路径），"资料完整可用"的措辞略过承诺。

## 二、MUST-FIX（必须修改才能进入编码）

1. **回滚删目标 = 数据全丢（5.1 步骤 6）**：同盘 `rename` 后源即消失，跨盘 `cp+rm` 后源已删；此时"事务失败→删目标目录"删的是唯一副本，与"宁可冗余不丢数据"直接矛盾。改为：复制→校验→更新 record→验证→最后删源；任何失败路径只保留目标或反向 rename 恢复源，禁止删除当前唯一副本。
2. **批量单事务无实现支撑且清单漏文件**：`ChatSessionStore.update` 仅单条、`db` 为 private（`chat-session-store.ts:145-157`），无事务 API。需新增 `updateWorkspacePathInTransaction` 并把 `apps/desktop/electron/main/chat-session-store.ts` 列入改动清单；否则中途失败留半更新状态。
3. **Windows 句柄占用导致 rename 失败**：setup 会话是 open 的，Pi 进程 cwd 在源目录，Windows 下该目录无法 rename；计划步骤 7 的 `configure_session` 却在步骤 5 搬目录之后，顺序错误。改为先复制、再切 cwd/释放句柄、最后删源；与 B1"保持槽位"方案协同验证。
4. **准入能力误配（步骤 2）**：`admitWorkspace`（`workspace-admission.ts:24-112`）只校验 protectedRoots，**不检查 reparse point、不检查硬链接别名**；`chooseWorkspace`（`ipc.ts:1578-1589`）更是无任何准入/空校验。目标须显式 `pathProbe.inspect` + `isReparsePoint` + canonical 身份校验（复用 `verifyTarget` 语义）。
5. **与 B1 Grant 修复冲突（步骤 4）**：relocate 主动 `taskLifecycle.end` 与 B1"仅当确属本轮 prompt 结束才 end / 保持槽位"（`html:458,498`）冲突；setup 无 Grant 时该调用无意义还可能污染迟到 settled 通道。改为不主动 end，改用平台通用"无活跃流/无活跃 Grant"前置校验。

## 三、SHOULD-FIX（强烈建议）

- 多窗口/其他 session 内存态不同步：批量更新 record 后，其他窗口 `activeProject.workspacePath` 仍是旧值，后续 `writeProject` 会把旧路径写回 `project.json`，导致分组错乱。需广播 `workspace-relocated` 事件并强制各窗口刷新。
- 空目录校验应在平台侧 `readdir` 实做，不能依赖 UI；"目标不存在则创建"在 `openDirectory` 流程中实际不会发生，需理顺契约。
- "留双份副本"仅可作为最后兜底，须定义对账/清理流程与用户提示，避免长期冗余。
- 失败/回滚路径也应写审计，与 P1 fail-closed 审计一致（步骤 8 仅记 allowed）。
- 澄清 F5/F10 措辞：F5 改为"无 LLM 流但需防 B1 迟到 settled 与并发 workspaceWrite"；F10 目标明确为"工作区内文件树完整"。

## 四、遗漏边界

- 目标是源的父/子目录（循环嵌套）：`cp recursive` 到自身后代会递归爆炸/自我嵌套，须做双向 `isSameOrDescendant` 校验。
- 硬链接（nlink>1）：`cp` 会断开硬链接语义，未处理。
- reparse point / junction / 符号链接（见 MUST-FIX 4）。
- 超长路径（Windows MAX_PATH）、UNC/网络盘、OneDrive 按需文件；只读/权限不足目录。
- Windows 大小写不敏感文件系统：仅大小写不同的 newPath 被误判为不同路径。
- 跨盘 `fs.cp` 非原子，中断留半副本，缺文件数/大小/hash 对账；磁盘空间不足。
- `piSessionFile`/anchorDir 是否含旧工作区绝对路径需核对。

## 五、选型裁决

- **路径 A vs B：裁 A**。F6/F7/F8 支撑"sessionId 不变 + 整体搬目录"；B 的 sessionId 变化会断历史、绑定与索引。但 A 的执行顺序必须按 MUST-FIX 重做。
- **多 session 模型**：批量更新必要，"禁止共享路径"不是更简替代（`startNewConversation`/`openProject` 设计即共享）。更根本的简化是把 workspacePath 从 session 解耦为 workspace 实体 + session 持 workspaceId，当前保留批量更新可接受（须配事务方法）。
- **锁定层级**：平台不判断业务态正确，但须增加**平台通用"会话空闲/无活跃 Grant"前置校验**（非业务特判）；仅 UI+包内 status 守卫不足以防真实数据问题。
- **Grant 处理**：relocate 不主动 end，复用 B1 修复后的"安全结束任务"原语，二者统一定义。

## 六、放行条件

1. 搬迁顺序改为复制优先 + 末位删源，所有失败路径不删唯一副本。
2. store 增加单事务批量更新方法并补入改动清单。
3. Windows 句柄占用方案落地，且与 B1"保持槽位"协同验证通过。
4. 目标准入改为显式 reparse point/canonical 校验 + 循环嵌套校验。
5. 移除主动 `taskLifecycle.end`，改为平台通用 idle 校验并与 B1 共用原语。
6. 增加跨窗口状态同步机制与多窗口测试。
7. 平台侧空目录校验 + 明确"留双份副本"清理契约。
8. 测试补：循环嵌套、reparse point、句柄占用（mock EBUSY）、多窗口、部分事务失败、跨盘半副本对账；清单补漏文件。
9. 修正 F5/F10 表述。

上述 9 项全部满足后，方可进入代码编写。

---

## 处理结果（合入记录）

评审 9 项放行条件中：
- **7 项已在计划修订稿合入**（条件 1/2/4/6/7/8/9）。
- **2 项需在编码阶段与 B1 修复协同验证**（条件 3 Windows 句柄、条件 5 idle 原语与 B1 统一定义）。

计划状态更新为「需修改后通过（修订已合入，待放行确认）」。
