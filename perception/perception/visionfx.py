"""Perception overlay feed: lets the headset show the machine SEE, RECOGNIZE and LEARN.

HUD messages (contracts/EVENTS.md), only for clients that asked (/ws/quest?debug=1 or ?vision=1):
  vision            ~5 Hz while faces are tracked: per track bbox, 5 landmarks, state, candidates, embedding barcode
  face_capture      one small face crop per learning sample (filmstrip). Made in memory, sent once, never persisted.
and for every HUD client:
  relationship_vector  per person after each GBrain relationship update (radar chart next to the person card)

Hooks: service._frame_worker -> VisionFx.after_frame(res); vision._identify -> capture_sample(); HudSink -> rel_vectors.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import time
from collections import Counter
from typing import Any

import numpy as np

log = logging.getLogger("world.visionfx")

VISION_HZ = 5.0
CROP_PX = 96
SIG_DIMS = 16
TOP_K = 3

# Fixed random projection 128 -> 16 for the "embedding barcode". Seeded, so the same face gives the
# same bars across runs. 16 squashed values of a 128-d embedding: a visual, not an identity key.
_PROJ = np.random.default_rng(20260927).standard_normal((SIG_DIMS, 128)).astype(np.float32)


def embedding_sig(emb: np.ndarray | None) -> list[float] | None:
    if emb is None:
        return None
    v = np.asarray(emb, dtype=np.float32).reshape(-1)
    if v.shape[0] != 128:
        return None
    z = _PROJ @ v  # each ~N(0, |v|^2) since rows are N(0,1)
    return [round(float(x), 2) for x in 0.5 + 0.5 * np.tanh(z * 0.9)]


def face_crop_b64(frame: np.ndarray, bbox, size: int = CROP_PX, quality: int = 70) -> str | None:
    """Square crop around the face bbox (+20% margin), size x size JPEG, base64. In memory only."""
    import cv2

    h, w = frame.shape[:2]
    x, y, bw, bh = (float(v) for v in bbox)
    side = max(bw, bh) * 1.2
    cx, cy = x + bw / 2, y + bh / 2
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(w, cx + side / 2)), int(min(h, cy + side / 2))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    crop = cv2.resize(frame[y0:y1, x0:x1], (size, size), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    del crop
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def capture_sample(t: Any, frame: np.ndarray, face: Any, res: Any) -> None:
    """Called by vision.py for each learning sample: queue a transient crop for the filmstrip."""
    try:
        jpg = face_crop_b64(frame, face.bbox)
    except Exception:  # noqa: BLE001
        log.debug("face crop failed", exc_info=True)
        jpg = None
    if jpg:
        res.captures.append({
            "kind": "face_capture", "track_id": t.track_id, "name": t.enroll_name,
            "n": len(t.enroll_buf), "needed": t.extra.get("enroll_needed", 12), "jpeg_b64": jpg,
        })


def track_state(t: Any) -> str:
    if t.enroll_name is not None:
        return "learning"
    if t.person_id:
        return "recognized"
    if t.label:
        return "unknown"
    return "matching" if t.votes else "detecting"


def landmarks(face: Any, fw: int, fh: int) -> list[list[float]] | None:
    row = getattr(face, "row", None)
    if row is None or len(row) < 14 or not fw or not fh:
        return None
    return [[round(float(row[4 + 2 * i]) / fw, 4), round(float(row[5 + 2 * i]) / fh, 4)] for i in range(5)]


def candidates(store: Any, emb: np.ndarray | None, k: int = TOP_K) -> list[dict[str, Any]]:
    """Top-k enrolled people by score (enrolled set only, never external)."""
    if emb is None:
        return []
    from .people import score_against

    out = []
    with store._lock:
        people = list(store.people.values())
    for p in people:
        if p.embeddings:
            out.append({"name": p.name, "score": round(max(0.0, score_against(emb, p.embeddings)), 3)})
    return sorted(out, key=lambda c: -c["score"])[:k]


def track_entry(t: Any, store: Any, fw: int, fh: int) -> dict[str, Any]:
    face = t.extra.get("face")
    emb = t.embeddings[-1] if t.embeddings else None
    state = track_state(t)
    x, y, w, h = t.bbox
    last_vote = t.votes[-1][1] if t.votes else 0.0
    score = t.match_score if t.person_id else float(last_vote)
    e = {
        "track_id": t.track_id,
        "bbox": [round(x / fw, 4), round(y / fh, 4), round(w / fw, 4), round(h / fh, 4)] if fw and fh else list(t.bbox),
        "landmarks": landmarks(face, fw, fh),
        "det_score": round(float(getattr(face, "score", 0.0) or 0.0), 3),
        "state": state,
        "person_id": t.person_id,
        "name": t.enroll_name if state == "learning" else t.label,
        "match_score": round(max(0.0, float(score)), 3),
        "top_candidates": candidates(store, emb),
        "embedding_sig": embedding_sig(emb),
    }
    if state == "learning":
        e["samples"] = {"n": len(t.enroll_buf), "needed": t.extra.get("enroll_needed", 12)}
    return e


def vision_message(tracks: list[Any], store: Any, fw: int, fh: int, ts: float | None = None) -> dict[str, Any]:
    return {"kind": "vision", "ts": round(ts or time.time(), 3), "w": fw, "h": fh,
            "tracks": [track_entry(t, store, fw, fh) for t in tracks]}


class VisionFx:
    """Sends vision + face_capture to opted-in clients; keeps the open conversation pointed at a just-learned person."""

    def __init__(self, svc: Any, hz: float = VISION_HZ) -> None:
        self.svc = svc
        self.clients: set = set()
        self.period = 1.0 / hz
        self._last = 0.0
        self._last_states: dict[int, str] = {}

    async def _send(self, msg: dict[str, Any]) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:  # noqa: BLE001
                self.clients.discard(ws)

    async def after_frame(self, res: Any) -> None:
        self._relabel_encounter(res)
        if not self.clients:
            res.captures.clear()
            return
        for cap in res.captures:
            await self._send(cap)
        res.captures.clear()  # crops are sent once, then gone
        tracks = list(self.svc.vision.tracker.tracks.values())
        states = {t.track_id: track_state(t) for t in tracks}
        now = time.monotonic()
        changed = states != self._last_states
        if not tracks and not self._last_states:
            return
        if changed or now - self._last >= self.period:
            self._last, self._last_states = now, states
            await self._send(vision_message(tracks, self.svc.store, res.frame_w, res.frame_h))

    def _relabel_encounter(self, res: Any) -> None:
        """A person just learned mid-conversation keeps the same encounter (live extraction then starts)."""
        cur = getattr(self.svc.conv, "current", None)
        if cur is None or cur.person_id:
            return
        for ev in res.events:
            if ev.get("type") != "person.encountered":
                continue
            p = ev.get("payload", {})
            if p.get("person_id") and cur.track_id in (None, p.get("track_id")):
                cur.person_id, cur.name, cur.track_id = p["person_id"], p.get("label"), p.get("track_id")
                return


# ---------------------------------------------------------------- relationship vectors

POS = ("excited", "love", "happy", "impressed", "keen", "eager", "positive", "enthusiastic", "likes", "interested", "great", "warm")
NEG = ("frustrat", "confus", "annoy", "angry", "upset", "skeptic", "disappoint", "negative", "worried", "unhappy", "blocked", "hate")


def _sentiment_value(text: str | None) -> float:
    s = (text or "").lower()
    if not s:
        return 0.5
    p = sum(w in s for w in POS)
    n = sum(w in s for w in NEG)
    if p == n:
        return 0.5
    return 0.8 if p > n else 0.22


def _recency(last_seen: str | None) -> float:
    if not last_seen:
        return 0.0
    from datetime import datetime

    try:
        ts = datetime.strptime(last_seen[:16], "%Y-%m-%d %H:%M").timestamp()
    except ValueError:
        return 0.0
    age_h = max(0.0, (time.time() - ts) / 3600)
    return round(math.exp(-age_h / 48), 3)


class RelationshipVectors:
    """Builds `relationship_vector` HUD messages from what GBrain (or its stub) knows about a person."""

    def __init__(self) -> None:
        self.kinds: dict[str, Counter] = {}
        self.seen_now: dict[str, float] = {}

    def observe(self, event: dict[str, Any]) -> str | None:
        t = event.get("type")
        p = event.get("payload", {})
        pid = p.get("person_id")
        if t == "relationship.updated" and pid:
            c = self.kinds.setdefault(pid, Counter())
            for d in p.get("deltas") or []:
                c[d.get("kind") or "fact"] += 1
            return pid
        if t in ("person.encountered", "person.enrolled") and pid:
            self.seen_now[pid] = time.time()
            return pid
        return None

    def build(self, gbrain: Any, pid: str, name: str | None = None, last_delta: str | None = None) -> dict[str, Any]:
        st = (getattr(gbrain, "rel", None) or {}).get(pid)
        kinds = self.kinds.get(pid, Counter())
        if st is not None:
            facts = len(st.facts)
            loops = len(st.you_owe) + len(st.owes_you)
            encounters = st.encounters
            sentiment = st.sentiment
            recency = _recency(st.last_seen)
            name = name or st.name
            last_delta = last_delta or (st.deltas[-1] if st.deltas else None)
            topics = kinds["topic"] + (1 if st.last_topic else 0) + len(st.recent)
        else:  # stub: count what this run has seen
            events = getattr(gbrain, "events", None) or getattr(getattr(gbrain, "fallback", None), "events", None) or []
            facts = kinds["fact"] + kinds["preference"] + kinds["shared_context"]
            loops = kinds["open_loop_you_owe"] + kinds["open_loop_owes_you"]
            encounters = topics = 0
            sentiment = None
            for ev in events:
                ids = {x.get("id") for x in ev.get("people", [])} | {ev.get("payload", {}).get("person_id")}
                if pid not in ids:
                    continue
                if ev["type"] == "person.encountered":
                    encounters += 1
                elif ev["type"] == "commitment.detected":
                    loops += 1
                elif ev["type"] in ("conversation.completed", "customer_feedback.detected", "feature_request.detected"):
                    topics += 1
                elif ev["type"] == "relationship.updated":
                    for d in ev.get("payload", {}).get("deltas") or []:
                        if d.get("kind") == "sentiment":
                            sentiment = d.get("text")
                        if d.get("kind") == "topic":
                            topics += 1
            recency = 0.0
        if time.time() - self.seen_now.get(pid, -1e9) < 600:
            recency = 1.0
        dims = [
            {"label": "familiarity", "value": round(1 - math.exp(-max(0, encounters) / 3), 3)},
            {"label": "knowledge", "value": round(min(1.0, facts / 10), 3)},
            {"label": "topics", "value": round(min(1.0, topics / 6), 3)},
            {"label": "open loops", "value": round(min(1.0, loops / 4), 3)},
            {"label": "warmth", "value": _sentiment_value(sentiment)},
            {"label": "recency", "value": recency},
        ]
        return {"kind": "relationship_vector", "person_id": pid, "name": (name or pid).upper(), "dims": dims,
                "facts_count": facts, "last_delta": last_delta}

    async def on_event(self, event: dict[str, Any], gbrain: Any, broadcast) -> None:
        pid = self.observe(event)
        if not pid:
            return
        p = event.get("payload", {})
        deltas = p.get("deltas") or []
        name = p.get("label") or p.get("name") or next((x.get("name") for x in event.get("people", []) if x.get("id") == pid), None)
        await broadcast(self.build(gbrain, pid, name, deltas[-1]["text"] if deltas else None))


rel_vectors = RelationshipVectors()
