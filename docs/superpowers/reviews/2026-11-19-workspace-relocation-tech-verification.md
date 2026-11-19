# 技术验证报告 · 搬迁计划的 2 项待验证条件

- 日期：2026-11-19
- 目的：验证架构师评审遗留的 2 项条件（放行条件 3、5），用代码核对 + 本机实验得出结论
- 结论：**2 项全部验证完成，其中 MUST-FIX 3 的前提被推翻，需要修正计划；MUST-FIX 5 的原语已存在**

---

## 条件 3：Windows 句柄占用导致目录无法 rename/删除

### 评审的原始主张（MUST-FIX 3）

> setup 会话是 open 的，Pi 进程 cwd 在源目录，Windows 下该目录无法 rename；应「先复制、再 configure_session 切 cwd/释放句柄、最后删源」。

### 验证方法 1：本机实验（Windows，Node v22.22.2）

用 Node fork 一个长驻子进程把 cwd 设为目标目录，然后尝试 rename/rm：

```
A[released file handle]: RENAME OK
B[child cwd = src]: RENAME FAIL code=EBUSY
B[child cwd = src]: RM FAIL code=EBUSY
C[after child killed]: RENAME OK
```

**结论**：「进程 cwd 指向目录会锁住它」这个机制**是真的**（EBUSY）。但关键问题是：Pi 进程的 cwd 到底在不在工作区？

### 验证方法 2：代码核对 Pi 进程 cwd 的来源

| 检查点 | 代码 | cwd 指向 |
|---|---|---|
| Pi 子进程 fork | `pi-runtime/transports.ts:9-12,33-37` | **未设置 cwd**，继承 Electron 主进程 cwd（应用启动目录），与工作区无关 |
| 会话 saddle.cwd | `ipc.ts:631-634` buildSaddle → `anchorDir(sessionId)` | `dataDir/sessions/<id>`（app data 目录），**不是工作区** |
| workspaceRoot | `saddle.ts:18,36` 独立字段 | 才是工作区路径，仅用于工具路径边界 / 提示词 |
| configureSaddle | `pi-sdk-runtime.ts:542-546` | 只更新内存 pendingSaddle + 重装工具，**不调用 process.chdir** |
| 沙箱 helper | `windows-sandbox.ts:366 cwd: workspace` | 命令执行期短生命周期 helper，非长驻进程；setup 阶段无 LLM 工具调用，不会产生 |

### 结论

**评审 MUST-FIX 3 的前提不成立**：没有任何常驻进程把 cwd 设在工作区目录。setup 阶段工作区内文件是通过 P1 IPC（`readFile`/`writeFile`，句柄用完即释放）读写的，实验场景 A 证明这种情况 rename 完全正常。

**而且评审给的解法本身无效**：`configure_session` 不执行 chdir，无法"切 cwd 释放句柄"。

**修正建议**：
- 删除计划 5.1 步骤 9「configure_session 切 cwd 释放句柄」中"释放句柄"的说法；configure_session 仍需保留，但目的是**让 Pi 工具看到新的 workspaceRoot**（`buildSaddle` 读 record），不是释放 OS 句柄。
- 保留末位删源 + 删源失败保留双份的兜底（低成本、防未知占用，如用户自己开着资源管理器/杀毒软件扫描）。
- 句柄占用从"必须先解决的前提"降级为"删源失败时的兜底处理"。

---

## 条件 5：idle 原语与 B1 统一定义

### 评审的原始主张（MUST-FIX 5）

> relocate 主动 `taskLifecycle.end` 与 B1「仅当确属本轮 prompt 结束才 end / 保持槽位」冲突；应改为平台通用 idle 校验并与 B1 共用原语。

### 验证：现有原语盘点

| 原语 | 代码 | 能力 |
|---|---|---|
| `taskLifecycle.active(sessionId)` | `task-lifecycle.ts:35-37` | 判断是否**有活跃 Grant** —— 这就是现成的空闲判定 |
| `taskLifecycle.assertActive(sessionId, taskId?)` | `task-lifecycle.ts:39-45` | 断言活跃（工具执行前用，抛错而非布尔） |
| `taskLifecycle.end(sessionId, reason)` | `task-lifecycle.ts:65-73` | **幂等**：无 taskId 时 `revoke` 后直接 return，不报错 |
| `openSessions.get(sessionId)` | `ipc.ts` | 判断会话是否有常驻槽位在池里 |
| `session.streaming` / `chat-event` | `standard-chat.tsx`, `ipc.ts:726-739` | 判断是否流式中 |

### 结论

**不需要造新原语**。`taskLifecycle.active(sessionId)` 已经是"无活跃 Grant"的判定，配合 `openSessions` 和 streaming 状态即可构成"会话空闲"校验。

关于冲突本身：评审担心的是 relocate 主动 end 会误伤 B1 场景下的 Grant。但：
- setup 阶段**本就没有 Grant**（createSession 不发 prompt，不 startSessionTask）；
- `end()` 幂等，无 Grant 时调用无副作用；
- B1 的根因是**迟到的 `agent_settled` 在 ipc.ts:730-733 无条件 end**，与 relocate 是否主动 end 无因果关系。

**修正建议**：
- relocate 的空闲校验用 `taskLifecycle.active(sessionId) === undefined && !streaming`，复用现有原语，不新增。
- 是否主动 `end` 变得无关紧要（setup 无 Grant 且 end 幂等）；为清晰起见可保留一次 `end(sessionId, 'workspace-relocated')` 作为防御，但**真正的 B1 修复点在 ipc.ts:730-733 的 agent_settled 处理**（须加"本轮 prompt 归属"判断），这属于独立的前置 bug 修复，不依赖 relocate。
- B1 与 relocate 解耦：B1 修 agent_settled 误 end，relocate 用 active() 做空闲判定，二者不再需要"共用原语"——原语本就是同一个 `taskLifecycle`。

---

## 对计划放行条件的影响

| 放行条件 | 原状态 | 验证后状态 |
|---|---|---|
| 3. Windows 句柄方案落地且与 B1 协同验证 | ⚠️ 待验证 | ✅ 前提被推翻，前提不成立；降级为兜底处理，无阻塞 |
| 5. idle 原语与 B1 共用定义 | ⚠️ 待验证 | ✅ 原语已存在（`taskLifecycle.active`），无需新增；B1 独立修复 agent_settled，与 relocate 解耦 |

**两项均不再阻塞编码。** 计划可以放行——但注意这只是搬迁计划本身的放行；B1/B2/B3 前置 bug 修复仍是独立工作，且 B1 的修复点已精确锁定在 `ipc.ts:730-733`。
