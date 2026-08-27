# 模型 provider 配置统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设置页的 provider 配置与聊天实际使用的 provider 以 Pi SDK 为唯一事实来源，前后端一致，不维护自己的 provider 表、不覆盖内置内容、不每次交互读 key/config。

**Architecture:** 内置 provider 只暴露白名单 id，URL/认证/模型目录全部来自 Pi SDK；自定义 provider 写进 Pi 自己的 `models.json`，key 走 `ModelRuntime.setRuntimeApiKey`。key 生命周期改为「fork 时注入 + 改 key 时广播」，去掉每次操作前的 keyring 读与 models.json refresh。

**Tech Stack:** Electron + React/TS + Vitest；`@earendil-works/pi-coding-agent`（Pi SDK）、`@sparkii/agent-host`、better-sqlite3。

**Spec:** `docs/superpowers/2026-08-27-model-provider-config-consolidation.md`

## SDK 核实结果（执行者据此写代码，不再重复调研）

- `models.json`（`ModelConfig`）的 provider 配置字段：`baseUrl`、`api`、`models`、`modelOverrides`、`headers`、`compat`、`authHeader`、`apiKey`、`oauth`、`name`。
- `apiKey` 是 ConfigValue：可直接写字面量字符串，或 `${ENV_VAR}` 模板，或 `!shell command`。
- `composeModelProvider(providerId, base, config)` 合并「内置 base + models.json config」，`baseUrl` 优先级 `config?.baseUrl ?? base?.baseUrl`。
- `ModelRuntime` 提供：`getProviders()`、`getProvider(id)`、`getModels(id)`、`getModel(provider, modelId)`、`refresh(opts)`、`setRuntimeApiKey(provider, key)`、`removeRuntimeApiKey(provider)`、`completeSimple(model, ctx)`。
- `ModelRuntime.create({ authPath, modelsPath })` 启动时读 `auth.json` 与 `models.json`。
- `ModelRegistry`（`new ModelRegistry(modelRuntime)`）提供 `getProvider` / `getProviderDisplayName` / `getProviderAuthStatus` / `getAvailable` / `getAll` / `hasConfiguredAuth` / `refresh`；`pi-coding-agent` 导出 `ModelRegistry`，`pi-ai` 导出 `getBuiltinProviders`（别名 `getProviders`）。
- `setRuntimeApiKey` 是 SDK 原生方法（内存热更新），不是本项目发明。
- 内置 provider 共 40 个；国产为：`deepseek`、`kimi-coding`、`minimax`、`minimax-cn`、`moonshotai`、`moonshotai-cn`、`qwen-token-plan`、`qwen-token-plan-cn`、`qwen-token-plan-individual`、`xiaomi`、`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn`、`xiaomi-token-plan-sgp`、`zai`、`zai-coding-cn`、`ant-ling`。白名单再补 `openai`、`anthropic`。

## Global Constraints

- Node >=22、pnpm >=9；全部包 ESM，相对导入带 `.js` 后缀。
- 测试用 vitest：`packages` 用 forks 池，`apps` 用 jsdom；从仓库根运行 `npx vitest run <相对路径>`。
- 提交信息前缀：feat / fix / refactor / test / docs / style / chore；每个任务一次提交。
- UI 文案简体中文；写操作/高风险仍走审批门，不改变审批语义。
- esbuild 打包时 electron 与 better-sqlite3 保持 external。
- 单测/类型检查/lint 全绿才能提交。

## 设计假设（已与用户确认）

- 每个 provider 独立一个 key：keyring name = `apiKey:<providerId>`；主进程 `Map<providerId, key>` 缓存，首次用读一次、改 key 时写回并更新缓存。
- 自定义 provider 不落 key 到 models.json：`models.json` 只写 `{ baseUrl, api }`，key 走 `setRuntimeApiKey`（避免明文 key 落盘）。
- 自定义 provider 的模型列表：`models.json` 不写 `models`，由 `list_models` 的 `refresh({ allowNetwork: true })` 联网拉取。
- 自定义 API 类型：`openai-completions` / `anthropic-messages`；本地模型（vLLM、Ollama）是 `openai-completions` 的本地端点。
- 白名单：OpenAI、Anthropic、DeepSeek + 全部国产（含 `ant-ling`）。

## File Structure

