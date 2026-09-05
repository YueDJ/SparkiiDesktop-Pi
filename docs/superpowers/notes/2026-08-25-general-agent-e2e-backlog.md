# 通用智能体 E2E 遗留项（spec §12）

> 记录日期：2026-08-25  
> 更新：2026-09-05 — 全量桌面 E2E 清单已收进新规格，本笔记不再单独演进。
>
> **现行文档（待产品评估，尚未落地）：**
> - 规格：`docs/superpowers/specs/2026-09-05-desktop-e2e-coverage-design.md`
> - 计划：`docs/superpowers/plans/2026-09-05-desktop-e2e-coverage.md`
>
> 下面 §12 六条对应新规格 P1 的 G1–G6。G4（指定工作区）无选目录短路则不做；G5 不强锁。

## 已自动化的覆盖

- `apps/desktop/e2e/general.spec.ts`：进入通用智能体 → `composer-input` 可见、`workspace-path` 含 `Sparkii`（模型无关冒烟）。
- `apps/desktop/e2e/pilot.spec.ts`：合同审核批准终态（文件级 `SPARKII_SKIP_LLM`；新计划要改成按 test skip，并补 live / 拒绝）。
- `apps/desktop/e2e/provider-settings.spec.ts`：设置页切供应商。

## 遗留场景（未自动化）

对应新规格 P1：

1. G1 纯问答会话 → 桌面上**不出现**任何 `Sparkii*` 文件夹。
2. G2 请求「创建 hello.txt」→ 出现审批卡 → 批准 → 工作区出现文件，审计 `proposal.executed`。
3. G3 同上但拒绝 → 无文件，审计 `proposal.denied`。
4. G4 Composer 指定工作区 → 写入发生在指定目录（无 `SPARKII_E2E_*` 选目录短路则本轮不做）。
5. G5 模型选择器选择模型 → 该轮打到所选模型（无窗口观察点则不强制）。
6. G6 拒绝后执行器不执行（与 G3 合并）。

合同 live 管道（L1–L3、D1）见新规格 P0，不在本笔记展开。
