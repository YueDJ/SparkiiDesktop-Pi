# Contract Review V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把合同审核改成 2 个业务 skill + 单页工作台，并修复 workflow 历史会话无法回放、历史记录落入空白分类的问题。

**Architecture:** 主进程先修复 workflow session 身份，让 DB id 与 Pi JSONL id 一致；Agent 层把 `workflow.yaml` 简化为两个可见 skill，并把 `ContractAgentSurface` 重做为单页工作台；UI 只消费 `AgentSurfaceProps`。

**Tech Stack:** React 18 + Vite + Vitest + `@testing-library/react` + `@sparkii/ui` + Electron 主进程 IPC。

**Spec:** `docs/superpowers/specs/2026-09-02-contract-review-v2-design.md`

## Global Constraints

- `apps/desktop/src/surface/**` 不 import `apps/desktop/agents/**`。
- `apps/desktop/src/platform/agent-surface-bindings.ts` 是唯一 import agents 的生成物，改完 manifest 后运行 `node apps/desktop/scripts/generate-surface-bindings.mjs`。
- Agent surface 只通过 `AgentSurfaceProps` 与 `@sparkii/ui` 交互。
- 平台层不出现 `agentId === 'contract-review'` 组件级特判。
- 所有写操作走审批门；被拒绝的写不执行。
- UI 以 `docs/superpowers/mocks/contract-review-v1.html` 为视觉基线，最终页面应尽量与其一致。
- 模型选择/思考强度直接使用 `@sparkii/ui` 的 `ModelEffortControl`；上下文和工作区沿用 `ChatComposer.tsx` 中的既有 JSX/CSS 表现，不重新设计。
- 测试用 Vitest + `@testing-library/react`；renderer + electron `tsc --noEmit` 必须通过。
- 本机 node 路径：`C:\Users\YDJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`。
- 沙箱内跑测试/类型检查需要提权；`git add/commit` 需要提权。

---

## File Structure

```text
apps/desktop/agents/contract-review/agent/workflow.yaml     # 两个可见 skill + 两个隐藏 tool
apps/desktop/agents/contract-review/agent/skills/contract_risk_review/SKILL.md
apps/desktop/agents/contract-review/agent/skills/contract_report/SKILL.md
apps/desktop/agents/contract-review/surface/contract.ts      # 类型化解析
apps/desktop/agents/contract-review/surface/index.tsx        # 单页工作台
apps/desktop/agents/contract-review/surface/StepViews.tsx    # 删除或改为轻量步骤辅助
apps/desktop/src/styles.css                                  # 新工作台样式
apps/desktop/electron/main/workflow.ts                       # workflow session 身份修复
apps/desktop/electron/main/ipc.ts                            # openChatSession/listChatSessions 兼容
apps/desktop/test/contract-helpers.test.ts
apps/desktop/test/contract-surface.test.tsx
apps/desktop/test/workflow-broker.test.ts
apps/desktop/test/surface-normalize.test.ts
apps/desktop/test/use-agent-session.test.ts
apps/desktop/test/app-workflow.test.tsx
```

---

## Task 1: 修复 workflow session 身份

**Files:**
- Modify: `apps/desktop/electron/main/workflow.ts`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Consumes: `rt.pool.acquire(tempKey, opts)`、`slot.client.send({ type: 'new_session' })`、`rt.pool.renameSession`
- Produces: `runWorkflow` 返回 Pi 真实 session id，并写入 `piSessionFile`

- [ ] **Step 1: 写失败测试**

在 `workflow-broker.test.ts` 中新增用例，断言 `runWorkflow` 返回 Pi 返回的 session id，而不是预生成的 UUID：

