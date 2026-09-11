# 文档解析快路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 能选中字的 6 页合同 ≤ 10 s 走文字层；默认解析归档 ≤ 100 MB；真纯图走 RapidOCR + ONNX Runtime + PP-OCRv6 small。

**Architecture:** Main 用 `probePdf` + `shouldUseStructure` 决定 native 或认字。认字仍 `spawn sparkii-document-parse.exe`，NDJSON 的 `progress` 仍是 `{page, total}`。进程改为 RapidOCR 3.9，模型只从 `SPARKII_DOCUMENT_PARSE_MODELS/baseline/` 读。1.8 GB 包退出默认安装，ensure 只接受 checksums 匹配的轻量 SFX。

**Tech Stack:** pdfjs-dist、RapidOCR ≥ 3.9 `<4`、ONNX Runtime CPU、pypdfium2、现有 supervisor。

**Spec:** `docs/superpowers/specs/2026-09-11-document-parse-fast-path-design.md`

## Global Constraints

- 用户可见禁止：worker、sidecar、OCR 引擎、OC2、PP-Structure、Paddle、ONNX、Rapid、JSON-RPC、Python、模型文件名。
- 用户可见允许：文档解析、电子文本、基础解析、正在解析、识别质量。
- Windows x64 CPU only。禁止 GPU / CUDA / cuDNN / `onnxruntime-gpu` 进默认包。
- 认字栈：RapidOCR ≥ 3.9, `<4` + ONNX Runtime CPU + PP-OCRv6 small + 现成 cls。不要 tiny / medium / Paddle 运行时 / 视觉大模型。
- RapidOCR 3.9 返回 `RapidOCROutput`（`txts` / `scores`）。不要按 1.x 元组解析。
- `progress.params` 只有 `{page, total}`。不要引入 `current`。不要改 `document-parse-rpc.ts` 的 `ParseProgress`。
- `engine` 走认字时仍为 `'structure'`。
- `SPARKII_DOCUMENT_PARSE_FAKE=1` 不得打进发布 exe。Supervisor 继续剥掉它。
- 运行时禁止下载模型。三个 ONNX 只在 `models/baseline/`。
- 生产构建机拉模型可用 ModelScope / Bos。禁止 huggingface.co。
- 不要 git-add SFX。`checksums.json` 必须是真实 64 hex。
- 每任务 TDD。Commit 仅当用户要求。

## File map

- `packages/connectors/src/document/route.ts`
- `packages/connectors/src/document/native-markdown.ts`
- `packages/connectors/test/document-route.test.ts`
- `packages/connectors/test/probe-pdf.test.ts` — 仅 throw 用例；pdfjs mock 只放此文件
- `packages/connectors/test/probe-pdf-empty.test.ts` — 成功空层（不要和 throw 文件共用 pdfjs mock）
- `apps/desktop/electron/main/document-read.ts`
- `apps/desktop/test/document-read.test.ts`
- `packages/document-parse/sparkii_document_parse/light_ocr.py` — 新建
- `packages/document-parse/sparkii_document_parse/loop.py` — 换芯；删除 Paddle / forbid-v6 符号
- `packages/document-parse/sparkii_document_parse/__init__.py`
- `packages/document-parse/tests/test_loop.py` — 重写，删除 Structure/Paddle/v6-forbid 套件
- `packages/document-parse/README.md`
- `packages/document-parse/requirements-light.txt`
- `apps/desktop/electron/main/document-parse-supervisor.ts`
- `apps/desktop/test/document-parse-supervisor.test.ts`
- `apps/desktop/electron/main/document-parse-layout.ts`
- `apps/desktop/scripts/ensure-document-parse.mjs` — 去掉未校验的兄弟路径拷贝
- `apps/desktop/runtime/document-parse/README.md` / `checksums.json`

`parsePdf`（`packages/connectors/src/document/index.ts`）不是探测路径，本期不改。

---

### Task 1: 放宽可用文字层阈值，空层与 pageCount<=0 走认字

**Files:**
- Modify: `packages/connectors/src/document/route.ts`
- Test: `packages/connectors/test/document-route.test.ts`

