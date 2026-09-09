# SparkiiRAG Connector + 企业知识问答 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop 通过 Main 调用 SparkiiRAG 做检索与打开出处，并交付独立智能体「企业知识问答」；合同审核本期仍走 BM25；通用智能体不接知识库。

**Architecture:** Pi 只发出 `knowledge.search({ query })`，不持有 RAG Key、不传 datasetId。`connector_read` 把 read 工具交 Main 执行。Main 按 `profileOf().profile.manifest.knowledge.backend` 选择 SparkiiRAG 或 BM25，注入默认库或会话选中库。有命中时 JSONL 在助手正文后追加 `knowledge_turn.documents`；Renderer 用插槽折进同一气泡。空命中 abort，不经过大模型，写入 `knowledge_turn.refused`。不改写 assistant `text`。不走 SparkiiRAG 聊天补全。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron IPC、SparkiiRAG HTTP（`Authorization: Bearer`，成功 `code === 0`）。

**Spec:** `docs/superpowers/specs/2026-09-09-sparkii-rag-connector-design.md`（v7）

## Architect corrections

| 项 | 曾误写 | 现锁定 |
| --- | --- | --- |
| 选库 UI | 会话头 | Composer `toolbarExtra`；`picker === 'session'` 才挂；发送前 `await setSessionKnowledge` |
| 出处 | 工具卡当主 UI；id 解引用 | 相邻两行 assistant + `knowledge_turn`；同一气泡两截；权威是 `documents` 快照 |
| 空检索 | 覆盖模型正文 / `grounding_refuse` | abort + `knowledge_turn.refused`；文案「知识库没有相关内容，我无法回答。」 |
| Surface | 默认导出 StandardChat | 包一层插槽；禁止 `if (agent.id === 'knowledge-qa')` |
| schema | YAML 写 knowledge 即可 | **先**给 `manifestSchema` 加 `knowledge`，否则 Zod strip |
| backend 读取 | `agentOf().manifest.knowledge` | `rt.profileOf(id).profile.manifest.knowledge` |
| RAG Key | — | `getApiKey('sparkiirag')` 返回 null；`saveSettings` merge `rag` |

## Global Constraints

- 平台生产代码不以 `'knowledge-qa'` / `'general'` / `'contract-review'` 作为调用方式分支。后端与选库由 `manifest.knowledge.backend` / `manifest.knowledge.picker` 驱动。读字段用 `profileOf`。
- Pi 子进程不得 `fetch` SparkiiRAG，不得读取 `apiKey:sparkiirag`。
- `knowledge.search` 模型参数只有 `query` 与可选 `topK`。出现 `datasetId` 必须忽略或拒绝。
- `backend: sparkiirag` 未配好时 **prompt 前**失败，禁止静默退回 `corpus.json`。
- RAG Key：Main→Renderer 只给 `rag.hasApiKey`。`getApiKey('sparkiirag')` 返回 `null`。
- 不改通用智能体工具列表。合同审核本期 `backend: bm25`。
- 不调用 `/api/v1/openai/.../chat/completions`，不上传、不 parse、不建库。
- `src/surface/**` 不 import `agents/**`。加完 profile 后跑 `node apps/desktop/scripts/generate-surface-bindings.mjs`。
- 不改写 Pi 已写入的 assistant `text`。不把 `assistantId` 当 JSON 指针解 toolResult。
- 聊天管道复用 `useAgentSession`；禁止第二套乐观时间线。
- 检索超时 30s。审计 `tool.read` 只记 query 前 120 字 + 命中文件名。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| HTTP 客户端 | `packages/connectors/src/sparkiirag/` | Electron、Pi |
| 接地 / 打开原文 | `apps/desktop/electron/main/rag-*.ts` | Renderer、Pi |
| Composer 选库 | `toolbarExtra` 通用；控件在 `apps/desktop/src/surface/` | ChatComposer 不认识 dataset |
| 出处折气泡 | 知识问答 `surface/index.tsx` + `knowledge-citations.tsx` | StandardChat 不写死 `knowledge_turn` 布局 |

## File Structure

