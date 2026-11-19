# 施工提示词 · 标书写作智能体（工作区管理 + 知识库绑定）

> 复制下方全文，交给新 Agent 执行。它是自包含的：不需要看历史对话。

---

你是 Sparkii Desktop 项目的实施 Agent。请完成标书写作智能体的三项改动。全程用中文汇报。

## 0. 仓库约定（先做）

检查 `.codex-handoff/CURRENT.md`：若存在且首部含 `status: open`，该文件正文就是任务，逐字执行、不要修改或删除它，最终回复引用其 task-id。否则按本提示执行。

## 1. 必读材料（按序，不要跳过）

设计已定稿，**不要修改设计稿和评审文档**（它们是验收基准）：

1. `docs/workspace-management-ui-design.html` — UI 设计稿 v2（顶栏、工作区抽屉、知识库顶栏常驻入口、决策⑥⑦）
2. `docs/superpowers/plans/2026-11-19-workspace-relocation-plan.md` — 存放位置搬迁实施计划（含全部修订）
3. `docs/superpowers/reviews/2026-11-19-workspace-relocation-arch-review.md` — 架构师评审
4. `docs/superpowers/reviews/2026-11-19-workspace-relocation-tech-verification.md` — 技术验证（两项放行条件已解除）
5. `docs/superpowers/reviews/2026-11-19-unified-review.md` — 统一复审（含用户验收追加修订）

## 2. 三个工作包（严格按此顺序，分 3+ 个 commit）

### WP1 — 前置 bug 修复（B1 / B2 / B3）

- **B1（最关键）**：`apps/desktop/electron/main/ipc.ts:730-733`，`agent_settled` 事件无条件 `taskLifecycle.end(sessionId,'session-ended')`。迟到事件会撤销刚建立的 Task Grant → 工作区文件读写报 TASK_REVOKED。修法：给 settled 事件加"确属本轮 prompt"的归属判断（用 taskId / 轮次标识），只在该轮真正结束时 end。同时按设计稿推荐，将 P9 的"建完即释放槽位"改为"保持槽位 + 更激进 idle 释放（15s）"，与 end 修复协同；若实施中发现该策略风险高，可先只做归属判断、保留现状，并在交付报告里说明取舍。
- **B2**：`apps/desktop/agents/bid-writing/surface/index.tsx` 的 `openProject()`（约 411-434），fallback 用 `createSession` 建会话后未建骨架 → WORKSPACE_NOT_CREATED。补 `ensureSkeleton(sessionId)`，与 `createProject` 一致。
- **B3**：工具 deny 只显示笼统"无法读写"。把 `ruleId`（如 TASK_REVOKED）回显到对话气泡，便于定位。

### WP2 — 方案 C：准备阶段可改「存放位置」

- 平台新增通用 IPC `sparkii:relocateWorkspace(sessionId, newPath)`（无业务特判）。执行顺序**必须**按计划 5.1 的 13 步：
  基础校验 → 循环嵌套校验（双向 isSameOrDescendant）→ 准入校验（admitWorkspace + 显式 pathProbe.inspect 查 reparse/硬链接 + canonical）→ idle 校验（`taskLifecycle.active(sessionId)===undefined`，不做主动 end 制造空闲）→ 平台侧空目录校验 → 复制到目标 → 副本对账 → **批量事务更新** session records → configure_session 重绑 saddle → 验证 → 末位删源 → 审计。
- **`chat-session-store.ts` 新增 `updateWorkspacePathInTransaction(old,new,kind)`**（db 是 private，必须在该类内实现），按 workspacePath 批量更新所有会话（多 session 共享路径，F8）。
- preload 桥接：`api.ts` / `api-types.ts` 暴露 `relocateWorkspace` 和 `workspace-relocated` 事件订阅。
- surface：工作区抽屉加「更改存放位置」按钮，仅 setup 渲染；调用链 relocate → 更新 activeProject.workspacePath → writeProject → refreshProjects → 广播刷新。
- 顶层注释/设计稿里那句"零新增 IPC"已修正为"新增 1 个通用 IPC"。

### WP3 — 知识库绑定 UI（顶栏常驻，任何阶段可改）

