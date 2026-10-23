# PR

## Title

refactor(desktop): streamline chat permissions and model compatibility

## Description

### 概要

简化通用智能体与企业知识问答的权限交互，修复 DeepSeek V4.1 Flash 的能力误判，并统一 Composer 工具栏的按钮顺序与视觉对齐。

### 变更

- 将 `Ask` / `Auto review` 双按钮改为 Composer 中的单选权限菜单，显示“每次询问”或“自动审查”的当前选择。
- 为两种权限模式增加不同图标：
  - 每次询问：人物图标。
  - 自动审查：盾牌图标。
- 删除聊天区常驻的任务能力胶囊、宿主/网络限制说明和手动“撤销本任务权限”入口。
- 删除手动撤销对应的 preload/IPC 接口，同时保留 Main 侧任务授权的自动撤销生命周期。
- 修复 `deepseek-flash`（DeepSeek V4.1 Flash）的工具调用能力误判。
- 将模型能力兜底改为正交组合，视觉能力不再覆盖工具调用能力。
- Composer 工具栏统一为：
  - 通用智能体：上传、工作区、权限。
  - 企业知识问答：上传、知识库、权限。
- 上传按钮改用共享图标按钮布局，修复 hover 圆形背景中加号未居中的问题。

### 安全说明

本次没有修改审批判定、任务授权、审计或自动撤销规则。移除的是重复展示和冗余的手动撤销入口；任务结束、停止、切换权限模式、更换工作区、删除或释放会话时仍会自动撤销授权。

### 验证

- 相关功能测试：188 项通过。
- 后续 Composer/知识问答修复测试：181 项通过。
- renderer 与 Electron 两套 TypeScript 检查通过。
- renderer 生产构建通过。
- 使用实际 Electron 构建验证：
  - 加号图标中心偏差 X/Y 均为 `0px`。
  - 通用智能体顺序为“上传、工作区、权限”。
  - 企业知识问答顺序为“上传、知识库、权限”。
- 全量测试：1545 项通过、3 项跳过；唯一失败为本机 Windows sandbox ACL 环境测试（`cannot grant runtime ACL`），与本次改动无关。
