# 平台文档解析 — Design Spec

**Status:** Draft v3 — **引擎 / 模型 / 默认安装包已作废**  
**Date:** 2026-09-10  
**引擎与随包以这份为准：** `docs/superpowers/specs/2026-09-11-document-parse-fast-path-design.md`。本文「禁止 v6」「锁定 PP-OCRv5_server」「默认 PP-StructureV3」「随包约 1.8 GB 完整产线」等条款不要再遵守。NDJSON、运行中心、copy rules 仍有效。  
**Depends on:**
- `docs/2026-08-22-design.md`（A 类连接器：文档）
- `docs/superpowers/specs/2026-08-23-pi-embedded-runtime-design.md`（Renderer / Main / Pi）
- `docs/superpowers/specs/2026-08-28-runtime-pool-management-design.md`（运行中心、底栏、智能体槽位）
- `docs/superpowers/specs/2026-08-31-self-contained-runtime-distribution-design.md`（运行时解压到 LOCALAPPDATA）
- `docs/superpowers/specs/2026-09-09-sparkii-rag-connector-design.md`（`host: 'main'` 原则；接线细节以本规格为准，不要照抄「现有 connector_read 即可」）
- `packages/connectors` 现有 `document.read`（pdfjs / mammoth / xlsx 抽文字层）

**Amends:**
- `document.read` 今日只抽电子文字层；扫描件、照片、空文字层 PDF 会得到空文本。本规格把扫描件解析做成**平台能力**，仍走同一工具名。
- 运行中心今日只列智能体会话。本规格在同一抽屉增加 **文档解析** 一块，不新开窗口，也不把解析伪装成一条智能体会话。
- `handleConnectorRead` 今日只放行 `knowledge.search` / `knowledge.fetch_document`。本规格要求再放行 `document.read`，并由 **同一** `executeDocumentRead` 服务聊天和合同 workflow。

---

## Goal

让所有声明了 `document.read` 的智能体都能读扫描件、照片和几乎没有文字层的 PDF，而不给某个智能体单独做 OCR 工具。

引擎是本机 **PP-StructureV3**（内部认字 = **PP-OCRv5_server**）。电子件仍走现在的文字层，不过这条产线。智能体只看到 Markdown 正文和一份识别质量；看不到模型名，也不知道后面有一个解析进程。

SparkiiRAG 继续只负责知识库检索。当场打开的合同、发票、附件不送去入库。

## Why this round

合同审核、以后的财务扫描单据、化验手写，都卡在同一处：`document.read` 抽不到字。先做平台解析，再开财务/化验智能体。环保、工艺诊断不靠这一条。

## Confirmed Decisions

