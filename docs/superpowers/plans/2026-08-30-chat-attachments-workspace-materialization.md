# 聊天附件工作区物化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让通用智能体聊天附件真正进入模型上下文：发送时把附件物化到会话 workspace 的 `.sparkii-attachments/` 目录，再把 workspace-relative 引用拼进发给 Pi 的 message，由 Pi 原生 `read`/`bash` 工具读取。

**Architecture:** renderer 只传附件元数据（`path/name/size/type`）到 main；main 进程负责物化（懒创建 workspace、同名避让、copyFile）并拼接最终 message；Pi 侧不加 `images` 字段、不写任何解析/缩放逻辑——图片由 `read` 工具原生缩放（`autoResizeImages` 默认 true），文本由 `read` 读取，二进制文档由 `bash` 处理。

**Tech Stack:** TypeScript（strict，ESM，import 相对路径带 `.js` 后缀）、Node ≥ 22、pnpm workspaces、vitest、Electron main/preload、`@sparkii/agent-host`。

**Spec:** [2026-08-30-chat-attachments-workspace-materialization.md](../specs/2026-08-30-chat-attachments-workspace-materialization.md)（本计划从 spec 论证，执行者必须同时阅读）

## Global Constraints

- ESM + strict TS：新文件遵循 `"type": "module"` 语义，import 相对路径带 `.js` 后缀；main/preload 沿用分号风格。
- 测试：`pnpm exec vitest run <file>`；单测不得依赖真实 LLM 与真实 Electron 窗口；fs 测试使用 `mkdtemp` 临时目录并在 `afterEach` 清理。
- 无附件时，`promptSession` / `promptDraftSession` 的**调用参数个数必须与现状完全一致**，保证现有测试（`toHaveBeenCalledWith`）不回归。
- 用户文本必须位于最终 message 末尾（renderer 回显抑制用 `endsWith` 匹配）。
- 附件目录名固定 `.sparkii-attachments`，ref 使用正斜杠分隔。
- 不新增运行时依赖；不改 `workspace-guard`、审批模型、Pi 运行时。
- 用户可见文案用中文；内部标识沿用现有命名。

---

## File Structure

- 新增：`apps/desktop/electron/main/attachments.ts`——物化与 message 拼接纯函数模块。
- 修改：`apps/desktop/electron/preload/api-types.ts`——新增 `ChatAttachment`；`SparkiiApi` 的 `promptSession`/`promptDraftSession` 增加可选 `attachments` 参数。
- 修改：`apps/desktop/electron/preload/api.ts`——透传 `attachments`。
- 修改：`apps/desktop/electron/main/ipc.ts`——`promptSession`/`promptDraftSession` 接收附件、物化、拼接 message。
- 修改：`apps/desktop/src/types/sparkii-api.ts`——re-export `ChatAttachment`。
- 修改：`apps/desktop/src/surfaces/GeneralChatSurface.tsx`——`send()` 传附件、回显抑制改为 `endsWith`。
- 测试：新增 `apps/desktop/test/attachments.test.ts`；修改 `apps/desktop/test/ipc.test.ts`、`apps/desktop/test/general-chat-surface.test.tsx`。

---

### Task 1: 附件物化模块

**Files:**
- Create: `apps/desktop/electron/main/attachments.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Test: `apps/desktop/test/attachments.test.ts`

**Interfaces:**
- Consumes: `isPathInside`（来自 `./workspace.js` re-export 的 `@sparkii/agent-host`）；`ChatAttachment`（本任务在 `api-types.ts` 新增）。
- Produces: `ATTACHMENTS_DIR`（`'.sparkii-attachments'`）、`StagedAttachment`、`stageAttachments(workspacePath, attachments)`、`buildAttachmentPrompt(text, refs)`。

- [ ] **Step 1: 写失败测试**

新增 `apps/desktop/test/attachments.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENTS_DIR, buildAttachmentPrompt, stageAttachments } from '../electron/main/attachments.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tmp(name: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), name));
  dirs.push(d);
  return d;
}