**Interfaces:**
- Consumes: `shouldUseStructure({ ext: string; textLayer: string | null; pageCount: number })`
- Produces: 仅当 `pageCount > 0` 且去空白长度 ≥ `20 * pageCount` 且乱码比 ≤ 0.30 时对 PDF 返回 `false`。`textLayer === ''` 或 `pageCount <= 0` 返回 `true`。

- [ ] **Step 1: Write the failing tests**

```ts
  it('routes empty or short or garbled pdfs to structure', () => {
    expect(shouldUseStructure({ ext: '.pdf', textLayer: null, pageCount: 3 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '', pageCount: 3 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '', pageCount: 0 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: 'a'.repeat(19 * 2), pageCount: 2 })).toBe(true);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: '\uFFFD'.repeat(40) + 'ok'.repeat(10), pageCount: 1 })).toBe(true);
  });

  it('keeps a six-page selectable contract native', () => {
    const page = '甲方应当在本合同生效后十个工作日内支付预付款。'.repeat(2);
    expect(shouldUseStructure({
      ext: '.pdf',
      textLayer: Array.from({ length: 6 }, () => page).join('\n'),
      pageCount: 6,
    })).toBe(false);
  });

  it('treats a short-but-usable chinese page as native', () => {
    const layer = '技术服务合同编号HT-2026-0911-008甲方星火工业';
    expect(layer.replace(/\s/g, '').length).toBeGreaterThanOrEqual(20);
    expect(layer.replace(/\s/g, '').length).toBeLessThan(50);
    expect(shouldUseStructure({ ext: '.pdf', textLayer: layer, pageCount: 1 })).toBe(false);
  });
```

保留 office / photo / dense electronic 现有断言。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/connectors exec vitest run test/document-route.test.ts`  
Expected: FAIL on `treats a short-but-usable chinese page as native`（阈值仍为 50）。`pageCount: 0` 在旧逻辑下也可能 FAIL（`20 * 0` 让空串变成 native）。

- [ ] **Step 3: Write minimal implementation**

```ts
const MIN_CHARS_PER_PAGE = 20;

  if (input.textLayer === null) return true;
  if (input.pageCount <= 0) return true;
  const stripped = input.textLayer.replace(/\s/g, '');
  if (stripped.length < MIN_CHARS_PER_PAGE * input.pageCount) return true;
```

`GARBLED_RATIO_THRESHOLD` 保持 `0.30`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sparkii/connectors exec vitest run test/document-route.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求）

```bash
git add packages/connectors/src/document/route.ts packages/connectors/test/document-route.test.ts
git commit -m "fix: treat short but usable PDF text layers as electronic text"
```

---

### Task 2: `probePdf` 按契约区分成功空层与失败

**Files:**
- Modify: `packages/connectors/src/document/native-markdown.ts`
- Create: `packages/connectors/test/probe-pdf.test.ts`（只测 throw；`vi.mock` 只在此文件）
- Create: `packages/connectors/test/probe-pdf-empty.test.ts`（成功空层；不要 mock 成 reject）

**Interfaces:**
- Consumes: `probePdf(path: string)`
- Produces: `{ textLayer: string; pageCount: number; pages: string[] }`。成功无字：`textLayer === ''`。失败：抛 `ConnectorError('CONNECTOR_IO', '无法读取该文件。')`。永不返回 `{ textLayer: null, pageCount: 0 }`。

- [ ] **Step 1: Write the failing tests**

`probe-pdf.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.reject(new Error('Invalid PDF structure')),
  }),
}));

import { probePdf } from '../src/document/native-markdown.js';
import { ConnectorError } from '../src/types.js';

