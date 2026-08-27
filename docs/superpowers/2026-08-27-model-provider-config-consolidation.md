# 模型 provider 配置 —— 决策定稿

日期：2026-08-27

状态：定稿（另有「实现前待核对」清单）

关联：昨天 follow-up 文档 `docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支 `codex/session-storage-and-credentials` 上）；本分支：`codex/model-provider-config-consolidation`

## 一、背景与目标

昨天（2026-08-26）完成了「会话记录 / 标题 / 身份 / 凭据统一」的实现，实测时发现设置页的「服务商 / baseUrl / API key」和聊天实际使用的 provider 没有打通。

本文档合并昨天的遗留问题和今天的讨论决策，目标：让「设置页 provider 配置」与「聊天实际使用的 provider」以 Pi SDK 为唯一事实来源，前后端一致，不重复发明格式、不覆盖 Pi 内置内容、不引入每次交互的额外读写。

## 二、昨天的 follow-up（待修）

来源：`docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支上）。

1. 切换服务商时自定义 baseUrl 丢失：`SettingsView.tsx` 的 `switchProvider` 每次切换都无条件 `setBaseUrl(预设)`，且只存一个全局 `(provider, baseUrl)`。
2. 设置页服务商 ≠ 聊天 provider：设置页选的服务商被映射成 `openai-compat` 等 id，聊天却走 `manifest.yaml` 硬编码的 `deepseek`，两条线没对应。
3. 自定义 provider 缺认证方式拉不到模型：`writePiModelsConfig` 只写 `{ baseUrl, api }`，没有认证方式，SDK 的 `composeModelProvider` 对无内置 base 且无 apiKey 的 provider 抛 `no authentication method configured`。

已确认可用、无需返工：key 热加载、baseUrl 热刷新、`modelRuntime` 已贯通。

## 三、最终决策

1. Pi SDK 是唯一事实来源：provider 的 `baseUrl / auth / models` 全由 Pi SDK 管理，我们不维护一张并行的 provider 表，也不发明自己的格式。
2. 内置 provider：不覆盖 URL、前端完全不展示 URL，只填 API key；URL / 认证 / 模型目录来自 SDK 内置目录。
3. 内置展示清单：OpenAI、Anthropic、DeepSeek + Pi 里所有国产 provider（通义千问 Qwen、智谱 GLM / Z.ai、Kimi / 月之暗面、MiniMax、小米 MiMo、蚂蚁 Ling 等，全部放）；不放 Groq、xAI、Google。Pi 分开列的 provider 就分开列、不去重 / 合并（`minimax` 与 `minimax-cn` 是两个独立 provider）。
4. 自定义 provider：URL 写进 `models.json`（Pi 自己的配置文件）、API key 走 `setRuntimeApiKey`；URL / API 类型 / 认证方式可定义、可修改。API 类型为 `openai-completions`（OpenAI 兼容）与 `anthropic-messages`（Anthropic 兼容）两种；本地模型（vLLM、Ollama）是 OpenAI 兼容的本地端点，作为自定义 provider 的一种。
5. API key 的存储与更新（每个 provider 独立一个 key）：
   - 持久化：存我们加密的 `keyring`（Electron `safeStorage`，Windows 走 DPAPI），每个 provider 一个条目，name = `apiKey:<providerId>`。
   - `Keyring` 类不变（name→value）；新增 `loadApiKey(providerId)` / `saveApiKey(providerId, key)` 辅助函数。
   - 主进程维护 `Map<providerId, key>` 内存缓存：首次用读一次并缓存，之后走缓存；改 key 时写 keyring + 更新缓存。
   - 改 key 生命周期：写 keyring(`apiKey:<id>`) → 更新缓存 → 该 provider 下次被用前从缓存 `setRuntimeApiKey` 注入（可选：同时广播给在跑的 slot）。
   - `setRuntimeApiKey` 是 Pi SDK 原生方法（`ModelRuntime.setRuntimeApiKey`），不是我们发明的。
