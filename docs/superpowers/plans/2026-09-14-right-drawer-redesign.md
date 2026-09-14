# Right Drawer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the four right-hand drawers onto one chrome and make Runtime Center show agent occupancy and document parse as two separate resources.

**Architecture:** Keep inbox, runtime pool, document-parse, and error-store contracts unchanged. Extend `Drawer` with `size` (`sm` 360; default 420). Drop kickers. Runtime Center becomes two lanes. Agent danger button stays `释放线程`; parse stays `释放`. Approval loses only the count headline. Account becomes identity + inert menu rows. Error actions stick inside the panel.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, existing `@sparkii/ui` tokens and CSS.

**Spec:** `docs/superpowers/specs/2026-09-14-right-drawer-redesign-design.md`

## Global Constraints

- Drawer-visible copy must not include: `两套占用`, `互不影响`, `单独一路`, `情境说明`, `当前会话优先`, `本机账号`, `处改动等你看`, `等待中的文件`, `释放槽位`, `暂无运行中的智能体`, section titles `运行中` / `排队中`, or `Pi` / `OCR` / `worker` / `sidecar` / `Paddle` / `JSON-RPC` / `进程池`.
- Agent button is `释放线程`. Parse idle/resident button is `释放`. Confirm modals may say `释放线程` and `工作进程将被复用`.
- Drawer default width is `420px` on `.ui-drawer`. Account uses `size="sm"` → `.ui-drawer--sm` / `360px`. `max-width: 92%`. Do not add a redundant `.ui-drawer--md`.
- Header is title + close only. Close control is `CloseIcon` with `aria-label="关闭"`. Drawer titles are `span` + `role="dialog"` `aria-label`; query dialogs, not headings, for those titles.
- `Drawer` has no `toolbar` prop. Error-center actions are `position: sticky` inside the panel.
- Do not change approval decide IPC, runtime pool IPC, document-parse supervisor, or error store adapters.
- Status bar stays `运行 {active}/{max} · {queued} 排队` and appends ` · 文档解析进行中` only when parse status is `starting` or `parsing`.
- High-risk approvals stay in the centered modal.
- Account「修改密码」「导出审计记录」are `<button>` rows with no new backend.
- Meter: `idle = max(0, maxAgents - active)`. `aria-label` is `运行 ${active}，排队 ${queued}，空闲 ${idle}`. Visible wait cells = `min(queued, idle)`.
- `parsing` must show visible text `正在解析` (secondary line). Keep `document-parse-copy` `/正在解析/`.

---

### Task 1: Drawer size and close icon

**Files:**
- Modify: `packages/ui/src/primitives/Drawer.tsx`
- Modify: `packages/ui/src/styles.css` (`.ui-drawer` width)
- Test: `apps/desktop/test/ui-overlay.test.tsx`

**Interfaces:**
- Produces: `DrawerSize = 'md' | 'sm'`; `size?: DrawerSize` defaults to `'md'`. `'md'` adds no extra class. `'sm'` adds `ui-drawer--sm`.
- Consumes: `CloseIcon` from `../icons/index.js`.

- [ ] **Step 1: Write the failing test**

Keep the existing backdrop/close test. Add:

```ts
it('drawer defaults to 420 and can be sm', () => {
  const { rerender } = render(<Drawer open title="运行中心" onClose={() => {}}>内容</Drawer>);
  const panel = screen.getByRole('dialog', { name: '运行中心' });
  expect(panel.className).toContain('ui-drawer');
  expect(panel.className).not.toContain('ui-drawer--sm');
  expect(screen.getByLabelText('关闭').querySelector('svg')).toBeTruthy();
  rerender(<Drawer open title="账号" size="sm" onClose={() => {}}>内容</Drawer>);
  expect(screen.getByRole('dialog', { name: '账号' }).className).toContain('ui-drawer--sm');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/ui-overlay.test.tsx`

Expected: FAIL — close button has no svg, or `--sm` is missing.

- [ ] **Step 3: Write minimal implementation**

Import `CloseIcon`. Add `size = 'md'`. Class list: `ui-drawer ${size === 'sm' ? 'ui-drawer--sm' : ''} ${fixed ? 'fixed' : ''} ${className}`. Replace `✕` with `<CloseIcon />`. Keep `aria-label="关闭"`.

