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

- `SPARKII_DOCUMENT_PARSE_FAKE=1` **must not** be set in the packaged Windows binary, freeze spec, or installer.
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

## Building the light archive (`sparkii-document-parse.7z.exe`)

The release archive is gitignored and must be **≤ 100 MiB**. A real 64-character sha256 must be in `apps/desktop/runtime/document-parse/checksums.json` before `pnpm dist`. That hash is the control plane: `ensure-document-parse.mjs` accepts only an env override or `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`, and both must match.

On a Windows x64 CPU build machine (no CUDA, no HuggingFace):

1. Create a fresh venv. Install only `requirements-light.txt` and `pyinstaller`.
2. Pull the three locked ONNX names from ModelScope `RapidAI/RapidOCR` (not huggingface.co). Copy them **only** into `models/baseline/`. Do not let PyInstaller collect another copy.
3. Freeze `--onedir --console` as `bin/sparkii-document-parse.exe`. Collect data+binaries for `rapidocr`, `onnxruntime`, and `pypdfium2`. Exclude OpenVINO, CUDA, `onnxruntime-gpu`, `opencv-python`, and paddle. Do not `--collect-all paddle`. **FAKE unset**.
4. Extract layout:

   ```text
   bin/sparkii-document-parse.exe
   models/baseline/READY
   models/baseline/PP-OCRv6_det_small.onnx
   models/baseline/PP-OCRv6_rec_small.onnx
   models/baseline/ch_ppocr_mobile_v2.0_cls_mobile.onnx
   licenses/
   ```

5. Pack a 7-Zip SFX:

   ```text
   7z a -sfx7zCon.sfx sparkii-document-parse.7z.exe bin models licenses
   ```

6. Before writing `checksums.json`: archive `Length -le 104857600`. Then write the file’s real sha256 as `archive` (64 hex). **No invented hashes. No `REPLACE_*` placeholders.**
7. Place the SFX at `apps/desktop/runtime/document-parse/sparkii-document-parse.7z.exe`. Do not git-add it.

### extraResources / NSIS

The archive sha256 is in `apps/desktop/runtime/document-parse/checksums.json`. Place `sparkii-document-parse.7z.exe` next to it on the Windows build machine (the 7z is gitignored). `electron-builder.yml` extraResources and NSIS `customInstall` then pack and extract it. AppX still relies on `ensureDocumentParse`. FAKE must not be packaged.
