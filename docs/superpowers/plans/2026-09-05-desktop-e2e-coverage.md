# Desktop E2E Coverage Implementation Plan

> **For agentic workers:** 本 plan 已经架构师审过并吸收 must-fix。审核记录见「Architect corrections」。按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 给真 Electron 窗口补上能抓住「live 管道没画」的回归，并补上合同拒绝写；通用智能体 §12 作为 P1 写清但不堵 P0。不把管道内部 Vitest 再做成 Playwright。

**Architecture:** 一层共享 launch harness + `playwright.config.ts`。Lane A 打真实合同 `load` 步（无 API key 也必须写出 `审核中：load`）；Lane B 按 test 跳过；Lane C 无模型壳冒烟。断言只看 DOM。

**Tech Stack:** Playwright `@playwright/test` + Electron `_electron`，现有 `SPARKII_E2E_DOCUMENT` / `SPARKII_E2E_EXPORT_DIR` / `SPARKII_SKIP_LLM`。

**Spec:** `docs/superpowers/specs/2026-09-05-desktop-e2e-coverage-design.md`

## Architect corrections

第一轮 **Request changes**。已吸收（无需产品再拍板）：

1. L1 只认 `/审核中：(load|search|review|report)/`。`审核完成` / `审核失败` 不是 L1 通过（否则又变成只等终态）。
2. 空态「运行审核后…」在 load/search 是正常的。失败 = 顶栏空白 **且** 这句还在。`contract-empty` 单独出现不失败。
3. 禁止 `getByTestId(/^session-/)`（会命中 `session-more-*`）。加 `session-group-${agentId}`，在合同组内点最新会话行。
4. L2 必须在首页看到该行 `aria-label="运行中"`，或回来后状态相对离开前前进。同一句 `审核中：load` 且无转圈 = 只重放 JSONL，算失败。
5. Lane A **不需要 API key**。`load` 的 `workflow_step_start` 在 skill 之前。禁止为此 skip 或改 runner。
6. Harness：`import.meta.url` 解析入口；每测 `--user-data-dir`；文档要求 `build:renderer` + `build:main` + `ensure:runtime`。

Nits 已吸收：合同 `SPARKII_PROFILE_DIR` 固定为该 profile 目录；P1-keep 用 `workflow-status`；D1 等 dialog < 300s 并点拒绝，断言 `proposal.denied` 且无 `proposal.executed`；G4 无选目录短路则不做；G1 维持 §12，test 开始时快照 Desktop；Task 1 接好后跑全部已接线 spec。

**Product forks:** none。G1 沿用通用智能体规格 §12 已锁规则，不在本 E2E 规格里削弱。

**Architect verdict:** Approve with nits（must-fix 已吸收；IMPLEMENTATION MAY START）。

## Global Constraints

- 不新开 IPC，不注入 `chat-event`，不把 slot 因 E2E 钉住。
- 不新增第三种产品 `SPARKII_E2E_*`。已有的 document / export dir 开关保持原样。
- 平台生产代码不按 `'general'` / `'contract-review'` 为 E2E 分叉。testid 可以出现真实 agent id。首页卡片锁死 `agent-card-contract-review`。
- 不改运行池、审批策略、workflow.yaml、合同投影规则。
- 不为 E2E 做缩短版 contract-review profile。
- 不把 Playwright 加进 `.github/workflows/ci.yml`（本轮）。
- `SPARKII_SKIP_LLM` 只包住需要 LLM 的 `test()`，禁止文件顶 `test.skip`。
- L2 禁止点击 `agent-nav-*` 当「回来」。
- 相关 Vitest 不放宽、不删。

---

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| launch / config / spec 文件 | `apps/desktop/e2e/**`、`apps/desktop/playwright.config.ts` | `electron/main` |
| 稳定 testid | 合同 Surface、Shell 顶栏、SessionList 组、Error toast（可选） | 不为 testid 改布局或文案逻辑 |
| README 跑法 | 根 README / README.en | 不改 CI |

---

## File Structure