- **设计已定稿为顶栏常驻**，不要再套用"写作后锁定"（那是存放位置的规则）。知识库入口放顶栏（与"工作区"并列，popover），setup / drafting / exported 全程可改；准备阶段面板内只保留摘要 +「前往设置」。
- surface 改动：
  - workbench 侧加载 dataset 列表（`listRagDatasets`，现仅 wizardOpen 时加载）；
  - 从 `activeProject.knowledgeBases` 派生选中态；
  - 「应用绑定」同时调 `setSessionKnowledge(sessionId,{mode:'ids',datasetIds})` + `writeProject` 更新 knowledgeBases + 刷新；「取消」回滚草稿态；
  - 打开会话时按 project.json 恢复绑定（现有 `sessionKnowledgeSelections` 是内存 Map，重启即失，必须补）；
  - 多 session 共享 workspacePath 时绑定一致性（F8）；
  - 无连接降级文案、空绑定态（空数组）。
- T1 索引（`input/.index/`）与 RAG 知识库是两条独立通道，**改知识库不影响 T1**，不要重建索引。

## 3. 已验证的关键事实（不要重新推导，直接采信）

- workspacePath 存两份：session record（P1 文件服务唯一真相）+ `project.json.workspacePath`（agent 私有）。顺序：先 session record，后 project.json，反过来会写回旧目录。
- workspace root **禁止**用 P1 的 workspaceMove 移动（`workspace-file-service.ts:272-274`），必须走新增 IPC。
- **Windows 句柄占用不是障碍**：本机实验证明 cwd 会锁目录（EBUSY），但 Pi 子进程 fork 不设 cwd（`pi-runtime/transports.ts`）、saddle.cwd 指向 app data（`ipc.ts:631-634`）、`configureSaddle` 不 chdir（`pi-sdk-runtime.ts:542-546`）。无任何常驻进程 cwd 在工作区。删源失败保留双份副本作为兜底即可。
- idle 原语已存在（`taskLifecycle.active`），无需新增。B1 根因独立在 ipc.ts:730-733，与 relocate 解耦。
- setup 阶段无 LLM 流、composer 被拦截、无活跃 Grant —— 搬迁窗口安全。

## 4. 已知坑（架构师评审抓出，必须避免）

1. 回滚**不能删唯一副本**：复制优先 + 末位删源；任何失败路径只清理目标副本或保留双份 + 告警 + 审计。
2. 批量更新必须单事务，否则中途失败留半更新状态。
3. `admitWorkspace` 不查 reparse point / 硬链接，须显式 `pathProbe.inspect` + canonical 校验。
4. 目标是源的父/子目录会递归爆炸，须双向 isSameOrDescendant 校验。
5. 跨盘用 `fs.cp`（rename 会 EXDEV）；复制后做文件数/字节数对账。
6. 知识库"应用绑定"必须真的调用 API，不能只改前端 checkbox（原型的草稿/已绑定态要落实）。

## 5. 测试与验收

- 新增单测：`ipc.test.ts`（relocate 全流程、批量事务、空目录/循环嵌套/reparse 拒绝、跨盘对账、句柄 mock EBUSY、多窗口、部分事务失败、审计）、`preload-api.test.ts`（channel）、`bid-writing-surface.test.tsx`（setup 显示/drafting 隐藏存放位置入口；知识库应用绑定调用链、取消回滚、空态、降级、按 project.json 恢复、多 session；顶栏入口写作后仍可改）。
- 全量回归：当前基线 **175/175 通过**，`pnpm typecheck` 双端 0 错误，真实 profile loader 可加载。不得引入回归。
- 手工验收：建 setup 项目 → 加资料 → 改存放位置 → 新路径文件树完整 → 改知识库 → 重启后绑定保留 → 开始写作 → 存放位置入口消失但顶栏知识库入口仍在且可改 → 写作正常。

## 6. 文档登记（最后做）

产品设计 §14 平台改动清单加 P10；技术设计 §10 加 P10 章节；记录 B1/B2/B3 修复与两项验证结论。**不要改动设计稿与评审文档本身。**

## 7. 汇报要求

每个 WP 完成后说明改了哪些文件、测试结果；遇到与本提示冲突的实际情况，先报告再决策，不要擅自改变设计定稿（尤其知识库顶栏常驻、存放位置写作后锁定这两条生命周期规则）。