describe('stageAttachments', () => {
  it('does not create the workspace when there are no attachments', async () => {
    const ws = join(await tmp('ws-'), 'missing');
    const out = await stageAttachments(ws, []);
    expect(out).toEqual([]);
    expect(existsSync(ws)).toBe(false);
  });

  it('copies an external file into the attachments dir with a relative ref', async () => {
    const src = join(await tmp('src-'), 'report.pdf');
    await writeFile(src, 'pdf-bytes');
    const ws = join(await tmp('ws-'), 'workspace');
    const out = await stageAttachments(ws, [{ path: src, name: 'report.pdf' }]);
    expect(out).toHaveLength(1);
    expect(out[0].ref).toBe(`${ATTACHMENTS_DIR}/report.pdf`);
    expect(await readFile(out[0].absolutePath, 'utf8')).toBe('pdf-bytes');
  });

  it('deduplicates same-named attachments with a -N suffix', async () => {
    const src1 = join(await tmp('src1-'), 'a.txt');
    const src2 = join(await tmp('src2-'), 'a.txt');
    await writeFile(src1, 'one');
    await writeFile(src2, 'two');
    const ws = join(await tmp('ws-'), 'workspace');
    const out = await stageAttachments(ws, [
      { path: src1, name: 'a.txt' },
      { path: src2, name: 'a.txt' },
    ]);
    expect(out.map((r) => r.ref)).toEqual([
      `${ATTACHMENTS_DIR}/a.txt`,
      `${ATTACHMENTS_DIR}/a-1.txt`,
    ]);
    expect(await readFile(out[1].absolutePath, 'utf8')).toBe('two');
  });

  it('references an in-workspace file without copying', async () => {
    const ws = join(await tmp('ws-'), 'workspace');
    await mkdir(ws, { recursive: true });
    const target = join(ws, 'notes.md');
    await writeFile(target, 'inside');
    const out = await stageAttachments(ws, [{ path: target, name: 'notes.md' }]);
    expect(out[0].ref).toBe('notes.md');
    expect(out[0].absolutePath).toBe(target);
    expect(existsSync(join(ws, ATTACHMENTS_DIR, 'notes.md'))).toBe(false);
  });

  it('throws when the source file is missing', async () => {
    const ws = join(await tmp('ws-'), 'workspace');
    await expect(stageAttachments(ws, [{ path: join(ws, 'nope.pdf'), name: 'nope.pdf' }]))
      .rejects.toThrow();
  });
});