1. **平台能力，不是某个智能体的附件。** 禁止 `if (agent.id === …)` 决定要不要解析。声明了 `document.read` 的智能体自动获得扫描件能力。
2. **本机引擎。** 不用 SparkiiRAG 入库解析，不用视觉大模型当默认正文来源，不把 PaddleOCR-VL 当默认。客户工位可以没有 NVIDIA GPU。
3. **只调 PP-StructureV3 一次。** 不并排再装 PP-OCRv6，不自己把「先跑一遍 OCR、再跑一遍 Structure」拼起来。Structure 的 `ocr_version` 只认 v3/v4/v5；内部认字锁定 **PP-OCRv5_server**（det + rec）。
4. **不搬 DeepDoc。** RAGFlow DeepDoc 是 InfiniFlow 自有 ONNX 产线，不是当前 PaddleOCR 的包装。Desktop 用官方 PaddleOCR / PaddleX 的 Structure，不复制 SparkiiRAG 的 Python。
5. **智能体只调 `document.read`。** 给模型的主字段 `text` 是 **Markdown**（表格为 Markdown 表或 HTML 表）。一期返回给智能体的 `data` 只有 `{ text, kind, engine, meta }`，**不含** `blocks`/`tables`（避免 workflow JSONL 膨胀）。老智能体继续读 `text`。
6. **一期文件：** 扫描 PDF、照片（jpg/jpeg/png）、文字层空或乱码的 PDF → Structure。Word / Excel / 文本 / 文字层正常的 PDF → 现有 mammoth / xlsx / pdfjs，**不过** Structure。合同选择器和原文预览必须能打开照片，否则「照片走 Structure」没有用户入口。
7. **解析进程独立于 Pi。** Main `child_process.spawn` 全应用 **一个** 解析程序。传输是 **stdin/stdout 上的 NDJSON**，不是 Pi 的 `utilityProcess` / `postMessage` 信封。不监听端口、不做本机 REST。代码名 `document-parse-worker`；用户可见名称一律 **文档解析**。
8. **第一次真正需要 Structure 的 `document.read` 才拉起进程。** 打开 App、进合同审核、电子 PDF 走文字层：不启动。队列空且无在飞任务后，默认 **5 分钟** 杀掉进程、卸掉模型。设置可改为常驻。在飞或排队时禁止空闲释放。
9. **失败必须失败。** 引擎没装好、进程崩溃、解析出错：`document.read` 返回错误，提示去「设置 → 文档解析」。禁止静默返回空 `text` 让模型编造。
10. **一期不做单独的人工复核工作流。** 必须让人看见识别质量：整份高/中/低 + 百分数；详情里按页。电子件不显示假的识别分数。低质量只是警告，不改写正文、不阻断继续。
11. **安装包只带基础能力。** 随包：版面 + OCR v5 + 表格 + 转正/展平。印章、公式、图表按需：有网从 **Paddle/百度官方源** 下载；内网用离线包导入数据目录。缺可选模块时跳过该能力，不让整页失败。
12. **运行中心扩展，不新开窗口。** 底栏仍打开同一个抽屉。里面两块：**智能体**（现有列表外包一层标题）、**文档解析**。底栏 `1/4` 只表示智能体槽位。解析进行中在旁边加「文档解析进行中」，不把解析算进 `2/4`。界面、设置、报错来源不出现 worker / sidecar / OCR 引擎 / OC2 / JSON-RPC。
13. **有网下载源用官方 Paddle/百度。** 不依赖 HuggingFace 作为默认源。基础模型已在安装包里，不上公网也能跑完合同扫描。
14. **`executeDocumentRead` 是唯一执行器。** 聊天 `handleConnectorRead` 和合同 `runTool` 都必须调用它。`document.read` 的 `host: 'main'`、白名单放行、`runTool` 分支、子进程 stub **同一提交**落地。只改 `host` 不改白名单，聊天会立刻 `unhandled`。
15. **一期接受 FIFO 会占住智能体槽位。** 四个合同会话可以同时占槽、排队等解析。不做「解析期间释放槽位」。会话 **停止（abortChat）与释放线程** 都必须 `failSession(sessionId)`（当前任务若属于该会话则停，队列中该会话的项全部失败，其它会话保留）。合同 `load` 走 Main `LinearRunner`，只 abort Pi **不会**取消正在跑的 `document.read`。
16. **退出走 Electron `before-quit`，没有应用内「注销」。** 关最后窗口、退出应用、操作系统注销都进同一钩子：`preventDefault` 一次，`await failAll()`（文案「文档解析已停止。」），杀进程树，再 `app.quit()`。用 `quitting` 守卫防止重入。账号抽屉里的修改密码 / 导出审计不是注销，不杀解析进程。

## Architect corrections (v1 → v2)

| 项 | v1 误写 / 过薄 | v2 锁定 |
| --- | --- | --- |
| Main 接线 | 「现有 connector_read 即可」 | `executeDocumentRead` 同时接到 `handleConnectorRead`（放行 `document.read`）和 `workflow.ts` `runTool`（与 `knowledge.search` 同样的特殊分支） |
| 子进程 handler | 立刻改成 stub | 两条 Main 路径都调用执行器之后，handler 才返回「必须在主程序执行」 |
| 传输 | 「与 Pi 同一类接法」 | Pi 仍是 `postMessage` 信封。解析进程是 `spawn` 外来二进制 + **NDJSON**；stdout 只走 RPC，日志走 stderr/文件；Windows 杀**进程树** |
| 快照 | 「推进运行中心快照」未定义类型 | 独立 `DocumentParseSnapshot`，作 Pi 快照的**兄弟字段或独立事件**；禁止写入 `slots` |
| 包装 | 「跟 Portable Git 一样」一句话 | 与 08-31 同级：产物、校验、解压、ensure、卸载、许可证、可选模块清单 URL |
| 谁渲染 PDF | 「抽不出页 → 渲染后当图」未指派 | 文字层探测可在 Main（合同今天已经这样）。Structure 的 PDF 栅格化**只在解析进程**，Main 不写页图 |
| 照片 | 文件类型含 jpg，但合同选择器没有 | 合同 `chooseDocument` + `documentKindOf` + 原文预览增加 jpg/jpeg/png |
| 质量落点 | 「JSONL 旁路」含糊 | 合同：`extractWorkflowResult().load.meta.quality`。聊天：`document.read` 的 toolResult；`engine==='structure'` 时简洁模式也显示紧凑质量条 |
| 设置保存 | 未提 | `saveDocumentParseSettings`；`saveSettings` 必须像 `rag` 一样保留 `documentParse`，防止大模型设置页冲掉 |
| 关掉能力 | 写了但设置表没有 | **不做**总开关。基线随包装好即可用。连续启动失败用设置里的「重新加载」清熔断 |
| 退出 / 注销 | 「注销」像有独立功能 | 无应用内注销。只接 `before-quit`（见决策 16） |
| `host: 'main'` 时机 | 可被理解成先改声明 | 与白名单、`runTool`、stub **同一提交** |
| 混合 PDF | 整份判定 | 一期不做按页拆引擎。已知漏：稀疏电子表会误进 Structure；带扫描附件的长电子 PDF 会漏掉附件。记录在案，禁止实施时「顺手」改成按页双引擎 |
| 通用 kind 联合 | 预留 `kind` union | 一期只加「文档解析」一块。不要先做通用进程列表框架 |

