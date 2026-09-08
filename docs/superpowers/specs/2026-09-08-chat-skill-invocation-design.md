# 通用聊天技能调用 — Design Spec

**Status:** Approved（架构师第二轮 Approve；可以改产品代码）
**Date:** 2026-09-08
**Plan:** `docs/superpowers/plans/2026-09-08-chat-skill-invocation.md`
**Depends on:**
- `docs/superpowers/specs/2026-09-08-general-agent-skills-library-design.md`（用户库、`skillsDir`、只读多根守卫、`<available_skills>`）
- `docs/superpowers/specs/2026-08-24-multi-agent-runtime-native-skills-design.md`（鞍注入 `additionalSkillPaths`、Pi 按需 `read`）
- `docs/superpowers/specs/2026-08-26-session-storage-and-credentials-design.md`（Pi jsonl 是消息正文唯一权威）
- `docs/superpowers/specs/2026-09-04-session-title-source-of-truth-design.md` / current-session（时间线只读 jsonl）
**Amends:**
- 技能库 spec 第 6 条与 Non-goals：「Composer 不做技能选择器 / 本轮不实现 slash UI」——本轮对话式表面要实现 destName 形 slash 菜单（见下）
- 平台把聊天输入 `/name` 改写成 `/skill:name`、触发 Pi 展开、把 SKILL.md 全文写入 user 消息的现状

## Goal

通用智能体（以及以后所有**对话式**智能体）用 skill 时：

- 人在输入框用 `/` 看见当前鞍上有哪些 skill，选中后插入短指令，不插入说明书。
- 发出去的 user 消息在 Pi jsonl 里就是用户打的短指令（`/brainstorming` + 可选后文）。
- 模型靠鞍上留下的 `<available_skills>` 用 `read` 读 `SKILL.md`。
- 时间线把这条短指令投影成技能 chip，不把说明书画进用户气泡。

合同审核等**流程式**智能体继续由 workflow 发送 `/skill:name`，Pi 展开全文写入该步的 user 消息。这条路本轮不改。

## Confirmed Decisions

1. **调用分两式，由表面决定，不按智能体 id 分叉。**
   - **对话式（chat）：** 目录 + `read`。jsonl 的 user 行 = 用户原文。
   - **流程式（workflow）：** 平台拼 `/skill:<ref>`，Pi 把 SKILL.md 全文替换成该步 user 消息。合同审核维持现状。
   - 以后新智能体按表面选一种。禁止聊天偷偷改写成 `/skill:name`。禁止把 workflow 改成「模型自己挑 skill」。

2. **Pi jsonl 仍是聊天唯一账本。** 不另写 `skill.invoked` custom 行，不在 renderer / `sessions.db` 存第二份「用户其实想打 /brainstorming」。画面只投影 jsonl 里已有的文本和 tool 行。

3. **聊天路径禁止触发 Pi 的 `/skill:` 展开。** 平台不得把 `/brainstorming` 改成 `/skill:brainstorming` 再交给 `prompt` / `steer` / `followUp`。Pi 原生只展开以 `/skill:` 开头的输入；聊天不要去念这句咒语。删除 `expandLeadingSkillSlash`、`skillSlashAliases`、`loadSkillSlashAliases` 及其在 session 发送路径上的调用。

4. **鞍上的 skill 目录必须继续对模型可见。** 上一轮的 `mergeSaddleSystemPrompt`（`system.md` + `<available_skills>` + cwd）保留。这是对话式调用的前提：模型要知道 name / description / location。本轮不撤回。

5. **调用身份 = 安装子目录名（`listUserSkills` 行上的 `name`）。**
   - 菜单、插入的 `/token`、IPC 行的 `name` 都是这个子目录名。用户库导入后该名就是技能库 spec 的 `destName`；包内 skill 的文件夹可以是 `contract_risk_review`（下划线），**仍按文件夹名列出并插入**。
   - 禁止文件夹名 → frontmatter `name` 的别名（删掉现有 `skillSlashAliases`）。
   - Pi catalog 的 `<name>` 仍可能是不合法的 frontmatter；模型点名时按 **location 的父目录名**（及 description）对齐 `/token`，不要只认 catalog `<name>`。
   - obra/superpowers 按**叶子**子目录导入。没有根上 `SKILL.md` 的包名不出现在菜单里。
   - **chip 另加 destName 形过滤**（见第 9、10 条）。列举与插入**不要**用 `isDestName` 过滤（隔离测试要能列到包内下划线名）。

