# 标书写作智能体（bid-writing）实施动工提示词

> 用法：把下面 "【提示词开始】" 到 "【提示词结束】" 之间的内容整段复制到新 session。新 session 没有当前对话记忆，提示词已自包含。

---

【提示词开始】

# 任务：标书写作智能体（bid-writing）具体实施

你是 Sparkii Desktop 的实施工程师。请基于已通过三轮架构审核的产品设计文档，完成从技术设计到代码实施的完整闭环。**全程使用中文交流。**

## 第一步：动手前先读资料（全部读完再写任何代码）

1. **权威需求源**：`docs/superpowers/specs/2026-11-17-bid-writing-agent-design.md`（17 章，重点读 §5 工作区数据模型、§6 两条上下文线、§7 图表生成与渲染、§8 Markdown 中间态、§9 UI/UX、§10 对话机制、§11 审批安全、§13 待验证项、§14 平台改动清单、§16 落地阶段）。
2. **平台原则与边界**：`PRODUCT.md`、`DESIGN.md`、`README.md`、`AGENTS.md`。
3. **审核历史（避免重犯已修过的坑）**：
   - `C:/Users/YDJ/.workbuddy/plans/swift-thunder-curie-NAyWzGZv.md`（首轮：不通过，B1-B6/I1-I8/O1-O4）
   - `C:/Users/YDJ/.workbuddy/plans/radiant-pulse-tesla-xLWyAjmQ.md`（第二轮：仍需修改，R1-R4/O1-O3）
   - 终审结论：全部审核通过（见设计文档末尾）。
4. **权威技术依据（按需核对，不要凭印象）**：`docs/superpowers/specs/` 下的 `2026-09-02-agent-surface-thin-contract-custom-extension.md`、`2026-09-05-live-session-pipeline-design.md`、`2026-10-21-agent-approval-boundary-design.md`、`2026-09-11-session-workspace-home.md`（后者在 `docs/superpowers/plans/`）。
5. **设计决策来龙去脉**：`.workbuddy/memory/2026-11-17.md`。

**已知文档瑕疵（以权威章节为准）**：§10.2、§12、§13 表格 T5 中残留「`promptSession` 新建 + `setChatWorkspace` 绑回」的旧表述；新会话绑定的正确方案以 §5.3 / §9.4 为准，即用 `promptSession(..., context: { workspacePath, workspaceKind: 'auto' })` 一步绑定项目固定工作区，`setChatWorkspace` 仅作备选（会把 `workspaceKind` 置为 `'user'`）。

## 第二步：不可违反的硬约束

1. **平台改动严格登记、完整记录**：所有平台改动按设计文档 §14 的 P1-P7 表格格式逐条登记——改动文件/层、改什么、为什么、是否通用非特判、对其他智能体的影响、回归验证点。新增改动立即登记，绝不留下未登记的隐式改动。
2. **零业务特判**：平台核心禁止出现 `if (agentId === 'bid-writing')` 或等价业务分支；所有改动必须是通用能力或标准接入动作。review 发现特判即判违规。
3. **不影响其他智能体**：每次平台改动后必须全量回归 `general` / `contract-review` / `knowledge-qa` / `procurement-review` 等现有智能体，确认行为不变。P1 影响面最大，须单独评审并先做 spike。
4. **P6/P7 是兜底条目**：T1 项目级检索、T2 draw.io 渲染一旦确定需要平台侧能力，立即把对应条目转为确定条目并补全登记。
5. **权威状态在工作区文件，不在会话上下文**：项目 = 一份标书 = 一个固定工作区；每条对话 = 独立 `ChatSessionRecord` + 独立 JSONL + 同一固定 `workspacePath`；新会话空上下文、按需加载资料。
6. **审批按现行模型**：使用 Task Grant / Capability Gateway / Workspace Admission；工作区内增删改查（含删除）不产生 Approval Proposal，但必须写 Tool 时间线与审计；最终导出由用户主动点击构成授权。**禁止回退到旧的 `requireApproval` 工具白名单说法。**
7. **安全边界**：P1 新增 IPC 每次操作须经 Workspace Admission 校验目标在固定工作区内、拒绝越界（含 `..` 与符号链接逃逸）、写审计并回溯 sessionId→项目、失败关闭。
8. **不删除 `.workbuddy` 目录**；不碰系统核心文件；所有改动可回滚。

## 第三步：执行顺序（严格按阶段推进，每阶段完成后先汇报再继续）

### 阶段 A：技术设计 + P0 可行性验证（先做，不要直接写业务代码）

1. 定稿 T1-T6 技术方案，尤其是：
   - **T1** 项目私有资料按需检索：确定 A（项目级索引）还是 B（摘要清单），以及归属（包内 or 平台 P6）；
   - **T2** draw.io XML→PNG/SVG 本机渲染 + 图片内嵌源 XML 可编辑：验证离线/中文/体积，降级方案也必须本机；确定归属（包内 or 平台 P7）；
   - **T3** MD+图片→DOCX 编译：收口单一方案；
   - **T4** WYSIWYG 编辑 + `blockId` 三方合并 + 冲突提示；
   - **T5/T6** workspacePath 分组、新会话绑定与回放（按 §5.3 一步式绑定）。
2. 做三个 P0 spike 并记录结论：T2 渲染、T1 检索、P1 IPC（与现有 `readDocumentBytes` / `requestExportReport` 是否冲突）。
3. 产出技术设计文档：`docs/superpowers/plans/2026-11-17-bid-writing-agent-technical-design.md`，含 T1-T6 定稿方案、P6/P7 归属结论、P1 IPC 接口与安全边界、风险与备选。
4. **任一 P0 spike 不可行 → 停下来向用户汇报并请求决策，不得自行降级为联网方案。**

### 阶段 B：实现计划

把 §16 的 P0-P5 阶段与 §14 的 P1-P7 平台改动展开为带依赖顺序的任务清单。每个任务必须含：改动文件、测试用例、对其他智能体的回归点、验收标准。

### 阶段 C：编码实施

按阶段 B 顺序逐阶段实现：

- **P1 骨架**：profile 包 + 三栏 Surface + `project.json` + 项目列表/向导 + 工作区绑定（P1/P2/P3/P5）；
- **P2 写作闭环**：两条上下文线 + Markdown 中间态 + 章节生成 + 手改合并 + 版本快照 + 多会话（对话显示**完全复用 Live Session Pipeline**，不新造机制）；
- **P3 图表**：图结构 skill + 转换/渲染 + 编辑闭环；
- **P4 导出**：MD+图→DOCX 编译 + 审计；
- **P5 打磨**：项目级检索索引、搜索、记住大纲位置。

### 阶段 D：验证与交付

1. 每阶段完成后跑测试 + 其他智能体全量回归；
2. 同步更新 §14 平台改动清单与技术设计文档，保持文档与代码一致；
3. 最终产出：改动文件清单、测试结果、回归报告、已知限制。

## 第四步：汇报规则

- 每个阶段完成后先汇报，等用户确认再进入下一阶段，不要一口气闷头做完。
- 遇到以下情况**必须停下询问，不自行决定**：设计文档未覆盖的决策点、P0 spike 不可行、平台改动超出 P1-P7 范围、需要新增业务特判。
- 完成后说明：实现了什么、改了哪些平台文件、如何验证、还有什么没做。

【提示词结束】