describe('buildAttachmentPrompt', () => {
  it('returns text unchanged when there are no refs', () => {
    expect(buildAttachmentPrompt('hi', [])).toBe('hi');
  });

  it('puts the reference block first and keeps user text last', () => {
    const out = buildAttachmentPrompt('回答我', [
      { ref: `${ATTACHMENTS_DIR}/a.pdf`, absolutePath: '/ws/.sparkii-attachments/a.pdf' },
    ]);
    expect(out).toContain(`- ${ATTACHMENTS_DIR}/a.pdf`);
    expect(out.endsWith('回答我')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/attachments.test.ts`
Expected: FAIL——`../electron/main/attachments.js` 不存在，无法导入。

- [ ] **Step 3: 实现**

先改 `apps/desktop/electron/preload/api-types.ts`，在 `DraftPromptContext` 之后新增：

```ts
export interface ChatAttachment {
  path: string;
  name: string;
  size?: number;
  type?: string;
}
```

再新增 `apps/desktop/electron/main/attachments.ts`：

```ts
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { isPathInside } from './workspace.js';
import type { ChatAttachment } from '../preload/api-types.js';

export const ATTACHMENTS_DIR = '.sparkii-attachments';

export interface StagedAttachment {
  ref: string;
  absolutePath: string;
}

function splitName(name: string): { stem: string; ext: string } {
  const ext = extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

function resolveUniqueName(dir: string, name: string): string {
  const { stem, ext } = splitName(name);
  let candidate = name;
  for (let i = 1; existsSync(join(dir, candidate)); i += 1) {
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
}

export async function stageAttachments(
  workspacePath: string,
  attachments: ChatAttachment[],
): Promise<StagedAttachment[]> {
  if (attachments.length === 0) return [];
  await mkdir(workspacePath, { recursive: true });
  const dir = join(workspacePath, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  const out: StagedAttachment[] = [];
  for (const att of attachments) {
    const inside = att.path
      && isPathInside(workspacePath, att.path)
      && existsSync(att.path);
    if (inside) {
      out.push({
        ref: relative(workspacePath, att.path).replaceAll('\\', '/'),
        absolutePath: att.path,
      });
      continue;
    }
    const finalName = resolveUniqueName(dir, att.name);
    const finalPath = join(dir, finalName);
    await copyFile(att.path, finalPath);
    out.push({
      ref: relative(workspacePath, finalPath).replaceAll('\\', '/'),
      absolutePath: finalPath,
    });
  }
  return out;
}

export function buildAttachmentPrompt(text: string, refs: StagedAttachment[]): string {
  if (refs.length === 0) return text;
  const list = refs.map((r) => `- ${r.ref}`).join('\n');
  return [
    '以下是本条消息附带的文件，已放置到会话工作区（相对工作区路径）：',
    list,
    '',
    '请使用 read 工具读取需要的文本或代码内容；图片会作为图像输入；PDF、Word 等二进制文档请用 bash 配合本机可用工具解析。',
    '',
    text,
  ].join('\n');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/attachments.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/attachments.ts apps/desktop/electron/preload/api-types.ts apps/desktop/test/attachments.test.ts
git commit -m "feat(attachments): stage chat attachments into session workspace"
```

---

### Task 2: IPC 与 preload 接线

**Files:**
- Modify: `apps/desktop/electron/preload/api-types.ts`
- Modify: `apps/desktop/electron/preload/api.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`
- Test: `apps/desktop/test/ipc.test.ts`

**Interfaces:**
- Consumes: `ChatAttachment`、`stageAttachments`、`buildAttachmentPrompt`（Task 1）。
- Produces: `SparkiiApi.promptSession(sessionId, text, options?, attachments?)`、`SparkiiApi.promptDraftSession(profileId, text, context, attachments?)`；IPC handler 同样接受第 4 参 `attachments`。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/test/ipc.test.ts` 的 `describe('ipc provider handlers', ...)` 内追加两个用例（文件顶部已 import `mkdtemp/mkdir/writeFile/readFile/rm/tmpdir/join`）：

```ts
it('promptSession stages attachments into the session workspace before prompting', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

  const ws = await mkdtemp(join(tmpdir(), 'ipc-ws-'));
  dirs.push(ws);
  const srcDir = await mkdtemp(join(tmpdir(), 'ipc-src-'));
  dirs.push(srcDir);
  const src = join(srcDir, 'report.txt');
  await writeFile(src, 'hello attachment');

  const sent: any[] = [];
  const client = {
    onEvent: vi.fn(() => () => {}),
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'get_state') return { success: true, data: { isStreaming: false, sessionFile: null } };
      return { success: true };
    },
  };
  const rt = await makeRuntime({
    dataDir,
    piAgentDir,
    client,
    chatSession: { profileId: 'general', model: null },
  });
  (rt as any).chatSessions.get = () => ({ profileId: 'general', model: null, workspacePath: ws });

  const handlers = await registeredHandlers();
  const promptSession = handlers.get('sparkii:promptSession');
  await promptSession!(null, 's1', '请看附件', undefined, [{ path: src, name: 'report.txt' }]);

  const promptCmd = sent.find((c) => c.type === 'prompt');
  expect(promptCmd).toBeDefined();
  expect(promptCmd.message).toContain('.sparkii-attachments/report.txt');
  expect(promptCmd.message.endsWith('请看附件')).toBe(true);
  expect(await readFile(join(ws, '.sparkii-attachments', 'report.txt'), 'utf8')).toBe('hello attachment');
});

it('promptDraftSession stages attachments into the chosen workspace', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-data-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({}), 'utf8');

  const ws = await mkdtemp(join(tmpdir(), 'ipc-ws-'));
  dirs.push(ws);
  const srcDir = await mkdtemp(join(tmpdir(), 'ipc-src-'));
  dirs.push(srcDir);
  const src = join(srcDir, 'draft.txt');
  await writeFile(src, 'draft bytes');

  const sent: any[] = [];
  const client = {
    onEvent: vi.fn(() => () => {}),
    send: async (command: any) => {
      sent.push(command);
      if (command.type === 'get_state') return { success: true, data: { sessionId: 's-new', sessionFile: null } };
      return { success: true };
    },
  };
  const rt = await makeRuntime({ dataDir, piAgentDir, client });
  (rt as any).chatSessions.create = vi.fn();

  const handlers = await registeredHandlers();
  const promptDraftSession = handlers.get('sparkii:promptDraftSession');
  await promptDraftSession!(null, 'general', '看附件', { workspacePath: ws }, [{ path: src, name: 'draft.txt' }]);

  const promptCmd = sent.find((c) => c.type === 'prompt');
  expect(promptCmd.message).toContain('.sparkii-attachments/draft.txt');
  expect(promptCmd.message.endsWith('看附件')).toBe(true);
  expect(await readFile(join(ws, '.sparkii-attachments', 'draft.txt'), 'utf8')).toBe('draft bytes');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ipc.test.ts`
Expected: 新增两个用例 FAIL——`prompt` 命令的 message 不含 `.sparkii-attachments/...`，且附件未被复制。

- [ ] **Step 3: 实现**

改 `apps/desktop/electron/preload/api-types.ts`，把 `SparkiiApi` 的两个签名改为：

```ts
promptDraftSession(profileId: string, text: string, context: DraftPromptContext, attachments?: ChatAttachment[]): Promise<{ ok: boolean; sessionId: string; behavior: 'prompt' | 'steer' | 'followUp' }>;
promptSession(sessionId: string, text: string, options?: { behavior?: 'steer' | 'followUp' }, attachments?: ChatAttachment[]): Promise<{ ok: boolean; behavior?: 'prompt' | 'steer' | 'followUp' }>;
```

改 `apps/desktop/electron/preload/api.ts`：

```ts
promptDraftSession: (profileId, text, context, attachments) => invoke('promptDraftSession', profileId, text, context, attachments) as Promise<{ ok: boolean; sessionId: string; behavior: 'prompt' | 'steer' | 'followUp' }>,
promptSession: (sessionId, text, options, attachments) => invoke('promptSession', sessionId, text, options, attachments) as Promise<{ ok: boolean; behavior?: 'prompt' | 'steer' | 'followUp' }>,
```

改 `apps/desktop/electron/main/ipc.ts`：

1. 顶部 import 增加：

```ts
import { buildAttachmentPrompt, stageAttachments } from './attachments.js';
import type { ChatAttachment } from '../preload/api-types.js';
```

2. `sparkii:promptDraftSession` handler 签名改为 `attachments: ChatAttachment[] = []`，并在发送前替换 message。把：

```ts
const promptResp = await slot.client.send({ type: 'prompt', message: text });
```

改为：

```ts
const staged = await stageAttachments(workspacePath, attachments ?? []);
const promptResp = await slot.client.send({ type: 'prompt', message: buildAttachmentPrompt(text, staged) });
```

3. `sparkii:promptSession` handler 签名改为 `attachments: ChatAttachment[] = []`，在 `const rec = rt.chatSessions.get(sessionId);` 之后计算最终 message。在 behavior 分支前插入：

```ts
const workspacePath = rec?.workspacePath;
if (attachments?.length && !workspacePath) {
  throw new Error('会话缺少工作区，无法放置附件');
}
const staged = workspacePath ? await stageAttachments(workspacePath, attachments ?? []) : [];
const finalText = buildAttachmentPrompt(text, staged);
```

并把三个 send 分支的 `message: text` 改为 `message: finalText`：

```ts
if (behavior === 'steer') {
  const resp = await open.slot.client.send({ type: 'steer', message: finalText });
} else if (behavior === 'followUp') {
  const resp = await open.slot.client.send({ type: 'follow_up', message: finalText });
} else {
  const resp = await open.slot.client.send({ type: 'prompt', message: finalText });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ipc.test.ts`
Expected: 全量 PASS（含新增两个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/preload/api-types.ts apps/desktop/electron/preload/api.ts apps/desktop/electron/main/ipc.ts apps/desktop/test/ipc.test.ts
git commit -m "feat(attachments): wire attachment staging through prompt IPC"
```

---

### Task 3: renderer 发送附件与回显抑制

**Files:**
- Modify: `apps/desktop/src/types/sparkii-api.ts`
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: `apps/desktop/test/general-chat-surface.test.tsx`

**Interfaces:**
- Consumes: `ChatAttachment`（Task 1）、`SparkiiApi.promptSession/promptDraftSession` 的第 4 参（Task 2）。
- Produces: renderer `send(text, attachments)` 把 `ComposerAttachment[]` 映射为 `ChatAttachment[]` 传递；无附件时调用签名不变。

- [ ] **Step 1: 写失败测试**

改 `apps/desktop/test/general-chat-surface.test.tsx` 的 `makeApi`，增加：

```ts
getPathForFile: vi.fn((file: File) => `C:/downloads/${file.name}`),
```

并在 `describe('GeneralChatSurface', ...)` 内追加：

```ts
it('passes attachments to promptSession when files are selected', async () => {
  const { api } = makeApi();
  const { container } = render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
  await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('s1'));

  const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '分析这个' } });
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });

  await waitFor(() => expect(api.promptSession).toHaveBeenCalled());
  expect(api.promptSession).toHaveBeenCalledWith(
    's1',
    '分析这个',
    undefined,
    [{ path: 'C:/downloads/report.pdf', name: 'report.pdf', size: 6, type: 'application/pdf' }],
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/general-chat-surface.test.tsx`
Expected: 新增用例 FAIL——`promptSession` 只收到 `('s1', '分析这个')`，缺少第 4 参。

- [ ] **Step 3: 实现**

改 `apps/desktop/src/types/sparkii-api.ts`：

```ts
export type { ChatAttachment, SparkiiApi } from '../../electron/preload/api-types.js';
```

改 `apps/desktop/src/surfaces/GeneralChatSurface.tsx`：

1. 顶部 import 改为：

```ts
import type { ChatAttachment, SparkiiApi } from '../types/sparkii-api.js';
```

2. 把 `send` 替换为：

```ts
const send = (text: string, attachments: ComposerAttachment[] = []) => {
  const display = attachments.length ? `${attachments.map((a) => `📎 ${a.name}`).join(' ')}\n${text}` : text;
  const chatAttachments: ChatAttachment[] = attachments.map(({ path, name, size, type }) => ({ path, name, size, type }));
  setError('');
  if (!sessionId && draft) {
    if (busy) return;
    setBusy(true);
    api.promptDraftSession(
      'general',
      text,
      { workspacePath, model, thinkingLevel },
      chatAttachments.length ? chatAttachments : undefined,
    ).then((res) => {
      if (res?.sessionId) onSessionCommitted?.(res.sessionId, text);
    }).catch((e: any) => {
      setError(String(e?.message ?? e));
      setBusy(false);
    });
    return;
  }
  if (!sessionId) return;
  if (busy) {
    if (chatAttachments.length) {
      api.promptSession(sessionId, text, { behavior: 'followUp' }, chatAttachments)
        .catch((e: any) => setError(String(e?.message ?? e)));
    } else {
      api.promptSession(sessionId, text, { behavior: 'followUp' })
        .catch((e: any) => setError(String(e?.message ?? e)));
    }
    return;
  }
  lastIdlePromptRef.current = text;
  suppressUserEventRef.current = true;
  setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text: display, streaming: false }]);
  setBusy(true);
  if (chatAttachments.length) {
    api.promptSession(sessionId, text, undefined, chatAttachments)
      .catch((e: any) => {
        setError(String(e?.message ?? e));
        setBusy(false);
      });
  } else {
    api.promptSession(sessionId, text)
      .catch((e: any) => {
        setError(String(e?.message ?? e));
        setBusy(false);
      });
  }
};
```

3. 把回显抑制条件改为 `endsWith`（原为 `===`）：

```ts
if (suppressUserEventRef.current && lastIdlePromptRef.current && text.endsWith(lastIdlePromptRef.current)) {
  suppressUserEventRef.current = false;
  return;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/general-chat-surface.test.tsx apps/desktop/test/app-general.test.tsx`
Expected: 全量 PASS；`app-general` 的 `promptDraftSession('general', '你好', expect.any(Object))` 与 `general-chat-surface` 的 `promptSession('s1', '请创建 hello.txt')` 无附件断言保持通过。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/types/sparkii-api.ts apps/desktop/src/surfaces/GeneralChatSurface.tsx apps/desktop/test/general-chat-surface.test.tsx
git commit -m "feat(attachments): pass chat attachments from renderer and suppress prefixed echo"
```

---

## Self-Review

**Spec coverage:** 物化（Task 1）、命名避让（Task 1）、message 拼接（Task 1）、IPC 接线（Task 2）、renderer 传参与回显抑制（Task 3）、失败抛错（Task 1/2）、懒创建（Task 1/2）。全部有对应任务。

**Placeholder scan:** 无 TBD/TODO；所有步骤含具体代码。

**Type consistency:** `ChatAttachment`（Task 1 定义）在 Task 2/3 复用；`StagedAttachment`、`stageAttachments`、`buildAttachmentPrompt`、`ATTACHMENTS_DIR` 命名跨任务一致；`promptSession`/`promptDraftSession` 第 4 参类型统一为 `ChatAttachment[]`。
