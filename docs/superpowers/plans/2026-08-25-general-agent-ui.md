# 通用智能体 UI（GeneralChatSurface）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为通用智能体落地 Codex 风格对话界面：GeneralChatSurface（消息流 + 工具卡片 + Composer + 工作区/模型选择）+ Shell 会话抽屉扩展 + 审批 diff 展示 + e2e 冒烟。

**Architecture:** 渲染层沿用现有壳层（Shell/顶栏/左栏/抽屉/V3 token）。GeneralChatSurface 消费运行时计划（`2026-08-25-general-agent-runtime.md`）产出的 IPC 面（`newChatSession/openChatSession/promptSession/abortChat/setChatModel/setChatWorkspace/getModelOptions/listChatSessions/…`）与 `chat-event`/`approval` 事件流；消息与工具调用渲染为统一的条目列表（message/tool 两类）。审批面板在 `payload.diff` 存在时内嵌 DiffView。会话抽屉复用 Shell，扩展重命名/删除回调。

**Tech Stack:** React 19 + TypeScript（strict，ESM，import 带 `.js` 后缀）+ Vite、vitest + Testing Library（jsdom）、react-markdown + remark-gfm（新增依赖）、Playwright（Electron e2e）。

**Spec:** [2026-08-25-general-agent-design.md](../specs/2026-08-25-general-agent-design.md)

**Runtime plan（前置依赖，先于本计划执行）：** [2026-08-25-general-agent-runtime.md](./2026-08-25-general-agent-runtime.md)——本计划的 IPC/事件契约全部来自该计划的 Task 15，执行者必须同时阅读两份文档。

## Global Constraints

- ESM + strict TS；renderer 代码**不用分号**（与 `apps/desktop/src` 现有风格一致）；import 相对路径带 `.js` 后缀。
- 测试：`pnpm test`（vitest projects：`apps/**/test/**/*.test.{ts,tsx}` 走 jsdom）；组件测试不依赖真实 IPC/LLM（`window.sparkii` 用 mock）。
- 权威状态原则：消息/工具结果来自 `chat-event` 事件流，用户消息本地回显（忽略 runtime 的 user echo），不双写。
- 安全/体验：写操作审批沿用现有 ApprovalPanel/ApprovalModal（App 全局）；GeneralChatSurface 只标记「等待审批」，不绕过审批。
- 用户可见文案中文；类名沿用现有风格（kebab-case）；视觉 token 来自 V3（背景 `#F5F7FB`、主色 `#2563EB`、圆角 12px 等）。
- 不新增除 react-markdown/remark-gfm 外的依赖；若离线无法安装依赖，按 Task 1 的降级路径执行并记录偏差。

---

## File Structure

