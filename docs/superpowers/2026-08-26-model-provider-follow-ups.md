# 模型 provider / 设置页 配置脱节 —— 遗留问题与根因（待下一 session 修复）

- 日期：2026-08-26
- 状态：待修（下一 session 处理）
- 关联：会话记录/标题/身份/凭据统一（2026-08-26）实现过程中的实测发现

## 背景

在实测「设置页配 key / baseUrl → 聊天」这条链路时，发现设置页的「服务商 / baseUrl」与聊天实际使用的 provider 没有正确打通。以下三个问题是相互独立、但叠加起来造成「改了 URL 聊天不对、设置页还能拉取/测试、自定义服务商拉不到模型」的现象。

## 问题 1：切换服务商时自定义 baseUrl 丢失

**现象**：把 DeepSeek 的 URL 改成自定义值并保存后，切到别的服务商再切回 DeepSeek，URL 又变回预设的正确值，用户的自定义值丢失。

**根因**：`apps/desktop/src/shell/SettingsView.tsx` 的 `switchProvider` 每次切换都执行 `setBaseUrl(PROVIDERS[name]?.url)`，无条件重置为预设 URL；且 settings 只保存一个全局 `(provider, baseUrl)`，不按服务商分别记住各自的自定义 URL。

**相关文件**：`apps/desktop/src/shell/SettingsView.tsx`

**修复方向（供参考）**：切换时不要无脑重置；或按 provider 分别记忆 baseUrl；或切回某 provider 时从已保存的 settings 恢复其值。

## 问题 2：设置页服务商 ≠ 聊天使用的 provider

**现象**：设置页选「云端 OpenAI 兼容」时拉不到 deepseek 模型；聊天却仍用 deepseek。两边各自独立，baseUrl 写给了设置页的 provider，聊天读的是另一个 provider。

**根因**：
- 聊天用哪个 provider 是由 profile `manifest.yaml` 的 `modelRouting.tasks` 硬编码为 `deepseek`。
- 设置页的服务商经 `apps/desktop/electron/main/pi-model-config.ts` 的 `providerIdForLabel` 映射成另一个 id（如「云端 OpenAI 兼容」→ `openai-compat`）。
- `saveSettings` 写 `models.json` 时写的是设置页映射出来的 id，而聊天读的是 `deepseek`，两条线没有建立对应关系。

**相关文件**：`apps/desktop/electron/main/pi-model-config.ts`、`profiles/*/manifest.yaml`、`apps/desktop/electron/main/ipc.ts`、`packages/agent-host/src/pi-sdk-runtime.ts`

**修复方向（供参考）**：建立「设置页服务商 ↔ 聊天 provider id」的唯一对应，或让聊天从 settings 读取 provider，而不是依赖 manifest 硬编码。

## 问题 3：自定义 provider 缺认证方式导致无法组成、拉不到模型

**现象**：选「云端 OpenAI 兼容」（映射为 `openai-compat`）时，`list_models` 返回空，拉不到模型。

**根因**：`apps/desktop/electron/main/pi-model-config.ts` 的 `writePiModelsConfig` 写进 `models.json` 的只有 `{ baseUrl, api }`，没有 apiKey 认证方式。SDK 的 `composeModelProvider` 对「无内置 base、且 config 里无 apiKey」的 provider 会抛 `no authentication method configured`，于是该 provider 被丢弃、`getModels` 为空。DeepSeek 因为是内置 provider（有 base 提供认证方式），所以能正常组成；只有自定义 provider 这一路会挂。

**相关文件**：`apps/desktop/electron/main/pi-model-config.ts`

**修复方向（供参考）**：给自定义 provider 提供认证方式（config 里用 apiKey 引用环境变量/内存，或调整运行时 key 的注入时机），并确认 `composeModelProvider` 能使用运行时注入的 key。

## 已确认可用的部分（无需返工）

- key 热加载：每次模型操作前从 keyring 懒读 + `set_api_key` 注入，改 key 下一条消息生效。
- baseUrl 热刷新：`syncModelConfig` 在 `setModel`/`complete`/`testConnection` 前 `refresh({ allowNetwork:false })` 重读 `models.json`，改 baseUrl 下一条消息生效（对聊天路径已验证）。
- `modelRuntime` 已贯通：`createAgentSessionServices` 传入同一个 `modelRuntime`，避免进程内出现两个实例导致 key 注入错位。

## 备注

上述三个问题的根因均在「设置页服务商 ↔ 聊天 provider」这条对应关系没有设计清楚，属于配置/接线层面，不涉及会话存储、审批、身份等其它模块。
