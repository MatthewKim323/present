"""Opt-in enrolled people store (perception/data/people.json, gitignored).

Only embeddings + names are persisted, never images. Matching is local cosine
similarity against this set only.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .events import slug

TOP_K = 3


@dataclass
class Person:
    person_id: str
    name: str
    embeddings: list[np.ndarray] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)  # parallel to embeddings: "live" | "photo:<file>"
    meta: dict = field(default_factory=dict)  # optional role/company for HUD


def score_against(emb: np.ndarray, gallery: list[np.ndarray], k: int = TOP_K) -> float:
    """Mean of the top-k cosine similarities (embeddings are L2-normalized)."""
    if not gallery:
        return -1.0
    sims = np.stack(gallery) @ emb
    kk = min(k, len(sims))
    return float(np.sort(sims)[-kk:].mean())


class PeopleStore:
    def __init__(self, path: Path | None, threshold: float = 0.40) -> None:
        self.path = Path(path) if path else None
        self.threshold = threshold
        self.people: dict[str, Person] = {}
        self._lock = threading.Lock()
        if self.path and self.path.exists():
            self.load()

    # persistence
    def load(self) -> None:
        raw = json.loads(self.path.read_text())
        for pid, p in raw.get("people", {}).items():
            embs = [np.asarray(e["v"], dtype=np.float32) for e in p.get("embeddings", [])]
            srcs = [e.get("src", "live") for e in p.get("embeddings", [])]
            self.people[pid] = Person(pid, p.get("name", pid), embs, srcs, p.get("meta", {}))

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        out = {
            "version": 1,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "people": {
                pid: {
                    "name": p.name,
                    "meta": p.meta,
                    "embeddings": [
                        {"v": [round(float(x), 6) for x in e], "src": s} for e, s in zip(p.embeddings, p.sources)
                    ],
                }
                for pid, p in self.people.items()
            },
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(out))
        tmp.replace(self.path)

    # mutation
    def add(self, name: str, embeddings: list[np.ndarray], src: str = "live", save: bool = True) -> Person:
        pid = slug(name) or "person"
        with self._lock:
            p = self.people.get(pid) or Person(pid, name.strip())
            p.name = name.strip() or p.name
            p.embeddings.extend(embeddings)
            p.sources.extend([src] * len(embeddings))
            self.people[pid] = p
        if save:
            self.save()
        return p

    def replace_source(self, name: str, embeddings: list[np.ndarray], srcs: list[str], prefix: str) -> Person:
        """Drop embeddings whose src starts with prefix, then add the new ones (re-running photo enroll is idempotent)."""
        pid = slug(name) or "person"
        with self._lock:
            p = self.people.get(pid) or Person(pid, name.strip())
            keep = [(e, s) for e, s in zip(p.embeddings, p.sources) if not s.startswith(prefix)]
            p.embeddings = [e for e, _ in keep] + list(embeddings)
            p.sources = [s for _, s in keep] + list(srcs)
            self.people[pid] = p
        return p

    def remove(self, person_id: str) -> bool:
        with self._lock:
            ok = self.people.pop(person_id, None) is not None
        if ok:
            self.save()
        return ok

    def match_name(self, name: str) -> str | None:
        pid = slug(name)
        return pid if pid in self.people else None

    # matching
    def match(self, emb: np.ndarray, exclude: str | None = None) -> tuple[str | None, str | None, float]:
        """Best enrolled match. Returns (person_id, name, score); ids are None below threshold."""
        best_id, best_name, best = None, None, -1.0
        with self._lock:
            for pid, p in self.people.items():
                if pid == exclude or not p.embeddings:
                    continue
                s = score_against(emb, p.embeddings)
                if s > best:
                    best_id, best_name, best = pid, p.name, s
        if best < self.threshold:
            return None, None, best
        return best_id, best_name, best