CSS: `.ui-drawer { width: 420px; max-width: 92%; }` and `.ui-drawer--sm { width: 360px; }`. Do not add `.ui-drawer--md`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/ui-overlay.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/primitives/Drawer.tsx packages/ui/src/styles.css apps/desktop/test/ui-overlay.test.tsx
git commit -m "feat: size the shared drawer and use CloseIcon"
```

---

### Task 2: Runtime Center two-lane layout

**Files:**
- Modify: `packages/ui/src/patterns/RuntimeCenter.tsx`
- Modify: `packages/ui/src/styles.css` (`.ui-runtime-*`)
- Test: `apps/desktop/test/ui-shell-patterns.test.tsx`
- Test: `apps/desktop/test/document-parse-copy.test.ts`
- Test: `apps/desktop/test/shell.test.tsx`

**Interfaces:**
- Consumes: existing `RuntimePoolSummary`, `DocumentParseSnapshot`, and the six action callbacks.
- Produces: headings `智能体` / `文档解析` only; meter `role="img"` `aria-label={`运行 ${active}，排队 ${queued}，空闲 ${Math.max(0, maxAgents - active)}`}`; agent danger `释放线程`; parse danger `释放`.

- [ ] **Step 1: Rewrite the failing assertions**

In `ui-shell-patterns.test.tsx` replace only the three RuntimeCenter cases (keep StatusBar / AgentNav / Shell cases):

```ts
it('runtime center renders running and queued items and invokes actions', () => {
  const onStop = vi.fn();
  render(
    <RuntimeCenter
      snapshot={{
        active: 1,
        queued: 1,
        maxAgents: 4,
        sessions: [{ sessionId: 's1', profileId: 'general', profileName: '通用智能体', label: '会话#1', status: 'running' }],
        queue: [{ queueId: 'q1', profileId: 'contract-review', profileName: '合同审核', label: '新会话', position: 1 }],
      }}
      onStop={onStop}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
    />,
  );
  expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
  expect(screen.getByRole('img', { name: '运行 1，排队 1，空闲 3' })).toBeTruthy();
  expect(screen.queryByText('运行 1/4 · 排队 1 · 空闲 3')).toBeNull();
  expect(screen.queryByText('运行中')).toBeNull();
  expect(screen.queryByText('排队中')).toBeNull();
  expect(screen.queryByText('暂无运行中的智能体')).toBeNull();
  fireEvent.click(screen.getByText('停止'));
  fireEvent.click(screen.getByText('确认停止'));
  expect(onStop).toHaveBeenCalledWith('s1');
  expect(screen.getByRole('button', { name: '释放线程' })).toBeTruthy();
  expect(screen.getByLabelText('第 1 位')).toBeTruthy();
  expect(screen.queryByText('第 1 位')).toBeNull();
});

it('keeps agent 释放线程 distinct from parse 释放', () => {
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
  expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '文档解析' })).toBeTruthy();
  expect(screen.getByText('暂无智能体占用')).toBeTruthy();
  expect(screen.getByText('空闲')).toBeTruthy();
  expect(screen.getByText('2分钟后释放')).toBeTruthy();
  expect(screen.getByRole('button', { name: '释放' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '释放线程' })).toBeNull();

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
  expect(screen.getByRole('button', { name: '释放线程' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '取消加载' })).toBeTruthy();
  expect(screen.getByText('正在加载')).toBeTruthy();
});

it('shows parsing progress and waiting files without internal names', () => {
  const parse = {
    status: 'parsing' as const,
    fileName: 'scan.pdf',
    agentDisplayName: '合同审核智能体',
    page: 3,
    total: 12,
    waiting: [{ sessionId: 's2', agentDisplayName: '通用智能体', fileName: 'invoice.jpg' }],
  };
  const { container } = render(
    <RuntimeCenter
      snapshot={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
      documentParse={parse}
      onStop={vi.fn()}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
      onStopParse={vi.fn()}
      onReleaseParse={vi.fn()}
      onCancelLoad={vi.fn()}
    />,
  );
  expect(screen.getByText('scan.pdf')).toBeTruthy();
  expect(screen.getByText('正在解析')).toBeTruthy();
  expect(screen.getByText('第 3/12 页')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '解析进度' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '停止解析' })).toBeTruthy();
  expect(screen.queryByText('等待中的文件')).toBeNull();
  expect(screen.getByText('invoice.jpg')).toBeTruthy();
  expect(screen.getByText('通用智能体')).toBeTruthy();
  expect(container.textContent).not.toMatch(/worker|sidecar|OCR|Paddle|JSON-RPC|两套占用|单独一路/i);
});

