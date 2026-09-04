# Runtime ⊥ Viewport — Design Spec

**Status:** Approved（架构师 Approve with nits；可以改产品代码）
**Date:** 2026-09-04
**Depends on:** 当前会话真相（`2026-09-04-current-session-source-of-truth-design.md`）；会话标题公布（`2026-09-04-session-title-source-of-truth-design.md`）；运行池 / 薄契约
**Amends:** current-session spec 的「绑定 id」规则（今天写的是「current 仍是该 Agent 的会话就回写」）；title spec 的「有 sessionId 后公布」时机（今天写的是 viewport 上已有 id）
**Does not replace:** 那两份 spec 的主体（一份 `current`、高亮派生、Pi 标题、Agent 起名、`session_title` upsert）。本文件只补它们没切开的那条缝：运行时和视口被绑在一起。

## Goal

把「进程在不在跑」和「右边在看谁」收成两条互相垂直的轴。点「开始审核」或发出第一条聊天，是给运行时下命令，不是给 `current` 分配身份。`current` 只回答右边此刻显示什么。侧栏出现只走已经存在的 `session_title` upsert。

合同审核点「开始审核」没反应、运行池也看不到进程，是这条缝的症状，不是合同 Surface 自己的产品 bug。通用智能体走同一套骨架；以后加 Agent 只加 manifest + Surface + 点火命令 + 标题策略，不再加第三份 current map，也不按 agent id 分叉。

## Two Axes

| 轴 | 谁拥有 | 真相写在哪 | 不拥有 |
| --- | --- | --- | --- |
| Runtime | 运行池、saddle、LinearRunner / `promptSession`、Pi JSONL、`sessions.db` 里的 inputs / workspace | Pi JSONL（时间线）；会话记录（inputs、workspace、owner） | 右边看谁、亮哪一行 |
| Viewport | `current` + 目录 | `current`（右边是什么）；目录（已落盘、已有名字的行） | 起不停跑、释不释放、JSONL 写不写 |

规则：

1. **改 `current` 不得开始、停止或释放一次运行。** 点历史、点智能体、去首页 / 设置，只换右边。后台那条会话继续跑。
2. **点火是对运行时的命令。** `sessionId` 出生在 Pi / `runWorkflow` / `promptSession`，不出生在 `current`。
3. **视口跟随是可选的、事后的。** 命令返回 id 之后，仅当右边仍停在**该 Agent 的草稿**（`type === 'session'` 且 `agentId` 对得上且 `sessionId == null`）时，才把这个 id 写进 `current`。用户已经点开另一条历史、另一个 Agent、或任何壳页面，就不要抢焦点。
4. **离开视口不等于结束运行。** 活着的 `chat-event` 可能暂时没人听。回来时重新读该会话的 JSONL（`openChatSession`），事件流只是尾巴，不是第二份真相。
5. **侧栏出现仍只走 `session_title` upsert。** 归属先看运行时已经盖上的 owner（`bindCurrentSession` 里的 stamp / `profileId`），再回退到「`current` 正好挂着这个 id」。不要求合同 Surface 此时仍挂着这个 `sessionId`。

```text
用户点「开始审核」/ 发出首条消息
        │
        ▼
   运行时命令（runWorkflow / promptSession）
        │  sessionId 在这里出生
        ├──────────────┬─────────────────────────┐
        ▼              ▼                         ▼
   盖 owner        视口：仅草稿才 bind         Agent 用返回的 id 公布标题
   （stamp）       否则 current 不动            session_title → 侧栏 upsert
        │
        ▼
   跑循环 / 写 JSONL / 占运行池
   （不读 current，不等 openChatSession）
```

聊天和 workflow 同一协议：聊天命令是 `promptSession`，workflow 命令是 `runWorkflow`。Surface 从命令的返回值拿到 `sessionId`，再决定要不要 `openSession` / 让壳 bind。平台不写 `if (agentId === 'contract-review')`。

## Confirmed Decisions