```text
packages/config/src/schema.ts
packages/config/src/types.ts
packages/ui/src/patterns/ChatComposer.tsx
packages/ui/src/patterns/Shell.tsx
apps/desktop/test/chat-composer-toolbar.test.tsx
apps/desktop/src/surface/standard-chat.tsx
apps/desktop/src/surface/contract.ts
apps/desktop/src/surface/knowledge-citations.tsx
apps/desktop/src/surface/KnowledgeDatasetPicker.tsx
apps/desktop/src/App.tsx
apps/desktop/agents/knowledge-qa/**
apps/desktop/agents/contract-review/manifest.yaml
apps/desktop/electron/main/rag-grounding.ts
apps/desktop/electron/main/rag-open.ts
apps/desktop/electron/main/ipc.ts
apps/desktop/electron/preload/api-types.ts
apps/desktop/electron/preload/api.ts
```

建议自检：

```text
pnpm exec vitest run packages/config/test/schema.test.ts packages/config/test/profile-dirs.test.ts
pnpm exec vitest run apps/desktop/test/chat-composer-toolbar.test.tsx apps/desktop/test/rag-grounding.test.ts apps/desktop/test/standard-chat-knowledge.test.tsx apps/desktop/test/knowledge-citations.test.tsx apps/desktop/test/surface-bindings.test.ts apps/desktop/test/ipc.test.ts apps/desktop/test/rag-search.test.ts
```

## Execution note

**Tasks 1–6 already landed** on `feat/sparkii-rag-connector`。不要重做客户端、`connector_read`、设置页。从 **Task 7** 开始。`sessionKnowledgeSelections` Map 已在 `ipc.ts`，尚无 `setSessionKnowledge` IPC。

---

### Task 7: `manifest.knowledge` 进 Zod（必须先于 YAML）

**Files:**
- Modify: `packages/config/src/schema.ts`
- Modify: `packages/config/src/types.ts`
- Test: `packages/config/test/schema.test.ts`

**Interfaces:**
- Consumes: 现有 `manifestSchema`
- Produces:

```ts
// ProfileManifest
knowledge?: {
  enabled: boolean
  picker: 'hidden' | 'session'
  backend: 'bm25' | 'sparkiirag'
}

// schema.ts
knowledge: z.object({
  enabled: z.boolean(),
  picker: z.enum(['hidden', 'session']),
  backend: z.enum(['bm25', 'sparkiirag']),
}).optional(),
```

- [ ] **Step 1: Write the failing test**

```ts
it('keeps optional knowledge on the parsed manifest', () => {
  const m = parseProfileManifest({
    name: 'knowledge-qa',
    version: '1.0.0',
    knowledge: { enabled: true, picker: 'session', backend: 'sparkiirag' },
    modelRouting: { tasks: { default: [{ provider: 'deepseek', modelId: 'deepseek-v4-flash' }] } },
  })
  expect(m.knowledge).toEqual({ enabled: true, picker: 'session', backend: 'sparkiirag' })
})

it('strips invalid knowledge.backend', () => {
  expect(() => parseProfileManifest({
    name: 'x',
    version: '1.0.0',
    knowledge: { enabled: true, picker: 'session', backend: 'pinecone' },
    modelRouting: { tasks: { default: [{ provider: 'local', modelId: 'qwen2.5:7b' }] } },
  })).toThrow()
})
```

- [ ] **Step 2:** `pnpm exec vitest run packages/config/test/schema.test.ts` — Expected: FAIL（`m.knowledge` undefined）

- [ ] **Step 3: Implement** schema + `ProfileManifest.knowledge?`