## Current State

- `packages/connectors/src/document/index.ts`：`document.read` 无 `host: 'main'`。聊天路径上工具在 **Pi 子进程**执行 pdfjs/mammoth/xlsx。合同 `load` **不经** `connector_read`：`LinearRunner` → `runTool` 已在 Main 调 `tool.handler`。
- `handleConnectorRead`（`apps/desktop/electron/main/ipc.ts`）白名单只有 `knowledge.fetch_document` 与 `knowledge.search`。给 `document.read` 加 `host: 'main'` 若不改白名单，聊天会得到 `CONNECTOR_DENIED` / `unhandled`。
- `runTool` 只对 `knowledge.search` + SparkiiRAG 走 Main 专用函数；其它只读工具（含今天的 `document.read`）直接 `tool.handler`。
- 运行中心只反映 `RuntimePoolSnapshot`：`{ maxAgents, active, queued, slots, queue }`。`active` 是智能体槽位数。抽屉没有「智能体」分组标题。智能体按钮文案是「释放线程」，本规格不改这个词。
- `saveSettings` 合并时强制 `rag: prev.rag`。`documentParse` 必须同样锁住。
- 合同选择器：`chooseDocument({ extensions: ['pdf', 'docx', 'txt'] })`。`document-bytes.ts` 的 `PREVIEW_EXTENSIONS` / `documentKindOf` 无图片。
- 聊天贴图走视觉模型（`images[]`），不经 `document.read`。本期不合并。
- 仓库运行时没有 Python。`runtime-layout` / NSIS 只知道 Portable Git 与 fd/rg。

## Approaches（已选）

| 方案 | 结论 |
| --- | --- |
| 视觉大模型看图当正文 | 不采用。数字不可审计，云端会送出文件。 |
| SparkiiRAG / DeepDoc 入库解析 | 不采用。当场读文件 ≠ 知识库入库；没开 RAG 的智能体会被绑死。 |
| PP-OCRv6 通用 OCR + 自己拼表 | 不采用。要结构就走 Structure；v6 尚未正式接到 Structure 的 `ocr_version`。 |
| 本机 REST 侧车 | 不采用。多一个端口，像再部署一套 SparkiiRAG。 |
| Paddle 塞进 Pi 或 Main | 不采用。Pi 会按智能体复制多份模型；Main 会卡死窗口。 |
| **Main spawn 一个解析进程 + stdout NDJSON** | **采用。** 不是 Pi 的 IPC 信封。 |

## Non-goals（一期）

- 财务扫描单据智能体、化验录入智能体、环保 / 工艺诊断。
- 人工逐页复核台、改字后回写、阻断低质量继续。
- PaddleOCR-VL、单独的 PP-OCRv6、GPU/CUDA 安装包。
- Desktop 上传到 SparkiiRAG、触发知识库 parse/chunk。
- 把聊天「看图」和 `document.read` 合成一条。
- 新窗口「进程管理中心」；把文档解析伪装成智能体会话行；通用 `kind` 进程框架。
- 多解析进程并行、按智能体各开一份模型。
- 解析期间释放智能体槽位（FIFO 占槽是接受的）。
- 按页拆引擎（混合 PDF 已知漏，见上）。
- Linux / macOS 作为一期交付目标（实现可预留路径，安装包与模型布局先按 Windows）。
- 页内框选高亮、把识别框叠回 PDF 预览。
- 文档解析总开关（「关掉能力」）。
- 把 `blocks`/`tables` 写入 JSONL 或发给模型。

---

## Architecture

```text
Renderer（窗口）
  运行中心：智能体（现有）+ 文档解析（新一块）
  订阅 runtime-pool（只含智能体）和 document-parse（独立快照）
  识别质量：合同原文侧 / 聊天紧凑条
  设置 → 文档解析
  只发 IPC，不 spawn，不碰模型文件

Main（Electron 主进程）
  executeDocumentRead（唯一执行器）
    ← handleConnectorRead（聊天，Pi host:main）
    ← runTool（合同 load）
  路由：电子件 / 文字层探测在 Main（可接受的短暂 CPU）
    Structure：needsDocumentParse → 磁盘≥2GB → ensure（窗口可显示「正在准备文档解析」）→ enqueueParse
  解析进程监督：`getDocumentParseSupervisor()` 模块单例，ipc / workflow / document-read / before-quit 共用同一份
  生命周期、队列、模块安装
  before-quit：preventDefault → await failAll → 杀进程树 → app.quit（quitting 守卫）

Pi（智能体循环）
  只发出 document.read({ documents })
  不加载 Paddle，不读模型目录

解析进程（全应用 1 个，代码名 document-parse-worker）
  随包 Windows CPU 程序 + baseline 模型
  stdin/stdout NDJSON
  自己把 PDF 页渲染成图再跑 Structure
  不监听 TCP
```