describe('probePdf failure', () => {
  it('throws ConnectorError instead of faking an empty text layer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'probe-'));
    const path = join(dir, 'a.pdf');
    await writeFile(path, '%PDF-1.4 fake');
    await expect(probePdf(path)).rejects.toBeInstanceOf(ConnectorError);
    await expect(probePdf(path)).rejects.toMatchObject({
      code: 'CONNECTOR_IO',
      message: '无法读取该文件。',
    });
  });
});
```

不要断言 `name: 'Error'`（`ConnectorError.name` 是 `ConnectorError`）。

`probe-pdf-empty.test.ts`：用 `vi.mock` 返回 `numPages: 2`、`getTextContent` 空 items：

```ts
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
      }),
    }),
  }),
}));
```

断言 `{ textLayer: '', pageCount: 2, pages: ['', ''] }`，且 `textLayer !== null`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/connectors exec vitest run test/probe-pdf.test.ts test/probe-pdf-empty.test.ts`  
Expected: FAIL（当前 catch 返回 `{ textLayer: null, pageCount: 0 }`；`pages.length === 0` 也曾返回 null）

- [ ] **Step 3: Write minimal implementation**

```ts
export async function probePdf(path: string): Promise<{
  textLayer: string;
  pageCount: number;
  pages: string[];
}> {
  try {
    const buf = await readFile(path);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await getDocument({
      data: new Uint8Array(buf),
      disableWorker: true,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
    }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: { str?: string }) => String(it.str ?? '')).join(' '));
    }
    return { textLayer: pages.join('\n'), pageCount: doc.numPages, pages };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError('CONNECTOR_IO', '无法读取该文件。');
  }
}
```

不要 `await` `@napi-rs/canvas`。不要把这两个测试的 mock 抽到 `setup.ts`。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/connectors exec vitest run test/probe-pdf.test.ts test/probe-pdf-empty.test.ts test/document-route.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求）

```bash
git add packages/connectors/src/document/native-markdown.ts packages/connectors/test/probe-pdf.test.ts packages/connectors/test/probe-pdf-empty.test.ts
git commit -m "fix: distinguish PDF probe failure from an empty text layer"
```

---

### Task 3: `executeDocumentRead` 只在抽字失败或不可用时 enqueue

**Files:**
- Modify: `apps/desktop/electron/main/document-read.ts`
- Test: `apps/desktop/test/document-read.test.ts`

**Interfaces:**
- Consumes: Task 1 / Task 2
- Produces: 够用文字层 → `engine: 'native'`，不 enqueue。`probePdf` throw → `textLayer = null`，`pageCount = 0`，enqueue **不带** `total`。Worker 自己数页。

- [ ] **Step 1: Write the failing tests**

把 `routes a short text-layer pdf to structure` 的 mock 改成：

```ts
      probePdf: async () => ({ textLayer: 'a'.repeat(5), pageCount: 2, pages: ['aaaaa', ''] }),
```

新增：

```ts
  it('uses native text for a six-page selectable contract without enqueueParse', async () => {
    const page = '甲方应当在本合同生效后十个工作日内支付预付款。';
    const enqueueParse = vi.fn();
    const out = await executeDocumentRead({ documents: ['/tmp/contract.pdf'] }, ctx, {
      enqueueParse,
      probePdf: async () => ({
        textLayer: Array.from({ length: 6 }, () => page).join('\n'),
        pageCount: 6,
        pages: Array.from({ length: 6 }, () => page),
      }),
    });
    expect(enqueueParse).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect((out.data as { engine: string }).engine).toBe('native');
  });

  it('falls back to parse without a stale total when probePdf throws', async () => {
    const enqueueParse = vi.fn(async () => ({ markdown: '# scan', pages: [{ page: 1, score: 0.8 }] }));
    const out = await executeDocumentRead({ documents: ['/tmp/x.pdf'] }, ctx, {
      enqueueParse,
      needsDocumentParse: () => false,
      ensureDocumentParse: async () => {},
      diskFreeBytes: async () => 10 * 1024 ** 3,
      probePdf: async () => { throw new Error('无法读取该文件。'); },
    });
    expect(enqueueParse).toHaveBeenCalledTimes(1);
    expect(enqueueParse.mock.calls[0][0].total).toBeUndefined();
    expect(out.ok).toBe(true);
    expect((out.data as { engine: string }).engine).toBe('structure');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-read.test.ts`  
Expected: throw 路径若被外层 `connectorFail` 吃掉、或不 enqueue，则 FAIL。

