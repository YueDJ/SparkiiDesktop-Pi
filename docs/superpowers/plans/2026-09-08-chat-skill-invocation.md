# 通用聊天技能调用 Implementation Plan

> **For agentic workers:** 本 plan 已经架构师审过（第二轮 Approve）。用 superpowers:executing-plans（或 subagent-driven-development）按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。

**Goal:** 聊天不再把 `/name` 改写成 `/skill:name`。用户原文写入 Pi jsonl；模型用 `<available_skills>` + `read` 加载 SKILL.md。Composer 提供 `/` 菜单与前导 chip；时间线把 destName 形 `/name` 投影成技能 chip。合同审核 workflow 的 `/skill:` 展开不动。

**Architecture:** 发送路径去掉 `expandLeadingSkillSlash` 与 aliases。保留 `mergeSaddleSystemPrompt`。列举走 `listAgentSkills(agentId)`（`rt.agents.get` + `listUserSkills(agent.skillsDir)`）。菜单和 Composer chip 在 `ChatComposer`；时间线投影是对 jsonl 文本的纯函数。平台不按智能体 id 分叉。

**Tech Stack:** TypeScript、Vitest、React Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-08-chat-skill-invocation-design.md`

## Architect corrections

已吸收（含第二轮 Block / nits，无需产品再拍板）：

| 项 | 曾误写 | 现锁定 |
| --- | --- | --- |
| 身份 | 文件夹 → frontmatter 别名 | **只**子目录名（`listUserSkills.name`）。删 `skillSlashAliases` |
| Composer 空列表 | `[]` 不出菜单 | `null`/`undefined` 才不出；**fulfilled** `[]` →「还没有安装技能」 |
| loading | 未写 / 易用 `[]` | 首次 settle 前只能 `null`；禁止 `[]` 表示 loading |
| IPC | `agentOf` | `rt.agents.get`；未知 `{ skills: [] }` |
| 报错 source | `displayName` | `source: agent.name`（`AgentDescriptor` 无 displayName） |
| 列表刷新 | 仅 mount | mount + **window focus** |
| 解析空白 | `/^\s+/` 与「保留换行」打架 | name 后只消费 **一个** 空白字符（`/^\s/`） |
| chip 字符 | 列表名都 chip | 仅 destName 形；下划线名可列表/插入，不 chip |
| 菜单 vs chip | 混用 parse | 菜单看「行首/空白后的 `/` + 连续非空白」；chip 只看整段前导 destName |
| 列举过滤 | 用 `isDestName` 滤菜单 | **不要**滤；包内 `contract_risk_review` 必须能列 |
| 失败态 | 失败当 `[]` | 失败 / API 缺失 → `skills={null}` |
| Task 3 夹具 | `skillsDir` 指 skill 根 | `skillsDir` = **库根**；`contract_risk_review` 是其子目录 |
| Task 1 测试 | 只禁三个函数名 | 禁止 `withSkillSlash` 与 `/skill:` 拼接；`text` 原样进入 prompt/steer/followUp |
| 附件 | 未写 | 渲染层 `📎` 前缀 → 本轮不 chip；不改附件 |
| system.md | 只信 catalog `<name>` | **同时**要求「父目录」+ `read`；禁止 catalog `<name>` 当唯一对齐键 |
| 设置深链 | 「能链则链」 | 本轮只写「可到设置 → 技能安装」，不新开路由 |

## Product forks

none。决策已在对话与 spec 收口。

## Global Constraints

- 平台生产代码（`apps/desktop/electron`、`packages/*`，测试除外）不以 `'general'` / `'contract-review'` 作为调用方式分支。
- 聊天 `prompt` / `steer` / `followUp` 不得把 `/name` 改写成 `/skill:name`。不得删除或拦截已有的 `/skill:` 原文（workflow 共用 host）。
- 不新增 jsonl custom 类型表示「点了 skill」。
- 不改合同审核 workflow、profile 签名、Gate、`resolveWorkflowTemplates`。
- 保留 `mergeSaddleSystemPrompt`（catalog 可见）。
- `apps/desktop/src/surface/**` 不 import `agents/**`。
- 相关旧测试按新语义改，不放宽隔离断言。
- 本轮不抽 `isDestName` 共享包；`packages/ui` 复制同一条正则。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| 去掉聊天 slash 改写 | `packages/agent-host` `pi-sdk-runtime.ts` / `skill-prompt.ts` | workflow / LinearRunner |
| 保留 catalog 合并 | 已有 `mergeSaddleSystemPrompt` | 不要改回整段替换 |
| `parseLeadingSkillSlash` | `packages/ui/src/patterns/skill-slash.ts` | renderer 临时正则、agent-host（host 不再解析 slash） |
| slash 菜单 + 前导 chip | `packages/ui` `ChatComposer.tsx` + `styles.css` | 合同 Surface、`workbench/Composer.tsx`（不接线） |
| `listAgentSkills` | desktop `ipc.ts` + 已有 `listUserSkills(skillsDir)` | 设置页改走这条 |
| 时间线 chip | `standard-chat.tsx`（`ChatMessage` children） | 改 Pi jsonl、改 `ChatMessage` 协议 |
| 调用句 | `agents/general/agent/prompts/system.md` | 合同 system.md |
| DESIGN | 仓库根 `DESIGN.md` Surfaces §2 | 不存在的 `agents/general/DESIGN.md` |

## File Structure

```text
packages/agent-host/src/skill-prompt.ts          # 删 expand / aliases；留 merge
packages/agent-host/src/pi-sdk-runtime.ts
packages/agent-host/test/skill-prompt.test.ts
packages/agent-host/test/pi-sdk-runtime.test.ts

packages/ui/src/patterns/skill-slash.ts          # 新
packages/ui/src/patterns/ChatComposer.tsx
packages/ui/src/styles.css
packages/ui/src/index.ts

apps/desktop/electron/main/ipc.ts
apps/desktop/electron/preload/api-types.ts
apps/desktop/electron/preload/api.ts
apps/desktop/src/surface/standard-chat.tsx
apps/desktop/agents/general/agent/prompts/system.md

apps/desktop/test/skill-slash.test.ts            # 或 ui-chat-patterns 同文件
apps/desktop/test/ipc.test.ts
apps/desktop/test/preload-api.test.ts
apps/desktop/test/ui-chat-patterns.test.tsx      # ChatComposer 菜单 / chip
apps/desktop/test/chat-composer.test.tsx         # workbench 包装回归，不传 skills
apps/desktop/test/standard-chat.test.tsx
apps/desktop/test/runtime-assemble.test.ts
apps/desktop/test/skill-library.test.ts          # 若补「非法 frontmatter → 文件夹名」

DESIGN.md
docs/superpowers/specs/2026-09-08-general-agent-skills-library-design.md
docs/superpowers/specs/2026-09-08-chat-skill-invocation-design.md
```

建议自检（实现阶段每任务跑子集，全部做完跑一遍）：

```text
pnpm exec vitest run packages/agent-host/test/skill-prompt.test.ts \
  packages/agent-host/test/pi-sdk-runtime.test.ts \
  packages/agent-host/test/workflow.test.ts \
  apps/desktop/test/workflow-broker.test.ts \
  apps/desktop/test/skill-slash.test.ts \
  apps/desktop/test/ipc.test.ts \
  apps/desktop/test/preload-api.test.ts \
  apps/desktop/test/chat-composer.test.tsx \
  apps/desktop/test/ui-chat-patterns.test.tsx \
  apps/desktop/test/standard-chat.test.tsx \
  apps/desktop/test/runtime-assemble.test.ts
```

---

### Task 1: 聊天发送路径不再改写 `/name`

**Files:** `packages/agent-host/src/pi-sdk-runtime.ts`、`skill-prompt.ts`、对应测试

- `adaptSession` 的 `prompt` / `steer` / `followUp` 传原文，去掉 `withSkillSlash`。
- `configureSaddle` 不再 `loadSkillSlashAliases`；删除 `pendingSkillAliases`。
- 删除 `expandLeadingSkillSlash`、`skillSlashAliases`、`loadSkillSlashAliases`（确认无其它生产调用方）。
- **保留** `mergeSaddleSystemPrompt` / `applySaddleSystemPrompt` / `before_agent_start` 及测试。

**Tests：**

- 删除 `skill-prompt.test.ts` 里 expand / aliases 两个 describe。
- `pi-sdk-runtime.test.ts`：去掉 `expandLeadingSkillSlash` import 与「`/using-superpowers` → `/skill:`」断言；保留 catalog merge 断言。
- `skill-prompt.ts` 不再导出 `expandLeadingSkillSlash` / `skillSlashAliases` / `loadSkillSlashAliases`。
- `pi-sdk-runtime.ts` 源码形状（`readFileSync`）：
  - 不含 `expandLeadingSkillSlash`、`loadSkillSlashAliases`、`skillSlashAliases`、`withSkillSlash`。
  - 不含把用户输入拼成 `` `/skill:${…}` `` 或 `"/skill:" +` 的改写（workflow 不走此文件的这段 adaptSession）。
  - `prompt` / `steer` / `followUp` 的形参 `text` 原样进入 `startPromptWithoutBlocking(session, text, …)` / `session.steer(text, …)` / `session.followUp(text, …)`。
- 只禁函数名不够：换名或内联改写必须被上面的形状断言挡住。有可测缝再补行为 spy；本任务不要求真起 Pi。
- `workflow.test.ts` / `workflow-broker.test.ts`：`/skill:clause_extract`、`/skill:contract_risk_review` 仍在。

跑：`pnpm exec vitest run packages/agent-host/test/skill-prompt.test.ts packages/agent-host/test/pi-sdk-runtime.test.ts packages/agent-host/test/workflow.test.ts apps/desktop/test/workflow-broker.test.ts`

- [ ] Step 1: 改测试（改写用例改为「不再导出 / 不再改写」）
- [ ] Step 2: 跑红
- [ ] Step 3: 最小实现
- [ ] Step 4: 跑绿
- [ ] Step 5: Commit

```bash
git add packages/agent-host/src/skill-prompt.ts packages/agent-host/src/pi-sdk-runtime.ts \
  packages/agent-host/test/skill-prompt.test.ts packages/agent-host/test/pi-sdk-runtime.test.ts
git commit -m "fix(agent-host): stop rewriting chat slashes to /skill:"
```

---

### Task 2: `parseLeadingSkillSlash`

**Files:** `packages/ui/src/patterns/skill-slash.ts`（新）、`packages/ui/src/index.ts`、`apps/desktop/test/skill-slash.test.ts`（新；desktop 已有 RTL/vitest 惯例）

```ts
export function parseLeadingSkillSlash(text: string): { name: string; rest: string } | null
```

规则锁死见 spec「Timeline」。与 `isDestName` 同语义，本轮在此文件复制：

```ts
const DEST_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// name.length >= 1 && name.length <= 64 && DEST_NAME_RE.test(name)
```

此函数 **只** 给 Composer chip 与时间线投影。`listAgentSkills` / 菜单插入 **不要** 用它过滤。

**Tests：**

| 输入 | 期望 |
| --- | --- |
| `/brainstorming` | `{ name: "brainstorming", rest: "" }` |
| `/brainstorming 帮我拆` | rest = `帮我拆` |
| `/brainstorming\n\n第二段`（name 后只吃一个空白） | rest = `\n第二段` |
| `/brainstorming   x` | rest = `  x` |
| `  /brainstorming`（前导空白） | 仍成功 |
| `/skill:brainstorming` | `null` |
| `/superpowers` | `{ name: "superpowers", rest: "" }` |
| `请看 /brainstorming` | `null` |
| `/BRAINSTORMING` / `/MySkill` | `null` |
| `/` + 65 个 `a` | `null` |
| `/contract_risk_review` | `null` |
| `hello` | `null` |

跑：`pnpm exec vitest run apps/desktop/test/skill-slash.test.ts`

- [ ] Step 1: 写失败测试
- [ ] Step 2: 跑红
- [ ] Step 3: 实现并 `export *` from `@sparkii/ui`
- [ ] Step 4: 跑绿
- [ ] Step 5: Commit

```bash
git add packages/ui/src/patterns/skill-slash.ts packages/ui/src/index.ts apps/desktop/test/skill-slash.test.ts
git commit -m "feat(ui): parse leading destName-shaped skill slash"
```

---

### Task 3: `listAgentSkills` IPC

**Files:** `apps/desktop/electron/main/ipc.ts`、`preload/api-types.ts`、`preload/api.ts`、`test/ipc.test.ts`、`test/preload-api.test.ts`

```ts
ipcMain.handle('sparkii:listAgentSkills', async (_e, agentId: string) => {
  const agent = rt.agents.get(String(agentId ?? ''))
  if (!agent) return { skills: [] }
  return { skills: await listUserSkills(agent.skillsDir) }
})
```

preload：`listAgentSkills(agentId: string)` → `invoke('listAgentSkills', agentId)`。

禁止 `agentOf`。不要复用 `userLibraryAgent` / `sparkii:listUserSkills`。

`makeRuntime` 已支持 `agents?: Map`。测试必须往 `agents` 里塞带 `skillsDir` 的 runtime，不能只 mock `agentOf`。

**Tests：**

- 临时 dataDir：user-library 智能体 **库根** 下放 `brainstorming/SKILL.md`，`listAgentSkills(该 id)` 的 `name === 'brainstorming'`。
- 同一夹具：frontmatter `name: My Skill`（非法）、文件夹 `my-skill` → 返回 `name === 'my-skill'`，不是 `My Skill`。
- 合同审核 id：`skillsDir` = 该智能体的**库根**（包内 `agent/skills` 或等价夹具），其子目录含 `contract_risk_review` → 返回 `name === 'contract_risk_review'`，**不含**另一智能体用户库里的 `brainstorming`。禁止把 `skillsDir` 设成 skill 根本身（否则 `listUserSkills` 会列空）。
- 对包内库根直接调 `listUserSkills`：结果含下划线文件夹名。
- 未知 id：`{ skills: [] }`，**不** throw。
- preload 白名单含 `listAgentSkills`；`invoke` channel 为 `sparkii:listAgentSkills`。

跑：`pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/preload-api.test.ts`

- [ ] Step 1: 写失败测试
- [ ] Step 2: 跑红
- [ ] Step 3: 最小实现
- [ ] Step 4: 跑绿
- [ ] Step 5: Commit

```bash
git commit -m "feat(desktop): IPC listAgentSkills for composer menu"
```

---

### Task 4: ChatComposer `/` 菜单 + 前导 chip

**Files:** `packages/ui/src/patterns/ChatComposer.tsx`、`packages/ui/src/styles.css`、`apps/desktop/test/ui-chat-patterns.test.tsx`

Props：`skills?: Array<{ name: string; description: string }> | null`

空状态锁死见 spec 第 6 条。菜单 / chip 行为见 spec「Composer」。

实现要点：

- 仅当 `skills !== undefined && skills !== null` 且草稿匹配「行首或空白后的 `/` + **连续非空白**前缀、该 token 后无正文」时开菜单。
- 过滤用 name/description 包含。**不要**用 `parseLeadingSkillSlash` / destName 正则决定开不开菜单。
- 选中用 `/<name>` 替换当前 `/过滤词`，其后一个空格（**不是** `/skill:`）。
- 可抄 `Menu` 的定位 / `pointerdown` 外点关闭，但 markup 用 `listbox` / `option`。
- pill 用现有信息蓝浅底（DESIGN tokens），放在 textarea **上方**（attachments 与输入之间）。× 只用 `parseLeadingSkillSlash(...).rest` 写回草稿。
- `workbench/Composer.tsx` **不**加 prop；其测试保持无菜单。

`data-testid`：`composer-skill-menu`、`composer-skill-menu-item`、`composer-skill-chip`、`composer-skill-chip-remove`。

**Tests（直接 render `@sparkii/ui` 的 `ChatComposer`）：**

- 不传 `skills`：键入 `/` 无 `composer-skill-menu`。
- `skills={null}`：同上。
- `skills={[]}`：`/` 出现菜单，文案含「还没有安装技能」。
- 有 `brainstorming` + `using-superpowers`：`/` 两项；再键入 `bra` 只剩 brainstorming。
- 过滤无命中：可见「没有匹配的技能」，菜单不关。
- 高亮第一项时 Enter：draft 变成 `/brainstorming `，`onSend` 不触发。
- Esc：菜单关，draft 仍是 `/` 或过滤中文本。
- 点选鼠标：等同插入。
- `skills=[{name:'brainstorming',...}]` 且 draft=`/brainstorming 做对比`：chip 可见；点 × 后 draft 为 `做对比`。
- `/tmp` 且列表无 tmp：无 chip。
- 有 `contract_risk_review`：菜单有此项；选中 draft=`/contract_risk_review `；**无** chip。
- `/skill:brainstorming`：无 chip。
- `请 /bra`：开菜单；`请看/bra`：不开。
- `/contract_r` 且列表有 `contract_risk_review`：菜单仍开并能滤到该项；选中后若原稿是 `请 /contract_r`，draft 为 `请 /contract_risk_review `，**无** Composer chip。
- 无菜单时 Enter 仍发送（回归现有 `ui-chat-patterns` / `chat-composer`）。

跑：`pnpm exec vitest run apps/desktop/test/ui-chat-patterns.test.tsx apps/desktop/test/chat-composer.test.tsx`

- [ ] Step 1: 写失败测试
- [ ] Step 2: 跑红
- [ ] Step 3: 最小实现 + CSS
- [ ] Step 4: 跑绿
- [ ] Step 5: Commit

```bash
git commit -m "feat(ui): composer skill slash menu and leading chip"
```

---

### Task 5: 聊天表面接线 + 时间线 chip

**Files:** `apps/desktop/src/surface/standard-chat.tsx`、`apps/desktop/test/standard-chat.test.tsx`

- 有 Composer 的时候（已有 session 或 `draft`）按 `agent.id` 调 `api.listAgentSkills`。
- 初始 `skills` 必须是 `null`。`useEffect`：mount 拉一次；`window` 听 `focus` 再拉。`agent.id` 变则重拉。卸载取消 in-flight。
- **只有 fulfilled** 才写成数组（包括 `[]`）。失败或 `api.listAgentSkills` 缺失 → `reportError({ source: agent.name })`，保持 / 回到 `null`。禁止 `useState([])` 或用 `[]` 表示 loading。
- user 行：`parseLeadingSkillSlash(e.text)` 命中则「技能 · {name}」chip + `rest`；否则纯文本。不查 live 列表。
- 旧 `<skill name="brainstorming"` 全文：parse 为 null，纯文本。

**Tests：**

- 首 paint（`listAgentSkills` 用 pending Promise、尚未 settle）：键入 `/` 无菜单，也无「还没有安装技能」。
- mock `listAgentSkills` 返回 `[{ name: 'brainstorming', description: '…' }]`：Composer `/` 能看到该项（`waitFor`）。
- mock **省略** `listAgentSkills`：键入 `/` 无菜单（与 fulfilled `[]` 不同）。
- mock 成功 `[]`：settle **之后** `/` 见「还没有安装技能」。
- mock reject：无菜单（当 `null`）。
- `window.dispatchEvent(new Event('focus'))`：`listAgentSkills` 再被调用。
- 渲染 user ` /brainstorming\n做对比`：chip +「做对比」。
- 渲染 `请读一下`：无 skill chip。
- 渲染 `/skill:brainstorming`、`/contract_risk_review`、以 `<skill name="brainstorming"` 开头的长文：无 skill chip。
- 回归：现有 `promptSession` 发送用例仍绿。

跑：`pnpm exec vitest run apps/desktop/test/standard-chat.test.tsx`

- [ ] Step 1: 写失败测试
- [ ] Step 2: 跑红
- [ ] Step 3: 最小实现
- [ ] Step 4: 跑绿
- [ ] Step 5: Commit

```bash
git commit -m "feat(desktop): skill chips in composer and user timeline"
```

---

### Task 6: 通用 system.md + DESIGN.md

**Files:** `apps/desktop/agents/general/agent/prompts/system.md`、`apps/desktop/test/runtime-assemble.test.ts`、`DESIGN.md`

现行 system 句含「`/skill:技能名`」，**改掉**，换成 spec「system.md」那几条大意（location 父目录名、先 `read`、不搜工作区、不复述全文、不改写成 `/skill:`）。

`runtime-assemble.test.ts` 已有 `available_skills` / 「不要在工作区里搜索」：

- 保留这些。
- 通用 `system.md` **必须同时**出现「父目录」（或「location 的父目录」）和 `read`。
- 禁止把 catalog `<name>` 写成唯一对齐键（断言含「不要只」认 catalog name / 不要只拿 `<name>` 比，或等价禁止句）。
- `/skill:技能名` 不得当推荐打法。更干净是 general system **完全不出现** `/skill:`。
- 合同审核 `system.md` 不出现这套聊天点名句（location 父目录 / `/token` 点名）。

`DESIGN.md` Surfaces §2（对话式）补：「Composer 输入 `/` 列出当前智能体已装 skill；时间线将 destName 形 `/name` 画成技能 chip。说明书走 read 工具卡，不进用户气泡。」

跑：`pnpm exec vitest run apps/desktop/test/runtime-assemble.test.ts apps/desktop/test/saddle.test.ts`

- [ ] Step 1: 更新 assemble 断言（先红）
- [ ] Step 2: 改 system.md / DESIGN.md
- [ ] Step 3: 跑绿
- [ ] Step 4: Commit

```bash
git commit -m "docs(general): resolve /token via skill location folder name"
```

---

### Task 7: 文档回写

**Files:**

- `docs/superpowers/specs/2026-09-08-general-agent-skills-library-design.md` —— 若本 docs PR 已改过「Composer 不做选择器」，本任务只确认没有回潮。
- `docs/superpowers/specs/2026-09-08-chat-skill-invocation-design.md` —— 全部做完后 Status → **Implemented**。
- 本 plan 任务 checkbox 勾完。

- [ ] Step 1: 改 Status
- [ ] Step 2: Commit

```bash
git commit -m "docs: mark chat skill invocation implemented"
```

---

## 完成定义

- 聊天发送 `/brainstorming`，host 不再改写成 `/skill:brainstorming`。
- `/skill:clause_extract` 原样到达 Pi（host 不拦截）。
- 鞍仍把 `<available_skills>` 留给模型。
- Composer：`null` 无菜单；成功 `[]` 空态；有项可插入短指令（不是 `/skill:`）。
- 时间线对 destName 形 `/name` + 后文画 chip，不画 SKILL.md；下划线名 / `<skill>` 旧块不 chip。
- 合同审核 workflow 仍发 `/skill:contract_risk_review`。
- 用户库 skill 不出现在 `listAgentSkills(合同 id)` 与其会话鞍。
- `listAgentSkills` 的 `name` 是文件夹名（非法 frontmatter 也不改）。
- 无技能包、无 jsonl 双写、无按 id 分叉。

## 建议手验（实现后，非本 plan 强制）

1. 设置 → 技能导入 `brainstorming` skill 根，**新开**通用会话。
2. 输入 `/` 看见 brainstorming；选中后发送「/brainstorming」+ 一句需求。
3. 用户气泡是 chip，不是说明书；随后有 `read` 工具卡。
4. `/superpowers`（未作为叶子安装）菜单没有此项；发出去是短字。
5. 合同审核跑一单，步骤仍走原 skill，无 Composer 菜单。