### 两条 Main 入口（必须同时改）

今天合同审核不走 Pi 的 `document.read` 子进程路径，聊天才走。只改其中一个会让另一条继续抽空文字或直接 `unhandled`。

```text
聊天 / 通用（Pi 工具）
  document.read host: 'main'
  → connector_read
  → handleConnectorRead
       今日：非 knowledge.* → unhandled
       本期：document.read → executeDocumentRead

合同审核（workflow load）
  LinearRunner → runTool('document.read')
  → 今日：documentConnector.handler（Main 上的 pdfjs）
  → 本期：executeDocumentRead（与上面同一函数）
```

子进程里的 `documentConnector.handler`：在上述两处都改完之前，保持现有电子件解析（避免合同审核在半成品分支上坏掉）。两条都接到 `executeDocumentRead` 之后，handler 改为返回 `{ ok: false, error: { code: 'CONNECTOR_DENIED', message: 'document.read must run on main' } }`。

### 包边界

| 包 | 职责 |
| --- | --- |
| `@sparkii/connectors` | `ParsedDocument`、电子件 Markdown、`shouldUseStructure()` 纯函数。`document.read` 标 `host: 'main'`。不 import Electron、不 spawn。 |
| `apps/desktop` Main | `executeDocumentRead`、解析进程监督、队列、设置、模块安装、IPC。 |
| 解析程序 | 只跑 PP-StructureV3；读路径；按页回报；自己栅格化 PDF。 |
| `packages/ui` | 运行中心第二块、底栏拼接文案、识别质量条组件。不出现内部进程名。 |
| Renderer Surface | 合同从 `load.meta.quality` 画；聊天从 toolResult 画。禁止按智能体 id 分支。 |
| `packages/agent-host` | 不新增工具协议。`connector_read` 请求形状不变。 |
| 各智能体 profile | **不改工具名。** |

Main 永不把模型路径、RPC 帧、Python 堆栈原文经 IPC 传给窗口。窗口只收：状态枚举、页码、智能体显示名、文件名、错误的用户文案。

---

## 引擎与模块

PP-StructureV3 是一条产线。Desktop 调一次 parse：

| 模块 | 一期默认 | 模型（官方配对） | 体积量级 |
| --- | --- | --- | --- |
| 版面 | 随包，必开 | `PP-DocLayout_plus-L` | ~126 MB |
| 区块 | 随包，必开 | `PP-DocBlockLayout` | ~124 MB |
| 文字检测 / 识别 | 随包，必开 | `PP-OCRv5_server_det` + `PP-OCRv5_server_rec` | ~84 + 81 MB |
| 行方向 | 随包 | `PP-LCNet_x1_0_textline_ori` | ~6.5 MB |
| 表格分类 + 有线/无线表 + 单元格 | 随包，必开 | `PP-LCNet_x1_0_table_cls`、`SLANeXt_wired`、`SLANet_plus`、RT-DETR-L 单元格 | 合计约 0.6 GB |
| 转正 / 展平 | 随包，扫描件开 | `PP-LCNet_doc_ori` + `UVDoc` | ~7 + 30 MB |
| 印章 | 按需 | `PP-OCRv4_server_seal_det` 等 | ~109 MB |
| 公式 | 按需 | `PP-FormulaNet_plus-L` | ~698 MB |
| 图表 | 按需 | `PP-Chart2Table` | ~1.4 GB |

随包模型合计约 **1.2 GB**。加上 CPU 版 Paddle 运行时，安装包增量大约 **1.5–1.7 GB**（不含 Electron 壳）。全开三件套另加约 2.2 GB，不打进默认安装包。

缺可选模块：跳过该能力，`meta.skippedModules` 记录，整次 `document.read` 仍成功。图表失败时保留「这是一张图」，不拖垮整页。

不在 Structure 之外再跑一次独立 OCR。不把检测/识别换成未接入的 v6。

---

## 随包布局与按需安装

沿用 `%LOCALAPPDATA%\SparkiiDesktop\runtime\`。

```text
%LOCALAPPDATA%\SparkiiDesktop\
  runtime\
    portable-git\                 已有
    tools\                        已有 fd/rg
    document-parse\               新增
      bin\sparkii-document-parse.exe
      models\baseline\            安装器解压
      models\optional\seal\
      models\optional\formula\
      models\optional\chart\
      licenses\
