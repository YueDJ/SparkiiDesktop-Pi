# 平台统一权限模式与 Shell 自动审查设计

日期：2026-10-21

状态：待评审

## 1. 背景

现有审批设计尝试在 Windows 上使用 AppContainer 承载 Git Bash，并在沙箱内自动运行工作区命令。实际验证发现：

- AppContainer 进程可以启动；
- Git Bash/MSYS2 在初始化 Cygwin 全局命名对象时被 AppContainer 拒绝；
- 平台预创建 MSYS2 所需命名对象后仍无法打开该对象；
- native PowerShell 可以启动，但会产生新的工作目录、父链 ACL 和工具链可见性问题；
- 让所有用户安装 Docker Desktop 或 WSL2 不符合当前桌面产品的轻量交付目标。

因此，平台不再要求 `process.exec` 必须位于 OS 沙箱中。Windows Shell 恢复为宿主 Git Bash，由平台审批、Reviewer 和审计控制风险。Workspace 内的结构化文件操作继续由 Main 做确定性路径校验。

本文是
`docs/superpowers/specs/2026-10-21-agent-approval-boundary-design.md`
的补充设计。Task Grant、Action 规范化、Workspace Admission、Capability Gateway、
审计和业务 Workflow 复核继续有效；本文明确取代该文档中“所有 Shell 必须由平台
OS 沙箱承载”以及用户可选“全部允许”模式的表述。

## 2. 目标

1. Workspace 内普通文件名操作在两种权限模式下都自动执行。
2. 提供两个平台级、用户可选的权限模式：
   - `ask`
   - `auto_review`
3. 两种模式适用于所有 Agent、Workflow 和未来新增 Profile。
4. Agent/Profile 只能声明默认模式或更严格限制，不能实现第二套放行逻辑。
5. Shell 直接使用宿主 Git Bash，不引入 Docker、WSL、AppContainer 或 PowerShell
   作为前置依赖。
6. 用户不需要为每条低风险命令确认。
7. 所有自动审查、人工审批、拒绝和执行均写审计。

## 3. 非目标

1. 不提供 `full`、`yolo` 或“全部允许”权限模式。
2. 不声称宿主 Shell 是 OS 沙箱。
3. 不通过命令字符串白名单冒充安全边界。
4. 不让主 Agent 审查或批准自己的 Shell 命令。
5. 不让 Reviewer 覆盖硬拒绝、信任锚、凭据保护或灾难目标保护。
6. 不改变合同审核、采购审核和 Workflow 的业务人工复核语义。
7. 不在本设计中实现 Docker、WSL、远程 VM 或其他可选隔离后端。

## 4. 核心模型

### 4.1 权限模式不是技术沙箱

权限模式只决定：

> 一个原本需要审批的动作，由用户确认，还是由平台独立 Reviewer 判断。

权限模式不决定：

- 路径是否可访问；
- 是否允许网络；
- 是否具备 OS 隔离；
- 是否拥有凭据；
- 是否可覆盖灾难目标。

这些技术边界仍由 Platform Adapter 和 Main 确定性执行。

### 4.2 两类权限模式

```ts
type PlatformPermissionMode = 'ask' | 'auto_review';
```

`ask`：

- 需要用户确认的动作进入现有审批流；
- 用户可以仅允许一次，或按平台允许的范围允许本任务；
- 后续动作仍重新检查 Task、目标和载荷。

`auto_review`：

- 需要审批的动作先交给独立 Reviewer；
- Reviewer 可以返回 `allow`、`ask` 或 `deny`；
- Reviewer 不能直接扩大平台能力，也不能跳过 Main 的最终校验。

不存在用户可选的 `full` 模式。

### 4.3 Plan、Task 状态与权限模式独立

- Plan 模式控制“是否允许产生变更”；
- Task 生命周期控制授权是否有效；
- 权限模式控制“需要审批时由谁审查”；
- Platform Adapter 控制实际 OS 能力和限制。

这些概念不得合并为一个布尔值。

## 5. 平台职责

### 5.1 Main 是唯一权威

Main 负责：

- 根据可信工具定义重算 Capability、目标、风险、副作用和摘要；
- 执行不可覆盖的硬拒绝规则；
- 计算动作是 `ALLOW`、`ASK` 还是 `DENY`；
- 在 `ask` 和 `auto_review` 之间路由；
- 调用 Reviewer 并验证其返回结构；
- 在执行前重新校验 Task、目标身份、父链和载荷哈希；
- 执行、审计和撤销。

Runtime、Agent、Profile、Reviewer 和工具调用方都不能自行决定最终放行。

### 5.2 Agent/Profile 的限制

Agent/Profile 可以：

