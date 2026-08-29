# Chat Detail Level and Timeline Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global three-level chat detail setting and render chat timeline entries through it, with lighter lifecycle and tool visuals.

**Architecture:** Keep all event data intact and add a renderer-side `shouldShowEntry(entry, level)` predicate. Load the global `chatDetailLevel` through the existing `getSettings` IPC path. Keep the change local to settings state, the GeneralChatSurface render loop, and the two visual components.

**Tech Stack:** TypeScript, React, Vitest, Testing Library, Electron IPC, existing Sparkii UI CSS.

**Spec:** `docs/superpowers/specs/2026-08-29-chat-detail-level-and-ui-refinement.md`

## Global Constraints

- Detail levels are exactly `'minimal' | 'standard' | 'debug'`; default is `'standard'`.
- Model change events are hidden in `standard` and shown in `debug`.
- Tool calls are hidden in `minimal` unless they are awaiting approval or carry an error result.
- Tool calls are shown in `standard` and `debug`; `debug` defaults them to expanded.
- Filtering happens at render time. Do not remove entries from `ChatEntry[]`.
- The setting lives in the existing global settings store and the “智能体与运行” pane.
- Historical sessions use the same renderer and require no data migration.

---

### Task 1: Detail-level predicate and unit tests

**Files:**
- Create: `apps/desktop/src/workbench/chat-detail-level.ts`
- Test: `apps/desktop/test/chat-detail-level.test.ts`

**Interfaces:**
- Produces: `ChatDetailLevel`, `CHAT_DETAIL_LEVELS`, `DEFAULT_CHAT_DETAIL_LEVEL`, `isChatDetailLevel`, `chatDetailLevelLabel`, `shouldShowEntry`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/chat-detail-level.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHAT_DETAIL_LEVEL,
  isChatDetailLevel,
  chatDetailLevelLabel,
  shouldShowEntry,
} from '../src/workbench/chat-detail-level.js';

const message = {
  kind: 'message',
  id: 'm1',
  role: 'assistant',
  text: 'hi',
  streaming: false,
} as const;

const event = (event: string, over: Record<string, unknown> = {}) => ({
  kind: 'event',
  id: 'e1',
  event,
  label: event,
  ...over,
}) as any;

const tool = (over: Record<string, unknown> = {}) => ({
  kind: 'tool',
  id: 't1',
  toolName: 'bash',
  input: { command: 'ls' },
  ...over,
}) as any;