it('covers stopped, resident, and overflow queue on the meter', () => {
  const { rerender } = render(
    <RuntimeCenter
      snapshot={{ active: 0, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
      documentParse={{ status: 'stopped', waiting: [] }}
      onStop={vi.fn()}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
    />,
  );
  expect(screen.getByText('未启动')).toBeTruthy();

  rerender(
    <RuntimeCenter
      snapshot={{
        active: 4,
        queued: 2,
        maxAgents: 4,
        sessions: [
          { sessionId: 's1', profileId: 'a', profileName: 'A', label: '1', status: 'running' },
          { sessionId: 's2', profileId: 'b', profileName: 'B', label: '2', status: 'running' },
          { sessionId: 's3', profileId: 'c', profileName: 'C', label: '3', status: 'running' },
          { sessionId: 's4', profileId: 'd', profileName: 'D', label: '4', status: 'running' },
        ],
        queue: [
          { queueId: 'q1', profileId: 'e', profileName: 'E', label: '5', position: 1 },
          { queueId: 'q2', profileId: 'f', profileName: 'F', label: '6', position: 2 },
        ],
      }}
      documentParse={{ status: 'resident', waiting: [] }}
      onStop={vi.fn()}
      onRelease={vi.fn()}
      onCancelQueue={vi.fn()}
    />,
  );
  expect(screen.getByText('常驻')).toBeTruthy();
  expect(screen.getByRole('img', { name: '运行 4，排队 2，空闲 0' })).toBeTruthy();
  expect(document.querySelectorAll('.ui-runtime-meter span')).toHaveLength(4);
});
```

In `shell.test.tsx` **edit** `queue panel opens from the status bar...`; do not replace the whole file. Keep 合同审核 / 舆情监控 assertions. Change only:

```ts
expect(screen.getByRole('dialog', { name: '运行中心' })).toBeTruthy();
expect(screen.getByLabelText('第 1 位')).toBeTruthy();
expect(screen.queryByText('第 1 位')).toBeNull();
```

`closes a drawer when clicking outside it` may keep `getByText('运行中心')` — that matches the title `span`.

In `document-parse-copy.test.ts` keep `expect(screen.getByText(/正在解析/))` and the forbidden-name scan. Add `scan.pdf` / `第 3/12 页` if useful. Do not delete `/正在解析/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/ui-shell-patterns.test.tsx test/shell.test.tsx test/document-parse-copy.test.ts`

Expected: FAIL on missing meter / leftover `运行中` / `等待中的文件`.

- [ ] **Step 3: Implement the two lanes**

Two `<section>`s with `<h3>智能体</h3>` / `<h3>文档解析</h3>`.

Meter:

```tsx
const idle = Math.max(0, snapshot.maxAgents - snapshot.active);
const waitCells = Math.min(snapshot.queued, idle);
<div className="ui-runtime-meter" role="img" aria-label={`运行 ${snapshot.active}，排队 ${snapshot.queued}，空闲 ${idle}`}>
  {Array.from({ length: snapshot.maxAgents }, (_, i) => {
    const cls = i < snapshot.active ? 'is-run' : i < snapshot.active + waitCells ? 'is-wait' : '';
    return <span key={i} className={cls} />;
  })}
</div>
```

Map `sessions` then `queue` with no section titles. Queue badge: `<span className="ui-runtime-pos" aria-label={`第 ${q.position} 位`}>{q.position}</span>`. Agent danger label stays `释放线程`.

Parse header action unchanged. Visible parse rows follow spec §8.3 table. `parsing` always renders a node whose text is `正在解析`. Waiting files have no heading.

Delete `.ui-runtime-summary`. Empty agents: `暂无智能体占用`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/ui-shell-patterns.test.tsx test/shell.test.tsx test/document-parse-copy.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/patterns/RuntimeCenter.tsx packages/ui/src/styles.css apps/desktop/test/ui-shell-patterns.test.tsx apps/desktop/test/shell.test.tsx apps/desktop/test/document-parse-copy.test.ts
git commit -m "feat: split runtime center into agent and parse lanes"
```

---

### Task 3: Account drawer

**Files:**
- Modify: `packages/ui/src/patterns/Shell.tsx`
- Modify: `packages/ui/src/styles.css`
- Test: `apps/desktop/test/shell.test.tsx`

**Interfaces:**
- Consumes: `userName`, `userRole`, `ShieldIcon`, `ChevronRightIcon`.
- Produces: `size="sm"` account drawer; two inert `<button type="button">` rows.

- [ ] **Step 1: Write the failing test**

Replace `account drawer shows the current user` in `shell.test.tsx`:

```ts
it('account drawer shows the current user', () => {
  render(<Shell {...makeProps()} />);
  fireEvent.click(screen.getByTitle('账号'));
  const dialog = screen.getByRole('dialog', { name: '账号' });
  expect(dialog.className).toContain('ui-drawer--sm');
  expect(screen.getByText('admin')).toBeTruthy();
  expect(screen.getByText('审核员')).toBeTruthy();
  expect(screen.getByText('本机 · 已加密')).toBeTruthy();
  expect(screen.getByRole('button', { name: '修改密码' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '导出审计记录' })).toBeTruthy();
  expect(screen.queryByText('本机账号')).toBeNull();
  expect(dialog.querySelector('.ui-kv')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/shell.test.tsx`

Expected: FAIL — `.ui-kv` still present.

- [ ] **Step 3: Replace the account body**

```tsx
<Drawer open={drawer === 'account'} title="账号" size="sm" onClose={closeDrawer}>
  <div className="ui-account">
    <div className="ui-account-identity">
      <div className="ui-account-avatar" aria-hidden="true">{userName.trim().slice(0, 1) || '?'}</div>
      <div>
        <div className="ui-account-name">{userName}</div>
        <span className="ui-account-role">{userRole}</span>
      </div>
    </div>
    <div className="ui-account-trust">
      <ShieldIcon />
      <div>
        <div>数据目录</div>
        <b>本机 · 已加密</b>
      </div>
    </div>
    <button type="button" className="ui-account-action">修改密码<ChevronRightIcon /></button>
    <button type="button" className="ui-account-action">导出审计记录<ChevronRightIcon /></button>
  </div>
</Drawer>
```

`ShieldIcon` is already imported in `Shell.tsx`. Add `ChevronRightIcon` to that import. No click handlers.

- [ ] **Step 4: Run the test and make sure it passes**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/shell.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/patterns/Shell.tsx packages/ui/src/styles.css apps/desktop/test/shell.test.tsx
git commit -m "feat: restyle the account drawer identity block"
```

---

### Task 4: Error center chrome

**Files:**
- Modify: `packages/ui/src/patterns/ErrorCenter.tsx`
- Modify: `packages/ui/src/styles.css`
- Test: `apps/desktop/test/error-center-shell.test.tsx`
- Test: `apps/desktop/test/error-center.test.tsx` (only if selectors break)

**Interfaces:**
- Consumes: `useErrors()`, `EmptyState`.
- Produces: sticky `.ui-error-center-actions`; empty `<h3>暂无报错记录</h3>` via `EmptyState`.

- [ ] **Step 1: Write the failing empty-state assertion**

Add to `error-center-shell.test.tsx`. Today the muted div already says「暂无报错记录」; this test fails because that string is not a heading:

```ts
it('shows an empty error drawer without a unread kicker', () => {
  renderShell();
  fireEvent.click(screen.getByRole('button', { name: /报错中心/ }));
  expect(screen.getByRole('dialog', { name: '报错中心' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '暂无报错记录' })).toBeTruthy();
  expect(screen.queryByText(/条未读/)).toBeNull();
});
```

Do not delete the existing mark-all-read tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/error-center-shell.test.tsx`

Expected: FAIL — `getByRole('heading', { name: '暂无报错记录' })` not found. Do not “fix” by deleting the six characters.

- [ ] **Step 3: Restyle the panel**

`import { EmptyState } from '../primitives/EmptyState.js'`. Replace the muted empty div with `<EmptyState title="暂无报错记录" />`. Keep the two action buttons. Add `.ui-error-center-actions { position: sticky; top: 0; background: var(--color-surface); z-index: 1; }`. No header subtitle.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/error-center-shell.test.tsx test/error-center.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/patterns/ErrorCenter.tsx packages/ui/src/styles.css apps/desktop/test/error-center-shell.test.tsx
git commit -m "feat: quiet the error-center drawer chrome"
```

---

### Task 5: Approval drawer without the count headline

**Files:**
- Modify: `apps/desktop/src/trust/ApprovalDrawer.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/test/approval-trust.test.tsx`

**Interfaces:**
- Consumes: `useApprovalInbox`, `ApprovalCard`, `EmptyState` from `@sparkii/ui`.
- Produces: dialog name `需要你确认`; no `处改动等你看`.

- [ ] **Step 1: Update assertions; keep the rest of the file**

In `shows the summary and decides without a note` only add/replace:

```ts
expect(screen.getByRole('dialog', { name: '需要你确认' })).toBeTruthy();
expect(screen.queryByText(/处改动等你看/)).toBeNull();
expect(screen.queryByText('暂无待确认')).toBeNull();
expect(screen.getByText('当前会话')).toBeTruthy();
```

Do **not** delete `reveals payload JSON under 技术细节`, `groups approvals by session...`, or the decide / UUID cases.

Add:

```ts
it('uses the shared drawer and an empty state without a count headline', async () => {
  renderApproval(<ApprovalDrawer open onClose={() => {}} />, []);
  const dialog = screen.getByRole('dialog', { name: '需要你确认' });
  expect(dialog.className).toContain('ui-drawer');
  expect(dialog.className).not.toContain('ui-drawer--sm');
  expect(screen.getByRole('heading', { name: '没有待确认的事项' })).toBeTruthy();
  expect(screen.queryByText(/处改动等你看/)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/approval-trust.test.tsx`

Expected: FAIL — `1 处改动等你看` still present.

- [ ] **Step 3: Remove the queue headline**

Delete `.ui-approval-qhead`. Empty branch: `<EmptyState title="没有待确认的事项" />`. Drop `className="ui-approval-drawer"` if it only existed for width. Delete `.ui-approval-drawer` width and `.ui-approval-qhead` from `apps/desktop/src/styles.css`. Keep session groups and `ApprovalCard`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/approval-trust.test.tsx test/approval-diff.test.tsx test/approval-shell.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/trust/ApprovalDrawer.tsx apps/desktop/src/styles.css apps/desktop/test/approval-trust.test.tsx
git commit -m "feat: drop the approval drawer count headline"
```

---

### Task 6: Regression sweep

**Files:** no new production files unless a leftover assertion forces a one-line fix

- [ ] **Step 1: Run the related suites**

```
pnpm --filter @sparkii/desktop exec vitest run test/ui-overlay.test.tsx test/ui-shell-patterns.test.tsx test/shell.test.tsx test/document-parse-copy.test.ts test/error-center-shell.test.tsx test/error-center.test.tsx test/approval-trust.test.tsx test/approval-diff.test.tsx test/approval-shell.test.tsx
```

Expected: PASS. If a leftover `运行中` / `第 1 位` / `处改动等你看` / `等待中的文件` assertion remains, update that assertion to the spec — do not revert the UI. Do not rename `释放线程` to `释放`.

- [ ] **Step 2: Scan visible copy**

Search `RuntimeCenter.tsx`, `ApprovalDrawer.tsx`, `ErrorCenter.tsx`, and the account block in `Shell.tsx` for the Global Constraints blacklist. Confirm-modal titles that still say `释放线程` / `工作进程` are allowed.

- [ ] **Step 3: Commit only if Step 2 changed files**

```bash
git add -u
git commit -m "fix: finish drawer copy and test leftovers"
```

Skip when the tree is clean.

---

## Self-review

1. **Spec coverage:** Chrome/width → Task 1. Two lanes, meter formula, 释放线程 vs 释放, 正在解析, stopped/resident/overflow → Task 2. Account Shield/Chevron → Task 3. Sticky error actions + heading empty → Task 4. Approval headline only → Task 5. Status bar unchanged → existing tests kept. Old specs cross-linked.
2. **Placeholders:** None.
3. **Types:** `size` default md has no `--md` class; later tasks query `--sm` or its absence.