- 选择平台允许的默认权限模式；
- 将某些能力限制为必须 `ask`；
- 禁止某些工具或能力；
- 提供业务允许的动作集合。

Agent/Profile 不可以：

- 启用平台未提供的 `full` 模式；
- 把自己的工具标成无条件 `ALLOW`；
- 覆盖灾难目标、信任锚或凭据规则；
- 指定一个更宽松的 Reviewer 策略；
- 直接读取或伪造 Reviewer 结论。

## 6. 统一决策流程

```text
Action
  → 校验 Task 仍有效
  → Main 规范化目标、身份、载荷和副作用
  → 平台不可覆盖的 DENY 检查
  → Workspace 内普通文件操作：ALLOW
  → 基础策略仍需要审批
      → ask：用户审批
      → auto_review：独立 Reviewer
  → 合并最终决定
  → 再次校验 Task、目标身份和载荷
  → 执行
  → 审计
```

### 6.1 直接 ALLOW

以下动作在两种模式下都不需要人工确认：

- Workspace 内普通文件新增、修改、删除；
- Workspace 内普通文件移动和重命名；
- 私有 Task scratch 操作；
- 已绑定 Input Resource 的只读访问；
- 平台证明安全的本地结构化操作。

前提：

- Main 已完成 Workspace Admission；
- 目标身份和父链稳定；
- 未命中信任锚、灾难目标或硬拒绝规则。

### 6.2 基础需要审批

以下动作根据权限模式进入 `ask` 或 `auto_review`：

- 宿主 Shell 命令；
- Workspace 外读取；
- 网络读取；
- 未预授权的 Connector 调用；
- 尚未绑定到当前 Task 的外部能力；
- 已知高风险但未被硬拒绝的动作。

### 6.3 始终人工审批

以下由类型化 Capability、Connector 或 Main 可识别的本地动作发起的操作，
在 `auto_review` 中也必须由用户确认：

- 外部系统写入；
- 发送消息、邮件或审批；
- 创建工单、部署、发布；
- Git Push 或其他远端写操作；
- 修改权限、审计、沙箱控制或平台配置；
- 机器可证明的不可逆高风险动作。

`auto_review` 不是外部写授权器。

该保证以 Main 能识别动作类型为前提。宿主 Shell 中由脚本动态发起的任意外部写
无法仅靠命令文本完全证明，仍属于第 8.6 节声明的残余风险。

### 6.4 始终 DENY

以下动作不能由任何模式、Task Grant、Profile 或 Reviewer 覆盖：

- 文件系统根、用户主目录和整个 Workspace Root 的整体覆盖或删除；
- Windows、Program Files、Sparkii 数据、审计、权限、运行态和凭据目录；
- 信任锚和凭据读取或修改；
- 已知灾难命令；
- 无法建立必要身份校验或平台安全前置条件的动作。

## 7. Ask 模式

### 7.1 用户体验

`ask` 是默认模式。

Workspace 内结构化文件编辑不弹窗。

当 Shell 第一次需要审批时，审批卡展示：

- 命令；
- 工作目录；
- 当前 Task 和 Workspace；
- “宿主执行”标记；
- 允许一次；
- 本任务允许 Shell；
- 拒绝。

用户选择“本任务允许 Shell”后，创建 Task Shell Grant。普通后续 Shell 命令
直接执行，不再逐条询问。

### 7.2 Task Shell Grant

Task Shell Grant：

- 只绑定当前 Task、Workspace、Profile 和权限模式；
- 任务结束、Workspace 改变、用户撤销、应用重启或身份变化后失效；
- 不允许子 Agent 获得比父 Task 更大的范围；
- 不允许跨 Task 复用；
- 不覆盖灾难目标和信任锚；
- 命中仍然禁止或必须再次确认的高风险规则时，原授权不生效。

### 7.3 高风险命令

Task Shell Grant 不能把所有命令变成无审查执行。

已知高风险动作仍需要：

- 再次确认；或
- 直接拒绝。

硬拒绝优先于再次确认。

## 8. AutoReview 模式

### 8.1 审查器身份

Reviewer 是一个独立的模型调用，不是主 Agent 的同一轮推理，也不是主 Agent
用自然语言自评。

Reviewer：

- 使用平台固定配置和版本化策略；
- 不拥有 Shell 或写工具；
- 不获得 API Key、凭据或隐藏思维链；
- 只获得完成当前判断所需的压缩上下文；
- 返回固定 JSON，不允许自由文本作为执行许可。

### 8.2 输入

Reviewer 输入包含：

- 用户当前任务；
- 当前 Profile 和权限模式；
- Workspace 根目录；
- 当前 Action；
- 规范化后的工具名、Capability、命令、cwd 和目标摘要；
- 近期相关 Tool 调用和结果；
- 平台已知限制和硬拒绝规则版本。

