# document-parse runtime

Windows x64 CPU offline archive for the document-parse process.

Internal layout after extract:

```text
bin/sparkii-document-parse.exe
models/baseline/READY
models/baseline/PP-OCRv6_det_small.onnx
models/baseline/PP-OCRv6_rec_small.onnx
models/baseline/ch_ppocr_mobile_v2.0_cls_mobile.onnx
licenses/
```

- Archive name: `sparkii-document-parse.7z.exe` (gitignored; required on the build machine for `pnpm dist`)
- SHA256: `checksums.json` → `archive` (64 hex). This hash is the only accepted content.
- Size: ≤ 100 MiB. `ensure-document-parse.mjs` accepts only:
  - `SPARKII_DOCUMENT_PARSE_ARCHIVE` (must exist and match `checksums.json`)
  - or this directory’s `sparkii-document-parse.7z.exe` (must match `checksums.json`)
- Extract: `sparkii-document-parse.7z.exe -o<dest> -y`

Do not ship `SPARKII_DOCUMENT_PARSE_FAKE=1`. Models stay under `models/baseline/` only.
