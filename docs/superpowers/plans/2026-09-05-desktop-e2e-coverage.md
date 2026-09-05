# Desktop E2E Coverage Implementation Plan

> **For agentic workers:** 本 plan 在架构师 Approve 之前 **不得执行测试代码**。规格与本 plan 审过并吸收 must-fix 后，按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 给真 Electron 窗口补上能抓住「live 管道没画」的回归，并补上合同拒绝写；通用智能体 §12 作为 P1 写清但不堵 P0。不把管道内部 Vitest 再做成 Playwright。

**Architecture:** 一层共享 launch harness + `playwright.config.ts`。Lane A 打真实合同 `load` 步（只要 Pi 能起）；Lane B 按 test 跳过；Lane C 无模型壳冒烟。断言只看 DOM。

**Tech Stack:** Playwright `@playwright/test` + Electron `_electron`，现有 `SPARKII_E2E_DOCUMENT` / `SPARKII_E2E_EXPORT_DIR` / `SPARKII_SKIP_LLM`。

**Spec:** `docs/superpowers/specs/2026-09-05-desktop-e2e-coverage-design.md`

## Architect corrections

（审核后填。未审前不得把下面的 Global Constraints 当成已批准。）

## Global Constraints

- 不新开 IPC，不注入 `chat-event`，不把 slot 因 E2E 钉住。
- 不新增第三种产品 `SPARKII_E2E_*` 去改 runner / 跳过步骤。已有的 document / export dir 开关保持原样。
- 平台生产代码不按 `'general'` / `'contract-review'` 为 E2E 分叉。testid 可以出现真实 agent id。首页卡片锁死 `agent-card-contract-review`（`listAgents` id = manifest.name）。现有 `pilot.spec.ts` 的 `agent-card-contract` 一并改掉。
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
| 稳定 testid | 合同 Surface、Shell 顶栏、Error toast（可选） | 不为 testid 改布局或文案逻辑 |
| README 跑法 | 根 README / README.en | 不改 CI |

---

## File Structure

```text
apps/desktop/playwright.config.ts              # 新
apps/desktop/e2e/harness.ts                     # 新：launchElectronApp
apps/desktop/e2e/pilot.spec.ts                  # 拆 skip；可并入 L3 或保持终态
apps/desktop/e2e/live-pipeline.spec.ts          # 新：L1 L2（Lane A）
apps/desktop/e2e/pilot-deny.spec.ts             # 新：D1（Lane B）；或与 pilot 同文件不同 test
apps/desktop/e2e/general.spec.ts               # 保留 G0；P1 再加 G1–G4
apps/desktop/e2e/provider-settings.spec.ts      # 改用 harness
packages/ui/src/patterns/Shell.tsx             # data-testid="home"
apps/desktop/agents/contract-review/surface/index.tsx  # risk-card、contract-empty
README.md / README.en.md
```

P1 落地时再加 `apps/desktop/e2e/general-write.spec.ts`（或同文件 describe），不要预建空文件。

---

### Task 1: Playwright config + 共享 harness

**Files:**
- Create: `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/e2e/harness.ts`
- Modify: 三条现有 spec 改为 `launchApp()`；`pilot.spec.ts` 的 `agent-card-contract` 改为 `agent-card-contract-review` 
- Test: 现有 C 车道仍绿（`general.spec.ts`、`provider-settings.spec.ts`）

**行为：**

```ts
// playwright.config.ts
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
}): Promise<{ app: ElectronApplication; page: Page; dataDir: string; exportDir: string; close(): Promise<void> }>
```

每个 test 独立 `DATA_DIR`。`close` 必须 `app.close()`。不要在 harness 里设 `SPARKII_SKIP_LLM`。

- [ ] **Step 1:** 写 config + harness；把 `general.spec.ts` / `provider-settings.spec.ts` / `pilot.spec.ts` 接到 harness；卡片改为 `agent-card-contract-review`（先不要动 skip 语义）。
- [ ] **Step 2:** `pnpm --filter @sparkii/desktop build:main` 后跑这两条，PASS。
- [ ] **Step 3: Commit** `share electron launch harness for playwright e2e`

---

### Task 2: 稳定 testid（行为不变）