默认不发送：

- 完整会话历史；
- 未相关文件内容；
- 凭据或环境密钥；
- 模型隐藏思维链。

### 8.3 输出

```ts
type ReviewerDecision =
  | {
      decision: 'allow';
      risk: 'low' | 'medium';
      reason: string;
    }
  | {
      decision: 'ask';
      risk: 'high';
      reason: string;
    }
  | {
      decision: 'deny';
      risk: 'critical';
      reason: string;
    };
```

Main 必须验证：

- JSON 符合固定 Schema；
- Action 哈希与审查请求一致；
- Reviewer 未返回额外能力；
- 动作仍属于 Reviewer 可处理的审批类别；
- 外部写和硬拒绝仍未因 Reviewer 输出被绕过。

### 8.4 判定语义

- `allow`：原动作进入最终执行前复核；
- `ask`：进入用户审批；
- `deny`：不执行，把理由返回主 Agent；
- Reviewer 拒绝后，主 Agent 不得通过换命令、脚本或间接调用绕过；
- 连续拒绝触发 circuit breaker，停止当前任务；
- Reviewer 超时、异常或无效输出不能自动放行。

### 8.5 不可处理的动作

以下动作不交给 Reviewer 决定是否放行：

- 硬拒绝动作；
- 外部系统写；
- 权限或平台配置修改；
- Reviewer 服务自身不可用时的无人值守动作。

### 8.6 残余风险

宿主 Shell 可以执行任意用户权限允许的程序。平台无法从任意命令文本确定其全部
动态行为，因此：

- Reviewer 结论是概率性控制，不是 OS 安全边界；
- 已知高风险规则继续由 Main 确定性执行；
- typed Connector 外部写继续强制人工审批；
- Shell 内自行实现的网络上传或外部写只能依赖 Reviewer、审计和事后发现；
- UI 必须明确显示“宿主执行，非沙箱”。

## 9. Shell 执行

Windows 默认执行后端：

```text
Main → Git Bash（宿主令牌）→ Job Object → stdout/stderr → 审计
```

要求：

- cwd 初始为 Workspace；
- 环境变量按白名单构造；
- 不继承 API Key、知识库 Token 或用户 Shell 配置；
- 设置超时；
- 创建 suspended 进程后加入 Job Object，再恢复运行；
- Task revoke 终止进程树；
- 任务结束后清理私有 scratch；
- UI 显示 Host 状态；
- 不显示“沙箱内执行”或“无网络”。

不为 Shell 引入 AppContainer、PowerShell 或 Docker 前置依赖。

## 10. 平台 API 边界

建议在 `packages/approval` 定义平台契约：

```ts
interface PermissionModeController {
  resolve(input: {
    taskId: string;
    profileId: string;
    requestedMode?: PlatformPermissionMode;
  }): PlatformPermissionMode;
}

interface ShellReviewer {
  review(input: ShellReviewInput): Promise<ReviewerDecision>;
}
```

约束：

- `ShellReviewer` 由 Main 持有和调用；
- Agent Runtime 只看到 `ActionExecutionResult`；
- Reviewer 输出不直接进入执行器；
- Profile 不能注入 Reviewer 实现；
- 审计记录 Reviewer 模型、策略版本和结果。

## 11. UI

所有 Agent 共用同一权限模式选择器：

```text
Ask
需要我确认有风险的操作

Auto review
让平台单独审查有风险的操作
```

不显示 `Full access`。

要求：

- 模式按当前 Task/Session 展示；
- 新建任务默认 `ask`；
- AutoReview 生效时显示通用状态标记；
- 工具卡显示 `Host`；
- Reviewer allow/deny/ask 出现在任务时间线；
- 用户随时可以切回 Ask；
- 切回 Ask 会撤销尚未使用的 Shell Task Grant；
- 已经执行的动作不回滚。

## 12. 审计

每次 Reviewer 调用记录：

- taskId、sessionId、actionId；
- 权限模式；
- Profile；
- Reviewer 模型和策略版本；
- payloadHash；
- 输入上下文摘要；
- 决定、风险级别和理由；
- 耗时、超时或错误；
- 是否回退到用户审批；
- 最终执行结果。

Workspace 内普通 CRUD：

- 写 `action.allowed` / `action.executed`；
- 不创建 Proposal；
- 不写 `approval_required` / `approval_resolved` JSONL。

人工审批继续使用现有 Proposal 和 JSONL 契约。

AutoReview 是平台安全审查事件，不伪装成人工审批决定。

## 13. 配置与迁移

### 13.1 新配置

平台配置至少包含：