6. OpenAI / Anthropic 的 OAuth 登录：第一期不做，记为后续 TODO。

## 四、Pi SDK 的合并机制（为什么不需要自己的表）

- 内置目录：`getBuiltinProviders()` 返回 SDK 内置 provider（`id / name / baseUrl / auth / models / api`）。
- 自定义覆盖：`models.json`（`ModelConfig`）承载我们写的自定义 provider——这是 Pi 自己的配置文件（`ModelRuntime.create({ modelsPath })` 读它），不是我们造的表。
- 合成：`composeModelProvider(providerId, base, config)` 把「内置 base」和「models.json config」合成一个 provider，字段优先级 `config?.baseUrl ?? base?.baseUrl`（我们写了就覆盖，没写就用内置）。
- 所以 SDK 内部天然就是「一张表 = 内置目录 + models.json 覆盖」。我们只需往里写自定义项、再读出来渲染。
- 昨天问题 3 的根因：自定义项没写认证方式，`composeModelProvider` 抛 `no authentication method configured`。

## 五、前后端一致性落地

- 前端只保留一个「要展示的内置 provider id 白名单」，加上从 `models.json` 读出的自定义项；显示名 / 认证状态从 SDK 读（`ModelRegistry.getProviderDisplayName` / `getProviderAuthStatus`）。
- 删掉 `SettingsView.tsx` 的 `PROVIDERS` 和 `pi-model-config.ts` 的 `PROVIDER_CONFIG` 两份硬编码，统一走 SDK。
- 自定义 provider：写 `models.json`（`baseUrl + api + auth.apiKey`），成为 SDK 表的一行。
- 内置 provider：只 `setRuntimeApiKey`，不写 `models.json`。

## 六、运行时机制（目标态）

- URL / 认证 / 模型目录：Pi 子进程 `ModelRuntime.create()` 启动时读一次（内置目录 + models.json），常驻内存。
- 改自定义 URL：写 models.json + 对运行中的 Pi 调一次 `refresh`。
- API key：按第三节第 5 条的三步闭环；平时常驻内存。
- 无每次交互读：不再每次交互前读 keyring / `refresh` models.json（内置 provider 更是完全不读 models.json）。

当前代码需一并修正的两点：

1. `runtime.ts` 在 app 启动时读一次 keyring 并固化成 `env.SPARKII_PI_API_KEY`，导致改 key 后新 fork 的进程拿到旧 key；应把 keyring 读取移到「每次 fork 时」。
2. `ipc.ts` / `workflow.ts` 现在每次操作前都读 keyring + `set_api_key`，是为补第 1 点的洞；应按目标态删掉，改成「改 key 时广播 + fork 时注入」。

## 七、本期实现范围

- 改造 `SettingsView.tsx` / `pi-model-config.ts`，删掉 `PROVIDERS` / `PROVIDER_CONFIG`，统一走 SDK。
- key：keyring 读取移到 fork 时 + 改 key 时广播 `setRuntimeApiKey` + 删除每次交互读。
- `PiRuntimePool` 新增「遍历所有 slot 广播」的 API。
- 聊天路由不再依赖 `manifest.yaml` 硬编码 provider。

## 八、后续 TODO

- OpenAI / Anthropic 的 OAuth 登录。

## 九、实现前待核对

1. SDK 公开 API：`getBuiltinProviders` / `ModelRegistry`（`getProviderDisplayName` / `getProviderAuthStatus`）从现有 `modelRuntime` / `services` 怎么拿到。
2. 本地无 key 的 provider（vLLM / Ollama）在 `models.json` 的认证方式精确写法：是否需要写 `apiKey: ""` 或注入空 key，才能让 `composeModelProvider` 组成 provider。
3. 国内 provider 精确 id 与变体（含 `ant-ling`，以 SDK 目录为准）。

## 十、下一步

- 先核对第九节，然后按第七节顺序实现。
