"""YuNet detection + SFace embeddings via OpenCV. Frames stay in memory only."""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Face:
    bbox: tuple[int, int, int, int]  # x, y, w, h in ORIGINAL frame pixels
    score: float
    row: np.ndarray  # raw YuNet row (15 floats) in original frame coords, for alignCrop

    @property
    def area(self) -> int:
        return self.bbox[2] * self.bbox[3]


class LatencyStat:
    """Exponential moving average of a timing in ms."""

    def __init__(self, alpha: float = 0.1) -> None:
        self.alpha = alpha
        self.ms: float | None = None
        self.n = 0

    def add(self, ms: float) -> None:
        self.n += 1
        self.ms = ms if self.ms is None else (1 - self.alpha) * self.ms + self.alpha * ms


class FaceEngine:
    def __init__(self, yunet_path: Path, sface_path: Path, score_threshold: float = 0.8, max_side: int = 640) -> None:
        for p in (yunet_path, sface_path):
            if not Path(p).exists():
                raise FileNotFoundError(f"missing model {p}; run: uv run python scripts/fetch_models.py")
        self.detector = cv2.FaceDetectorYN.create(str(yunet_path), "", (320, 320), score_threshold, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create(str(sface_path), "")
        self.max_side = max_side
        self._input_size: tuple[int, int] | None = None
        self.detect_lat = LatencyStat()
        self.embed_lat = LatencyStat()

    def detect(self, frame: np.ndarray) -> list[Face]:
        """Detect faces. Downscales large frames for speed, returns boxes in original coords."""
        t0 = time.perf_counter()
        h, w = frame.shape[:2]
        scale = min(1.0, self.max_side / max(h, w))
        img = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale < 1.0 else frame
        size = (img.shape[1], img.shape[0])
        if size != self._input_size:
            self.detector.setInputSize(size)
            self._input_size = size
        _, dets = self.detector.detect(img)
        faces: list[Face] = []
        if dets is not None:
            for row in dets:
                r = row.copy()
                r[:14] = r[:14] / scale
                x, y, bw, bh = (int(round(v)) for v in r[:4])
                faces.append(Face(bbox=(x, y, bw, bh), score=float(r[14]), row=r))
        self.detect_lat.add((time.perf_counter() - t0) * 1000)
        return faces

    def embed(self, frame: np.ndarray, face: Face) -> np.ndarray:
        """L2-normalized 128-d SFace embedding."""
        t0 = time.perf_counter()
        crop = self.recognizer.alignCrop(frame, face.row)
        feat = self.recognizer.feature(crop).flatten().astype(np.float32)
        n = float(np.linalg.norm(feat))
        self.embed_lat.add((time.perf_counter() - t0) * 1000)
        return feat / n if n > 0 else feat


def decode_jpeg(data: bytes) -> np.ndarray | None:
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)