- 默认权限模式；
- Profile 允许的权限模式；
- Reviewer 模型；
- Reviewer 超时；
- Reviewer 策略版本；
- 是否允许在 Reviewer 不可用时回退 Ask。

### 13.2 旧配置

- `requireApproval` 继续把指定能力提升为需要审批；
- `autoApprove` 不再表示绕过审批，只可作为选择 `auto_review` 的建议配置；
- `timeoutMs` 只作用于人工审批和 Reviewer 等待；
- `highRiskDoubleConfirm` 继续作用于允许人工审批的高风险动作；
- 旧配置不得产生隐藏的 `ALLOW` 路径；
- 已存在会话历史按原状态展示，不回填。

## 14. 失败与撤销

- `ask` 模式 Reviewer 不参与；
- `auto_review` 交互任务 Reviewer 不可用时回退 `ask`；
- `auto_review` 无人值守任务 Reviewer 不可用时 `DENY`；
- Reviewer 输出无效时不得执行；
- Task revoke 清理待审批、Reviewer 调用、Shell Grant 和活动进程；
- 权限模式变化后，新 Action 使用新模式；
- 变更前已启动进程按 Task 撤销策略处理，不因切换模式自动继续或回滚。

## 15. 测试要求

### 15.1 平台一致性

- 通用、合同、采购和 Workflow 使用同一模式控制器；
- Agent 包中没有第二套审批判定；
- 新 Agent 只需声明默认/更严格模式即可复用。

### 15.2 Workspace CRUD

- 两种模式下新增、修改、删除、移动和重命名均零 Proposal、零弹窗；
- 信任锚和灾难目标仍拒绝；
- 路径身份变化后拒绝或重新计算。

### 15.3 Ask

- 第一次需要审批的 Shell 命令产生一次用户审批；
- “允许本任务”后普通后续命令自动执行；
- 高风险例外仍确认或拒绝；
- Task 结束或 Workspace 变化后 Grant 失效。

### 15.4 AutoReview

- allow 后执行；
- ask 后进入用户审批；
- deny 后不执行并返回理由；
- Reviewer 不能允许硬拒绝或外部写；
- Reviewer 超时、异常和无效 JSON 失败关闭；
- 连续拒绝触发 circuit breaker；
- 主 Agent 不能伪造或消费 Reviewer 结果。

### 15.5 Shell 与回归

- 宿主 Git Bash 可启动并执行测试、构建和本地 Git；
- Workspace 外普通绝对写入在平台结构化工具中仍由 Admission 拒绝；
- Shell 的宿主权限在 UI 和审计中明确；
- 原有合同、采购、知识问答、Workflow 和业务审批回归通过；
- 旧 `autoApprove`/`requireApproval` 迁移测试覆盖。

## 16. 验收标准

1. 用户可选择 Ask 或 Auto review，且不存在 Full access。
2. Workspace 内普通文件编辑不询问用户。
3. Ask 模式下，一个任务最多为首个普通 Shell 动作询问一次，风险例外除外。
4. AutoReview 模式下，普通 Shell 动作由独立 Reviewer 决定，不重复询问用户。
5. Reviewer deny 后没有等价绕过路径。
6. 类型化外部系统写始终人工确认。
7. 所有 Agent 使用同一平台权限模式与 Reviewer 契约。
8. Git Bash 不再依赖 AppContainer、Docker 或 WSL。
9. Reviewer 不可用时不会静默放行。
10. 所有决定均可从审计中追溯到 Task、Action、载荷哈希和策略版本。

## 17. 风险

- Reviewer 可能误判，尤其在提示注入或极端动态命令下；
- Reviewer 调用增加延迟和模型成本；
- 宿主 Shell 没有 OS 文件系统、网络或 IPC 边界；
- 命令脚本可能在审查后读取或写入审批时未展示的对象；
- 模型服务不可用会降低自主执行能力；
- 用户可能误把 AutoReview 理解成安全沙箱。

缓解：

- 固定硬拒绝；
- UI 明确 Host 和 Reviewer 语义；
- 外部写始终人工；
- Reviewer 失败关闭；
- 审计和 circuit breaker；
- 后续如需强隔离，另设可选远端/容器 Execution Backend，不改变两档权限模式。

## 18. 实施切片建议

1. 平台契约与 PermissionModeController。
2. Workspace CRUD 两模式直通和迁移测试。
3. Host Git Bash 执行器与 Job Object。
4. Ask Task Shell Grant。
5. 独立 ShellReviewer 与固定 JSON Schema。
6. UI 模式选择器、状态和审计时间线。
7. 通用/合同/采购/Workflow 全量回归。

实施阶段应使用 TDD，并按切片形成可独立回滚的提交。
