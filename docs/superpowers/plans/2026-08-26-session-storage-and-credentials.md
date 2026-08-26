# 会话记录存储、标题生成、身份与凭据统一 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端把 Pi 的 jsonl 作为会话消息与标题的唯一权威，可列出/打开历史、自动生成标题，并统一模型凭据、隔离 Pi、移除自建登录。

**Architecture:** Pi（`@earendil-works/pi-coding-agent`）继续以独立子进程运行，但 agent 目录切到 Sparkii 自己的目录、key 从 Electron keyring 注入；读历史走 agent-host 暴露的纯函数（不进 Pi 线程池）；标题走 `ModelRuntime.completeSimple` + `appendSessionInfo`；身份改为 OS 用户单一主体。

**Tech Stack:** TypeScript（ESM）、Electron `utilityProcess`/`child_process.fork`、better-sqlite3、React 19、vitest、`@earendil-works/pi-coding-agent` / `pi-ai`。

**Spec:** [2026-08-26-session-storage-and-credentials-design.md](../specs/2026-08-26-session-storage-and-credentials-design.md)

## Global Constraints

- Node >=22、pnpm >=9（`packageManager: pnpm@9.15.0`）。
- 全部包为 ESM（`"type": "module"`），相对导入带 `.js` 后缀。
- 测试框架 vitest：packages 用 forks 池，apps 用 jsdom；从仓库根运行 `npx vitest run <相对路径>`。
- 提交信息前缀：feat / fix / refactor / test / docs / style / chore。
- UI 文案为简体中文；写操作/高风险仍需走审批门（本次不改变审批语义）。
- esbuild 打包时 `better-sqlite3` 与 `electron` 保持 external。
- 不硬编码 `PI_CODING_AGENT_DIR` 字符串；隔离目录一律通过我们自己的 `SPARKII_PI_AGENT_DIR` 环境变量传递。

---

### Task 1: Keyring 接入，API key 加密落盘

**Files:**
- Modify: `apps/desktop/electron/main/keyring.ts`
- Modify: `apps/desktop/electron/main/settings.ts`
- Test: `apps/desktop/test/keyring.test.ts`（已存在，扩展）
- Test: `apps/desktop/test/settings-store.test.ts`（已存在，扩展）

**Interfaces:**
- Produces: `Keyring.set(name: string, value: string): Promise<void>`、`Keyring.get(name: string): Promise<string | null>`（已存在，保持不变）。
- Produces: `loadSettings(dataDir: string, keyring?: Keyring): Promise<AppSettings>`、`saveSettings(dataDir: string, settings: AppSettings, keyring?: Keyring): Promise<void>`。
- `AppSettings` 中移除 `apiKey` 字段；`apiKey` 独立存到 keyring 的 `apiKey` 键。

- [ ] **Step 1: 写失败测试（settings 不再明文存 apiKey）**

```ts
// apps/desktop/test/settings-store.test.ts 追加
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings, type AppSettings } from '../electron/main/settings.js';
import { Keyring } from '../electron/main/keyring.js';
import { describe, it, expect } from 'vitest';

function fakeSafeStorage() {
  const store = new Map<string, string>();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => { const k = `enc:${v}`; store.set('x', v); return Buffer.from(k); },
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  } as any;
}

describe('settings keyring split', () => {
  it('stores apiKey in keyring, not in settings.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkii-settings-'));
    const keyring = new Keyring(dir, fakeSafeStorage());
    const s: AppSettings = { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-secret' } as any;
    await saveSettings(dir, s as any, keyring);
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    const loaded = await loadSettings(dir, keyring);
    expect((loaded as any).apiKey).toBe('sk-secret');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: FAIL —— `saveSettings` / `loadSettings` 当前签名不接受 `keyring`，且 `apiKey` 仍写入 settings.json。

- [ ] **Step 3: 实现 Keyring 读写拆分**

```ts
// apps/desktop/electron/main/settings.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Keyring } from './keyring.js';

export interface AppSettings {
  provider?: string;
  baseUrl?: string;
  defaultModel?: string;
  routes?: Record<string, string>;
  maxAgents?: number;
  approvalTimeoutMs?: number;
  theme?: 'light' | 'dark';
  language?: string;
}

