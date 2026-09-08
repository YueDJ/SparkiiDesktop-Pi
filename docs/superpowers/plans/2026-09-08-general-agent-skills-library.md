# 通用智能体用户技能库 Implementation Plan

> **For agentic workers:** 本 plan 已经架构师审过（Approve with nits，nits 已吸收）。按任务逐步落地。Steps 用 checkbox (`- [ ]`) 跟踪。推荐 superpowers:executing-plans。

**Goal:** 通用智能体从用户数据目录加载可安装的 SKILL.md；设置页可导入文件夹、列出、卸载、打开目录；专用智能体仍只用包内 skill。鞍只带一个 `skillsDir`。只读工具放行当前鞍的 skill 根。

**Architecture:** `skillLibrary: user | package` 决定 `AgentRuntime.skillsDir`。用户库的列举/预览/导入/卸载是 Main 侧纯模块。设置页只打 IPC。`configure_session` 已有 `additionalSkillPaths`；本轮补对的是目录解析和 `read`/`ls`/`grep`/`find` 多根守卫。

**Tech Stack:** TypeScript、Vitest、React Testing Library、Electron dialog/shell、`@sparkii/config` 的 `loadSkillsFromDir`、`isPathInside`。

**Spec:** `docs/superpowers/specs/2026-09-08-general-agent-skills-library-design.md`

## Architect corrections

已吸收（无需产品再拍板）：

1. **唯一身份 `destName`：** IPC/UI/`uninstall` 的 `name` 就是安装目录名。列举按子目录，对每个 child 调 `loadSkillsFromDir(child)`，不用库根一次扫描的 frontmatter name。
2. **卸载不得删库根：** `name` 必须是合法 destName，且 `relative(skillsDir, dest) !== ''`。
3. **overlap 双向：** `resolve` 后相等，或源在目的地内，或目的地在源内。
4. **system.md 改工作区句：** 允许读已安装 skill 目录，即使工作区未创建。
5. IPC 表含 `previewUserSkill`；覆盖只走 import 的 `exists`；文案用 `displayName`；隔离锁走 `buildAgentSaddle` / `agent.skillsDir`，不新增 `buildProfileSaddle` 生产调用。
6. import **先校验再改盘**（含 source===dest 的 overlap，避免打开库后再导入把自己删掉）。preview 行的 `name === destName`。设置页补「无 user library」空态。
7. **包内子 destName 闭包失败：** 每个将安装的 skill 根在改盘前必须有唯一合法子 destName（frontmatter name，否则文件夹名）。冲突或无法生成 → preview/import 都 `bad-name`，不得 `ok: true` 后静默跳过。空的 `skills/` 且不是 Pi 包 → `not-skill-root`。

## Product forks

none。决策已在对话中收口。

## Global Constraints

- 平台生产代码（`apps/desktop/electron`、`packages/*`，测试除外）不把 `'general'` / `'contract-review'` 当作 skill 装配分支。
- 一条鞍只带一个 `skillsDir`。不引入 `skills-disabled/`、启用开关、zip、GitHub、自动改写。
- 导入目标必须是 skill 根（该目录下直接有 `SKILL.md`）。
- 不改合同审核 workflow、profile 签名文件集、Gate 状态机。
- 相关旧测试按新语义改，不放宽隔离断言。
- `apps/desktop/src/surface/**` 不 import `agents/**`。技能页放在 `src/shell/SettingsView.tsx`（或同目录小组件），不放进通用 Surface。

## Ownership

| 改动 | 放哪 | 不放哪 |
| --- | --- | --- |
| `skillLibrary` 字段、`resolveAgentSkillsDir` | `@sparkii/config` schema/types + `agent-registry` | 渲染层、Pi 内核 |
| 用户库预览/导入/卸载 | `apps/desktop/electron/main/skill-library.ts` | renderer、合同审核 profile loader |
| 只读多根守卫 | `packages/agent-host` `tool-registry.ts` | bash/edit/write |
| 设置页 | `SettingsView` + preload API | Composer、左栏 |
| 鞍上的目录 | 已有 `buildAgentSaddle` / `skillsDir` | 不要再造第二套注入 |

## File Structure

