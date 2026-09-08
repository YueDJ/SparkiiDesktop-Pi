# 审批渲染解耦 + 智能体内联 + 隔离 + 未来规则预留 — Design Spec

**Status:** 已对齐（2026-09-08；渲染层设计，待实现）
**Date:** 2026-09-08
**Depends on:**
- `docs/superpowers/specs/2026-09-06-approval-presentation-design.md`（展示契约：`summary` + 可选 `preview` + `present()`）
- `docs/superpowers/specs/2026-09-06-general-chat-approval-timeline-design.md`（会话 JSONL 审批态投影）
- `packages/approval`（`ApprovalGate` 提案状态机 / 超时 / RBAC / 审计）
- `PRODUCT.md` / `DESIGN.md`（可控、可审计、写操作人工把关；Approval Ritual）

**Amends:**
- `apps/desktop/src/App.tsx` 集中持有 `pending` + `decide` 并全局渲染 `ApprovalPanel` / `ApprovalModal` 的现状
- 通用智能体表面只有 `awaitingApproval` 标记、无就地决策按钮的现状
- `packages/approval`：`ProposalRequest` / `Proposal` 增加必填 `requestId`（关联键，非展示字段）
- 09-06 的「Main 不推 renderer」一句：改为 Main 主动推送过期提案（见 §6 超时）

---

## 1. Goal

把「审批」的**逻辑与事实源**（平台）和「渲染位置 / 形态」（智能体）彻底解耦，并满足三点：

1. 平台只保留：`ApprovalGate`（已有）+ 待批收件箱 + 兜底抽屉 + 高风险强制弹窗。
2. 智能体自己决定是否内联显示、显示在哪；未来新智能体只遵守一个最小契约即可接入。
3. 预留未来便利机制（批量审批、会话级 / 持久自动审批），且保证自动通过仍然**可见、可审计**，不产生盲区。

本轮不改 `ApprovalGate` 的状态机、超时、RBAC、审计（§6 的超时推送与 §7 的 `requestId` 关联字段除外）。本 spec 只定**渲染层归谁、怎么隔离、怎么内联**，并书面定下未来规则层的接入点。

## 2. Current State（现状）

- `App.tsx` 同时持有：`pending` 状态、`decide()`、`partitionApprovals()`，并全局渲染右侧 `ApprovalPanel` 与居中 `ApprovalModal`。
- 通用智能体表面通过 `applyApprovalStatus` 把 `approval_required` / `approval_resolved` 投影到工具卡的 `awaitingApproval`，但**没有批准/拒绝按钮**；真正做决定的是右侧抽屉。
- 合同审核的 `report.export` 走 gate，但只在抽屉里出现；它的风险逐条确认是 workflow 业务复核，**不走 gate，与本 spec 无关**。
- 所有 `approval` 事件广播到整个 renderer；`listPendingApprovals()` 返回全量，渲染端再按需要挑。
- `Proposal` 目前只有 gate 生成的 `id`，没有提交端生成的 `requestId`，无法与 JSONL 时间线的审批行稳定关联。

## 3. Confirmed Decisions

1. **逻辑与渲染彻底分离。** 平台只保留 gate + 收件箱 + 兜底抽屉 + 高风险强制弹窗；其余渲染归智能体。
2. **采用「收件箱 + 认领（claim）」协议。** 认领是内部实现，**不暴露给智能体**，被封装进 `InlineApprovalCard`。
3. **身份隔离：智能体只能经 `useSessionApprovals(sessionId)` 拿自己会话的例行待批。** 不允许先拉全量再自己 `filter`。这是 renderer 内的封装边界，不是对抗恶意 surface 的安全边界（见 §7）。
4. **兜底抽屉只显示未认领的例行审批。** 智能体认领后抽屉不重复显示；智能体卸载（切会话 / 切页面）后认领自动释放，审批回到抽屉。**同一提案同一时刻只有一张决策卡（内联或抽屉）。**
5. **高风险不可认领，平台强制** `HighRiskApprovalDialog`（居中 + 倒计时 + 二次确认）。
6. **身份粒度用 `sessionId`**（一个智能体可同时多会话，按 session 隔离最精确）。
7. **`approve` / `reject` 不加 sessionId 校验**：谁能批是**用户** RBAC（gate 已校验），隔离针对的是**信息可见性**，不是决定权。
8. **命名人类可读**（见 §4），不出现 `Provider` / `Overlay` 这类技术角色词；`claim` 仅作为内部机制名，不进入公开 API 名。
9. **合同审核本轮零改动**：不订阅、不认领，其 gate 审批自然落抽屉。
10. **未来规则层预留**（§9）：批量 / 会话级 / 持久自动审批；命中规则仍**创建提案、仍广播、仍审计、仍留时间线痕迹**，只是状态直接 `approved` 并标注「自动通过 + 原因」。
11. **审批中心不设「自动通过」筛选**：自动与人工通过的记录都在中心里，按时间/状态可见即可。
12. **`requestId` 是提交端生成的权威关联键**：`ProposalRequest.requestId` 与 `Proposal.requestId` 均必填，用于把 gate 提案、JSONL 审批行、工具卡三者对齐。

