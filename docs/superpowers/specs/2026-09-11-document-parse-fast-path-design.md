# 文档解析快路径 — Design Spec

**Date:** 2026-09-11  
**Status:** accepted  
**Supersedes:** `docs/superpowers/specs/2026-09-10-document-parse-design.md` 里所有引擎、模型、默认安装包、体积门槛相关条款。上一套「禁止 v6 / 只用 v5 server / 默认 PP-StructureV3 / 随包完整产线」**不再约束本方向**。

**仍沿用 09-10：** NDJSON 协议形状（`progress.params` 只有 `{page, total}`）、全应用一个解析进程、运行中心与底栏、设置页信息架构、`executeDocumentRead` 是唯一执行器、用户可见 copy rules（并补禁 ONNX / Rapid / 模型文件名）。不要改 `ParseProgress`。

## Goal

合同审核读一份能选中文字的 5–6 页 PDF，`document.read` 第一步在本机普通 Windows 上 **≤ 10 秒** 给出正文。默认安装里文档解析增量 **≤ 100 MB**。真纯图才走轻量认字。

## Locked stack

三层分开，不要混称：

| 层 | 锁定 | 不要 |
| --- | --- | --- |
| 文字层 | pdfjs-dist `getTextContent`（Main） | 把抽字失败伪装成「没有文字层」 |
| OCR 流程 | RapidOCR ≥ 3.9, `<4` | Paddle / NCNN / 系统 OCR / 视觉大模型 |
| 推理 | ONNX Runtime CPU，Windows x64 | GPU / CUDA / DirectML / OpenVINO 作为默认 |
| 权重 | PP-OCRv6 small | tiny / medium / v4 / v5 server |
| PDF 栅格 | pypdfium2（解析进程内），`scale=2`（约 144 DPI） | Poppler / pdf2image / Main 渲页图 |

RapidOCR ≥ 3 返回 `RapidOCROutput`（`txts` / `scores` / `boxes`），不是 1.x 的 `(box, text, score)` 元组列表。

锁定权重文件名（放在 `models/baseline/`，只此一份）：

- `PP-OCRv6_det_small.onnx`
- `PP-OCRv6_rec_small.onnx`
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx`（v6 无新 cls）

`create_ocr()` 必须读 `SPARKII_DOCUMENT_PARSE_MODELS`，把三个绝对路径传给 `Det.model_path` / `Rec.model_path` / `Cls.model_path`。缺文件 → `PARSE_FAILED`，stderr 记原因。**禁止运行时下载**（含 ModelScope / Bos / HuggingFace）。构建机拉模型只发生在打离线包时。

RapidOCR 初始化锁定：

```
Det.engine_type = onnxruntime
Det.ocr_version = PP-OCRv6
Det.model_type = small
Det.model_path = <MODELS>/baseline/PP-OCRv6_det_small.onnx
Rec.engine_type = onnxruntime
Rec.ocr_version = PP-OCRv6
Rec.model_type = small
Rec.model_path = <MODELS>/baseline/PP-OCRv6_rec_small.onnx
Cls.engine_type = onnxruntime
Cls.model_path = <MODELS>/baseline/ch_ppocr_mobile_v2.0_cls_mobile.onnx
```

进程内缓存已加载的识别器。同一进程第二次 `parse` 不得重新加载模型。PyInstaller 不得再 collect 一份 RapidOCR 自带 ONNX；模型只在 `models/baseline/`。

`SPARKII_DOCUMENT_PARSE_FAKE=1` 只用于测试。发布 exe / 冻结 spec / 启动环境都不得设置它。Supervisor 继续剥掉该变量。

## Routing

函数仍叫 `shouldUseStructure`。协议字段 `engine` 在走认字进程时仍为 `'structure'`。实现已不是 StructureV3。

| 输入 | `shouldUseStructure` | `engine` |
| --- | --- | --- |
| Office / txt / md / csv | false | `native` |
| jpg / jpeg / png | true | `structure` |
| PDF 文字层可用 | false | `native` |
| PDF `textLayer === ''`、过短、乱码、或 `pageCount <= 0` | true | `structure` |
| PDF `probePdf` 抛错 | 路由用 `textLayer = null`，`pageCount = 0` | 回退认字 |

**可用文字层：** `pageCount > 0`，去掉空白后长度 ≥ `20 * pageCount`，且 U+FFFD + 控制符比例 ≤ 0.30。中文按字符计。阅读器能选中正文的 6 页合同必须判可用。

`parsePdf` / `parseDocument` 不是本规格探测路径，本期不改。

### `probePdf` 契约

```ts
{ textLayer: string; pageCount: number; pages: string[] }
```

- 打开成功、抽字完成：`textLayer` 为拼接正文；全空则 `''`，**不是** `null`。`pageCount` 为 `doc.numPages`。
- 文件读失败、PDF 损坏、`getDocument` / `getPage` / `getTextContent` 因文档失败：抛 `ConnectorError('CONNECTOR_IO', '无法读取该文件。')`。
- **禁止**再 `catch` 后返回 `{ textLayer: null, pageCount: 0 }`。
- `@napi-rs/canvas` 缺失不得单独导致抽字失败。不要为消 warning 去 `await` 会抛的 canvas import。`getDocument` 使用 `{ data, disableWorker: true, isEvalSupported: false, disableFontFace: true, useSystemFonts: true }`。

`executeDocumentRead`：`.pdf` 包在 try 内。成功用返回的 `''` 或正文。只有 **throw** 才设 `textLayer = null` 且 `pageCount = 0`，**省略** parse job 的 `total`。Worker 用 pypdfium2 的页数当 `progress.total`，忽略过期 hint。

## Light process

Desktop 仍 `spawn` 全应用一个 `sparkii-document-parse.exe`。stdin/stdout NDJSON **形状不变**：

```
{"id":"1","method":"progress","params":{"page":3,"total":12}}
```

禁止改成 `current`。FAKE 也发 `{page, total}`。

- 图片：直接认。
- PDF：进程内 pypdfium2 按 `len(doc)` + `doc[i]` 逐页 `render(scale=2).to_pil()`，用完关闭 page/doc。
- 每页先 `progress`，全部完成后再一条 `result`。
- `result.markdown`：按页 `# 第 n 页` + `txts` 行。
- `result.pages[].score`：该页 `scores` 平均；没有行则 `0`。
- `modules` 可忽略；本期只有这一条认字路径。
- `SPARKII_DOCUMENT_PARSE_MODELS` 指向解压后的 `models`。不再依赖 `PADDLE_PDX_MODEL_SOURCE`。Supervisor 不再默认写入该变量。

