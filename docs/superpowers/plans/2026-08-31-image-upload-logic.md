# 图片上传逻辑实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让图片附件不再经过 Pi 的 `read` 工具，而是由应用侧 `nativeImage` 缩放后经 `RpcCommand.images` 直传，并在模型不支持视觉时给出提示（不拦截）。

**Architecture:** 图片走「应用 resize → base64 → `images` 字段」，非图片附件维持「物化 + `read`/`bash`」。模型能力从 Pi 的 `list_models` 透出（`model.input.includes("image")`），renderer 据此提示。

**Tech Stack:** TypeScript（strict，ESM，import 相对路径带 `.js`）、Electron main `nativeImage`、vitest（jsdom / forks）、`@sparkii/agent-host`。

**Spec:** [2026-08-30-chat-attachments-workspace-materialization.md](../specs/2026-08-30-chat-attachments-workspace-materialization.md)

## Global Constraints

- ESM + strict TS；新文件 import 相对路径带 `.js` 后缀；沿用分号风格。
- 单测不得依赖真实 Electron 窗口与真实 LLM；`nativeImage` 用 `vi.mock('electron')` 注入假实现；fs 测试用 `mkdtemp` 并在 `afterEach` 清理。
- 无附件 / 无图片时，`promptSession` 调用参数与现状一致（现有 `toHaveBeenCalledWith` 断言不回归）。
- 图片缩放：长边 ≤ 2000px、不放大、PNG 保 PNG（透明）、其余转 JPEG；无法解码返回 null 由调用方原样透传。
- 模型能力用「支持 image 输入」布尔值表达，不做多模态矩阵、不做自动路由、不做硬拦截。

---

### Task 1: 图片缩放模块

**Files:**
- Create: `apps/desktop/electron/main/image-resize.ts`
- Test: `apps/desktop/test/image-resize.test.ts`

**Interfaces:**
- Produces: `computeResizeTarget(width, height, maxDimension)`, `resizeImageForAttachment(path, mimeType, options?)`。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/image-resize.test.ts`（`vi.mock('electron')` 提供假 `nativeImage`；测试 `computeResizeTarget` 与 `resizeImageForAttachment` 的缩放/PNG/JPEG/空图返回 null）。
- [ ] **Step 2: 运行确认失败** `pnpm exec vitest run apps/desktop/test/image-resize.test.ts`
- [ ] **Step 3: 实现** `image-resize.ts`
- [ ] **Step 4: 运行确认通过** 同上命令
- [ ] **Step 5: Commit**（沙箱禁写 `.git`，见备注）

### Task 2: RPC images 接线（agent-host）

**Files:**
- Modify: `packages/agent-host/src/types.ts`（新增 `ImageContent`；`prompt/steer/follow_up` 加 `images?`）
- Modify: `packages/agent-host/src/pi-runtime.ts`（`PiRuntimeSession` 签名 + `handleCommand` 转发 `images`）
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`（`startPromptWithoutBlocking` 透传 images；`adaptSession` 的 steer/followUp 透传 images）
- Test: `packages/agent-host/test/pi-runtime.test.ts`（用现有 fakeSession，断言 `steer(message, images)` / `followUp(message, images)` / `prompt(message, { streamingBehavior, images })`）

### Task 3: main 侧拆分图片与非图片并发送 images

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`（`promptSession` 内拆分、缩放图片、发送 `images`）
- Modify: `apps/desktop/electron/main/attachments.ts`（`buildAttachmentPrompt` 去掉「图片经 read」文案）
- Test: `apps/desktop/test/ipc.test.ts`（带图片附件时 `prompt` 命令含 `images`，非图片仍物化）

### Task 4: 模型能力透出 + 聊天面提示

**Files:**
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`（`listModels` 返回 `supportsImages`）
- Modify: `apps/desktop/electron/main/ipc.ts`（`getModelOptions` 返回 `supportsImages`）
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`（记录 `supportsImages`；发送含图且模型不支持时显示提示，不拦截）
- Test: `apps/desktop/test/general-chat-surface.test.tsx`

## 备注

- 设置页「默认模型」下拉的视觉能力标注延后：它走 provider `/models` 探测，拿不到能力信息；本次先把能力用在聊天输入框（附图的判断/警告）。
