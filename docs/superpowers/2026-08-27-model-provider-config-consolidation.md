# 模型 provider 配置统一 —— 决策与待办

日期：2026-08-27

状态：讨论稿（方向已定，实现细节待核对）

关联：昨天 follow-up 文档 `docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支 `codex/session-storage-and-credentials` 上）；本分支：`codex/model-provider-config-consolidation`

## 一、背景与目标

昨天（2026-08-26）完成了「会话记录 / 标题 / 身份 / 凭据统一」的实现，实测时发现设置页的「服务商 / baseUrl / API key」和聊天实际使用的 provider 没有打通。

本文档把昨天的遗留问题和今天讨论的决策合并成一份待办，目标是：让「设置页 provider 配置」与「聊天实际使用的 provider」成为同一个数据源，前后端一致，且不重复发明格式、不覆盖 Pi 内置内容。

## 二、昨天的 follow-up（待修）

来源：`docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支上）。

1. 切换服务商时自定义 baseUrl 丢失：`SettingsView.tsx` 的 `switchProvider` 每次切换都无条件 `setBaseUrl(预设)`，且只存一个全局 `(provider, baseUrl)`。
2. 设置页服务商 ≠ 聊天 provider：设置页选的服务商被映射成 `openai-compat` 等 id，聊天却走 `manifest.yaml` 硬编码的 `deepseek`，两条线没对应。
3. 自定义 provider 缺认证方式拉不到模型：`writePiModelsConfig` 只写 `{ baseUrl, api }`，没有认证方式，SDK 的 `composeModelProvider` 对无内置 base 且无 apiKey 的 provider 抛 `no authentication method configured`。

已确认可用、无需返工：key 热加载（每次用前懒读 keyring + `set_api_key`）、baseUrl 热刷新（`syncModelConfig` 重读 models.json）、`modelRuntime` 已贯通。

## 三、今天新增的决策

1. 内置 provider 不覆盖：Pi 已内置的 `baseUrl / auth / models / api` 一律不动，我们只补 Pi 要求我们填的内容（API key）。
2. 内置 provider 的 URL 前端完全不展示（不显示，也不灰色展示）。
3. 内置 provider 清单：OpenAI、Anthropic、DeepSeek，加上 Pi 里所有国产 provider（Qwen、智谱 GLM、Kimi/月之暗面、MiniMax、小米 MiMo 等，全部放）；不放 Groq、xAI、Google 等国内不常用的国外服务。
4. 两张表合二为一：Pi 内置 provider + 我们自定义 provider → 同一张表、同一套字段。
5. 格式沿用 Pi 自带 provider 的字段（`id / name / baseUrl / auth / api / models`），不发明新 schema。
6. OpenAI / Anthropic 的 OAuth 登录：第一期不做，记为后续 TODO。

## 四、统一 provider 注册表（沿用 Pi 格式）

Pi 内置 provider 的字段基准（以 deepseek 为例，取自 SDK）：

```js
createProvider({
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",       // 内置 URL，不覆盖
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: Object.values(DEEPSEEK_MODELS),
  api: openAICompletionsApi()
})
```

这是同一张表、同一套列（`id / name / baseUrl / api / models / auth`）。builtin 与 custom 的区别不在表结构，而在每个字段的「值从哪里来」：

- builtin 行：`baseUrl / api / models / auth` 的值由 Pi 在运行时提供，我们不往自己表里抄（只保留 `id` + 展示名）。这样避免我们抄一份 Pi 的值、将来 Pi 更新就漂移（昨天 `https://api.deepseek.com/v1` vs Pi 的 `https://api.deepseek.com` 就是这类漂移）。
- custom 行：这些字段由我们填写并存盘。

| kind | id | name | baseUrl | api | models | auth |
| --- | --- | --- | --- | --- | --- | --- |
| builtin | `deepseek` | DeepSeek | 由 Pi 提供（不落盘、不展示） | 由 Pi 提供 | 由 Pi 提供 | 只需 API key |
| builtin | `openai` | OpenAI | 同上 | 同上 | 同上 | 同上 |
| custom | `ollama` | 本地 Ollama | 我们填 | `openai-completions` | 拉取 | apiKey |
| custom | `openai-compat` | 云端 OpenAI 兼容 | 我们填 | `openai-completions` | 拉取 | apiKey |

