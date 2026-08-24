# Sparkii Desktop

> 本地部署、可审计的 AI 桌面工作台 —— 首个落地场景：合同审核智能体
>
> [English](./README.en.md) · 简体中文

**状态：** pilot（v0.1.0，私有仓库） · **平台：** Windows 优先（NSIS / MSIX）

## 简介

Sparkii Desktop 是一个以「可控、可审计、可私有化部署」为设计原则的 AI 桌面工作台。Agent 内核（Pi）随应用内嵌为无窗口子进程，用户机器无需单独安装任何运行时；所有写操作遵循「提议—执行分离」，由人工审批门控、全程审计留痕——**被拒绝的写操作绝不会发生**。

当前仓库处于 pilot 阶段，内置「合同审核」（`contract-review`）profile，演示完整闭环：

上传合同 → 文档解析 → 法规检索 → 条款抽取 → 风险比对 → 生成报告 → 人工复核 → 审批导出 → 审计留痕

## 核心特性

- **内嵌 Agent 运行时**：Pi 内核（`@earendil-works/pi-coding-agent`）随安装包内嵌，无需外部安装 pi / Node / pnpm，应用启动与运行全程不出现终端窗口。
- **多 Agent 隔离**：有上限的 Pi 进程池（默认 4，可用 `SPARKII_MAX_AGENTS` 调整），每 Agent 独立 session；子进程崩溃后自动指数退避恢复。
- **安全门控与审计**：LLM 只能提出写操作，Main 侧确定性执行器在人工批准后才执行；SQLite 审计可导出，拒绝即不写。
- **Profile 驱动的可配置性**：页面、流程、技能、主题、权限、模型路由全部声明式配置，带 Ed25519 签名完整性校验。
- **原生 Skills 加载**：遵循 Pi 的 SKILL.md 标准，目录注入 + 内置 read 工具按需读取正文与 references/assets。
- **私有化/离线交付**：数据不出本机，单安装包交付，无退出遥测；模型 provider 可插拔（当前 pilot 使用 deepseek，支持按 profile 接入本地/云端端点）。

## 合同审核流程

`contract-review` profile 使用线性 workflow 编排以下步骤：

1. **文档解析** `document.read` —— 读取并解析本地合同（PDF / Word / Excel / 文本）
2. **法规检索** `knowledge.search` —— 在本地法规知识库（BM25 索引）中检索相关条款
3. **条款抽取** `clause_extract`（skill）—— 抽取标的、金额、付款、违约责任、争议解决等关键条款
4. **风险比对** `risk_compare`（skill）—— 逐条比对合同条款与法规依据，给出风险等级与建议
5. **生成报告** `report`（llm）—— 组织为结构化审核报告
6. **人工复核** —— 审核人查看报告
7. **审批导出** `report.export` —— 写操作，必须通过审批门后由 Main 侧执行器导出 Word 报告
8. **审计留痕** —— 全过程写入可导出的审计记录

```
上传合同 → load → search → extract → compare → report → 人工复核 → export（审批） → 审计
```

## 架构总览

进程模型：Renderer 与 Main、Main 与 Pi Runtime 之间逐层隔离，安全与合规能力集中在 Main 控制层。

```text
┌───────────────────────────────────────────────┐
│ Renderer（React，沙箱化）                       │
│ 页面组合 · 对话工作台 · 审批弹窗 · 审计视图      │
└───────────────▲───────────────────────────────┘
                │ Electron IPC（typed，contextBridge）
┌───────────────┴───────────────────────────────┐
│ Electron Main（控制层）                        │
│ 配置加载 · 会话 · 模型路由 · 审批门 · 审计 ·    │
│ RBAC · PiRuntimePool（有上限的进程池）          │
└───────────────▲───────────────────────────────┘
                │ 结构化消息（utilityProcess / fork）
┌───────────────┴───────────────────────────────┐
│ Pi Runtime 子进程（Node，无窗口，随应用内嵌）   │
│ AgentSession · Skills · 读工具 · 写操作提议     │
└───────────────────────────────────────────────┘
```

Monorepo 结构（pnpm workspace）：

| 目录 / 包 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 应用：主进程装配、类型化 IPC、React Renderer |
| `packages/config` | Profile schema（zod）、加载、校验、签名完整性 |
| `packages/model-router` | 按任务选择模型并降级（chat / extract / report / default） |
| `packages/connectors` | 连接器纯逻辑：文档解析、知识检索、报告导出 |
| `packages/identity` | 本地账号 + RBAC（预留 `IdentityProvider` 接口） |
| `packages/approval` | 审批门 + 审计（SQLite WAL）+ 确定性执行器 |
| `packages/agent-host` | Pi 内嵌运行时：进程池、transport、workflow runner |
| `packages/theme` | 设计 token / 皮肤系统 |
| `profiles/contract-review` | pilot profile：manifest / agent / ui / security |