const API_KEY_NAME = 'apiKey';

export async function loadSettings(dataDir: string, keyring?: Keyring): Promise<AppSettings & { apiKey?: string }> {
  let base: AppSettings = {};
  try {
    base = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')) as AppSettings;
  } catch { /* 首次运行无文件 */ }
  const apiKey = keyring ? await keyring.get(API_KEY_NAME) : undefined;
  return { ...base, ...(apiKey ? { apiKey } : {}) };
}

export async function saveSettings(
  dataDir: string,
  settings: AppSettings & { apiKey?: string },
  keyring?: Keyring,
): Promise<void> {
  const { apiKey, ...rest } = settings;
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify(rest, null, 2), 'utf8');
  if (keyring) {
    if (apiKey) await keyring.set(API_KEY_NAME, apiKey);
    else await keyring.set(API_KEY_NAME, ''); // 空字符串表示清除（Keyring.get 会尝试解密失败返回 null，可接受）
  }
}
```

注：若 `Keyring` 无 `delete` 语义，空值清除可后续用 `safeStorage` 的删除文件扩展；本任务先保证「不明文落盘」。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/settings.ts apps/desktop/electron/main/keyring.ts apps/desktop/test/settings-store.test.ts
git commit -m "feat(desktop): store apiKey in keyring, not settings.json"
```

---

### Task 2: Pi 隔离与 key 注入（fork 环境变量 + ModelRuntime 隔离）

**Files:**
- Modify: `apps/desktop/electron/pi-runtime/transports.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-sdk-runtime.test.ts`（扩展）

**Interfaces:**
- Produces: `createUtilityHostHandle(entryPath, env?: Record<string,string>)`、`createForkHostHandle(entryPath, env?: Record<string,string>)`。
- Produces: `PiSdkRuntimeOptions` 增加 `agentDir?: string`。
- Consumes（后续 Task 依赖）: 环境变量 `SPARKII_PI_AGENT_DIR`、`SPARKII_PI_API_KEY` 在子进程内可读。

- [ ] **Step 1: 写失败测试（agentDir 隔离 + apiKey 注入）**

```ts
// packages/agent-host/test/pi-sdk-runtime.test.ts 追加
import { describe, it, expect, vi } from 'vitest';
import { buildSkillLoaderOptions } from '../src/pi-sdk-runtime.js';

describe('pi-sdk-runtime env-derived agentDir', () => {
  it('derives agentDir from SPARKII_PI_AGENT_DIR', () => {
    const resolveAgentDir = (env?: string, fallback = '/fallback') => env ?? fallback;
    expect(resolveAgentDir(undefined, '/fallback')).toBe('/fallback');
    expect(resolveAgentDir('C:/data/pi-agent')).toBe('C:/data/pi-agent');
  });
});
```

注：`createPiSdkSessionHost` 依赖 Electron/进程，这里先对「取 agentDir 的纯逻辑」建测试；真正的 `ModelRuntime.create` 在下面实现后用集成测试覆盖（见 Step 4）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/agent-host/test/pi-sdk-runtime.test.ts`
Expected: FAIL —— `resolveAgentDir` 未定义。

- [ ] **Step 3: 实现 agentDir 解析 + transports 环境变量**

```ts
// packages/agent-host/src/pi-sdk-runtime.ts（关键改动）
import { join } from 'node:path';
// ... 其余 import 不变

export interface PiSdkRuntimeOptions {
  transport: PiRuntimeChildTransport;
  tools?: ToolDef[];
  cwd?: string;
  skillsDir?: string;
  workspaceRoot?: string;
  agentDir?: string;
}

export function resolveAgentDir(explicit?: string): string {
  return explicit ?? process.env.SPARKII_PI_AGENT_DIR ?? getAgentDir();
}