1. **`current` 只是视口。** 形状、高亮公式、点历史 / 点智能体 / 打开壳页面，仍按 current-session spec。本 spec 不改 `CurrentWork`，不把运行中的会话再存进第二份 map。
2. **草稿才跟随。** `bindCurrentSession(agentId, sessionId)`：永远先 stamp owner；然后仅当 `current` 是该 Agent 且 `sessionId == null` 时才 `bindSession`。已经在看该 Agent 的另一条历史、或右边不是这个 Agent，current 不动。
3. **今天会抢焦点，应该不抢。** 今日实现：`current` 仍是该 Agent 的任意会话（包括历史）就会把 `sessionId` 改成新跑起来的那条。用户点完开始、立刻点开旧合同，会被新跑的 id 拽走。应改为：历史继续停在用户点的那条；新跑的那条靠标题 upsert 进目录，不亮（除非用户再点它，或当时仍停在草稿上）。
4. **`sessionId` 的变化不是同一种导航。不要用 `(prev, next)` 两个指针单独把 `null→id` 叫 bind。**

   | 变化 | 名字 | 怎么认 | Surface 本地草稿 |
   | --- | --- | --- | --- |
   | 草稿跟随命令返回的 id | bind | workflow：`null→id` 且 **`mode === 'live'`**（壳刚 `bindSession`） | **保留**本地文件 / 文件名 |
   | 草稿点开一条已有会话 | open | workflow：`null→id` 且 **`mode === 'history'`**（点了目录） | 清掉草稿，按 B 的 inputs 重装 |
   | `id → null` | leave | 新会话、去首页、切走 | 清掉这条会话的本地态 |
   | `id A → id B` | switch | 换到另一条已有会话 | 按 B 的 inputs 重装 |

   同一 Agent 仍是 `current` 时，`AgentFrame` **不卸** Surface，只改 `sessionId`。用户停在合同草稿再点该 Agent 一条历史，Surface 看到的就是 `null → 历史id` + `mode: 'history'`。若把凡 `null→id` 都当 bind，草稿文件会糊在历史会话上。「开始后立刻点历史」和「没开始、从草稿点历史」是同一条挂载路径，必须能分开。

   `mode` 对 workflow 够用：打开目录里的工作流是 `'history'`，点火跟随是 `'live'`。不要用「和 `bindCurrentSession` 同一条 Promise 里再记 `startedId`」——App 的 `then` 先 `setState`，Surface 的 `then` 还没写入 ref，effect 会把真 bind 误判成 open。

   聊天的历史也是 `'live'`，但聊天没有「本地已选合同文件」这坨态；聊天草稿只靠 `draft={sessionId==null}`。不要把合同的 `mode` 启发式抄进通用 Surface。

   合同 Surface 今天把「`sessionId` 变了」一律当导航：一 bind 就清 `localFileName` / 用当时还是空的 `inputs` 盖掉已选文件。这是视口和草稿耦死的具体位置。
5. **渲染真相是 JSONL（外加会话记录上的 inputs）。** `useAgentSession` 在有 id 时 `openChatSession`，再订阅 `chat-event` 当尾巴。`sessionId == null` 时不订阅，这是对的。漏掉的事件靠重读文件补，不靠「先 subscribe 再允许 loop 跑」。
6. **`openChatSession` 在 JSONL 尚未落盘（ENOENT）时仍要带回 `inputs`。** 今日 `ipc.ts` 这条路径返回 `{ messages: [] }`，丢掉会话记录里的 inputs。回来看一条刚启动、文件还没写出来的会话时，Surface 会以为没有文档。
7. **点火失败走现有错误中心，不另开通道。** 今日 `startWorkflow` 是 `.catch(() => {})`。通用聊天的 `promptSession` 已经 `useErrors().reportError(message, { source: agent.name })`：右上 toast + 报错中心抽屉 + `errors.db`（`2026-08-30-error-toast-center-persistence`）。workflow 点火失败接同一条口。`source` 用该 Agent 的显示名（列表里的 `name`），不要写死 agent id，也不要在 `App` 里直接 `appendError`（会跳过 toast；合同导出今天有这个旁路，点火不要学）。空 catch 不是「保持冷静」，是「点了没反应」。
8. **标题公布发生在点火回调闭包里，不发生在「我还挂着且 props 已有 id」的 effect 里。**

   去首页或点另一个 Agent 时，该帧 `active === false`，`{active && <Surface>}` **卸掉** Surface（`App.tsx` `AgentFrame`）。只改 `useEffect([sessionId])` 或「不要把 props.sessionId 改成新 id」的单测，测的仍是挂着的组件，卸挂后 `setState` / effect 都不会跑，侧栏洞还在。

   合同：点「开始审核」的 `onClick` 里 `await` / `.then` `startWorkflow`，拿到 `sessionId` 立刻 `setChatTitle(id, contractSessionTitle(selectedName), 'agent')`。打的是平台 API，不依赖还挂载，不依赖 `props.sessionId` / `props.title` / `titledSessions`。`titledSessions` 和现有 effect 只防**同一挂载周期**里 viewport 补发双写。

   通用：占位名同样在命令返回处公布。`promptSession` 已返回 `{ sessionId }`；`standard-chat` 在 `then` 里已经 `openSession`。给 `StandardChatSurface` 一个可选 `onSessionCreated?(sessionId, userText)`，由 `agents/general` 做成 `setChatTitle(id, placeholderOf(userText), 'agent')`。不要把占位策略写进 `App.tsx` 或 `standard-chat` 正文。短名（第二步）仍看 entries，仅 Surface 还挂着时升级；离开后占位名可以留在侧栏，本轮不在后台补短名。

   upsert 归属靠 stamp / `profileId`。不要求任一 Agent 的 Surface 此时仍是 `current`。