默认路径删除 Paddle / Structure / 「Never pass v6」：`structure_kwargs`、`FORBIDDEN_OCR_VERSIONS`、`load_structure_class`、`instantiate_structure`、Paddle 形 `extract_*`。FAKE 只走 NDJSON，不调用这些符号。

日志、traceback 只走 stderr。stdout 只有 JSON 行。

## Packaging

- 文件名仍为 `sparkii-document-parse.7z.exe`（gitignore）+ `checksums.json`（64 hex）。
- 解压布局：`bin/sparkii-document-parse.exe`、`models/baseline/READY`（`ok`）、三个 ONNX 在 `models/baseline/`、`licenses/`。
- 归档体积 ≤ **100 MB**。写入 `checksums.json` 前必须 `Get-Item ...Length -le 104857600`。
- extraResources 仍指向同名 SFX，但 **唯一合法内容** 是轻量包：sha256 必须等于 `checksums.json`。`ensure-document-parse.mjs` 禁止从仓库兄弟路径（桌面 / `sparkii-document-parse-dist`）拷贝未校验的 SFX。缺文件或哈希不符 = 硬失败。
- 冻结：独立 venv；`rapidocr>=3.9.0,<4`；CPU 版 `onnxruntime`（不要 `onnxruntime-gpu`）；`pypdfium2`；不要 `opencv-python` / paddle / CUDA；`--onedir --console`；collect `rapidocr` + `onnxruntime` + `pypdfium2` 的 data/binaries，排除 OpenVINO/CUDA；不要 `--collect-all paddle`。冻结产物不得设置 FAKE。
- 磁盘门槛：需要准备解析时，可用空间 ≥ **512 MB**。文案仍是「磁盘空间不足，无法准备文档解析。」

印章 / 公式 / 图表 / 大号完整产线：本期不随包、不做按需下载。

## Acceptance

- 能选中字的 6 页合同：`document.read` ≤ 10 s，`engine: 'native'`，不调用 `enqueueParse`。
- 真纯图 6 页：`progress` 为 `page/total`（total 来自实际页数）；力争约 10 s，允许更慢，UI 不得假死。
- 默认归档存在时 ≤ 100 MB，且 sha256 与 `checksums.json` 一致。
- 发布 exe 未设置 FAKE。
- 窗口、设置、底栏、toast 不出现 OCR / Paddle / ONNX / Rapid / 模型文件名。

## Non-goals

- GPU / CUDA。
- 默认路径使用 tiny、medium、Paddle 运行时、视觉大模型。
- 用户切换模型档位。
- 承诺纯扫描 20 页稳定 < 10 s。
- 按页拆引擎。
- 改工具名或把 `engine: 'structure'` 改成新字面量。
- 改 `document-parse-rpc.ts` 的 `ParseProgress` 形状。

## Copy（用户可见）

允许：运行中心、智能体、文档解析、未启动、正在加载、正在解析、空闲、常驻、释放、停止解析、取消加载、重新加载、识别质量、电子文本、基础解析、印章、公式、图表、导入离线包、等待中的文件。

禁止：worker、sidecar、OCR 引擎、OC2、PP-Structure、Paddle、ONNX、Rapid、JSON-RPC、Python、模型文件名。

代码与日志内部可用 `document-parse-worker`、`engine: 'structure'`、RapidOCR、ONNX、PP-OCRv6。