**Files:**
- Modify: `packages/ui/src/patterns/Shell.tsx` — 顶栏 Sparkii 按钮 `data-testid="home"`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx` — 风险卡 `data-testid="risk-card"`；空态 `data-testid="contract-empty"`
- 可选：`packages/ui/src/patterns/ErrorCenter.tsx` toast `data-testid="error-toast"`（P0 不断言它）
- Test: 现有 `contract-surface.test.tsx` / `app-workflow.test.tsx` 若按 testid 取顶栏，一并更新；不得因加属性红。

- [ ] **Step 1:** 只加属性，不改 class / 文案。
- [ ] **Step 2:** `pnpm --filter @sparkii/desktop test test/contract-surface.test.tsx test/app-workflow.test.tsx`（或实际引用这些 DOM 的测试）PASS。
- [ ] **Step 3: Commit** `add e2e testids for home and contract risk cards`

---

### Task 3: Lane A — L1 live 顶栏、L2 离开再回来

**Files:**
- Create: `apps/desktop/e2e/live-pipeline.spec.ts`
- Test: 本文件两条（可同一次 launch）

**前置：** 与 pilot 相同的合同 fixture 文本 + `SPARKII_E2E_DOCUMENT`；`SPARKII_PROFILE_DIR` 指向 `apps/desktop/agents/contract-review`（与现 pilot 一致，避免首页两个 profile 抢按钮）。

**L1：**

```text
点 agent-card-contract-review → upload → review
expect workflow-status 在 60s 内匹配 /审核中|审核完成|审核失败/
空白 + contract-empty「运行审核后…」= 失败
禁止：先 wait 审核完成 再 assert 过往状态
机器快已经完成：L1 仍过（L3 锁风险卡）
```

**L2（同一 app）：**

```text
点 getByTestId('home')
点合同会话行：getByTestId(/^session-/) 里带合同文件名 / 最新一行（不要 agent-nav）
回来后：workflow-status 匹配 /审核中|审核完成|审核失败/ 之一
且不得只有 contract-empty 文案「运行审核后，风险发现会显示在这里」而顶栏空白
```

本文件 **没有** `test.skip(SPARKII_SKIP_LLM)`。

若 `load` 在无 API key 时根本不 acquire：这是环境/产品问题，测试失败；不要改 runner 为 E2E 特判。

- [ ] **Step 1:** 写红测试（先跑，确认会在旧「只等完成」语义下仍能独立失败——即 L1 不等完成）。
- [ ] **Step 2:** 本地有 runtime 时 PASS。
- [ ] **Step 3: Commit** `e2e: live contract status without leaving the page`

---

### Task 4: Lane B — 拆 skip；L3 当场风险卡；D1 拒绝

**Files:**
- Modify: `apps/desktop/e2e/pilot.spec.ts` — 删除文件顶 `test.skip`；每个需要模型的 test 内 `test.skip(process.env.SPARKII_SKIP_LLM === '1')`
- Modify 或 Create: 批准用例在出现「审核完成」时 **本次停留内** `getByTestId('risk-card')` 至少 1（L3）。不要为 L3 先 home 再 open。
- Create: `apps/desktop/e2e/pilot-deny.spec.ts`（推荐独立 launch）
  - 同样上传/审核等到 dialog
  - 点「拒绝」
  - `expect(existsSync(join(exportDir, 'report.docx'))).toBe(false)`
  - 审计页 `/proposal.denied/`
  - 超时与批准相同量级（360s）

批准与拒绝不得共用一个 app 实例（第二次审批会与第一次的完成态缠在一起）。

- [ ] **Step 1:** 改 skip；L3 断言加进批准用例或并列 test（并列则两次 LLM，贵；**优先同一次批准 launch 加风险卡断言**）。
- [ ] **Step 2:** `SPARKII_SKIP_LLM=1` 时：L1/L2/C 仍跑，pilot 与 deny **跳过** 且不失败。
- [ ] **Step 3:** 有模型时跑 `pilot.spec.ts` + `pilot-deny.spec.ts`。
- [ ] **Step 4: Commit** `e2e: assert live findings and denied export`

---

### Task 5: README 跑法

**Files:** `README.md`、`README.en.md`

写清：先 `build:main`；Lane A+C 在 `SPARKII_SKIP_LLM=1` 下必须执行；Lane B 需要本机模型凭据。不要声称 CI 会跑 E2E。

- [ ] **Step 1:** 改两份 README。
- [ ] **Step 2: Commit** `docs: document playwright lanes and skip semantics`

---

### Task 6: P1 通用智能体 §12（P0 绿之后才开始）

**Files:** `apps/desktop/e2e/general.spec.ts` 或新 `general-write.spec.ts`

| test | skip | 要点 |
| --- | --- | --- |
| G1 纯问答不建桌面 Sparkii 文件夹 | LLM | 发一句闲聊；断言 `os.homedir()/Desktop` 下不新增 `Sparkii*`（只扫测试开始后的新目录，避免误伤用户桌面——**更稳：断言 SPARKII_DATA_DIR 外的 Desktop 增量**；若产品默认工作区不在 Desktop 而在 data dir，则断言 Desktop 无新增即可） |
| G2 创建 hello.txt 批准 | LLM | 审批 UI + 文件存在 + 审计 executed |
| G3/G6 拒绝 | LLM | 独立 launch；无文件 + denied |
| G4 指定工作区 | LLM | harness 提供已存在的 temp workspace；通过 Composer 工作区按钮选中（若 E2E 无法驱动原生选目录对话框：**允许** 只在有注入路径的现有 IPC 时做；没有则本条记入 spec 观察性降级，**不要新 IPC**） |
| G5 换模型 | 不强锁 | 无窗口可观察点则跳过实现，在 spec 保持「不强制」 |

P1 开始前确认：原生 `chooseWorkspace` 对话框能否像 `SPARKII_E2E_DOCUMENT` 一样已有 env 短路。没有则 G4 不做、不发明开关——回写到 spec「观察性」而不是改产品。

- [ ] **Step 1:** 只在 P0 合并后开做。先读 `chooseWorkspace` / workspace 是否已有 e2e env。
- [ ] **Step 2:** G1–G3 优先；G4/G5 按观察性。
- [ ] **Step 3: Commit** 按场景拆 commit，不要一锅。

---

## Suggested Implementation Order

1. Harness（Task 1）——后面所有 spec 依赖
2. testid（Task 2）
3. L1/L2（Task 3）——本轮真正要锁的回归
4. L3 + D1 + 拆 skip（Task 4）
5. README（Task 5）
6. P1（Task 6）——单独，不堵 P0 合并

不要先写 mock OpenAI。不要先加 CI。不要先做 compaction/崩溃 E2E。

## Self-Review Notes

- L1 若写成「等审核完成」就和旧 pilot 一样抓不住 bug。超时必须对准 `workflow_step_start`，不是对准 skill 结束。
- `agent-nav` ≠ 打开已有会话。L2 写错选择器会假绿（新草稿空页）。
- D1 必须独立 launch，否则批准用例已经把 report 写出去。
- 首页卡片 testid 已锁为 `agent-card-contract-review`。改 harness 时顺手修 `pilot.spec.ts`，否则 Lane B 会点不到卡片。
- Lane A 失败不要偷偷改成 skip。