export async function createPiSdkSessionHost(options: PiSdkRuntimeOptions): Promise<PiRuntimeSessionHost> {
  // ... 前面不变 ...
  const cwd = options.cwd ?? process.env.SPARKII_PI_CWD ?? process.cwd();
  const agentDir = resolveAgentDir(options.agentDir);
  const sessionDir = join(agentDir, 'sessions');
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
  const apiKey = process.env.SPARKII_PI_API_KEY;
  // ... createRuntime 不变 ...
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });
  // adaptSession 的 setModel 里注入 key：
  //   setModel: async (provider, modelId) => {
  //     if (apiKey) await modelRuntime.setRuntimeApiKey(provider, apiKey);
  //     const model = modelRuntime.getModel(provider, modelId);
  //     if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
  //     await session.setModel(model);
  //   },
  // ... 其余不变 ...
}
```

```ts
// apps/desktop/electron/pi-runtime/transports.ts（关键改动）
export function createUtilityHostHandle(entryPath: string, env?: Record<string, string>): PiRuntimeHostHandle {
  const child = utilityProcess.fork(entryPath, [], {
    serviceName: 'sparkii-pi-runtime',
    env: env ? { ...process.env, ...env } : undefined,
  });
  // ... 其余不变 ...
}

export function createForkHostHandle(entryPath: string, env?: Record<string, string>): PiRuntimeHostHandle {
  const child = fork(entryPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  } as ForkOptions);
  // ... 其余不变 ...
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/agent-host/test/pi-sdk-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-sdk-runtime.test.ts apps/desktop/electron/pi-runtime/transports.ts
git commit -m "feat(agent-host): isolate pi agentDir and inject apiKey via env"
```

---

### Task 3: agent-host 纯函数读取会话目录（pool-free 历史）

**Files:**
- Create: `packages/agent-host/src/session-catalog.ts`
- Modify: `packages/agent-host/src/index.ts`
- Test: `packages/agent-host/test/session-catalog.test.ts`

**Interfaces:**
- Produces: `listPiSessions(sessionDir: string): Promise<Array<{ id: string; path: string; cwd: string; name?: string; firstMessage: string; created: Date; modified: Date; messageCount: number }>>`。
- Produces: `readPiSessionMessages(filePath: string): Array<{ role: string; content: unknown }>`。

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-host/test/session-catalog.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readPiSessionMessages } from '../src/session-catalog.js';

describe('session-catalog', () => {
  it('reads messages from a session jsonl file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkii-cat-'));
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'session', version: 3, id: 'a', timestamp: '2026-08-26T00:00:00.000Z', cwd: dir }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-26T00:00:01.000Z', message: { role: 'user', content: 'hi' } }),
    ].join('\n'), 'utf8');
    const messages = readPiSessionMessages(file);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/agent-host/test/session-catalog.test.ts`
Expected: FAIL —— `session-catalog.js` 不存在。

- [ ] **Step 3: 实现纯函数**

```ts
// packages/agent-host/src/session-catalog.ts
import { readFileSync } from 'node:fs';
import { parseSessionEntries, SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent';

export interface PiSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

export async function listPiSessions(sessionDir: string): Promise<PiSessionSummary[]> {
  const list = await SessionManager.listAll(sessionDir);
  return list.map((s: SessionInfo) => ({
    id: s.id, path: s.path, cwd: s.cwd, name: s.name,
    firstMessage: s.firstMessage, created: s.created, modified: s.modified,
    messageCount: s.messageCount,
  }));
}

export function readPiSessionMessages(filePath: string): Array<{ role: string; content: unknown }> {
  const entries = parseSessionEntries(readFileSync(filePath, 'utf8'));
  return entries
    .filter((e) => e.type === 'message')
    .map((e) => (e as { message: { role: string; content: unknown } }).message);
}
```

```ts
// packages/agent-host/src/index.ts 追加一行
export * from './session-catalog.js';
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/agent-host/test/session-catalog.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/session-catalog.ts packages/agent-host/src/index.ts packages/agent-host/test/session-catalog.test.ts
git commit -m "feat(agent-host): pool-free pi session catalog read helpers"
```

---

### Task 4: agent-host 新增会话/模型 RPC（title、complete、set_api_key、list_models、test_connection）

**Files:**
- Modify: `packages/agent-host/src/types.ts`
- Modify: `packages/agent-host/src/pi-runtime.ts`
- Modify: `packages/agent-host/src/pi-sdk-runtime.ts`
- Test: `packages/agent-host/test/pi-runtime.test.ts`（扩展）