```

### 产物（与 08-31 同级）

| 项 | 锁定 |
| --- | --- |
| 产物名 | `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`（自解压，用法同 `portable-git.7z.exe`） |
| 内容 | Windows x64 **CPU** 可执行入口 `sparkii-document-parse.exe` + 私有解释器/依赖 + `models/baseline` + `licenses/`。用户无系统 Python / CUDA 也能跑 |
| 来源 | Sparkii 构建的发布物，**不是**用户机器现场 pip。构建脚本与版本钉在 `apps/desktop/runtime/document-parse/README.md`；checksum 钉在 `apps/desktop/runtime/document-parse/checksums.json` |
| SHA256 | `checksums.json` 的 `archive` 字段。`ensure` 与安装后校验失败则视为未就绪，禁止跑解析 |
| extraResources | **仅当** `checksums.json.archive` 已是 64 位 sha256 且 `sparkii-document-parse.7z.exe` 已放进 `apps/desktop/runtime/document-parse/`。归档未产出前禁止写入 `electron-builder.yml`（`pnpm dist` 会因缺文件失败）。AppX 不跑 NSIS，只靠首次 `ensureDocumentParse` |
| NSIS `customInstall` | 有归档时解压到 `$LOCALAPPDATA\SparkiiDesktop\runtime\document-parse`。失败不阻断安装，只 `DetailPrint` |
| 首次补齐 | `needsDocumentParse()`：缺少 `bin/sparkii-document-parse.exe` 或 baseline 哨兵文件（`models/baseline/READY`）则为真。`ensureDocumentParse()` 从 extraResources / 开发归档解压。解压期间窗口可显示「正在准备文档解析」（不启动解析进程本身） |
| `pnpm ensure:runtime` | 调用并列脚本 `ensure-document-parse.mjs`（或并入现有 ensure），解压到同一 LOCALAPPDATA 路径。不按 `app.isPackaged` 换根目录 |
| 卸载 | `customUnInstall` 增加 `RMDir /r "$LOCALAPPDATA\SparkiiDesktop\runtime\document-parse"`。不删 `data\` |
| 就绪探针 | 入口存在 **且** `models/baseline/READY` 存在 **且** checksum 已验证过一次（标记文件即可，不必每次启动全量哈希 1.2 GB） |
| 磁盘 | spawn 前若 `needsDocumentParse` 且盘上可用空间 < 2 GB，失败文案：「磁盘空间不足，无法准备文档解析。」 |

### 可选模块清单

仓库检入 `apps/desktop/runtime/document-parse/modules.json`（实施时按 PaddleX 3.7 YAML 填**完整 URL + sha256 + minBytes + 相对目标路径**）。约束：

- Host 只允许 `paddle-model-ecology.bj.bcebos.com` 或 `paddleocr.bj.bcebos.com`。禁止 HuggingFace 默认源。
- 有网：设置里下载到 `models/optional/<id>/`，校验 sha256。
- 内网：导入 zip/目录，按同一清单核对**文件名 + minBytes**（离线包也必须带 `manifest.json` 列出文件）。一期不做签名链。
- 合并前 `modules.json` 每条必须有完整 URL（host 在 allowlist）和 64 位 sha256。禁止提交 `REPLACE_*` 占位。没有真哈希不得写下载函数。URL 以 PaddleX **3.7** YAML 为准（Bos `official_inference_model`），实施时核对文件名后再钉死，不要照抄过期路径。

### 许可

与 08-31 §9 同级：Paddle CPU 运行时与 baseline/optional 模型的许可证放进 `runtime/document-parse/licenses/`（Apache-2.0 等原文）。公开发布前法务确认，属发布门禁。解析程序以独立进程被 Electron 聚合调用。

---

## `document.read` 契约

工具名、参数保持：

```ts
{ documents: string[] }  // 一期仍读 documents[0]；其余忽略并在 meta.ignoredCount 注明
```

终态 `host: 'main'`。与 `handleConnectorRead` 白名单、`runTool` 分支、子进程 stub **同一提交**；不得提前只改声明。

成功时发给智能体的 `data`（聊天 toolResult 与合同 `workflow_step_end` 的 `load` 相同形状）：

```ts
type DocumentEngine = 'native' | 'structure';
type RecognitionLevel = 'high' | 'mid' | 'low';

interface RecognitionQuality {
  score: number;          // 0–1
  level: RecognitionLevel;
  pages: Array<{ page: number; score: number; level: RecognitionLevel }>;
}