9. **owner 在运行时侧盖，不在「Surface 还开着」上盖。** `bindCurrentSession` 里 stamp 已经先于是否 bind。保留这条。`session_title` 插入时的归属顺序不变：覆盖值上的 `agentId`，否则 `current` 正好挂着这个 id。
10. **平台生产代码不按 agent id 分叉。** 不恢复 `workflowByAgent` / `activeSessionByAgent` / `titleByAgent`。不把「合同要等打开、聊天不用等」写成两条壳逻辑。能力差只体现在：聊天命令是 `promptSession`，workflow 命令是 `runWorkflow`；`mode` 仍只看 `surfaceType`。
11. **明确拒绝的做法**（讨论里已经否决，实现时不得再拣回来）：

    | 拒绝 | 为什么 |
    | --- | --- |
    | 恢复 `workflowByAgent` 或任何 per-agent current map | 刚删掉的第三真相；和新 Agent 的代价 |
    | `runWorkflow` 等 `openChatSession` / 视口 subscribe 之后再跑 loop | 运行时反过来等视口，耦合比现在更重 |
    | 握手：allocate → bind → subscribe → 再 start | 同上；`sessionId` 被当成视口分配出来的门票 |
    | 视口本地 `setBusy` 当「在跑」的真相 | 离开再回来就丢；运行池和 JSONL 才是 |
    | 为合同单开一份 start spec / 第三条 current | 聊天和以后的 Agent 会再踩同一条缝 |
    | 平台按文件名给合同起名 | 标题 spec：起名在 Agent |
    | `runWorkflow` 读取 `current` 决定跑不跑 | 运行时不看视口 |

## Current State (why start looks like a no-op)

点「开始审核」今天走：

1. Contract Surface → `actions.startWorkflow({ documents, workspacePath, model, thinkingLevel })`
2. `App.startWorkflow` → `api.runWorkflow(...).then(bindCurrentSession).catch(() => {})`
3. 主进程 `runWorkflow`：建 saddle → `pool.acquire` → `configure_session` → `new_session` / `get_state` → 落盘 → `onReady` 开始推事件 → **立刻** `void runWorkflowLoop` → **然后**才把 `sessionId` 返回给渲染进程
4. `bindCurrentSession`：stamp；若 `current` 仍是该 Agent 的会话（**不论是不是草稿**）就 `bindSession`
5. `useAgentSession`：`sessionId == null` 时不订阅；id 一变先 `setSession(EMPTY)` 再 `openChatSession`
6. 合同 `[sessionId]` effect 把任何 id 变化当导航，清掉本地文件
7. 界面状态只从 JSONL 时间线派生；时间线还是空就仍显示「开始审核」
8. `openChatSession` ENOENT 返回 `{ messages: [] }`，没有 inputs

叠在一起的结果：

- 命令其实可能已经跑了，但视口还停在 idle，按钮看起来没反应。
- 第一步若很快失败并 `release`，运行池也是空的，用户两边都看不见。
- 空 catch 把失败吞掉。
- 即使用户没离开，bind 也会清草稿；事件又发生在 subscribe 之前。测试只在 bind **之后** 才打 `chat-event`，所以 CI 是绿的。

`runWorkflow` 本身不读 `current`，池和 saddle 的用法也符合运行池设计。耦在渲染进程的 bind / subscribe / Surface 把 id 变化当导航、以及标题 effect 必须看到 viewport id。

## Relation to Existing Specs

### current-session（不重写）

