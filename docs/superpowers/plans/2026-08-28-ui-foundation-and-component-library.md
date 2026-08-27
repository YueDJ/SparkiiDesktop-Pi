# UI 底座与组件库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sparkii Desktop 的前端收敛为一套统一设计令牌 + React 组件库，并迁移现有全部表面，消除按钮、composer、状态点等不一致，为后续智能体扩展提供可复用底座。

**Architecture:** 保留 `@sparkii/theme` 作为唯一 token 源，新增 `@sparkii/ui` workspace 包承载基础组件、图标和业务模式组件。`apps/desktop` 改为消费 `@sparkii/ui`，删除旧的全局 `styles.css` 大文件，只保留应用级最小样式。composer 的模型/思考强度采用 Codex 风格的单一组合控制按钮，点开两行菜单，每行箭头进入对应设置。

**Tech Stack:** React 19 + TypeScript（strict，ESM，相对导入带 `.js` 后缀）、pnpm workspace、Vitest + Testing Library（jsdom）、Vite。不新增第三方大型 UI 框架。

**Spec:** [2026-08-28-ui-foundation-and-component-library-design.md](../specs/2026-08-28-ui-foundation-and-component-library-design.md)

## Global Constraints

- ESM + strict TS；`apps/desktop/src` 代码不使用分号，`packages/*` 代码可使用分号，但相对导入均带 `.js` 后缀。
- 所有 UI 颜色、圆角、阴影、间距、控件高度只从 `@sparkii/theme` 生成的 CSS 变量取，禁止新增硬编码十六进制颜色。
- 组件库类名使用 `ui-` 前缀，业务模式组件类名也以 `ui-` 开头；应用侧迁移后不再依赖旧的 `.btn`、`.icon-btn`、`.agent` 等类。
- 用户可见文案简体中文。
- 保持现有 `data-testid` 不丢失；若迁移导致类名变化，优先改实现保持 `data-testid`，不轻易改测试定位。
- 空闲状态不显示状态圆点；只有运行中、排队、等待审批、失败等真实状态才出现语义状态。
- 每个任务一次提交，提交信息前缀 `feat` / `refactor` / `test` / `docs` / `style` / `chore`。
- 测试运行从仓库根执行；组件测试用 `@testing-library/react`，不要依赖真实 IPC。

---

## File Structure