6. **Composer 做 slash 菜单，只给聊天 Composer。** 是否出菜单，看 props 是否「已成功拉过列表」。**没有第四个 loading 值：** 首次 IPC settle 之前只能传 `null` / 省略，禁止用 `[]` 表示「还在拉」。

   | `skills` | `/` 行为 |
   | --- | --- |
   | `undefined` / `null`（未接线、首次尚未 settle、或 `listAgentSkills` 失败 / API 缺失） | **不出菜单、不出 chip**，`/` 当普通字 |
   | **fulfilled** 且 `[]` | `/` **打开**空态「还没有安装技能」+ 文案「可到设置 → 技能安装」（设置页无深链，本轮只写字，不新开路由） |
   | **fulfilled** 且非空 | 正常列表；过滤无命中时菜单留着，文案「没有匹配的技能」 |

   选中后插入 `/<子目录名>`（可再跟空格和用户自己的话），**不插入 SKILL.md 正文**，**不插入 `/skill:` 形式**。合同审核表面不接这套菜单。

7. **菜单数据来自该智能体的 `skillsDir`，不写死智能体 id。** 新 IPC 按 `agentId` 用 `rt.agents.get(id)` 取 runtime；没有该 id → `{ skills: [] }`（不要 `agentOf`，它会扔）。列举 `agent.skillsDir`，算法与目录助手 `listUserSkills(skillsDir)` 相同。设置页仍只用已有的 `listUserSkills` IPC（先解析 `skillLibrary: user`）。不要和这条新 IPC 混用。

8. **导入后已打开会话的 `<available_skills>` 仍不热更新**（沿用技能库 spec 第 8 条）。菜单按磁盘现列：mount **和窗口 `focus`** 各拉一次。用户若在旧会话点了刚导入的 skill，模型可能没有 location；设置页已有「新会话生效」。本轮不为此做会话快照或热重绑。

9. **时间线投影只认 jsonl 文本，不查活库。** `parseLeadingSkillSlash` 见下方。chip 只给 **destName 形**的 `/token`（与 `isDestName` 同语义：`^[a-z0-9]+(?:-[a-z0-9]+)*$`，长度 1–64）。下划线名（`/contract_risk_review`）菜单可以列出并插入，但 **本轮不画 chip**，当普通字。不解析 `<skill name="...">`、不把全文折成 chip。历史里已展开的块按普通用户文本，不迁移。

   **附件本轮不管。** `promptSession` 若在正文前加 `📎` / 文件说明，时间线不会把这条当成 `/name` chip。不为此跳过前缀。

10. **Composer 里的「特殊颜色」= 菜单 + 可移除 chip，不是给 textarea 做语法高亮。** 原生 textarea 不能给中间一段着色。当草稿的前导 token 是 destName 形 **且** 落在当前 `skills` 列表的 `name` 上时，在输入区上方显示「技能 · \<name\>」pill，点 × 用 `parseLeadingSkillSlash` 的返回值去掉前导 `/name` 及紧随的 **一个** 空白字符（不要另写一套吞空白）。textarea 里仍是会发送的原文。`/tmp` 不在列表里则无 Composer chip（时间线仍可能 chip，见第 9 条）。下划线名即使在列表里也不出 Composer chip（parse 为 null）。句中插入的 `/name`（菜单允许）**不**出 Composer chip，也不当模型点名。

11. **平台生产代码不出现 `'general'` / `'contract-review'` 作为调用方式分支。** 用表面类型（是否挂聊天 Composer）和「发送路径是否改写 slash」区分。合同审核零改 workflow / 签名 / Gate。

12. **通用 `system.md` 与调用方式对齐。** 用户消息以 `/token` 开头时视为点名：在 `<available_skills>` 里找 **location 父目录名等于 token** 的那一项（description 可作辅助），`read` 该 location。不要只拿 catalog `<name>` 和 token 比（frontmatter 可能不是目录名）。不要在工作区搜 SKILL.md。不要把 SKILL.md 全文当作用户原话。不写「平台会改写成 `/skill:`」。删掉现行「`/skill:技能名`」引导。

## Current State

