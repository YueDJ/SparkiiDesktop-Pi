# 附件图片 / 视觉链路 —— 待决策与未调通项

> 日期：2026-08-30
> 分支：`codex/chat-attachments-workspace`
> 状态：待决策 / 待端到端验证

## 1. 图片缩放策略（photon / WASM）—— 未决策

**现状**：`packages/agent-host/src/tool-registry.ts` 里 read 工具已设 `autoResizeImages: false`（见提交 `0546806`）。原因是打包产物中 `@silvia-odwyer/photon-node` 的 `photon_rs_bg.wasm` 不可用，`loadPhoton()` 返回 null，缩放失效导致图片被 omitted。

**待决策**：

- A. 正确打包 photon + WASM（electron-builder 用 `extraResources`/`asarUnpack` 带上 WASM，esbuild 对 photon 做 `external` 或修正 WASM 路径），恢复 Pi 原生 2000×2000 / 4.5MB 的缩放限制。
- B. 维持 `autoResizeImages: false`，图片原样进入；大图可能超 provider 限制或被 omitted。

## 2. 视觉模型端到端 —— 未调通 / 未验证

**已解决**：Pi 0.84.4 内置 `deepseek-v4-flash-vision-exp`（`input: ["text", "image"]`），模型目录 / 能力判定问题随本次依赖升级解决。

**未验证**：`附件 → workspace 相对路径 → Pi read 工具 → image content block → 视觉模型真正收到并理解图片` 这条链路，尚未在打包产物中用真实 vision 模型端到端验证。

**依赖**：第 1 条缩放策略未定，大图在真实 provider 下的行为也未知。

## 备注

- 若选 A（恢复缩放），需在 asar 环境实测 WASM 可加载。
- 若选 B（维持关闭），需确认大图 / 多图场景不会稳定触发 omitted 或超限。