仍然成立：全应用一份 `current`；高亮是派生值；新会话没名字不进目录；`openSession` / `startWorkflow` 不插「新对话」行；平台不按 agent id 打开 / 高亮。

收窄这一条（原文「绑定 id」）：

```text
今日写法 / 已落地代码：
  仅当 current.type === 'session' 且 agentId 对得上：
    current.sessionId = 新id，mode = 'live'

应收窄为：
  仅当 current 是该 Agent 的草稿（sessionId == null）：
    current.sessionId = 新id，mode = 'live'
  否则 current 不动；owner stamp 仍发生
```

原文决策 9「发出第一条消息并且公布了标题 → 补上 sessionId，目录出现且只亮它」在**用户仍停在草稿**时成立。用户已经离开这条草稿时：目录仍可因 `session_title` 出现这一行，但**不**亮、右边**不**跳过去。

### session-title（不重写）

仍然成立：Pi jsonl 的 `name` 是标题真相；起名在 Agent；平台只公布 + 用户锁；侧栏只靠 `session_title` upsert；平台不起名、不按 agent id 分支。

收窄合同决策 7、通用决策 8 的时机：

```text
今日写法：
  合同：viewport 已有 sessionId 后公布。
  通用：effect 里 if (!sessionId) return；依赖 openSession 改了 current。

应收窄为：
  点火回调闭包里公布（合同 = startWorkflow 返回；通用占位 = promptSession 返回）。
  不要求 Surface 仍挂着，不要求 props.sessionId 已等于这个 id。
  通用短名仍跟 entries，仅还挂着时升级。
```

## Viewport Follow

```text
bindCurrentSession(agentId, sessionId)
  stampSessionOwner(sessionId, agentId)          // 永远做
  if current.type === 'session'
     && current.agentId === agentId
     && current.sessionId == null
    current = bindSession(current, sessionId)    // mode: 'live'
  else
    // 不改 current：用户在看历史 / 别的 Agent / 壳页面
```

`bindSession` 的纯函数语义跟着收窄：对已经有 id 的 session 再 bind，应原样返回（或由调用方先判断草稿）。不要再把历史会话的 id 覆盖成新跑起来的 id。

聊天 `actions.openSession(id)` 和 workflow 的 sessionId 回写走同一条 `bindCurrentSession`。通用首条 `promptSession` 回来后调 `openSession`，也只在仍是草稿时跟随。

## Title and Sidebar

```text
命令返回 sessionId
    │
    ├─ stamp owner（壳，已有）
    ├─ 视口 follow（仅草稿）
    └─ Agent 标题策略
         合同：文件名去最后一段扩展名，slice(0, 20)
         通用：已有两步（占位 → 短名）
         调用 setChatTitle(sessionId, title, 'agent')
              │
              ▼
         session_title 广播
              │
              ▼
         目录 upsert（归属：stamp / profileId，否则 current 挂着这个 id）
         高亮仍派生：只有右边正在看这个 id 才亮
```

不把起名搬进 `App.tsx` / `ipc.ts`。不要求合同 Surface 为了起名而保持 `props.sessionId`。历史模式仍不覆盖已有标题（title spec 已有）。

为了让发出命令的 Surface 拿到 id：`startWorkflow` 的类型定为 `void | Promise<{ sessionId?: string }>`，把 `runWorkflow` 的 Promise 交还（和 `promptSession` 已经返回 `{ sessionId }` 对称）。聊天那条空实现继续 `() => {}`。这是命令协议的收口，不是给合同开后门。不要写成 `Promise<unknown>`。

点火时不要把别人的历史改成 `mode: 'live'`。今日 `startWorkflow` 里若 `mode !== 'live'` 就同步改 mode——用户若在历史上看见闲着的按钮并误点，会把正在看的历史改成 live。`mode: 'live'` 只由草稿 `bindSession` 带上。历史页上的开始应走「新跑一条」且不抢焦点，而不是把当前历史 id 就地改成 live。

## Return Path

离开再回来：

1. 点目录里的那一行 → `current = openHistory(...)`（或聊天的 live）。
2. 该帧拿到 `sessionId` → `useAgentSession` `openChatSession`。
3. 读 JSONL + 会话记录上的 inputs；有活事件再接尾巴。
4. 文件还不存在（ENOENT）：`{ messages: [], entries: [], inputs: 记录里的 inputs }`，不要只回 `{ messages: [] }`。

运行时在离开期间该跑继续跑、该占池继续占。视口不补「我离开时错过的事件队列」；文件就是补课。

