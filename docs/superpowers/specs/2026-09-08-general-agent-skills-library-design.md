# 通用智能体用户技能库 — Design Spec

**Status:** Approved with nits（nits 已吸收；可以改产品代码）
**Date:** 2026-09-08
**Plan:** `docs/superpowers/plans/2026-09-08-general-agent-skills-library.md`
**Depends on:**
- `docs/superpowers/specs/2026-08-24-multi-agent-runtime-native-skills-design.md`（鞍注入 `additionalSkillPaths`、Pi 按需 `read`）
- `docs/superpowers/specs/2026-08-25-general-agent-design.md`（通用智能体、`configure_session` 鞍）
- `docs/superpowers/specs/2026-09-01-agent-decoupling-and-contract-review-surface-design.md`（智能体同级、manifest 为入口）
- `@sparkii/config` 的 `loadSkillsFromDir`（与 Pi 对齐的 SKILL.md 发现）
**Amends:**
- 所有智能体的 `skillsDir` 一律 `join(agent.dir, 'agent', 'skills')` 的现状
- `read` / `ls` / `grep` / `find` 只允许工作区、工作区未创建时连 skill 正文也读不到的现状
- 设置页没有技能分组的现状

## Goal

让通用智能体能安装、列出、卸载外面的 Agent Skills（`SKILL.md` 目录），并在会话里只看见自己的那一份目录；专用智能体（合同审核、以后的财务）继续只用包内 `agent/skills`，两边不混。

运行时不新造「平面」子系统：智能体同级，隔离只靠鞍上的一个 `skillsDir`。

## Confirmed Decisions

1. **一个智能体一个 skill 目录，鞍只带这一个路径。** 创建 session runtime（`new_session`）时 `additionalSkillPaths` 只有 `saddle.skillsDir`（有则一项，无则空）。`configure_session` 不单独重绑 Pi 的 skill loader。禁止把多个智能体的目录拼进同一条鞍。
2. **目录落点由 manifest 声明，不按 `id === 'general'` 分叉。** 新增可选字段 `skillLibrary: 'package' | 'user'`（缺省 `'package'`）。
   - `package`：`join(agent.dir, 'agent', 'skills')`（合同审核现状）。
   - `user`：`join(dataDir, 'agents', <agentId>, 'skills')`。
   - 通用智能体 manifest 写 `skillLibrary: user`。财务等专用体不写，保持包内目录。
3. **用户库磁盘即事实源。** 在 `skills/` 里 = 已安装 = 会进鞍。不做启用/停用，不做 `skills-disabled/`，不做旁路索引。
4. **这一期只从文件夹导入。** 选中的目录必须自己就是 skill 根（该目录下直接有 `SKILL.md`）。拷贝整目录，不建快捷方式。不做 zip、不做 GitHub URL、不做自动改写、不扫 `~/.agents/skills` / `~/.claude/skills`。
5. **鉴定只问「能不能被现有 loader 加载」。** 复用 `loadSkillsFromDir`：没有可用 `description` 则拒绝安装。name 不规范只警告仍可装。不按 Claude / Pi 出身拦截，不改写 `SKILL.md`。
6. **设置 → 技能** 只管理 `skillLibrary: user` 的智能体。本轮恰好一个（通用智能体）。页上写清「这些技能仅用于{displayName}」。四个动作：列表、导入文件夹、卸载、打开文件夹。Composer 不做技能选择器。
7. **只读工具放行当前鞍的 `skillsDir`。** `read` / `ls` / `grep` / `find` 的允许根 = 工作区（若已创建）∪ 本会话 `skillsDir`。路径在 skill 目录内时，即使工作区尚未创建也允许读。`bash` / `edit` / `write` 不因 skill 免批；`scripts/` 走现有 bash 审批。
8. **已打开的会话不热更新技能列表。** Pi 的 `additionalSkillPaths` 在创建 session runtime 时绑定（`new_session`），不是 `configure_session` 单独重载。导入/卸载后须新开或重新打开会话（会 `new_session`）才看见变化。
9. **平台生产代码不写死 `'general'` / `'contract-review'`。** 用 `skillLibrary` 与 `agent.skillsDir` 分辨。设置页文案可以用通用智能体的 `displayName`。
10. **审计** 记 `skill.installed` / `skill.uninstalled`（`resource` = skill name，`payloadSummary` = 来源路径或卸载说明）。安装本身不走写审批弹窗。

## Current State

