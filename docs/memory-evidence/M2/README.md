# M2 验收证据

- 日期：2026-11-23
- 路径相对仓库根。原始输出保留在本目录；`scratch/` 中的构建与临时件在交付前清理。

## 0. 取证方式（先说明局限，再给证据）

本机隔离实例里**没有可用的模型凭据**（`data/pi-agent/auth.json` 与 `keyring/apiKey` 均空），真实云端大模型无法调用。为不把「界面绿勾」当证据，本次走产品自带的自定义服务商通道接了一个**本机 OpenAI 兼容桩**（`127.0.0.1:8787`，只在本机回包、不出机）：

- 真实链路未打折：真实 renderer IPC → 真实 `ExtractionScheduler` → 真实 `PiRuntimePool.acquireIfIdle` 内部槽位 → 真实 pi 子进程 → 真实 HTTP 请求 → 真实 `parseExtraction` / `applyOps` / 真相源文件 / `memory.db`。
- 唯一被替换的是「谁产生那段 JSON」。桩把每次请求写进 `mock-llm-requests.log`，因此**调用次数**是可数的客观事实（下面第 6 节用它证明「关闭自动提炼后零提炼调用」）。
- 桩的三种回包形态：正常提炼 JSON、畸形输出、`memory_forget` 工具调用（用于审批链路）。
- 为缩短等待，验收期间把 `extractionDebounceMs` 从 90000 改成 4000/6000（设置项本身，测完不写回默认值也不影响交付，因为 `scratch/` 会清理）。

## 1. 端到端：三段真实对话 → 提炼 → pending（含 excerpt）→ 批准 → 下一条会话注入

- `extraction-and-injection.log.txt`：主进程日志原文。可见 `memory extraction applied`（`opsApplied: 2`）与紧随其后的 `memory prompt block appended to saddle`，块内含
  `[用户] (2026-11-23) 用户偏好先给结论，正文不超过三句` 与
  `[项目] (2026-11-23) 本项目报价一律使用人民币`。
- `m2-pending-dark.png`：深色主题「待确认」区，两条候选各自带 `来源：…`（excerpt，用户原话）、`批准` / `驳回`。
- 批准动作是在真实 UI 上点 `批准` 完成的（`批准#2` → `批准#1`），不是直接调 IPC。
- 新会话注入取证不是读界面：`memory prompt block appended` 这条日志由 `service.buildBlock → buildMemoryBlock` 生产路径写出。

## 2. 驳回 → 不再提案

- 同一组偏好文本第二次提炼产生 `UPDATE` 候选（targetId 指向已生效条目，说明高相似降级生效）；在 UI 上 `驳回` 后进黑名单。
- 第三个会话再提炼：日志 `opsApplied: 0`，`listMemories().pending` 为空（见 `final-state.txt` 的 `rejected_hashes` 两行，`session_id` 指向驳回发生的会话）。

## 3. 畸形输出：整批丢弃 + errors.db + 真相源无半批写入

- `extraction-and-injection.log.txt` 中 `memory extraction batch discarded`，原因为「提炼输出不是合法 JSON」。
- `final-state.txt`：`errors.db` 有 `memory.extract-parse` 记录。
- 同一批次其它断言（真实实例侧）：`user.json` / 项目 `memory.json` 的 md5 在提炼前后一致；`memories` 行数不变；该会话没有 `extraction_state` 行（位点未推进，下次会重试）。`episodes` 未新增。

## 4. `memory_forget` 弹审批 + 普通删除三处无残留

- `m2-forget-approval.png`：真实会话里模型发起 `memory_forget`（参数 `query`），平台弹出**高风险**审批框：标题「删除 1 条记忆：先给结论」、`可能无法恢复`、倒计时、将删除条目预览、`拒绝` / `允许`；点 `允许` 后还有一次 `再次确认允许`（二次确认），与其它高风险动作同一套组件。
- 批准后三处核验（真实实例）：`user.json` 的 `entries` 变空、`memories` 表该行消失、`memories_fts` 的 `MATCH '"先给结论"'` 命中 0（索引行数同步减一）。

