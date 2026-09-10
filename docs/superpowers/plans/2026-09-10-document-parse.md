# 平台文档解析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有声明了 `document.read` 的智能体能读扫描 PDF、照片和空/乱码 PDF；电子件仍走文字层；扫描走本机 PP-StructureV3；运行中心增加「文档解析」一块；设置可配空闲释放/常驻与按需模块。

**Architecture:** `executeDocumentRead` 是唯一执行器，同时接到聊天 `handleConnectorRead` 和合同 `runTool`。电子件与 PDF 文字层探测在 Main。Structure 由 Main `spawn` 全应用一个解析进程，stdin/stdout NDJSON，不是 Pi 的 `postMessage`。独立 `DocumentParseSnapshot` 事件，禁止写入智能体 `slots`。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron IPC、`child_process.spawn`、Windows CPU PaddleOCR 3.7 PP-StructureV3（解析进程内）。

**Spec:** `docs/superpowers/specs/2026-09-10-document-parse-design.md`（v3）

## Architect corrections (spec v2)

实施必须遵守规格 Architect corrections 与决策 14–16：两条 Main 入口同一提交才改 `host`；NDJSON 而非 Pi 信封；独立快照；Windows 杀进程树；`before-quit` 有 quitting 守卫；合同照片入口；`saveSettings` 锁 `documentParse`；`getDocumentParseSupervisor()` 单例。

## Global Constraints

- 用户可见文案只用：运行中心、智能体、文档解析、未启动、正在加载、正在解析、空闲、常驻、释放、停止解析、取消加载、重新加载、识别质量、电子文本、基础解析、印章、公式、图表、导入离线包、等待中的文件。禁止 worker / sidecar / OCR 引擎 / OC2 / Paddle / JSON-RPC / Python / 模型文件名。
- 智能体按钮保持「停止」「释放线程」。文档解析用「停止解析」「释放」。
- 底栏 `active/maxAgents` 只计智能体。解析进行中只追加 ` · 文档解析进行中`。
- 禁止 `if (agent.id === 'contract-review' | 'knowledge-qa' | 'general')` 决定是否解析或是否显示质量。
- `document.read` 失败不得返回空 `text`。
- 一期 `data` 只有 `{ text, kind, engine, meta }`，不含 `blocks`/`tables`。
- 解析进程 stdout 只走 NDJSON。Windows 杀进程树。`child.kill()` 不够。
- `sparkii:saveSettings` 必须保留 `documentParse: prev.documentParse`（与 `rag` 相同）。
- 混合 PDF 不做按页双引擎。
- 真实 Paddle 测试默认 skip：`describe.skipIf(!process.env.SPARKII_DOCUMENT_PARSE_E2E)`。
- 提交信息用 feat/fix/test 前缀；本计划的 commit 步骤仅在用户要求提交时由执行者执行。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| 路由 / 质量等级 / ParsedDocument | `packages/connectors` | Electron |
| `executeDocumentRead` | `apps/desktop/electron/main/document-read.ts` | Pi、Renderer |
| 解析进程监督 | `apps/desktop/electron/main/document-parse-*.ts` | `packages/agent-host` 进程池 |
| NDJSON 解析程序 | `packages/document-parse` | Pi utilityProcess |
| 运行中心第二块 | `packages/ui` RuntimeCenter / StatusBar | 新窗口 |
| 设置 | `SettingsDocumentParsePane` + `saveDocumentParseSettings` | 塞进「智能体与运行」当主配置 |
| 合同照片 | `document-bytes.ts` + 合同 surface / DocumentPreview | 按 agent.id 分支质量条 |

## File Structure