- 修改 `packages/agent-host/src/types.ts`、`pi-runtime.ts`、`pi-sdk-runtime.ts`：暴露 `list_providers`。
- 新增 `apps/desktop/electron/main/provider-catalog.ts`：内置白名单 + 自定义合并。
- 修改 `apps/desktop/electron/main/settings.ts`：settings 增加 `activeProviderId` / `providers`。
- 修改 `apps/desktop/electron/main/pi-model-config.ts`：只写自定义 provider 到 models.json。
- 修改 `apps/desktop/electron/main/runtime.ts`：keyring 读取移到 fork 时。
- 修改 `apps/desktop/electron/main/ipc.ts`：新增 `listProviders`、改造 save/list/test/getModelOptions/promptSession、改 key 广播。
- 修改 `packages/agent-host/src/pi-runtime-pool.ts`：新增 `broadcast`。
- 修改 `apps/desktop/src/shell/SettingsView.tsx`：从 IPC 渲染 provider。
- 修改 `apps/desktop/electron/main/workflow.ts`：去掉 manifest 硬编码 deepseek。

---

### Task 1: Pi runtime 暴露 list_providers

**Files:**
- Modify: `packages/agent-host/src/types.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-runtime.test.ts`

**Interfaces:**
- Produces: `PiProviderInfo { id: string; name: string; baseUrl: string; apiKeyAuth: boolean; oauthAuth: boolean }`；`RpcCommand` 增加 `{ type: 'list_providers' }`；`PiRuntimeSession.listProviders(): Promise<PiProviderInfo[]>`。

- [ ] **Step 1: 写失败测试**

在 `packages/agent-host/test/pi-runtime.test.ts` 增加一条：向 `transport.emit` 发 `{ type: "list_providers" }`，断言响应 `success: true` 且 `data` 是数组、元素含 `id/name/baseUrl/apiKeyAuth/oauthAuth`。复用现有 fake host，先让 `host.current()` 返回的 session 缺 `listProviders`，使命令走 default 分支抛错。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: FAIL（`list_providers` 未处理）

- [ ] **Step 3: 最小实现**

`types.ts`：
```ts
export interface PiProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyAuth: boolean;
  oauthAuth: boolean;
}
// RpcCommand 增加：
| { type: 'list_providers' }
```

`pi-runtime.ts`：`PiRuntimeSession` 增加 `listProviders(): Promise<PiProviderInfo[]>`；`handleCommand` 增加：
```ts
case "list_providers":
  return await session.listProviders();
```

`pi-sdk-runtime.ts`：`adaptSession()` 返回对象增加：
```ts
listProviders: async () =>
  modelRuntime.getProviders().map((p) => {
    const provider = p as unknown as { id: string; name: string; baseUrl?: string; auth?: { apiKey?: unknown; oauth?: unknown } };
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? '',
      apiKeyAuth: Boolean(provider.auth?.apiKey),
      oauthAuth: Boolean(provider.auth?.oauth),
    };
  }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-runtime.test.ts
git commit -m "feat(agent-host): expose list_providers from pi runtime"
```

---

### Task 2: 主进程 provider catalog（白名单 + 自定义合并）

**Files:**
- Create: `apps/desktop/electron/main/provider-catalog.ts`
- Test: `apps/desktop/test/provider-catalog.test.ts`

**Interfaces:**
- Consumes: `PiProviderInfo`（from `@sparkii/agent-host`）。
- Produces:
```ts
export const BUILTIN_PROVIDER_IDS: readonly string[];
export type ProviderKind = 'builtin' | 'custom';
export interface ProviderEntry { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKeyAuth: boolean; oauthAuth: boolean; api?: 'openai-completions' | 'anthropic-messages' }
export function buildProviderList(runtimeProviders: PiProviderInfo[], customProviders: CustomProvider[]): ProviderEntry[];
```

- [ ] **Step 1: 写失败测试**

`provider-catalog.test.ts`：给定 `runtimeProviders=[{id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',apiKeyAuth:true,oauthAuth:false}, {id:'google',name:'Google',baseUrl:'...',apiKeyAuth:true,oauthAuth:true}]` 与 `customProviders=[{id:'ollama',name:'本地 Ollama',baseUrl:'http://127.0.0.1:11434/v1',api:'openai-completions'}]`，断言结果含 `deepseek`、`ollama`，不含 `google`，且 `deepseek.kind==='builtin'`、`ollama.kind==='custom'`、`ollama.api==='openai-completions'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/provider-catalog.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`provider-catalog.ts`：`BUILTIN_PROVIDER_IDS` 用 SDK 核实结果里的 18 个 id（含 `ant-ling`）；`buildProviderList` 用 `Map(runtimeProviders.map(p=>[p.id,p]))` 取内置 name/baseUrl/auth，过滤出白名单 id + 自定义 id，自定义项以 `customProviders` 的 name/baseUrl/api 覆盖。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/provider-catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/provider-catalog.ts apps/desktop/test/provider-catalog.test.ts
git commit -m "feat(desktop): provider catalog whitelist and custom merge"
```