- [ ] **Step 3: Write minimal implementation**

`ProbePdfResult.textLayer` 改为 `string`。

```ts
    if (ext === '.pdf') {
      try {
        probed = await probePdf(path);
        textLayer = probed.textLayer;
        pageCount = probed.pageCount || 0;
      } catch {
        textLayer = null;
        pageCount = 0;
      }
    }
```

enqueue 时仅 `pageCount > 0` 才传 `total`（现有逻辑可保留）。throw 后 `pageCount === 0` → 省略 `total`。

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-read.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求）

```bash
git add apps/desktop/electron/main/document-read.ts apps/desktop/test/document-read.test.ts
git commit -m "fix: skip document parse when a PDF text layer is usable"
```

---

### Task 4: 轻量识别进程（RapidOCR 3.9 + PP-OCRv6 small）

**Files:**
- Create: `packages/document-parse/sparkii_document_parse/light_ocr.py`
- Create: `packages/document-parse/requirements-light.txt`
- Modify: `packages/document-parse/sparkii_document_parse/loop.py`
- Modify: `packages/document-parse/sparkii_document_parse/__init__.py`
- Modify: `packages/document-parse/README.md`
- Rewrite: `packages/document-parse/tests/test_loop.py`（删除 Structure/Paddle/v6-forbid 套件）
- Modify: `apps/desktop/electron/main/document-parse-supervisor.ts`
- Test: `apps/desktop/test/document-parse-supervisor.test.ts`

**Interfaces:**
- Consumes: NDJSON `parse` `{ path: string; modules?: string[]; total?: number }`。`total` 只是 hint；PDF 以 `len(doc)` 为准。
- Produces: `progress.params = {page, total}`；`result.markdown`；`result.pages[].score`
- `create_ocr()`：单例；缺 ONNX 抛错，不下载
- `lines_from_ocr(out) -> list[tuple[str, float]]`：读 `out.txts` / `out.scores`

**Delete from default path (do not keep “for FAKE”):**  
`structure_kwargs`、`_assert_ocr_version_not_v6`、`FORBIDDEN_OCR_VERSIONS`、`OCR_VERSION`、`DET_MODEL`、`REC_MODEL`、`load_structure_class`、`instantiate_structure`、Paddle `extract_markdown` / `extract_score`、`MODEL_SOURCE_ENV` / `PADDLE_PDX_CACHE_HOME`。FAKE 只留 `handle_parse_fake`。Grep 默认路径不得再出现 `Never pass v6`、`PP-OCRv5_server`、`PPStructureV3`。

- [ ] **Step 1: Write the failing tests**

在重写后的 `test_loop.py`：

```python
class FakeOcr:
    def __call__(self, img):
        class Out:
            txts = ("合同编号",)
            scores = (0.99,)
        return Out()

class LightOcrTests(unittest.TestCase):
    def test_light_ocr_emits_page_progress_then_markdown(self):
        reset_pipeline_cache_for_tests()
        stdin = io.StringIO(
            '{"id":"1","method":"parse","params":{"path":"/tmp/a.png","modules":["baseline"],"total":1}}\n'
        )
        stdout = io.StringIO()
        with mock.patch("sparkii_document_parse.light_ocr.create_ocr", return_value=FakeOcr()):
            os.environ.pop("SPARKII_DOCUMENT_PARSE_FAKE", None)
            run_loop(stdin, stdout, io.StringIO())
        frames = parse_stdout_lines(stdout.getvalue())
        self.assertEqual(frames[0]["method"], "progress")
        self.assertEqual(frames[0]["params"], {"page": 1, "total": 1})
        self.assertNotIn("current", frames[0]["params"])
        self.assertIn("合同编号", frames[-1]["result"]["markdown"])
        self.assertAlmostEqual(frames[-1]["result"]["pages"][0]["score"], 0.99)

    def test_create_ocr_locks_offline_v6_small_paths(self):
        os.environ["SPARKII_DOCUMENT_PARSE_MODELS"] = r"C:\models"
        captured = {}
        def fake_ctor(**kwargs):
            captured.update(kwargs.get("params") or {})
            return FakeOcr()
        with mock.patch("sparkii_document_parse.light_ocr.RapidOCR", side_effect=fake_ctor):
            from sparkii_document_parse import light_ocr
            light_ocr.reset_ocr_for_tests()
            light_ocr.create_ocr()
        self.assertEqual(captured["Det.ocr_version"], "PP-OCRv6")
        self.assertEqual(captured["Det.model_type"], "small")
        self.assertEqual(captured["Rec.ocr_version"], "PP-OCRv6")
        self.assertEqual(captured["Rec.model_type"], "small")
        self.assertEqual(captured["Det.engine_type"], "onnxruntime")
        self.assertTrue(str(captured["Det.model_path"]).endswith("PP-OCRv6_det_small.onnx"))
        self.assertTrue(str(captured["Rec.model_path"]).endswith("PP-OCRv6_rec_small.onnx"))
        self.assertTrue(str(captured["Cls.model_path"]).endswith("ch_ppocr_mobile_v2.0_cls_mobile.onnx"))
```