- 鞍把 `skillsDir` 映射为 `additionalSkillPaths`；只读守卫允许读 skill 根。
- `before_agent_start` 已用 `mergeSaddleSystemPrompt` 保留 `<available_skills>`。模型**能看见**目录。
- `createPiSdkSessionHost.adaptSession` 在 `prompt` / `steer` / `followUp` 上调用 `expandLeadingSkillSlash`：命中已装 name（或单 skill 目录名）则改成 `/skill:<name>`。Pi `_expandSkillCommand` 把 user 消息换成 `<skill name="..." location="...">` + 全文并写入 jsonl。
- 因此 `/brainstorming` 的用户气泡是整篇说明书；`/superpowers` 对不上叶子 name，jsonl 仍是短字。
- `ChatComposer` 是普通 textarea，无 `/` 菜单，无 chip。设置页 `listUserSkills` IPC 只找第一个 `skillLibrary: user` 的智能体，不按当前会话 `agentId` 列。
- `standard-chat` 时间线只读 `session.entries`（jsonl 投影）。user 行原样输出到 `ChatMessage`。
- 合同审核 `resolveWorkflowTemplates` 仍把步骤收成 `/skill:${ref}`，`LinearRunner.skillPrompt` 补 JSON。与聊天改写无关。
- `apps/desktop/src/workbench/Composer.tsx` 是 `ChatComposer` 的旧包装，生产聊天表面不用它；本轮不给它接线。

## Non-goals

- 技能包 / 父 skill / `/superpowers` 展开子列表。
- 已打开会话热更新 `<available_skills>`。
- 把历史 jsonl 里已展开的 `<skill>` 块回写成 `/name`。
- 聊天走 Pi `/skill:` 展开、再用渲染层折叠全文（展示与账本分叉）。
- 在发送路径上拦截人手打的 `/skill:name`（与 workflow 共用 `createPiSdkSessionHost`；禁止所有 `/skill:` 会误伤合同审核）。
- ContentEditable 输入框、斜杠菜单的中文别名、skill 市场。
- 改合同审核 workflow、profile 签名、Gate、审批。
- 给 workflow 表面做 slash 菜单。
- 改 Pi 内核。
- 为带附件的 user 行剥 `📎` 前缀再 chip。
- 设置页深链 / 新开「技能」路由。
- 把 `isDestName` 抽到新共享包（UI 侧复制同一条正则即可）。

## Architecture

```text
设置 → 技能（已有，user library）
        │
        ▼
agent.skillsDir  ──┐
                   │  listAgentSkills(agentId)   // 磁盘现列
                   ▼
ChatComposer  / 菜单 + 前导 chip
        │  onSend("/brainstorming\n我想做…")
        ▼
prompt / steer / followUp   **不再**改写成 /skill:
        ▼
Pi jsonl user 行 = 原文
        │
        ├─ 模型看见 <available_skills>（鞍保留的 catalog，会话创建时绑定）
        └─ 模型 read(location) → jsonl tool 行
        ▼
时间线   投影：destName 形 /name → 技能 chip；read → 已有 ToolCard
```

流程式（合同审核）不进左列，仍：

```text
workflow step.ref → /skill:name + JSON → Pi 展开 → 该步 user 行 = 全文
```

## Invocation rules

### 对话式（本轮要实现）

| 用户输入 | 写入 jsonl 的 user 行 | 模型侧 |
| --- | --- | --- |
| `/brainstorming` | `/brainstorming` | 用 location 父目录名对齐后 `read` |
| `/brainstorming` + 后文 | 原文（含后文） | 同上，后文当任务 |
| `/superpowers`（无此叶子） | `/superpowers` | 不当成 skill 点名；可当普通字。菜单里没有这一项 |
| `/contract_risk_review`（若该鞍列得出） | 原文 | 按 location 父目录名对齐；UI **不** chip |
| `/skill:brainstorming`（人手打） | 原文。若以 `/skill:` 开头，**仍原样发送** | Pi 会展开——本轮不拦截、不改写、不鼓励。菜单不插入这种形式 |
| 普通句子且任务像某 skill | 原文 | 可按 description 自己 `read`（system.md） |

人手误打 `/skill:name` 仍会触发 Pi 展开。本轮不在发送路径上禁止。菜单和文案不引导这种打法。聊天 host 与 workflow host 是同一 `createPiSdkSessionHost`；只去掉「把 `/name` 改成 `/skill:name`」，不要禁止所有 `/skill:`。

### 流程式（不改）

`/skill:${step.ref}` + JSON → Pi 展开 → jsonl 该步为全文。

## IPC

| IPC | 行为 |
| --- | --- |
| `sparkii:listAgentSkills` | `(agentId: string)` → `{ skills: Array<{ name, description, hasScripts, warnings }> }`。`name` = 子目录名（`listUserSkills` 的 `name`）。目录不存在或智能体不存在 → `{ skills: [] }`。列举算法与 `listUserSkills(skillsDir)` 相同：直接子目录、跳过 `.` 与 `node_modules`、对每个 child `loadSkillsFromDir`。frontmatter `name` 非法时，返回值仍是**文件夹名**。 |

实现：

```ts
const agent = rt.agents.get(agentId)
if (!agent) return { skills: [] }
return { skills: await listUserSkills(agent.skillsDir) }
```