```text
packages/config/src/schema.ts
packages/config/src/types.ts
packages/config/src/agent.ts
packages/config/test/loader.test.ts          # 若需：未知 skillLibrary 失败

packages/agent-host/src/tool-registry.ts
packages/agent-host/src/types.ts             # 若 Registry 类型在此
packages/agent-host/src/pi-sdk-runtime.ts    # 把 saddle.skillsDir 传给工具注册表
packages/agent-host/test/tool-registry.test.ts

apps/desktop/electron/main/agent-registry.ts
apps/desktop/electron/main/runtime.ts
apps/desktop/electron/main/skill-library.ts  # 新
apps/desktop/electron/main/ipc.ts
apps/desktop/electron/preload/api-types.ts
apps/desktop/electron/preload/api.ts
apps/desktop/agents/general/manifest.yaml
apps/desktop/agents/general/agent/prompts/system.md
apps/desktop/src/shell/SettingsView.tsx
apps/desktop/src/shell/SettingsSkillsPane.tsx  # 可选，避免 SettingsView 再膨胀

apps/desktop/test/agent-registry.test.ts
apps/desktop/test/skill-library.test.ts       # 新
apps/desktop/test/saddle.test.ts              # 补 buildAgentSaddle + user library
apps/desktop/test/ipc.test.ts
apps/desktop/test/settings-view.test.tsx
apps/desktop/test/preload-api.test.ts

DESIGN.md
```

---

### Task 1: `skillLibrary` + `resolveAgentSkillsDir`

**Files:** `packages/config/src/types.ts`、`schema.ts`、`agent.ts`、对应测试；`apps/desktop/electron/main/agent-registry.ts`、`runtime.ts`、`test/agent-registry.test.ts`

`ProfileManifest` / `AgentManifest` 增加 `skillLibrary?: 'package' | 'user'`。zod：`z.enum(['package', 'user']).optional()`。

```ts
export function resolveAgentSkillsDir(input: {
  id: string;
  dir: string;
  dataDir: string;
  skillLibrary?: 'package' | 'user';
}): string
```

- `user` → `join(dataDir, 'agents', id, 'skills')`
- 其他 / 缺省 → `join(dir, 'agent', 'skills')`

`loadAgentRuntimes(inputs, { dataDir })`：每个 runtime 的 `skillsDir` 用上面函数。`assemble` 传入 `dataDir`，并把 profile `skillLibrary` 放进构造的 manifest。

**Tests：**

- `user` + id `general` + dataDir `C:/data` → `C:/data/agents/general/skills`（路径用 `join` 比）。
- 缺省 / `package` + dir `C:/agents/finance` → `C:/agents/finance/agent/skills`。
- `loadAgentRuntimes`：一份 `skillLibrary: 'user'`、一份缺省；断言两个 `skillsDir` 不同且 user 侧含 `dataDir/agents/<id>/skills`。
- 生产装配路径不出现 `if (id === 'general')`。

跑：`pnpm exec vitest run packages/config/test apps/desktop/test/agent-registry.test.ts`

- [ ] Step 1: 写失败测试
- [ ] Step 2: 跑红
- [ ] Step 3: 最小实现
- [ ] Step 4: 跑绿

---

### Task 2: 通用 manifest + system 提示

**Files:** `apps/desktop/agents/general/manifest.yaml`、`agent/prompts/system.md`、`test/saddle.test.ts`

manifest 增加 `skillLibrary: user`。system.md 追加 spec 中的一句。

`saddle.test.ts` 增加 `buildAgentSaddle` 用例：构造 `AgentRuntime`，`skillsDir` 已是 user 路径时鞍原样带上。合同审核隔离锁用 `agentOf` / `buildAgentSaddle` 的 `skillsDir`（包内 `agent/skills`），不要把 `buildProfileSaddle` 当生产契约。

system.md：**改**工作区相关句（见 spec），并追加 skill 那一句。

跑：`pnpm exec vitest run apps/desktop/test/saddle.test.ts apps/desktop/test/runtime-assemble.test.ts`

