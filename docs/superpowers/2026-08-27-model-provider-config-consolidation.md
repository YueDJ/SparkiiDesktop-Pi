# 模型 provider 配置 —— 决策与待办

日期：2026-08-27

状态：讨论稿（方向已定，实现细节待核对）

关联：昨天 follow-up 文档 `docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支 `codex/session-storage-and-credentials` 上）；本分支：`codex/model-provider-config-consolidation`

## 一、背景与目标

昨天（2026-08-26）完成了「会话记录 / 标题 / 身份 / 凭据统一」的实现，实测时发现设置页的「服务商 / baseUrl / API key」和聊天实际使用的 provider 没有打通。

本文档合并昨天的遗留问题和今天的讨论决策，目标是：让「设置页 provider 配置」与「聊天实际使用的 provider」以 Pi SDK 为唯一事实来源，前后端一致，不重复发明格式、不覆盖 Pi 内置内容。

## 二、昨天的 follow-up（待修）

来源：`docs/superpowers/2026-08-26-model-provider-follow-ups.md`（在分支上）。

1. 切换服务商时自定义 baseUrl 丢失：`SettingsView.tsx` 的 `switchProvider` 每次切换都无条件 `setBaseUrl(预设)`，且只存一个全局 `(provider, baseUrl)`。
2. 设置页服务商 ≠ 聊天 provider：设置页选的服务商被映射成 `openai-compat` 等 id，聊天却走 `manifest.yaml` 硬编码的 `deepseek`，两条线没对应。
3. 自定义 provider 缺认证方式拉不到模型：`writePiModelsConfig` 只写 `{ baseUrl, api }`，没有认证方式，SDK 的 `composeModelProvider` 对无内置 base 且无 apiKey 的 provider 抛 `no authentication method configured`。

已确认可用、无需返工：key 热加载、baseUrl 热刷新、`modelRuntime` 已贯通。

## 三、结论：以 Pi SDK 为唯一事实来源，不维护自己的 provider 表

1. provider 的 `baseUrl / auth / models` 全部由 Pi SDK 管理，我们不维护一张并行的 provider 表。
2. 设置 provider 时，把「自定义 URL」写进 `models.json`、把「API key」用 `setRuntimeApiKey` 交给 Pi 内核；Pi 自己合成 provider 并在发请求时使用。
3. 内置 provider：不覆盖 URL、前端不展示 URL，只填 key。
4. 内置展示清单：OpenAI、Anthropic、DeepSeek + Pi 里所有国产 provider（Qwen、智谱 GLM、Kimi/月之暗面、MiniMax、小米 MiMo 等，全部放）；不放 Groq、xAI、Google。
5. OpenAI / Anthropic 的 OAuth 登录：第一期不做，记为 TODO。

## 四、Pi SDK 的合并机制

- 内置目录：`getBuiltinProviders()` 返回 SDK 内置 provider（`id / name / baseUrl / auth / models / api`）。
- 自定义覆盖：`models.json`（`ModelConfig`）承载我们写的自定义 provider。
- 合成：`composeModelProvider(providerId, base, config)` 把「内置 base」和「models.json config」合成一个 provider，字段优先级 `config?.baseUrl ?? base?.baseUrl`（我们写了就覆盖，没写就用内置）。
- 所以 SDK 内部天然就是「一张表 = 内置目录 + models.json 覆盖」。我们只需往里写自定义项、再读出来渲染。
- 昨天问题 3 的根因：自定义项没写认证方式，`composeModelProvider` 抛 `no authentication method configured`。

## 五、前后端一致性落地

- 前端只保留一个「要展示的内置 provider id 白名单」，加上从 `models.json` 读出的自定义项；显示名 / 认证状态从 SDK 读（`ModelRegistry.getProviderDisplayName` / `getProviderAuthStatus`）。
- 删掉 `SettingsView.tsx` 的 `PROVIDERS` 和 `pi-model-config.ts` 的 `PROVIDER_CONFIG` 两份硬编码，统一走 SDK。
- 自定义 provider：写 `models.json`（`baseUrl + api + auth.apiKey`），成为 SDK 表的一行。
- 内置 provider：只 `setRuntimeApiKey`，不写 `models.json`。

## 六、运行时机制

- URL / 认证 / 模型目录：Pi 子进程 `ModelRuntime.create()` 启动时读一次（内置目录 + models.json），常驻内存。
- API key：`setRuntimeApiKey` 写入 Pi 进程内存；`keyring` 只是我们这边的持久化存储，改 key 时才读写。
- 变更时推一次：改 URL → 写 models.json + 对运行中的 Pi 调 `refresh`；改 key → 重新 `setRuntimeApiKey`。
- 结论：不需要每次交互前读 keyring / refresh models.json（现在这两处是我们自己加的热生效逻辑，可去掉或改成「变更时推一次」）。

## 七、已记录 TODO（后续阶段）

- OpenAI / Anthropic 的 OAuth 登录。
- 去掉每次交互前的 keyring 读 + `syncModelConfig` refresh，改成「变更时推一次」。
- 核对 SDK 公开 API：`getBuiltinProviders` / `ModelRegistry` 从我们现有 `modelRuntime` / `services` 怎么拿到。

## 八、待定 / 实现前需核对

1. 国内 provider 的 id 与变体：Pi 分开列的 provider 就分开列、不去重/合并（例如 `minimax` 与 `minimax-cn` 是两个独立 provider）。具体 id 以 SDK 目录为准。
2. 自定义 provider 在 `models.json` 里的认证方式精确写法（`composeModelProvider` 认不认 config 里的 apiKey，还是必须靠 `setRuntimeApiKey`）。
3. SDK 公开导出路径：`getBuiltinProviders` / `ModelRegistry` 的 import 位置。

## 九、下一步

- 核对 SDK 公开 API → 改造 SettingsView / pi-model-config → 聊天路由（manifest 的硬编码 provider）。