interface ParsedDocument {
  text: string;
  kind: 'pdf' | 'docx' | 'xlsx' | 'text' | 'image';
  engine: DocumentEngine;
  meta: {
    fileName: string;
    pageCount?: number;
    quality?: RecognitionQuality;  // 仅 engine === 'structure'
    skippedModules?: string[];
    ignoredCount?: number;
  };
}
```

- `text`：Markdown。表格用 Markdown 表（复杂合并格可用 HTML `<table>`）。公式若模块已装则 LaTeX 代码块。图：一行说明，不把二进制塞进 `text`。
- 电子件也 Markdown 化，`engine: 'native'`，**没有** `quality`。
- **一期不把 `blocks`/`tables` 放进 `data`。** 解析进程内部用来生成 Markdown，丢弃。以后要框层再加字段。
- 工具描述覆盖扫描件，仍写「读取并解析本地文档」，不出现 Paddle / Structure / OCR。

### 路由（Main，确定性，不经模型）

纯函数 `shouldUseStructure({ ext, textLayer, pageCount })` 放在 `@sparkii/connectors`，Main 和单测共用。

| 扩展名 | 路径 |
| --- | --- |
| `.txt` `.md` `.csv` `.docx` `.xlsx` | 永远 native |
| `.jpg` `.jpeg` `.png` | 永远 structure |
| `.pdf` | 先在 **Main** 用 pdfjs 抽文字层；若判定「空或乱码」→ structure，否则 native |
| 其他 | `CONNECTOR_UNSUPPORTED` |

PDF「空或乱码」：

1. 抽不出任何页 → structure。解析进程拿到**原始 PDF 路径**自己渲染，Main **不**写 PNG。
2. 全部页拼接后去空白，长度 `< 50 × pageCount` → structure。
3. U+FFFD 或控制字符占比 `> 0.30` → structure。
4. 否则 native。文字层转 Markdown 页分隔返回，不再送 Structure。

**已知漏（一期不修）：** 稀疏电子表可能误进 Structure（慢，但结果仍可用）；前半电子、后半扫描的长 PDF 会整份走 native，扫描页仍是空的。禁止实施时改成按页双引擎。

文字层探测跑在 Main：与今天合同 `document.read` 相同，一期接受。若窗口卡顿再单独立项挪到 Node utilityProcess，不作为本规格静默选项。

**Structure 的 I/O 与 PDF 栅格化只在解析进程。** Main 只传本地绝对路径。

### 照片入口（否则类型表是空话）

| 面 | 改动 |
| --- | --- |
| 合同选择器 | `chooseDocument({ extensions: ['pdf', 'docx', 'txt', 'jpg', 'jpeg', 'png'] })` |
| `documentKindOf` / `PREVIEW_EXTENSIONS` | 增加 `image`（jpg/jpeg/png） |
| 原文预览 | 图片用 `<img>`（blob URL），不走 pdfjs |
| 聊天 Composer 贴图 | **不改**，仍给视觉模型 |

质量展示仍禁止 `if (agent.id === …)`：预览头上的质量条吃 `load.meta.quality`，任何 workflow 的 load 都能用。

---

## 解析进程：传输、生命周期、队列

### 传输（不是 Pi）

| | Pi | 文档解析 |
| --- | --- | --- |
| 启动 | `utilityProcess.fork` / `fork` | `child_process.spawn(exe, [], { stdio: ['pipe','pipe','pipe'] })` |
| 帧 | `PiRuntimeEnvelope` + `postMessage` | **一行一条 JSON（NDJSON）**，`\n` 分隔 |
| stdout | 不用来当 RPC | **只** RPC。Paddle/Python 日志不得写 stdout |
| stderr | 另论 | 追加到 `data/logs/document-parse.log`（轮转简单按大小 5 MB） |
| 杀进程 | 现有 supervisor | Windows：杀**进程树**（冻结运行时会再 spawn 孙进程）。`child.kill()` 不够。使用 `taskkill /pid <pid> /T /F`（或等价），再 `wait` |
| `before-quit` | 现有池无此钩子，需新增 | `preventDefault` 一次 → `await failAll()` → 杀树 → `app.quit()`；第二次进入因 `quitting` 直接放行 |

NDJSON 请求/响应（内部，不暴露给窗口）：

```text
→ {"id":"1","method":"parse","params":{"path":"C:/.../a.pdf","modules":["baseline","seal"]}}
← {"id":"1","method":"progress","params":{"page":3,"total":12}}
← {"id":"1","result":{"markdown":"...","pages":[{"page":1,"score":0.91}]}}
→ {"id":"2","method":"shutdown"}
```

出错：`{"id":"1","error":{"code":"PARSE_FAILED","message":"..."}}`。Main 把 message 映射成用户文案，不把堆栈原文送到 toast。

整份任务超时默认 10 分钟。超时 = 该次失败，并允许用户点停止。一期不对单页做 watchdog。

### 状态机

```text
stopped（未启动）
    第一次需要 Structure 的 document.read
        → starting（正在加载）
        → idle / resident 或直接 parsing