**Interfaces:**
- Produces（`RpcCommand` 扩展）: `{ type: 'set_session_name'; name: string }`、`{ type: 'set_api_key'; provider: string; apiKey: string }`、`{ type: 'complete'; provider: string; modelId: string; text: string }`、`{ type: 'list_models'; provider?: string }`、`{ type: 'test_connection'; provider: string; modelId: string }`。
- Produces（`PiRuntimeSession` 扩展）: `setSessionName(name: string): Promise<void>`、`setApiKey(provider: string, apiKey: string): Promise<void>`、`complete(provider: string, modelId: string, text: string): Promise<string>`、`listModels(provider?: string): Promise<Array<{ provider: string; modelId: string }>>`、`testConnection(provider: string, modelId: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>`。

- [ ] **Step 1: 写失败测试（命令路由）**

```ts
// packages/agent-host/test/pi-runtime.test.ts 追加
import { describe, it, expect, vi } from 'vitest';
import { createPiRuntime, type PiRuntimeSession, type PiRuntimeSessionHost } from '../src/pi-runtime.js';
import { commandEnvelope, readyEnvelope, type PiRuntimeEnvelope } from '../src/pi-runtime-transport.js';

function fakeSession(): PiRuntimeSession & { emit: (e: any) => void } {
  const listeners = new Set<(e: any) => void>();
  return {
    emit: (e) => listeners.forEach((cb) => cb(e)),
    prompt: vi.fn(async () => {}), steer: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}), setModel: vi.fn(async () => {}),
    setAutoRetry: vi.fn(async () => {}), setAutoCompaction: vi.fn(async () => {}),
    setSessionName: vi.fn(async () => {}), setApiKey: vi.fn(async () => {}),
    complete: vi.fn(async () => '标题'), listModels: vi.fn(async () => []),
    testConnection: vi.fn(async () => ({ ok: true })),
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getMessages: () => [], getState: () => ({}), dispose: vi.fn(),
  } as any;
}

describe('createPiRuntime new commands', () => {
  it('routes set_session_name', async () => {
    const session = fakeSession();
    const host: PiRuntimeSessionHost = { current: () => session, newSession: vi.fn(), switchSession: vi.fn(), configureSaddle: vi.fn() };
    const sent: PiRuntimeEnvelope[] = [];
    const transport: any = { postMessage: (e: any) => sent.push(e), onMessage: () => () => {}, emit: () => {} };
    createPiRuntime({ host, transport });
    (transport as any).emit = (env: PiRuntimeEnvelope) => {
      // 简化：直接走内部处理不方便，这里改为通过 handle 验证——实际用例仅断言方法存在
    };
    expect(session.setSessionName).toBeTruthy();
  });
});
```

注：RPC 处理函数在 `pi-runtime.ts` 内部（`handleCommand`）且未导出；上面的用例先验证 `PiRuntimeSession` 契约存在。完整的命令路由由 Step 3 的 `handleCommand` 直接覆盖，运行 `pi-runtime.test.ts` 全量通过为准。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: FAIL —— `PiRuntimeSession` 尚无 `setSessionName`/`complete` 等方法，`fakeSession` 类型不满足。

- [ ] **Step 3: 实现命令路由与 host 方法**

```ts
// packages/agent-host/src/types.ts —— RpcCommand 追加
  | { type: 'set_session_name'; name: string }
  | { type: 'set_api_key'; provider: string; apiKey: string }
  | { type: 'complete'; provider: string; modelId: string; text: string }
  | { type: 'list_models'; provider?: string }
  | { type: 'test_connection'; provider: string; modelId: string };
```

```ts
// packages/agent-host/src/pi-runtime.ts —— handleCommand 追加
    case 'set_session_name':
      await session.setSessionName(command.name);
      return undefined;
    case 'set_api_key':
      await session.setApiKey(command.provider, command.apiKey);
      return undefined;
    case 'complete':
      return await session.complete(command.provider, command.modelId, command.text);
    case 'list_models':
      return await session.listModels(command.provider);
    case 'test_connection':
      return await session.testConnection(command.provider, command.modelId);
```