- `loadAgentRuntimes` 把每个智能体的 `skillsDir` 设为 `join(dir, 'agent', 'skills')`。通用智能体包内没有这个目录。
- `buildAgentSaddle` 已把 `agent.skillsDir` 放进鞍；`createPiSdkSessionHost` 已把它映射为 `additionalSkillPaths`。
- 合同审核包内已有 `agent/skills/**/SKILL.md`，workflow 用 `/skill:name` 强制激活。这条保持不动。
- `resolveToolDefinitions` 给 `read` / `ls` / `grep` / `find` 包了工作区守卫：工作区不存在直接返回「尚未创建」；路径不在工作区内拒绝。Pi 注入的 skill `location` 是绝对路径且在工作区外，通用（以及合同审核按需读正文）会被挡住。
- 设置页分组：大模型连接 / 数据与隐私 / 智能体与运行 / 审批与安全 / 外观与语言 / 审计。无技能页。
- Pi 对 SKILL.md 与 Claude/Codex 同标准、校验偏松；`pi install <git url>` 装的是 Pi package，不是安装器自动改写第三方 skill。本轮不复制那条对话式改造。

## Non-goals

- 启用/停用、zip、市场、ClawHub / skills.sh、GitHub 安装、自动把 Claude skill 改写成 Pi 方言。
- 自动扫描或挂载 `~/.pi`、`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`。
- 智能体自写 skill、Skill Workshop、per-skill API Key。
- 给专用智能体做技能页，或把用户库技能注入合同审核/财务会话。
- 改合同审核 workflow、签名完整性收集规则、审批门状态机。
- Composer / slash UI、热重载已打开会话的 `<available_skills>`。
- 完整危险代码扫描（只做 loader 校验 + 人确认）。

## Architecture

```text
Settings → 技能
   list / import folder / uninstall / open folder
        │
        ▼
Main  skill-library  （<dataDir>/agents/<id>/skills）
        │  拷贝 / 删除 / 按子目录 loadSkillsFromDir(child)
        ▼
AgentRuntime.skillsDir
        │
        ▼
buildAgentSaddle → new_session（绑定 additionalSkillPaths）
        │  additionalSkillPaths: [skillsDir]
        │  read/ls/grep/find 允许根: workspace ∪ skillsDir
        ▼
Pi session   仅本智能体这一份目录
```

专用智能体：`skillsDir` 仍是包内 `agent/skills`，设置页不管，鞍不带用户库路径。

## Manifest

`ProfileManifest` 与 `AgentManifest` 增加：

```ts
skillLibrary?: 'package' | 'user'  // 缺省 'package'
```

解析：未知值视为 schema 失败（zod enum）。`assemble` 把 profile 上的字段传进 `loadAgentRuntimes`。

```ts
resolveAgentSkillsDir({
  id, dir, dataDir, skillLibrary
}): string
// user    → join(dataDir, 'agents', id, 'skills')
// package → join(dir, 'agent', 'skills')
```

`apps/desktop/agents/general/manifest.yaml` 增加 `skillLibrary: user`。合同审核 manifest 不写该字段。

## User library layout

```text
<dataDir>/agents/general/skills/
  <skill-name>/
    SKILL.md
    references/   # 可选
    scripts/      # 可选
    assets/       # 可选
```

**磁盘目录名 = IPC/UI 的 `name` = `destName`。** 全程只用这一个身份，禁止用 frontmatter `name` 当卸载键。

`destName` 必须是单段、匹配 `^[a-z0-9-]+$`（1–64，无首尾/连续连字符），且不是 `''`、`.`、`..`。算法：

1. 若 frontmatter `name` 已合法 → 用它。
2. 否则把源文件夹名转小写，去掉非法字符、压缩连字符、去掉首尾连字符；结果合法则用它。
3. 否则 → `reason: 'bad-name'`，不安装。

frontmatter name 不合法但 description 有效时仍可安装（与 Pi / 现有 loader 一致），列表 `name` 仍是 `destName`，`warnings` 带上 loader 的 name 诊断。

**列举用户库：** 读 `skillsDir` 的直接子目录（跳过 `.` 前缀与 `node_modules`）。对每个子目录单独 `loadSkillsFromDir(child)`（skill 根）。`name` 用子目录名（即 `destName`），description / warnings 来自该次加载。不要对整个库根调一次 `loadSkillsFromDir` 再拿 `skill.name` 当卸载键（库根会把 frontmatter name 和根级 `.md` 混进来）。

