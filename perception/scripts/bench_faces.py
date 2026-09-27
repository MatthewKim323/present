"""Measure YuNet detect + SFace embed latency on this machine.

    uv run python scripts/bench_faces.py --image some.jpg [--n 200] [--width 1280]
    uv run python scripts/bench_faces.py --webcam [--n 200]
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from perception.config import get_settings  # noqa: E402
from perception.faces import FaceEngine  # noqa: E402


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")
    ap.add_argument("--webcam", action="store_true")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--width", type=int, default=1280, help="resize image to this width (Quest frames are ~1280x960)")
    a = ap.parse_args()
    s = get_settings()
    eng = FaceEngine(s.yunet_path, s.sface_path, s.detect_score, s.detect_max_side)
    cap = cv2.VideoCapture(0) if a.webcam else None
    img = None
    if not a.webcam:
        img = cv2.imread(a.image)
        h, w = img.shape[:2]
        img = cv2.resize(img, (a.width, int(h * a.width / w)))
    det, emb, nfaces = [], [], []
    for i in range(a.n + 10):
        frame = cap.read()[1] if cap else img
        t0 = time.perf_counter()
        faces = eng.detect(frame)
        t1 = time.perf_counter()
        for f in faces:
            eng.embed(frame, f)
        t2 = time.perf_counter()
        if i >= 10:  # warmup
            det.append((t1 - t0) * 1000)
            if faces:
                emb.append((t2 - t1) * 1000 / len(faces))
            nfaces.append(len(faces))
    print(f"opencv {cv2.__version__}  frame {frame.shape[1]}x{frame.shape[0]}  detect_max_side={s.detect_max_side}")
    print(f"faces/frame  mean {statistics.mean(nfaces):.2f}")
    print(f"detect ms    mean {statistics.mean(det):.2f}  p50 {pct(det, .5):.2f}  p95 {pct(det, .95):.2f}")
    if emb:
        print(f"embed ms/face mean {statistics.mean(emb):.2f}  p50 {pct(emb, .5):.2f}  p95 {pct(emb, .95):.2f}")


if __name__ == "__main__":
    main()