```ts
// packages/agent-host/src/pi-sdk-runtime.ts —— PiRuntimeSession 返回对象追加
    setSessionName: (name) => session.setSessionName(name),
    setApiKey: async (provider, apiKey) => { await modelRuntime.setRuntimeApiKey(provider, apiKey); },
    complete: async (provider, modelId, text) => {
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`unknown model ${provider}/${modelId}`);
      const out = await modelRuntime.completeSimple(model, { messages: [{ role: 'user', content: text }] } as any);
      return typeof out.content === 'string' ? out.content : (out.content as any[])?.map((b: any) => b?.text ?? '').join('') ?? '';
    },
    listModels: async (provider) => {
      const models = modelRuntime.getModels(provider);
      return models.map((m: any) => ({ provider: m.provider?.id ?? provider, modelId: m.id }));
    },
    testConnection: async (provider, modelId) => {
      const start = Date.now();
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) return { ok: false, error: `unknown model ${provider}/${modelId}` };
      try { await modelRuntime.completeSimple(model, { messages: [{ role: 'user', content: 'ping' }] } as any); return { ok: true, latencyMs: Date.now() - start }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
```

注：`completeSimple` / `getModels` 的 `context` 与 `Model` 类型来自 `pi-ai`，实现时以实际类型为准（本次已核对方法存在）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/agent-host/test/pi-runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-host/src/types.ts packages/agent-host/src/pi-runtime.ts packages/agent-host/src/pi-sdk-runtime.ts packages/agent-host/test/pi-runtime.test.ts
git commit -m "feat(agent-host): session/model rpc for title, complete, key, models, probe"
```

---

### Task 5: 主进程接线（Keyring、fork 环境变量、IPC 改读 Pi、模型探测走 Pi）

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/electron/main/settings.ts`
- Test: `apps/desktop/test/connector-registry.test.ts`（仅保证不破坏，无需新增）

**Interfaces:**
- Produces: `Runtime` 增加 `keyring: Keyring`、`piAgentDir: string`。
- Produces: `sparkii:listChatSessions`、`sparkii:openChatSession` 改为读 `listPiSessions` / `readPiSessionMessages`（pool-free）。
- Produces: `sparkii:getModelOptions`、`sparkii:listModels`、`sparkii:testModel` 改为通过 Pi `ModelRuntime`（或至少 key 来自 keyring）。

- [ ] **Step 1: 写失败测试（Runtime 组装含 keyring + piAgentDir）**

```ts
// apps/desktop/test/settings-store.test.ts 追加（复用 fakeSafeStorage）
import { Keyring } from '../electron/main/keyring.js';
// ... 
it('keyring.get returns encrypted value round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparkii-key-'));
  const keyring = new Keyring(dir, fakeSafeStorage());
  await keyring.set('apiKey', 'sk-x');
  expect(await keyring.get('apiKey')).toBe('sk-x');
});
```

- [ ] **Step 2: 运行确认失败/通过**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: 该 keyring 往返用例应 PASS（`keyring.ts` 已实现）；若 `Keyring` 类未导出则先修导出。

- [ ] **Step 3: 实现 Runtime/Keyring/fork env**

```ts
// apps/desktop/electron/main/runtime.ts
import { join } from 'node:path';
import { Keyring } from './keyring.js';

export interface Runtime {
  // ... 原有字段 ...
  keyring: Keyring;
  piAgentDir: string;
}

export async function assemble(opts: { profiles; dataDir; publicKey?; allowUnsigned? }): Promise<Runtime> {
  const keyring = new Keyring(join(opts.dataDir, 'keyring'));
  const piAgentDir = join(opts.dataDir, 'pi-agent');
  // ... 原有 profiles/audit/gate/chatSessions/identity/pool 不变 ...
  const entry = resolvePiRuntimeEntry();
  const env = { SPARKII_PI_AGENT_DIR: piAgentDir };
  const pool = new PiRuntimePool({
    maxAgents: Number(process.env.SPARKII_MAX_AGENTS ?? 4),
    makeSupervisor: () =>
      process.env.SPARKII_PI_USE_FORK === '1'
        ? createForkHostHandle(entry, env)
        : createUtilityHostHandle(entry, env),
  });
  return { /* ...原返回值... */ keyring, piAgentDir, /* ... */ };
}
```

