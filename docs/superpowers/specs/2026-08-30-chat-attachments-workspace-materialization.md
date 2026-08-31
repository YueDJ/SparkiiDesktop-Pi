# 聊天附件工作区物化设计规格

- 日期：2026-08-30
- 状态：设计决策已与用户逐项确认，本文档待用户审阅
- 范围：Sparkii Desktop「通用智能体」对话输入附件

## 1. 目标与定位

让用户在通用智能体对话里选择的附件，真正进入模型可读的上下文，且**尽可能复用 Pi 原生能力、不引入自研解析/缩放逻辑**。

核心结论：附件不“上传内容”，也不“传原始绝对路径”，而是**物化到会话工作区**（materialize into workspace），再把**工作区相对路径引用**发给 Pi，让模型用已有的 `read` / `bash` 工具读取。

## 2. 现状问题

当前链路是“假上传”：

1. `ChatComposer` 只保存附件的 `path / name / size / type / previewUrl`，不读取内容。
2. `GeneralChatSurface.send()` 把附件拼成一段中文路径文本（`请基于以下我提供的文件进行分析:\n- C:\...\x.pdf`），然后调用 `promptSession(sessionId, prompt)`。
3. `promptSession` / `promptDraftSession` 的 IPC 与 RPC 只携带 `message: string`，附件元数据在链路中被丢弃。
4. Pi 收到的是纯文本路径；模型用 `read` 工具读取时，附件路径几乎总在会话 `workspaceRoot` 之外，被 `withWorkspaceGuard` / `guardPath` 以“不在工作区内”拒绝。

结果：附件既没有被真正传递，模型也读不到。

## 3. 已确认决策

| 主题 | 决策 |
| --- | --- |
| 附件物化 | 发送时把附件复制进 `<workspace>/.sparkii-attachments/`；附件已在该 workspace 内则**不复制**，直接引用 |
| 文件名 | 保留原名；目标已存在同名文件时使用 `原名-N.ext`（连字符数字后缀，保留扩展名） |
| 懒创建 | 复制附件属于写操作，会 `mkdir` 创建 workspace 与附件目录；无附件不创建 |
| 消息引用 | 发送给 Pi 的 message 附带 **workspace-relative** 引用，正斜杠分隔 |
| 图片 | 应用侧用 Electron `nativeImage` 缩放（长边 ≤ 2000px、体积 ≤ 4.5MB、不放大；无法解码的格式原样透传）后，作为 `ImageContent[]` 经 `RpcCommand.images` **直接**传给 Pi，**不经过 `read` 工具** |
| 模型能力 | 图片输入要求模型支持 `image` 模态；模型列表标注视觉能力，附件含图片而当前模型不支持时 UI 提示（**不强制拦截**），由 Pi 兜底替换为占位文本 |
| 文本 | 由 Pi 原生 `read` 工具读取 |
| PDF/DOCX | 由模型用 `bash` + 本机可用工具解析，**不做预解析** |
| 文件类型 | 不设白名单，任意文件 |
| 失败处理 | 复制失败向上抛错，UI 显示错误；**不静默降级**为原始路径 |
| 用户指定 workspace | 规则统一：已在 workspace 内则不复制，否则复制进 `.sparkii-attachments/` |

## 4. 与 Pi 原生能力的关系

Pi SDK/RPC 层**不会**展开 `@file`，也不会读取磁盘文件。其原生能力是：

- `session.prompt(text, { images })`：`images` 只接受已序列化的 `ImageContent[]`，不负责缩放。
- `read` 工具：读图片文件时自动 MIME 检测 + `processImage`（缩放/转 base64/ImageContent）；`ReadToolOptions.autoResizeImages` 默认 true。
- `bash` 工具：可运行命令解析任意文档。

本设计把“文件读取/解析”交给 Pi 的 `read`/`bash` 工具；但**图片的缩放由应用侧 `nativeImage` 完成、以 `images` 直传**，不再依赖 Pi `read` 的 photon 缩放（打包后 WASM 不可用）。

## 5. 架构与数据流

```
Renderer（ChatComposer）
  └─ 选择文件 → ComposerAttachment { path, name, size, type, previewUrl }
        ↓ onSend(text, attachments)
GeneralChatSurface
  └─ 映射为 ChatAttachment { path, name, size?, type? }
        ↓ api.promptSession / promptDraftSession（新增 attachments 参数）
Preload（api.ts）原样透传
        ↓ IPC
Main（ipc.ts）
  ├─ 取会话 workspacePath（promptDraftSession 用 context 或 auto 生成；promptSession 用 chatSessions 记录）
  ├─ 拆分附件：图片 vs 非图片
  ├─ 非图片 → stageAttachments(...) + buildAttachmentPrompt(...) → 引用块
  ├─ 图片 → resizeForAttachment（nativeImage 缩放）→ base64 → ImageContent[]
  └─ slot.client.send({ type: prompt|steer|follow_up, message: finalMessage, images })
        ↓
Pi 子进程：模型直接看到 images；非图片文件用 read/bash 读 workspace 内文件
```

## 6. 详细设计

### 6.1 附件物化

新增 main 进程模块 `apps/desktop/electron/main/attachments.ts`，导出：

```ts
export const ATTACHMENTS_DIR = '.sparkii-attachments';

export interface StagedAttachment {
  ref: string;          // workspace-relative，正斜杠分隔
  absolutePath: string; // workspace 内最终绝对路径
}

export interface StagedAttachmentInput {
  path: string;
  name: string;
  size?: number;
  type?: string;
}

export function stageAttachments(
  workspacePath: string,
  attachments: StagedAttachmentInput[],
): Promise<StagedAttachment[]>;

export function buildAttachmentPrompt(
  text: string,
  refs: StagedAttachment[],
): string;
```

