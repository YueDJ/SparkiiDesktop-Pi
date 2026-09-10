# document-parse

NDJSON process that Desktop Main `spawn`s for scanned PDFs and photos.

Protocol (stdout is JSON lines **only**; logs go to stderr):

```text
→ {"id":"1","method":"parse","params":{"path":"...","modules":["baseline"]}}
← {"id":"1","method":"progress","params":{"page":1,"total":1}}
← {"id":"1","result":{"markdown":"...","pages":[{"page":1,"score":0.91}]}}
→ {"id":"2","method":"shutdown"}
```

Error: `{"id":"1","error":{"code":"PARSE_FAILED","message":"..."}}`

## FAKE mode (tests / local dev only)

```bash
SPARKII_DOCUMENT_PARSE_FAKE=1 PYTHONPATH=packages/document-parse python3 -m sparkii_document_parse
```

- `SPARKII_DOCUMENT_PARSE_FAKE=1` **must not** be set in the packaged Windows binary or installer.
- FAKE never imports `paddleocr` / `paddlex`.
- Do **not** ship FAKE as `sparkii-document-parse.exe`. Do **not** put this Python tree into `electron-builder.yml` `extraResources`.

## Real Structure (optional)

- Engine: PP-StructureV3 with **PP-OCRv5_server** (det + rec). `ocr_version` is `v5`. **Never pass v6.**
- If unset, the process sets `PADDLE_PDX_MODEL_SOURCE=bos` (Baidu Bos, not HuggingFace).
- Models directory: `SPARKII_DOCUMENT_PARSE_MODELS` (Desktop layout: `runtime/document-parse/models`).
- Real Paddle tests stay skipped unless `SPARKII_DOCUMENT_PARSE_E2E` is set:

```bash
python3 -m unittest packages/document-parse/tests/test_loop.py
```

## Building `sparkii-document-parse.7z.exe` later

This is a **release gate after** the NDJSON entry is stable. Do not add installer wiring until the archive exists **and** `checksums.json` has a real 64-character sha256.

On a Windows x64 CPU build machine (no CUDA):

1. Install PaddlePaddle CPU + PaddleOCR **3.7** / PaddleX **3.7** (pin versions in the build log).
2. Freeze this package as `bin/sparkii-document-parse.exe` (PyInstaller onedir or equivalent). The entry is `python -m sparkii_document_parse` with **FAKE unset**.
3. Copy baseline models next to the exe layout so extract yields:

   ```text
   bin/sparkii-document-parse.exe
   models/baseline/READY
   models/baseline/   # PP-DocLayout, PP-OCRv5_server det/rec, tables, …
   licenses/
   ```

4. Pack a 7-Zip SFX (same pattern as `portable-git.7z.exe`):

   ```text
   7z a -sfx7zCon.sfx sparkii-document-parse.7z.exe bin models licenses
   ```

5. Place the SFX at `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`.
6. Write the archive sha256 into `apps/desktop/runtime/document-parse/checksums.json` as `archive` (64 hex chars). **No `REPLACE_*` placeholders.**

### extraResources / NSIS — only after a real hash

`electron-builder.yml` `extraResources` and NSIS `customInstall` `ExecWait` for this archive are **forbidden** until:

- `checksums.json` `archive` is a real 64-character sha256, **and**
- `sparkii-document-parse.7z.exe` is on disk under `apps/desktop/runtime/document-parse/`.

Adding `extraResources` before that makes `pnpm dist` fail (missing file). AppX does not run NSIS; it relies on `ensureDocumentParse`. FAKE must not be packaged into extraResources.

Until that gate, `ensure-document-parse.mjs` skips when the archive is absent so `pnpm dist` stays green.
