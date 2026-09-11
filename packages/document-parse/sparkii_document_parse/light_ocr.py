import os
from pathlib import Path

try:
    from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR
except ImportError:  # pragma: no cover - real runtime installs RapidOCR
    RapidOCR = None  # type: ignore[misc, assignment]
    EngineType = None  # type: ignore[misc, assignment]
    OCRVersion = None  # type: ignore[misc, assignment]
    ModelType = None  # type: ignore[misc, assignment]

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
        if RapidOCR is None or EngineType is None or OCRVersion is None or ModelType is None:
            raise ImportError("rapidocr is required")
        base = _baseline_dir()
        _ocr = RapidOCR(params={
            "Det.engine_type": EngineType.ONNXRUNTIME,
            "Det.ocr_version": OCRVersion.PPOCRV6,
            "Det.model_type": ModelType.SMALL,
            "Det.model_path": _require(base / DET_NAME),
            "Rec.engine_type": EngineType.ONNXRUNTIME,
            "Rec.ocr_version": OCRVersion.PPOCRV6,
            "Rec.model_type": ModelType.SMALL,
            "Rec.model_path": _require(base / REC_NAME),
            "Cls.engine_type": EngineType.ONNXRUNTIME,
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


def open_pdf_pages(path: str):
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    total = len(doc)

    def pages():
        try:
            for i in range(total):
                page = doc[i]
                try:
                    yield page.render(scale=2).to_pil()
                finally:
                    page.close()
        finally:
            doc.close()

    return total, pages()


def pdf_to_images(path: str):
    _total, pages = open_pdf_pages(path)
    yield from pages
