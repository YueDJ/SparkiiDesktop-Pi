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
    configure_runtime_env,
    is_fake_mode,
    reset_pipeline_cache_for_tests,
    run_loop,
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


class FakeOcr:
    def __call__(self, img):
        class Out:
            txts = ("合同编号",)
            scores = (0.99,)

        return Out()


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
        self.assertNotIn("current", frames[0]["params"])
        self.assertEqual(frames[1]["id"], "1")
        self.assertEqual(frames[1]["result"]["pages"], [{"page": 1, "score": 0.91}])
        self.assertIn("scan.pdf", frames[1]["result"]["markdown"])
        self.assertNotIn("paddleocr", sys.modules)
        self.assertNotIn("paddlex", sys.modules)

    def test_fake_does_not_call_create_ocr(self) -> None:
        stdin = io.StringIO(
            '{"id":"1","method":"parse","params":{"path":"/tmp/a.pdf","modules":["baseline"]}}\n'
        )
        stdout = io.StringIO()
        with mock.patch("sparkii_document_parse.loop.handle_parse_real") as real:
            run_loop(stdin, stdout, io.StringIO())
            real.assert_not_called()
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
        self.assertEqual(frames[0]["params"], {"page": 1, "total": 1})
        self.assertNotIn("current", frames[0]["params"])
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
        self.assertEqual(frames[0]["params"], {"page": 1, "total": 1})
        self.assertIn("chunked.pdf", frames[1]["result"]["markdown"])


class RuntimeEnvTests(unittest.TestCase):
    def test_caps_cpu_thread_env_when_unset(self) -> None:
        saved = {k: os.environ.get(k) for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")}
        try:
            for key in saved:
                os.environ.pop(key, None)
            configure_runtime_env()
            for key in saved:
                n = int(os.environ[key])
                self.assertGreaterEqual(n, 2)
                self.assertLessEqual(n, 8)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_does_not_set_paddle_model_source(self) -> None:
        saved_source = os.environ.get("PADDLE_PDX_MODEL_SOURCE")
        saved_cache = os.environ.get("PADDLE_PDX_CACHE_HOME")
        try:
            os.environ.pop("PADDLE_PDX_MODEL_SOURCE", None)
            os.environ.pop("PADDLE_PDX_CACHE_HOME", None)
            configure_runtime_env()
            self.assertNotIn("PADDLE_PDX_MODEL_SOURCE", os.environ)
            self.assertNotIn("PADDLE_PDX_CACHE_HOME", os.environ)
        finally:
            if saved_source is None:
                os.environ.pop("PADDLE_PDX_MODEL_SOURCE", None)
            else:
                os.environ["PADDLE_PDX_MODEL_SOURCE"] = saved_source
            if saved_cache is None:
                os.environ.pop("PADDLE_PDX_CACHE_HOME", None)
            else:
                os.environ["PADDLE_PDX_CACHE_HOME"] = saved_cache

    def test_lines_from_ocr_reads_txts_and_scores(self) -> None:
        from sparkii_document_parse.light_ocr import lines_from_ocr

        class Out:
            txts = ("合同编号",)
            scores = (0.99,)

        self.assertEqual(lines_from_ocr(Out()), [("合同编号", 0.99)])


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

        with (
            mock.patch("sparkii_document_parse.light_ocr.RapidOCR", side_effect=fake_ctor),
            mock.patch("pathlib.Path.is_file", return_value=True),
        ):
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


if __name__ == "__main__":
    unittest.main()