---

### Task 3: settings 增加 activeProviderId 与 providers

**Files:**
- Modify: `apps/desktop/electron/main/settings.ts`
- Test: `apps/desktop/test/settings-store.test.ts`

**Interfaces:**
- Produces:
```ts
export interface CustomProvider { id: string; name: string; baseUrl: string; api: 'openai-completions' | 'anthropic-messages' }
export interface AppSettings {
  activeProviderId?: string;
  providers?: CustomProvider[];
  defaultModel?: string;
  routes?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
}
```
- 新增 `loadApiKey(keyring, providerId)` / `saveApiKey(keyring, providerId, key)`，keyring name = `apiKey:<providerId>`；settings.json 不存任何 key。

- [ ] **Step 1: 写失败测试**

在 `settings-store.test.ts` 增加：保存含 `activeProviderId`、`providers` 的 settings，断言 settings.json 里没有 key，重新 load 后字段往返一致；`saveApiKey('deepseek', key)` 后 `loadApiKey('deepseek')` 返回该 key。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

按上面接口改 `settings.ts`；`saveSettings` 的解构改成只剥离 `apiKey`，其余（含 `activeProviderId`/`providers`）写 settings.json。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/settings.ts apps/desktop/test/settings-store.test.ts
git commit -m "feat(desktop): settings track active provider and custom providers"
```

---

### Task 4: writePiModelsConfig 只写自定义 provider

**Files:**
- Modify: `apps/desktop/electron/main/pi-model-config.ts`
- Test: `apps/desktop/test/pi-model-config.test.ts`（若无则新建）

**Interfaces:**
- Produces: `writePiModelsConfig(piAgentDir: string, providers: CustomProvider[]): Promise<void>`（替换旧的 label→id 版本）。

- [ ] **Step 1: 写失败测试**

写入两个自定义 provider，断言生成 `models.json` 为：
```json
{ "providers": { "ollama": { "baseUrl": "http://127.0.0.1:11434/v1", "api": "openai-completions" }, "claude-compat": { "baseUrl": "https://x", "api": "anthropic-messages" } } }
```
并断言不包含任何内置 id（如 `deepseek`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/pi-model-config.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

`pi-model-config.ts` 重写为遍历 `providers`，写 `{ providers: { [p.id]: { baseUrl: p.baseUrl, api: p.api } } }`。删除 `providerIdForLabel` 与旧 `PROVIDER_CONFIG`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/pi-model-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/pi-model-config.ts apps/desktop/test/pi-model-config.test.ts
git commit -m "refactor(desktop): write only custom providers to models.json"
```

---

### Task 5: key 生命周期改造（per-provider 缓存 + 使用前注入）

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/workflow.ts`

**Interfaces:**
- Produces: `Runtime.keyFor(providerId): Promise<string | null>`；`Runtime.setKey(providerId, key): Promise<void>`。

- [ ] **Step 1: 写失败测试（runtime key 缓存）**

`apps/desktop/test/runtime-key.test.ts`（若无则新建）：用 fake keyring 断言 `keyFor('deepseek')` 读 keyring `apiKey:deepseek` 并返回；第二次 `keyFor('deepseek')` 不再读 keyring（缓存命中）；`setKey('deepseek','new')` 后 `keyFor` 返回 `new`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/runtime-key.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 keyFor / setKey + 注入**

`runtime.ts`：删掉 fork-env `SPARKII_PI_API_KEY`；`makeSupervisor` 只传 `PI_CODING_AGENT_DIR`；新增 `const keyCache = new Map<string,string>()`、`keyFor(providerId)`（读 keyring `apiKey:<providerId>` 并缓存）、`setKey(providerId,key)`（写 keyring + 更新缓存），并在 `assemble` 返回的 Runtime 上暴露。

`ipc.ts` / `workflow.ts`：`promptSession` / `withProbeSlot` / `selectModel` 把 `rt.keyring.get('apiKey')` 改成 `rt.keyFor(providerId)`；`saveSettings` 调 `rt.setKey(activeProviderId, apiKey)`。

- [ ] **Step 4: 跑测试 + typecheck 确认通过**

Run: `npx vitest run apps/desktop/test/runtime-key.test.ts`、`pnpm typecheck`
Expected: PASS / exit 0

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/workflow.ts
git commit -m "refactor(desktop): per-provider key cache and inject-on-use"
```

---

