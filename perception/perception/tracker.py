"""Greedy IoU tracker with centroid fallback. Gives stable track_ids across frames."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np

BBox = tuple[int, int, int, int]


def iou(a: BBox, b: BBox) -> float:
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    iw = max(0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def centroid_dist(a: BBox, b: BBox) -> float:
    """Centroid distance normalized by the larger box's diagonal-ish size."""
    ca = (a[0] + a[2] / 2, a[1] + a[3] / 2)
    cb = (b[0] + b[2] / 2, b[1] + b[3] / 2)
    scale = max(a[2], a[3], b[2], b[3], 1)
    return float(np.hypot(ca[0] - cb[0], ca[1] - cb[1]) / scale)


@dataclass
class Track:
    track_id: int
    bbox: BBox
    first_seen: float
    last_seen: float
    hits: int = 1
    # identity
    person_id: str | None = None
    label: str | None = None
    match_score: float = 0.0
    votes: deque = field(default_factory=lambda: deque(maxlen=5))  # recent (person_id|None, score)
    embeddings: deque = field(default_factory=lambda: deque(maxlen=20))
    last_embed_ts: float = 0.0
    # enrollment in progress
    enroll_name: str | None = None
    enroll_buf: list = field(default_factory=list)
    # encounter bookkeeping
    announced_key: str | None = None
    # user-attached
    extra: dict = field(default_factory=dict)

    @property
    def area(self) -> int:
        return self.bbox[2] * self.bbox[3]


class Tracker:
    def __init__(self, max_age_s: float = 1.0, iou_min: float = 0.25, centroid_max: float = 0.6) -> None:
        self.max_age_s = max_age_s
        self.iou_min = iou_min
        self.centroid_max = centroid_max
        self.tracks: dict[int, Track] = {}
        self._next_id = 1

    def update(self, boxes: list[BBox], ts: float) -> tuple[list[tuple[Track, int]], list[Track]]:
        """Associate detections to tracks.

        Returns (assigned, expired): assigned is a list of (track, detection_index) for every
        detection, expired lists tracks dropped this update.
        """
        pairs: list[tuple[float, int, int]] = []
        for tid, t in self.tracks.items():
            for di, b in enumerate(boxes):
                ov = iou(t.bbox, b)
                if ov >= self.iou_min:
                    pairs.append((1.0 + ov, tid, di))
                else:
                    d = centroid_dist(t.bbox, b)
                    if d <= self.centroid_max:
                        pairs.append((1.0 - d, tid, di))  # always ranks below any IoU match
        pairs.sort(reverse=True)
        used_t: set[int] = set()
        used_d: set[int] = set()
        assigned: list[tuple[Track, int]] = []
        for _, tid, di in pairs:
            if tid in used_t or di in used_d:
                continue
            t = self.tracks[tid]
            t.bbox, t.last_seen, t.hits = boxes[di], ts, t.hits + 1
            used_t.add(tid)
            used_d.add(di)
            assigned.append((t, di))
        for di, b in enumerate(boxes):
            if di in used_d:
                continue
            t = Track(self._next_id, b, ts, ts)
            self._next_id += 1
            self.tracks[t.track_id] = t
            assigned.append((t, di))
        expired = [t for t in self.tracks.values() if ts - t.last_seen > self.max_age_s]
        for t in expired:
            del self.tracks[t.track_id]
        assigned.sort(key=lambda x: x[1])
        return assigned, expired

    def expire(self, ts: float) -> list[Track]:
        """Drop stale tracks without a new frame (called from the tick loop)."""
        expired = [t for t in self.tracks.values() if ts - t.last_seen > self.max_age_s]
        for t in expired:
            del self.tracks[t.track_id]
        return expired