parsing（正在解析）
    FIFO，同时 1 个任务
idle（空闲）— 默认 5 分钟后杀进程
resident（常驻）— 不因空闲杀
```

- `ensureParseProcess()` 仅在路由到 structure 时调用。`starting` 期间新任务入队，不第二次 spawn。
- 在飞或排队：禁止空闲计时与空闲杀。
- `idleMinutes` 默认 5，范围 1–60。`0` 不是立即杀；立即杀用运行中心「释放」。
- 常驻默认关。打开后不因空闲杀。设置里提示：常驻大约占用 **1 GB 以上** 内存。
- spawn 失败（含 OOM）：该次 `document.read` 失败：「内存不足或文档解析无法启动，请到设置 → 文档解析查看。」连续 **3** 次启动失败进入熔断，不再自动 spawn；设置「重新加载」或成功保存文档解析设置后清熔断。没有「关掉文档解析」开关。
- 崩溃：当前任务失败；状态 `stopped`；错误中心来源「文档解析」。未达熔断则可在下次 `document.read` 再拉起。
- 停止解析：中断当前 RPC，该次失败「文档解析已停止。」队列下一项继续。无空状态「启动」按钮。
- 释放：不在 `parsing`/`starting`，或先停止再释放。杀树，卸模型。

### FIFO 与智能体槽位

一期 **接受** 解析排队时智能体槽位被占住（`connector_read` / `runTool` 未返回，Pi/workflow 仍占槽）。不做解析期间还槽。

| 事件 | 行为 |
| --- | --- |
| 用户停止解析 | 失败当前任务；队列下一个接着跑 |
| 用户停止/释放**该智能体会话**（`abortChat` 与 `releaseSessionSlotInternal`） | `failSession(sessionId)`：**先于** Pi abort / unbind。当前任务属于该会话则停；队列中该会话项全部失败「文档解析已停止。」其它会话保留。合同 load 只靠这条 |
| 退出应用（`before-quit`） | `failAll` → 杀树 → `app.quit()`。无应用内注销 |
| 空闲超时 | 仅当队列空且无在飞 |

---

## 运行中心快照与用词

**禁止**把文档解析写进 `RuntimePoolSnapshot.slots`。`active` / `maxAgents` / `queued` 永远只描述智能体。

```ts
type DocumentParseStatus = 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';

interface DocumentParseWaiting {
  sessionId: string;
  agentDisplayName: string;
  fileName: string;
}