- [ ] Step 1–4: TDD；assemble 若读真实 general manifest，补一条 skillsDir 落在 dataDir 下的断言（`runtime-assemble.test.ts` 若已有 assemble 夹具）。
- [ ] 另锁：用户库里放入一个 SKILL.md 后，`loadProfile(合同审核包)` 的 `agent.skills` 名称集不变（隔离 #3）。

---

### Task 3: 只读工具多根守卫

**Files:** `packages/agent-host/src/tool-registry.ts`、`pi-sdk-runtime.ts`、`test/tool-registry.test.ts`

`RegistryContext.skillsDir?: string`。守卫：

1. 有 `params.path` 且绝对/相对解析后 `isPathInside(skillsDir, abs)` → 直接执行原工具（不要求 workspace 存在）。
2. 否则保持现有 workspace 逻辑。

`createPiSdkSessionHost` 里 `resolveToolDefinitions(..., { skillsDir: pendingSaddle?.skillsDir, ... })`。

**Tests：**

- workspace 未创建，`path` 为 `join(skillsDir, 'foo/SKILL.md')`（文件存在）→ 读到正文，不是 `WORKSPACE_NOT_CREATED`。
- workspace 已创建，读工作区内文件 → 仍成功（回归）。
- workspace 已创建，读「另一个智能体」的 skill 绝对路径 → 拒绝访问。
- workspace 未创建，读工作区路径 → 仍是 `WORKSPACE_NOT_CREATED`。
- 无 `skillsDir` 时行为与现在一致。

跑：`pnpm --filter @sparkii/agent-host test`

- [ ] Step 1–4: TDD

---

### Task 4: `skill-library` 纯模块

**Files:** `apps/desktop/electron/main/skill-library.ts`、`test/skill-library.test.ts`

导出（名称可微调，语义锁定）：

```ts
destNameFor(frontmatterName: string | undefined, sourceDir: string): string | { reason: 'bad-name' }
previewUserSkill(sourceDir: string): Promise<
  | { ok: true; skill: { name: string; description: string; hasScripts: boolean; warnings: string[] } }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'unavailable' | 'bad-name'; diagnostics?: string[] }
>
// 成功时 skill.name === destName
listUserSkills(skillsDir: string): Promise<Array<{ name: string; description: string; hasScripts: boolean; warnings: string[] }>>
importUserSkill(skillsDir: string, sourceDir: string, opts?: { overwrite?: boolean }): Promise<
  | { ok: true; name: string }
  | { ok: false; reason: 'not-skill-root' | 'invalid-skill' | 'exists' | 'overlap' | 'unavailable' | 'bad-name'; name?: string }
>
uninstallUserSkill(skillsDir: string, name: string): Promise<
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'bad-name' }
>
```

`hasScripts`：`join(childDir, 'scripts')` 是目录。
`listUserSkills`：目录不存在 → `[]`。对每个直接子目录 `loadSkillsFromDir(child)`；行上 `name` = 子目录名（destName）。
`destNameFor`：frontmatter name 合法则用；否则净化文件夹名；再不行 `bad-name`。

**Tests（tmp 目录）：**

- 合法 `SKILL.md` 预览成功；导入后 `list` 的 `name` 等于 destName；目的地有 `references/` 若源有。
- frontmatter `name: My Skill`（非法）但有 description：仍安装；`list`/`uninstall` 用净化后的 destName，不是 `My Skill`。
- 根上无 `SKILL.md`、子目录才有（且不是 `skills/` / Pi 包）→ `not-skill-root`，不写盘。
- Pi 包 / 约定 `skills/`：一个 destName；只拷 `package.json` + 各 skill 根；不拷 `.cloud` / `.git` / `.pi` / README。
- 无 description → `invalid-skill`。
- 再导同名无 overwrite → `exists`，原文件不变；`overwrite: true` 替换。
- `uninstall` 只删 `skillsDir/destName`；`../x`、`a/b`、`.`、`''` → `bad-name`，库根仍在。
- overlap：`sourceDir === skillsDir`；源在 dest 内；**dest 在源内**（把父目录当 source 导入）三者都失败且不写坏库。

跑：`pnpm exec vitest run apps/desktop/test/skill-library.test.ts`

- [ ] Step 1–4: TDD

---

### Task 5: IPC + preload

