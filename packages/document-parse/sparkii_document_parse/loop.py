"""stdin/stdout NDJSON loop for the document-parse process.

stdout is JSON lines only. Logs, tracebacks, and Paddle banners go to stderr.
`SPARKII_DOCUMENT_PARSE_FAKE=1` never imports paddleocr/paddlex.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import traceback
from contextlib import redirect_stdout
from typing import Any, Iterator, Optional, TextIO

FAKE_ENV = "SPARKII_DOCUMENT_PARSE_FAKE"
MODELS_ENV = "SPARKII_DOCUMENT_PARSE_MODELS"
MODEL_SOURCE_ENV = "PADDLE_PDX_MODEL_SOURCE"

# Structure ocr_version must stay on v5. Never pass v6 / PP-OCRv6.
OCR_VERSION = "v5"
DET_MODEL = "PP-OCRv5_server_det"
REC_MODEL = "PP-OCRv5_server_rec"

FORBIDDEN_OCR_VERSIONS = frozenset({"v6", "pp-ocrv6", "ppocrv6", "pp-ocrv6_server"})


def is_fake_mode() -> bool:
    return os.environ.get(FAKE_ENV) == "1"


def path_basename(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def log_err(message: str, err: TextIO) -> None:
    err.write(message)
    if not message.endswith("\n"):
        err.write("\n")
    err.flush()


def write_frame(frame: dict[str, Any], out: TextIO) -> None:
    out.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    out.flush()


def write_error(frame_id: str, message: str, out: TextIO, code: str = "PARSE_FAILED") -> None:
    write_frame({"id": frame_id, "error": {"code": code, "message": message}}, out)


def configure_runtime_env() -> None:
    if not os.environ.get(MODEL_SOURCE_ENV):
        os.environ[MODEL_SOURCE_ENV] = "bos"
    models = os.environ.get(MODELS_ENV)
    if models:
        os.environ.setdefault("PADDLE_PDX_CACHE_HOME", models)


def structure_kwargs(modules: Optional[list[str]] = None) -> dict[str, Any]:
    mods = {m for m in (modules or []) if isinstance(m, str)}
    kwargs: dict[str, Any] = {
        "ocr_version": OCR_VERSION,
        "text_detection_model_name": DET_MODEL,
        "text_recognition_model_name": REC_MODEL,
        "device": "cpu",
        "use_seal_recognition": "seal" in mods,
        "use_formula_recognition": "formula" in mods,
        "use_chart_recognition": "chart" in mods,
    }
    _assert_ocr_version_not_v6(kwargs)
    return kwargs


def _assert_ocr_version_not_v6(kwargs: dict[str, Any]) -> None:
    raw = str(kwargs.get("ocr_version", "")).strip().lower()
    compact = raw.replace("_", "").replace("-", "")
    if raw in FORBIDDEN_OCR_VERSIONS or compact in FORBIDDEN_OCR_VERSIONS or "v6" in compact:
        raise RuntimeError("ocr_version v6 is not supported")


def _filter_kwargs(cls: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        sig = inspect.signature(cls.__init__)
    except (TypeError, ValueError):
        return dict(kwargs)
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in sig.parameters}


def load_structure_class() -> Any:
    """Import PPStructureV3 only on the real path. Returns None if unavailable."""
    configure_runtime_env()
    try:
        from paddleocr import PPStructureV3  # type: ignore
    except Exception as exc:
        log_err(f"document parse runtime import failed: {exc}", sys.stderr)
        return None
    return PPStructureV3


def instantiate_structure(cls: Any, modules: Optional[list[str]] = None) -> Any:
    kwargs = structure_kwargs(modules)
    filtered = _filter_kwargs(cls, kwargs)
    _assert_ocr_version_not_v6(filtered)
    try:
        return cls(**filtered)
    except TypeError:
        if "ocr_version" in filtered and filtered.get("ocr_version") == "v5":
            alt = dict(filtered)
            alt["ocr_version"] = "PP-OCRv5"
            _assert_ocr_version_not_v6(alt)
            try:
                return cls(**_filter_kwargs(cls, alt))
            except TypeError:
                pass
        dropped = {k: v for k, v in filtered.items() if k != "ocr_version"}
        return cls(**dropped)


def _as_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    json_attr = getattr(value, "json", None)
    if callable(json_attr):
        try:
            dumped = json_attr()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    elif isinstance(json_attr, dict):
        return json_attr
    res = getattr(value, "res", None)
    if isinstance(res, dict):
        return res
    return {}


def extract_markdown(res: Any) -> str:
    md = getattr(res, "markdown", None)
    if isinstance(md, str) and md.strip():
        return md
    if isinstance(md, dict):
        for key in ("markdown_texts", "markdown_text", "markdown"):
            text = md.get(key)
            if isinstance(text, str) and text.strip():
                return text
            if isinstance(text, list):
                joined = "\n\n".join(str(item) for item in text if item)
                if joined.strip():
                    return joined
    data = _as_mapping(res)
    for key in ("markdown", "markdown_texts", "markdown_text"):
        text = data.get(key)
        if isinstance(text, str) and text.strip():
            return text
    return ""


def _collect_scores(value: Any, into: list[float]) -> None:
    if isinstance(value, (int, float)):
        into.append(float(value))
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            _collect_scores(item, into)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            key_l = str(key).lower()
            if "score" in key_l:
                _collect_scores(item, into)


def extract_score(res: Any) -> float:
    scores: list[float] = []
    data = _as_mapping(res)
    rec = data.get("overall_ocr_res")
    if isinstance(rec, dict):
        _collect_scores(rec.get("rec_score"), scores)
        _collect_scores(rec.get("rec_scores"), scores)
        _collect_scores(rec.get("rec_score_list"), scores)
    if not scores:
        layout = data.get("layout_det_res")
        if isinstance(layout, dict):
            _collect_scores(layout.get("boxes"), scores)
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 4)


def iter_chunks(stdin: TextIO) -> Iterator[str]:
    buf = getattr(stdin, "buffer", None)
    if buf is not None:
        read1 = getattr(buf, "read1", None)
        reader = read1 if callable(read1) else buf.read
        while True:
            raw = reader(4096)
            if not raw:
                return
            if isinstance(raw, str):
                yield raw
            else:
                yield raw.decode("utf-8", errors="replace")
        return
    while True:
        chunk = stdin.read(4096)
        if not chunk:
            return
        yield chunk


def handle_parse_fake(frame_id: str, params: dict[str, Any], out: TextIO) -> None:
    path = params.get("path") if isinstance(params.get("path"), str) else ""
    name = path_basename(path)
    write_frame({"id": frame_id, "method": "progress", "params": {"page": 1, "total": 1}}, out)
    write_frame(
        {
            "id": frame_id,
            "result": {
                "markdown": f"# fake\n{name}",
                "pages": [{"page": 1, "score": 0.91}],
            },
        },
        out,
    )


def handle_parse_real(
    frame_id: str,
    params: dict[str, Any],
    out: TextIO,
    err: TextIO,
) -> None:
    path = params.get("path")
    if not isinstance(path, str) or not path:
        write_error(frame_id, "document parse failed: missing path", out)
        return
    modules = params.get("modules")
    module_list = [m for m in modules if isinstance(m, str)] if isinstance(modules, list) else []

    cls = load_structure_class()
    if cls is None:
        write_error(frame_id, "document parse runtime is not available", out)
        return

    try:
        with redirect_stdout(err):
            pipeline = instantiate_structure(cls, module_list)
            output = pipeline.predict(input=path)
            results = list(output) if output is not None else []
    except Exception:
        log_err(traceback.format_exc(), err)
        write_error(frame_id, "document parse failed", out)
        return

    if not results:
        write_error(frame_id, "document parse produced no pages", out)
        return

    total = len(results)
    pages: list[dict[str, Any]] = []
    markdown_parts: list[str] = []
    for index, res in enumerate(results, start=1):
        write_frame(
            {"id": frame_id, "method": "progress", "params": {"page": index, "total": total}},
            out,
        )
        markdown_parts.append(extract_markdown(res))
        pages.append({"page": index, "score": extract_score(res)})

    write_frame(
        {
            "id": frame_id,
            "result": {
                "markdown": "\n\n".join(part for part in markdown_parts if part).strip(),
                "pages": pages,
            },
        },
        out,
    )


def handle_frame(frame: Any, out: TextIO, err: TextIO) -> Optional[int]:
    if not isinstance(frame, dict) or not isinstance(frame.get("id"), str):
        return None
    frame_id = frame["id"]
    method = frame.get("method")
    if method == "shutdown":
        out.flush()
        return 0
    if method != "parse":
        return None
    params = frame.get("params")
    if not isinstance(params, dict):
        params = {}
    if is_fake_mode():
        handle_parse_fake(frame_id, params, out)
        return None
    handle_parse_real(frame_id, params, out, err)
    return None


def run_loop(stdin: TextIO, stdout: TextIO, stderr: Optional[TextIO] = None) -> int:
    err = stderr if stderr is not None else sys.stderr
    rest = ""
    for chunk in iter_chunks(stdin):
        rest += chunk
        parts = rest.split("\n")
        rest = parts.pop() if parts else ""
        for line in parts:
            if not line.strip():
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                log_err("malformed ndjson line skipped", err)
                continue
            code = handle_frame(frame, stdout, err)
            if code is not None:
                return code
    return 0


def main() -> None:
    rpc_out = sys.stdout
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass
    # Any library print/banner must not land on the RPC stream.
    sys.stdout = sys.stderr
    raise SystemExit(run_loop(sys.stdin, rpc_out, sys.stderr))