## 4. Naming（人类可读命名表）

| 名字 | 归属 | 作用 |
| --- | --- | --- |
| `useSessionApprovals(sessionId)` | 智能体（唯一公开入口） | 只返回本会话的例行待批项 + `approve` / `reject` |
| `ApprovalInbox` | 平台内部 | renderer 内唯一待批缓存 + 路由 + 认领注册表；**不对智能体公开** |
| `ApprovalCard` | 共享展示 | 一张审批卡（纯展示，抽屉/内联共用） |
| `InlineApprovalCard` | 共享（平台封装认领，智能体使用） | 内联审批卡 = `ApprovalCard` + 自动认领 |
| `ApprovalDrawer` | 平台 | 兜底抽屉，只显示未认领的例行审批 |
| `HighRiskApprovalDialog` | 平台 | 高风险强制弹窗 |
| `ApprovalCenter` | 平台 | 审批中心页（全量，含自动通过，无筛选） |

返回字段：`waiting`（本会话例行待批项列表）、`approve(id, options?)`、`reject(id, options?)`。

`requestId` 是关联元数据：**不进 `payloadHash`**，也**不进 09-06 展示契约**（不做 UI 展示，只做 join / routing）。

## 5. Responsibilities（职责切分）

| 职责 | 平台 | 智能体 |
| --- | --- | --- |
| 提案生命周期 / 超时 / RBAC / 审计 | ✅ `ApprovalGate` | ✗ |
| 待批缓存 + 路由 + 认领注册 | ✅ `ApprovalInbox`（renderer 内部） | ✗ |
| 兜底抽屉 / 高风险弹窗 / 审批中心 | ✅ 平台组件 | ✗ |
| **决定「要不要审批、风险几级」** | ✅ 安全边界，不可下放 | ✗ |
| **决定「显示在哪、长什么样」** | ✗ 不关心 | ✅ 智能体自己 |
| 订阅 + 认领 + 渲染 + 决定 | 提供原语 | ✅ 智能体 surface |
| 业务复核（合同风险确认等） | ✗ 不属 gate | ✅ 智能体 workflow |

一句话：**平台拥有「审批是什么、谁能批、批了之后发生什么、以及没人认领时兜底在哪显示」；智能体只拥有「审批卡放在我界面的哪个位置」。**

## 6. Platform Contract

```ts
// 智能体唯一入口：先报身份，再拿本会话例行待批
const { waiting, approve, reject } = useSessionApprovals(sessionId);
// waiting: Proposal[] —— 只含本会话、status === 'pending' 且 risk !== 'high-risk'（例行）

type ApprovalDecisionResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; status: 'expired' | 'failed'; error: { code: string; message: string } };

approve(id: string, options?: { note?: string }): Promise<ApprovalDecisionResult>;
reject(id: string, options?: { note?: string }): Promise<ApprovalDecisionResult>;
```

- `approve` / `reject` 是唯一决策通道，直连 gate。
- **乐观移除与失败回滚由 inbox 拥有**，卡片只调用并消费结果。
- `ProposalRequest.requestId` / `Proposal.requestId` 必填（关联键）。

```tsx
// 智能体渲染内联卡（自动认领，无需理解 claim）
<InlineApprovalCard proposal={p} />
```

## 7. Isolation（单层：renderer 封装边界）

- 权威事实源在 Main `ApprovalGate`；renderer 的 `ApprovalInbox` 是唯一待批缓存 + 路由。
- `ApprovalInbox` 唯一接触 `sparkii:event:approval` 和全量列表（抽屉 / 中心 / 高风险弹窗需要全量）。
- 智能体**只能**通过 `useSessionApprovals(sessionId)` 拿数据：它是 inbox 内部 `Map<id, Proposal>` 的派生 session 过滤视图，且不含 high-risk。
- **不存在** `useAllApprovals()` 这类对智能体公开的入口。全量访问只在平台内部。

Trust model：单窗口、单渲染进程、单本地用户；智能体 surface 与平台同属第一方可信 UI。本轮隔离目标是「信息可见性 / 封装」，不是对抗恶意 surface 的安全边界；决定权仍由 gate RBAC 统一校验。若未来智能体变成不可信插件，另起「沙箱 surface + 受限 preload + 能力令牌」，不是本轮范畴。

Main 不新增 `sessionId` 过滤参数；过滤全部发生在 renderer inbox 路由。