保留现有 FAKE NDJSON 测试（`page`/`total`，不要改成 `current`）。删除 `StructureKwargsTests`、`StreamingParseTests` 对 `load_structure_class` 的补丁、`MissingPaddleTests`、`RealPaddleTests`、`test_never_passes_ocr_version_v6`。`RuntimeEnvTests` 里依赖 Paddle `overall_ocr_res` 的提取测试删除或改成 `lines_from_ocr`。

Supervisor：断言 spawn env **没有**被写入 `PADDLE_PDX_MODEL_SOURCE`；仍剥 `FAKE`；仍设 `SPARKII_DOCUMENT_PARSE_MODELS`。

- [ ] **Step 2: Run tests to verify they fail**

Run（在包目录）：

```
cd packages/document-parse
python -m unittest tests.test_loop.LightOcrTests -v
```

Expected: FAIL（无 `light_ocr` 模块）

- [ ] **Step 3: Write minimal implementation**

`requirements-light.txt`：

```
rapidocr>=3.9.0,<4
onnxruntime
pypdfium2
```

不要写 `paddlepaddle`、`paddleocr`、`opencv-python`、`onnxruntime-gpu`。

`light_ocr.py`：

```python
import os
from pathlib import Path
from rapidocr import RapidOCR

MODELS_ENV = "SPARKII_DOCUMENT_PARSE_MODELS"
DET_NAME = "PP-OCRv6_det_small.onnx"
REC_NAME = "PP-OCRv6_rec_small.onnx"
CLS_NAME = "ch_ppocr_mobile_v2.0_cls_mobile.onnx"

_ocr = None

def _baseline_dir() -> Path:
    root = os.environ.get(MODELS_ENV)
    if not root:
        raise FileNotFoundError("SPARKII_DOCUMENT_PARSE_MODELS is not set")
    return Path(root) / "baseline"

def _require(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return str(path)

def create_ocr():
    global _ocr
    if _ocr is None:
        base = _baseline_dir()
        _ocr = RapidOCR(params={
            "Det.engine_type": "onnxruntime",
            "Det.ocr_version": "PP-OCRv6",
            "Det.model_type": "small",
            "Det.model_path": _require(base / DET_NAME),
            "Rec.engine_type": "onnxruntime",
            "Rec.ocr_version": "PP-OCRv6",
            "Rec.model_type": "small",
            "Rec.model_path": _require(base / REC_NAME),
            "Cls.engine_type": "onnxruntime",
            "Cls.model_path": _require(base / CLS_NAME),
        })
    return _ocr

def reset_ocr_for_tests():
    global _ocr
    _ocr = None

def lines_from_ocr(out):
    txts = list(getattr(out, "txts", None) or ())
    scores = list(getattr(out, "scores", None) or ())
    return list(zip(txts, scores))

def pdf_to_images(path: str):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path)
    images = []
    try:
        for i in range(len(doc)):
            page = doc[i]
            try:
                images.append(page.render(scale=2).to_pil())
            finally:
                page.close()
    finally:
        doc.close()
    return images
```

