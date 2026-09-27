"""Frame -> tracks -> identities -> person.encountered / person.enrolled events.

Synchronous and thread-confined: the service runs process() in a worker thread,
one frame at a time (latest frame wins).
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .events import make_event, slug
from .faces import FaceEngine
from .people import PeopleStore
from .tracker import Track, Tracker

log = logging.getLogger("world.vision")

IDENTIFIED_REEMBED_S = 0.5
UNKNOWN_REEMBED_S = 0.15
ENROLL_SAMPLE_GAP_S = 0.15
MIN_ENROLL_SAMPLES = 3
STABLE_HITS = 3


@dataclass
class VisionResult:
    events: list[dict[str, Any]] = field(default_factory=list)
    expired: list[Track] = field(default_factory=list)
    tracks: list[dict[str, Any]] = field(default_factory=list)
    detect_ms: float = 0.0
    embed_ms: float = 0.0
    frame_w: int = 0
    frame_h: int = 0


class VisionPipeline:
    def __init__(
        self,
        engine: FaceEngine | None,
        store: PeopleStore,
        *,
        source: str = "quest3s",
        max_age_s: float = 1.0,
        encounter_debounce_s: float = 60.0,
        enroll_samples: int = 12,
    ) -> None:
        self.engine = engine
        self.store = store
        self.source = source
        self.tracker = Tracker(max_age_s=max_age_s)
        self.encounter_debounce_s = encounter_debounce_s
        self.enroll_samples = enroll_samples
        self._unknown_counter = 0
        self._last_announce: dict[str, float] = {}
        self._pending_labels: list[tuple[int, str]] = []
        self._lock = threading.Lock()

    # public API (thread-safe entry points)
    def request_label(self, track_id: int, name: str) -> None:
        with self._lock:
            self._pending_labels.append((int(track_id), name))

    def process(self, frame: np.ndarray, ts: float | None = None) -> VisionResult:
        ts = time.time() if ts is None else ts
        res = VisionResult(frame_h=frame.shape[0], frame_w=frame.shape[1])
        assert self.engine is not None
        t0 = time.perf_counter()
        faces = self.engine.detect(frame)
        res.detect_ms = (time.perf_counter() - t0) * 1000
        assigned, expired = self.tracker.update([f.bbox for f in faces], ts)
        self._apply_labels(res)
        t1 = time.perf_counter()
        for track, di in assigned:
            self._identify(track, frame, faces[di], ts, res)
        res.embed_ms = (time.perf_counter() - t1) * 1000
        for track, _ in assigned:
            self._maybe_announce(track, ts, res)
        res.expired = self._finish_expired(expired, res)
        res.tracks = [self.track_view(t) for t in self.tracker.tracks.values()]
        return res

    def tick(self, ts: float | None = None) -> VisionResult:
        """Expire tracks when no frames are arriving."""
        res = VisionResult()
        res.expired = self._finish_expired(self.tracker.expire(time.time() if ts is None else ts), res)
        return res

    def track_view(self, t: Track) -> dict[str, Any]:
        return {
            "track_id": t.track_id,
            "bbox": list(t.bbox),
            "person_id": t.person_id,
            "label": t.label,
            "match_score": round(t.match_score, 3),
            "enrolling": t.enroll_name is not None,
        }

    def primary_track(self) -> Track | None:
        """Largest labeled track in view: the person the wearer is most likely talking to."""
        cands = [t for t in self.tracker.tracks.values() if t.label]
        return max(cands, key=lambda t: t.area) if cands else None

    # internals
    def _apply_labels(self, res: VisionResult) -> None:
        with self._lock:
            pending, self._pending_labels = self._pending_labels, []
        for track_id, name in pending:
            t = self.tracker.tracks.get(track_id)
            if t is None:
                log.warning("label for unknown track %s (%s) ignored", track_id, name)
                continue
            t.enroll_name = name.strip()
            t.enroll_buf = list(t.embeddings)
            t.person_id = slug(name)
            t.label = name.strip()
            t.match_score = 1.0
            log.info("enrolling track %s as %s (%d buffered samples)", track_id, name, len(t.enroll_buf))
            if len(t.enroll_buf) >= self.enroll_samples:
                self._finalize_enroll(t, res)

    def _identify(self, t: Track, frame: np.ndarray, face, ts: float, res: VisionResult) -> None:
        if t.enroll_name is not None:
            if ts - t.last_embed_ts >= ENROLL_SAMPLE_GAP_S:
                emb = self.engine.embed(frame, face)
                t.last_embed_ts = ts
                t.embeddings.append(emb)
                t.enroll_buf.append(emb)
                if len(t.enroll_buf) >= self.enroll_samples:
                    self._finalize_enroll(t, res)
            return
        gap = IDENTIFIED_REEMBED_S if t.person_id else UNKNOWN_REEMBED_S
        if ts - t.last_embed_ts < gap:
            return
        emb = self.engine.embed(frame, face)
        t.last_embed_ts = ts
        t.embeddings.append(emb)
        pid, name, score = self.store.match(emb)
        t.votes.append((pid, score, name))
        self._resolve_identity(t)

    def _resolve_identity(self, t: Track) -> None:
        counts: dict[str | None, list[tuple[float, str | None]]] = {}
        for pid, score, name in t.votes:
            counts.setdefault(pid, []).append((score, name))
        best_pid = max(counts, key=lambda k: len(counts[k]))
        n = len(counts[best_pid])
        if best_pid is not None and n >= 2:
            scores = [s for s, _ in counts[best_pid]]
            t.person_id, t.label = best_pid, counts[best_pid][-1][1]
            t.match_score = float(np.mean(scores))
        elif t.person_id is None and len(t.votes) >= 3 and t.label is None:
            self._unknown_counter += 1
            t.label = f"UNKNOWN PERSON {self._unknown_counter:02d}"
            t.match_score = float(max(s for _, s, _ in t.votes))
        elif t.person_id is not None and best_pid is None and n >= 4:
            # identity lost (e.g. person swapped under the same box): demote
            self._unknown_counter += 1
            t.person_id, t.label = None, f"UNKNOWN PERSON {self._unknown_counter:02d}"

    def _maybe_announce(self, t: Track, ts: float, res: VisionResult) -> None:
        if not t.label or t.hits < STABLE_HITS or t.enroll_name is not None:
            return
        key = t.person_id or f"track:{t.track_id}"
        if t.announced_key == key:
            return
        if t.person_id and ts - self._last_announce.get(t.person_id, -1e9) < self.encounter_debounce_s:
            t.announced_key = key  # seen recently via another track; don't spam
            return
        t.announced_key = key
        if t.person_id:
            self._last_announce[t.person_id] = ts
        res.events.append(self._encounter_event(t))

    def _encounter_event(self, t: Track) -> dict[str, Any]:
        people = [{"id": t.person_id, "name": t.label, "enrolled": True}] if t.person_id else []
        return make_event(
            "person.encountered",
            {
                "track_id": t.track_id,
                "person_id": t.person_id,
                "label": t.label,
                "bbox": list(t.bbox),
                "match_score": round(t.match_score, 3),
            },
            source=self.source,
            confidence=max(0.0, min(1.0, t.match_score)) if t.person_id else 0.0,
            people=people,
        )

    def _finalize_enroll(self, t: Track, res: VisionResult) -> None:
        name = t.enroll_name or t.label or "unknown"
        samples = list(t.enroll_buf)
        t.enroll_name, t.enroll_buf = None, []
        if len(samples) < 1:
            return
        p = self.store.add(name, samples, src="live")
        t.person_id, t.label, t.match_score = p.person_id, p.name, 1.0
        t.votes.clear()
        log.info("enrolled %s with %d samples (total %d)", p.person_id, len(samples), len(p.embeddings))
        res.events.append(
            make_event(
                "person.enrolled",
                {"person_id": p.person_id, "name": p.name, "samples": len(samples)},
                source=self.source,
                people=[{"id": p.person_id, "name": p.name, "enrolled": True}],
            )
        )
        t.announced_key = None
        self._last_announce.pop(p.person_id, None)
        res.events.append(self._encounter_event(t))
        t.announced_key = p.person_id
        self._last_announce[p.person_id] = time.time()

    def _finish_expired(self, expired: list[Track], res: VisionResult) -> list[Track]:
        for t in expired:
            if t.enroll_name is not None and len(t.enroll_buf) >= MIN_ENROLL_SAMPLES:
                self._finalize_enroll(t, res)
            elif t.enroll_name is not None:
                log.warning("track %s left before enough enroll samples (%d)", t.track_id, len(t.enroll_buf))
        return expired