`stageAttachments` 规则：

1. `attachments` 为空 → 返回 `[]`，且**不创建任何目录**（保持懒创建语义）。
2. 否则先 `mkdir(workspacePath, { recursive: true })`，再 `mkdir(join(workspacePath, ATTACHMENTS_DIR), { recursive: true })`。
3. 逐附件处理：
   - `att.path` 非空、`isPathInside(workspacePath, att.path)` 且 `existsSync(att.path)` → 不复制，`ref = relative(workspacePath, att.path)`。
   - 否则在附件目录内解析唯一文件名（见 6.2），`copyFile(att.path, finalPath)`。
4. `ref` 统一转为正斜杠分隔（`relative(...).replaceAll('\\', '/')`）。
5. 任一复制失败 → 抛错，中止整个发送。

### 6.2 命名规则

- 目标文件名优先 `att.name` 原样。
- 若目标已存在，拆出扩展名生成 `stem-1.ext`、`stem-2.ext`…（`extname` 拆 stem/ext；无扩展名则 `name-1`）。
- 避让判断使用**落盘目录内的实际存在性**（`existsSync`），顺序处理同一批附件，天然覆盖同批同名。

### 6.3 消息拼接

`buildAttachmentPrompt(text, refs)`：

- 无 refs → 原样返回 `text`。
- 有 refs → 格式如下，**用户文本放在末尾**（供 renderer 回显抑制匹配）：

```
以下是本条消息附带的文件，已放置到会话工作区（相对工作区路径）：
- .sparkii-attachments/report.pdf

请使用 read 工具读取需要的文本或代码内容；PDF、Word 等二进制文档请用 bash 配合本机可用工具解析。

<用户文本>
```

### 6.4 错误处理

- 复制失败（源不存在、无权限、磁盘异常等）→ IPC 抛错 → renderer `setError` 显示。
- 带附件但无法取得 `workspacePath` → 抛错 `会话缺少工作区，无法放置附件`。
- 不做任何静默降级为原始绝对路径的行为。

### 6.5 与 workspace-guard 的关系

附件物化后位于 `workspaceRoot` 内，模型用 `read`/`bash` 读取时，`isPathInside(workspaceRoot, resolve(workspaceRoot, ref))` 正常通过。这不是“绕过 guard”，而是让附件落在 guard 允许的范围内。guard 逻辑**不改动**。

## 7. 文件类型策略

- 不设扩展名/MIME 白名单，任意文件均可作为附件。
- 图片：应用侧 `nativeImage` 缩放后以 `images` 直传 Pi；HEIC/AVIF 等 `nativeImage` 无法解码的格式**原样 base64 透传**并提示「建议转 PNG/JPG」；**SVG 按文本走 `read` 工具**（不塞给视觉模型）。
- 文本/代码：`read` 工具读取（受 Pi 默认 50KB / 2000 行截断，属原生行为）。
- 二进制文档（PDF/DOCX/XLSX 等）：模型用 `bash` + 本机工具解析。

## 8. 边界情况

| 场景 | 行为 |
| --- | --- |
| 附件已在该 workspace 内 | 不复制，直接相对引用 |
| 同批/历史同名附件 | `原名-1.ext` 递增 |
| workspace 尚未创建 | 复制前 `mkdir` 触发懒创建 |
| 用户指定 workspace | 规则与 auto 一致；附件目录 `.sparkii-attachments` 落于用户目录内 |
| 无文字、仅附件 | 沿用现有约束：composer 无文本不发送（不改变） |
| 附件为图片 | 应用侧缩放后以 `images` 直传；不经过 read 工具 |

## 9. 非目标

- 不做附件内容预解析/文本抽取。
- 不做文件类型校验/白名单。
- 不做附件生命周期回收（会话结束清理）——留后续。
- 不改 workspace-guard 与审批模型。

## 10. 测试策略

- `attachments.ts`：单元测试覆盖“在 workspace 内不复制 / 外部复制 / 同名避让 / 懒创建 / 失败抛错 / 空附件不创建目录 / message 拼接”。
- `image-resize`（新模块）：覆盖“不放大 / 长边 ≤ 2000 / 体积上限 / 无法解码透传 / PNG 保透明 / 等比缩放的几何计算”。
- IPC：`promptSession` / `promptDraftSession` 带附件时完成复制并把引用写入最终 message。
- IPC：带图片附件时完成缩放并把 `images` 写入 RPC；非图片附件仍走物化 + 引用。
- renderer：有附件时把 `ChatAttachment[]` 传给 api；无附件时调用签名不变（保持现有测试通过）；回显抑制兼容引用块前缀。
- renderer：附件含图片且当前模型不支持视觉时出现提示（不拦截发送）。

## 11. 验收标准

1. 用户发送带附件的消息后，附件以 `.sparkii-attachments/原名` 落于会话 workspace；模型通过 read/bash 能读取。
2. 同名附件产生 `原名-1.ext` 且原文件不被覆盖。
3. 无附件时行为与现状完全一致。
4. 复制失败时 UI 显示明确错误，不发送半成品。
5. 现有 `pnpm test` 全量通过，合同审核流程不回归。
6. 带图片的消息用真实 `deepseek-v4-flash-vision-exp` 在打包产物中验证：模型能准确描述图片内容（覆盖小图 / 大图 / 多图）。
7. 当前模型不支持视觉时，发送带图片消息 UI 有提示；切换到视觉模型后图片可被理解。