- [ ] **Step 4:** 同一命令 PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(config): keep manifest.knowledge on parsed profiles"
```

---

### Task 8: 企业知识问答 profile + listAgents 透出 knowledge

**Files:**
- Create: `apps/desktop/agents/knowledge-qa/` 全套 loader 必填文件
- Modify: `apps/desktop/agents/contract-review/manifest.yaml` 增加 `knowledge: { enabled: true, picker: hidden, backend: bm25 }`
- Modify: `apps/desktop/electron/main/ipc.ts` `listAgents`
- Modify: `apps/desktop/src/App.tsx` 把 `knowledge` 拷进 agents
- Modify: `packages/ui/src/patterns/Shell.tsx` `ShellAgent.knowledge?`
- Modify: `apps/desktop/src/surface/contract.ts` `AgentDescriptor.knowledge?`
- Modify: `apps/desktop/test/surface-bindings.test.ts`
- Modify: `packages/config/test/profile-dirs.test.ts`
- Run: `node apps/desktop/scripts/generate-surface-bindings.mjs`

**Interfaces:**
- Consumes: Task 7 schema
- Produces: `listAgents()` 项含可选 `knowledge`；`surfaceByAgent['knowledge-qa']`

`manifest.yaml`：

```yaml
name: knowledge-qa
displayName: 企业知识问答
sortOrder: 15
version: 1.0.0
surface:
  type: chat
knowledge:
  enabled: true
  picker: session
  backend: sparkiirag
capabilities:
  entry: agent/capabilities.ts
  tools: [knowledge.search, knowledge.fetch_document]
modelRequirements:
  requires: [chat, toolCall]
modelRouting:
  tasks:
    default:
      - { provider: deepseek, modelId: deepseek-v4-flash }
    title:
      - { provider: deepseek, modelId: deepseek-v4-flash }
```

不要 `skillLibrary: user`。`agent/tools.yaml` 仅 `knowledge.search` 与 `knowledge.fetch_document`。`agent/workflow.yaml`：`version: 1` / `engine: linear` / `steps: []`。`agent/knowledge/corpus.json`：`[]`。`security/approval.yaml`：`requireApproval: []`。tokens 从 `agents/contract-review/ui/theme/tokens.json` 拷最小一份。本任务 `surface/index.tsx` 可先 `export { StandardChatSurface as default }`；Task 10 再包插槽。

`system.md` 必须 `toContain`：回答前必须调用 `knowledge.search`；只根据工具返回的 chunks 写；用了第 n 段在句末标 `[n]`；没有命中禁止用通识。

`listAgents`：

```ts
knowledge: pr.profile.manifest.knowledge,
```

从 **profile manifest** 透出，不要 `agentOf().manifest`。`App.tsx` `setAgents` 把 `knowledge` 原样放进 `ShellAgent`。

- [ ] **Step 1: Failing tests**

```ts
// packages/config/test/profile-dirs.test.ts
it('loads knowledge-qa with sparkiirag session picker and search-only tools', async () => {
  const p = await loadProfile(join(repoRoot, 'apps/desktop/agents/knowledge-qa'), { allowUnsigned: true })
  expect(p.manifest.displayName).toBe('企业知识问答')
  expect(p.manifest.knowledge).toEqual({ enabled: true, picker: 'session', backend: 'sparkiirag' })
  expect(p.agent.tools).toEqual(['knowledge.search', 'knowledge.fetch_document'])
  expect(p.agent.prompts.system).toContain('knowledge.search')
})

// apps/desktop/test/surface-bindings.test.ts
expect(typeof surfaceByAgent['knowledge-qa']).toBe('function')
```

- [ ] **Step 2:** 跑上述测试 — Expected: FAIL（目录不存在 / schema 已过则 load 失败）

- [ ] **Step 3: 建 profile、改 listAgents/App/ShellAgent、跑 codegen**

- [ ] **Step 4:** 测试 PASS；`grep` 生产代码无 `if (profileId === 'knowledge-qa')`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agents): add knowledge-qa profile and expose manifest.knowledge"
```

---

### Task 9: Composer `toolbarExtra` + 选库 IPC（StandardChat 不挂 picker）

**Files:**
- Modify: `packages/ui/src/patterns/ChatComposer.tsx`
- Test: `apps/desktop/test/chat-composer-toolbar.test.tsx`
- Create: `apps/desktop/src/surface/KnowledgeDatasetPicker.tsx`（本任务可建文件；**挂载在 Task 10 的 knowledge-qa surface**）
- Modify: `apps/desktop/src/surface/standard-chat.tsx`（`toolbarExtra`、`hideWorkspace`、`onBeforeSend`；**不要** import picker）
- Modify: `apps/desktop/electron/main/ipc.ts`、preload（`setSessionKnowledge` + draft 迁移）
- Test: `apps/desktop/test/standard-chat-knowledge.test.tsx`（先测槽与发送顺序；下拉出现放到 Task 10）