`loop.py`：`handle_parse_real` 走 `create_ocr`。图片 1 页；PDF 用 `pdf_to_images`，`total = len(images)`（忽略过期 hint）。每页 `{"page": i, "total": total}`。Markdown `# 第 n 页` + `txts`。`score` 为 `scores` 平均。`configure_runtime_env` 只设 `OMP/MKL/OPENBLAS` 线程上限。`get_pipeline` → `create_ocr()`；`reset_pipeline_cache_for_tests` 调 `reset_ocr_for_tests()`。

`__init__.py` / `packages/document-parse/README.md`：改成 RapidOCR + v6 small + 离线 `models/baseline`，删掉「ocr_version is v5 / Never pass v6 / PP-StructureV3 / Paddle 3.7 freeze」。

Supervisor `spawnEnv`：删除默认 `PADDLE_PDX_MODEL_SOURCE = 'bos'`。保留剥 `FAKE` 与默认 `SPARKII_DOCUMENT_PARSE_MODELS`。

- [ ] **Step 4: Run tests**

```
cd packages/document-parse
python -m unittest tests.test_loop -v
```

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-parse-supervisor.test.ts`  
Expected: PASS。仓库内 `Never pass v6` / `PP-OCRv5_server` / `PPStructureV3` 不得再出现在默认路径源码（测试夹具除外）。

- [ ] **Step 5: Commit**（仅当用户要求）

```bash
git add packages/document-parse apps/desktop/electron/main/document-parse-supervisor.ts apps/desktop/test/document-parse-supervisor.test.ts
git commit -m "feat: run document parse on RapidOCR PP-OCRv6 small"
```

---

### Task 5: 轻量归档 + 堵住 1.8GB 误拷

**Files:**
- Modify: `apps/desktop/scripts/ensure-document-parse.mjs`
- Modify: `apps/desktop/test/document-parse-layout.test.ts` 与现有 ensure/provision 测试
- Modify: `apps/desktop/runtime/document-parse/README.md`
- Modify: `apps/desktop/runtime/document-parse/checksums.json`（打出真实轻量包后写真实 64 hex）

**Interfaces:**
- Consumes: 冻结出的 `bin/` + `models/baseline/{READY,三个onnx}` + `licenses/`
- Produces: SFX ≤ 100 MB；`checksums.json.archive` = 该文件 sha256。ensure **只**接受：`SPARKII_DOCUMENT_PARSE_ARCHIVE`（若设则必须存在且哈希对）或 `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`（哈希对）。删除 `join(repoRoot, '..', ARCHIVE_NAME)` 与 `../sparkii-document-parse-dist/...` 候选。

- [ ] **Step 1: Write the failing tests**

```ts
  it('keeps the default archive under 100 MiB when present', () => {
    const archive = join(desktopRoot, 'runtime/document-parse', DOCUMENT_PARSE_ARCHIVE_NAME);
    if (!existsSync(archive)) return;
    expect(statSync(archive).size).toBeLessThanOrEqual(100 * 1024 * 1024);
  });
```

给 ensure 脚本加/改测试：设置 `SPARKII_DOCUMENT_PARSE_ARCHIVE` 指向一个哈希不对的文件时必须失败；仓库兄弟路径即使存在 1.8GB 同名文件也不得被选中。把现有「为隔离 git 测试而把 ARCHIVE 指到缺失路径」的用例留下。

- [ ] **Step 2: Run test**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-parse-layout.test.ts test/runtime-provision.test.ts`  
Expected: 本机仍是 1.8 GB SFX 则 size 断言 FAIL

- [ ] **Step 3: Freeze, pack, close fallbacks**

独立 venv，只装 `requirements-light.txt` + `pyinstaller`。`--onedir --console`。collect `rapidocr` / `onnxruntime` / `pypdfium2` 的 data+binaries。排除 OpenVINO、CUDA、`onnxruntime-gpu`、`opencv-python`、paddle。不要 `--collect-all paddle`。ONNX **只**复制进 `models/baseline/`，不要让 PyInstaller 再打一份。

从 ModelScope RapidAI/RapidOCR 拉三个锁定文件名。禁止 HuggingFace。

