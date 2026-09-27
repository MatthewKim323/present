"""Runtime settings, all env-overridable. Nothing here is secret except the API key env var name."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
ROOT_DIR = PKG_DIR.parent  # perception/
MODELS_DIR = ROOT_DIR / "models"
DATA_DIR = ROOT_DIR / "data"


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _envf(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("WORLD_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_env("WORLD_PORT", "8787")))

    yunet_path: Path = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
    sface_path: Path = MODELS_DIR / "face_recognition_sface_2021dec.onnx"
    people_path: Path = field(default_factory=lambda: Path(_env("WORLD_PEOPLE_PATH", str(DATA_DIR / "people.json"))))
    events_log_path: Path = field(default_factory=lambda: Path(_env("WORLD_EVENTS_LOG", str(DATA_DIR / "events.jsonl"))))

    # Faces
    detect_score: float = field(default_factory=lambda: _envf("WORLD_DETECT_SCORE", 0.8))
    detect_max_side: int = field(default_factory=lambda: int(_env("WORLD_DETECT_MAX_SIDE", "640")))
    # SFace cosine: opencv_zoo recommends 0.363. Slightly stricter default.
    match_threshold: float = field(default_factory=lambda: _envf("WORLD_MATCH_THRESHOLD", 0.40))
    track_max_age_s: float = field(default_factory=lambda: _envf("WORLD_TRACK_MAX_AGE", 1.0))
    encounter_debounce_s: float = field(default_factory=lambda: _envf("WORLD_ENCOUNTER_DEBOUNCE", 60.0))
    enroll_samples: int = field(default_factory=lambda: int(_env("WORLD_ENROLL_SAMPLES", "12")))

    # Audio / conversation
    asr_backend: str = field(default_factory=lambda: _env("WORLD_ASR", "faster-whisper"))  # faster-whisper | none
    asr_model: str = field(default_factory=lambda: _env("WORLD_ASR_MODEL", "base.en"))
    conv_gap_s: float = field(default_factory=lambda: _envf("WORLD_CONV_GAP", 10.0))
    leave_grace_s: float = field(default_factory=lambda: _envf("WORLD_LEAVE_GRACE", 4.0))

    # Extraction
    anthropic_model: str = field(default_factory=lambda: _env("WORLD_LLM_MODEL", "claude-sonnet-5"))
    wearer_id: str = field(default_factory=lambda: _env("WORLD_WEARER_ID", "matthew"))
    wearer_name: str = field(default_factory=lambda: _env("WORLD_WEARER_NAME", "Matthew"))

    # Sinks
    qm_url: str = field(default_factory=lambda: _env("QM_URL", ""))
    gbrain_backend: str = field(default_factory=lambda: _env("GBRAIN_BACKEND", "stub"))


def get_settings() -> Settings:
    return Settings()