内置 provider 候选（id 需在实现前对 SDK 目录再核对一次）：

- OpenAI：`openai`
- Anthropic：`anthropic`
- DeepSeek：`deepseek`
- 通义千问 Qwen：`qwen-token-plan` / `qwen-token-plan-cn` / `qwen-token-plan-individual`
- 智谱 GLM（Z.ai）：`zai` / `zai-coding-cn`
- Kimi / 月之暗面：`moonshotai` / `moonshotai-cn`，另有 `kimi-coding`
- MiniMax：`minimax` / `minimax-cn`
- 小米 MiMo：`xiaomi` / `xiaomi-token-plan-cn` / `xiaomi-token-plan-ams` / `xiaomi-token-plan-sgp`

不放：`google`、`groq`、`xai` 等。（`-cn`、`token-plan` 是地域/接入方式变体，实现时确认是否去重或都暴露。）

## 五、前后端一致性落地要点

- 前端 `SettingsView.tsx` 与后端 `pi-model-config.ts` 都从上述同一份注册表派生，删掉现在各自维护的 `PROVIDERS` 和 `PROVIDER_CONFIG` 两处硬编码。
- builtin：前端只渲染「服务商 + API Key」，不渲染 URL；保存只写 key，运行时 `setRuntimeApiKey(id, key)`；不写 baseUrl 进 models.json。
- custom：前端渲染「服务商 + Base URL + API Key（+ API 类型）」；后端写 models.json（baseUrl + api + 认证方式）+ key 注入。

这条规则直接收口昨天的三个问题：问题 1（切换丢 URL）消失；问题 2（provider id 不一致）由单一注册表保证；问题 3（自定义缺认证）变成 custom 的必填项。

## 六、运行时机制

这张「表」是代码里的静态单一事实来源，不是运行时反复去网络拉取的东西。它只在两个时刻被用到：渲染设置页（决定展示哪些 provider、哪些字段可编辑/隐藏）、保存设置（决定写什么）。

各字段在运行时的真实来源：

- 内置 provider 的 `baseUrl / auth / models`：由 Pi 子进程启动时 `ModelRuntime.create()` 从 SDK 目录加载一次并常驻内存，我们表里只留 `id`，不写、不覆盖、不展示。
- API key：每次真正用模型前（发消息 / 拉模型 / 测试连接）由主进程 `keyring.get` 读一次，再 `set_api_key` 注入 Pi 进程（热生效）。
- 自定义 provider 的 `baseUrl`：保存时写 `pi-agent/models.json`，运行中的 Pi 进程在 `setModel / complete / testConnection` 前 `refresh({ allowNetwork: false })` 重读（热生效）。
- 模型列表：点「拉取模型列表」才走 Pi 的 `list_models`（可能联网），provider 清单本身是静态的。

一次「发消息」的链路：`promptSession` → 读 keyring → `set_api_key` → （自定义 provider）refresh 刷新 baseUrl → `set_model` → `prompt`。

## 七、已记录 TODO（后续阶段）

- OpenAI / Anthropic 的 OAuth 登录（第一期不做）。

## 八、待定 / 实现前需核对

1. 国内 provider 的 id 与变体：Pi 分开列的 provider 就分开列、不去重/合并（例如 `minimax` 与 `minimax-cn` 是两个独立 provider）。具体 id 以 SDK 目录为准，实现时逐个核对并落进注册表。
2. custom provider 在 `models.json` 里的认证方式精确写法（`composeModelProvider` 认不认 config 里的 apiKey，还是要靠运行时 `setRuntimeApiKey`）——动手前读 SDK 确认，这也决定昨天问题 3 的修法。

## 九、下一步

- 本分支 `codex/model-provider-config-consolidation` 作为这轮 follow-up 的实现分支。
- 确认待定点后，排实现：注册表 → SettingsView → pi-model-config → 聊天路由。
