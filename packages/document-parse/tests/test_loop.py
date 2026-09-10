from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

_PKG_ROOT = Path(__file__).resolve().parents[1]
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from sparkii_document_parse.loop import (  # noqa: E402
    extract_markdown,
    extract_score,
    is_fake_mode,
    load_structure_class,
    run_loop,
    structure_kwargs,
)


class ChunkedIO(io.StringIO):
    def __init__(self, value: str, size: int = 11) -> None:
        super().__init__(value)
        self._size = size

    def read(self, n: int = -1) -> str:  # noqa: ARG002
        return super().read(self._size)


def parse_stdout_lines(stdout: str) -> list[Any]:
    frames = []
    for line in stdout.split("\n"):
        if not line.strip():
            continue
        frames.append(json.loads(line))
    return frames


class FakeLoopTests(unittest.TestCase):
    def setUp(self) -> None:
        self._fake = os.environ.get("SPARKII_DOCUMENT_PARSE_FAKE")
        os.environ["SPARKII_DOCUMENT_PARSE_FAKE"] = "1"

    def tearDown(self) -> None:
        if self._fake is None:
            os.environ.pop("SPARKII_DOCUMENT_PARSE_FAKE", None)
        else:
            os.environ["SPARKII_DOCUMENT_PARSE_FAKE"] = self._fake

    def test_fake_parse_stdout_is_json_progress_then_result(self) -> None:
        stdin = io.StringIO(
            '{"id":"1","method":"parse","params":{"path":"C:/docs/scan.pdf","modules":["baseline"]}}\n'
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = run_loop(stdin, stdout, stderr)
        self.assertEqual(code, 0)
        raw = stdout.getvalue()
        self.assertFalse(raw.startswith("Loading") or "Paddle" in raw)
        frames = parse_stdout_lines(raw)
        self.assertGreaterEqual(len(frames), 2)
        self.assertEqual(frames[0], {"id": "1", "method": "progress", "params": {"page": 1, "total": 1}})
        self.assertEqual(frames[1]["id"], "1")
        self.assertEqual(frames[1]["result"]["pages"], [{"page": 1, "score": 0.91}])
        self.assertIn("scan.pdf", frames[1]["result"]["markdown"])
        self.assertNotIn("paddleocr", sys.modules)
        self.assertNotIn("paddlex", sys.modules)

    def test_fake_does_not_import_paddle(self) -> None:
        stdin = io.StringIO(
            '{"id":"1","method":"parse","params":{"path":"/tmp/a.pdf","modules":["baseline"]}}\n'
        )
        stdout = io.StringIO()
        with mock.patch("sparkii_document_parse.loop.load_structure_class") as loader:
            run_loop(stdin, stdout, io.StringIO())
            loader.assert_not_called()
        self.assertTrue(is_fake_mode())

    def test_fake_shutdown_exits_0(self) -> None:
        env = os.environ.copy()
        env["SPARKII_DOCUMENT_PARSE_FAKE"] = "1"
        env["PYTHONPATH"] = str(_PKG_ROOT)
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.run(
            [sys.executable, "-m", "sparkii_document_parse"],
            input='{"id":"2","method":"shutdown"}\n',
            capture_output=True,
            text=True,
            env=env,
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0)
        for line in proc.stdout.splitlines():
            if line.strip():
                json.loads(line)

    def test_malformed_line_skipped_then_parse_works(self) -> None:
        stdin = io.StringIO(
            "not-json\n"
            '{"id":"1","method":"parse","params":{"path":"/tmp/next.pdf","modules":["baseline"]}}\n'
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        run_loop(stdin, stdout, stderr)
        frames = parse_stdout_lines(stdout.getvalue())
        self.assertEqual(frames[0]["method"], "progress")
        self.assertEqual(frames[1]["result"]["pages"][0]["score"], 0.91)
        self.assertIn("next.pdf", frames[1]["result"]["markdown"])
        self.assertIn("malformed", stderr.getvalue())

    def test_remainder_buffer_joins_chunked_json(self) -> None:
        payload = (
            '{"id":"1","method":"parse","params":{"path":"/tmp/chunked.pdf","modules":["baseline"]}}\n'
        )
        stdin = ChunkedIO(payload, size=9)
        stdout = io.StringIO()
        run_loop(stdin, stdout, io.StringIO())
        frames = parse_stdout_lines(stdout.getvalue())
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0]["method"], "progress")
        self.assertIn("chunked.pdf", frames[1]["result"]["markdown"])


class StructureKwargsTests(unittest.TestCase):
    def test_never_passes_ocr_version_v6(self) -> None:
        kwargs = structure_kwargs(["baseline", "seal"])
        dumped = json.dumps(kwargs).lower()
        self.assertNotIn("v6", dumped)
        self.assertEqual(kwargs["ocr_version"], "v5")
        self.assertEqual(kwargs["text_detection_model_name"], "PP-OCRv5_server_det")
        self.assertEqual(kwargs["text_recognition_model_name"], "PP-OCRv5_server_rec")
        self.assertTrue(kwargs["use_seal_recognition"])
        self.assertFalse(kwargs["use_formula_recognition"])

    def test_extract_markdown_and_score(self) -> None:
        class Res:
            markdown = {"markdown_texts": "# hi"}
            json = {
                "overall_ocr_res": {"rec_scores": [0.9, 0.7]},
            }

        self.assertEqual(extract_markdown(Res()), "# hi")
        self.assertEqual(extract_score(Res()), 0.8)


class MissingPaddleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._fake = os.environ.get("SPARKII_DOCUMENT_PARSE_FAKE")
        os.environ.pop("SPARKII_DOCUMENT_PARSE_FAKE", None)

    def tearDown(self) -> None:
        if self._fake is None:
            os.environ.pop("SPARKII_DOCUMENT_PARSE_FAKE", None)
        else:
            os.environ["SPARKII_DOCUMENT_PARSE_FAKE"] = self._fake

    def test_missing_paddle_replies_parse_failed_without_traceback_on_stdout(self) -> None:
        stdin = io.StringIO(
            '{"id":"1","method":"parse","params":{"path":"/tmp/a.pdf","modules":["baseline"]}}\n'
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch("sparkii_document_parse.loop.load_structure_class", return_value=None):
            run_loop(stdin, stdout, stderr)
        raw = stdout.getvalue()
        frames = parse_stdout_lines(raw)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["error"]["code"], "PARSE_FAILED")
        self.assertNotIn("Traceback", raw)
        self.assertNotIn("Traceback", stdout.getvalue())


@unittest.skipUnless(os.environ.get("SPARKII_DOCUMENT_PARSE_E2E"), "SPARKII_DOCUMENT_PARSE_E2E not set")
class RealPaddleTests(unittest.TestCase):
    def test_real_paddle_import_and_v5_kwargs(self) -> None:
        os.environ.pop("SPARKII_DOCUMENT_PARSE_FAKE", None)
        cls = load_structure_class()
        self.assertIsNotNone(cls, "paddleocr is required when SPARKII_DOCUMENT_PARSE_E2E is set")
        kwargs = structure_kwargs(["baseline"])
        dumped = json.dumps(kwargs).lower()
        self.assertNotIn("v6", dumped)
        self.assertEqual(kwargs["ocr_version"], "v5")


if __name__ == "__main__":
    unittest.main()