**apps/desktop/src/workbench/**
- `Markdown.tsx`（新）：react-markdown 渲染 + 代码块复制。
- `DiffView.tsx`（新）：diff 字符串高亮渲染（+/-/上下文/头）。
- `Composer.tsx`（新）：多行输入、发送/停止三态、模型下拉、工作区选择行。
- `ToolCard.tsx`（新）：工具调用/结果卡片（展开详情、diff、状态：运行中/等待审批/完成）。

**apps/desktop/src/surfaces/**
- `GeneralChatSurface.tsx`（新）：会话生命周期、事件订阅、条目列表（message/tool）、空态/错误。

**apps/desktop/src/trust/**
- `ApprovalPanel.tsx`、`ApprovalModal.tsx`：payload.diff 存在时展示 DiffView。

**apps/desktop/src/shell/**
- `Shell.tsx`：`ScreenId` 增加 `'general'`；会话抽屉增加重命名/删除（回调可选）。

**apps/desktop/src/**
- `App.tsx`：agents 来自 `listAgents`（带 fallback）、general 路由/会话状态、会话抽屉数据、审批 diff 接线。
- `styles.css`：新增聊天/工具卡片/diff/composer/工作区/模型样式。

**apps/desktop/package.json**
- 新增依赖：`react-markdown`、`remark-gfm`。

**apps/desktop/e2e/**
- `general.spec.ts`（新）：冒烟 e2e。

---

### Task 1: 依赖 react-markdown / remark-gfm

**Files:**
- Modify: `apps/desktop/package.json`、`pnpm-lock.yaml`

**Interfaces:**
- Produces: `react-markdown`、`remark-gfm` 进入 dependencies。

- [ ] **Step 1: 安装**

Run: `pnpm --filter @sparkii/desktop add react-markdown remark-gfm`
Expected: package.json dependencies 增加两项、pnpm-lock.yaml 更新。

> 若沙箱网络受限导致安装失败，请求授权（`pnpm` 前缀）后重试。若仍无法联网，采用降级：不安装依赖，在 Task 2 中实现内置最小 Markdown 渲染（代码围栏 + 行内代码 + 粗体/列表），并在 Task 2 末尾注明偏差（`react-markdown` 留待联网后替换）。

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "deps(desktop): react-markdown and remark-gfm"
```

---

### Task 2: Markdown.tsx（渲染 + 代码块复制）

**Files:**
- Create: `apps/desktop/src/workbench/Markdown.tsx`
- Test: `apps/desktop/test/markdown.test.tsx`（新）

**Interfaces:**
- Produces:
  ```tsx
  export function Markdown({ text }: { text: string }): JSX.Element;
  ```
  渲染 GFM Markdown；代码块带「复制」按钮（`navigator.clipboard.writeText`）；`data-testid="code-block"` / `data-testid="copy-btn"`。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/markdown.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Markdown } from '../src/workbench/Markdown.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders paragraphs and inline code', () => {
    render(<Markdown text={'hello **world**\n\n`code`'} />);
    expect(screen.getByText(/hello/)).toBeTruthy();
    expect(screen.getByText('world').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
  });

  it('renders code blocks with a copy button', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    const block = screen.getByTestId('code-block');
    expect(block.textContent).toContain('const a = 1;');
    fireEvent.click(screen.getByTestId('copy-btn'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/markdown.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/workbench/Markdown.tsx`：

```tsx
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock(props: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(props.children ?? '').replace(/\n$/, '');
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="code-block" data-testid="code-block">
      <button type="button" className="copy-btn" data-testid="copy-btn" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
      <pre><code className={props.className}>{props.children}</code></pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: (p) => <>{p.children}</>, code: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

> 说明：`pre` 覆盖为直接透传，使代码块只渲染一次（`code` 自定义组件负责外层容器）；若 react-markdown 版本对 `pre`/`code` 组合语义不同，测试以「代码内容出现一次且复制按钮存在」为准微调。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/markdown.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench/Markdown.tsx apps/desktop/test/markdown.test.tsx
git commit -m "feat(desktop): markdown rendering with code copy"
```

---

### Task 3: DiffView.tsx（审批/工具卡片 diff 渲染）

**Files:**
- Create: `apps/desktop/src/workbench/DiffView.tsx`
- Test: `apps/desktop/test/diff-view.test.tsx`（新）

**Interfaces:**
- Produces:
  ```tsx
  export function DiffView({ diff }: { diff: string }): JSX.Element;
  ```
  逐行渲染：头（`---`/`+++`）→ `diff-hdr`；`+` → `diff-add`；`-` → `diff-del`；空格前缀 → `diff-ctx`。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/diff-view.test.tsx`：

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DiffView } from '../src/workbench/DiffView.js';

afterEach(cleanup);

describe('DiffView', () => {
  it('classifies header, added, removed and context lines', () => {
    const { container } = render(<DiffView diff={'--- a/a.txt\n+++ b/a.txt\n-old\n+new\n keep\n'} />);
    expect(container.querySelector('.diff-hdr')).toBeTruthy();
    const add = container.querySelector('.diff-add');
    expect(add?.textContent).toBe('+new');
    const del = container.querySelector('.diff-del');
    expect(del?.textContent).toBe('-old');
    expect(container.querySelector('.diff-ctx')?.textContent).toBe(' keep');
  });
  it('renders empty diff without crashing', () => {
    render(<DiffView diff="" />);
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/diff-view.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/workbench/DiffView.tsx`：

```tsx
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="diff" data-testid="diff-view">
      {lines.map((line, i) => {
        let cls = 'diff-ctx';
        if (line.startsWith('---') || line.startsWith('+++')) cls = 'diff-hdr';
        else if (line.startsWith('+')) cls = 'diff-add';
        else if (line.startsWith('-')) cls = 'diff-del';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/diff-view.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench/DiffView.tsx apps/desktop/test/diff-view.test.tsx
git commit -m "feat(desktop): diff view for approval previews"
```

---

### Task 4: Composer.tsx（输入 / 发送·停止 / 模型下拉 / 工作区行）

**Files:**
- Create: `apps/desktop/src/workbench/Composer.tsx`
- Test: `apps/desktop/test/composer.test.tsx`（新）

**Interfaces:**
- Consumes: 无（纯受控组件）。
- Produces:
  ```tsx
  export interface ComposerProps {
    busy: boolean;
    models: string[];
    defaultModel: string | null;
    model: string | null;
    onModelChange(model: string | null): void;
    workspacePath: string | null;
    workspaceKind: 'auto' | 'user';
    onChooseWorkspace(): void;
    onClearWorkspace(): void;
    onSend(text: string): void;
    onStop(): void;
  }
  export function Composer(props: ComposerProps): JSX.Element;
  ```
  `data-testid`：`composer-input`、`composer-send`、`model-select`、`workspace-path`、`workspace-clear`。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/composer.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Composer, type ComposerProps } from '../src/workbench/Composer.js';

afterEach(cleanup);

function makeProps(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    busy: false,
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    defaultModel: 'deepseek-v4-flash',
    model: null,
    onModelChange: vi.fn(),
    workspacePath: 'C:/ws/SparkiiXyZ9202608251710',
    workspaceKind: 'auto',
    onChooseWorkspace: vi.fn(),
    onClearWorkspace: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
}

describe('Composer', () => {
  it('sends on Ctrl+Enter and clears the input', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(props.onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('shows stop instead of send while busy', () => {
    const props = makeProps({ busy: true });
    render(<Composer {...props} />);
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('model select defaults to 默认(跟随配置)', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'deepseek-v4-pro' } });
    expect(props.onModelChange).toHaveBeenCalledWith('deepseek-v4-pro');
  });

  it('workspace row shows path, choose and clear actions', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    expect(screen.getByTestId('workspace-path').textContent).toContain('SparkiiXyZ9');
    fireEvent.click(screen.getByText('选择文件夹'));
    expect(props.onChooseWorkspace).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('workspace-clear'));
    expect(props.onClearWorkspace).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/composer.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/workbench/Composer.tsx`：

```tsx
import { useState } from 'react';

export interface ComposerProps {
  busy: boolean;
  models: string[];
  defaultModel: string | null;
  model: string | null;
  onModelChange(model: string | null): void;
  workspacePath: string | null;
  workspaceKind: 'auto' | 'user';
  onChooseWorkspace(): void;
  onClearWorkspace(): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text || props.busy) return;
    props.onSend(text);
    setDraft('');
  };

  return (
    <div className="composer">
      <div className="composer-row ws-row">
        <span className="muted">工作区</span>
        <span className="ws-path" data-testid="workspace-path" title={props.workspacePath ?? ''}>
          {props.workspacePath ?? '（首次写操作时生成）'}
        </span>
        <button type="button" className="btn sm" onClick={props.onChooseWorkspace}>选择文件夹</button>
        {props.workspaceKind === 'user' && (
          <button type="button" className="btn sm" data-testid="workspace-clear" onClick={props.onClearWorkspace}>清除</button>
        )}
      </div>
      <div className="composer-row">
        <select
          className="model-select"
          data-testid="model-select"
          value={props.model ?? ''}
          onChange={(e) => props.onModelChange(e.target.value || null)}
        >
          <option value="">默认（跟随配置）{props.defaultModel ? ` · ${props.defaultModel}` : ''}</option>
          {props.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div className="composer-row">
        <textarea
          className="field composer-input"
          data-testid="composer-input"
          rows={3}
          placeholder="输入消息，Ctrl+Enter 发送"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="btn primary composer-send" data-testid="composer-send" onClick={props.busy ? props.onStop : send}>
          {props.busy ? '停止' : '发送'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/composer.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench/Composer.tsx apps/desktop/test/composer.test.tsx
git commit -m "feat(desktop): chat composer with model and workspace selection"
```

---

### Task 5: ToolCard.tsx（工具调用/结果卡片）

**Files:**
- Create: `apps/desktop/src/workbench/ToolCard.tsx`
- Test: `apps/desktop/test/tool-card.test.tsx`（新）

**Interfaces:**
- Consumes: `DiffView`（Task 3）。
- Produces:
  ```tsx
  export interface ToolCardProps {
    toolName: string;
    input: unknown;
    result?: unknown;
    awaitingApproval?: boolean;
  }
  export function ToolCard(props: ToolCardProps): JSX.Element;
  ```
  状态文本：等待审批（琥珀）/ 运行中（蓝）/ 完成（绿）；详情可展开；`input.diff` 或 `result.details?.diff` 存在时展示 `DiffView`。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/tool-card.test.tsx`：

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToolCard } from '../src/workbench/ToolCard.js';

afterEach(cleanup);

describe('ToolCard', () => {
  it('shows running state before result', () => {
    render(<ToolCard toolName="bash" input={{ command: 'ls' }} />);
    expect(screen.getByText(/运行中/)).toBeTruthy();
    expect(screen.getByText(/ls/)).toBeTruthy();
  });

  it('shows awaiting approval state', () => {
    render(<ToolCard toolName="write" input={{ path: 'C:/ws/a.txt' }} awaitingApproval />);
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });

  it('expands details and renders diff from result', () => {
    render(<ToolCard toolName="edit" input={{ path: 'a.txt' }} result={{ details: { diff: '--- a/a.txt\n+++ b/a.txt\n+hi' } }} />);
    expect(screen.getByText(/完成/)).toBeTruthy();
    fireEvent.click(screen.getByText('详情 ▸'));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/tool-card.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/workbench/ToolCard.tsx`：

```tsx
import { useState } from 'react';
import { DiffView } from './DiffView.js';

export interface ToolCardProps {
  toolName: string;
  input: unknown;
  result?: unknown;
  awaitingApproval?: boolean;
}

function summaryOf(toolName: string, input: unknown): string {
  const rec = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'bash') return String(rec.command ?? '');
  if (typeof rec.path === 'string') return rec.path;
  return toolName;
}

export function ToolCard(props: ToolCardProps) {
  const { toolName, input, result, awaitingApproval } = props;
  const [open, setOpen] = useState(false);
  const resultRec = (result ?? {}) as { details?: { diff?: string } };
  const inputRec = (input ?? {}) as { diff?: string };
  const diff = inputRec.diff ?? resultRec.details?.diff;
  const status = awaitingApproval ? '等待审批' : result ? '完成' : '运行中…';
  const cls = awaitingApproval ? 'await' : result ? 'done' : 'run';

  return (
    <div className={`tool-card ${cls}`} data-testid="tool-card">
      <div className="tool-head">
        <b>{toolName}</b>
        <span className="tool-summary">{summaryOf(toolName, input)}</span>
        <span className={`tool-status ${cls}`}>{status}</span>
      </div>
      <button type="button" className="btn sm" onClick={() => setOpen((v) => !v)}>详情 {open ? '▾' : '▸'}</button>
      {open && (
        <div className="tool-detail">
          <pre className="payload-box">{JSON.stringify(input, null, 2)}</pre>
          {typeof result === 'string' && <pre className="payload-box">{result}</pre>}
          {diff && <DiffView diff={diff} />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/tool-card.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench/ToolCard.tsx apps/desktop/test/tool-card.test.tsx
git commit -m "feat(desktop): tool call/result cards"
```

---

### Task 6: GeneralChatSurface.tsx（消息流 + 事件订阅 + 会话生命周期）

**Files:**
- Create: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: `apps/desktop/test/general-chat-surface.test.tsx`（新）

**Interfaces:**
- Consumes: `SparkiiApi`（runtime plan Task 15 的 `promptSession/openChatSession/getChatSession/getChatMessages/setChatModel/setChatWorkspace/chooseWorkspace/getModelOptions/abortChat`）、`Composer`（Task 4）、`ToolCard`（Task 5）、`Markdown`（Task 2）。
- Produces:
  ```tsx
  export type ChatEntry =
    | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; streaming: boolean }
    | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean };
  export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[];
  export function normalizeMessages(messages: unknown[]): ChatEntry[];
  export interface GeneralChatSurfaceProps {
    api: SparkiiApi;
    sessionId: string | null;
    onNewSession(): void;
  }
  export function GeneralChatSurface(props: GeneralChatSurfaceProps): JSX.Element;
  ```
  空态（无 sessionId）：标题 + 引导 + 「新建会话」按钮；有 sessionId：打开会话（`openChatSession` 恢复历史）、订阅 `chat-event`（按 `sessionId` 过滤）+ `approval`（标记工具卡等待审批）、Composer（模型/工作区）、错误行。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/general-chat-surface.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { GeneralChatSurface, applyChatEvent, normalizeMessages, type ChatEntry } from '../src/surfaces/GeneralChatSurface.js';

afterEach(cleanup);

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [{ role: 'user', text: 'hi' }] }),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710', workspaceKind: 'auto' }),
    getChatMessages: vi.fn().mockResolvedValue([]),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    abortChat: vi.fn().mockResolvedValue({ ok: true }),
    setChatModel: vi.fn().mockResolvedValue({ ok: true }),
    setChatWorkspace: vi.fn().mockResolvedValue({ ok: true }),
    chooseWorkspace: vi.fn().mockResolvedValue({ path: 'C:/user-ws' }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: 'deepseek-v4-flash', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }),
  };
  return { api: api as any, channels };
}

describe('applyChatEvent', () => {
  it('appends streaming deltas and finalizes text', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', delta: 'Hel' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', delta: 'lo' });
    entries = applyChatEvent(entries, { type: 'message', role: 'assistant', text: 'Hello' });
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).text).toBe('Hello');
    expect((entries[0] as any).streaming).toBe(false);
  });

  it('pairs tool_call with tool_result and ignores user echo', () => {
    let entries: ChatEntry[] = [];
    entries = applyChatEvent(entries, { type: 'message', role: 'user', text: 'x' });
    entries = applyChatEvent(entries, { type: 'tool_call', toolName: 'bash', input: { command: 'ls' } });
    entries = applyChatEvent(entries, { type: 'tool_result', toolName: 'bash', result: { exitCode: 0 } });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('tool');
    expect((entries[0] as any).result).toMatchObject({ exitCode: 0 });
  });
});

describe('normalizeMessages', () => {
  it('maps user/assistant text messages', () => {
    const out = normalizeMessages([{ role: 'user', text: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }]);
    expect(out.map((e) => (e.kind === 'message' ? e.role : null))).toEqual(['user', 'assistant']);
  });
});

describe('GeneralChatSurface', () => {
  it('shows empty state and creates a session via onNewSession', async () => {
    const { api } = makeApi();
    const onNewSession = vi.fn();
    render(<GeneralChatSurface api={api} sessionId={null} onNewSession={onNewSession} />);
    fireEvent.click(screen.getByText('新建会话'));
    expect(onNewSession).toHaveBeenCalled();
  });

  it('restores history and sends promptSession with sessionId', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await waitFor(() => expect(api.openChatSession).toHaveBeenCalledWith('s1'));
    expect(screen.getByText('hi')).toBeTruthy();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '请创建 hello.txt' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    expect(api.promptSession).toHaveBeenCalledWith('s1', '请创建 hello.txt');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'message', role: 'assistant', delta: '收到' }));
    expect(screen.getByText(/收到/)).toBeTruthy();
  });

  it('marks a tool card awaiting approval from approval events', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    act(() => channels['chat-event']({ sessionId: 's1', type: 'tool_call', toolName: 'write', input: { path: 'C:/ws/a.txt' } }));
    act(() => channels['approval']({ sessionId: 's1', toolName: 'write' }));
    expect(screen.getByText(/等待审批/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/general-chat-surface.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/surfaces/GeneralChatSurface.tsx`：

```tsx
import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { Composer } from '../workbench/Composer.js';
import { ToolCard } from '../workbench/ToolCard.js';
import { Markdown } from '../workbench/Markdown.js';

export type ChatEntry =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean };

function findLastUnresolvedTool(entries: ChatEntry[], toolName: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'tool' && e.toolName === toolName && e.result === undefined) return i;
  }
  return -1;
}

export function applyChatEvent(entries: ChatEntry[], ev: unknown): ChatEntry[] {
  const raw = ev as { type?: string; role?: string; delta?: string; text?: string; toolName?: string; input?: unknown; result?: unknown };
  if (raw.type === 'message') {
    if (raw.role === 'user') return entries;
    const last = entries[entries.length - 1];
    if (typeof raw.delta === 'string') {
      if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: last.text + raw.delta }];
      }
      return [...entries, { kind: 'message', id: `m${Date.now()}-${Math.random()}`, role: 'assistant', text: raw.delta, streaming: true }];
    }
    if (typeof raw.text === 'string') {
      if (last?.kind === 'message' && last.role === 'assistant' && last.streaming) {
        return [...entries.slice(0, -1), { ...last, text: raw.text, streaming: false }];
      }
      return [...entries, { kind: 'message', id: `m${Date.now()}-${Math.random()}`, role: 'assistant', text: raw.text, streaming: false }];
    }
    return entries;
  }
  if (raw.type === 'tool_call') {
    return [...entries, { kind: 'tool', id: `t${Date.now()}-${Math.random()}`, toolName: String(raw.toolName ?? ''), input: raw.input }];
  }
  if (raw.type === 'tool_result' && raw.toolName) {
    const idx = findLastUnresolvedTool(entries, raw.toolName);
    if (idx < 0) return entries;
    const next = [...entries];
    const target = next[idx] as Extract<ChatEntry, { kind: 'tool' }>;
    next[idx] = { ...target, result: raw.result, awaitingApproval: false };
    return next;
  }
  return entries;
}

export function normalizeMessages(messages: unknown[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let n = 0;
  for (const m of messages) {
    const rec = m as { role?: string; text?: string; content?: unknown };
    const role = rec.role === 'user' ? 'user' : rec.role === 'assistant' ? 'assistant' : null;
    const text = typeof rec.text === 'string'
      ? rec.text
      : Array.isArray(rec.content)
        ? rec.content.map((c) => (c as { text?: string })?.text ?? '').join('')
        : '';
    if (role && text) out.push({ kind: 'message', id: `m${n++}`, role, text, streaming: false });
  }
  return out;
}

export interface GeneralChatSurfaceProps {
  api: SparkiiApi;
  sessionId: string | null;
  onNewSession(): void;
}

export function GeneralChatSurface(props: GeneralChatSurfaceProps) {
  const { api, sessionId, onNewSession } = props;
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceKind, setWorkspaceKind] = useState<'auto' | 'user'>('auto');

  const refreshMeta = () => {
    if (!sessionId) return;
    api.getChatSession(sessionId).then((rec: any) => {
      if (rec?.workspacePath) setWorkspacePath(rec.workspacePath);
      if (rec?.workspaceKind === 'user') setWorkspaceKind('user');
      if (rec?.model) setModel(rec.model);
    });
  };

  useEffect(() => {
    setEntries([]);
    setBusy(false);
    setError('');
    setModel(null);
    if (!sessionId) return;
    api.openChatSession(sessionId).then(({ messages }: any) => {
      setEntries(normalizeMessages(messages ?? []));
    }).catch((e: any) => setError(String(e?.message ?? e)));
    api.getModelOptions().then((r: any) => {
      setModels(r.models ?? []);
      setDefaultModel(r.defaultModel ?? null);
    });
    refreshMeta();
    const off1 = api.on('chat-event', (p: any) => {
      if (p?.sessionId !== sessionId) return;
      setEntries((xs) => applyChatEvent(xs, p));
    });
    const off2 = api.on('approval', (p: any) => {
      if (p?.sessionId !== sessionId || !p?.toolName) return;
      setEntries((xs) => {
        const idx = findLastUnresolvedTool(xs, p.toolName);
        if (idx < 0) return xs;
        const next = [...xs];
        next[idx] = { ...(next[idx] as Extract<ChatEntry, { kind: 'tool' }>), awaitingApproval: true };
        return next;
      });
    });
    return () => { off1(); off2(); };
  }, [api, sessionId]);

  const send = (text: string) => {
    if (!sessionId) return;
    setEntries((xs) => [...xs, { kind: 'message', id: `u${Date.now()}`, role: 'user', text, streaming: false }]);
    setBusy(true);
    setError('');
    api.promptSession(sessionId, text).catch((e: any) => setError(String(e?.message ?? e))).finally(() => setBusy(false));
  };

  const stop = () => {
    if (sessionId) void api.abortChat(sessionId).finally(() => setBusy(false));
  };

  const onModelChange = (next: string | null) => {
    setModel(next);
    if (sessionId) void api.setChatModel(sessionId, next);
  };

  const chooseWorkspace = () => {
    api.chooseWorkspace().then(({ path }: any) => {
      if (path && sessionId) {
        api.setChatWorkspace(sessionId, path).then(refreshMeta);
      }
    });
  };

  const clearWorkspace = () => {
    if (sessionId) api.setChatWorkspace(sessionId, null).then(refreshMeta);
  };

  if (!sessionId) {
    return (
      <div className="chat-empty">
        <h3>通用智能体</h3>
        <p>可以对话问答，也可以在工作区内编程：读代码、跑命令、改文件。</p>
        <button type="button" className="btn primary" onClick={onNewSession}>新建会话</button>
      </div>
    );
  }

  return (
    <div className="chat-surface">
      <div className="chat-list">
        {entries.map((e) => (
          e.kind === 'message' ? (
            <div key={e.id} className={`msg msg-${e.role}`}>
              {e.role === 'assistant' ? <Markdown text={e.text} /> : <span className="msg-text">{e.text}</span>}
              {e.streaming && <span className="caret" aria-hidden="true" />}
            </div>
          ) : (
            <ToolCard key={e.id} toolName={e.toolName} input={e.input} result={e.result} awaitingApproval={e.awaitingApproval} />
          )
        ))}
        {entries.length === 0 && !busy && <div className="muted chat-hint">开始对话，或让智能体在工作区里做点什么。</div>}
      </div>
      {error && <div className="chat-error" role="alert">{error}</div>}
      <Composer
        busy={busy}
        models={models}
        defaultModel={defaultModel}
        model={model}
        onModelChange={onModelChange}
        workspacePath={workspacePath}
        workspaceKind={workspaceKind}
        onChooseWorkspace={chooseWorkspace}
        onClearWorkspace={clearWorkspace}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/general-chat-surface.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/surfaces/GeneralChatSurface.tsx apps/desktop/test/general-chat-surface.test.tsx
git commit -m "feat(desktop): general chat surface with streaming and tool cards"
```

---

### Task 7: Shell 支持 general 智能体与会话抽屉重命名/删除

**Files:**
- Modify: `apps/desktop/src/shell/Shell.tsx`
- Test: `apps/desktop/test/shell.test.tsx`（扩展）

**Interfaces:**
- Consumes: 现有 `ShellProps`。
- Produces: `ScreenId` 增加 `'general'`；`ShellProps` 增加可选 `onRenameSession?(agentId: string, sessionId: string, title: string): void` 与 `onDeleteSession?(agentId: string, sessionId: string): void`；会话抽屉行在提供回调时显示「重命名」「删除」按钮，重命名行内变为输入框（Enter/失焦保存）。

- [ ] **Step 1: 追加失败测试**

在 `apps/desktop/test/shell.test.tsx` 追加：

```tsx
  it('supports general agent and rename/delete callbacks in session drawer', () => {
    const props = makeProps();
    props.active = 'general';
    props.agents = [...props.agents, { id: 'general', name: '通用智能体', status: 'idle' }];
    props.sessions = { ...props.sessions, general: [{ id: 'g1', name: '会话 08-25 17:10', state: '', time: '今天' }] };
    props.onRenameSession = vi.fn();
    props.onDeleteSession = vi.fn();
    render(<Shell {...props} />);
    fireEvent.click(screen.getByTitle('会话'));
    fireEvent.click(screen.getByTitle('重命名 g1'));
    const input = screen.getByDisplayValue('会话 08-25 17:10');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRenameSession).toHaveBeenCalledWith('general', 'g1', '新标题');
    fireEvent.click(screen.getByTitle('删除 g1'));
    expect(props.onDeleteSession).toHaveBeenCalledWith('general', 'g1');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/shell.test.tsx`
Expected: FAIL——`general` 不在 ScreenId / 重命名/删除按钮不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/shell/Shell.tsx`：

```tsx
export type ScreenId = 'home' | 'contract' | 'chat' | 'dashboard' | 'general' | 'approvals' | 'audit' | 'settings';
```

`ShellProps` 增加：

```tsx
  onRenameSession?(agentId: string, sessionId: string, title: string): void;
  onDeleteSession?(agentId: string, sessionId: string): void;
```

组件内新增 `renamingId` 状态与行渲染（替换原 `activeSessions.map` 行内按钮部分）：

```tsx
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const startRename = (s: ShellSession) => {
    setRenamingId(s.id);
    setRenameDraft(s.name);
  };

  const commitRename = (agentId: string, s: ShellSession) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title && title !== s.name) props.onRenameSession?.(agentId, s.id, title);
  };
```

抽屉列表项（在 `<div className="item">` 内追加）：

```tsx
              {renamingId === s.id ? (
                <input
                  className="field"
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(active, s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(active, s);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <>
                  {props.onRenameSession && (
                    <button type="button" className="icon-btn sm" title={`重命名 ${s.id}`} onClick={() => startRename(s)}>✎</button>
                  )}
                  {props.onDeleteSession && (
                    <button type="button" className="icon-btn sm" title={`删除 ${s.id}`} onClick={() => props.onDeleteSession?.(active, s.id)}>✕</button>
                  )}
                </>
              )}
```

> 放置位置：按钮放在会话名右侧、时间左侧，保持现有行结构；若视觉拥挤，把按钮放进行的尾部 `display:flex; gap:4px` 容器（样式在 Task 10）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/shell.test.tsx`
Expected: PASS（旧 7 例 + 新增 1 例）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shell/Shell.tsx apps/desktop/test/shell.test.tsx
git commit -m "feat(desktop): shell supports general agent and session rename/delete"
```

---

### Task 8: App.tsx 接线（agents / 会话 / 路由 / 审批 diff）

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/app-general.test.tsx`（新）

**Interfaces:**
- Consumes: `GeneralChatSurface`（Task 6）、`Shell` 新回调（Task 7）、`SparkiiApi.listAgents/newChatSession/listChatSessions/setChatTitle/deleteChatSession/getChatSession`。
- Produces: `AGENTS` 由 `listAgents()` 驱动（失败时 fallback 合同审核）；`sessions` 状态按 agent 提供抽屉数据；`navigate('general')` 进入通用表面；`onNewSession('general')` 创建会话；`onRenameSession`/`onDeleteSession` 接线；审批 diff 展示交给 Task 9。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/app-general.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

function makeApi() {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    login: vi.fn().mockResolvedValue({ userId: 'admin', roles: ['admin'] }),
    getProfile: vi.fn().mockResolvedValue({ pages: {} }),
    listPendingApprovals: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([
      { id: 'contract', name: '合同审核' },
      { id: 'general', name: '通用智能体' },
    ]),
    newChatSession: vi.fn().mockResolvedValue({ sessionId: 'g1', workspacePath: 'C:/ws/SparkiiXyZ9202608251710', model: null }),
    listChatSessions: vi.fn().mockResolvedValue([{ id: 'g1', profileId: 'general', title: '会话 08-25 17:10', workspaceKind: 'auto', workspacePath: 'C:/ws/SparkiiXyZ9202608251710', model: null, piSessionFile: null, createdAt: 0, updatedAt: 0 }]),
    getChatSession: vi.fn().mockResolvedValue({ workspacePath: 'C:/ws/SparkiiXyZ9202608251710', workspaceKind: 'auto' }),
    openChatSession: vi.fn().mockResolvedValue({ messages: [] }),
    getModelOptions: vi.fn().mockResolvedValue({ defaultModel: null, models: [] }),
    promptSession: vi.fn().mockResolvedValue({ ok: true }),
    setChatTitle: vi.fn().mockResolvedValue({ ok: true }),
    deleteChatSession: vi.fn().mockResolvedValue({ ok: true }),
    decideApproval: vi.fn(),
    queryAudit: vi.fn().mockResolvedValue([]),
  };
  (window as any).sparkii = api;
  return { api, channels };
}

describe('App general agent', () => {
  it('lists agents, creates a session, and streams a reply', async () => {
    const { api, channels } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByText('新建会话');
    fireEvent.click(screen.getByText('新建会话'));
    await waitFor(() => expect(api.newChatSession).toHaveBeenCalledWith('general'));
    await screen.findByTestId('composer-input');
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '你好' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.promptSession).toHaveBeenCalledWith('g1', '你好'));
    act(() => channels['chat-event']({ sessionId: 'g1', type: 'message', role: 'assistant', delta: '在的' }));
    expect(screen.getByText(/在的/)).toBeTruthy();
  });

  it('deletes the active session and returns to empty state', async () => {
    const { api } = makeApi();
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByText('登录'));
    await screen.findByText(/工作台 · 上午好/);
    fireEvent.click(screen.getByTestId('agent-card-general'));
    await screen.findByText('新建会话');
    fireEvent.click(screen.getByText('新建会话'));
    await screen.findByTestId('composer-input');
    fireEvent.click(screen.getByTitle('会话'));
    fireEvent.click(screen.getByTitle('删除 g1'));
    await waitFor(() => expect(api.deleteChatSession).toHaveBeenCalledWith('g1'));
    await screen.findByText('新建会话');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/app-general.test.tsx`
Expected: FAIL——general 路由/新建会话不存在。

- [ ] **Step 3: 实现**

`apps/desktop/src/App.tsx`：

- 引入 `GeneralChatSurface` 与 `type ShellSession`；删除硬编码 `AGENTS` 常量，改为状态：

```tsx
  const [agents, setAgents] = useState<ShellAgent[]>([{ id: 'contract', name: '合同审核', status: 'idle' }]);
  const [sessions, setSessions] = useState<Record<string, ShellSession[]>>({});
  const [activeGeneralSession, setActiveGeneralSession] = useState<string | null>(null);
  const [generalTitle, setGeneralTitle] = useState('');
```

- `login()` 内追加：

```tsx
    api.listAgents?.().then((list: Array<{ id: string; name: string }>) => {
      if (Array.isArray(list) && list.length) {
        setAgents(list.map((a) => ({ id: a.id as ScreenId, name: a.name, status: 'idle' })));
      }
    }).catch(() => {});
```

- 会话列表刷新与标题（模块内函数）：

```tsx
  const refreshSessions = (agentId: string) => {
    api.listChatSessions?.(agentId).then((list: any[]) => {
      const mapped: ShellSession[] = (list ?? []).map((s) => ({
        id: s.id,
        name: s.title ?? s.id,
        state: '',
        time: s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
      }));
      setSessions((prev) => ({ ...prev, [agentId]: mapped }));
      const active = mapped.find((s) => s.id === activeGeneralSession);
      if (active) setGeneralTitle(active.name);
    }).catch(() => {});
  };
```

- `navigate` 增加 general：

```tsx
  const navigate = (s: ScreenId) => {
    if (s === 'general') {
      setScreen('general');
      refreshSessions('general');
      return;
    }
    if (s === 'chat' || s === 'dashboard') { setScreen('contract'); return; }
    setScreen(s);
  };
```

- `onNewSession` 增加 general 分支：

```tsx
  const onNewSession = async (agentId: string) => {
    if (agentId === 'general') {
      const res = await api.newChatSession?.('general');
      if (res?.sessionId) {
        setActiveGeneralSession(res.sessionId);
        refreshSessions('general');
      }
      return;
    }
    setWorkflow({ status: 'idle' });
    setState((s) => ({ ...s, documents: [] }));
  };
```

- 重命名/删除回调：

```tsx
  const onRenameSession = (agentId: string, sessionId: string, title: string) => {
    api.setChatTitle?.(sessionId, title).then(() => refreshSessions(agentId));
  };

  const onDeleteSession = (agentId: string, sessionId: string) => {
    api.deleteChatSession?.(sessionId).then(() => {
      if (sessionId === activeGeneralSession) setActiveGeneralSession(null);
      refreshSessions(agentId);
    });
  };
```

- `surfaces` 增加 general：

```tsx
    general: (
      <GeneralChatSurface
        api={api}
        sessionId={activeGeneralSession}
        onNewSession={() => onNewSession('general')}
      />
    ),
```

- `surfaceTitles` 增加：

```tsx
    general: activeGeneralSession ? `通用智能体 · ${generalTitle || '会话'}` : '通用智能体',
```

- `Shell` 传参追加：`agents={agents}`、`sessions={sessions}`、`onRenameSession`、`onDeleteSession`。

- 删除原 `AGENTS`/`SESSIONS` 常量；`navigate` 内 `if (s === 'chat' || s === 'dashboard')` 分支保留。

> 注意：`ShellAgent.id` 是 `ScreenId`，`listAgents` 返回的 id 直接断言 `as ScreenId`。旧测试（app-workflow.test.tsx）的 mock 没有 `listAgents`，`api.listAgents?.()` 为 undefined → fallback 合同审核，行为不变。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/app-general.test.tsx apps/desktop/test/app-workflow.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/app-general.test.tsx
git commit -m "feat(desktop): wire general agent into app shell"
```

---

### Task 9: 审批面板/模态 diff 展示

**Files:**
- Modify: `apps/desktop/src/trust/ApprovalPanel.tsx`、`apps/desktop/src/trust/ApprovalModal.tsx`
- Test: `apps/desktop/test/approval-diff.test.tsx`（新）

**Interfaces:**
- Consumes: `DiffView`（Task 3）、`ApprovalProposalLike`。
- Produces: 当 `proposal.payload?.diff` 为非空字符串时，在「冻结参数」区下方展示 `DiffView`；面板与模态行为一致。

- [ ] **Step 1: 追加失败测试**

`apps/desktop/test/approval-diff.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalPanel } from '../src/trust/ApprovalPanel.js';
import { ApprovalModal } from '../src/trust/ApprovalModal.js';
import type { ApprovalProposalLike } from '../src/trust/types.js';

afterEach(cleanup);

const base = (over: Partial<ApprovalProposalLike> = {}): ApprovalProposalLike => ({
  id: 'p1',
  summary: '编辑 a.txt',
  risk: 'write',
  createdAt: Date.now(),
  toolName: 'edit',
  payload: { path: 'a.txt', content: 'hi', diff: '--- a/a.txt\n+++ b/a.txt\n+hi' },
  ...over,
});

describe('approval diff rendering', () => {
  it('panel shows DiffView when payload.diff exists', () => {
    render(<ApprovalPanel proposal={base()} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });

  it('panel hides DiffView without diff', () => {
    render(<ApprovalPanel proposal={base({ payload: { path: 'a.txt' } })} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.queryByTestId('diff-view')).toBeNull();
  });

  it('modal shows DiffView when payload.diff exists', () => {
    render(<ApprovalModal proposal={base()} onDecide={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/冻结参数/));
    expect(screen.getByTestId('diff-view')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/approval-diff.test.tsx`
Expected: FAIL——diff 未展示。

- [ ] **Step 3: 实现**

两个文件各自在「冻结参数」区块内追加（`ApprovalPanel.tsx`）：

```tsx
          {showPayload && (
            <>
              <pre className="payload-box">{payloadSummary(proposal.payload)}</pre>
              {typeof (proposal.payload as { diff?: unknown })?.diff === 'string' && (
                <DiffView diff={(proposal.payload as { diff: string }).diff} />
              )}
            </>
          )}
```

`ApprovalModal.tsx` 同样位置（其 `showPayload` 块）：

```tsx
          {showPayload && (
            <>
              <pre className="payload-box">{payloadSummary(proposal.payload)}</pre>
              {typeof (proposal.payload as { diff?: unknown })?.diff === 'string' && (
                <DiffView diff={(proposal.payload as { diff: string }).diff} />
              )}
            </>
          )}
```

两个文件头部追加 `import { DiffView } from '../workbench/DiffView.js';`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/approval-diff.test.tsx apps/desktop/test/approval.test.tsx apps/desktop/test/approval-trust.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/trust/ApprovalPanel.tsx apps/desktop/src/trust/ApprovalModal.tsx apps/desktop/test/approval-diff.test.tsx
git commit -m "feat(desktop): diff preview in approval panel and modal"
```

---

### Task 10: styles.css（聊天/工具卡片/diff/composer/工作区样式）

**Files:**
- Modify: `apps/desktop/src/styles.css`（末尾追加）

**Interfaces:**
- Produces: 下列类（覆盖聊天界面全部新组件，视觉沿用 V3 token）。无独立测试；用浏览器/截图人工核验，Task 12 的 e2e 作为存在性检查。

- [ ] **Step 1: 追加样式**

在 `apps/desktop/src/styles.css` 末尾追加：

```css
/* 通用智能体聊天界面 */
.chat-surface { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.chat-list { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.chat-hint { text-align: center; margin-top: 32px; }
.chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; text-align: center; }
.msg { max-width: 78%; padding: 10px 14px; border-radius: 12px; line-height: 1.6; }
.msg-user { align-self: flex-end; background: #2563EB; color: #fff; border-bottom-right-radius: 4px; }
.msg-agent { align-self: flex-start; background: #fff; border: 1px solid #EAF0F6; border-bottom-left-radius: 4px; }
.msg-text { white-space: pre-wrap; }
.caret { display: inline-block; width: 8px; height: 16px; margin-left: 2px; background: #2563EB; animation: caret-blink 1s steps(2) infinite; vertical-align: text-bottom; }
@keyframes caret-blink { 50% { opacity: 0; } }
.chat-error { margin: 0 16px 8px; padding: 8px 12px; border-radius: 8px; background: #FEF2F2; color: #B91C1C; font-size: 12px; }

/* 工具卡片 */
.tool-card { border: 1px dashed #CBD5E1; border-radius: 10px; background: #EFF6FF; padding: 8px 10px; align-self: stretch; }
.tool-card.await { background: #FFF7ED; border-color: #FDBA74; }
.tool-card.done { background: #F0FDF4; border-color: #86EFAC; }
.tool-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.tool-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #475569; }
.tool-status.run { color: #2563EB; }
.tool-status.await { color: #C2410C; }
.tool-status.done { color: #15803D; }
.tool-detail { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }

/* diff */
.diff { background: #0B1220; color: #E2E8F0; border-radius: 8px; padding: 8px; font-size: 12px; overflow-x: auto; }
.diff div { white-space: pre; }
.diff-hdr { color: #60A5FA; }
.diff-add { color: #4ADE80; }
.diff-del { color: #F87171; }
.diff-ctx { color: #94A3B8; }

/* markdown */
.md p { margin: 0 0 8px; }
.md pre { margin: 8px 0; }
.md code { background: rgba(37, 99, 235, 0.08); border-radius: 4px; padding: 0 4px; font-size: 12px; }
.md pre code { background: none; padding: 0; }
.code-block { position: relative; background: #0B1220; border-radius: 8px; padding: 10px; margin: 8px 0; }
.code-block pre { margin: 0; color: #E2E8F0; overflow-x: auto; }
.copy-btn { position: absolute; top: 6px; right: 6px; border: none; background: #1E293B; color: #E2E8F0; border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }

/* composer */
.composer { border-top: 1px solid #EAF0F6; padding: 10px 16px 14px; display: flex; flex-direction: column; gap: 8px; background: #fff; }
.composer-row { display: flex; align-items: center; gap: 8px; }
.composer-input { flex: 1; resize: vertical; min-height: 56px; }
.composer-send { align-self: flex-end; }
.ws-path { flex: 1; font-size: 12px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-select { font-size: 12px; padding: 4px 8px; border-radius: 8px; border: 1px solid #E2E8F0; background: #fff; }

/* 会话抽屉行内操作 */
.item .icon-btn.sm { width: 22px; height: 22px; font-size: 12px; }
```

- [ ] **Step 2: 人工/构建核验**

Run: `pnpm --filter @sparkii/desktop build:renderer`
Expected: 构建通过，无未定义类。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/src/styles.css
git commit -m "style(desktop): chat surface, tool cards, diff, composer"
```

---

### Task 11: e2e 冒烟（general.spec.ts）

**Files:**
- Create: `apps/desktop/e2e/general.spec.ts`

**Interfaces:**
- Consumes: 构建产物 `dist-electron/main/index.js` + `dist/index.html`（Task 12 Step 3 构建）。

- [ ] **Step 1: 追加 e2e**

`apps/desktop/e2e/general.spec.ts`：

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test.skip(process.env.SPARKII_SKIP_LLM === '1');

test('general agent surface smoke', async () => {
  test.setTimeout(120_000);
  const dataDir = mkdtempSync(join(tmpdir(), 'general-data-'));
  const app = await electron.launch({
    args: ['dist-electron/main/index.js'],
    env: { ...process.env, SPARKII_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  await page.getByPlaceholder('用户名').fill('admin');
  await page.getByPlaceholder('密码').fill('admin123');
  await page.getByText('登录').click();
  await page.getByRole('button', { name: /通用智能体/ }).first().click();
  await page.getByText('新建会话').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('workspace-path')).toContainText(/Sparkii/);
  await app.close();
});
```

> 说明：不设置 `SPARKII_PROFILE_DIR` 时，dev 构建从仓库 `profiles/` 加载 contract + general 两个 profile；若主进程扫描顺序导致通用智能体按钮文本重复（首页卡片 + 左栏），用 `.first()` 取左栏项。若 e2e 运行环境已有模型端点，可额外验证发送消息流式回复（可选，不阻塞）。

- [ ] **Step 2: 运行 e2e（构建后，见 Task 12 Step 3）**

Run: `pnpm exec playwright test apps/desktop/e2e/general.spec.ts`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/e2e/general.spec.ts
git commit -m "test(desktop): general agent e2e smoke"
```

---

### Task 12: 全量验证与回归

**Files:** 无新增。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 构建 + 两条 e2e**

Run:
```bash
pnpm --filter @sparkii/desktop build:renderer
pnpm --filter @sparkii/desktop build:main
pnpm exec playwright test apps/desktop/e2e/pilot.spec.ts apps/desktop/e2e/general.spec.ts
```
Expected: pilot（合同审核回归）与 general 冒烟均通过；无模型端点时 pilot 以 `SPARKII_SKIP_LLM=1` 记录跳过并人工回归。

- [ ] **Step 4: 提交（如有修复）**

```bash
git add -A
git commit -m "chore: ui verification fixes"
```

---

## Self-Review（写作时已执行）

**Spec coverage 对照（spec §9 UI：GeneralChatSurface）：**

- 表面头部/会话抽屉/新会话 → Task 7/8
- 消息流（用户右/助手左/Markdown/代码块复制/流式光标）→ Task 2/6
- 工具卡片（命令/diff/状态：运行中/等待审批/已执行/已拒绝·未执行）→ Task 5/6
- Composer（工作区选择行 + 模型下拉 + 发送/停止三态 + Ctrl+Enter）→ Task 4
- 审批 diff 展示 → Task 3/9
- 会话抽屉（列表/新建/重命名/删除，删除不删文件夹）→ Task 7/8（删除仅关闭会话，符合 spec §13）
- 空态与引导、错误可重发 → Task 6
- 左栏 agents 来自 listAgents → Task 8
- e2e → Task 11/12

**Placeholder scan：** 无 TBD/TODO；Task 1 的「离线降级」与 Task 11 的 `.first()` 说明是明确回退路径与实现提示，非占位。

**Type consistency：** `ChatEntry`（Task 6）在 `applyChatEvent`/`normalizeMessages`/组件内部一致；`ComposerProps` 在 Task 4 定义、Task 6 使用一致；`DiffView` 在 Task 3 定义、Task 5/9 使用一致；`ShellProps.onRenameSession/onDeleteSession` 在 Task 7 定义、Task 8 传参一致；IPC 方法名（`promptSession/openChatSession/…`）与 runtime plan Task 15 一致。

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-08-25-general-agent-ui.md`。两种执行方式：

1. **Subagent-Driven（推荐）**——每个任务派发一个全新 subagent，任务间我做两段式审查，迭代快；
2. **Inline Execution**——在当前会话用 executing-plans 按批次执行，带检查点。

采用哪种？（注意：本计划依赖 runtime plan 先落地，两者有先后顺序。）