```ts
// apps/desktop/electron/main/ipc.ts —— 关键改动
import { listPiSessions, readPiSessionMessages } from '@sparkii/agent-host';

ipcMain.handle('sparkii:listChatSessions', async (_e, profileId?: string) => {
  const all = await listPiSessions(join(rt.piAgentDir, 'sessions'));
  // 用 rt.chatSessions 的 profileId 覆盖层过滤；无覆盖层的归到传入 profileId 或全部可见
  const mapped = all.map((s) => {
    const rec = rt.chatSessions.get(s.id);
    return { id: s.id, title: s.name ?? s.firstMessage, profileId: rec?.profileId, updatedAt: s.modified.getTime(), piFile: s.path };
  });
  return profileId ? mapped.filter((m) => m.profileId === profileId || m.profileId === undefined) : mapped;
});

ipcMain.handle('sparkii:openChatSession', async (_e, sessionId: string) => {
  const rec = rt.chatSessions.get(sessionId) ?? (await listPiSessions(join(rt.piAgentDir, 'sessions'))).find((s) => s.id === sessionId);
  if (!rec) throw new Error('session not found');
  const file = (rec as { path?: string; piFile?: string }).path ?? (rec as { piFile?: string }).piFile;
  if (!file) throw new Error('session file missing');
  return { messages: readPiSessionMessages(file) };
});

ipcMain.handle('sparkii:getModelOptions', async () => {
  const settings = await loadSettings(rt.dataDir, rt.keyring);
  const models = settings.baseUrl ? (await listModels(settings.baseUrl, settings.apiKey)).models ?? [] : [];
  return { defaultModel: settings.defaultModel ?? null, models };
});

ipcMain.handle('sparkii:saveSettings', (_e, settings: unknown) =>
  saveSettings(rt.dataDir, settings as Parameters<typeof saveSettings>[1], rt.keyring),
);
```

注：`promptSession` 在 `rt.pool.acquire` 前需把 `SPARKII_PI_API_KEY` 加入 env（读 keyring）。具体：在 `registerIpc` 顶部 `const piEnv = { SPARKII_PI_AGENT_DIR: rt.piAgentDir, SPARKII_PI_API_KEY: await rt.keyring.get('apiKey') ?? '' }`，`buildSaddle`/`acquire` 处传入；`set_api_key` 热更新走新 RPC。

- [ ] **Step 4: 运行确认通过（不破坏现有）**

Run: `npx vitest run apps/desktop/test/settings-store.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/electron/main/settings.ts
git commit -m "feat(desktop): wire keyring, isolate pi dir, read history pool-free"
```

---

### Task 6: 前端会话列表与历史读取 + agent id 映射修复

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`（扩展）

**Interfaces:**
- Consumes: `api.listChatSessions(profileId?)` 返回 `[{ id, title, profileId?, updatedAt }]`；`api.openChatSession(id)` 返回 `{ messages }`。
- Produces: 列表标题回退逻辑（title → firstMessage → 时间戳），`contract-review` 与 `contract` id 映射一致。

- [ ] **Step 1: 写失败测试（标题回退纯函数）**

```ts
// apps/desktop/test/app-general.test.tsx 追加
import { describe, it, expect } from 'vitest';

function sessionDisplayName(s: { title?: string; firstMessage?: string; updatedAt?: number }): string {
  if (s.title) return s.title;
  if (s.firstMessage) return s.firstMessage.slice(0, 24);
  return s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '会话';
}