不取代设置页的 `listUserSkills` IPC。Composer / 时间线不写盘。

Renderer：`SparkiiApi.listAgentSkills(agentId)`。`StandardChatSurface` 在 **mount** 和窗口 **`focus`** 时各拉一次。初始 state 与首次 settle 之前只能是 `skills={null}`（或省略）。**只有 fulfilled** 才写成数组（包括 `[]`）。`rejected` / 方法缺失保持 `null`，并用现有 `reportError`（`source: agent.name`，与本表面其它报错一致；`AgentDescriptor` 没有 `displayName`）。禁止用 `[]` 表示 loading。成功覆盖上次结果。不在 `apps/desktop/src/surface/**` import `agents/**`。

草稿会话（`sessionId == null` 但已挂 Composer）仍按 `agent.id` 拉列表，菜单在首条发送前可用。

## Composer

`ChatComposer` 增加可选 `skills?: Array<{ name: string; description: string }> | null`。

- 省略或 `null` = 未接线 / 首次未 settle / 失败 → 无菜单、无 chip（合同审核若误挂、workbench 旧包装不传，都保持今天）。
- **fulfilled** `[]` = 已成功、库空 → 空态菜单（第 6 条）。不要把失败或 loading 收成 `[]`。

菜单（与 chip parse **不是**同一套规则）：

- 打开：光标前是行首或空白，用户键入 `/`，或 `/` 后继续键入一段**连续非空白**前缀，且该 slash token 后面还没有正文。
- **不要**用 `parseLeadingSkillSlash` / destName 正则决定开不开菜单（否则 `/contract_r` 会关菜单）。
- 过滤：`name`、`description` 大小写不敏感**包含**（下划线名也能滤）。
- 空结果：菜单显示「没有匹配的技能」，不自动关闭，避免抢 `/`。
- 选中：用 `/<name>` **替换**当前这段 `/过滤词`，其后留一个空格。句中 `请 /contract_r` 选中 `contract_risk_review` 后变成 `请 /contract_risk_review `。
- 键盘：↑↓ 高亮，Enter / Tab 选中，Esc 关闭。菜单打开时 Enter 不发送。
- 鼠标点选等同 Enter。
- 点击菜单外关闭。
- 无障碍：`role="listbox"` / `option`；空态可用 `role="status"`。不要直接复用 `Menu` 的 `role="menu"`（可抄它的定位和外点关闭）。

前导 chip：

- **只**看整段草稿 `trimStart` 后的前导 destName token（`parseLeadingSkillSlash`），与菜单是否打开无关。
- parse 得到 name，且当前 `skills` 数组含该 name → 显示 pill「技能 · {name}」，× 用同一函数的 `rest` 替换整段草稿（即去掉 `/name` + 一个空白字符）。
- 不在 textarea 内着色。

`data-testid`：`composer-skill-menu`、`composer-skill-menu-item`、`composer-skill-chip`、`composer-skill-chip-remove`。

## Timeline

纯函数，放 `packages/ui/src/patterns/skill-slash.ts`（与 `pi-timeline` 同层）：

```ts
parseLeadingSkillSlash(text: string): { name: string; rest: string } | null
```

锁死规则：

1. 先 `trimStart`（保留行尾，不 `trimEnd` 整段）。
2. 必须以 `/` + destName 形开头：`name` 匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，长度 1–64。
3. `/` 与 name 之后必须是结束或空白；否则 `null`（因此 `/skill:foo`、`/MySkill`、`/contract_risk_review` 都是 `null`）。
4. 若 name 后有空白，只消费 **一个** 空白字符（`/^\s/`：空格 / Tab / 换行），禁止 `/^\s+/`。`rest` = 其后全部。若直接结束，`rest = ''`。
   - `/brainstorming\n\n第二段` → `{ name: "brainstorming", rest: "\n第二段" }`
   - `/brainstorming   x` → `{ name: "brainstorming", rest: "  x" }`
5. 中间夹普通字（`请看 /brainstorming`）→ `null`。Composer × 与时间线 rest **只**用该返回值，不要另写一套吞空白。

`StandardChatSurface` 画 user 行：若 parse 命中，chip + rest；否则维持现在的纯文本。不查 IPC。不解析 `<skill>` XML。`ChatMessage` 已支持 `children`，投影可以在表面做，不必改消息组件的协议。

`read` 工具卡沿用现有 `ToolCard` / 详细程度。默认不必自动展开 SKILL.md 正文。

## system.md（通用智能体）

**改**现有工作区 / skill 句（现行文本含「`/skill:技能名`」，必须拿掉），大意：

