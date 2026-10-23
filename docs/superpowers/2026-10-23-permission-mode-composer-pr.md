# PR

## Title

refactor(desktop): simplify chat permission controls

## Description

### 概要

简化通用智能体的权限交互：移除聊天区顶部的常驻权限栏和输入框上方的任务能力胶囊，将审批方式合并为 Composer 中的一个选择按钮。

### 变更

- 将 `Ask` / `Auto review` 双按钮改为“每次询问” / “自动审查”单选菜单。
- 权限按钮显示当前选择，点击后在 Composer 上方展开选项。
- 删除聊天区常驻的任务能力、宿主执行、网络和限制说明。
- 删除用户手动“撤销本任务权限”入口及对应 preload/IPC 接口。
- 保留 Main 侧任务授权的自动撤销生命周期，任务结束、停止、切换权限模式、更换工作区、删除或释放会话时仍会自动撤销。
- 更新权限交互、Preload API 和 IPC 退休测试。

### 用户可见结果

- 聊天消息区和输入框之间不再出现权限胶囊或安全限制长文本。
- Composer 工具栏只保留一个权限选择器，与工作区和模型选择保持一致。
- 当前审批方式仍然清晰可见，并且可以随时切换。

### 安全说明

本次只移除重复的展示和冗余的用户入口，不改变审批判定、任务授权、审计或自动撤销逻辑。

### 验证

- 权限交互与集成测试：162 项通过。
- 桌面端 renderer 与 Electron 两套 TypeScript 检查通过。
- renderer 生产构建通过。
- 全量测试：1541 项通过、3 项跳过；`windows-sandbox-spike.test.ts` 在当前环境因 `cannot grant runtime ACL` 失败，与本次 UI 改造无关。