**Interfaces:**
- Consumes: `listRagDatasets(): Promise<{ ok: boolean; datasets?: Array<{ id: string; name: string }>; error?: string }>`（已有，不要改成裸数组）
- Produces:

```ts
toolbarExtra?: ReactNode
hideWorkspace?: boolean
onBeforeSend?(): Promise<void>

setSessionKnowledge(
  sessionId: string,
  selection: { mode: 'ids'; datasetIds: string[] } | { mode: 'all' },
): Promise<{ ok: boolean; error?: string }>
```

`ChatComposer`：`toolbarExtra` 为 `ui-composer-toolbar-left` 第一个子节点。不接收 datasets。`hideWorkspace` 时不渲染工作区按钮。

`StandardChatSurface.send`：

```ts
setBusy(true)
try {
  await onBeforeSend?.()
} catch (e) {
  reportError(...)
  setBusy(false)
  return
}
const res = await api.promptSession(...)
if (!res?.ok && res?.ok !== undefined) {
  reportError(String(res.error ?? '发送失败'))
  setBusy(false)
  return
}
```

`promptSession`（Main）：`openOrCreateSession` **之后**、`client.send` **之前**：若 `sessionKnowledgeSelections` 有 `draft:${profileId}`，搬到真实 sessionId 并删除 draft。单测：第一次发送 `mode:'all'` 时 `onConnectorRead` 读到的是全部 id，不是默认库。

`setSessionKnowledge`：`sessionKnowledgeSelections.set(sessionId, selection)`。失败返回 `{ ok: false }`。

- [ ] **Step 1: Failing tests**

```tsx
it('renders toolbarExtra as the first left-toolbar child', () => {
  render(<ChatComposer {...base} toolbarExtra={<span data-testid="extra">库</span>} />)
  const left = document.querySelector('.ui-composer-toolbar-left')
  expect(left?.firstElementChild).toHaveAttribute('data-testid', 'extra')
})

it('hides workspace when hideWorkspace is set', () => {
  render(<ChatComposer {...base} hideWorkspace />)
  expect(screen.queryByTestId('composer-workspace')).toBeNull()
})

it('does not show dataset select when StandardChat has no toolbarExtra', () => {
  render(<StandardChatSurface {...chatProps({})} />)
  expect(screen.queryByTestId('knowledge-dataset-select')).toBeNull()
})

it('calls onBeforeSend before promptSession', async () => {
  const order: string[] = []
  const api = makeApi({
    setSessionKnowledge: async () => { order.push('knowledge'); return { ok: true } },
    promptSession: async () => { order.push('prompt'); return { ok: true, sessionId: 's1' } },
  })
  // StandardChat with onBeforeSend that awaits setSessionKnowledge
  // fire send → expect(order).toEqual(['knowledge', 'prompt'])
})

it('promptSession failure clears busy', async () => {
  // promptSession resolves { ok: false, error: '请先在设置 → 知识库配置 SparkiiRAG' }
  // expect error reported and composer not stuck busy
})
```

另写 ipc 单测：`draft:knowledge-qa` 在 create 后、send prompt 前迁到真实 id。

- [ ] **Step 2:** FAIL

- [ ] **Step 3: Implement**。StandardChat **不得** `import KnowledgeDatasetPicker`。

- [ ] **Step 4:** PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): composer toolbarExtra and session knowledge IPC"
```

---

### Task 10: 助手消息插槽 + 同一气泡出处

**Files:**
- Modify: `apps/desktop/src/surface/standard-chat.tsx`
- Create: `apps/desktop/src/surface/knowledge-citations.tsx`
- Modify: `apps/desktop/agents/knowledge-qa/surface/index.tsx`
- Create: `apps/desktop/src/surface/KnowledgeDatasetPicker.tsx`（若 Task 9 已建则此处只挂载）
- Test: `apps/desktop/test/knowledge-citations.test.tsx`
- Modify: `apps/desktop/test/standard-chat-knowledge.test.tsx`

**Interfaces:**
- Consumes: `CustomSessionEntry`、`ChatMessage`
- Produces:

```ts
export type KnowledgeTurnData = {
  refused?: boolean
  text?: string
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>
}