### Task 6: IPC listProviders 与 save/list/test 改造

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`

**Interfaces:**
- Produces: `sparkii:listProviders` → `ProviderEntry[]`；`sparkii:saveSettings` 写自定义 provider 到 models.json 并在 key 变化时广播；`sparkii:listModels` / `sparkii:testModel` / `sparkii:getModelOptions` 改用 `activeProviderId`（不再走 label 映射）。

- [ ] **Step 1: 写失败测试**

用现有 ipc 测试模式（若有 `apps/desktop/test/ipc.test.ts` 则扩展，否则新增）：`listProviders` 返回白名单 + 自定义；`saveSettings` 后 models.json 只含自定义 provider。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/ipc.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

`listProviders` 用 `withProbeSlot` 发 `list_providers`，再 `buildProviderList(runtimeProviders, settings.providers ?? [])`。`saveSettings` 调 `writePiModelsConfig(rt.piAgentDir, s.providers ?? [])`。`listModels`/`testModel`/`getModelOptions` 用 `settings.activeProviderId` 作为 provider id。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/ipc.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(desktop): provider list and save/list/test via active provider"
```

---

### Task 7: 聊天路由去掉 manifest 硬编码 deepseek

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`（`promptSession` 的 `selectModel`）

**Interfaces:**
- Produces: `selectModel` 优先用 `rt.chatSessions.get(sessionId).model`，否则用 settings 的 `activeProviderId` + `defaultModel`（不再回落到 manifest 里的 `deepseek`）。

- [ ] **Step 1: 写失败测试**

扩展 workflow/ipc 测试：当 settings 的 `activeProviderId='zai'`、`defaultModel='glm-5'` 且会话无 model 时，`promptSession` 的 `set_model` 用 `zai/glm-5`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/...`
Expected: FAIL

- [ ] **Step 3: 最小实现**

`promptSession` 无会话 model 时：`selectModel(settings.activeProviderId ?? 'deepseek', settings.defaultModel ?? '')`；`workflow.ts` 的 `selectModel` 同样读 activeProviderId。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/electron/main/ipc.ts
git commit -m "fix(desktop): route chat to configured provider, not hardcoded deepseek"
```

---

### Task 8: SettingsView 从 IPC 渲染 provider

**Files:**
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Test: `apps/desktop/test/settings-view.test.tsx`（若无则新建）

**Interfaces:**
- Consumes: `SettingsApi` 增加 `listProviders(): Promise<ProviderEntry[]>`；`saveSettings` 参数改为 `{ activeProviderId, providers, defaultModel, routes, apiKey }`。

- [ ] **Step 1: 写失败测试**

渲染 SettingsView，mock `listProviders` 返回内置 + 自定义；断言内置项不显示 URL 输入框，自定义项显示 baseUrl 输入框，且下拉包含白名单项、不含 `google`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/desktop/test/settings-view.test.tsx`
Expected: FAIL

- [ ] **Step 3: 最小实现**

删掉 `PROVIDERS` 常量与 `switchProvider` 的 URL 重置；provider 下拉数据来自 `api.listProviders()`；内置项只渲染「API Key」，自定义项渲染「Base URL + API 类型 + API Key」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/desktop/test/settings-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shell/SettingsView.tsx apps/desktop/test/settings-view.test.tsx
git commit -m "feat(desktop): render providers from SDK-backed list"
```

---

### Task 9: 收尾验证

- [ ] **Step 1:** `pnpm typecheck`
- [ ] **Step 2:** `pnpm lint`
- [ ] **Step 3:** 全量单测 `npx vitest run`（packages forks + apps jsdom）
- [ ] **Step 4:** `pnpm build`（esbuild 打包主进程/预加载，electron 与 better-sqlite3 保持 external）
- [ ] **Step 5:** 更新 spec/plan 文档，并提交

```bash
git commit -am "chore: finalize provider config consolidation"
```

---

## Self-Review（已做）

- Spec 覆盖：内置不覆盖 URL/只填 key、自定义写 models.json、key 三步闭环、白名单、OAuth 后续、聊天路由、前端渲染，均有对应任务。
- 占位符扫描：无 TBD/TODO 占位；「设计假设」里的三个点是明确决策而非占位。
- 类型一致：`PiProviderInfo`、`ProviderEntry`、`CustomProvider`、`AppSettings` 在各任务中命名一致。

## 已确认的决策

1. 每个 provider 独立一个 key（keyring name = `apiKey:<providerId>`），主进程 `Map<providerId,key>` 缓存。
2. 白名单 = OpenAI、Anthropic、DeepSeek + 全部国产（含 `ant-ling`）。
3. 自定义 API 类型 = `openai-completions` / `anthropic-messages`；本地 vLLM / Ollama 是 OpenAI 兼容的本地端点。