```text
packages/connectors/src/document/types.ts
packages/connectors/src/document/route.ts
packages/connectors/src/document/quality.ts
packages/connectors/src/document/native-markdown.ts
packages/connectors/src/document/index.ts
packages/connectors/test/document-route.test.ts
packages/connectors/test/document-quality.test.ts
packages/connectors/test/document-host.test.ts
packages/document-parse/sparkii_document_parse/__main__.py
packages/document-parse/README.md
packages/ui/src/patterns/RuntimeCenter.tsx
packages/ui/src/patterns/StatusBar.tsx
packages/ui/src/patterns/RecognitionQuality.tsx
packages/ui/src/patterns/chat-detail-level.ts
packages/ui/src/patterns/Shell.tsx
apps/desktop/electron/main/document-read.ts
apps/desktop/electron/main/document-parse-layout.ts
apps/desktop/electron/main/document-parse-rpc.ts
apps/desktop/electron/main/document-parse-kill.ts
apps/desktop/electron/main/document-parse-supervisor.ts
apps/desktop/electron/main/document-parse-settings.ts
apps/desktop/electron/main/document-parse-modules.ts
apps/desktop/electron/main/settings.ts
apps/desktop/electron/main/ipc.ts
apps/desktop/electron/main/workflow.ts
apps/desktop/electron/main/index.ts
apps/desktop/electron/main/document-bytes.ts
apps/desktop/electron/preload/api-types.ts
apps/desktop/electron/preload/api.ts
apps/desktop/src/shell/SettingsView.tsx
apps/desktop/src/shell/SettingsDocumentParsePane.tsx
apps/desktop/src/App.tsx
apps/desktop/agents/contract-review/surface/index.tsx
apps/desktop/agents/contract-review/surface/DocumentPreview.tsx
apps/desktop/runtime/document-parse/modules.json
apps/desktop/runtime/document-parse/checksums.json
apps/desktop/scripts/ensure-document-parse.mjs
apps/desktop/build/installer.nsh
apps/desktop/electron-builder.yml
```

建议自检：

```text
pnpm exec vitest run packages/connectors/test/document-route.test.ts packages/connectors/test/document-quality.test.ts packages/connectors/test/document-host.test.ts
pnpm exec vitest run apps/desktop/test/document-parse-rpc.test.ts apps/desktop/test/document-parse-supervisor.test.ts apps/desktop/test/document-read.test.ts
pnpm exec vitest run apps/desktop/test/ui-shell-patterns.test.tsx apps/desktop/test/recognition-quality.test.tsx apps/desktop/test/chat-detail-level.test.ts
pnpm exec vitest run apps/desktop/test/settings-document-parse.test.tsx apps/desktop/test/ipc.test.ts apps/desktop/test/contract-surface.test.tsx
```

---

### Task 1: 路由、质量等级、契约类型

**Files:**
- Create: `packages/connectors/src/document/types.ts`
- Create: `packages/connectors/src/document/route.ts`
- Create: `packages/connectors/src/document/quality.ts`
- Create: `packages/connectors/test/document-route.test.ts`
- Create: `packages/connectors/test/document-quality.test.ts`
- Create: `packages/connectors/test/document-host.test.ts`
- Modify: `packages/connectors/src/document/index.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces: `ParsedDocument`、`shouldUseStructure`、`recognitionLevel`、`averageQuality`。**本任务不得设置 `host: 'main'`**（Pi 会立刻把工具打到尚未放行的 `handleConnectorRead`）。handler 保持现有电子件解析。

- [ ] **Step 1: Write failing tests**

```ts
// packages/connectors/test/document-route.test.ts
import { describe, it, expect } from 'vitest';
import { shouldUseStructure } from '../src/document/route.js';

describe('shouldUseStructure', () => {
  it('never uses structure for office and text', () => {
    for (const ext of ['.txt', '.md', '.csv', '.docx', '.xlsx']) {
      expect(shouldUseStructure({ ext, textLayer: '', pageCount: 1 })).toBe(false);
    }
  });
  it('always uses structure for photos', () => {
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      expect(shouldUseStructure({ ext, textLayer: '', pageCount: 1 })).toBe(true);
    }
  });
  it('routes empty or short or garbled pdfs to structure', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: null, pageCount: 3 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: 'a'.repeat(49 * 2), pageCount: 2 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '\uFFFD'.repeat(40) + 'ok'.repeat(10), pageCount: 1 })).toBe(true);
  });
  it('keeps a dense electronic pdf native', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '合同条款'.repeat(80), pageCount: 2 })).toBe(false);
  });
});
```

```ts
// packages/connectors/test/document-quality.test.ts
import { describe, it, expect } from 'vitest';
import { recognitionLevel, averageQuality } from '../src/document/quality.js';

describe('recognitionLevel', () => {
  it('uses locked thresholds', () => {
    expect(recognitionLevel(0.85)).toBe('high');
    expect(recognitionLevel(0.849)).toBe('mid');
    expect(recognitionLevel(0.70)).toBe('mid');
    expect(recognitionLevel(0.699)).toBe('low');
  });
});

describe('averageQuality', () => {
  it('averages pages equally and omits empty pages', () => {
    const q = averageQuality([{ page: 1, score: 0.9 }, { page: 2, score: 0.7 }]);
    expect(q.score).toBeCloseTo(0.8);
    expect(q.level).toBe('mid');
    expect(q.pages).toHaveLength(2);
  });
});
```

```ts
// packages/connectors/test/document-host.test.ts
import { describe, it, expect } from 'vitest';
import { documentConnector } from '../src/document/index.js';