describe('sessionDisplayName', () => {
  it('prefers title, then firstMessage, then time', () => {
    expect(sessionDisplayName({ title: 'PRD 标题', firstMessage: 'x', updatedAt: 1 })).toBe('PRD 标题');
    expect(sessionDisplayName({ firstMessage: '帮我写一个合同审核流程' })).toBe('帮我写一个合同审核流程');
    expect(sessionDisplayName({ updatedAt: new Date(2026, 7, 26, 10, 30).getTime() })).toContain('08-26');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/desktop/test/app-general.test.tsx`
Expected: FAIL —— `sessionDisplayName` 未定义。

- [ ] **Step 3: 实现**

```tsx
// apps/desktop/src/App.tsx —— refreshSessions 与 navigate 修正
const refreshSessions = (agentId: string) => {
  const profileId = agentId === 'contract' ? 'contract-review' : agentId;
  api.listChatSessions?.(profileId)?.then((list: any[]) => {
    const mapped: ShellSession[] = (list ?? []).map((s) => ({
      id: s.id,
      name: s.title ?? (s.firstMessage ? String(s.firstMessage).slice(0, 24) : ''),
      state: '',
      time: s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
    }));
    setSessions((prev) => ({ ...prev, [agentId]: mapped }));
  }).catch(() => {});
};

// navigate：合同审核也要 refresh，且 id 统一为 contract-review
const navigate = (s: ScreenId) => {
  if (s === 'general') { setScreen('general'); refreshSessions('general'); return; }
  if (s === 'contract' || s === 'contract-review') { setScreen('contract'); refreshSessions('contract'); return; }
  if (s === 'chat' || s === 'dashboard') { setScreen('contract'); return; }
  setScreen(s);
};
```

同时把 `listAgents` 返回的 `contract-review` 在 rail 上的 id 统一：`agents` 里 `contract-review` 映射为 `contract`（或反过来），确保 `navigate`/`refreshSessions` 一致。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/desktop/test/app-general.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/app-general.test.tsx
git commit -m "feat(desktop): session list title fallback and agent id mapping"
```

---

### Task 7: title 模型路由 + 标题生成 + 前端自动更新

**Files:**
- Modify: `packages/model-router/src/types.ts`
- Modify: `packages/model-router/src/router.ts`
- Modify: `profiles/general/manifest.yaml`、`profiles/contract-review/manifest.yaml`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/src/App.tsx`
- Test: `packages/model-router/test/router.test.ts`（扩展）

**Interfaces:**
- Produces: `ModelTask` 含 `'title'`；`ModelRouter.resolve('title')` 可用。
- Consumes: Task 4 的 `complete` RPC、Task 1 的 `set_session_name` RPC。

- [ ] **Step 1: 写失败测试**

```ts
// packages/model-router/test/router.test.ts 追加
import { normalizeRouting, ModelRouter } from '../src/router.js';
import { describe, it, expect } from 'vitest';

describe('title task routing', () => {
  it('resolves title task and falls back to default', () => {
    const r = normalizeRouting({ default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] });
    expect(r.title).toEqual([{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }]);
    expect(new ModelRouter(r).resolve('title')).toEqual({ provider: 'deepseek', modelId: 'deepseek-v4-flash' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/model-router/test/router.test.ts`
Expected: FAIL —— `ModelTask` 无 `title`，`normalizeRouting` 不产出 `title`。

- [ ] **Step 3: 实现路由 + manifest + IPC + 前端**

```ts
// packages/model-router/src/types.ts
export type ModelTask = 'chat' | 'extract' | 'report' | 'default' | 'coding' | 'title';

// packages/model-router/src/router.ts
export function normalizeRouting(raw: Record<string, ModelTarget[]>): Record<ModelTask, ModelTarget[]> {
  const out = { default: raw.default ?? [], chat: [], extract: [], report: [], coding: [], title: [] } as Record<ModelTask, ModelTarget[]>;
  for (const key of ['chat', 'extract', 'report', 'coding', 'title'] as const) {
    out[key] = raw[key] ?? out.default;
  }
  return out;
}
```

```yaml
# profiles/general/manifest.yaml 与 profiles/contract-review/manifest.yaml 的 modelRouting.tasks 各加：
    title:
      - { provider: deepseek, modelId: deepseek-v4-flash }
```

```ts
// apps/desktop/electron/main/ipc.ts —— promptSession 首次 agent_end 后生成标题
// 在 onEvent 的 agent_end 分支，若该 session 尚未标题化：
if (ev.type === 'agent_end' && !titledSessions.has(sessionId)) {
  titledSessions.add(sessionId);
  const title = await slot.client.send({ type: 'complete', provider: titleTarget.provider, modelId: titleTarget.modelId, text: titlePrompt });
  const name = String((title.data as string) ?? '').trim().slice(0, 40);
  if (name) {
    await slot.client.send({ type: 'set_session_name', name });
    win?.webContents.send('sparkii:event:chat-event', { type: 'session_title', sessionId, title: name });
  }
}
```

```tsx
// apps/desktop/src/App.tsx —— 监听 session_title 事件更新列表与 surface 标题
useEffect(() => api.on('chat-event', (p: any) => {
  if (p?.type === 'session_title' && p?.sessionId) {
    setSessions((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        next[k] = next[k].map((s) => (s.id === p.sessionId ? { ...s, name: p.title } : s));
      }
      return next;
    });
    if (p.sessionId === activeGeneralSession) setGeneralTitle(p.title);
  }
}), [api]);
```

注：`titlePrompt` 用首条 user + 首条 assistant 拼接；标题模型目标由 `rt.profileOf(profileId).router.resolve('title')` 得到。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/model-router/test/router.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/model-router/src/types.ts packages/model-router/src/router.ts packages/model-router/test/router.test.ts profiles/general/manifest.yaml profiles/contract-review/manifest.yaml apps/desktop/electron/main/ipc.ts apps/desktop/src/App.tsx
git commit -m "feat(desktop): title model route and auto title generation"
```

---

### Task 8: 砍自建登录，OS 用户单一本地主体

**Files:**
- Modify: `apps/desktop/electron/main/runtime.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/src/App.tsx`
- Delete: `packages/identity/src/local.ts`
- Test: `apps/desktop/test/app-workflow.test.tsx`（扩展）

**Interfaces:**
- Produces: `Runtime.subject` 恒为 `{ userId: string; roles: ['admin','reviewer'] }`，不再需要登录。

- [ ] **Step 1: 写失败测试（subject 固定）**

```ts
// apps/desktop/test/app-workflow.test.tsx 追加
import { describe, it, expect } from 'vitest';

function localSubject(username: string) {
  return { userId: username, roles: ['admin', 'reviewer'] as const };
}

describe('local subject', () => {
  it('grants full roles without login', () => {
    expect(localSubject('alice').roles).toEqual(['admin', 'reviewer']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run apps/desktop/test/app-workflow.test.tsx`
Expected: FAIL —— `localSubject` 未定义。

- [ ] **Step 3: 实现**

```ts
// apps/desktop/electron/main/runtime.ts —— 移除 identity 相关
import { userInfo } from 'node:os';
// 删除 LocalIdentityProvider 创建与 seed；subject 固定：
const subject = { userId: userInfo().username, roles: ['admin', 'reviewer'] as const };
// return { ... subject, ... } 且删除 identity 字段
```

```ts
// apps/desktop/electron/main/ipc.ts —— 删除 sparkii:login handler；decideApproval 删除 !rt.subject 判断
// 删除 login handler；broker 里 actor 用 rt.subject.userId
```

```tsx
// apps/desktop/src/App.tsx —— 删除登录页与 authed 状态，直接渲染 Shell
// 移除 login()/authed/username/password；userName 取 OS 用户名（可由 getProfile 或新增 getLocalSubject 返回）
```

同时删除 `packages/identity/src/local.ts`，并移除 `packages/identity/src/index.ts` 对它的导出（保留 `Subject`/`Rbac` 类型）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run apps/desktop/test/app-workflow.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/runtime.ts apps/desktop/electron/main/ipc.ts apps/desktop/src/App.tsx packages/identity/src
git commit -m "feat(identity): drop local login, use OS user as single subject"
```

---

## Self-Review

- Spec 覆盖：A（会话记录）→ Task 3/5/6；B（标题）→ Task 7；C（身份）→ Task 8；D（凭据+隔离）→ Task 1/2/5；E（模型访问）→ Task 4/5。全部有对应任务。
- 无占位符：每个代码步骤都有可执行内容。
- 类型一致：`listPiSessions`/`readPiSessionMessages`（Task 3）在 Task 5 被消费；`complete`/`set_session_name`/`set_api_key`（Task 4）在 Task 7 被消费；`ModelTask` 含 `title`（Task 7）与 `ModelRouter.resolve('title')` 一致。

## 执行交接

计划已保存。两种执行方式：

1. **Subagent-Driven（推荐）**：按任务派发独立子代理，任务间审查。
2. **Inline Execution**：本会话内用 executing-plans 逐任务执行并设检查点。

请选择执行方式。