写入 `checksums.json` 前：

```
if ((Get-Item sparkii-document-parse.7z.exe).Length -gt 104857600) { throw 'archive > 100MB' }
```

并确认冻结目录 / spec / 启动脚本没有 `SPARKII_DOCUMENT_PARSE_FAKE=1`。

`ensure-document-parse.mjs`：候选列表只保留 env 与 `runtime/document-parse/` 下的归档；拷贝或解压前校验 sha256。

README（runtime + package）只写内部布局。移走构建机上旧 1.8 GB 同名文件，避免人手误用；控制面是 checksum，不是「记得搬走」。

- [ ] **Step 4: Smoke + tests**

`node apps/desktop/scripts/ensure-document-parse.mjs`  
对 `D:\tmp\scan.png` 发 NDJSON `parse`：须有 `{page,total}` 的 `progress` 与非空 markdown。壳环境未设 FAKE。

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-parse-layout.test.ts test/runtime-provision.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求；不要 git-add SFX）

```bash
git add apps/desktop/scripts/ensure-document-parse.mjs apps/desktop/test apps/desktop/runtime/document-parse/checksums.json apps/desktop/runtime/document-parse/README.md packages/document-parse/README.md
git commit -m "build: ship a checksummed sub-100MB document-parse archive"
```

---

### Task 6: 磁盘门槛改为 512 MB

**Files:**
- Modify: `apps/desktop/electron/main/document-parse-layout.ts`
- Test: `apps/desktop/test/document-read.test.ts`

**Interfaces:**
- Consumes: `MIN_DOCUMENT_PARSE_DISK_BYTES`
- Produces: `512 * 1024 ** 2`。文案仍是「磁盘空间不足，无法准备文档解析。」

- [ ] **Step 1: Write the failing tests**

把「fails with 磁盘空间不足 when diskFreeBytes is under 2GB」改名为 under 512MB，mock `400 * 1024 ** 2`，断言该文案。

不要再用 `1024 ** 3`（1 GB）当「磁盘不足」：门槛降到 512 MB 后 1 GB 会变成「尚未就绪」或成功。

另加：`diskFreeBytes: async () => 600 * 1024 ** 2` + `needsDocumentParse: () => false` 的 native 路径不因磁盘失败。`600 MB` + `needs: true` **不是**磁盘不足（可能是 NOT_READY）。

- [ ] **Step 2: Run test**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-read.test.ts -t "磁盘"`  
Expected: 旧 2GB 门槛下，若只改了测试没改常量，400MB 仍会失败（过）；若有人留下 1GB 用例当磁盘不足，实现后会 FAIL——以本步骤的 400MB 为准。

- [ ] **Step 3: Implement**

```ts
export const MIN_DOCUMENT_PARSE_DISK_BYTES = 512 * 1024 ** 2;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @sparkii/desktop exec vitest run test/document-read.test.ts test/document-parse-layout.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**（仅当用户要求）

```bash
git add apps/desktop/electron/main/document-parse-layout.ts apps/desktop/test/document-read.test.ts
git commit -m "fix: lower document-parse disk floor to 512MB"
```

---

## Spec coverage

| 规格条款 | 任务 |
| --- | --- |
| 20 字/页、乱码 30%、空层 / pageCount<=0 走认字 | Task 1 |
| `probePdf` 成功空串 / 失败抛错 | Task 2 |
| throw → pageCount 0、省略 total；够用层不 enqueue | Task 3 |
| RapidOCR 3.9 Output、离线 model_path、`{page,total}`、pypdfium2 scale=2 | Task 4 |
| ≤100 MB、checksum 硬门、去掉兄弟路径误拷 | Task 5 |
| 磁盘 ≥ 512 MB | Task 6 |
| 不改 ParseProgress / engine 字面量 / 用户文案 | 全任务 |
| 删除 Paddle / forbid-v6 默认路径 | Task 4 |

## Placeholder scan

无 TBD。进度字段锁定 `{page, total}`。认字锁定 RapidOCR 3.9 + 三个绝对 ONNX 路径。
