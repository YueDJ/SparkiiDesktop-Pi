# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

> Sparkii Desktop 是 Electron 桌面应用(Windows 优先,NSIS/MSIX 交付);渲染层为 React/web 技术,设计语言按 web 对待。

## Users

- 主要用户:业务人员(合同审核员/法务/风控、采购、舆情监控等垂直岗位),在工位用桌面应用完成"让智能体跑任务、人工把关"的工作。非技术背景,希望界面安静、说人话。
- 次要用户:技术管理员,负责配置模型端点、安装智能体(profile)、查看/导出审计。
- 使用场景:任务导向、有合规压力;"打开就知道有没有要处理的、上次审到哪了"是第一诉求。

## Product Purpose

Sparkii Desktop 是一个本地部署、可审计的 AI 桌面工作台(多智能体工作台)。当前首个落地场景是合同审核:上传合同 → 解析 → 法规检索 → 条款抽取 → 风险比对 → 生成报告 → 人工复核 → 审批导出 → 审计留痕。未来承载多种垂直智能体(任务流式 / 对话式 / 仪表板式)。

## Positioning

- **可控**:所有写操作遵循"提议—执行分离",人工批准后才执行;被拒绝的写操作绝不会发生。
- **可审计**:全过程留痕(SQLite WAL)、可导出,审批可回溯到具体智能体会话。
- **本机运行**:数据不出本机、离线交付、无退出遥测;模型 provider 可插拔(本地/云端)。

## Operating Context

- 桌面应用:Electron 壳 + React 渲染层,Pi 内核以无窗口子进程内嵌;安装包内自带运行时,不依赖 PATH。
- 配置驱动:profile(能力包)定义页面、流程、技能、主题、权限、模型路由;Ed25519 签名校验,fail closed。
- 多 Agent 并行:Pi 进程池上限默认 4,超出排队;每 Agent 独立 session(sessionId 贯穿审批/审计)。
- 术语(面向业务人员时说人话):智能体 = 一个 profile/能力单元;会话 = session;审批门 = 写操作必须人工批准;审计 = 操作留痕。"进程池/槽位"只在技术语境使用,"运行中的智能体/排队"是面向用户的说法。
- 数据目录按用户隔离;密钥经 OS 级加密(Windows DPAPI)。

## Capabilities and Constraints

已实现(pilot v0.1.0,合同审核):

- 文档解析(PDF/Word/Excel/文本)、本地法规知识库 BM25 检索、条款抽取、风险比对、报告生成。
- 人工审批门(提议参数冻结、payloadHash、超时自动拒绝、高风险二次确认策略);SQLite 审计(WAL)与 JSONL 导出。
- 本地账号 + RBAC(角色 → 页面/工具/可批事项);Renderer 沙箱(contextIsolation + sandbox)。
- Profile 驱动页面组合(组件注册表 + JSON schema)+ 对话工作台 + 主题 token。

未来(接口已预留/规划,不提前实现):多 profile 并行、SSO/LDAP/AD、集中审计与哈希链、ERP/MES/DCS 等连接器、硬沙箱(容器/微 VM)、离线模型权重(Ollama/vLLM)、macOS/Linux 打包。

约束:业务人员为主要受众;Windows 优先;安全合规是硬约束(被拒绝的写绝不发生、任何写尝试必留审计);无遥测(除非显式开启)。

## Brand Commitments

- 名称:Sparkii Desktop(Sparkii)。
- 中文定位语:可控、可审计、可私有化部署。
- 视觉基调(用户已确认,2026-08-25):现代亲和(浅色 + 蓝 + 大圆角),见 DESIGN.md;不得削弱"可信感"的状态语义(风险红 / 等待橙 / 完成绿清晰可辨)。
- 沟通基调:对业务人员说人话,技术细节默认收起,异常才主动提示。

## Evidence on Hand

- README.md / README.en.md:产品简介、架构、路线图。
- docs/2026-08-22-design.md:桌面端智能体平台设计文档。
- docs/superpowers/specs/2026-08-24-multi-agent-runtime-native-skills-design.md:多 Agent 运行时规格。
- profiles/contract-review/:pilot 配置包(manifest / ui / security / agent)。
- apps/desktop/src/:现有 UI 骨架(登录 / PageComposer / ChatWorkbench / ApprovalDialog / AuditView)。
- .superpowers/brainstorm/16444-1787632584/content/:本次设计讨论的可视化线框(壳层 / 三表面 / 审批 / 审计 / 首页 / 登录 / 状态栏 / 视觉风格,共 10 屏)。
- 尚无真实客户证言、定价、对外宣传材料——未来不得虚构。

## Product Principles

1. 权威状态是唯一事实源:UI 展示来自 Main 事件/审计的状态,LLM 叙述只是旁注。
2. 无事不打扰,有事必清楚:技术细节默认收起,审批/复核/错误/排队轮到时才主动打扰。
3. 写操作必须人工把关:批准决定由确定性执行器强制,拒绝即不写。
4. 信任是交互而非口号:每个产出可回溯到审计;本机/审计状态常驻可见。
5. 配置驱动、多智能体可扩展:壳层同构,智能体表面在有限范式内变化(任务流 / 对话 / 仪表板)。

## Accessibility & Inclusion

- 未建立产品专属无障碍标准;以基础可访问性为准:键盘可达、焦点管理(审批弹窗焦点陷阱)、语义化标记、足够对比度。
- 审批倒计时可见、高风险二次确认不可跳过——这些是合规体验的一部分。