```ts
it('uses the runtime session id for the workflow session record', async () => {
  const send = vi.fn();
  const getWindow = () => ({ webContents: { send } }) as any;
  const rt = {
    dataDir: mkdtempSync(join(tmpdir(), 'wf-identity-')),
    profileOf: () => ({
      profile: {
        manifest: { name: 'contract-review' },
        security: { approval: { timeoutMs: 50 } },
        agent: {
          tools: ['read'],
          prompts: { system: 'sys' },
          workflow: { version: 1, engine: 'linear', steps: [] },
        },
      },
    }),
    agentOf: () => ({
      id: 'contract-review',
      tools: ['read'],
      dir: 'C:/x',
      skillsDir: 'C:/x/skills',
      systemPrompt: 'sys',
    }),
    subject: { userId: 'admin' },
    gate: {
      submit: async () => ({ id: 'p1', status: 'pending', payloadHash: 'h', createdAt: Date.now() }),
      expire: async (id: string) => ({ id, status: 'expired' }),
    },
    pool: {
      acquire: async () => ({
        client: {
          send: async (cmd: any) => {
            if (cmd.type === 'new_session') return { success: true };
            if (cmd.type === 'get_state') {
              return { success: true, data: { sessionId: 'pi-workflow-1', sessionFile: 'C:/pi/sessions/pi-workflow-1.jsonl' } };
            }
            return { success: true };
          },
        },
        supervisor: { onProposal: () => {} },
      }),
      renameSession: vi.fn(),
      get: () => undefined,
      release: async () => {},
    },
    chatSessions: {
      create: vi.fn(),
      update: vi.fn(),
    },
  } as any;

  const broker = createBroker(rt, getWindow);
  const id = await runWorkflow(rt, getWindow, { documents: [] }, broker, 'contract-review');

  expect(id).toBe('pi-workflow-1');
  expect(rt.pool.renameSession).toHaveBeenCalledWith(expect.stringContaining('new:'), 'pi-workflow-1');
  expect(rt.chatSessions.create).toHaveBeenCalledWith(expect.objectContaining({
    id: 'pi-workflow-1',
    profileId: 'contract-review',
    piSessionFile: 'C:/pi/sessions/pi-workflow-1.jsonl',
  }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node <vitest.mjs> run workflow-broker`
Expected: FAIL，因为当前 `runWorkflow` 返回预生成的 UUID。

- [ ] **Step 3: 修改 `runWorkflow`**

把当前 `const sessionId = randomUUID();` 和 `rt.pool.acquire(sessionId, ...)` 改为：

```ts
export async function runWorkflow(
  rt: Runtime,
  getWindow: () => BrowserWindow | null,
  input: Record<string, unknown>,
  broker: ReturnType<typeof createBroker>,
  profileId: string,
): Promise<string> {
  const pr = rt.profileOf(profileId);
  const tempKey = `new:${randomUUID()}`;
  const slot = await rt.pool.acquire(tempKey, {
    saddle: buildAgentSaddle(rt.agentOf(profileId), join(rt.dataDir, 'sessions', tempKey)),
  });

  const freshResp = await slot.client.send({ type: 'new_session' });
  if (!freshResp.success) throw new Error(freshResp.error ?? 'new_session failed');
  const stateResp = await slot.client.send({ type: 'get_state' });
  if (!stateResp.success) throw new Error(stateResp.error ?? 'get_state failed');
  const sessionId = (stateResp.data as { sessionId?: string })?.sessionId;
  const sessionFile = (stateResp.data as { sessionFile?: string })?.sessionFile;
  if (!sessionId) throw new Error('runtime did not provide a session id');
  rt.pool.renameSession(tempKey, sessionId);

  const inputFiles = Array.isArray(input?.documents) ? JSON.stringify(input.documents) : null;
  rt.chatSessions?.create?.({
    id: sessionId,
    profileId,
    kind: 'workflow',
    currentStep: null,
    workspaceKind: 'auto',
    workspacePath: join(rt.dataDir, 'sessions', sessionId),
    inputs: inputFiles,
    piSessionFile: sessionFile ?? null,
  });

  slot.supervisor.onProposal((req) => broker.route(req, { sessionId, profileId }));
  // 后续事件发送与 workflow 执行逻辑继续使用 sessionId，不再使用旧的 randomUUID。
  // ...（原 try/finally 结构不变）
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node <vitest.mjs> run workflow-broker`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/workflow.ts apps/desktop/test/workflow-broker.test.ts
git commit -m "fix(workflow): use pi session id for workflow history"
```

---

## Task 2: 简化 workflow 并新增两个 skill

**Files:**
- Modify: `apps/desktop/agents/contract-review/agent/workflow.yaml`
- Create: `apps/desktop/agents/contract-review/agent/skills/contract_risk_review/SKILL.md`
- Create: `apps/desktop/agents/contract-review/agent/skills/contract_report/SKILL.md`
- Test: `apps/desktop/test/workflow-broker.test.ts`

**Interfaces:**
- Produces: workflow 步骤 `load/search/review/report`，其中用户可见 `review/report`
- `contract_risk_review` 输出 `riskFindings[]`
- `contract_report` 输出 `sections[]` + `riskTable`

- [ ] **Step 1: 写失败测试**

在 `workflow-broker.test.ts` 新增：

```ts
it('resolves the two visible business skills plus hidden tools', () => {
  const def = {
    version: 1,
    engine: 'linear',
    steps: [
      { id: 'load', type: 'tool', ref: 'document.read', map: { documents: 'documents' } },
      { id: 'search', type: 'tool', ref: 'knowledge.search', map: { query: 'load.text' } },
      { id: 'review', type: 'skill', ref: 'contract_risk_review', inputs: { from: ['load', 'search'] } },
      { id: 'report', type: 'skill', ref: 'contract_report', inputs: { from: 'review' } },
    ],
  } as any;
  const resolved = resolveWorkflowTemplates(def);
  expect(resolved.steps.map((s) => s.id)).toEqual(['load', 'search', 'review', 'report']);
  expect(resolved.steps.find((s) => s.id === 'review')?.template).toContain('contract_risk_review');
  expect(resolved.steps.find((s) => s.id === 'report')?.template).toContain('contract_report');
});
```

- [ ] **Step 2: 运行测试确认失败**

Expected: FAIL，当前 workflow 仍是 `load/search/extract/compare/report`。

- [ ] **Step 3: 更新 `workflow.yaml`**

```yaml
version: 1
engine: linear
steps:
  - { id: load,    type: tool,  ref: document.read,   map: { documents: documents } }
  - { id: search,  type: tool,  ref: knowledge.search, map: { query: load.text } }
  - { id: review,  type: skill, ref: contract_risk_review, inputs: { from: [load, search] } }
  - { id: report,  type: skill, ref: contract_report, inputs: { from: review } }
