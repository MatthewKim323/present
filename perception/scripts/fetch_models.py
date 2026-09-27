"""Fetch the YuNet + SFace ONNX models from opencv_zoo into perception/models/.

Models are gitignored (*.onnx), so run this once after cloning:
    uv run python scripts/fetch_models.py
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
BASE = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": f"{BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": f"{BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}


def main() -> int:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in MODELS.items():
        dest = MODELS_DIR / name
        if dest.exists() and dest.stat().st_size > 100_000:
            print(f"ok   {name} ({dest.stat().st_size} bytes)")
            continue
        print(f"get  {name} <- {url}")
        tmp = dest.with_suffix(".part")
        urllib.request.urlretrieve(url, tmp)
        if tmp.stat().st_size < 100_000:
            tmp.unlink()
            print(f"FAIL {name}: download too small (LFS pointer?)", file=sys.stderr)
            return 1
        tmp.rename(dest)
        print(f"ok   {name} ({dest.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