export const KNOWLEDGE_TURN = 'knowledge_turn'

export function parseKnowledgeTurn(entry: CustomSessionEntry): KnowledgeTurnData | null

export function KnowledgeAnswerBubble(props: {
  text: string
  thinking?: string
  streaming?: boolean
  documents: KnowledgeTurnData['documents']
  onOpenDocument?(doc: KnowledgeTurnData['documents'][number]): void
}): JSX.Element
```

`StandardChatProps` 增加：

```ts
emptyCopy?: { heading?: string; body?: string }
hideToolNames?: string[]
renderAssistantMessage?(args: {
  entry: Extract<ChatEntry, { kind: 'message'; role: 'assistant' }>
  following: CustomSessionEntry[]
}): ReactNode
renderCustomEntry?(entry: CustomSessionEntry): ReactNode | null
```

时间线 walk：

1. 纳入 `kind === 'custom'`。
2. `shouldShowEntry` 只用于 message / tool / event；custom 不走该函数。
3. 助手 message：收集其后连续 custom 为 `following`，调用 `renderAssistantMessage`。这些 following 不再单独画。
4. 其它 custom：`renderCustomEntry`。
5. `hideToolNames` 且已完成且非 debug：不画 ToolCard。运行中仍画。
6. 助手 `key` 必须是 `entry.id`。

知识问答 surface（`agent.knowledge` 驱动，不是 agent id）。**此处挂 picker**（StandardChat 不 import）：

```tsx
<StandardChatSurface
  {...props}
  emptyCopy={{ heading: agent.name, body: '可以询问制度条款。回答依据知识库检索结果。' }}
  hideWorkspace
  hideToolNames={['knowledge.search', 'knowledge_search']}
  composerSkills={null}
  toolbarExtra={agent.knowledge?.picker === 'session' ? <KnowledgeDatasetPicker ... /> : undefined}
  onBeforeSend={async () => {
    const key = sessionId ?? `draft:${agent.id}`
    await api.setSessionKnowledge(key, selection)
  }}
  renderAssistantMessage={({ entry, following }) => {
    const turn = following[0] && parseKnowledgeTurn(following[0])
    if (turn?.refused) {
      return <ChatMessage role="assistant" text={turn.text ?? RAG_REFUSE_TEXT} />
    }
    if (turn && !turn.refused) {
      return <KnowledgeAnswerBubble text={entry.text} thinking={entry.thinking} streaming={entry.streaming} documents={turn.documents} onOpenDocument={...} />
    }
    return <ChatMessage role="assistant" text={entry.text} thinking={entry.thinking} streaming={entry.streaming}><Markdown text={entry.text} /></ChatMessage>
  }}
  renderCustomEntry={(entry) => {
    const turn = parseKnowledgeTurn(entry)
    if (turn?.refused) return <ChatMessage role="assistant" text={turn.text ?? RAG_REFUSE_TEXT} />
    return null
  }}
/>
```

`composerSkills={null}` 关掉技能菜单（StandardChat 把该 prop 传给 ChatComposer 的 `skills`，不要自己再 listSkills）。`KnowledgeDatasetPicker`：选项 = `listRagDatasets().datasets` + `__all__`「全部可见库」。

`KnowledgeAnswerBubble`：上半 Markdown；`documents.length > 0` 时横线 + 出处按钮 `data-testid="knowledge-source"`。

通用不传这些 props。

- [ ] **Step 1: Failing tests**

```tsx
it('folds a knowledge_turn after an assistant message into one bubble', () => {
  render(<KnowledgeAnswerBubble text={'根据办法发放[1]'} documents={[{ documentId: 'd1', documentName: '高温作业津贴办法.pdf', datasetId: 'law' }]} />)
  expect(screen.getByText(/根据办法发放/)).toBeTruthy()
  expect(screen.getByTestId('knowledge-source')).toHaveTextContent('高温作业津贴办法.pdf')
})