```

- [ ] **Step 4: 新增 `contract_risk_review/SKILL.md`**

```markdown
---
name: contract_risk_review
description: 从合同文本和检索到的法规片段中抽取条款并完成风险比对，输出严格 JSON。
---

你收到已解析的合同文本，以及本地检索到的相关规则片段。
请完成：
1. 抽取关键条款。
2. 将条款与规则片段逐条比对。
3. 输出严格 JSON，不输出 Markdown 或额外文字：

{"summary":{"clauseCategories":8,"ruleHits":12,"high":2,"mid":5,"low":1},"riskFindings":[{"id":"r1","title":"付款周期过长","level":"high","clause":"第7条 付款条件","position":"p12","ruleId":"rg-01","ruleText":"账期≤30天","reason":"账期超过基准","advice":"约定逾期违约金"}],"evidence":[{"id":"e1","kind":"clause","label":"付款条款","text":"..."}]}

level 只取 high / mid / low。
```

- [ ] **Step 5: 新增 `contract_report/SKILL.md`**

```markdown
---
name: contract_report
description: 根据风险发现生成结构化审核报告。
---

根据 riskFindings 生成结构化报告，输出严格 JSON：

{"title":"合同审核报告","sections":[{"heading":"结论","body":"..."},{"heading":"风险明细","body":"..."},{"heading":"修改建议","body":"..."}],"riskTable":{"totals":{"high":2,"mid":5,"low":1}}}
```

- [ ] **Step 6: 运行测试并提交**

Run: `node <vitest.mjs> run workflow-broker`

```bash
git add apps/desktop/agents/contract-review/agent/workflow.yaml apps/desktop/agents/contract-review/agent/skills/contract_risk_review apps/desktop/agents/contract-review/agent/skills/contract_report apps/desktop/test/workflow-broker.test.ts
git commit -m "feat(contract): collapse workflow to two visible skills"
```

---

## Task 3: 扩展风险与条款归一化

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/contract.ts`
- Test: `apps/desktop/test/contract-helpers.test.ts`

**Interfaces:**
- Consumes: `contract_risk_review` 输出 `{ riskFindings: [...] }`
- Produces: `parseRiskFindings(rows)` 仍返回 `RiskFinding[]`

- [ ] **Step 1: 写失败测试**