describe('chat detail level helpers', () => {
  it('recognizes valid levels and defaults to standard', () => {
    expect(isChatDetailLevel('minimal')).toBe(true);
    expect(isChatDetailLevel('standard')).toBe(true);
    expect(isChatDetailLevel('debug')).toBe(true);
    expect(isChatDetailLevel('verbose')).toBe(false);
    expect(DEFAULT_CHAT_DETAIL_LEVEL).toBe('standard');
  });

  it('returns human readable level labels', () => {
    expect(chatDetailLevelLabel('minimal')).toBe('简洁');
    expect(chatDetailLevelLabel('standard')).toBe('标准');
    expect(chatDetailLevelLabel('debug')).toBe('调试');
  });

  it('always shows messages', () => {
    expect(shouldShowEntry(message as any, 'minimal')).toBe(true);
    expect(shouldShowEntry(message as any, 'standard')).toBe(true);
    expect(shouldShowEntry(message as any, 'debug')).toBe(true);
  });

  it('shows runtime errors at every level and model changes only in debug', () => {
    expect(shouldShowEntry(event('runtime_error'), 'minimal')).toBe(true);
    expect(shouldShowEntry(event('model_change'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('model_change'), 'debug')).toBe(true);
  });

  it('shows standard lifecycle events at standard level but hides debug-only events', () => {
    expect(shouldShowEntry(event('compaction'), 'standard')).toBe(true);
    expect(shouldShowEntry(event('agent_start'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('turn_start'), 'standard')).toBe(false);
    expect(shouldShowEntry(event('agent_start'), 'debug')).toBe(true);
    expect(shouldShowEntry(event('turn_start'), 'debug')).toBe(true);
  });

  it('shows ordinary tools in standard/debug and only important tools in minimal', () => {
    expect(shouldShowEntry(tool(), 'minimal')).toBe(false);
    expect(shouldShowEntry(tool({ awaitingApproval: true }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool({ result: { exitCode: 1 } }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool({ result: { error: 'failed' } }), 'minimal')).toBe(true);
    expect(shouldShowEntry(tool(), 'standard')).toBe(true);
    expect(shouldShowEntry(tool(), 'debug')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/chat-detail-level.test.ts`

Expected: FAIL because `../src/workbench/chat-detail-level.js` does not exist.

- [ ] **Step 3: Write the helper**

Create `apps/desktop/src/workbench/chat-detail-level.ts`:

```ts
import type { ChatEntry, TimelineEventType } from './pi-timeline.js';

export type ChatDetailLevel = 'minimal' | 'standard' | 'debug';

export const CHAT_DETAIL_LEVELS: readonly ChatDetailLevel[] = ['minimal', 'standard', 'debug'] as const;
export const DEFAULT_CHAT_DETAIL_LEVEL: ChatDetailLevel = 'standard';

export function isChatDetailLevel(value: unknown): value is ChatDetailLevel {
  return value === 'minimal' || value === 'standard' || value === 'debug';
}

export function chatDetailLevelLabel(level: ChatDetailLevel): string {
  switch (level) {
    case 'minimal':
      return '简洁';
    case 'standard':
      return '标准';
    case 'debug':
      return '调试';
  }
}

const LEVEL_RANK: Record<ChatDetailLevel, number> = {
  minimal: 0,
  standard: 1,
  debug: 2,
};

const EVENT_MIN_LEVEL: Partial<Record<TimelineEventType, ChatDetailLevel>> = {
  runtime_error: 'minimal',
  compaction_start: 'standard',
  compaction_end: 'standard',
  compaction: 'standard',
  custom_message: 'standard',
  branch_summary: 'standard',
  session_info: 'standard',
  custom: 'standard',
  label: 'standard',
  agent_start: 'debug',
  agent_end: 'debug',
  agent_settled: 'debug',
  turn_start: 'debug',
  turn_end: 'debug',
  model_change: 'debug',
  thinking_level_change: 'debug',
  auto_retry_start: 'debug',
  auto_retry_end: 'debug',
  summarization_retry_scheduled: 'debug',
  summarization_retry_attempt_start: 'debug',
  summarization_retry_finished: 'debug',
};

function toolResultIsImportant(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const rec = result as Record<string, unknown>;
  const exitCode = rec.exitCode;
  if ((typeof exitCode === 'number' && exitCode !== 0) || (typeof exitCode === 'string' && exitCode !== '0')) {
    return true;
  }
  return rec.ok === false || rec.success === false || rec.error !== undefined;
}

export function shouldShowEntry(entry: ChatEntry, level: ChatDetailLevel): boolean {
  if (entry.kind === 'message') return true;

  if (entry.kind === 'tool') {
    if (level === 'minimal') {
      return Boolean(entry.awaitingApproval) || toolResultIsImportant(entry.result);
    }
    return true;
  }

  const min = EVENT_MIN_LEVEL[entry.event] ?? 'debug';
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/chat-detail-level.test.ts`

Expected: PASS

---

### Task 2: Persist and edit the global detail-level setting

**Files:**
- Modify: `apps/desktop/electron/main/settings.ts:7-19`
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Test: `apps/desktop/test/settings-view.test.tsx`

**Interfaces:**
- Consumes: `isChatDetailLevel`, `CHAT_DETAIL_LEVELS`, `chatDetailLevelLabel`, `ChatDetailLevel` from Task 1.
- Produces: `AppSettings.chatDetailLevel` and the saved settings payload field.

- [ ] **Step 1: Add the settings type**

In `apps/desktop/electron/main/settings.ts`, add to `AppSettings`:

```ts
  chatDetailLevel?: 'minimal' | 'standard' | 'debug';
```

- [ ] **Step 2: Wire the SettingsView state**

In `apps/desktop/src/shell/SettingsView.tsx`, add the import:

```ts
import {
  CHAT_DETAIL_LEVELS,
  chatDetailLevelLabel,
  isChatDetailLevel,
  type ChatDetailLevel,
} from '../workbench/chat-detail-level.js';
```

Add state near the other settings state:

```ts
  const [chatDetailLevel, setChatDetailLevel] = useState<ChatDetailLevel>('standard');
```

In the load effect, add after `setQueueEnabled`:

```ts
        if (isChatDetailLevel(s.chatDetailLevel)) setChatDetailLevel(s.chatDetailLevel);
```

In `save()`, include the field:

```ts
    await api.saveSettings({
      activeProviderId: providerId,
      providers: nextCustom,
      defaultModel,
      defaultThinkingLevel,
      routes,
      apiKey,
      maxAgents,
      queueEnabled,
      chatDetailLevel,
    });
```

- [ ] **Step 3: Add the settings row**

Inside the `pane === 'runtime'` block, after the “超出上限时排队” row:

```tsx
          <SettingsRow label="聊天信息详细程度">
            <Select
              data-testid="chat-detail-level-select"
              value={chatDetailLevel}
              onChange={(e) => setChatDetailLevel(e.target.value as ChatDetailLevel)}
            >
              {CHAT_DETAIL_LEVELS.map((level) => (
                <option key={level} value={level}>{chatDetailLevelLabel(level)}</option>
              ))}
            </Select>
          </SettingsRow>
```

- [ ] **Step 4: Add the settings test**

In `apps/desktop/test/settings-view.test.tsx`, add a test:

```tsx
  it('saves the chat detail level from the runtime pane', async () => {
    const saveSettings = vi.fn().mockResolvedValue({});
    render(<SettingsView api={makeApi({ saveSettings })} />);
    await screen.findByText('已加载本机配置');

    fireEvent.click(screen.getByText('智能体与运行'));
    fireEvent.change(screen.getByTestId('chat-detail-level-select'), { target: { value: 'debug' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    const arg = saveSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.chatDetailLevel).toBe('debug');
  });
```

- [ ] **Step 5: Run the settings tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/settings-view.test.tsx test/settings.test.tsx`

Expected: PASS

---

### Task 3: Filter entries and make tool cards level-aware

**Files:**
- Modify: `packages/ui/src/patterns/ToolCard.tsx`
- Modify: `apps/desktop/src/workbench/ToolCard.tsx`
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: `apps/desktop/test/general-chat-surface.test.tsx`

**Interfaces:**
- Consumes: `shouldShowEntry`, `DEFAULT_CHAT_DETAIL_LEVEL`, `isChatDetailLevel`, `ChatDetailLevel` from Task 1.
- Produces: `ToolCardProps.defaultExpanded`, `GeneralChatSurface` render filtering.

- [ ] **Step 1: Add default-open support to the UI tool card**

In `packages/ui/src/patterns/ToolCard.tsx`, change the signature and state:

```tsx
export function ToolCard({
  toolName,
  input,
  result,
  awaitingApproval = false,
  detail,
  summary,
  defaultOpen = false,
}: {
  toolName: string;
  input: unknown;
  result?: unknown;
  awaitingApproval?: boolean;
  detail?: ReactNode;
  summary?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
```

Move the toggle button into the head block:

```tsx
      <div className="ui-tool-card-head">
        <span className="ui-tool-card-icon" aria-hidden="true">{glyph}</span>
        <b className="ui-tool-card-name">{toolName}</b>
        {summary && <span className="ui-tool-card-summary" title={summary}>{summary}</span>}
        <span className={`ui-tool-card-status ui-status-badge ui-status-badge--${status}`}>{statusLabel}</span>
        <button
          type="button"
          className="ui-btn ui-btn--sm ui-btn--ghost ui-tool-card-toggle"
          data-testid="tool-card-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '详情 ▾' : '详情 ▸'}
        </button>
      </div>
      {open && <div className="ui-tool-card-detail">{detail ?? <pre className="ui-payload">{JSON.stringify({ input, result }, null, 2)}</pre>}</div>}
```

- [ ] **Step 2: Pass default-open through the workbench ToolCard**

In `apps/desktop/src/workbench/ToolCard.tsx`, add the prop:

```tsx
export interface ToolCardProps {
  toolName: string;
  input: unknown;
  result?: unknown;
  awaitingApproval?: boolean;
  defaultExpanded?: boolean;
}

export function ToolCard({ toolName, input, result, awaitingApproval, defaultExpanded = false }: ToolCardProps) {
```

Pass it to `UiToolCard`:

```tsx
      summary={summaryOf(toolName, input)}
      detail={typeof diff === 'string' ? <DiffView diff={diff} /> : undefined}
      defaultOpen={defaultExpanded}
    />
```

- [ ] **Step 3: Load and apply the detail level in GeneralChatSurface**

In `apps/desktop/src/surfaces/GeneralChatSurface.tsx`, add imports:

```ts
import {
  DEFAULT_CHAT_DETAIL_LEVEL,
  isChatDetailLevel,
  shouldShowEntry,
  type ChatDetailLevel,
} from '../workbench/chat-detail-level.js';
```

Add state:

```ts
  const [detailLevel, setDetailLevel] = useState<ChatDetailLevel>(DEFAULT_CHAT_DETAIL_LEVEL);
```

Add a load effect near the existing `active` effect:

```ts
  useEffect(() => {
    if (!active) return;
    api.getSettings().then((raw: any) => {
      if (isChatDetailLevel(raw?.chatDetailLevel)) setDetailLevel(raw.chatDetailLevel);
    }).catch(() => {
      // 读取失败时保持默认值，不打断聊天流程
    });
  }, [active, sessionId, draft, api]);
```

Compute visible entries before the return:

```ts
  const visibleEntries = entries.filter((entry) => shouldShowEntry(entry, detailLevel));
```

Replace `entries.map` with `visibleEntries.map`, `entries.length` with `visibleEntries.length`, and pass `defaultExpanded={detailLevel === 'debug'}` to `ToolCard`.

- [ ] **Step 4: Update the GeneralChatSurface test helper**

In `apps/desktop/test/general-chat-surface.test.tsx`, add to `makeApi()`:

```ts
    getSettings: vi.fn().mockResolvedValue({ chatDetailLevel: 'standard' }),
```

Add an integration test:

```tsx
  it('hides model changes in standard detail level', async () => {
    const { api, channels } = makeApi();
    render(<GeneralChatSurface api={api} sessionId="s1" onNewSession={vi.fn()} />);
    await screen.findByText('hi');
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    act(() => channels['chat-event']({
      sessionId: 's1',
      type: 'model_change',
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }));

    expect(screen.queryByText('模型切换')).toBeNull();
  });
```

- [ ] **Step 5: Run the surface and tool tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/general-chat-surface.test.tsx test/tool-card.test.tsx`

Expected: PASS

---

### Task 4: Lighten lifecycle and tool card styles

**Files:**
- Modify: `apps/desktop/src/styles.css:107-116`
- Modify: `packages/ui/src/styles.css:88-98`

**Interfaces:**
- Consumes: existing `LifecycleCard` and `ToolCard` DOM classes.
- Produces: left-aligned lifecycle rail and single-row collapsible tool cards.

- [ ] **Step 1: Replace lifecycle card styles**

In `apps/desktop/src/styles.css`, replace the `.pi-lifecycle-card` block and its status variants:

```css
.pi-lifecycle-card { align-self: flex-start; max-width: min(680px, 92%); width: fit-content; min-width: 0; border: none; border-left: 2px solid var(--color-borderStrong); background: transparent; padding: 1px var(--spacing-xs); display: flex; flex-direction: column; gap: 2px; box-shadow: none; font-size: var(--font-size-xs); color: var(--color-textSecondary); }
.pi-lifecycle-card--running { border-left-color: var(--color-primary); }
.pi-lifecycle-card--ok { border-left-color: var(--color-ok); }
.pi-lifecycle-card--warn { border-left-color: var(--color-warn); color: var(--color-warn); }
.pi-lifecycle-card--error { border-left-color: var(--color-risk); color: var(--color-risk); }
.pi-lifecycle-card-head { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
.pi-lifecycle-card-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-control); background: transparent; color: inherit; flex: none; font-family: var(--font-mono); }
.pi-lifecycle-card-label { color: inherit; font-weight: var(--font-weight-semibold); flex: none; }
.pi-lifecycle-card-status { margin-left: auto; }
.pi-lifecycle-card-detail { color: inherit; opacity: .85; white-space: pre-wrap; overflow-wrap: anywhere; }
```

- [ ] **Step 2: Replace tool card styles**

In `packages/ui/src/styles.css`, replace the `.ui-tool-card` styles:

```css
.ui-tool-card { border: 1px solid var(--color-borderStrong); border-left-width: 3px; border-radius: var(--radius-card); background: var(--color-surface); padding: var(--spacing-xs) var(--spacing-sm); display: flex; flex-direction: column; gap: var(--spacing-xs); align-self: flex-start; width: fit-content; max-width: min(680px, 92%); box-shadow: var(--shadow-card); }
.ui-tool-card--running { border-left-color: var(--color-primary); }
.ui-tool-card--approval { border-left-color: var(--color-warn); background: var(--color-warnBg); }
.ui-tool-card--ok { border-left-color: var(--color-ok); background: var(--color-okBg); }
.ui-tool-card-head { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
.ui-tool-card-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: var(--radius-control); background: var(--color-controlBg); color: var(--color-textSecondary); font-size: var(--font-size-xs); font-family: var(--font-mono); flex: none; }
.ui-tool-card-name { font-family: var(--font-mono); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); color: var(--color-text); flex: none; }
.ui-tool-card-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-textSecondary); font-size: var(--font-size-sm); }
.ui-tool-card-status { margin-left: auto; flex: none; }
.ui-tool-card-toggle { flex: none; height: var(--control-height-sm); padding: 0 var(--spacing-xs); font-size: var(--font-size-xs); }
.ui-tool-card-detail { margin-top: var(--spacing-xs); border-top: 1px dashed var(--color-border); padding-top: var(--spacing-xs); font-size: var(--font-size-sm); max-width: 100%; overflow: hidden; }
```

- [ ] **Step 3: Run the full desktop test suite**

Run: `pnpm --filter @sparkii/desktop exec vitest run`

Expected: PASS, with no existing tests regressed.

---

## Final Verification

- [ ] Run `pnpm --filter @sparkii/desktop exec vitest run` and confirm every test passes.
- [ ] Manually check the “智能体与运行” settings pane loads and saves `chatDetailLevel`.
- [ ] Manually confirm historical chat entries render with the new left-aligned lifecycle rail and collapsed tool cards.
