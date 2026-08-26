# 通用智能体 E2E 遗留项（spec §12）

> 记录日期：2026-08-25
> 分支：`codex/general-agent`
> 来源：设计规格 §12「E2E（Playwright + Electron）」6 个完整场景，本阶段（UI Task 10–12）仅做冒烟，以下均未自动化，需人工回归或后续补测。

## 已自动化的覆盖

- `apps/desktop/e2e/general.spec.ts`：登录 → 进入通用智能体 → 新建会话 → `composer-input` 可见、`workspace-path` 含 `Sparkii`（模型无关冒烟，真实运行）。
- `apps/desktop/e2e/pilot.spec.ts`：合同审核回归，真实模型端点下通过（含 agent 有机调用 `report_export` 触发审批 → 批准 → 导出 → 审计留痕）。

## 遗留场景（未自动化）

1. 纯问答会话 → 桌面上**不出现**任何 `Sparkii*` 文件夹。
2. 请求「创建 hello.txt」→ 出现审批卡（diff）→ 批准 → 桌面出现 `SparkiiXXXX<ts>` 文件夹与文件，审计含 `workspace.created` + `proposal.executed`。
3. 同上但拒绝 → 无文件、无文件夹，审计 `proposal.denied`。
4. Composer 指定工作区 → 写入发生在指定目录（桌面不生成默认文件夹）。
5. 模型选择器选择模型 → 该轮 `set_model` 使用所选模型（mock 断言）。
6. 安全不变量：拒绝后执行器不执行（复用现有审批契约测试模式）。

## 依赖与注意事项

- 场景 2–6 需要真实模型端点（或可注入的假 provider）；当前使用本机 `~/.pi/agent` 的 DeepSeek 凭据。
- 场景 1 与 5 模型无关，可优先补为自动化测试。
- 场景 6 与阶段 1/2 已锁定的安全单测语义一致，e2e 只需验证端到端不执行。