**packages/theme/**
- `src/tokens.ts`：扩展 token 组与 `cssVariables`。
- `src/sparkii.ts`：扩展 light/dark token 值。
- `test/tokens.test.ts`、`test/sparkii.test.ts`：更新断言。

**packages/ui/**
- `package.json`、`tsconfig.json`、`src/index.ts`、`src/styles.css`。
- `src/primitives/`：Button、IconButton、Badge、StatusBadge、Tag、Card、TextField、TextArea、Select、Switch、Tabs、ListRow、EmptyState、Toolbar、Divider、Spinner、Toast、Drawer、Modal、Menu。
- `src/icons/index.tsx`：统一图标。
- `src/patterns/`：AgentNav、SessionList、StatusBar、Shell、ChatMessage、ToolCard、ModelEffortControl、ChatComposer、WorkflowSteps、RiskBadge、Countdown、ApprovalItem、AuditTimeline、SettingsLayout、SettingsRow。

**apps/desktop/**
- `package.json`：增加 `@sparkii/ui` 依赖。
- `src/main.tsx`：改为引入 `@sparkii/ui/styles.css`。
- `src/shell/theme.ts`：继续负责注入 token，但不再重复维护全局组件样式。
- `src/shell/Shell.tsx`、`src/App.tsx`、`src/surfaces/*.tsx`、`src/workbench/*.tsx`、`src/trust/*.tsx`、`src/audit/*.tsx`、`src/composer/*.tsx`：迁移到 `@sparkii/ui`。
- `src/styles.css`：最终只保留应用级最小样式；旧类删除。
- `test/ui-*.test.tsx`：组件库与迁移后的行为测试。

---

### Task 1: 扩展设计令牌

**Files:**
- Modify: `packages/theme/src/tokens.ts`
- Modify: `packages/theme/src/sparkii.ts`
- Test: `packages/theme/test/tokens.test.ts`、`packages/theme/test/sparkii.test.ts`

**Interfaces:**
- Produces: `DesignTokens` 增加 `control`、`motion`、`z` 三组；`spacing` 增加 `lg`、`xl`；`font` 增加字号和字重；`color` 增加控件、禁用、focus、语义边框 token。

- [ ] **Step 1: 写失败测试**

`packages/theme/test/tokens.test.ts` 替换为：

```ts
import { describe, it, expect } from 'vitest';
import { resolveTheme, cssVariables } from '../src/tokens.js';

const full = {
  color: { primary: '#111' },
  spacing: { md: '8px' },
  radius: { md: '6px' },
  shadow: { md: '0 1px 2px' },
  font: { body: 'sans-serif', 'size-sm': '12px' },
  control: { 'height-md': '34px' },
  motion: { normal: '180ms' },
  z: { modal: '50' },
};

describe('theme tokens', () => {
  it('resolves tokens and emits css variables', () => {
    const tokens = resolveTheme(full);
    expect(cssVariables(tokens)).toContain('--color-primary: #111');
    expect(cssVariables(tokens)).toContain('--control-height-md: 34px');
    expect(cssVariables(tokens)).toContain('--motion-normal: 180ms');
    expect(cssVariables(tokens)).toContain('--z-modal: 50');
  });

  it('rejects missing token group', () => {
    expect(() => resolveTheme({ color: {} })).toThrow(/THEME_INVALID/);
  });
});
```

`packages/theme/test/sparkii.test.ts` 增加断言：

```ts
  it('carries component, motion and z-index tokens', () => {
    expect(sparkiiLight.control['height-md']).toBe('34px');
    expect(sparkiiLight.motion.normal).toBe('180ms');
    expect(sparkiiLight.z.modal).toBe('50');
    expect(sparkiiLight.font['size-sm']).toBe('12px');
    expect(sparkiiLight.color.controlBorder).toBe('#E2E8F0');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run packages/theme/test/tokens.test.ts packages/theme/test/sparkii.test.ts`
Expected: FAIL（`control`/`motion`/`z` 未定义）

- [ ] **Step 3: 实现**

`packages/theme/src/tokens.ts`：

```ts
export interface DesignTokens {
  color: Record<string, string>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  shadow: Record<string, string>;
  font: Record<string, string>;
  control: Record<string, string>;
  motion: Record<string, string>;
  z: Record<string, string>;
}

const groups = ['color', 'spacing', 'radius', 'shadow', 'font', 'control', 'motion', 'z'] as const;

export function resolveTheme(raw: unknown): DesignTokens {
  if (!raw || typeof raw !== 'object') throw new Error('THEME_INVALID: theme must be an object');
  for (const g of groups) {
    if (!(raw as any)[g] || typeof (raw as any)[g] !== 'object') throw new Error(`THEME_INVALID: missing ${g}`);
  }
  return raw as DesignTokens;
}

export function cssVariables(tokens: DesignTokens, selector: ':root' | '.dark' = ':root'): string {
  const vars: string[] = [];
  for (const g of groups) {
    for (const [k, v] of Object.entries(tokens[g])) vars.push(`--${g}-${k}: ${v}`);
  }
  return `${selector} { ${vars.join('; ')}; }`;
}
```

`packages/theme/src/sparkii.ts` 的 `base` 替换为：

```ts
const base = {
  spacing: { xxs: '4px', xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '24px' },
  radius: { control: '8px', button: '10px', card: '12px', overlay: '14px', pill: '999px' },
  shadow: { card: '0 2px 8px rgba(15,23,42,.04)', overlay: '0 8px 24px rgba(15,23,42,.12)' },
  font: {
    body: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    'size-xs': '11px', 'size-sm': '12px', 'size-md': '13px', 'size-lg': '14px',
    'size-xl': '15px', 'size-2xl': '18px', 'size-3xl': '22px',
    'weight-normal': '400', 'weight-medium': '500', 'weight-semibold': '600', 'weight-bold': '700',
  },
  control: {
    'height-sm': '28px', 'height-md': '34px', 'height-lg': '40px',
    'icon-sm': '28px', 'icon-md': '34px', 'icon-lg': '40px', 'textarea-min': '64px',
  },
  motion: { fast: '120ms', normal: '180ms', slow: '240ms', ease: 'ease-out' },
  z: { base: '0', dropdown: '30', drawer: '40', modal: '50', toast: '60' },
};
```

`sparkiiLight.color` 增加：

```ts
    controlBg: '#F8FAFE',
    controlBorder: '#E2E8F0',
    controlBorderHover: '#CBD5E1',
    controlFocusRing: 'rgba(37,99,235,.24)',
    disabled: '#CBD5E1',
    disabledBg: '#F1F5F9',
    primaryActive: '#1E40AF',
    riskBorder: '#FECACA',
    warnBorder: '#FED7AA',
    okBorder: '#BBF7D0',
```

`sparkiiDark.color` 增加：

```ts
    controlBg: '#0F172A',
    controlBorder: '#28364A',
    controlBorderHover: '#3B4A63',
    controlFocusRing: 'rgba(96,165,250,.28)',
    disabled: '#475569',
    disabledBg: '#1E293B',
    primaryActive: '#2563EB',
    riskBorder: 'rgba(248,113,113,.32)',
    warnBorder: 'rgba(251,191,36,.32)',
    okBorder: 'rgba(74,222,128,.32)',
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run packages/theme/test/tokens.test.ts packages/theme/test/sparkii.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/theme/src/tokens.ts packages/theme/src/sparkii.ts packages/theme/test/tokens.test.ts packages/theme/test/sparkii.test.ts
git commit -m "feat(theme): extend design tokens for component library"
```

---

### Task 2: 创建 @sparkii/ui 包、全局样式与第一组基础组件

**Files:**
- Create: `packages/ui/package.json`、`packages/ui/tsconfig.json`、`packages/ui/src/index.ts`、`packages/ui/src/styles.css`
- Create: `packages/ui/src/primitives/Button.tsx`、`IconButton.tsx`、`Badge.tsx`、`StatusBadge.tsx`、`Tag.tsx`、`Card.tsx`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/test/ui-primitives.test.tsx`（新）

**Interfaces:**
- Produces:
  - `Button({ variant?, size?, loading?, icon?, ...buttonProps })`
  - `IconButton({ size?, label, ...buttonProps })`
  - `Badge({ children })`
  - `StatusBadge({ status })`
  - `Tag({ children })`
  - `Card({ children, className })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-primitives.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button, IconButton, Badge, StatusBadge, Tag, Card } from '@sparkii/ui';

describe('ui primitives', () => {
  it('renders button variants and sizes', () => {
    render(<Button variant="primary" size="lg" data-testid="b">发送</Button>);
    expect(screen.getByTestId('b').className).toContain('ui-btn--primary');
    expect(screen.getByTestId('b').className).toContain('ui-btn--lg');
  });

  it('renders an icon button with an accessible name', () => {
    render(<IconButton label="设置" data-testid="icon">⚙</IconButton>);
    expect(screen.getByTestId('icon').getAttribute('aria-label')).toBe('设置');
  });

  it('renders status badge semantic class', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText('运行中').className).toContain('ui-status-badge--running');
  });

  it('renders badge, tag and card', () => {
    render(<><Badge>3</Badge><Tag>本地</Tag><Card data-testid="card">内容</Card></>);
    expect(screen.getByText('3').className).toContain('ui-badge');
    expect(screen.getByText('本地').className).toContain('ui-tag');
    expect(screen.getByTestId('card').className).toContain('ui-card');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-primitives.test.tsx`
Expected: FAIL（`@sparkii/ui` 不存在）

- [ ] **Step 3: 创建包配置**

`packages/ui/package.json`：

```json
{
  "name": "@sparkii/ui",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@sparkii/theme": "workspace:*" },
  "peerDependencies": { "react": "^19.2.8", "react-dom": "^19.2.8" },
  "devDependencies": {
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.5",
    "typescript": "^6.0.3"
  }
}
```

`packages/ui/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["react", "react-dom"],
    "noEmit": true
  },
  "include": ["src"]
}
```

在 `apps/desktop/package.json` 的 `dependencies` 增加 `"@sparkii/ui": "workspace:*"`，然后运行 `pnpm install`。

- [ ] **Step 4: 实现组件**

`packages/ui/src/primitives/Button.tsx`：

```tsx
import { type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, children, className = '', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`ui-btn ui-btn--${variant} ui-btn--${size} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="ui-spinner" /> : icon}
      {children}
    </button>
  );
}
```

`packages/ui/src/primitives/IconButton.tsx`：

```tsx
import { type ButtonHTMLAttributes } from 'react';
import { Button, type ButtonSize } from './Button.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  size?: ButtonSize;
}

export function IconButton({ label, size = 'md', className = '', ...rest }: IconButtonProps) {
  return (
    <Button variant="ghost" size={size} className={`ui-icon-btn ${className}`} aria-label={label} title={label} {...rest} />
  );
}
```

`packages/ui/src/primitives/Badge.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Badge({ children }: { children: ReactNode }) {
  return <span className="ui-badge">{children}</span>;
}
```

`packages/ui/src/primitives/StatusBadge.tsx`：

```tsx
export type UiStatus = 'running' | 'queued' | 'approval' | 'ok' | 'fail';

const LABELS: Record<UiStatus, string> = {
  running: '运行中',
  queued: '排队',
  approval: '等待审批',
  ok: '完成',
  fail: '失败',
};

export function StatusBadge({ status }: { status: UiStatus }) {
  return <span className={`ui-status-badge ui-status-badge--${status}`}>{LABELS[status]}</span>;
}
```

`packages/ui/src/primitives/Tag.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Tag({ children }: { children: ReactNode }) {
  return <span className="ui-tag">{children}</span>;
}
```

`packages/ui/src/primitives/Card.tsx`：

```tsx
import type { HTMLAttributes } from 'react';

export function Card({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card ${className}`} {...rest}>{children}</div>;
}
```

`packages/ui/src/index.ts`：

```ts
export * from './primitives/Button.js';
export * from './primitives/IconButton.js';
export * from './primitives/Badge.js';
export * from './primitives/StatusBadge.js';
export * from './primitives/Tag.js';
export * from './primitives/Card.js';
```

- [ ] **Step 5: 添加基础样式**

在 `packages/ui/src/styles.css` 写入全局 reset 和第一组样式：

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body { margin: 0; font: var(--font-size-md)/1.5 var(--font-body); color: var(--color-text); background: var(--color-bg); }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }

.ui-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--spacing-xs);
  border: 1px solid var(--color-controlBorder); border-radius: var(--radius-button);
  background: var(--color-surface); color: var(--color-text); cursor: pointer;
  font-size: var(--font-size-md); font-weight: var(--font-weight-medium);
  transition: background var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
}
.ui-btn:hover { background: var(--color-controlBg); border-color: var(--color-controlBorderHover); }
.ui-btn:disabled { opacity: .55; cursor: not-allowed; }
.ui-btn--sm { height: var(--control-height-sm); padding: 0 var(--spacing-xs); font-size: var(--font-size-sm); }
.ui-btn--md { height: var(--control-height-md); padding: 0 var(--spacing-sm); }
.ui-btn--lg { height: var(--control-height-lg); padding: 0 var(--spacing-md); }
.ui-btn--primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.ui-btn--primary:hover { background: var(--color-primaryHover); }
.ui-btn--ghost { border-color: transparent; background: transparent; }
.ui-btn--ghost:hover { background: var(--color-primaryBg); }
.ui-btn--danger { color: var(--color-risk); border-color: var(--color-riskBorder); }

.ui-icon-btn { padding: 0; width: var(--control-height-md); }
.ui-icon-btn.ui-btn--sm { width: var(--control-height-sm); }
.ui-icon-btn.ui-btn--lg { width: var(--control-height-lg); }

.ui-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 6px; border-radius: var(--radius-pill); background: var(--color-warn); color: #fff; font-size: var(--font-size-xs); }
.ui-status-badge { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: var(--radius-pill); font-size: var(--font-size-xs); border: 1px solid transparent; }
.ui-status-badge--running { background: var(--color-primaryBg); color: var(--color-primary); border-color: var(--color-primary); }
.ui-status-badge--queued { background: var(--color-warnBg); color: var(--color-warn); border-color: var(--color-warnBorder); }
.ui-status-badge--approval { background: var(--color-warnBg); color: var(--color-warn); border-color: var(--color-warnBorder); }
.ui-status-badge--ok { background: var(--color-okBg); color: var(--color-ok); border-color: var(--color-okBorder); }
.ui-status-badge--fail { background: var(--color-riskBg); color: var(--color-risk); border-color: var(--color-riskBorder); }
.ui-tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-pill); background: var(--color-controlBg); color: var(--color-textSecondary); font-size: var(--font-size-xs); }
.ui-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-card); box-shadow: var(--shadow-card); padding: var(--spacing-md); }
.ui-spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: ui-spin 600ms linear infinite; }
@keyframes ui-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-primitives.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/ui apps/desktop/package.json pnpm-lock.yaml apps/desktop/test/ui-primitives.test.tsx
git commit -m "feat(ui): create component library primitives"
```

---

### Task 3: 表单、布局与反馈基础组件

**Files:**
- Create: `packages/ui/src/primitives/TextField.tsx`、`TextArea.tsx`、`Select.tsx`、`Switch.tsx`、`Tabs.tsx`、`ListRow.tsx`、`EmptyState.tsx`、`Toolbar.tsx`、`Divider.tsx`、`Toast.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-form.test.tsx`（新）

**Interfaces:**
- Produces:
  - `TextField(props: InputHTMLAttributes<HTMLInputElement>)`
  - `TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>)`
  - `Select(props: SelectHTMLAttributes<HTMLSelectElement>)`
  - `Switch({ checked, onCheckedChange, label })`
  - `Tabs({ tabs, active, onChange })`
  - `ListRow({ current?, trailing?, children, ...divProps })`
  - `EmptyState({ title, description, action? })`
  - `Toolbar({ children })`、`Divider()`
  - `Toast({ children })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-form.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextField, TextArea, Select, Switch, Tabs, EmptyState, Toolbar, Divider } from '@sparkii/ui';

describe('ui form and layout primitives', () => {
  it('renders text, textarea and select controls', () => {
    render(<><TextField data-testid="t" placeholder="输入" /><TextArea data-testid="a" /><Select data-testid="s"><option value="x">X</option></Select></>);
    expect(screen.getByTestId('t').className).toContain('ui-field');
    expect(screen.getByTestId('a').className).toContain('ui-textarea');
    expect(screen.getByTestId('s').className).toContain('ui-select');
  });

  it('switch reports boolean changes', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="本地" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('tabs exposes active tab', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} active="a" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders empty state, toolbar and divider', () => {
    render(<><EmptyState title="暂无会话" description="开始一个" /><Toolbar><span>x</span></Toolbar><Divider /></>);
    expect(screen.getByText('暂无会话')).toBeTruthy();
    expect(screen.getByText('x').parentElement?.className).toContain('ui-toolbar');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-form.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现组件**

`TextField.tsx`：

```tsx
import type { InputHTMLAttributes } from 'react';

export function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`ui-field ${props.className ?? ''}`} {...props} />;
}
```

`TextArea.tsx`：

```tsx
import type { TextareaHTMLAttributes } from 'react';

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`ui-textarea ${props.className ?? ''}`} {...props} />;
}
```

`Select.tsx`：

```tsx
import type { SelectHTMLAttributes } from 'react';

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`ui-select ${props.className ?? ''}`} {...props} />;
}
```

`Switch.tsx`：

```tsx
export function Switch({ checked, onCheckedChange, label }: { checked: boolean; onCheckedChange(next: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`ui-switch ${checked ? 'on' : ''}`} onClick={() => onCheckedChange(!checked)} />
  );
}
```

`Tabs.tsx`：

```tsx
export interface TabItem { id: string; label: string; }
export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange(id: string): void }) {
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={`ui-tab ${t.id === active ? 'on' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}
```

`ListRow.tsx`：

```tsx
import type { HTMLAttributes, ReactNode } from 'react';

export function ListRow({ current = false, trailing, children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { current?: boolean; trailing?: ReactNode }) {
  return <div className={`ui-list-row ${current ? 'current' : ''} ${className}`} {...rest}>{children}{trailing}</div>;
}
```

`EmptyState.tsx`：

```tsx
import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="ui-empty"><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
```

`Toolbar.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="ui-toolbar">{children}</div>;
}
```

`Divider.tsx`：

```tsx
export function Divider() {
  return <hr className="ui-divider" />;
}
```

`Toast.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Toast({ children }: { children: ReactNode }) {
  return <div className="ui-toast" role="status">{children}</div>;
}
```

更新 `index.ts`，追加：

```ts
export * from './primitives/TextField.js';
export * from './primitives/TextArea.js';
export * from './primitives/Select.js';
export * from './primitives/Switch.js';
export * from './primitives/Tabs.js';
export * from './primitives/ListRow.js';
export * from './primitives/EmptyState.js';
export * from './primitives/Toolbar.js';
export * from './primitives/Divider.js';
export * from './primitives/Toast.js';
```

- [ ] **Step 4: 添加样式**

`packages/ui/src/styles.css` 末尾追加：

```css
.ui-field, .ui-textarea, .ui-select {
  height: var(--control-height-md); border: 1px solid var(--color-controlBorder); border-radius: var(--radius-control);
  background: var(--color-controlBg); color: var(--color-text); font-size: var(--font-size-md); padding: 0 var(--spacing-sm);
}
.ui-field:focus, .ui-textarea:focus, .ui-select:focus { border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-controlFocusRing); outline: none; }
.ui-textarea { height: auto; min-height: var(--control-textarea-min); padding-top: var(--spacing-xs); resize: vertical; }
.ui-switch { width: 36px; height: 21px; border-radius: var(--radius-pill); background: var(--color-controlBorder); position: relative; border: none; cursor: pointer; padding: 0; }
.ui-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: left var(--motion-fast) var(--motion-ease); }
.ui-switch.on { background: var(--color-primary); }
.ui-switch.on::after { left: 17px; }
.ui-tabs { display: flex; gap: var(--spacing-xs); border-bottom: 1px solid var(--color-border); }
.ui-tab { padding: 0 var(--spacing-sm); height: var(--control-height-md); border: none; background: none; color: var(--color-textSecondary); cursor: pointer; border-bottom: 2px solid transparent; }
.ui-tab.on { color: var(--color-primary); border-bottom-color: var(--color-primary); font-weight: var(--font-weight-semibold); }
.ui-list-row { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 40px; padding: var(--spacing-xs) var(--spacing-sm); border: none; background: none; color: var(--color-text); }
.ui-list-row.current { background: var(--color-primaryBg); border-radius: var(--radius-control); }
.ui-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--spacing-sm); padding: var(--spacing-xl); color: var(--color-textSecondary); text-align: center; }
.ui-toolbar { display: flex; align-items: center; gap: var(--spacing-xs); }
.ui-divider { border: 0; border-top: 1px solid var(--color-border); margin: var(--spacing-sm) 0; }
.ui-toast { position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); background: #0F172A; color: #fff; border-radius: var(--radius-pill); padding: var(--spacing-xs) var(--spacing-md); font-size: var(--font-size-sm); box-shadow: var(--shadow-overlay); z-index: var(--z-toast); }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-form.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src apps/desktop/test/ui-form.test.tsx
git commit -m "feat(ui): add form layout and feedback primitives"
```

---

### Task 4: 弹层组件与菜单

**Files:**
- Create: `packages/ui/src/primitives/Drawer.tsx`、`Modal.tsx`、`Menu.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-overlay.test.tsx`（新）

**Interfaces:**
- Produces:
  - `Drawer({ open, title, onClose, children, fixed? })`
  - `Modal({ open, title, onClose, children })`
  - `Menu({ open, onClose, children })`
  - `MenuItem({ label, hint, onSelect, trailing? })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-overlay.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Drawer, Modal, Menu, MenuItem } from '@sparkii/ui';

describe('ui overlays and menu', () => {
  it('drawer closes on backdrop and close button', () => {
    const onClose = vi.fn();
    render(<Drawer open title="会话" onClose={onClose}>内容</Drawer>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('menu item shows hint and calls select', () => {
    const onSelect = vi.fn();
    render(<Menu open onClose={vi.fn()}><MenuItem label="模型" hint="deepseek-v4-pro" onSelect={onSelect} /></Menu>);
    expect(screen.getByText('deepseek-v4-pro')).toBeTruthy();
    fireEvent.click(screen.getByText('模型'));
    expect(onSelect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-overlay.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`Drawer.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Drawer({ open, title, onClose, children, fixed = false }: { open: boolean; title: string; onClose(): void; children: ReactNode; fixed?: boolean }) {
  if (!open) return null;
  return (
    <>
      <button type="button" className={`ui-drawer-backdrop ${fixed ? 'fixed' : ''}`} data-testid="drawer-backdrop" aria-label="关闭面板" onClick={onClose} />
      <aside className={`ui-drawer ${fixed ? 'fixed' : ''}`} role="dialog" aria-label={title}>
        <div className="ui-drawer-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>
  );
}
```

`Modal.tsx`：

```tsx
import type { ReactNode } from 'react';

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose(): void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="ui-modal-mask open">
      <div className="ui-modal" role="dialog" aria-label={title}>
        <div className="ui-modal-head"><span>{title}</span><button type="button" className="ui-icon-btn" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>
  );
}
```

`Menu.tsx`：

```tsx
import { useEffect, type ReactNode } from 'react';

export function Menu({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="ui-menu" role="menu">{children}</div>;
}

export function MenuItem({ label, hint, onSelect, trailing = '›' }: { label: string; hint?: string; onSelect(): void; trailing?: ReactNode }) {
  return (
    <button type="button" role="menuitem" className="ui-menu-item" onClick={onSelect}>
      <span>{label}</span>
      {hint && <span className="ui-menu-item-hint">{hint}</span>}
      <span className="ui-menu-item-chevron">{trailing}</span>
    </button>
  );
}
```

更新 `index.ts` 追加：

```ts
export * from './primitives/Drawer.js';
export * from './primitives/Modal.js';
export * from './primitives/Menu.js';
```

- [ ] **Step 4: 添加样式**

`packages/ui/src/styles.css` 末尾追加：

```css
.ui-drawer-backdrop { position: absolute; inset: 0; border: none; background: transparent; z-index: var(--z-drawer); cursor: default; }
.ui-drawer-backdrop.fixed { position: fixed; }
.ui-drawer { position: absolute; top: 0; bottom: 0; right: 0; width: 320px; max-width: 92%; background: var(--color-surface); border-left: 1px solid var(--color-borderStrong); box-shadow: var(--shadow-overlay); z-index: var(--z-drawer); display: flex; flex-direction: column; }
.ui-drawer.fixed { position: fixed; }
.ui-drawer-head, .ui-modal-head { display: flex; justify-content: space-between; align-items: center; padding: var(--spacing-sm) var(--spacing-md); border-bottom: 1px solid var(--color-border); font-weight: var(--font-weight-semibold); }
.ui-drawer-body, .ui-modal-body { padding: var(--spacing-sm) var(--spacing-md); overflow: auto; flex: 1; }
.ui-modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.32); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); }
.ui-modal { width: 420px; max-width: 92%; background: var(--color-surface); border-radius: var(--radius-overlay); box-shadow: var(--shadow-overlay); }
.ui-menu { min-width: 220px; background: var(--color-surface); border: 1px solid var(--color-borderStrong); border-radius: var(--radius-card); box-shadow: var(--shadow-overlay); padding: var(--spacing-xs); z-index: var(--z-dropdown); }
.ui-menu-item { display: flex; align-items: center; width: 100%; gap: var(--spacing-xs); padding: var(--spacing-xs) var(--spacing-sm); border: none; background: none; color: var(--color-text); border-radius: var(--radius-control); cursor: pointer; }
.ui-menu-item:hover { background: var(--color-primaryBg); }
.ui-menu-item-hint { margin-left: auto; color: var(--color-textMuted); font-size: var(--font-size-sm); }
.ui-menu-item-chevron { color: var(--color-textMuted); }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-overlay.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src apps/desktop/test/ui-overlay.test.tsx
git commit -m "feat(ui): add overlay and menu primitives"
```

---

### Task 5: 图标库

**Files:**
- Create: `packages/ui/src/icons/index.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-icons.test.tsx`（新）

**Interfaces:**
- Produces: `IconProps` 与 `SessionsIcon`、`PlusIcon`、`SendIcon`、`StopIcon`、`ClipIcon`、`GearIcon`、`MoonIcon`、`SunIcon`、`UserIcon`、`HomeIcon`、`ShieldIcon`、`AuditIcon`、`CloseIcon`、`ChevronDownIcon`、`ChevronRightIcon`、`SearchIcon`、`CheckIcon`、`WarningIcon`、`InfoIcon`。

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-icons.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SendIcon, ChevronDownIcon } from '@sparkii/ui';

describe('ui icons', () => {
  it('renders stroke-based icons with currentColor', () => {
    const { container } = render(<><SendIcon /><ChevronDownIcon /></>);
    expect(container.querySelectorAll('svg').length).toBe(2);
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-icons.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`packages/ui/src/icons/index.tsx`：

1. 把现有 `apps/desktop/src/shell/icons.tsx` 中的 `IconProps`、`base` 以及 `SessionsIcon`、`PlusIcon`、`SendIcon`、`StopIcon`、`ClipIcon`、`GearIcon`、`MoonIcon`、`SunIcon`、`UserIcon`、`HomeIcon`、`ShieldIcon`、`AuditIcon` 原样复制到新文件。
2. 把 `base` 的 `width`/`height` 改为 `16`，确保 `stroke="currentColor"`、`aria-hidden: true`。
3. 在文件末尾追加以下组件：

```tsx
export function ChevronDownIcon(p: IconProps) {
  return <svg {...base} {...p}><polyline points="6 9 12 15 18 9" /></svg>;
}
export function ChevronRightIcon(p: IconProps) {
  return <svg {...base} {...p}><polyline points="9 18 15 12 9 6" /></svg>;
}
export function CloseIcon(p: IconProps) {
  return <svg {...base} {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
}
export function SearchIcon(p: IconProps) {
  return <svg {...base} {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
}
export function CheckIcon(p: IconProps) {
  return <svg {...base} {...p}><polyline points="20 6 9 17 4 12" /></svg>;
}
export function WarningIcon(p: IconProps) {
  return <svg {...base} {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
}
export function InfoIcon(p: IconProps) {
  return <svg {...base} {...p}><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>;
}
```

更新 `index.ts` 追加 `export * from './icons/index.js';`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-icons.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/icons packages/ui/src/index.ts apps/desktop/test/ui-icons.test.tsx
git commit -m "feat(ui): centralize icon library"
```

---

### Task 6: 对话业务模式组件

**Files:**
- Create: `packages/ui/src/patterns/ChatMessage.tsx`、`ToolCard.tsx`、`ModelEffortControl.tsx`、`ChatComposer.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-chat-patterns.test.tsx`（新）

**Interfaces:**
- Produces:
  - `ChatMessage({ role, text, thinking?, streaming?, children? })`
  - `ToolCard({ toolName, input, result?, awaitingApproval? })`
  - `ModelEffortControl({ model, defaultModel, models, thinkingLevel, thinkingLevels, onModelChange, onThinkingLevelChange })`
  - `ChatComposer({ busy, workspacePath, workspaceKind, onChooseWorkspace, onClearWorkspace, modelProps, onSend, onStop })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-chat-patterns.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelEffortControl, ChatComposer } from '@sparkii/ui';

describe('ui chat patterns', () => {
  it('model effort control shows one combined trigger', () => {
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={vi.fn()} onThinkingLevelChange={vi.fn()} />);
    expect(screen.getByTestId('model-effort-trigger').textContent).toContain('deepseek-v4-pro');
    expect(screen.getByTestId('model-effort-trigger').textContent).toContain('高');
  });

  it('model effort menu has two rows with chevrons', () => {
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={vi.fn()} onThinkingLevelChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    expect(screen.getByText('模型')).toBeTruthy();
    expect(screen.getByText('思考强度')).toBeTruthy();
    expect(screen.getAllByText('›').length).toBe(2);
  });

  it('chat composer sends and stops', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<ChatComposer busy={false} workspacePath="C:/ws" workspaceKind="auto" onChooseWorkspace={vi.fn()} onClearWorkspace={vi.fn()} modelProps={{ model: null, defaultModel: null, models: [], thinkingLevel: null, thinkingLevels: [], onModelChange: vi.fn(), onThinkingLevelChange: vi.fn() }} onSend={onSend} onStop={onStop} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith('hi');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-chat-patterns.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`ChatMessage.tsx`：

```tsx
import type { ReactNode } from 'react';

export function ChatMessage({ role, text, thinking, streaming = false, children }: { role: 'user' | 'assistant'; text: string; thinking?: string; streaming?: boolean; children?: ReactNode }) {
  return <div className={`ui-chat-message ui-chat-message--${role}`}>{thinking && <details className="ui-thinking"><summary>思考过程</summary><div>{thinking}</div></details>}{children ?? text}{streaming && <span className="ui-caret" aria-hidden="true" />}</div>;
}
```

`ToolCard.tsx`：

```tsx
import { useState } from 'react';
export function ToolCard({ toolName, input, result, awaitingApproval = false }: { toolName: string; input: unknown; result?: unknown; awaitingApproval?: boolean }) {
  const [open, setOpen] = useState(false);
  const status = awaitingApproval ? 'approval' : result ? 'ok' : 'running';
  return (
    <div className={`ui-tool-card ui-tool-card--${status}`} data-testid="tool-card">
      <div className="ui-tool-card-head"><b>{toolName}</b><span className="ui-tool-card-status">{status}</span></div>
      <button type="button" className="ui-btn ui-btn--sm" onClick={() => setOpen((v) => !v)}>详情 {open ? '▾' : '▸'}</button>
      {open && <pre className="ui-payload">{JSON.stringify({ input, result }, null, 2)}</pre>}
    </div>
  );
}
```

`ModelEffortControl.tsx`：

```tsx
import { useState } from 'react';
import { Menu, MenuItem } from '../primitives/Menu.js';

export interface ModelEffortProps {
  model: string | null;
  defaultModel: string | null;
  models: string[];
  thinkingLevel: string | null;
  thinkingLevels: string[];
  onModelChange(model: string | null): void;
  onThinkingLevelChange(level: string | null): void;
}

export function ModelEffortControl(props: ModelEffortProps) {
  const [open, setOpen] = useState(false);
  const currentModel = props.model ?? props.defaultModel ?? '默认';
  const currentLevel = props.thinkingLevel ?? '默认';
  return (
    <div className="ui-model-effort">
      <button type="button" className="ui-btn ui-btn--md ui-model-effort-trigger" data-testid="model-effort-trigger" onClick={() => setOpen((v) => !v)}>
        {currentModel} · {currentLevel}
      </button>
      {open && (
        <Menu open onClose={() => setOpen(false)}>
          <MenuItem label="模型" hint={currentModel} onSelect={() => { setOpen(false); props.onModelChange(props.models[0] ?? null); }} />
          <MenuItem label="思考强度" hint={currentLevel} onSelect={() => { setOpen(false); props.onThinkingLevelChange(props.thinkingLevels[0] ?? null); }} />
        </Menu>
      )}
    </div>
  );
}
```

`ChatComposer.tsx`：

```tsx
import { useState } from 'react';
import { TextArea } from '../primitives/TextArea.js';
import { Button } from '../primitives/Button.js';
import { ModelEffortControl, type ModelEffortProps } from './ModelEffortControl.js';

export interface ChatComposerProps {
  busy: boolean;
  workspacePath: string | null;
  workspaceKind: 'auto' | 'user';
  onChooseWorkspace(): void;
  onClearWorkspace(): void;
  modelProps: ModelEffortProps;
  onSend(text: string): void;
  onStop(): void;
}

export function ChatComposer({ busy, workspacePath, workspaceKind, onChooseWorkspace, onClearWorkspace, modelProps, onSend, onStop }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const send = () => { const text = draft.trim(); if (!text || busy) return; onSend(text); setDraft(''); };
  return (
    <div className="ui-composer">
      <div className="ui-composer-input-row">
        <TextArea className="ui-composer-input" data-testid="composer-input" rows={3} placeholder="输入消息，Ctrl+Enter 发送" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <Button variant="primary" size="lg" className="ui-composer-send" data-testid="composer-send" onClick={busy ? onStop : send}>{busy ? '停止' : '发送'}</Button>
      </div>
      <div className="ui-composer-controls">
        <div className="ui-composer-workspace">
          <span>工作区</span>
          <span className="ui-composer-path" data-testid="workspace-path" title={workspacePath ?? ''}>{workspacePath ?? '（首次写操作时生成）'}</span>
          <Button size="sm" onClick={onChooseWorkspace}>选择文件夹</Button>
          {workspaceKind === 'user' && <Button size="sm" data-testid="workspace-clear" onClick={onClearWorkspace}>清除</Button>}
        </div>
        <ModelEffortControl {...modelProps} />
      </div>
    </div>
  );
}
```

更新 `index.ts` 追加：

```ts
export * from './patterns/ChatMessage.js';
export * from './patterns/ToolCard.js';
export * from './patterns/ModelEffortControl.js';
export * from './patterns/ChatComposer.js';
```

- [ ] **Step 4: 添加样式**

`packages/ui/src/styles.css` 末尾追加：

```css
.ui-chat-message { max-width: 78%; padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-card); line-height: 1.6; }
.ui-chat-message--user { align-self: flex-end; background: var(--color-primary); color: #fff; border-bottom-right-radius: 4px; }
.ui-chat-message--assistant { align-self: flex-start; background: var(--color-surface); border: 1px solid var(--color-border); border-bottom-left-radius: 4px; }
.ui-caret { display: inline-block; width: 8px; height: 16px; margin-left: 2px; background: var(--color-primary); animation: caret-blink 1s steps(2) infinite; vertical-align: text-bottom; }
@keyframes caret-blink { 50% { opacity: 0; } }
.ui-thinking { margin-bottom: var(--spacing-xs); padding: var(--spacing-xs) var(--spacing-sm); border: 1px solid var(--color-border); border-radius: var(--radius-control); background: var(--color-controlBg); color: var(--color-textSecondary); }
.ui-tool-card { border: 1px dashed var(--color-controlBorderHover); border-radius: var(--radius-button); background: var(--color-primaryBg); padding: var(--spacing-xs) var(--spacing-sm); }
.ui-tool-card--approval { background: var(--color-warnBg); border-color: var(--color-warnBorder); }
.ui-tool-card--ok { background: var(--color-okBg); border-color: var(--color-okBorder); }
.ui-composer { border-top: 1px solid var(--color-border); padding: var(--spacing-sm) var(--spacing-md); background: var(--color-surface); display: flex; flex-direction: column; gap: var(--spacing-xs); }
.ui-composer-input-row { display: flex; align-items: flex-end; gap: var(--spacing-xs); }
.ui-composer-input { flex: 1; min-height: var(--control-textarea-min); }
.ui-composer-send { min-width: 76px; }
.ui-composer-controls { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); flex-wrap: wrap; }
.ui-composer-workspace { display: flex; align-items: center; gap: var(--spacing-xs); min-width: 0; color: var(--color-textSecondary); }
.ui-composer-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); }
.ui-model-effort { position: relative; }
.ui-model-effort-trigger { min-width: 180px; justify-content: flex-start; }
.ui-payload { background: var(--color-controlBg); border: 1px solid var(--color-border); border-radius: var(--radius-control); padding: var(--spacing-sm); overflow: auto; font: var(--font-size-sm)/1.5 var(--font-mono); color: var(--color-textSecondary); white-space: pre-wrap; }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-chat-patterns.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src apps/desktop/test/ui-chat-patterns.test.tsx
git commit -m "feat(ui): add chat patterns and Codex-style model control"
```

---

### Task 7: 壳层业务模式组件

**Files:**
- Create: `packages/ui/src/patterns/AgentNav.tsx`、`SessionList.tsx`、`StatusBar.tsx`、`Shell.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-shell-patterns.test.tsx`（新）

**Interfaces:**
- Produces:
  - `AgentNav({ agents, active, onNavigate })`
  - `SessionList({ sessions, onNew, onOpen, onRename, onDelete })`
  - `StatusBar({ statusText, runningCount, queueCount, maxAgents, onOpenQueue })`
  - `Shell(props)` 与现有 `ShellProps` 一致，但移除状态点装饰。

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-shell-patterns.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentNav, StatusBar, Shell } from '@sparkii/ui';

describe('ui shell patterns', () => {
  it('agent nav has no idle dot', () => {
    render(<AgentNav agents={[{ id: 'contract', name: '合同审核', status: 'idle' }]} active="contract" onNavigate={vi.fn()} />);
    expect(screen.queryByText('●')).toBeNull();
    expect(screen.getByText('合同审核')).toBeTruthy();
  });

  it('status bar shows running and queued counts', () => {
    render(<StatusBar statusText="就绪" runningCount={1} queueCount={2} maxAgents={4} onOpenQueue={vi.fn()} />);
    expect(screen.getByText(/运行 1\/4 · 2 排队/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-shell-patterns.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`AgentNav.tsx`：

```tsx
export type AgentNavStatus = 'running' | 'idle' | 'queued';
export function AgentNav({ agents, active, onNavigate }: { agents: Array<{ id: string; name: string; status: AgentNavStatus; queuePosition?: number }>; active: string; onNavigate(id: string): void }) {
  return (
    <nav className="ui-agent-nav" aria-label="智能体">
      {agents.map((a) => (
        <button key={a.id} type="button" className={`ui-agent ${active === a.id ? 'on' : ''}`} onClick={() => onNavigate(a.id)}>
          <span>{a.name}</span>
          {a.status === 'queued' && <span className="ui-badge">排队{a.queuePosition ?? 1}</span>}
        </button>
      ))}
    </nav>
  );
}
```

`SessionList.tsx`：

```tsx
import { Button } from '../primitives/Button.js';

export interface SessionListItem { id: string; name: string; state?: string; time?: string; active?: boolean; }
export function SessionList({ sessions, onNew, onOpen, onRename, onDelete }: { sessions: SessionListItem[]; onNew(): void; onOpen(id: string): void; onRename?(id: string): void; onDelete?(id: string): void; }) {
  return (
    <div className="ui-session-list">
      <Button variant="primary" className="ui-btn--block" onClick={onNew}>+ 新会话</Button>
      {sessions.map((s) => (
        <div key={s.id} className={`ui-list-row ${s.active ? 'current' : ''}`} onClick={() => onOpen(s.id)}>
          <span>{s.name} {s.state}</span>
          {onRename && <button type="button" className="ui-icon-btn ui-btn--sm" title={`重命名 ${s.id}`} onClick={(e) => { e.stopPropagation(); onRename(s.id); }}>✎</button>}
          {onDelete && <button type="button" className="ui-icon-btn ui-btn--sm" title={`删除 ${s.id}`} onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>✕</button>}
          <span className="ui-list-row-hint">{s.time}</span>
        </div>
      ))}
    </div>
  );
}
```

`StatusBar.tsx`：

```tsx
export function StatusBar({ statusText, runningCount, queueCount, maxAgents, onOpenQueue }: { statusText: string; runningCount: number; queueCount: number; maxAgents: number; onOpenQueue(): void }) {
  return <footer className="ui-statusbar"><span className="ui-statusbar-text">{statusText}</span><button type="button" className="ui-btn ui-btn--sm" onClick={onOpenQueue}>运行 {runningCount}/{maxAgents} · {queueCount} 排队</button><span className="ui-statusbar-tech">本机运行</span></footer>;
}
```

`Shell.tsx`：

1. 把现有 `apps/desktop/src/shell/Shell.tsx` 中的 `ScreenId`、`AgentStatus`、`ShellAgent`、`ShellSession`、`ShellProps` 类型定义原样复制到新文件。
2. 导入 `Button`、`IconButton`、`Drawer`、`AgentNav`、`SessionList`、`StatusBar`。
3. 渲染结构改为：

```tsx
<div className="ui-shell">
  <header className="ui-topbar">
    <div className="ui-topbar-left">
      <Button variant="ghost" onClick={() => onNavigate('home')}>Sparkii</Button>
      <span className="ui-topbar-title">{title}</span>
    </div>
    <div className="ui-topbar-right">
      <span className="ui-trust-line">本机运行 · 审计✓</span>
      <Button variant="ghost" size="sm" onClick={() => onNavigate('approvals')}>审批 {pendingApprovals > 0 && <Badge>{pendingApprovals}</Badge>}</Button>
      <IconButton label="账号" onClick={() => openDrawer('account')}><UserIcon /></IconButton>
      <IconButton label="深色/浅色" onClick={toggleTheme}>{dark ? <SunIcon /> : <MoonIcon />}</IconButton>
      <IconButton label="设置" onClick={() => onNavigate('settings')}><GearIcon /></IconButton>
    </div>
  </header>
  <div className="ui-shell-main">
    <aside className="ui-rail">
      <AgentNav agents={agents} active={active} onNavigate={onNavigate} />
      <nav aria-label="全局">
        <Button variant="ghost" onClick={() => onNavigate('approvals')}>审批中心 {pendingApprovals > 0 && <Badge>{pendingApprovals}</Badge>}</Button>
        <Button variant="ghost" onClick={() => onNavigate('audit')}>审计</Button>
      </nav>
    </aside>
    <main className="ui-surface">
      {surfaceTitle && (
        <div className="ui-surface-head">
          <b>{surfaceTitle}</b>
          <IconButton label="会话" onClick={() => openDrawer('session')}><SessionsIcon /></IconButton>
          <IconButton label="新会话" onClick={() => onNewSession(active)}><PlusIcon /></IconButton>
          {surfaceActions}
        </div>
      )}
      {children}
    </main>
  </div>
  <StatusBar statusText={statusText} runningCount={runningCount} queueCount={queueCount} maxAgents={MAX_AGENTS} onOpenQueue={() => openDrawer('queue')} />
  <Drawer open={drawer === 'session'} title="会话" onClose={closeDrawer}>
    <SessionList sessions={activeSessions} onNew={() => onNewSession(active)} onOpen={(id) => onOpenSession?.(active, id)} onRename={onRenameSession ? (id) => startRename(activeSessions.find((s) => s.id === id)!) : undefined} onDelete={onDeleteSession ? (id) => onDeleteSession(active, id) : undefined} />
  </Drawer>
</div>
```

保留原有 `drawer` state、主题切换、重命名 draft 和回调逻辑；删除旧的 `.dot`、`.agent`、`.btn` 渲染。

更新 `index.ts` 追加：

```ts
export * from './patterns/AgentNav.js';
export * from './patterns/SessionList.js';
export * from './patterns/StatusBar.js';
export * from './patterns/Shell.js';
```

- [ ] **Step 4: 添加样式**

`packages/ui/src/styles.css` 末尾追加：

```css
.ui-agent-nav { display: flex; flex-direction: column; gap: 2px; }
.ui-agent { display: flex; align-items: center; gap: var(--spacing-xs); width: 100%; text-align: left; border: none; background: none; border-radius: var(--radius-button); padding: var(--spacing-xs) var(--spacing-sm); font-size: var(--font-size-md); color: var(--color-textSecondary); cursor: pointer; }
.ui-agent:hover { background: var(--color-controlBg); }
.ui-agent.on { background: var(--color-primaryBg); color: var(--color-primary); font-weight: var(--font-weight-semibold); }
.ui-btn--block { width: 100%; }
.ui-list-row-hint { margin-left: auto; color: var(--color-textMuted); font-size: var(--font-size-xs); }
.ui-statusbar { display: flex; align-items: center; gap: var(--spacing-md); padding: 0 var(--spacing-md); background: var(--color-surface); border-top: 1px solid var(--color-border); color: var(--color-textSecondary); font-size: var(--font-size-sm); }
.ui-statusbar-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-statusbar-tech { margin-left: auto; color: var(--color-textMuted); }
.ui-shell { display: grid; grid-template-rows: 48px 1fr 36px; height: 100%; background: var(--color-bg); overflow: hidden; }
.ui-shell-main { display: grid; grid-template-columns: 176px 1fr; min-height: 0; }
.ui-rail { background: var(--color-surface); border-right: 1px solid var(--color-border); padding: var(--spacing-sm) var(--spacing-xs); display: flex; flex-direction: column; gap: var(--spacing-md); overflow: auto; }
.ui-surface { overflow: auto; padding: var(--spacing-md) var(--spacing-lg); min-width: 0; }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-shell-patterns.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src apps/desktop/test/ui-shell-patterns.test.tsx
git commit -m "feat(ui): add shell and navigation patterns"
```

---

### Task 8: 工作流、审批、审计、设置业务模式组件

**Files:**
- Create: `packages/ui/src/patterns/WorkflowSteps.tsx`、`RiskBadge.tsx`、`Countdown.tsx`、`ApprovalItem.tsx`、`AuditTimeline.tsx`、`SettingsLayout.tsx`、`SettingsRow.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `apps/desktop/test/ui-business-patterns.test.tsx`（新）

**Interfaces:**
- Produces:
  - `WorkflowSteps({ steps })`
  - `RiskBadge({ risk })`
  - `Countdown({ until, onExpire, className })`
  - `ApprovalItem({ summary, risk, toolName, sessionId, countdownText, onOpenDetail })`
  - `AuditTimeline({ rows, isDenied })`
  - `SettingsLayout({ nav, children })`
  - `SettingsRow({ label, children, hint })`

- [ ] **Step 1: 写失败测试**

`apps/desktop/test/ui-business-patterns.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskBadge, ApprovalItem, SettingsRow, SettingsLayout } from '@sparkii/ui';

describe('ui business patterns', () => {
  it('risk badge maps high risk to high class', () => {
    render(<RiskBadge risk="high-risk" />);
    expect(screen.getByText('高风险').className).toContain('ui-risk-badge--high');
  });

  it('approval item has no leading status dot', () => {
    const onOpen = vi.fn();
    render(<ApprovalItem summary="导出报告" risk="write" toolName="export" sessionId="s1" countdownText="120s" onOpenDetail={onOpen} />);
    expect(screen.queryByText('●')).toBeNull();
    fireEvent.click(screen.getByText('详情'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('settings layout renders nav and content', () => {
    render(<SettingsLayout nav={<button>大模型连接</button>}><span>内容</span></SettingsLayout>);
    expect(screen.getByText('大模型连接')).toBeTruthy();
    expect(screen.getByText('内容')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/ui-business-patterns.test.tsx`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

各组件按现有 `WorkflowStatus`、`riskInfo`、`Countdown`、`ApprovalCenter`、`AuditView`、`SettingsView` 逻辑迁移到 `ui-` 类，并复用基础组件。关键代码：

`RiskBadge.tsx`：

```tsx
export function RiskBadge({ risk }: { risk: string | undefined }) {
  const level = risk === 'high-risk' ? 'high' : risk === 'read' ? 'low' : 'mid';
  const label = level === 'high' ? '高风险' : level === 'low' ? '低风险' : '中风险';
  return <span className={`ui-risk-badge ui-risk-badge--${level}`}>{label}</span>;
}
```

`ApprovalItem.tsx`：

```tsx
import { RiskBadge } from './RiskBadge.js';
export function ApprovalItem({ summary, risk, toolName, sessionId, countdownText, onOpenDetail }: { summary: string; risk: string; toolName?: string; sessionId?: string; countdownText: string; onOpenDetail(): void }) {
  return (
    <div className="ui-approval-item">
      <div className="ui-approval-item-main"><b>{summary}</b><div className="ui-muted">{toolName}{sessionId ? ` · 会话 ${sessionId.slice(0, 8)}` : ''}</div></div>
      <span className="ui-approval-item-meta"><RiskBadge risk={risk} /> · {countdownText}</span>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" onClick={onOpenDetail}>详情</button>
    </div>
  );
}
```

`WorkflowSteps.tsx`：

```tsx
export interface WorkflowStep { id: string; label: string; state: 'idle' | 'active' | 'done' | 'failed'; }
export function WorkflowSteps({ steps }: { steps: WorkflowStep[] }) {
  return <div className="ui-workflow-steps">{steps.map((s) => <span key={s.id} className={`ui-workflow-step ui-workflow-step--${s.state}`} data-state={s.state}>{s.label}</span>)}</div>;
}
```

`Countdown.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
export function Countdown({ until, onExpire, className = '' }: { until: number; onExpire?(): void; className?: string }) {
  const fired = useRef(false);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0 && !fired.current) { fired.current = true; onExpire?.(); }
    };
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until, onExpire]);
  return <span className={className}>{left}s</span>;
}
```

`AuditTimeline.tsx`：

```tsx
import { RiskBadge } from './RiskBadge.js';
export interface AuditTimelineRow { id?: string; action?: string; actor?: string; ts?: number; payloadSummary?: string; denied?: boolean; executed?: boolean; }
export function AuditTimeline({ rows }: { rows: AuditTimelineRow[] }) {
  return <div className="ui-audit-timeline">{rows.map((r, i) => (
    <div key={r.id ?? i} className={`ui-audit-item ${r.denied ? 'denied' : r.executed ? 'executed' : ''}`}>
      <b>{r.action ?? '-'}</b>
      <div className="ui-muted">{r.actor ?? '-'} · {r.ts ? new Date(r.ts).toLocaleString('zh-CN') : '-'}{r.payloadSummary ? ` · ${r.payloadSummary}` : ''}</div>
      {r.executed !== undefined && <RiskBadge risk={r.denied ? 'high-risk' : 'read'} />}
    </div>
  ))}</div>;
}
```

`SettingsLayout.tsx`：

```tsx
import type { ReactNode } from 'react';
export function SettingsLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return <div className="ui-settings-layout"><aside className="ui-settings-nav">{nav}</aside><section className="ui-settings-content">{children}</section></div>;
}
```

`SettingsRow.tsx`：

```tsx
import type { ReactNode } from 'react';
export function SettingsRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="ui-settings-row"><span>{label}</span>{children}{hint && <span className="ui-muted">{hint}</span>}</div>;
}
```

更新 `index.ts` 追加对应导出。

- [ ] **Step 4: 添加样式**

`packages/ui/src/styles.css` 末尾追加：

```css
.ui-risk-badge { display: inline-flex; align-items: center; border-radius: var(--radius-pill); padding: 1px 8px; font-size: var(--font-size-xs); border: 1px solid transparent; }
.ui-risk-badge--high { background: var(--color-riskBg); color: var(--color-risk); border-color: var(--color-riskBorder); }
.ui-risk-badge--mid { background: var(--color-warnBg); color: var(--color-warn); border-color: var(--color-warnBorder); }
.ui-risk-badge--low { background: var(--color-okBg); color: var(--color-ok); border-color: var(--color-okBorder); }
.ui-approval-item { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-xs); border-bottom: 1px dashed var(--color-border); }
.ui-approval-item-main { flex: 1; min-width: 0; }
.ui-approval-item-meta { display: inline-flex; align-items: center; gap: var(--spacing-xs); color: var(--color-textSecondary); font-size: var(--font-size-sm); }
.ui-settings-row { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) 0; border-bottom: 1px dashed var(--color-border); }
.ui-muted { color: var(--color-textMuted); font-size: var(--font-size-sm); }
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/ui-business-patterns.test.tsx && pnpm --filter @sparkii/ui typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src apps/desktop/test/ui-business-patterns.test.tsx
git commit -m "feat(ui): add workflow approval audit and settings patterns"
```

---

### Task 9: 接入主题/组件库并迁移壳层、首页

**Files:**
- Modify: `apps/desktop/src/main.tsx`
- Modify: `apps/desktop/src/shell/theme.ts`
- Modify: `apps/desktop/src/shell/Shell.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/surfaces/HomeView.tsx`
- Test: 更新现有 `apps/desktop/test/shell-theme.test.ts`、`home-view.test.tsx`

**Interfaces:**
- Consumes: `@sparkii/theme` 新 token、`@sparkii/ui` 的 Shell/AgentNav/SessionList/StatusBar 及基础组件。
- Produces: 应用壳层和首页全部消费组件库，旧 `.dot`、`.btn` 等壳层类被替换。

- [ ] **Step 1: 写失败测试**

更新 `home-view.test.tsx`，断言首页智能体卡片不再包含状态圆点：

```tsx
expect(screen.queryByText('●')).toBeNull();
```

更新 `shell-theme.test.ts`，断言注入的 CSS 包含新 token：

```ts
expect(document.getElementById('sparkii-theme-tokens')?.textContent).toContain('--control-height-md');
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/home-view.test.tsx apps/desktop/test/shell-theme.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`main.tsx` 把 `import './styles.css'` 改为 `import '@sparkii/ui/styles.css'`。

`theme.ts` 保持注入逻辑，改为只注入 token；`ensureTokenStyle` 的 `textContent` 保持不变。

`Shell.tsx` 不再自行实现壳层，改为从 `@sparkii/ui` 导入 `Shell`，并保留原 `ShellProps` 的类型 re-export 或直接删除旧文件后更新 `App.tsx` 引用。

`App.tsx` 更新 `agents` 状态中的 `status` 来源，确保空闲状态不渲染圆点；首页改用 `HomeView` 的新实现。

`HomeView.tsx`：

```tsx
import { Card, StatusBadge } from '@sparkii/ui';
```

“系统状态”卡片用图标 + 文本替换 `●` 文本符号；智能体卡片用 `StatusBadge` 只显示非空闲状态。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/home-view.test.tsx apps/desktop/test/shell-theme.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main.tsx apps/desktop/src/shell/theme.ts apps/desktop/src/shell/Shell.tsx apps/desktop/src/App.tsx apps/desktop/src/surfaces/HomeView.tsx apps/desktop/test/home-view.test.tsx apps/desktop/test/shell-theme.test.ts
git commit -m "refactor(desktop): migrate shell and home to ui library"
```

---

### Task 10: 迁移对话表面与工作台组件

**Files:**
- Modify: `apps/desktop/src/workbench/Composer.tsx`、`ToolCard.tsx`、`Markdown.tsx`、`DiffView.tsx`
- Modify: `apps/desktop/src/surfaces/GeneralChatSurface.tsx`
- Test: 更新 `apps/desktop/test/composer.test.tsx`、`tool-card.test.tsx`、`general-chat-surface.test.tsx`

**Interfaces:**
- Consumes: `@sparkii/ui` 的 `ChatMessage`、`ToolCard`、`ChatComposer`、`ModelEffortControl`、`Button`、`TextField` 等。
- Produces: 对话表面迁移完成，composer 使用 Codex 风格组合控制按钮，数据绑定逻辑保留。

- [ ] **Step 1: 写失败测试**

更新 `composer.test.tsx`，把 `model-select` / `thinking-select` 断言改为 `model-effort-trigger` 存在：

```tsx
expect(screen.getByTestId('model-effort-trigger')).toBeTruthy();
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/composer.test.tsx apps/desktop/test/tool-card.test.tsx apps/desktop/test/general-chat-surface.test.tsx`
Expected: FAIL（新控件未接入）

- [ ] **Step 3: 实现**

`Composer.tsx` 删除本地 composer 实现，改为从 `@sparkii/ui` 导入 `ChatComposer`，并增加 `thinkingLevels`/`thinkingLevel`/`onThinkingLevelChange` props。

`ToolCard.tsx` 改为从 `@sparkii/ui` 导入同名组件，保留 `DiffView` 的 diff 展示逻辑。

`GeneralChatSurface.tsx` 中 `model`/`thinkingLevel` 状态继续管理，但传给 `ChatComposer.modelProps`，不再渲染原生 `<select>`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/composer.test.tsx apps/desktop/test/tool-card.test.tsx apps/desktop/test/general-chat-surface.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/workbench apps/desktop/src/surfaces/GeneralChatSurface.tsx apps/desktop/test/composer.test.tsx apps/desktop/test/tool-card.test.tsx apps/desktop/test/general-chat-surface.test.tsx
git commit -m "refactor(desktop): migrate chat surface and composer"
```

---

### Task 11: 迁移合同审核与 profile 驱动组合

**Files:**
- Modify: `apps/desktop/src/surfaces/ContractSurface.tsx`
- Modify: `apps/desktop/src/workbench/WorkflowStatus.tsx`
- Modify: `apps/desktop/src/composer/registry.tsx`、`PageComposer.tsx`
- Test: 更新 `apps/desktop/test/contract-surface.test.tsx`、`workflow-status.test.tsx`

**Interfaces:**
- Consumes: `@sparkii/ui` 的 `Card`、`Tabs`、`Button`、`WorkflowSteps`、`RiskBadge` 等。
- Produces: 合同审核表面和 profile widget 使用统一组件。

- [ ] **Step 1: 写失败测试**

更新 `contract-surface.test.tsx`，断言 `workflow-status` 组件使用 `ui-workflow` 类：

```tsx
expect(container.querySelector('.ui-workflow-steps')).toBeTruthy();
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/contract-surface.test.tsx apps/desktop/test/workflow-status.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`WorkflowStatus.tsx` 改为从 `@sparkii/ui` 导入 `WorkflowSteps`，并保留当前状态数据转换。

`ContractSurface.tsx` 替换卡片、页签、按钮、风险徽标为组件库组件。

`registry.tsx` 中 `FileUpload`、`ActionButton`、`Table`、`DocPreview` 等 widget 改用 `Button`、`Card`、`TextField`，不改变 `WidgetProps` 接口。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/contract-surface.test.tsx apps/desktop/test/workflow-status.test.tsx apps/desktop/test/contract-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/surfaces/ContractSurface.tsx apps/desktop/src/workbench/WorkflowStatus.tsx apps/desktop/src/composer apps/desktop/test/contract-surface.test.tsx apps/desktop/test/workflow-status.test.tsx
git commit -m "refactor(desktop): migrate contract surface and page widgets"
```

---

### Task 12: 迁移设置、审批、审计并清理旧样式

**Files:**
- Modify: `apps/desktop/src/shell/SettingsView.tsx`
- Modify: `apps/desktop/src/trust/ApprovalCenter.tsx`、`ApprovalPanel.tsx`、`ApprovalModal.tsx`
- Modify: `apps/desktop/src/audit/AuditView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: 更新 `settings-view.test.tsx`、`approval.test.tsx`、`audit-view.test.tsx`

**Interfaces:**
- Consumes: `@sparkii/ui` 的 `SettingsLayout`、`SettingsRow`、`ApprovalItem`、`Drawer`、`Modal`、`AuditTimeline`、`RiskBadge`、`Countdown` 等。
- Produces: 所有现有表面迁移完成，旧 `.btn`、`.icon-btn`、`.agent`、`.dot` 等类从应用组件中移除。

- [ ] **Step 1: 写失败测试**

更新三个测试文件，断言不再出现旧 `.agent` 状态点：

```tsx
expect(screen.queryByText('●')).toBeNull();
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run apps/desktop/test/settings-view.test.tsx apps/desktop/test/approval.test.tsx apps/desktop/test/audit-view.test.tsx`
Expected: FAIL（仍引用旧类）

- [ ] **Step 3: 实现**

`SettingsView.tsx` 使用 `SettingsLayout` + `SettingsRow`；左侧导航不再使用 `.agent` 状态点，改用当前态背景高亮。

`ApprovalCenter.tsx` 使用 `ApprovalItem`；`ApprovalPanel.tsx` / `ApprovalModal.tsx` 使用 `Drawer` / `Modal`。

`AuditView.tsx` 使用 `AuditTimeline`，时间线节点颜色表达结果。

`apps/desktop/src/styles.css` 删除所有旧 `.btn`、`.icon-btn`、`.agent`、`.dot`、`.composer`、`.bubble`、`.msg`、`.toolcard` 等规则，只保留应用级 layout 残留；若仍有引用则先修正组件。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run apps/desktop/test/settings-view.test.tsx apps/desktop/test/approval.test.tsx apps/desktop/test/audit-view.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shell/SettingsView.tsx apps/desktop/src/trust apps/desktop/src/audit/AuditView.tsx apps/desktop/src/styles.css apps/desktop/test/settings-view.test.tsx apps/desktop/test/approval.test.tsx apps/desktop/test/audit-view.test.tsx
git commit -m "refactor(desktop): migrate settings approvals audit and remove legacy styles"
```

---

### Task 13: 全量回归与视觉核验

**Files:** 无新增。

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: lint**

Run: `pnpm lint`
Expected: PASS。

- [ ] **Step 4: 构建渲染层**

Run: `pnpm --filter @sparkii/desktop build:renderer`
Expected: PASS。

- [ ] **Step 5: 视觉核验**

启动 Electron 桌面构建，逐一检查：

- 左栏智能体无空闲灰点；
- composer 中模型/思考强度为单个组合按钮，点开两行菜单，每行右侧箭头；
- 同一行控件高度一致；
- light/dark 主题均可读；
- 合同审核、首页、审批、审计、设置无明显布局回归。

- [ ] **Step 6: 提交修复**

```bash
git add -A
git commit -m "chore: ui migration regression fixes"
```

---

## Self-Review

- **Spec coverage:** token（Task 1）、组件库基础/表单/弹层/图标（Task 2–5）、对话与 Codex 模型控制（Task 6）、壳层（Task 7）、工作流/审批/审计/设置（Task 8）、应用迁移与清理（Task 9–12）、验收（Task 13）。
- **Placeholder scan:** 无 TBD/TODO；组件代码为可执行最小实现，迁移任务提供明确替换目标。
- **Type consistency:** `ModelEffortProps` 在 Task 6 定义并在 `ChatComposerProps` 复用；`ShellProps`、`ScreenId` 保持与旧壳层一致；`RiskBadge`、`ApprovalItem` 等命名在 Task 8 与 Task 12 一致。

## Execution Handoff

计划已保存至 `docs/superpowers/plans/2026-08-28-ui-foundation-and-component-library.md`。两种执行方式：

1. **Subagent-Driven（推荐）**——每个任务派发一个全新 subagent，任务间做两段式审查，迭代快；
2. **Inline Execution**——在当前会话用 executing-plans 按批次执行，带检查点。

采用哪种？
