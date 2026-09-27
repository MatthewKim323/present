"""Director console: run the demo by hand from the laptop when ASR or recognition flakes on stage.

  GET  /director                 the page (plain HTML+JS, director.html); /director?token=... stores the token
  GET  /director/api/status      last 30 HUD messages, QM swarm lanes, builder jobs, gbrain op count, health bits
  POST /director/api/action      {action: recognized | intro | facts | recap | streak | watch | reset | forget_face | reload_people}

Every action goes through the same paths the live pipeline uses: WorldEvents through svc.emit (GBrain, QMSink, HUD,
BuilderSink), the intro line through svc.add_utterance like POST /debug/utterance. Auth: bearer (or ?token=) equal
to DIRECTOR_TOKEN, else WORLD_HOOKS_SECRET; with neither set the console is open (localhost dev).
"""
from __future__ import annotations

import os
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from . import demo_inject as demo
from .conversation import Utterance

PAGE = Path(__file__).with_name("director.html")
RECENT_N = 30
SKIP_KINDS = {"vision", "face_capture", "tracks"}


def expected_token() -> str:
    return os.environ.get("DIRECTOR_TOKEN") or os.environ.get("WORLD_HOOKS_SECRET") or ""


def check_token(authorization: str | None, token: str | None) -> None:
    want = expected_token()
    if not want:
        return
    got = (authorization or "").removeprefix("Bearer ").removeprefix("bearer ").strip() or (token or "")
    if got != want:
        raise HTTPException(401, "bad director token")


def _s(x: Any, n: int = 90) -> str:
    s = " ".join(str(x).split()) if x is not None else ""
    return s if len(s) <= n else s[: n - 1] + "…"


def summarize(msg: dict[str, Any]) -> str:
    """One short line per HUD message for the status column (never page bodies or images)."""
    k = msg.get("kind")
    if k == "person_card":
        return _s(" · ".join(x for x in (msg.get("name"), msg.get("subtitle"), msg.get("you_owe") and f"you owe: {msg['you_owe']}") if x))
    if k == "memory_event":
        return _s(" · ".join(x for x in (msg.get("text"), msg.get("detail")) if x))
    if k == "context_delta":
        return _s(msg.get("text"))
    if k in ("agent_activity", "qm_swarm"):
        lanes = ", ".join(f"{w.get('name')}:{w.get('state')}" for w in msg.get("workers") or [])
        return _s(f"{msg.get('hook')} [{lanes}]")
    if k == "gbrain_op":
        return _s(" ".join(str(x) for x in (msg.get("actor"), msg.get("op"), msg.get("slug") or msg.get("query")) if x))
    if k == "procedure":
        return _s(" · ".join(str(x) for x in (msg.get("phase"), msg.get("source"), msg.get("title")) if x))
    if k == "procedure_library":
        return f"{len(msg.get('items') or [])} procedures"
    if k == "dev_github":
        return _s(", ".join(f"#{p.get('number')} {p.get('checks')}" for p in msg.get("prs") or []) or "no PRs")
    if k == "preview_shot":
        return _s(f"PR #{msg.get('pr')} · {msg.get('title')}")
    if k == "relationship_vector":
        return _s(f"{msg.get('name')} · {msg.get('facts_count')} facts")
    return ""


class DirectorLog:
    """Hub tap: recent HUD lines (consecutive duplicates fold into a count) + per-kind counters."""

    def __init__(self, n: int = RECENT_N) -> None:
        self.recent: deque[dict[str, Any]] = deque(maxlen=n)
        self.counts: Counter[str] = Counter()
        self.actions: deque[dict[str, Any]] = deque(maxlen=20)

    def __call__(self, msg: dict[str, Any]) -> None:
        k = str(msg.get("kind") or "?")
        if k in SKIP_KINDS:
            return
        self.counts[k] += int(msg.get("count") or 1) if k == "gbrain_op" else 1
        line = {"t": round(time.time(), 2), "kind": k, "text": summarize(msg)}
        last = self.recent[-1] if self.recent else None
        if last and last["kind"] == k and last["text"] == line["text"]:
            last["n"] = last.get("n", 1) + 1
            last["t"] = line["t"]
            return
        self.recent.append(line)


