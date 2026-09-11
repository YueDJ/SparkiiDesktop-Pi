"""stdin/stdout NDJSON loop for the document-parse process.

stdout is JSON lines only. Logs, tracebacks, and library banners go to stderr.
`SPARKII_DOCUMENT_PARSE_FAKE=1` never imports RapidOCR.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Iterator, Optional, TextIO

FAKE_ENV = "SPARKII_DOCUMENT_PARSE_FAKE"
CPU_THREAD_CAP = 8
CPU_THREAD_FLOOR = 2


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


def _cpu_thread_count() -> int:
    n = os.cpu_count() or CPU_THREAD_FLOOR
    return max(CPU_THREAD_FLOOR, min(CPU_THREAD_CAP, n))


def configure_runtime_env() -> None:
    threads = str(_cpu_thread_count())
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        if not os.environ.get(key):
            os.environ[key] = threads


def reset_pipeline_cache_for_tests() -> None:
    from sparkii_document_parse import light_ocr

    light_ocr.reset_ocr_for_tests()


def _iter_pages(path: str) -> tuple[int, Any]:
    from sparkii_document_parse import light_ocr

    if Path(path).suffix.lower() == ".pdf":
        return light_ocr.open_pdf_pages(path)
    return 1, iter((path,))


def _page_markdown(index: int, lines: list[tuple[str, float]]) -> str:
    texts = [text for text, _score in lines if text]
    heading = f"# 第 {index} 页"
    if not texts:
        return heading
    return heading + "\n" + "\n".join(texts)


def _page_score(lines: list[tuple[str, float]]) -> float:
    scores = [float(score) for _text, score in lines]
    if not scores:
        return 0.0
    return sum(scores) / len(scores)


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

    try:
        from sparkii_document_parse import light_ocr

        configure_runtime_env()
        with redirect_stdout(err):
            ocr = light_ocr.create_ocr()
            total, images = _iter_pages(path)
        pages: list[dict[str, Any]] = []
        markdown_parts: list[str] = []
        index = 0
        try:
            for image in images:
                index += 1
                write_frame(
                    {"id": frame_id, "method": "progress", "params": {"page": index, "total": total}},
                    out,
                )
                with redirect_stdout(err):
                    result = ocr(image)
                lines = light_ocr.lines_from_ocr(result)
                markdown_parts.append(_page_markdown(index, lines))
                pages.append({"page": index, "score": _page_score(lines)})
        finally:
            close = getattr(images, "close", None)
            if callable(close):
                close()
        if index == 0:
            write_error(frame_id, "document parse produced no pages", out)
            return
    except Exception:
        log_err(traceback.format_exc(), err)
        write_error(frame_id, "document parse failed", out)
        return

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