interface DocumentParseSnapshot {
  status: DocumentParseStatus;
  fileName?: string;
  agentDisplayName?: string;
  page?: number;
  total?: number;
  idleRemainingSec?: number;
  waiting: DocumentParseWaiting[];
  circuitOpen?: boolean;
}
```

推送：独立事件 `document-parse`（与 `runtime-pool` 并列），进度每页推一次。Renderer 订阅，**不轮询**。`getDocumentParse()` IPC 供抽屉打开时拉一次。

一期不实现通用 `kind: 'agent-slot' | 'document-parse'` 联合列表。以后加能力再加一块业务名。

### 底栏

现网已写 `运行 {active}/{max} · {queued} 排队`（含 `0 排队`）。保持。

当快照 `status` 为 `starting` 或 `parsing` 时追加 ` · 文档解析进行中`。不要把解析等待人数写进 `1/4`。

智能体按钮文案仍是「释放线程」。文档解析按钮是「释放」/「停止解析」。不要把智能体按钮改名。

### 抽屉

在现有列表外包一层标题 **智能体**，其下仍是「运行中 / 排队中」现有行。下面另起 **文档解析**：一行状态 + 可选「等待中的文件」。

| 内部 | 用户可见 |
| --- | --- |
| `stopped` | 未启动 |
| `starting` | 正在加载 |
| `parsing` | 正在解析 · {智能体名} · {文件名} · 第 n/m 页 |
| `idle` | 空闲 · {剩余}后释放 |
| `resident` | 常驻 |

`starting`：提供「取消加载」（杀未就绪进程，当前 `document.read` 失败）。`stopped`：无「启动」。

确认框：「确认停止这次文档解析？智能体会收到失败结果。」 / 「确认释放文档解析？下次扫描文件会重新加载。」

报错 `source`：`文档解析`。

---

## 设置：「文档解析」分组

与「知识库」同级。不要塞进「智能体与运行」。

保存走 **`saveDocumentParseSettings`**（类似 `saveRagSettings`）。`sparkii:saveSettings` 必须 `{ ...prev, ...rest, rag: prev.rag, documentParse: prev.documentParse }`，防止大模型设置页冲掉。

| 项 | 存储 | 默认 |
| --- | --- | --- |
| 空闲后释放 | `documentParse.idleMinutes` | `5`（1–60；常驻时禁用） |
| 保持常驻 | `documentParse.keepResident` | `false` |
| 模块 | 磁盘 | 基础=已随包，不可卸载 |

模块用户可见名：基础解析 / 印章 / 公式 / 图表（说明同一期 v1）。

另加按钮 **重新加载**：清启动熔断；若进程在 `stopped` 不主动 spawn（下次 `document.read` 再拉）。下载/导入进度在设置页。失败：「网络不可达，请改用导入离线包。」

设置页可只读一行「当前：未启动 / 正在解析」，操作仍以运行中心为准。

「智能体与运行」加一句：并行上限只约束智能体，不约束文档解析。常驻开关旁提示大约 1 GB+ 内存。

---

## 识别质量

### 分数

- 仅 `engine === 'structure'`。
- 页分 = 该页识别分均值。整份 = 各页等权平均（空页不计）。
- 高 `>= 0.85`；中 `[0.70, 0.85)`；低 `< 0.70`。百分数 `Math.round(score * 100)`。
- native：不显示识别质量，不显示 100%。需要区分时写「电子文本」。

### 落点（锁定，不要第三条气泡）

1. **合同（及任何 workflow load）：** `extractWorkflowResult(entries).load` 即 `ParsedDocument`。原文侧标题附近读 `load.meta.quality`。不新增 custom JSONL 类型。
2. **聊天：** 质量在 `document.read` 的 toolResult `data.meta.quality`。`shouldShowEntry`：当工具为 `document.read` 且 `data.engine === 'structure'` 时，**简洁模式也显示**一条紧凑条（文件名 + 识别质量 中 · 78%），不展开全文 Markdown。`standard`/`debug` 可显示工具卡 + 同一条质量。不要新气泡，不改 assistant `text`。
3. **运行中心：** 不显示分数。

低质量文案：「部分文字可能不准确，请对照原文。」不阻止继续，不是审批门，不 abort。

---

## 失败与审计

| 情况 | 行为 |
| --- | --- |
| 基础程序或 baseline 未就绪 | 失败：「文档解析尚未就绪，请到设置 → 文档解析查看。」 |
| 磁盘不足 | 失败：「磁盘空间不足，无法准备文档解析。」 |
| spawn/OOM | 失败：「内存不足或文档解析无法启动，请到设置 → 文档解析查看。」 |
| 可选模块未装 | 跳过，`skippedModules`；整次成功 |
| 崩溃 | 该次失败；来源「文档解析」 |
| 用户停止 / 会话释放 / 退出 | 「文档解析已停止。」 |
| 不支持扩展名 | `CONNECTOR_UNSUPPORTED` |
| native I/O | `CONNECTOR_IO`，不启动解析进程 |

审计 `tool.read`：文件名、`engine`、页数、整份 `score`、skipped。不记全文，不记模型路径。

---

## 与现有产品的关系

- **知识库：** 不动。解析结果不自动入库。
- **合同审核切 SparkiiRAG：** 不在本规格。
- **聊天贴图：** 维持视觉模型路径。
- **08-31 运行时：** 只新增 `runtime/document-parse\`，不改 Portable Git / fd / rg。
- **「释放线程」：** 智能体用语保留。

---

## Copy rules（用户可见）

允许：运行中心、智能体、文档解析、未启动、正在加载、正在解析、空闲、常驻、释放、停止解析、取消加载、重新加载、识别质量、电子文本、基础解析、印章、公式、图表、导入离线包、等待中的文件。

禁止出现在窗口、设置、底栏、错误 toast、确认框：worker、sidecar、OCR 引擎、OC2、PP-Structure、Paddle、JSON-RPC、Python、模型文件名。

智能体操作按钮保持「停止」「释放线程」。不要改成「释放」以免和文档解析那一行混淆。

代码、日志、规格内部可用 `document-parse-worker`、`engine: 'structure'`。

---

## Testing notes（规格级）

- `shouldUseStructure`：空 PDF、短文字层、乱码、正常电子 PDF、jpg、docx — 不启动 Paddle。
- 生命周期：假进程。首次 structure 才 spawn；空闲到点杀树；在飞不杀；常驻不杀；宽限期内取消定时器；quit 先失败等待者。
- `executeDocumentRead` 被 `handleConnectorRead` 与 `runTool` 共用；只接一条则测试失败。
- 运行中心 / 底栏：解析中 `active` 不变；出现「文档解析进行中」；文案无 worker。
- 识别质量：0.70 / 0.85 边界；native 无质量条；简洁模式仍见 structure 质量条。
- 合同选择器含 jpg；预览 image kind。
- `saveSettings` 不冲掉 `documentParse`。
- 真实 Paddle 集成测试默认 skip（无模型的 CI）。