class Director:
    def __init__(self, svc: Any) -> None:
        self.svc = svc
        self.log = DirectorLog()
        svc.hub.taps.append(self.log)
        self.track_id = 4  # anchor used when no real face track is in view (matches the mock card)

    def _anchor(self) -> int:
        t = self.svc.vision.primary_track()
        return t.track_id if t else self.track_id

    async def _emit(self, ev: dict[str, Any]) -> dict[str, Any]:
        await self.svc.emit(ev)
        return {"event_id": ev["id"], "type": ev["type"]}

    async def act(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        svc = self.svc
        if action == "recognized":
            tid = self._anchor()
            svc.conv.person_seen("matthew", "Matthew", time.time())
            return await self._emit(demo.encountered(track_id=tid, score=0.81))
        if action == "intro":
            text = body.get("text") or "Hey, I'm Matthew."
            await svc.add_utterance(Utterance(time.time(), text, -30.0, "other person"))
            target = svc.intro.target_track()
            note = (f"learning track {target.track_id}" if target and "matthew" not in svc.store.people else
                    "matthew is already enrolled (run take.sh --fresh-face first)" if "matthew" in svc.store.people else
                    "no unknown face in view: intro only enrolls a tracked face")
            return {"said": text, "note": note}
        if action == "facts":
            return await self._emit(demo.facts_event())
        if action in ("recap", "streak"):
            spec = demo.FEATURE_REQUEST if action == "recap" else demo.FEATURE_REQUEST_2
            out = await self._emit(demo.feature_request_event(spec, anchor_track_id=self._anchor()))
            out["qm"] = bool(getattr(svc.qm, "base_url", ""))
            out["builder_auto"] = bool(svc.builder.cfg.auto)
            return out
        if action == "watch":
            return await self._emit(demo.watch_event(body.get("instruction") or demo.WATCH_INSTRUCTION))
        if action == "reset":
            svc.devfeed.reset()
            await svc.hub.broadcast({"kind": "clear"})
            return {"cleared": True}
        if action == "forget_face":
            pid = body.get("person_id") or "matthew"
            return {"removed": svc.store.remove(pid), "person_id": pid, "enrolled": sorted(svc.store.people)}
        if action == "reload_people":
            svc.store.load()
            return {"enrolled": sorted(svc.store.people)}
        raise HTTPException(422, f"unknown action {action!r}")

    def status(self) -> dict[str, Any]:
        svc = self.svc
        jobs = sorted(svc.builder.jobs.values(), key=lambda j: j.created, reverse=True)[:4]
        g = svc.gbrain.status() if hasattr(svc.gbrain, "status") else {"backend": "stub"}
        return {
            "t": round(time.time(), 2),
            "recent": list(self.log.recent)[::-1],
            "counts": dict(self.log.counts),
            "gbrain_ops": self.log.counts.get("gbrain_op", 0),
            "gbrain": g,
            "swarm": svc.devfeed.swarm_msg(),
            "jobs": [{"id": j.id, "event_id": j.event_id, "feature": j.feature, "state": j.state, "note": j.note,
                      "pr": j.pr_number, "pr_url": j.pr_url, "elapsed_s": int(time.time() - j.created),
                      "timings": j.timings} for j in jobs],
            "enrolled": sorted(svc.store.people),
            "tracks": [svc.vision.track_view(t) for t in svc.vision.tracker.tracks.values()],
            "hud_clients": len(svc.hub.clients),
            "qm_url": getattr(svc.qm, "base_url", "") or None,
            "builder_auto": bool(svc.builder.cfg.auto),
            "actions": list(self.log.actions)[::-1],
        }


def add_director_routes(app: FastAPI, svc: Any) -> Director:
    d = Director(svc)
    app.state.director = d

    @app.get("/director", response_class=HTMLResponse)
    async def director_page():
        return HTMLResponse(PAGE.read_text())

    @app.get("/director/api/status")
    async def director_status(authorization: str | None = Header(None), token: str | None = Query(None)):
        check_token(authorization, token)
        return d.status()

    @app.post("/director/api/action")
    async def director_action(body: dict[str, Any], authorization: str | None = Header(None), token: str | None = Query(None)):
        check_token(authorization, token)
        action = str(body.get("action") or "")
        out = await d.act(action, body)
        d.log.actions.append({"t": round(time.time(), 2), "action": action, **{k: v for k, v in out.items() if k in ("event_id", "note")}})
        return {"ok": True, "action": action, **out}

    return d