目录不存在视为空库，列举为 `[]`，鞍仍可带上该路径（Pi 对不存在的 additionalSkillPaths 只记 warning，会话照常）。

## Install / uninstall

导入（`importUserSkill`）：

1. `sourceDir` 必须是已存在的目录。
2. `join(sourceDir, 'SKILL.md')` 必须是文件。子目录里有 `SKILL.md` 但根上没有 → 失败，`reason: 'not-skill-root'`（不递归收割仓库）。
3. 对 `sourceDir` 调 `loadSkillsFromDir`。0 个 skill（缺 description 等）→ `reason: 'invalid-skill'`，带 diagnostics。
4. 取该根上加载到的那一个 skill（skill 根不再向下扫兄弟项）。
5. 目的地 `dest = join(skillsDir, destName)`。**先做完全部校验再改盘**：`dest` 必须在 `skillsDir` 内且 `relative(skillsDir, dest) !== ''`；`resolve` 后源与 dest 相等、或 `isPathInside(source, dest)`、或 `isPathInside(dest, source)` → `overlap`；已存在且 `overwrite !== true` → `exists`（返回 `name: destName`）。
6. 校验通过后：若 overwrite 则先删 dest，再 `fs.cp`（recursive）拷贝 `sourceDir`。
7. 成功则审计 `skill.installed`（`resource` = `destName`）。

卸载（`uninstallUserSkill`）：

1. `name` 必须是合法 `destName`（charset 规则；拒绝 `''` / `.` / `..` / 分隔符）。
2. `dest = resolve(skillsDir, name)`。必须 `isPathInside(skillsDir, dest)` **且** `relative(skillsDir, dest) !== ''`。缺一则 `bad-name`，不得删库根。
3. 不存在 → `reason: 'not-found'`。
4. 成功则审计 `skill.uninstalled`（`resource` = `name`）。

打开文件夹：`mkdir` 技能根（若缺失）后 `shell.openPath`。E2E / 无窗口环境：IPC 仍返回 `{ ok: true, path }`，不强制弹资源管理器。

## Validation shown in UI

列表每行：

```ts
{
  name: string
  description: string
  hasScripts: boolean          // 该 skill 目录下存在 scripts/ 目录
  warnings: string[]           // loader diagnostics 的 message
}
```

导入预览（选中文件夹、确认前）用同形，且 **`name` 必须等于 `destName`**（不要展示非法 frontmatter name）。`hasScripts === true` 时页上固定一句：「其中的命令仍要审批。」不做正文工具名启发式扫描。

## Read / search guard

`RegistryContext` 增加 `skillsDir?: string`。`pi-sdk-runtime` 从鞍传入。

对 `read` / `ls` / `grep` / `find`：

1. 将 `params.path`（若是字符串）相对于 `pathCwd`（现有：`workspaceRoot ?? cwd`）解析成绝对路径。
2. 若在 `skillsDir` 内 → 放行（不要求工作区存在）。
3. 若声明了 `workspaceRoot` 且工作区目录不存在 → 返回现有 `WORKSPACE_NOT_CREATED`（仅当路径不在 skill 根内）。
4. 若声明了 `workspaceRoot` 且路径不在工作区内、也不在 skill 根内 → 现有「拒绝访问」。
5. 无 `path` 的调用（例如默认在 cwd 上的 grep）保持现状：仍受工作区守卫约束，不把整盘打开。

`isPathInside` 复用 `@sparkii/agent-host`。相对路径继续按工作区根解析；Pi 写入 `<available_skills>` 的 location 是绝对路径，走第 2 步。

## Settings IPC

| IPC | 行为 |
| --- | --- |
| `sparkii:listUserSkills` | 解析 `skillLibrary: user` 的智能体；按子目录列举其 `skillsDir` |
| `sparkii:previewUserSkill` | `{ sourceDir }` 只读校验，不写盘；成功返回列表行形 + `destName` |
| `sparkii:chooseSkillFolder` | `dialog.showOpenDialog({ properties: ['openDirectory'] })`；E2E 可用 `SPARKII_E2E_SKILL_DIR` |
| `sparkii:importUserSkill` | `{ sourceDir: string, overwrite?: boolean }` |
| `sparkii:uninstallUserSkill` | `{ name: string }`（必须是 `destName`） |
| `sparkii:openUserSkillsDir` | 打开（必要时先创建）该智能体的 `skillsDir` |