- **收件箱 reconciliation：** 初次 `listAllApprovals()` 全量灌入 `Map<id, Proposal>`；之后每个 `approval` 事件按 `id` upsert，`status !== 'pending'`（如 `expired`）则从 `Map` 删除。超时推送因此只会「移除」而非「追加」，也不会产生重复项。

## 8. Claim 生命周期（内部，智能体无感）

- `InlineApprovalCard` 挂载时认领 `proposal.id`，卸载时释放。
- 认领注册表用 `Set<id>`（认领=add，释放=delete；同一提案当前不会被多处渲染）。
- `unclaimed` 是 render 期由 `claimedIds` 派生的集合；抽屉自动打开依据派生后的 `unclaimed`，不依赖具体 hook 时序。
- `pending` 移除该提案时，其认领记录一并剪枝。

**兜底可见性不变量：** 全局「待确认」角标与审批中心统计/展示**全部 pending（含已认领）**；认领只抑制抽屉里的重复卡，不减少平台兜底可见性。

**兜底抽屉显示集合：**

```ts
unclaimed = routine.filter(p => !claimedIds.has(p.id))
// routine = 非 high-risk 的 pending
// highRisk 永远走 HighRiskApprovalDialog，不参与认领
```

## 9. 未来规则层（预留，本轮不实现）

### 9.1 三种机制

| 机制 | 本质 | 落点 |
| --- | --- | --- |
| 批量审批 | 对多个 pending 一次决定 | 平台抽屉/中心 + `gate.decideMany` |
| 允许本次会话 | 会话级规则 | `gate` 规则层 |
| 总是允许 | 持久规则 | `gate` 规则层（需更高权限） |

### 9.2 命中规则后的不变量（关键：仍可见、可审计）

```
写操作 → gate.submit
  → 命中规则
  → 创建提案，立即置为 approved：
       decisionBy   = "rule:<ruleId>"
       decisionNote = 人类可读原因（如「自动通过：允许 bash（本会话）」）
       autoApproved = true
  → 执行器照常执行
  → 结果回 Pi → 时间线 approval_resolved（带 autoApproved + reason）
  → 聊天里工具卡显示「已自动通过 · 原因」（非交互）
  → 审计：一条完整记录，decision = auto-approved，带 ruleId + reason
```

要点：

- **省掉的是「等待用户决定」，不是「让用户看见」。** 自动通过的提案**不进 `waiting`**（`waiting` 只放 pending），所以不弹决策卡；但工具卡上有状态徽标，审计里有完整记录。
- 两种卡分开：**决策卡**（`ApprovalCard` / `InlineApprovalCard`）只在 pending 时出现；**工具卡状态徽标**每次工具调用都有，自动通过时挂「已自动通过 · 原因」。

### 9.3 三条安全红线

1. **高风险永不自动批**：规则只对 `risk: 'write'` 生效，`high-risk` 无论规则如何都强制走弹窗。
2. **持久规则要更高权限**：`session` 级 reviewer 可建；`persistent` 级需 admin。
3. **审计仍每写一条**：自动通过也落审计，decision 标记 `auto-approved`，可回溯到哪条规则、谁建的。

规则的具体数据形状（如 `ApprovalRule` 的 `id` / `scope` / `match` / `risk` 字段）**本轮不定型**，只保证 `Proposal` 的 `decisionBy` / `decisionNote` 和未来可加的 `autoApproved` 这个缝不被堵死。

## 10. Data Flow

**通用智能体（内联）**

```
Pi 写工具 → Main gate.submit → broadcast approval(pending, requestId)
  → ApprovalInbox: Map += p（pending, requestId）
  → useSessionApprovals(sessionId): waiting 含 p（本会话、routine）
  → 通用 surface 投影：用 requestId 把 waiting 的 p 对齐到对应 ToolCard
  → 渲染 InlineApprovalCard → 认领 p.id
  → ApprovalDrawer: unclaimed 不含 p → 不弹
  → 用户点允许 → approve(p.id) → 乐观移除 → gate.decide → 执行
  → approval_resolved 回 Pi → 工具卡变完成
```

**超时（Main 权威，保护长命令）**

```
Main broker 定时器到期 → gate.expire
  ├─ 仍 pending 且已到期 → 推送 approval(status='expired')
  │    → ApprovalInbox 按 id 删除 → 内联卡/抽屉消失
  │    → Pi 侧 resolve denied → 工具卡变已拒绝
  └─ 已 approved/executed（长命令执行中）→ 不推、不 resolve
        → 等 decideApproval 完成，由 broker.decide 回真实结果
```

**合同审核 / 后台会话（兜底）**