it('assistant followed by refused knowledge_turn shows only refuse text', () => {
  // knowledge-qa surface entries: assistant '模型胡诌' + knowledge_turn refused
  expect(screen.getByText('知识库没有相关内容，我无法回答。')).toBeTruthy()
  expect(screen.queryByText('模型胡诌')).toBeNull()
  expect(screen.queryByTestId('knowledge-source')).toBeNull()
})

it('shows dataset select when knowledge-qa surface mounts picker', () => {
  // render knowledge-qa surface with picker session + mocked listRagDatasets
  expect(screen.getByTestId('knowledge-dataset-select')).toBeTruthy()
})

it('general chat without toolbarExtra has no dataset select', () => {
  render(<StandardChatSurface {...generalPropsWithAssistant('hello')} />)
  expect(screen.queryByTestId('knowledge-dataset-select')).toBeNull()
})
```

- [ ] **Step 2:** FAIL

- [ ] **Step 3: Implement**。打开原文 IPC 可先 `onOpenDocument` no-op，Task 11 接上。

- [ ] **Step 4:** PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): fold knowledge_turn into the assistant bubble"
```

---

### Task 11: 打开出处原文

**Files:**
- Create: `apps/desktop/electron/main/rag-open.ts`
- Modify: ipc / preload `openRagDocument`
- Modify: `knowledge-citations.tsx` 点击调用 API
- Modify: `onConnectorRead`：`knowledge.fetch_document` 走同一 cache，返回 `{ path }`
- Test: `apps/desktop/test/knowledge-citations.test.tsx`（open 单测可同文件或 `rag-open` 段）

**Interfaces:**

```ts
export async function fetchAndCacheDocument(opts: {
  client: { fetchDocument(datasetId: string, documentId: string): Promise<Uint8Array> }
  cacheDir: string
  datasetId: string
  documentId: string
  fileName?: string
}): Promise<{ path: string }>

openRagDocument(args: { datasetId: string; documentId: string; fileName?: string }): Promise<{ ok: boolean; path?: string; error?: string }>
```

缓存目录 `join(dataDir, 'rag-cache')`。文件名 `documentId` + 扩展名（Content-Disposition 或 `fileName`）。已存在则不重复下载。`openRagDocument` 调可注入的 `openFile`（测试不要真调 `shell.openPath`）。不经写审批。

- [ ] **Step 1: Failing test** — mock fetch 写 temp 目录，第二次调用不 fetch

- [ ] **Step 2–4:** 实现并接到气泡文件名点击

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): cache and open SparkiiRAG source documents"
```

---

### Task 12: 空检索 abort + 写入 `knowledge_turn`

**Files:**
- Create: `apps/desktop/electron/main/rag-grounding.ts`
- Create: `apps/desktop/test/rag-grounding.test.ts`
- Modify: `ipc.ts`：`onConnectorRead`（空结果返回后再调度 abort）。**不要**改 `ensureProcessPipe` 过滤 `message_*`。

**Interfaces:**

```ts
export const RAG_REFUSE_TEXT = '知识库没有相关内容，我无法回答。'
export const KNOWLEDGE_TURN = 'knowledge_turn'

export type GroundingTurn = {
  searchCalled: boolean
  miss: boolean
  documents: Array<{ documentId: string; documentName: string; datasetId: string }>
}