- 用户消息以 `/token` 开头：在 `<available_skills>` 里用 **location 的父目录名**（以及 description）对齐 token；不要只信 catalog `<name>`。
- 对齐后 `read` 该 location，再按 SKILL.md 做；用户后文是任务，不是说明书。
- 没打 `/token` 但任务匹配某 skill 的 description 时，同样先 `read`。
- 不要在工作区搜 skills / SKILL.md。
- 不要把 SKILL.md 全文当作用户原话复述进气泡。
- 不要改写或要求用户改写成 `/skill:name`。

不写「平台会展开」。合同审核 `system.md` 不改。

## Isolation

1. 一条鞍仍只有一个 `skillsDir`。菜单只列该智能体的目录。
2. 通用用户库 skill 不进合同审核会话、不进其菜单（它没有这套 Composer）。`listAgentSkills(合同 id)` 不得含用户库刚装的名字。对包内 `agent/skills` 调 `listUserSkills`，结果必须含下划线文件夹名（如 `contract_risk_review`）；菜单可插入该名；`parseLeadingSkillSlash('/contract_risk_review')` 仍为 `null`。
3. 合同审核 workflow 的 `/skill:` 发送与展开本轮零改。
4. 平台源码不以智能体 id 选择「read 还是展开」。
5. 生产发送路径只经 `createPiSdkSessionHost` 的 prompt/steer/followUp；workflow 仍走已有 `/skill:` 拼装。

## Error / empty

- 首次 settle 前 / 失败 / API 缺失：`skills={null}`，菜单不出现，输入仍当普通字。失败时 `reportError`（`source: agent.name`）。
- 无 skill（IPC **fulfilled** `[]`）：`/` 打开菜单，空态「还没有安装技能」，提示去设置 → 技能。
- 未知 `agentId`：IPC 返回 `{ skills: [] }`（成功空），不是抛错。
- 模型 `read` 失败：走现有 tool 错误展示；不回退成平台代展开。

## Accepted residual risks

- 人手打 `/skill:name` 仍会走 Pi 展开（与 workflow 共用 host）。
- 菜单 = 磁盘现列；catalog = 会话创建时绑定；时间线 chip = destName 形 jsonl 文本。三者可以暂时不一致。
- `listUserSkills` 可以列出 description 为空的子目录；菜单仍显示该项。
- 模型可能不 `read`；平台不代为展开。
- 带附件的 user 行若有 `📎` 前缀，本轮不 chip。

## Testing

- 单元：`parseLeadingSkillSlash`（含 `/skill:foo` → null、65 字符 name、`/MySkill`、下划线名、前导空白、`/brainstorming\n\n第二段` → rest `\n第二段`、`/brainstorming   x` → rest `  x`）。
- host：`expandLeadingSkillSlash` / aliases **不再存在**；`pi-sdk-runtime.ts` 不得出现 `withSkillSlash`、不得做 `/skill:` 拼接；`prompt` / `steer` / `followUp` 的形参 `text` 原样进入 `startPromptWithoutBlocking(session, text, …)` / `session.steer(text, …)` / `session.followUp(text, …)`（源码形状断言）。`mergeSaddleSystemPrompt` 回归保留。
- Composer：省略/`null` 无菜单；fulfilled `[]` 空态；首 paint（尚未 settle）`/` 无菜单且无「还没有安装技能」；`请 /bra` 开菜单、`请看/bra` 不开、`/contract_r` 能滤到下划线名；Enter 插入且不发送；Esc；chip；× 用 parse 的 rest；下划线名可插入但不 chip；无菜单时 Enter 仍发送。
- 时间线：`/brainstorming\n后文` 出 chip + 后文；`/skill:…`、下划线名、`<skill …>` 旧块当普通文本。
- IPC：`listAgentSkills` 列该 id 的**库根** `skillsDir` 的直接子目录；未知 id 空数组；不 throw；非法 frontmatter 时 `name` 仍是文件夹名；与合同审核包内目录隔离。对包内库根 `listUserSkills` 含下划线文件夹名。
- assemble：通用 system.md **同时**出现「父目录」（或等价）和 `read`；禁止把 catalog `<name>` 写成唯一对齐键；`/skill:技能名` 不得当推荐打法。合同审核 system.md 不出现这套聊天点名句。
- 合同审核：`resolveWorkflowTemplates` / workflow 测试保持 `/skill:contract_risk_review`。

## DESIGN.md

对话式表面的 Composer：输入 `/` 列出当前智能体已装 skill；时间线将 destName 形 `/name` 画成技能 chip。说明书走 `read` 工具卡，不进用户气泡。