```ts
it('unwraps the new contract_risk_review result shape', () => {
  const out = parseRiskFindings({
    riskFindings: [
      { id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' },
    ],
  });
  expect(out).toEqual([{ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' }]);
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 修改 `parseRiskFindings` 入口**

```ts
export function parseRiskFindings(rows: unknown): RiskFinding[] {
  if (!rows) return [];
  if (!Array.isArray(rows) && typeof rows === 'object') {
    const rec = rows as Record<string, unknown>;
    if (Array.isArray(rec.riskFindings)) return parseRiskFindings(rec.riskFindings);
    if (Array.isArray(rec.comparisons)) return parseRiskFindings(rec.comparisons);
    return [];
  }
  if (!Array.isArray(rows)) return [];
  // 原有数组处理保持不变
}
```

- [ ] **Step 4: 运行测试并提交**

Run: `node <vitest.mjs> run contract-helpers`

```bash
git add apps/desktop/agents/contract-review/surface/contract.ts apps/desktop/test/contract-helpers.test.ts
git commit -m "feat(contract): normalize risk review result shape"
```

---

## Task 4: 重做合同审核单页工作台

**Files:**
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Modify: `apps/desktop/agents/contract-review/surface/StepViews.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/test/contract-surface.test.tsx`

**Interfaces:**
- Consumes: `AgentSurfaceProps`、`session.entries`、`session.meta`、`actions`
- Produces: `ContractAgentSurface` 单页工作台

- [ ] **Step 1: 写失败测试**

在 `contract-surface.test.tsx` 中新增：

```tsx
it('renders the single-page cockpit with review and report panels', () => {
  const entries = normalizeSessionEntries([
    { type: 'workflow_step_start', data: { stepId: 'review' } },
    { type: 'workflow_step_end', data: { stepId: 'review', status: 'completed' } },
    { type: 'workflow_state', data: { stepId: 'review', action: 'result', payload: {
      review: { riskFindings: [{ id: 'r1', title: '付款周期过长', level: 'high', advice: '约定逾期违约金' }] },
      report: { title: '合同审核报告', sections: [{ heading: '结论', body: '关注' }] },
    } } },
  ]);
  render(
    <ContractAgentSurface
      agent={{ id: 'contract-review', name: '合同审核智能体', surfaceType: 'workflow' }}
      sessionId="s1"
      mode="history"
      session={{ entries, streaming: false, status: 'done', meta: { currentStep: 'report', inputs: [{ path: 'C:/tmp/a.pdf', name: 'a.pdf' }] } }}
      actions={{ newSession: vi.fn(), openSession: vi.fn(), startWorkflow: vi.fn(), review: vi.fn(), requestExport: vi.fn(), chooseDocument: vi.fn().mockResolvedValue({}) }}
    />,
  );
  expect(screen.getByText('a.pdf')).toBeTruthy();
  expect(screen.getByText('风险发现')).toBeTruthy();
  expect(screen.getByText('付款周期过长')).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 重写 `ContractAgentSurface`**

按 mockup 的固定头部、双栏、可收起面板、风险操作、报告预览、合并/导出流程实现。核心结构：

模型选择使用 `ModelEffortControl`；上下文与工作区的顶部区域直接复用 `ChatComposer.tsx` 中的现有结构，不要另起一套样式。

```tsx
export function ContractAgentSurface(props: AgentSurfaceProps) {
  const { sessionId, session, actions } = props;
  const timeline = deriveWorkflowTimeline(session.entries);
  const status = session.status && session.status !== 'idle' ? session.status : timeline.status;
  const currentStep = session.meta.currentStep ?? timeline.step ?? null;
  const result = session.result ?? extractWorkflowResult(session.entries);
  const reviewPayload = (result?.['review'] ?? result?.['compare'] ?? result) as unknown;
  const findings = parseRiskFindings(reviewPayload);
  const report = formatReport(result?.['report']);
  const inputs = session.meta.inputs ?? [];
  const fileName = inputs[0]?.name ?? inputs[0]?.path?.split(/[\\/]/).pop() ?? '';
  const [documents, setDocuments] = useState<string[]>(inputs.map((i) => i.path));
  const [reviewed, setReviewed] = useState<Record<string, string>>({});
  const [reportMerged, setReportMerged] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const applyReview = (id: string, action: 'confirmed' | 'ignored' | 'escalated') => {
    setReviewed((prev) => ({ ...prev, [id]: prev[id] === action ? 'none' : action }));
    actions.review(`risk_${action}`, { riskId: id, stepId: 'review' });
  };

  const mergeReport = () => {
    setReportMerged(true);
    actions.review('report_merged', { stepId: 'report' });
  };

  return (
    <div className="contract-workbench">
      <div className="contract-stage">
        <span className="contract-stage-item done">审核</span>
        <span className="contract-stage-item done">报告</span>
        <span className={`contract-stage-item human ${reportMerged ? 'done' : 'warn'}`}>复核</span>
      </div>
      <div className={`contract-split ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
        <section className="contract-panel contract-panel--doc">
          <header className="contract-panel-head">
            <b>合同原文</b>
            <button aria-label="收起合同原文" onClick={() => setLeftCollapsed((v) => !v)}>‹</button>
          </header>
          <div className="contract-panel-body">{fileName}</div>
        </section>
        <section className="contract-panel contract-panel--risk">
          <header className="contract-panel-head">
            <b>风险发现</b>
            <span>已复核 {Object.values(reviewed).filter((v) => v !== 'none').length} / {findings.length}</span>
            <button aria-label="收起风险发现" onClick={() => setRightCollapsed((v) => !v)}>›</button>
          </header>
          <div className="contract-panel-body">
            {findings.map((f) => (
              <article key={f.id} className={`contract-risk ${reviewed[f.id] ?? ''}`}>
                <RiskBadge risk={f.level === 'high' ? '高风险' : f.level === 'mid' ? '中风险' : '低风险'} />
                <b>{f.title}</b>
                <div className="contract-risk-actions">
                  <button onClick={() => applyReview(f.id, 'confirmed')}>确认</button>
                  <button onClick={() => applyReview(f.id, 'ignored')}>忽略</button>
                  <button onClick={() => applyReview(f.id, 'escalated')}>升级</button>
                </div>
              </article>
            ))}
            {report && <div className="contract-report"><Markdown text={report.blocks.map((b) => `${b.heading ? `## ${b.heading}` : ''}\n${b.body}`).join('\n\n')} /></div>}
            <button className="ui-btn ui-btn--primary" disabled={!findings.length || reportMerged} onClick={mergeReport}>合并到报告</button>
            <button className="ui-btn ui-btn--primary" disabled={!reportMerged} onClick={() => actions.requestExport()}>导出报告</button>
          </div>
        </section>
      </div>
      {status === 'idle' && (
        <div className="contract-idle">
          <button onClick={async () => { const r = await actions.chooseDocument(); if (r?.path) setDocuments((xs) => [...xs, r.path!]); }}>选择合同文件</button>
          <button onClick={() => actions.startWorkflow({ documents })}>开始审核</button>
        </div>
      )}
    </div>
  );
}
```

> 保留 `ContractSurface` 作为旧 props 的适配器，App 通过 `agent-surface-bindings.ts` 渲染 `ContractAgentSurface`。

- [ ] **Step 4: 添加样式**

在 `apps/desktop/src/styles.css` 增加 `contract-workbench`、`contract-stage`、`contract-split`、`contract-panel` 等类，使用现有 token，固定头部/阶段条，主区滚动。

- [ ] **Step 5: 运行测试并提交**

Run: `node <vitest.mjs> run contract-surface`

```bash
git add apps/desktop/agents/contract-review/surface/index.tsx apps/desktop/agents/contract-review/surface/StepViews.tsx apps/desktop/src/styles.css apps/desktop/test/contract-surface.test.tsx
git commit -m "feat(contract): single-page review cockpit"
```

---

## Task 5: 历史回放时标记原文件缺失

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`
- Modify: `apps/desktop/src/surface/use-agent-session.ts`
- Modify: `apps/desktop/agents/contract-review/surface/index.tsx`
- Test: `apps/desktop/test/use-agent-session.test.ts`

**Interfaces:**
- Consumes: `openChatSession` 返回 `inputs: { path: string; name?: string; missing?: boolean }[]`
- Produces: `session.meta.inputs` 带 `missing` 标记；surface 在原文缺失时显示“无法找到原文件”

- [ ] **Step 1: 写失败测试**

```ts
it('marks input files that no longer exist during history replay', async () => {
  (globalThis as any).window = {
    sparkii: {
      openChatSession: vi.fn().mockResolvedValue({
        entries: [],
        inputs: [{ path: 'C:/gone/contract.pdf', name: 'contract.pdf', missing: true }],
      }),
      on: vi.fn().mockReturnValue(() => {}),
    },
  };
  const { result } = renderHook(() => useAgentSession('contract-review', 's1', 'history'));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(result.current.meta.inputs).toEqual([{ path: 'C:/gone/contract.pdf', name: 'contract.pdf', missing: true }]);
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: `openChatSession` 返回 missing 标记**

在 `ipc.ts` 的 `parseSessionInputs` 调用后，对每个输入文件补上 `missing: !existsSync(path)`。

- [ ] **Step 4: `use-agent-session` 透传 missing**

```ts
const inputs = Array.isArray(res?.inputs)
  ? res.inputs.map((i: any) => typeof i === 'string'
    ? { path: i }
    : {
        path: String(i?.path ?? ''),
        name: typeof i?.name === 'string' ? i.name : undefined,
        missing: Boolean(i?.missing),
      })
  : undefined;
```

- [ ] **Step 5: surface 显示缺失状态**

在 `ContractAgentSurface` 中，当 `inputs[0]?.missing` 为 true 时，原文面板显示“无法找到原文件”，但风险发现和报告仍从 `session.entries` 渲染。

- [ ] **Step 6: 运行测试并提交**

```bash
git add apps/desktop/electron/main/ipc.ts apps/desktop/src/surface/use-agent-session.ts apps/desktop/agents/contract-review/surface/index.tsx apps/desktop/test/use-agent-session.test.ts
git commit -m "feat(contract): degrade gracefully when original file is missing"
```

---

## Task 6: 保证历史会话按智能体归组

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/test/app-workflow.test.tsx`

**Interfaces:**
- Consumes: `api.listChatSessions()` 返回 `profileId`
- Produces: sessions 按 `contract-review` 分组

- [ ] **Step 1: 写失败测试**

在 `app-workflow.test.tsx` 中新增：

```tsx
it('groups workflow sessions under contract-review', async () => {
  const { api } = makeApi();
  api.listChatSessions = vi.fn().mockResolvedValue([{ id: 'pi-workflow-1', profileId: 'contract-review', title: '采购合同', updatedAt: 1 }]);
  render(<App />);
  await screen.findByText(/工作台/);
  expect(await screen.findByText('采购合同')).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 修正 `refreshSessions` 的 profileId 兜底**

当后端返回 `profileId` 为空时，不放入 `''` 分组；如果会话可从当前 workflow 状态推断 agent，则用该 agent。核心：

```ts
const profileId = s.profileId ?? '';
if (!profileId) {
  const owner = Object.entries(workflowByAgentRef.current).find(([, w]) => w.sessionId === s.id)?.[0];
  s.profileId = owner ?? '';
}
```

> Task 1 已经让 workflow DB record 带有 `profileId`；这里是给旧数据/异常数据兜底，避免空白分类。

- [ ] **Step 4: 运行测试并提交**

```bash
git add apps/desktop/src/App.tsx apps/desktop/test/app-workflow.test.tsx
git commit -m "fix(app): group workflow sessions under their agent"
```

---

## Task 7: 运行全量验证与 codegen

- [ ] **Step 1: 重新生成 surface 绑定**

Run: `node apps/desktop/scripts/generate-surface-bindings.mjs`

- [ ] **Step 2: 全量测试**

Run: `node <vitest.mjs> run`
Expected: 全部通过。

- [ ] **Step 3: 类型检查**

Run: `node <node_modules/.pnpm/typescript.../tsc> --noEmit -p apps/desktop/tsconfig.json` 与 `apps/desktop/tsconfig.electron.json`

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(contract): v2 single-page review workbench"
```

## Self-Review

1. Spec coverage：两个 skill、单页工作台、复核语义、历史归组均有任务覆盖。
2. Placeholder scan：无 TBD/TODO；关键实现给出具体代码。
3. Type consistency：`parseRiskFindings`、`RiskFinding`、`AgentSurfaceProps` 命名一致。