## Error Handling

| 情况 | 行为 |
| --- | --- |
| `runWorkflow` / `promptSession` reject | `useErrors().reportError`（toast + 报错中心 + `appendError`），视口停在原处 |
| 命令成功但用户已离开草稿 | 不 bind；stamp + Agent 公布标题；侧栏出现；不亮 |
| 命令成功且仍停在草稿 | bind；Surface 保留本地文件；随后 `openChatSession` + 订阅；标题公布后该行亮 |
| 第一步立刻失败并 release | 运行池空是真的；用户应看到错误，而不是无声的 idle |
| 回来时 JSONL 还没有 | 空时间线 + 仍有 inputs；不要变成「没选过文件」 |
| `session_title` 晚于离开 | upsert 进对的 Agent 分组，不抢高亮 |

## Invariants

任何时刻：

1. 运行中的会话集合 ≠ `current`。`current` 至多指向其中一条，也可以指向草稿或壳页面。
2. 改 `current` 不 `acquire` / `release` / 不调 `runWorkflow` / `promptSession`。
3. `runWorkflow` / `promptSession` 不读 `current`，也不等 `openChatSession`。
4. `bindCurrentSession` 在非草稿上是 no-op（除 stamp）。
5. 合同：`null→id` 且 `mode==='live'` 不清本地已选文件；`null→id` 且 `mode==='history'` 按打开历史重置。
6. 侧栏插入不依赖「发出命令的 Surface 仍是 current」。
7. 生产壳代码不出现 `workflowByAgent` / `activeSessionByAgent` / `titleByAgent`，也不按 `'general'` / `'contract-review'` 写 bind / 标题 / 高亮。
8. 活着的 `chat-event` 不是时间线的权威；JSONL 才是。

## Out of Scope

- 改合同审核步骤、风险操作、合并报告、导出。
- 改 Agent 起名字符串规则、用户锁名、截断。
- 改运行池容量、lease、审批抽屉。
- 改 `SessionList` 交互、置顶 / 归档 / 拖拽。
- 多窗口、分屏同时看两个 Agent。
- 把运行中会话列表做成第二份 current。
- 推迟 loop、握手门票、恢复 per-agent map。

## Testing

平台壳（`app-workflow` / `app-general` / `current-work`）：

- 停在合同草稿点开始 → bind 后本地文件还在；`session_title` 到达则该行亮。
- 合同草稿（未开始）点一条历史：`null→id` + `history` → 重置，按历史 inputs 装，不得留草稿文件。
- 点开始后立刻点另一条合同历史：右边仍是那条历史；新 id 因标题出现在目录但不亮。
- 点开始后立刻去首页 / 点另一个 Agent（Surface **已卸**）：`setChatTitle` 仍带着新 id 被调用；`session_title` upsert 进合同组且不亮。
- 同一合同草稿连续点两次开始：第二条返回的 id 不得覆盖已经 bind 的 current。
- `runWorkflow` reject：有 `reportError`（或错误中心看得到），`startWorkflow` 的空 catch 不复存在。
- 通用：发出首条后立刻点历史 / 回家 → 不抢焦点；占位名仍公布（`onSessionCreated`），侧栏出现；未出标题不插行的旧语义不放宽。
- `bindSession` / follow：page、历史、别的 Agent → 不改 current；只有草稿改。
- 命令已返回、视口已不在草稿：活着的 `chat-event` 可以先到；回来只靠 `openChatSession` 重读。
- bind 之后 JSONL 尚未落盘：时间线可以短暂 idle，「开始审核」仍显示；用运行池证明在跑。**禁止**用视口 `setBusy` 当「在跑」的真相。

IPC / session：

- `openChatSession` ENOENT 仍带 `inputs`。

回归：发送、标题 upsert、高亮派生、合同合并 / 导出断言不放宽。测试不得再「只在 bind 之后打事件」这一种路径；至少覆盖「命令已返回、视口已不在草稿」。

## Self-Review Notes

- 无 TBD：两轴、草稿才 bind、三种 sessionId 变化、标题跟命令不跟视口、ENOENT 带 inputs、失败要报、拒绝清单都已选定。
- 不重开 current-session / title 的主体讨论。
- 不把这次写成「修合同按钮」。聊天和以后的 Agent 用同一条缝。
- `runWorkflow` 保持「返回 id 时 loop 可能已经在跑」。视口用重读文件对齐，不用握手。