export function resetTurn(): GroundingTurn
export function markSearchResult(turn: GroundingTurn, result: { chunks: unknown[]; documents?: GroundingTurn['documents'] }): GroundingTurn
export function shouldAbortGeneration(turn: GroundingTurn): boolean
export function knowledgeTurnPayload(turn: GroundingTurn): { refused: boolean; text?: string; documents: GroundingTurn['documents'] }
export function isVisibleAssistantEnd(message: unknown): boolean
```

仅 `backend === 'sparkiirag'`。按 `sessionId` 存 `Map<string, GroundingTurn>`。**新用户 prompt**（`promptSession` 真正 `client.send({ type:'prompt' })` 前）`resetTurn`。

规则：

1. 空 chunks：工具结果先回 Pi；`miss=true`；**return connector_read 之后** `queueMicrotask` abort + append refused `knowledge_turn`。不要 await abort 再 return。
2. 有命中：仅在 `isVisibleAssistantEnd`（正文 `trim() !== ''`）的 `message_end` 立刻 append `{ refused: false, documents }`。不改 assistant jsonl。toolCall-only **不** append。`markSearchResult` 从 chunks 回填 `datasetId`。
3. **本期不做** Main 强制补搜 / `follow_up` / `steer`。
4. **不要**在 `onEvent` 丢掉 `message_*`。竞态由 Task 10 walk 用 refused following 替换助手正文。

- [ ] **Step 1: Failing tests**

```ts
it('empty chunks mark miss and refuse payload has no documents', () => {
  let turn = resetTurn()
  turn = markSearchResult(turn, { chunks: [], documents: [] })
  expect(shouldAbortGeneration(turn)).toBe(true)
  expect(knowledgeTurnPayload(turn)).toEqual({
    refused: true,
    text: RAG_REFUSE_TEXT,
    documents: [],
  })
})

it('fills datasetId from chunks when doc_aggs omit it', () => {
  let turn = resetTurn()
  turn = markSearchResult(turn, {
    chunks: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: 'law' }],
    documents: [{ documentId: 'd1', documentName: '办法.pdf', datasetId: '' }],
  })
  expect(knowledgeTurnPayload(turn).documents[0].datasetId).toBe('law')
})

it('toolCall-only message_end is not visible', () => {
  expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'knowledge.search' }] } })).toBe(false)
  expect(isVisibleAssistantEnd({ message: { role: 'assistant', content: '根据办法' } })).toBe(true)
})
```

不要写「pipe 丢掉 message_end」的测试。Surface 竞态由 Task 10 覆盖。

- [ ] **Step 2:** FAIL

- [ ] **Step 3: 接到 onConnectorRead 与可见 `message_end`。** 只对 `profileOf(...).manifest.knowledge.backend==='sparkiirag'` 生效。不改直播管道过滤。

- [ ] **Step 4:** PASS + `ipc.test.ts` 回归

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): abort empty retrieval and persist knowledge_turn"
```

---

### Task 13: 接线回归与禁止事项

**Files:**
- Modify: `apps/desktop/test/ipc.test.ts`
- Modify: `apps/desktop/test/saddle.test.ts` / workflow-broker（knowledge-qa 工具列表；general 仍无 knowledge.search）
- Modify: `packages/config/test/profile-dirs.test.ts`
- 若 `runtime-assemble.test.ts` 扫全部 agents，补 knowledge-qa 或允许空 corpus

核对（测试或 grep 锁死）：

- general tools 不含 `knowledge.search`
- 生产代码无 `if (agent.id === 'knowledge-qa')` / `profileId === 'knowledge-qa'`
- `getApiKey('sparkiirag')` 返回 null
- `saveSettings` 不丢掉 `rag`
- `knowledge.search` params 无 `datasetId`
- 无对 `/api/v1/openai/` 的引用（生产代码）
- 通用 StandardChat 无 `knowledge-dataset-select`

- [ ] **Step 1–4:** 补测试、修失败、跑本 plan 自检命令

- [ ] **Step 5: Commit**

```bash
git commit -m "test(desktop): lock knowledge-qa isolation and key secrecy"
```

---

## Self-review

| Spec 条目 | Task |
| --- | --- |
| SparkiiRAG 可配地址/Key | 已完成 1, 5, 6 |
| Desktop 不入库 | Non-goal |
| 设置「知识库」分组 | 已完成 6 |
| `manifest.knowledge` 不被 strip | 7 |
| 独立 knowledge-qa | 8 |
| Composer 选库 | 9 |
| 同一气泡出处 | 10 |
| 打开原文 | 11 |
| 空检索 abort（不做 follow_up 补搜） | 12 |
| 合同 BM25；问答禁止回退 corpus | 已完成 4 + 8 |
| 方案 2 connector_read | 已完成 3, 4 |
| Key 写后不可读 | 已完成 5, 6 |
| 隔离与禁止 openai chat | 13 |