## 5. 连源会话删除（隐私删除）五处无残留

被删除的是会话 `01a2085a-…` 产生的「本项目交付周期以周为单位」。删除前该会话挂着 1 条 active、2 条 pending、1 条 episode、1 条黑名单哈希、1 个 JSONL、1 行 `chat_sessions`；删除后：

- `memories`：该 `source_session` 的行 **0**（active 与 pending 一起走）
- `episodes`：该会话 **0** 行（总量从 4 降到 3）
- `rejected_hashes`：该会话 **0** 行（其它会话的哈希保留，未误删）
- JSONL：`2026-11-23T12-21-00-231Z_01a2085a-….jsonl` 已消失
- `chat_sessions`：`id = 01a2085a-…` **0** 行
- 界面同时给出「来源会话与相关记忆已删除」提示
- 详见 `final-state.txt`

## 6. 关闭自动提炼 → 零提炼调用

桩日志清零后，关闭 `autoExtract` 再跑一个新会话的 3 轮对话：

- 桩收到 **3** 条请求，全部是会话请求（含 `memory_remember/forget/search` 工具清单）
- 含「你是记忆提炼器」的请求 **0** 条
- `pending` 未增加

即：关闭开关后系统不会为提炼发起任何模型调用。

## 7. 本轮实测发现并修掉的三个缺陷（都有回归用例）

1. **首条项目记忆被静默丢弃**：`previewScope('project')` 在项目 `memory.json` 尚不存在时返回 `null`，`applyOps` 直接 `continue`；而手动新增走的 `resolveScope` 会创建该文件。真实实例症状：一次提炼 `opsApplied` 只有 1（项目候选消失）。改为一处：文件不存在时按 §126「创建时生成」分配 `projectId`（损坏文件仍返回 `null`，不覆盖）。用例：`memory-extraction.test.ts > user 工作区的首条项目候选…`。
2. **后台提炼的新候选在已打开的面板里不出现**：服务端为待确认专门发了 `pending_added` 事件，面板只处理 `repair_needed` / `source-deleted`。改为 `pending_added` 与 `memory_changed` 都 `refresh()`。用例：`memory-settings-pane.test.tsx > 面板开着时收到 pending_added…`。
3. **同一偏好重复提案**：ADD 去重只比对 `status='active'`，同 scope 已有高相似 pending 时仍会再写一条（真实实例出现过 4 条待确认里两对重复）。改为高相似 pending 直接跳过。用例：`memory-extraction.test.ts > 同一候选重复提炼…`。

## 8. 三件套（连跑）

- typecheck：`typecheck-run-1.txt` / `typecheck-run-2.txt`，两次均 `EXIT 0`。
- lint：`lint-run-1.txt` / `lint-run-2.txt`，两次均 `0 errors`，27 个 warning 全为仓库既有（本模块新增告警为 0）。
- test：`test-run-1.txt` / `test-run-2.txt` / `test-run-3.txt`。三次全量跑唯一稳定失败是 `windows-sandbox-spike.test.ts`（本机安全策略禁用 `reg.exe`，M1 已用未改动基线 worktree 证明与本次改动无关）。第 2、3 次各另有一次偶发超时（`host-shell-integration` 终止任务超时、`watchdog-command-line` NSIS 探针 30s 超时），两者在单独复跑时分别 3/3、4/4 通过，属并发压测下的环境抖动。
- 记忆模块用例：`memory-scoring`(5) + `memory-service`(10) + `memory-fence`(4) + `memory-extraction`(10) + `memory-tools`(5) + `memory-settings-pane`(2) = 36 例，全绿。

## 9. CDP console / network

- 取证全程 `Runtime.exceptionThrown = 0`、`Log.entryAdded = 0`、`Network.loadingFailed = 0`。
- 唯一 warning 仍是 Electron 开发态 `Insecure Content-Security-Policy`（框架级、打包后消失，M1 README 已记录同类审计结论）。