```text
apps/desktop/playwright.config.ts              # 新
apps/desktop/e2e/harness.ts                     # 新：launchApp
apps/desktop/e2e/pilot.spec.ts                  # 拆 skip；L3；agent-card-contract-review
apps/desktop/e2e/live-pipeline.spec.ts          # 新：L1 L2（Lane A）
apps/desktop/e2e/pilot-deny.spec.ts             # 新：D1
apps/desktop/e2e/general.spec.ts               # 改用 harness；P1 再加 G1–G3
apps/desktop/e2e/provider-settings.spec.ts      # 改用 harness
packages/ui/src/patterns/Shell.tsx             # data-testid="home"
packages/ui/src/patterns/SessionList.tsx      # data-testid="session-group-${agentId}"
apps/desktop/agents/contract-review/surface/index.tsx  # risk-card、contract-empty
README.md / README.en.md
```

P1 落地时再加 `apps/desktop/e2e/general-write.spec.ts`（或同文件 describe），不要预建空文件。

---

### Task 1: Playwright config + 共享 harness

**Files:**
- Create: `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/e2e/harness.ts`
- Modify: 三条现有 spec 改为 `launchApp()`；`pilot.spec.ts` 的 `agent-card-contract` → `agent-card-contract-review`
- Test: `general.spec.ts`、`provider-settings.spec.ts`（C）；pilot 仍可按原 skip 暂留到 Task 4，但卡片 id 本任务就改

**行为：**

```ts
// playwright.config.ts — 放在 apps/desktop，cwd 即该包
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000, // Lane B 单测再 test.setTimeout(360_000)
})

// harness.ts
export async function launchApp(opts?: {
  profileDir?: string
  extraEnv?: Record<string, string>
}): Promise<{ app: ElectronApplication; page: Page; dataDir: string; exportDir: string; userDataDir: string; close(): Promise<void> }>
```

- 入口：`fileURLToPath(new URL('../dist-electron/main/index.js', import.meta.url))`
- `electron.launch({ args: [entry, `--user-data-dir=${userDataDir}`], env: { SPARKII_DATA_DIR, ... } })`
- 每个 test 独立 `DATA_DIR` + `userDataDir`
- 不要在 harness 里设 `SPARKII_SKIP_LLM`
- 合同用例传入 `profileDir` = 仓库内 `apps/desktop/agents/contract-review`

- [ ] **Step 1:** 写 config + harness；三条 spec 换 launch；改卡片 id。
- [ ] **Step 2:** `build:renderer` + `build:main` + `ensure:runtime` 后跑 `general.spec.ts` 与 `provider-settings.spec.ts`，PASS。
- [ ] **Step 3: Commit** `share electron launch harness for playwright e2e`

---

### Task 2: 稳定 testid（行为不变）

**Files:**
- Modify: `packages/ui/src/patterns/Shell.tsx` — Sparkii 按钮 `data-testid="home"`
- Modify: `packages/ui/src/patterns/SessionList.tsx` — 组容器 `data-testid={`session-group-${g.agentId}`}`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx` — `data-testid="risk-card"`；空态 `data-testid="contract-empty"`
- 可选：`packages/ui/src/patterns/ErrorCenter.tsx` toast `data-testid="error-toast"`
- Test: 现有 surface/shell 测试不得因加属性红。`session-list` 若有测试按 class 取组，不必改逻辑。

- [ ] **Step 1:** 只加属性。
- [ ] **Step 2:** `pnpm --filter @sparkii/desktop test test/contract-surface.test.tsx test/app-workflow.test.tsx test/shell.test.tsx` PASS。
- [ ] **Step 3: Commit** `add e2e testids for home, session groups, and risk cards`

---

### Task 3: Lane A — L1 live 顶栏、L2 离开再回来

**Files:**
- Create: `apps/desktop/e2e/live-pipeline.spec.ts`

**前置：** 合同 fixture 文本 + `SPARKII_E2E_DOCUMENT`；`profileDir` 固定 contract-review。本文件 **没有** `SPARKII_SKIP_LLM` skip。

**L1：**

```text
点 agent-card-contract-review → upload → review
await expect(workflow-status).toHaveText(/审核中：(load|search|review|report)/, { timeout: 60_000 })
审核完成 / 审核失败 不能当作 L1 通过
失败：60s 后顶栏仍空，且 contract-empty 仍是「运行审核后，风险发现会显示在这里」
禁止：先 wait 审核完成
```

**L2（同一 app，仅当 L1 已过）：**

```text
const before = await workflow-status.textContent()
点 getByTestId('home')
在 session-group-contract-review 内：
  expect(getByLabel('运行中')).toBeVisible()
  点 locator('[data-testid^="session-"]:not([data-testid^="session-more-"])').last()