## 安全与合规设计

- **提议—执行分离**：Pi Runtime 内没有可执行的写原语；写/高风险工具只产生 proposal，参数在提议时冻结（payloadHash），Main 侧 `ConnectorExecutor` 仅在权威审批状态为「批准」时执行；拒绝 = 不执行。
- **审批门**：审批策略来自 profile（`requireApproval` / `timeoutMs` / `highRiskDoubleConfirm`），RBAC 决定谁能批准。
- **审计**：SQLite（WAL）追加写，每次写尝试恰好一条记录，可导出 JSONL；记录 actor / sessionId / profileId / 决策 / 执行结果，审批可回溯到具体 Agent。
- **Profile 完整性**：Ed25519 签名校验，fail closed；未签名 profile 仅开发模式放行。
- **密钥保护**：Electron `safeStorage`（Windows DPAPI）加密落盘，绝不明文、绝不暴露给 Renderer。
- **渲染层沙箱**：`contextIsolation` + `sandbox`，无 Node 能力、无凭证访问。
- **数据本地化**：数据目录按用户隔离；无退出遥测（除非显式开启）。

## 快速开始

环境要求：Node.js ≥ 22，pnpm ≥ 9。

```bash
pnpm install
pnpm test          # 全部单元/契约测试
pnpm lint          # ESLint
pnpm typecheck     # 全仓类型检查
pnpm build         # 各包构建
```

应用入口在 `apps/desktop/electron/main/index.ts`；开发模式下通过 `VITE_DEV_SERVER_URL` 接入 Vite dev server。首次运行会种子本地演示账号 `admin / admin123`（仅开发/演示用途）。

端到端验收（真实模型调用，120s+ 审批等待）：

```bash
pnpm --filter @sparkii/desktop build:main
pnpm --filter @sparkii/desktop exec playwright test
```

无模型可用时跳过真实 LLM 用例：`SPARKII_SKIP_LLM=1 pnpm --filter @sparkii/desktop exec playwright test`。

## 开发指南

关键环境变量：

| 变量 | 说明 |
| --- | --- |
| `SPARKII_MAX_AGENTS` | Agent 进程池上限（默认 4） |
| `SPARKII_PROFILE_DIR` | 覆盖 profile 目录 |
| `SPARKII_DATA_DIR` | 覆盖数据目录（审计、账号、日志） |
| `SPARKII_PI_USE_FORK` | `1` 时改用 `child_process.fork`（回退路径） |
| `SPARKII_SKIP_LLM` | `1` 时跳过真实模型 E2E |

测试原则：行为契约优先于快照；安全不变量测试优先级最高；无 API key 时 LLM 依赖测试跳过。

## Profile 配置

一个 profile 是版本化的声明式目录，驱动应用的行为与外观：

```text
profiles/contract-review/
  manifest.yaml          # 元信息 + 模型路由（任务 → 候选模型链）
  agent/
    tools.yaml           # 可用工具
    workflow.yaml        # 线性流程编排
    skills/              # 标准 SKILL.md 技能包（渐进式加载）
    knowledge/corpus.json# 法规知识库语料
  ui/
    pages/home.json      # JSON 驱动的页面 schema
    theme/tokens.json    # 设计 token
  security/
    roles.yaml           # 角色 → 页面 / 工具 / 可批事项
    approval.yaml        # 审批策略
```

页面由组件注册表 + JSON schema 驱动，配置包不得在渲染层执行任意代码；skills 遵循 Pi 的 SKILL.md 标准，由 `read` 工具按需读取正文与 references/assets。

## 打包与交付

```bash
pnpm --filter @sparkii/desktop dist
```

产物位于 `apps/desktop/out/`：NSIS 安装包（`.exe`）与 MSIX（`.appx`）。Pi Runtime 与 profile 资源随包分发，安装后不依赖 PATH 中的 pi / pnpm / Node。

## 路线图与当前边界

当前为 pilot，以下方向已预留接口或列为后续工作：

- 多 profile 并行、按 Agent 绑定不同 profile
- Pi Runtime 硬隔离（Windows restricted token / 容器 / 微 VM，接口已预留）
- 审计加固：集中采集、哈希链 / 签名追加（等保 / ISO 方向）
- 身份：SSO / LDAP / AD（`IdentityProvider` 接口已预留）
- 连接器扩展：ERP / MES / DCS、外部数据源、本地工具（接口已预留）
- 离线模型权重交付（Ollama / vLLM 运行时打包）
- macOS DMG / Linux AppImage 打包打磨
