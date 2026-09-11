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
- FAKE is NDJSON-only: it never imports RapidOCR and never loads ONNX.
- Do **not** ship FAKE as `sparkii-document-parse.exe`. Do **not** put this Python tree into `electron-builder.yml` `extraResources`.

## Real path (RapidOCR + PP-OCRv6 small)

- Engine: RapidOCR `>=3.9,<4` with **PP-OCRv6 small** (det + rec) and the mobile cls ONNX. Inference is ONNX Runtime CPU.
- Models are offline under `SPARKII_DOCUMENT_PARSE_MODELS/baseline/`:
  - `PP-OCRv6_det_small.onnx`
  - `PP-OCRv6_rec_small.onnx`
  - `ch_ppocr_mobile_v2.0_cls_mobile.onnx`
- Missing ONNX files fail the parse. The process does **not** download weights at runtime.
- PDF pages are rasterized in-process with pypdfium2 (`scale=2`). `progress.params` is `{page, total}` only (`total` comes from the real page count).
- Pins live in `requirements-light.txt`. Do not add paddle / OpenCV / `onnxruntime-gpu`.

```bash
python3 -m unittest packages/document-parse/tests/test_loop.py
```

## Building `sparkii-document-parse.7z.exe`

The release archive is gitignored. A real 64-character sha256 must be in `apps/desktop/runtime/document-parse/checksums.json` before `pnpm dist`.

On a Windows x64 CPU build machine (no CUDA):

1. Install RapidOCR `>=3.9,<4`, CPU `onnxruntime`, and `pypdfium2` from `requirements-light.txt`.
2. Freeze this package as `bin/sparkii-document-parse.exe` (PyInstaller onedir or equivalent). The entry is `python -m sparkii_document_parse` with **FAKE unset**.
3. Copy baseline models next to the exe layout so extract yields:

   ```text
   bin/sparkii-document-parse.exe
   models/baseline/READY
   models/baseline/   # PP-OCRv6_det_small / PP-OCRv6_rec_small / ch_ppocr_mobile_v2.0_cls_mobile
   licenses/
   ```

4. Pack a 7-Zip SFX (same pattern as `portable-git.7z.exe`):

   ```text
   7z a -sfx7zCon.sfx sparkii-document-parse.7z.exe bin models licenses
   ```

5. Place the SFX at `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`.
6. Write the archive sha256 into `apps/desktop/runtime/document-parse/checksums.json` as `archive` (64 hex chars). **No `REPLACE_*` placeholders.**

### extraResources / NSIS

The archive sha256 is in `apps/desktop/runtime/document-parse/checksums.json`. Place `sparkii-document-parse.7z.exe` next to it on the Windows build machine (the 7z is gitignored). `electron-builder.yml` extraResources and NSIS `customInstall` then pack and extract it. AppX still relies on `ensureDocumentParse`. FAKE must not be packaged.