回来后：转圈仍在，或 workflow-status 相对 before 已变化（更后 step / risk-card / 完成或失败）
同一 before 文本且无转圈 = 失败
禁止 agent-nav
```

不要写「若无 API key 则 acquire 失败所以 skip」。无 key 也必须出现 `审核中：load`。Pi 起不来才失败。

- [ ] **Step 1:** 写测试。
- [ ] **Step 2:** `SPARKII_SKIP_LLM=1` 下本文件仍执行并 PASS（有 runtime）。
- [ ] **Step 3: Commit** `e2e: live contract status without leaving the page`

---

### Task 4: Lane B — 拆 skip；L3 当场风险卡；D1 拒绝

**Files:**
- Modify: `apps/desktop/e2e/pilot.spec.ts` — 删除文件顶 `test.skip`；test 内 skip；卡片 id；「审核完成」改断言 `getByTestId('workflow-status')`；**本次停留内** `getByTestId('risk-card')` 至少 1（L3）
- Create: `apps/desktop/e2e/pilot-deny.spec.ts`（独立 launch）
  - 上传 / 审核
  - `expect(dialog).toBeVisible({ timeout: 60_000 })`（必须 < 300_000）
  - 点「拒绝」（不要先等审核完成）
  - `existsSync(report.docx) === false`
  - 审计：有 `proposal.denied`，没有该次 `proposal.executed`

批准与拒绝不得共用 app 实例。

- [ ] **Step 1:** 改 skip + L3。
- [ ] **Step 2:** `SPARKII_SKIP_LLM=1` 时 L1/L2/C 仍跑；pilot 与 deny 跳过且不失败。
- [ ] **Step 3:** 有模型时跑批准 + deny。
- [ ] **Step 4: Commit** `e2e: assert live findings and denied export`

---

### Task 5: README 跑法

**Files:** `README.md`、`README.en.md`

写清三步构建（renderer、main、runtime）；Lane A+C 在 `SPARKII_SKIP_LLM=1` 下必须执行；Lane B 需要凭据。不要声称 CI 会跑 E2E。

- [ ] **Step 1:** 改两份 README。
- [ ] **Step 2: Commit** `docs: document playwright lanes and skip semantics`

---

### Task 6: P1 通用智能体 §12（P0 绿之后才开始）

**Files:** `apps/desktop/e2e/general.spec.ts` 或新 `general-write.spec.ts`

| test | skip | 要点 |
| --- | --- | --- |
| G1 纯问答不建 Desktop Sparkii | LLM | **本条开始时** 快照 Desktop；结束后无新增 `Sparkii*`。不把合同 E2E 建的目录算进来。不削弱成 data dir |
| G2 创建 hello.txt 批准 | LLM | 审批 + 文件 + `proposal.executed` |
| G3/G6 拒绝 | LLM | 独立 launch；无文件 + `proposal.denied` |
| G4 指定工作区 | 不做 | `chooseWorkspace` 无 e2e 短路；不新 env |
| G5 换模型 | 不做 | 不强制 |

- [ ] **Step 1:** 只在 P0 合并后开做。
- [ ] **Step 2:** G1–G3。
- [ ] **Step 3: Commit** 按场景拆 commit。

---

## Suggested Implementation Order

1. Harness（Task 1）
2. testid（Task 2）
3. L1/L2（Task 3）
4. L3 + D1 + 拆 skip（Task 4）
5. README（Task 5）
6. P1（Task 6）——不堵 P0 合并

不要先写 mock OpenAI。不要先加 CI。不要先做 compaction/崩溃 E2E。不要为无 key 给 Lane A 加 skip。

## Self-Review Notes

- L1 写成「等审核完成」= 没做。
- `session-more-*` 与 `session-${id}` 共享前缀；L2 必须组内 + `:not(session-more-)`。
- L2 无转圈只靠 JSONL 重放 = 假绿。
- D1 等满 300s 会自动 deny，必须先点拒绝。
- 只 `build:main` 窗口是空的。
- 首页卡片已经锁 `agent-card-contract-review`。