若没有 `skillLibrary: user` 的智能体：`listUserSkills` 返回 `{ agent: null, skills: [] }`，导入/卸载/打开返回 `{ ok: false, reason: 'no-user-library' }`。

若有多个：本轮取 `sortOrder` 升序后的第一个，页上显示其 `displayName`。不合并多个库。

Renderer `SparkiiApi` 增加对应方法。设置页只通过这些 IPC 改磁盘，不在渲染层写用户数据目录。

## Settings UI

新分组 `skills`，标签「技能」，插在「智能体与运行」之后。

- 提示：这些技能仅用于「{agent.displayName}」。装上的 skill 在新会话里生效。覆盖确认走 `importUserSkill` 返回的 `exists`，不走 preview。
- 空态：还没有安装技能。
- 列表：name、description；有 scripts 显示那句审批提示；warnings 用弱文案列出。
- 「导入文件夹」→ `chooseSkillFolder` → 预览（再 list 一次源，或 import 前 Main 返回 preview）→ 确认 → `importUserSkill`。已存在则二次确认覆盖。
- 每行「卸载」→ 确认 → `uninstallUserSkill`。
- 「打开技能文件夹」→ `openUserSkillsDir`。

不在应用内编辑 `SKILL.md`。失败用现有 `reportError`（source：系统设置）。

导入预览在 Main 完成（`previewUserSkill(sourceDir)` 可与 import 共用校验，不写盘）。设置页确认后再 `importUserSkill`。也可以 `importUserSkill` 一次完成校验+拷贝，exists 时不写盘；预览用 `previewUserSkill` 避免选错目录才发现。**采用独立 `previewUserSkill` IPC**（只读校验，形状与列表行 + `reason`）。

## Session / prompt

通用智能体 `agent/prompts/system.md`：

- 增加：若用户任务匹配已安装 skill 的说明，先用 read 读取该 skill 的 SKILL.md 再按其中步骤执行。
- **改**现有工作区句，避免和只读守卫打架：所有**工作区文件**的读写必须位于工作区根内；已安装 skill 目录可用 read/ls/grep/find 读取，即使工作区尚未创建。只读操作在工作区未创建且目标不在 skill 目录内时，仍提示「工作区尚未创建」。

Pi 在 `read` 可用且 skills 非空时仍会注入 `<available_skills>`。本轮不改 Pi 注入格式，不实现 slash UI。`loadProfile` 继续只扫包内 `agent/skills`，不指向用户库。

## Isolation invariants（测试必须锁）

1. 通用智能体鞍的 `skillsDir` 是 `join(dataDir, 'agents', 'general', 'skills')`，不是包内 `agents/general/agent/skills`。
2. 合同审核鞍的 `skillsDir` 仍是包内 `agent/skills`，路径不在 `dataDir/agents/general` 下。
3. 用户库里装一个 skill **不**出现在合同审核 `loadProfile` 的 `agent.skills` 里。
4. 合同审核会话的只读守卫：可以读自己包内 skill 路径；读 `dataDir/agents/general/skills/...` 必须拒绝。
5. 通用会话的只读守卫：可以读自己的用户库；读合同审核包内 skill 路径必须拒绝。
6. 平台源码（`apps/desktop/electron`、`packages/*`，测试除外）不出现字符串 `'general'` / `'contract-review'` 作为 skill 装配分支。
7. 生产路径只经 `buildAgentSaddle` 取 `agent.skillsDir`。`buildProfileSaddle` 仍硬编码包内 `agent/skills`，本轮不新增生产调用方，也不把它当合同审核隔离锁。

## Error reasons

`not-skill-root` | `invalid-skill` | `exists` | `overlap` | `not-found` | `no-user-library` | `bad-name` | `unavailable`

`unavailable`：源目录不可读等 IO。消息给用户看人话；`reason` 给 UI 分支。

## Testing

- 单元：`resolveAgentSkillsDir`、`preview`/`import`/`uninstall`、只读多根守卫、鞍路径。
- 组件：设置技能页空态、列表、导入确认、覆盖确认、卸载确认、无 user library。
- IPC：list / preview / import / uninstall / choose（E2E env）/ 合同审核 skillsDir 不变。
- 不强制 Playwright 弹系统文件夹对话框；E2E 若加，只用 `SPARKII_E2E_SKILL_DIR`。

## DESIGN.md

设置分组表增加「技能」：通用智能体的用户技能库；导入文件夹 / 卸载 / 打开目录。
