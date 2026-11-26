# R8-REVIEW-RUNTIME-LOGGER 独立只读架构审查报告

- 审查日期：2026-11-25
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 审查域：R8-REVIEW-RUNTIME-LOGGER
- 审查方式：独立读取源码、完整调用链和回归；未依赖交付方摘要；未修改文件，未运行测试或构建。
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`5a8e91cbbeb23670de30edcfdfb22c36b8dc314112c80d3bb51916553c5cd313`
- 逐项核对：66/66 OK

## 结论

CHANGES_REQUIRED

Blocking finding count: 5

## B1：Task admission 缺少取消代次

位置：`security/task-lifecycle.ts:29-38`、`security/task-grant-factory.ts:84-144`、`ipc.ts:581-660`、`packages/approval/src/security/task-grant-registry.ts:38-48`。

factory 等待期间 end/revoke/stop 找不到未来 grant，beforeCommit 只检查 binding；同一 lease 未替换时旧 admission 可重新提交。同 lease 并发 admission 也可反序覆盖所有权。最小修复：session admission sequence/token，开始即领取，end/revoke/stop/workspace-change 同步失效；beforeCommit 校验 binding+ticket 最新未取消；只允许最新或串行；提交后复核。增加 factory 等待取消和并发反序回归。

## B2：审批提交 await 窗口隐私失效仍发送旧 proposal

位置：`packages/approval/src/gate.ts:41-52,159-179`、`workflow.ts:46-96`、`service.ts:1002-1014`。

submit 在 audit.append await 前置入 map，await 后返回局部 p；期间 redactTexts 替换 map proposal 并触发 listener，但 resolver 未注册，broker 随后仍发送旧明文 p。最小修复：submit 返回 map canonical proposal；broker 发送前复核存在、pending、未 privacyRedacted、payload hash；失效 resolve denied 且不发旧对象；必要时排队补偿失效事件。增加 audit await 中失效回归。

## B3：Logger 动态对象键可保留秘密

位置：`logger.ts:27-36,49-54,118-127,175-197`。

redactValue 保留所有 key，containsRegisteredValue/outputPreservesSecret 只检查 Object.values；`ctx: {[secret]: 1}` 可穿透 append/rewrite/export。最小修复：非 schema key 做登记秘密检测，保留可信 schema；动态 key 命中时安全替换记录/对象；append、rewrite、export 共用 key-aware 验证。增加动态 key 回归。

## B4：多个 IPC 控制/thinking/journal 路径未固定原 lease

位置：`ipc.ts:1885-1897` abortChat、`:2020-2038` setChatThinkingLevel、`:2052-2067` setChatWorkspace、`:2094-2102` relocation configureSession、`:2120-2130` updateWorkflowState。

这些 handler 未捕获/校验原始 `{client, lease, openEntry}`。旧 abort 可取消替代 Task，旧 thinking 可覆盖持久设置，旧 journal/workspace 可写替代 binding。最小修复：首个 await 前捕获 tuple，所有 await 后及持久化/命令前统一 assertOriginalBinding；abort/end 结合 admission token。增加 stale thinking/abort/journal/configure 回归。

## B5：export journal 失败被吞掉仍返回成功

位置：`ipc.ts:2133-2160`；对照 `workflow.ts:586-590`。

requestExportReport 对 append_workflow_entry 使用空 catch，且不检查 success:false，仍返回 approved:true。最小修复：等待并检查响应，await 前后检查原 binding；失败抛错并撤销本次 grant；增加 reject/success:false 回归。

## 已确认符合要求

- Pool lease/stale release/generation 校验完整。
- Workflow 主路径固定原 client/lease，覆盖 model/thinking/event/prompt；step 间 rebind 停止。
- Workflow journal 检查 binding 和 success，不吞失败。
- TaskLifecycle registry.start 后同步注册 cancellation hooks。
- Approval 执行复核 canonical proposal、payload hash、privacy、TaskGrant、capability lease。
- Supervisor 回调覆盖式，不累积旧回调。
- Logger 同步 append/rewrite；CR/LF/CRLF 记录边界；字符串值共享脱敏验证。
- 回归包含 deferred-await、same-client rebind、stale release、journal、物理换行和 malformed escape 断言。

## 非阻塞建议

1. pool bind 在 configure/switch await 后未复检 control.cancelled；当前外层 ownsBinding 可阻止接受，建议补复检。
2. proposal/action envelope 未携带 generation；当前未发现确定 stale proposal 路径，建议统一。

## 验证范围与限制

仅静态代码、调用链、冻结哈希和测试断言审查。未运行 Vitest、类型检查、构建、Electron 或真实 Pi 子进程。竞态结论来自明确 await 窗口和现有 deferred 模式，未声称运行时复现。哈希通过只证明冻结一致，不证明实现正确。B3 当前生产主要固定键，但 Logger ctx API 允许任意键且未来写入属于验收范围，故列阻断。
