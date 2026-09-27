"""Energy VAD segmentation + swappable ASR. Audio stays in memory and is dropped after transcription."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Protocol

import numpy as np

log = logging.getLogger("world.audio")


@dataclass
class Segment:
    audio: np.ndarray  # float32 mono, [-1, 1]
    sample_rate: int
    start_ts: float
    end_ts: float
    rms_db: float  # mean speech level; the wearer's own voice is usually loudest (mic at mouth)

    @property
    def duration_s(self) -> float:
        return len(self.audio) / self.sample_rate


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def resample(x: np.ndarray, sr: int, target: int = 16000) -> np.ndarray:
    if sr == target or len(x) == 0:
        return x
    n = int(round(len(x) * target / sr))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def dbfs(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0
    return 20 * np.log10(max(rms, 1e-9))


class EnergyVAD:
    """Adaptive-noise-floor energy VAD with hangover. Feed arbitrary chunk sizes."""

    def __init__(
        self,
        sample_rate: int = 16000,
        frame_ms: int = 30,
        margin_db: float = 10.0,
        abs_min_db: float = -50.0,
        start_frames: int = 3,
        end_silence_ms: int = 700,
        max_segment_s: float = 20.0,
        min_segment_s: float = 0.35,
    ) -> None:
        self.sr = sample_rate
        self.frame = int(sample_rate * frame_ms / 1000)
        self.frame_s = frame_ms / 1000
        self.margin_db = margin_db
        self.abs_min_db = abs_min_db
        self.start_frames = start_frames
        self.end_frames = max(1, end_silence_ms // frame_ms)
        self.max_frames = int(max_segment_s / self.frame_s)
        self.min_segment_s = min_segment_s
        self.noise_db = -60.0
        self._buf = np.zeros(0, dtype=np.float32)
        self._pre: list[np.ndarray] = []  # pre-roll frames
        self._seg: list[np.ndarray] = []
        self._levels: list[float] = []
        self._speech_run = 0
        self._silence_run = 0
        self._in_speech = False
        self._seg_start = 0.0
        self._clock = None  # ts of the next sample

    def feed(self, samples: np.ndarray, ts: float | None = None) -> list[Segment]:
        if ts is not None and self._clock is None:
            self._clock = ts
        if self._clock is None:
            self._clock = time.time()
        self._buf = np.concatenate([self._buf, samples.astype(np.float32)])
        out: list[Segment] = []
        while len(self._buf) >= self.frame:
            fr, self._buf = self._buf[: self.frame], self._buf[self.frame :]
            seg = self._step(fr)
            self._clock += self.frame_s
            if seg is not None:
                out.append(seg)
        return out

    def flush(self) -> Segment | None:
        return self._close() if self._in_speech else None

    def _step(self, fr: np.ndarray) -> Segment | None:
        lvl = dbfs(fr)
        speechy = lvl > max(self.noise_db + self.margin_db, self.abs_min_db)
        if not self._in_speech:
            # track noise floor only outside speech; fall fast, rise slow
            a = 0.3 if lvl < self.noise_db else 0.02
            self.noise_db = (1 - a) * self.noise_db + a * lvl
            self._pre.append(fr)
            self._pre = self._pre[-(self.start_frames + 5) :]
            self._speech_run = self._speech_run + 1 if speechy else 0
            if self._speech_run >= self.start_frames:
                self._in_speech = True
                self._seg = list(self._pre)
                self._levels = [lvl] * self.start_frames
                self._seg_start = self._clock - len(self._pre) * self.frame_s
                self._silence_run = 0
                self._pre = []
            return None
        self._seg.append(fr)
        if speechy:
            self._levels.append(lvl)
            self._silence_run = 0
        else:
            self._silence_run += 1
        if self._silence_run >= self.end_frames or len(self._seg) >= self.max_frames:
            return self._close()
        return None

    def _close(self) -> Segment | None:
        audio = np.concatenate(self._seg) if self._seg else np.zeros(0, np.float32)
        levels = self._levels
        self._seg, self._levels, self._in_speech, self._speech_run = [], [], False, 0
        if len(audio) / self.sr < self.min_segment_s:
            return None
        return Segment(audio, self.sr, self._seg_start, self._clock, float(np.mean(levels)) if levels else -99.0)


class Transcriber(Protocol):
    def transcribe(self, seg: Segment) -> str: ...


class NullTranscriber:
    """No ASR (e.g. tests, or text injected via /debug/utterance)."""

    def transcribe(self, seg: Segment) -> str:
        return ""


class FasterWhisperTranscriber:
    def __init__(self, model: str = "base.en", device: str = "cpu", compute_type: str = "int8") -> None:
        from faster_whisper import WhisperModel  # lazy: heavy import

        t0 = time.perf_counter()
        self.model = WhisperModel(model, device=device, compute_type=compute_type)
        log.info("faster-whisper %s loaded in %.1fs", model, time.perf_counter() - t0)

    def transcribe(self, seg: Segment) -> str:
        audio = resample(seg.audio, seg.sample_rate, 16000)
        segments, _ = self.model.transcribe(audio, language="en", beam_size=1, vad_filter=False, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments).strip()


def make_transcriber(backend: str, model: str) -> Transcriber:
    if backend in ("none", "null", "off"):
        return NullTranscriber()
    if backend == "faster-whisper":
        return FasterWhisperTranscriber(model)
    raise ValueError(f"unknown ASR backend {backend!r} (faster-whisper | none)")
