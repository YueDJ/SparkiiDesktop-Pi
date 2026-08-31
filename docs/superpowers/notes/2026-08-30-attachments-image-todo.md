# 附件图片 / 视觉链路 —— 决策记录

> 日期：2026-08-30（初稿） / 2026-08-31（定稿）
> 分支：`codex/chat-attachments-workspace`
> 状态：已决策；端到端验证仍待完成

## 0. 已决策（2026-08-31）

- **缩放**：走应用侧 Electron `nativeImage`（长边 ≤ 2000px、体积 ≤ 4.5MB、不放大、无法解码的格式原样透传），不再依赖 Pi `read` 的 photon WASM 缩放。
- **图片进上下文**：应用 resize + base64 后，经 `RpcCommand.images` 直传给 Pi（`session.prompt/steer/followUp(text, { images })`），**不经过 `read` 工具**。
- **模型能力**：模型列表标注视觉能力；附件含图片而当前模型不支持 `image` 输入时 UI 提示、**不强制拦截**，由 Pi 兜底替换为占位文本。
- 其余非图片附件维持「物化 + read/bash」不变。

详见 [spec](../specs/2026-08-30-chat-attachments-workspace-materialization.md)。

## 1. 图片缩放策略（photon / WASM）—— 已决策为应用侧 nativeImage

**现状**：`packages/agent-host/src/tool-registry.ts` 里 read 工具已设 `autoResizeImages: false`（见提交 `0546806`）。原因是打包产物中 `@silvia-odwyer/photon-node` 的 `photon_rs_bg.wasm` 不可用，`loadPhoton()` 返回 null，缩放失效导致图片被 omitted。

**最终决策**：

- 不修 photon（成本高、收益薄）；不维持“原样进入”（大图不可靠）。
- 改由应用侧 `nativeImage` 缩放，结果作为 `images` 直传（见 §0）。

## 2. 视觉模型端到端 —— 仍待验证

**已解决**：Pi 0.84.4 内置 `deepseek-v4-flash-vision-exp`（`input: ["text", "image"]`），模型目录 / 能力判定问题随本次依赖升级解决。

**未验证**：`附件 → workspace 相对路径 → Pi read 工具 → image content block → 视觉模型真正收到并理解图片` 这条链路，尚未在打包产物中用真实 vision 模型端到端验证。

**更新**：链路已改为 `附件 → 应用侧 nativeImage 缩放 → images 直传 → 视觉模型`，仍待真实 vision 模型端到端验证（小图 / 大图 / 多图）。

## 备注

- 带图消息要求当前模型支持 `image` 输入；不支持时 UI 提示、不强制拦截。