describe('document.read host (task 1)', () => {
  it('does not yet declare host main — chat still runs the child handler', () => {
    const tool = documentConnector.tools.find((t) => t.name === 'document.read')!;
    expect(tool.host).not.toBe('main');
    expect(tool.sideEffect).toBe('read');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/connectors/test/document-route.test.ts packages/connectors/test/document-quality.test.ts packages/connectors/test/document-host.test.ts`
Expected: FAIL（模块不存在 / `host` 不是 `'main'`）

- [ ] **Step 3: Implement types and pure functions**

`packages/connectors/src/document/types.ts`:

```ts
export type DocumentEngine = 'native' | 'structure';
export type RecognitionLevel = 'high' | 'mid' | 'low';
export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'text' | 'image';

export interface RecognitionQuality {
  score: number;
  level: RecognitionLevel;
  pages: Array<{ page: number; score: number; level: RecognitionLevel }>;
}

export interface ParsedDocument {
  text: string;
  kind: DocumentKind;
  engine: DocumentEngine;
  meta: {
    fileName: string;
    pageCount?: number;
    quality?: RecognitionQuality;
    skippedModules?: string[];
    ignoredCount?: number;
  };
}
```

`route.ts`：`textLayer === null` 视为抽不出页。去空白后 `length < 50 * pageCount`。控制字符与 U+FFFD 占比按 `textLayer` 原长计。office 扩展名直接 false。

`quality.ts`：`>= 0.85` high，`>= 0.70` mid，否则 low。`Math.round(score * 100)` 只用于 UI，本模块只出 0–1。

`index.ts`：从 `types.ts` 再导出类型；native 解析结果补 `engine: 'native'`；`fileName` 用 `basename`。**不要**加 `host: 'main'`。描述可先改成覆盖图片，工具仍在 Pi 子进程执行直到 Task 5。

- [ ] **Step 4: Re-run tests**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

```bash
git add packages/connectors/src/document packages/connectors/test/document-route.test.ts packages/connectors/test/document-quality.test.ts packages/connectors/test/document-host.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): add document.read routing and quality types"
```

---

### Task 2: 运行中心第二块与底栏（纯 UI）

**Files:**
- Modify: `packages/ui/src/patterns/RuntimeCenter.tsx`
- Modify: `packages/ui/src/patterns/StatusBar.tsx`
- Modify: `packages/ui/src/patterns/Shell.tsx` — 必须增加 `documentParse`、`onStopParse`、`onReleaseParse`、`onCancelLoad` 并传给 RuntimeCenter / StatusBar。UI 的智能体列表字段仍是 `sessions`（App 从 Main `slots` 映射），不要改成 `slots`。
- Modify: `apps/desktop/test/ui-shell-patterns.test.tsx`
- Modify: `apps/desktop/src/App.tsx` — 默认 `documentParse={{ status: 'stopped', waiting: [] }}` 传入 Shell。真实 IPC 在 Task 5。

**Interfaces:**
- Consumes: 无
- Produces: `DocumentParseSnapshot` 类型（与规格字段一致）；`RuntimeCenter` 新 prop `documentParse`；`StatusBar` 新 prop `documentParse`

- [ ] **Step 1: Write failing UI tests**

在 `apps/desktop/test/ui-shell-patterns.test.tsx` 追加：

```ts
it('keeps agent slot counts when document parse is busy', () => {
  render(
    <StatusBar
      statusText="就绪"
      runtimePool={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
      documentParse={{ status: 'parsing', fileName: 'scan.pdf', agentDisplayName: '合同审核智能体', page: 3, total: 12, waiting: [] }}
      onOpenQueue={vi.fn()}
    />,
  );
  expect(screen.getByText(/运行 1\/4/)).toBeTruthy();
  expect(screen.getByText(/文档解析进行中/)).toBeTruthy();
  expect(screen.queryByText(/运行 2\/4/)).toBeNull();
  expect(screen.queryByText(/worker/i)).toBeNull();
});

it('renders document parse as its own section without renaming agent release', () => {
  const idleSnap = { status: 'idle' as const, idleRemainingSec: 120, waiting: [] };
  const { rerender } = render(
    <RuntimeCenter
      snapshot={{ active: 0, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
      documentParse={idleSnap}
      onStop={vi.fn()}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
      onStopParse={vi.fn()}
      onReleaseParse={vi.fn()}
      onCancelLoad={vi.fn()}
    />,
  );
  expect(screen.getByText('智能体')).toBeTruthy();
  expect(screen.getByText('文档解析')).toBeTruthy();
  expect(screen.getByRole('button', { name: '释放' })).toBeTruthy();
  expect(screen.queryByText('释放线程')).toBeNull();

  rerender(
    <RuntimeCenter
      snapshot={{
        active: 1, queued: 0, maxAgents: 4,
        sessions: [{ sessionId: 's1', profileId: 'general', profileName: '通用智能体', label: '会话#1', status: 'running' }],
        queue: [],
      }}
      documentParse={{ status: 'starting', waiting: [] }}
      onStop={vi.fn()}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
      onStopParse={vi.fn()}
      onReleaseParse={vi.fn()}
      onCancelLoad={vi.fn()}
    />,
  );
  expect(screen.getByText('释放线程')).toBeTruthy();
  expect(screen.getByRole('button', { name: '取消加载' })).toBeTruthy();
});

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run apps/desktop/test/ui-shell-patterns.test.tsx`
Expected: FAIL（prop 不存在 / 无「文档解析」）

- [ ] **Step 3: Implement UI**

导出：

```ts
export type DocumentParseStatus = 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';
export interface DocumentParseWaiting { sessionId: string; agentDisplayName: string; fileName: string }
export interface DocumentParseSnapshot {
  status: DocumentParseStatus;
  fileName?: string;
  agentDisplayName?: string;
  page?: number;
  total?: number;
  idleRemainingSec?: number;
  waiting: DocumentParseWaiting[];
  circuitOpen?: boolean;
}
```

文案映射按规格表。`starting`/`parsing` 才让 StatusBar 追加「文档解析进行中」。现有 `运行 n/m · q 排队` 格式不要改。抽屉增加「智能体」标题包住原列表。

- [ ] **Step 4: Re-run tests** — Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 3: NDJSON 编解码与假解析进程

**Files:**
- Create: `apps/desktop/electron/main/document-parse-rpc.ts`
- Create: `apps/desktop/test/document-parse-rpc.test.ts`
- Create: `apps/desktop/test/fixtures/fake-document-parse.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `encodeRequest` / `decodeLines` / `DocumentParseClient`（对一个 `{ stdin, stdout }` 说话）

假进程脚本（Windows 下用 `process.execPath` 跑）：读 stdin 按行 JSON；`parse` 先发一条 `progress`，再 `result.markdown` 与 `pages: [{ page: 1, score: 0.91 }]`；`shutdown` 后 exit 0。stdout 不得打印非 JSON。

- [ ] **Step 1: Failing test** — 喂两行残缺 JSON + 一行完整 parse，断言 client 发出 parse、收到 progress 与 result。

- [ ] **Step 2: Run fail** — `pnpm exec vitest run apps/desktop/test/document-parse-rpc.test.ts`

- [ ] **Step 3: Implement codec**

```ts
export type RpcFrame =
  | { id: string; method: 'parse'; params: { path: string; modules: string[] } }
  | { id: string; method: 'shutdown' }
  | { id: string; method: 'progress'; params: { page: number; total: number } }
  | { id: string; result: { markdown: string; pages: Array<{ page: number; score: number }> } }
  | { id: string; error: { code: string; message: string } };

export function encodeLine(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function splitLines(buffer: string): { frames: unknown[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const frames = parts.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  return { frames, rest };
}
```

`DocumentParseClient.parse`：写 parse 行，收集同一 `id` 的 progress 回调，直到 result/error。

- [ ] **Step 4: Re-run** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 4: 监督器生命周期（假进程）

**Files:**
- Create: `apps/desktop/electron/main/document-parse-kill.ts`
- Create: `apps/desktop/electron/main/document-parse-supervisor.ts`
- Create: `apps/desktop/electron/main/document-parse-layout.ts`（本任务只解析路径：`exe` + `READY`；ensure/解压在 Task 8）
- Create: `apps/desktop/test/document-parse-supervisor.test.ts`

**Interfaces:**
- Consumes: Task 3 `DocumentParseClient`；`DocumentParseSnapshot`
- Produces: `DocumentParseSupervisor` 模块单例 `getDocumentParseSupervisor()`（`ipc.ts` / `workflow.ts` / `document-read.ts` / `index.ts` 都 import 这一份，不挂到 `Runtime`）。API：`enqueueParse`、`stopCurrent`、`release`、`failAll`、**`failSession(sessionId)`**、`beginQuit()`、`snapshot()`、`subscribe(cb)`、`setKeepResident` / `setIdleMinutes` / `clearCircuit`

杀树：`win32` 上 `spawn('taskkill', ['/pid', String(pid), '/T', '/F'])`；其它平台 `process.kill(-pid)` 若失败则 `child.kill('SIGKILL')`。

`enqueueParse({ sessionId, agentDisplayName, fileName, path, modules })` 返回 markdown+pages。

`failSession`：当前任务属于该 session 则等同 `stopCurrent`；queued 里该 session 全部 reject「文档解析已停止。」；其它 session 保留。

`beginQuit()`：若已在 quitting 则为 no-op；否则 `failAll` 再 `killTree`。供 `before-quit` 使用。

用 `vi.useFakeTimers()`：空闲 5 分钟杀树；在飞不杀；常驻不杀；宽限期内新任务 `clearTimeout`。`idleMinutes === 0` 不得当作立即杀。

- [ ] **Step 1: Failing tests**（至少覆盖）：第一次 enqueue 才 spawn；第二次复用同一 pid；idle 到期调用 killTree；parsing 时推进时钟不 kill；`failAll` 让 queued promise reject 且 message 为「文档解析已停止。」；`failSession('A')` 失败 A 的当前与排队、B 保留；`stopCurrent` 失败当前、下一件继续；连续 3 次 spawn 失败 `circuitOpen`；`beginQuit()` 让所有等待者失败并 killTree，第二次 `beginQuit()` 不再 kill。`starting` 时 `stopCurrent` 等同取消加载。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement supervisor** — spawn 命令：`process.env.SPARKII_DOCUMENT_PARSE_BIN` 或 layout 的 exe。stderr pipe 到 `dataDir/logs/document-parse.log`（测试可注入 `appendLog`）。

- [ ] **Step 4: Re-run** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 5: `executeDocumentRead` 接到两条 Main 路径

**Files:**
- Create: `apps/desktop/electron/main/document-read.ts`
- Create: `apps/desktop/test/document-read.test.ts`
- Modify: `apps/desktop/electron/main/ipc.ts`（`handleConnectorRead` 增加 `document.read`；`sparkii:abortChat` 与 `releaseSessionSlotInternal` **先** `failSession(sessionId)`）
- Modify: `apps/desktop/electron/main/workflow.ts` `runTool`
- Modify: `packages/connectors/src/document/index.ts` — **本任务**才设 `host: 'main'`，并在双路径测试通过后把 handler 改 stub
- Create: `packages/connectors/src/document/native-markdown.ts` 或 `apps/desktop/electron/main/document-read.ts` 内的 `probePdfTextLayer` + `nativePdfMarkdown`（复用 connectors 已有 pdfjs；Markdown 页分隔；`fileName` 用 basename；**不写 PNG**）
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/workflow-document-read.test.ts`（新建）
- Modify: `apps/desktop/electron/main/index.ts` — 见下方 `before-quit` 片段
- Modify: `apps/desktop/src/App.tsx` + preload：订阅 `document-parse`，`getDocumentParse`

**Interfaces:**
- Consumes: Task 1 路由；Task 4 supervisor；现有 pdfjs/mammoth/xlsx
- Produces: `executeDocumentRead(args, ctx) => ToolResult`；native 补 `engine:'native'`；structure 结果 `engine:'structure'` + `meta.quality`，**去掉 blocks/tables**

`executeDocumentRead` 使用 `getDocumentParseSupervisor()`，不要从外部注入另一份。`runStructure` 顺序锁定：`needsDocumentParse` → 磁盘可用 ≥ 2GB（注入 `diskFreeBytes` 以便测）→ `ensureDocumentParse`（失败则规格文案）→ `enqueueParse`。解压中可向 `document-parse` 快照设一个临时文案「正在准备文档解析」（映射为 `starting` 即可，不要新状态枚举）。

`native` 路径设置 `meta.ignoredCount = documents.length - 1`（仅当 >0）。office/text 也走薄 Markdown 包装（xlsx 每表一个标题）。

`index.ts` 在 `registerIpc` **之后**（不要只写在 `whenReady` 里找不到 supervisor）：

```ts
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void getDocumentParseSupervisor().beginQuit().finally(() => app.quit());
});
```

`handleConnectorRead`：在 `fetch_document` 之后、`knowledge.search` 之前放行 `document.read`。

`runTool`：`if (toolName === 'document.read') return executeDocumentRead(...)`。

同一提交：工具 `host: 'main'` + 上述两条路径 + stub handler。

- [ ] **Step 1: Failing tests**
  - `executeDocumentRead`：docx 不 enqueue；jpg 会 enqueue；短文字层 PDF 调用；`ignoredCount`；失败无 `data.text`。
  - ipc：`connector_read` `document.read` 不再 `unhandled`。
  - workflow `runTool` 走同一执行器。
  - `documentConnector.tools[0].host === 'main'`（本任务才成立）。
  - abortChat / releaseSessionSlot 调用 `failSession`（可用 supervisor 假对象断言顺序）。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement wiring；然后 stub handler**

```ts
const handler: ToolHandler = async () => ({
  ok: false,
  error: { code: 'CONNECTOR_DENIED', message: 'document.read must run on main' },
});
```

- [ ] **Step 4: Re-run document-read + ipc + workflow tests** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 6: 识别质量 UI

**Files:**
- Create: `packages/ui/src/patterns/RecognitionQuality.tsx`
- Create: `apps/desktop/test/recognition-quality.test.tsx`
- Modify: `packages/ui/src/patterns/chat-detail-level.ts`
- Modify: `apps/desktop/test/chat-detail-level.test.ts`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（原文侧标题旁）
- Modify: `apps/desktop/src/surface/standard-chat.tsx` — 这就是聊天时间线文件。`minimal` 且 `document.read` 且 `engine==='structure'` 时 **只渲染** `<RecognitionQuality />`，禁止走 `ToolCard`。`standard`/`debug` 才是 ToolCard + 质量条。
- Modify: `packages/ui/src/index.ts` 导出

**Interfaces:**
- Consumes: `RecognitionQuality` 类型（可在 ui 再定义一份窄接口 `{ score, level, pages }`，不要 import connectors 进 ui 若会循环；复制窄类型即可）
- Produces: 合同从 `extractWorkflowResult(entries).load.meta.quality` 读取

- [ ] **Step 1: Failing tests**
  - `RecognitionQuality`：`{ score: 0.78, level: 'mid', pages: [...] }` 显示「识别质量 中 · 78%」；native 传入 `quality={undefined}` 且 `engine="native"` 显示「电子文本」而不是百分数。
  - `shouldShowEntry`：structure `document.read` 在 `minimal` 为 true；普通成功 bash 仍 false。
  - 合同 surface：load 完成后原文侧出现质量条。
  - `standard-chat`：`minimal` + structure 结果 **没有** `tool-card`，有识别质量条。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement** — 低质量加「部分文字可能不准确，请对照原文。」可展开 pages。合同从 `extractWorkflowResult(entries).load.meta.quality` 读，禁止 `if (agent.id)`。

`shouldShowEntry` 增加：

```ts
function structureDocumentRead(result: unknown): boolean {
  const rec = result as { data?: { engine?: string } } | undefined;
  return rec?.data?.engine === 'structure';
}
```

在 `kind === 'tool'` 且 `minimal` 时：`toolName === 'document.read' && structureDocumentRead(entry.result)` 返回 true。

- [ ] **Step 4: Re-run** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 7: 合同照片入口

**Files:**
- Modify: `apps/desktop/electron/main/document-bytes.ts`
- Modify: `apps/desktop/electron/preload/api-types.ts`（`DocumentKind` 加 `'image'`）
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`（`chooseDocument` 扩展名）
- Modify: `apps/desktop/agents/contract-review/surface/DocumentPreview.tsx`
- Modify: `apps/desktop/test/contract-surface.test.tsx`
- 新增：`apps/desktop/test/document-bytes.test.ts`（若尚无）

**Interfaces:**
- Consumes: Task 6 质量条（图片 structure 完成后同样走 load.meta）
- Produces: 选择器 jpg/jpeg/png；预览 `<img>`

合同里 `PREVIEW_EXTENSIONS` 当前是 `['pdf', 'docx', 'txt']` 且传给 `chooseDocument`。改为 `['pdf', 'docx', 'txt', 'jpg', 'jpeg', 'png']`。`documentKindOf('.png') === 'image'`。`MAX_DOCUMENT_BYTES` 保持 40MB。

- [ ] **Step 1: Failing tests** — `chooseDocument` 被调用时 extensions 含 `jpg`/`png`；`readDocumentBytes` 对 png 返回 `kind: 'image'`；预览 `data-kind="image"`。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement ImagePreview** — `URL.createObjectURL` + revoke on unmount。

- [ ] **Step 4: Re-run contract-surface + document-bytes** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 8: 设置页、保存隔离、模块清单

**Files:**
- Modify: `apps/desktop/electron/main/settings.ts` — `AppSettings.documentParse?`
- Create: `apps/desktop/electron/main/document-parse-settings.ts`
- Create: `apps/desktop/src/shell/SettingsDocumentParsePane.tsx`
- Modify: `apps/desktop/src/shell/SettingsView.tsx` — PANES 增加 `documentParse: '文档解析'`
- Modify: `apps/desktop/electron/main/ipc.ts` — `saveSettings` 锁 `documentParse`；新增 `saveDocumentParseSettings` / `listDocumentParseModules` / `retryDocumentParse` / `importDocumentParseModule` / `downloadDocumentParseModule`
- Create: `apps/desktop/runtime/document-parse/modules.json`
- Create: `apps/desktop/test/settings-document-parse.test.tsx`
- Modify: `apps/desktop/test/ipc.test.ts` — 仿 `saveSettings does not wipe rag` 加 `does not wipe documentParse`

**Interfaces:**
- Consumes: supervisor `setIdleMinutes` / `setKeepResident` / `clearCircuit`
- Produces: `DocumentParseSettings { idleMinutes: number; keepResident: boolean }` 默认 `{ idleMinutes: 5, keepResident: false }`

**本任务禁止把占位 sha256 写进仓库。** 下载逻辑的单测用 **夹具文件**（例如 16 字节 tar，sha256 预先算好，host 用 `127.0.0.1` 的测试服务器或 `file://` 经 allowlist 测试夹具绕过）。生产 `modules.json` 另开步骤：

1. 对照 PaddleX **3.7** YAML 核对 seal / formula / chart 的 Bos 文件名（不要假设一定是 `paddle3.0.0/..._infer.tar`）。
2. 跑 `apps/desktop/scripts/pin-document-parse-modules.mjs` 下载并写入 64 位 sha256。
3. 测试：`expect(sha256).toMatch(/^[0-9a-f]{64}$/)` 且 `expect(JSON.stringify(mod)).not.toMatch(/REPLACE/)`。

**没有第 2 步产出的真哈希，不得实现 `downloadDocumentParseModule` 的联网分支。** 本任务仍实现：设置分组、idle/resident、重新加载、`saveSettings` 锁 `documentParse`、host allowlist 拒绝 HuggingFace、导入离线包（按文件名 + minBytes）。联网下载函数可以先对夹具 sha256 跑通，接到生产 json 之后把 URL 换成 Bos。

下载实现放 `document-parse-modules.ts`：校验 host、sha256、minBytes，解压到 `models/optional/<id>/`。缺模块时 supervisor 传 `modules` 不含该 id。

`saveSettings`：

```ts
const { apiKey, rag: _dropRag, documentParse: _dropDp, ...rest } = s;
await saveSettings(rt.dataDir, { ...prev, ...rest, rag: prev.rag, documentParse: prev.documentParse });
```

智能体与运行增加一句只读说明：「并行上限只约束智能体，不约束文档解析。」

- [ ] **Step 1: Failing tests** — 设置分组可见；保存走 `saveDocumentParseSettings` 不走会冲掉的 saveSettings rag 路径；ipc 不 wipe；下载拒绝 huggingface URL。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement pane** — 无「关掉文档解析」开关。有「重新加载」。常驻旁注「大约占用 1 GB 以上内存」。

- [ ] **Step 4: Re-run** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 9: 安装布局与 ensure（不含安装包 extraResources）

**Files:**
- Create/Modify: `apps/desktop/electron/main/document-parse-layout.ts` — `needsDocumentParse` / `ensureDocumentParse` / `resolveDocumentParsePaths`
- Create: `apps/desktop/scripts/ensure-document-parse.mjs`
- Create: `apps/desktop/runtime/document-parse/licenses/README.md`
- Modify: `apps/desktop/electron/main/runtime-provision.ts` — `ensureRuntime` 末尾调用 `ensureDocumentParse`（无归档则跳过并打日志，不阻断启动）
- Modify: `apps/desktop/package.json` 的 `ensure:runtime` 串联
- Create: `apps/desktop/test/document-parse-layout.test.ts`

**本任务禁止修改 `electron-builder.yml` extraResources 和 NSIS `customInstall` 解压命令。** 归档不在 git 时加 extraResources 会让 `pnpm dist` 失败。卸载宏可以先写上 `RMDir /r "...\document-parse"`（目录不存在也安全）。

布局与 Portable Git 相同 LOCALAPPDATA 根。测试用临时目录放假 `READY` + 假 exe。`ensure` 找不到 7z 时 skip。AppX 只走这条 ensure（NSIS 宏根本不跑）。

磁盘检查的 **调用点在 Task 5 `runStructure`**，本任务只提供 `diskFreeBytes` 可注入的 helper。

- [ ] **Step 1: Failing tests** — `needsDocumentParse` 在缺 READY 时为 true；路径在 `SPARKII_RUNTIME_ROOT/document-parse/bin/sparkii-document-parse.exe`。

- [ ] **Step 2: Run fail**

- [ ] **Step 3: Implement layout + ensure skip-if-missing。不要碰 extraResources。**

- [ ] **Step 4: Re-run** — PASS

- [ ] **Step 5: Commit**（仅当用户要求提交）

---

### Task 10: 解析程序（NDJSON 入口 + 可选 Paddle）

**Files:**
- Create: `packages/document-parse/sparkii_document_parse/__main__.py`
- Create: `packages/document-parse/sparkii_document_parse/loop.py`
- Create: `packages/document-parse/README.md`（如何打 `sparkii-document-parse.7z.exe`）
- Create: `packages/document-parse/tests/test_loop.py`

**Interfaces:**
- Consumes: 规格 NDJSON；`params.path` 为原始文件；进程内栅格化 PDF
- Produces: `result.markdown` + `pages[].score`

`SPARKII_DOCUMENT_PARSE_FAKE=1` 与 `SPARKII_DOCUMENT_PARSE_BIN=python` **只用于测试和开发**。正式安装包不设 FAKE。`ocr_version` 不得传 v6。`PADDLE_PDX_MODEL_SOURCE=bos`。`SPARKII_DOCUMENT_PARSE_MODELS` 指向 `runtime/document-parse/models`。

- [ ] **Step 1: Failing python test** — FAKE 模式 stdout 只有 JSON 行。
- [ ] **Step 2: Run fail**
- [ ] **Step 3: Implement loop**
- [ ] **Step 4: Supervisor 对 FAKE 入口 skipIf 无 python**
- [ ] **Step 5: Commit**（仅当用户要求提交）

**发布门（本任务之后、改安装包之前）：** 构建机按 README 打出 `sparkii-document-parse.7z.exe`，把 archive sha256 写入 `checksums.json`，文件放进 `apps/desktop/runtime/document-parse/`。**只有这时**才允许改 `electron-builder.yml` extraResources 和 NSIS `customInstall` 的 `ExecWait`。在此之前 `pnpm dist` 必须保持绿色。FAKE 入口不得打进 extraResources。

---

### Task 11: 错误文案、审计、复制检查

**Files:**
- Modify: `apps/desktop/electron/main/document-read.ts` 用户文案
- Modify: `handleConnectorRead` 审计 `tool.read` 摘要
- Create: `apps/desktop/test/document-parse-copy.test.ts`（对 RuntimeCenter / StatusBar / 错误字符串跑：不得匹配 `/worker|sidecar|OCR|Paddle|JSON-RPC/i`）
- 崩溃/spawn 失败走错误中心 `source: '文档解析'`（与「运行中心」并列）

锁定失败文案：

| 条件 | message |
| --- | --- |
| 未就绪 | 文档解析尚未就绪，请到设置 → 文档解析查看。 |
| 磁盘不足 | 磁盘空间不足，无法准备文档解析。 |
| spawn/OOM | 内存不足或文档解析无法启动，请到设置 → 文档解析查看。 |
| 停止/退出 | 文档解析已停止。 |

- [ ] **Step 1–4:** 测试文案 + 审计含 fileName/engine/score、不含全文。
- [ ] **Step 5: Commit**（仅当用户要求提交）

---

## Self-review（对照规格）

| 规格要求 | 任务 |
| --- | --- |
| `executeDocumentRead` 双入口；`host` 同提交 | 5（Task 1 不改 host） |
| stub 在双入口之后 | 5 |
| NDJSON 非 Pi 信封 | 3、4、10 |
| 杀进程树 / `beginQuit` | 4、5 |
| 独立 DocumentParseSnapshot；UI `sessions` 不是 `slots` | 2、5 |
| 包装：ensure 与 extraResources 分开 | 9 布局；10 之后才允许 extraResources |
| PDF 栅格化只在解析进程 | 5、10 |
| 照片入口 | 7 |
| 质量：load.meta / toolResult / minimal 只显示条 | 6 |
| `failSession` 在 abortChat 与释放线程之前 | 4、5 |
| `getDocumentParseSupervisor` 单例；runStructure disk→ensure→enqueue | 4、5 |
| saveSettings 不冲 documentParse | 8 |
| 无总开关；重新加载清熔断 | 4、8 |
| 混合 PDF 不按页拆 | 1 |
| 无 blocks/tables | 5 |
| Copy rules；错误来源「文档解析」 | 2、11 |
| 可选模块：无 REPLACE 占位、夹具测下载 | 8 |
| 真实 Paddle skip；FAKE 不进安装包 | 10 |