```
requestExport → gate.submit → broadcast → ApprovalInbox: Map += p
  → 无任何 surface 认领
  → ApprovalDrawer: unclaimed 含 p → 自动弹出
  → 用户在抽屉决定
```

**切换页面 / 会话**

```
通用智能体 pending 中，切去首页
  → 通用 surface 卸载 → InlineApprovalCard unmount → 认领自动释放
  → p 变 unclaimed → 抽屉弹出（「其他会话」分组）
```

## 11. File Plan（落点）

**平台（renderer，`apps/desktop/src/trust/`）**

- 新增 `ApprovalInbox.tsx` —— 收件箱 store（全量缓存 + 路由 + 认领 `Set` + `useSessionApprovals` + 决定副作用）
- 新增 `ApprovalCard.tsx` —— 从现有 `ApprovalPanel` 队列项抽出（纯展示）
- 新增 `InlineApprovalCard.tsx` —— `ApprovalCard` + 自动认领
- 重命名 `ApprovalPanel.tsx` → `ApprovalDrawer.tsx` —— 改为消费收件箱，只显示 `unclaimed`
- 重命名 `ApprovalModal.tsx` → `HighRiskApprovalDialog.tsx` —— 强制，不认领
- 修改 `ApprovalCenter.tsx` —— 消费收件箱（全量，无「自动通过」筛选）
- 修改 `App.tsx` —— 包裹收件箱，删除本地 `pending` / `decide`，改为渲染 `ApprovalDrawer` + `HighRiskApprovalDialog`；订阅收件箱「decided」信号刷新审计视图

**Main（`apps/desktop/electron/main/`）**

- `workflow.ts` broker：`gate.submit` 时把 `requestId` 落到 `Proposal`；超时回调**仅在 `gate.expire` 返回 `status === 'expired'` 时**推送该事件（`approved`/`executed` 不推，保护长命令）
- `ipc.ts`：无需新增过滤参数；`listPendingApprovals` 返回的 `Proposal` 自然带 `requestId`

**`packages/approval`**

- `ProposalRequest` / `Proposal` 增加必填 `requestId`；`createProposal` 复制它（不进 `payloadHash`）

**通用智能体**

- 修改 `apps/desktop/src/surface/standard-chat.tsx`（或 `agents/general/surface/`）—— 订阅 `useSessionApprovals`，按 `requestId` 把内联卡对齐到 `awaitingApproval` 工具卡下

**合同审核智能体**

- **不动**

**完全不动（除 `requestId` 与超时推送外）**

- `ApprovalGate` 状态机 / RBAC / 审计
- 09-06 展示契约（`present.ts` / `summary` / `preview`）
- 09-06 会话 JSONL 审批态投影（形状不变）

## 12. Test Points

- **隔离**：会话 A 的 surface 拿不到会话 B 的 pending；`useSessionApprovals(A)` 返回不含 B。
- **waiting 构成**：只含 routine pending，`high-risk` 永不进入 `waiting` / 永不认领。
- **关联**：JSONL `approval_required.requestId` 能对齐到同 `requestId` 的 `waiting` proposal（历史回放也成立）。
- **认领释放**：通用智能体认领后抽屉不弹；切会话 / 切页面后认领释放，抽屉弹出「其他会话」。
- **单决策卡**：同一提案不会同时出现在内联卡和抽屉。
- **抽屉集合**：`ApprovalDrawer` 只渲染 `unclaimed` 例行；高风险从不进抽屉。
- **高风险强制**：`high-risk` 不受认领影响，恒走 `HighRiskApprovalDialog`。
- **乐观决定**：`approve` / `reject` 乐观移除；失败时 inbox 回滚。
- **超时**：Main 推 `expired` → inbox 删除；内联卡/抽屉自动消失；不再由 renderer 主动 `decide('timeout')`。
- **合同审核回归**：导出审批仍走抽屉，业务复核不受影响。

## 13. Non-Goals（本轮不做）

- 不改 `ApprovalGate` 状态机、RBAC、审计（`requestId` 与超时推送除外）。
- 不改 09-06 展示契约与 JSONL 形状（仅超时推送一处修正）。
- 不实现批量审批、会话级 / 持久自动审批（仅预留 §9 不变量）。
- 不改合同审核智能体。
- 不改高风险二次确认语义。
- 不引入硬沙箱 / 符号链接逃逸防护。

## 14. Out of Scope Follow-ups

- 实现规则层：`decideMany`、会话级 / 持久规则、自动通过的 `autoApproved` + 原因字段与工具卡徽标。
- 会话 / 本轮授权，降低审批次数。
- 例行超时改为暂停。
- 导出改为系统「保存」对话框。
- 审批中心的「自动通过」汇总视图（如需要，与审计合并考虑）。
- 若智能体变成不可信插件：沙箱 surface + 受限 preload + 能力令牌。