**Files:** `ipc.ts`、`preload/api-types.ts`、`preload/api.ts`、`test/ipc.test.ts`、`test/preload-api.test.ts`

解析 user-library 智能体：从 `rt.agents` 里 `manifest.skillLibrary === 'user'`，按 `sortOrder ?? 0` 升序取第一个。

- `listUserSkills`：`{ agent: { id, name: displayName ?? id } | null, skills }`
- `previewUserSkill(sourceDir)`
- `importUserSkill({ sourceDir, overwrite? })` 成功/失败后：成功则 `rt.audit.append({ actor: subject.userId, action: 'skill.installed', resource: name, payloadSummary: sourceDir })`
- `uninstallUserSkill({ name })` 成功则 `skill.uninstalled`
- `chooseSkillFolder`：`SPARKII_E2E_SKILL_DIR` 优先，否则 `showOpenDialog` 目录
- `openUserSkillsDir`：`mkdir` 后 `shell.openPath`（测试里 mock 或只断言返回 `path`）

无 user library → spec 的 `no-user-library`。

**Tests：**

- 在临时 dataDir assemble（或手工 stub runtime）：import 后 list 看得到；audit 有 `skill.installed`；uninstall 后 audit 有 `skill.uninstalled`。
- 合同审核 `agentOf('contract-review').skillsDir` 仍以包内 `agent/skills` 结尾（经 `buildAgentSaddle` / runtime，不靠 `buildProfileSaddle`）。
- preload 方法名出现在 `preload-api.test.ts` 白名单（含 `previewUserSkill`）。

跑：`pnpm exec vitest run apps/desktop/test/ipc.test.ts apps/desktop/test/preload-api.test.ts`

- [ ] Step 1–4: TDD

---

### Task 6: 设置页

**Files:** `SettingsView.tsx`、可选 `SettingsSkillsPane.tsx`、`test/settings-view.test.tsx`、`DESIGN.md`

`PANES` 增加 `skills`，标签「技能」。`SettingsApi` 增加 list/preview/import/uninstall/choose/open。

**Tests：**

- 点「技能」：提示含「仅用于」+ mock agent 的 displayName；空列表文案「还没有安装技能」。
- mock list 两条：能看到两个 name。
- 导入：choose 返回路径 → preview 成功 → 确认 → `importUserSkill` 被调用（无 overwrite）。
- 覆盖：`importUserSkill` 返回 `exists` → 二次确认 → 再调用且 `overwrite: true`。preview 不负责 exists。
- 卸载：确认后调用 `uninstallUserSkill({ name })`（name 为 destName）。
- 打开文件夹调用 `openUserSkillsDir`。
- `listUserSkills` 返回 `agent: null`：技能页显示「未配置用户技能库」，导入/卸载/打开不可用。

跑：`pnpm exec vitest run apps/desktop/test/settings-view.test.tsx apps/desktop/test/settings.test.tsx`

- [ ] Step 1–4: TDD
- [ ] `DESIGN.md` 设置分组补「技能」一句

---

## 完成定义

- 通用会话鞍的 `skillsDir` 在 `<dataDir>/agents/<id>/skills`。
- 合同审核鞍仍指向包内 `agent/skills`；用户库文件不进其 profile skills。
- 设置 → 技能可导入合法 skill 根、列出、卸载、打开目录。
- 非 skill 根 / 无 description 不能装进去。
- 工作区未创建时，通用智能体的 `read` 能读用户库里的 `SKILL.md`；读专用体包内路径被拒。
- 合同审核 `read` 能读自己包内 skill（若工具在鞍上），不能读用户库。
- 无 zip / 启用停用 / GitHub / 改写 / 按智能体 id 分叉。

## 建议自检

```text
pnpm exec vitest run packages/config/test packages/agent-host/test \
  apps/desktop/test/agent-registry.test.ts apps/desktop/test/skill-library.test.ts \
  apps/desktop/test/saddle.test.ts apps/desktop/test/ipc.test.ts \
  apps/desktop/test/preload-api.test.ts apps/desktop/test/settings-view.test.tsx \
  apps/desktop/test/settings.test.tsx apps/desktop/test/runtime-assemble.test.ts
```
