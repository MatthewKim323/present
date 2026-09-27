"""Procedural memory on the HUD: Memorable made visible, separate from GBrain's declarative memory.

  Builder coder starts           -> procedure {phase: recording, tool_calls_seen: n}   (ticks up via builder.TOOL_TAPS)
  Builder POSTs /v1/extract      -> procedure {phase: extracting}
  draft admitted / refused       -> procedure {phase: learned, steps, trigger, gbrain_slug} | {phase: refused, reason}
  recalled before the coder runs -> procedure {phase: recalled, steps}
  QM posts POST /procedures      -> procedure {phase: learned | recalled, source: qm-swarm, gbrain_slug}
  any learn / recall             -> procedure_library snapshot (count, last titles, uses)

Library = local Builder drafts (perception/data/procedures/*.json, written by builder.ProcedureMemory) plus an index
(perception/data/procedure_library.json) of QM-learned titles, GBrain slugs and recall counts. QM drafts stay out of
procedures/ so the Builder's lexical recall only ever sees Builder procedures.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import builder as builder_mod
from .builder import _redact

log = logging.getLogger("world.procfeed")

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]
PHASES = ("recording", "extracting", "learned", "recalled", "refused")
MAX_STEPS = 12
RECORD_THROTTLE_S = 0.35  # coalesce bursts of tool calls into one recording tick


def source_of(origin: dict[str, Any] | None) -> str:
    h = str((origin or {}).get("harness") or (origin or {}).get("source") or "").lower()
    return "claude-code" if h in ("claude-code", "claude_code", "builder") else "qm-swarm"


def step_target(st: dict[str, Any]) -> str | None:
    """Short, redacted HUD target for one Memorable step: first line of the command / path, or its first target."""
    raw = st.get("target") or st.get("command") or ", ".join(st.get("targets") or []) or ""
    s = " ".join(str(raw).strip().splitlines()[0].split()) if str(raw).strip() else ""
    if not s:
        return None
    s = _redact(s)
    if " " not in s and len(s) > 56:  # a path: keep the tail
        return "…" + s[-55:]
    return s if len(s) <= 56 else s[:55] + "…"


def slim_steps(steps: Any) -> list[dict[str, Any]]:
    out = []
    for i, st in enumerate(steps or []):
        if not isinstance(st, dict):
            continue
        d: dict[str, Any] = {"seq": st.get("seq") or i + 1, "action": str(st.get("action") or "step")[:24],
                             "activity_class": str(st.get("activity_class") or "execute")[:16]}
        tgt = step_target(st)
        if tgt:
            d["target"] = tgt
        out.append(d)
    return out[:MAX_STEPS]


def trigger_of(doc: dict[str, Any]) -> str | None:
    sig = doc.get("trigger_signature") or {}
    t = doc.get("trigger") or doc.get("task") or sig.get("summary_text")
    return " ".join(str(t).split())[:120] if t else None


def procedure_msg(phase: str, source: str, *, doc: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
    """contracts/EVENTS.md `procedure` HUD message. None-valued fields are dropped."""
    assert phase in PHASES, phase
    m: dict[str, Any] = {"kind": "procedure", "phase": phase, "source": source}
    if doc:
        m["title"] = doc.get("title")
        steps = doc.get("steps")
        if isinstance(steps, list):
            m["steps"] = slim_steps(steps)
            if len(steps) > MAX_STEPS:
                m["steps_total"] = len(steps)
        m["trigger"] = trigger_of(doc)
    for k, v in kw.items():
        m[k] = v
    return {k: v for k, v in m.items() if v is not None}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ProcFeed:
    def __init__(self, broadcast: Broadcast, procedures_dir: Path, index_path: Path | None = None) -> None:
        self.broadcast = broadcast
        self.dir = Path(procedures_dir)
        self.index_path = Path(index_path) if index_path else self.dir.parent / "procedure_library.json"
        self.counts: dict[str, int] = {}  # job_id -> tool calls captured so far
        self.recording: dict[str, dict[str, Any]] = {}  # job_id -> base recording msg fields
        self._pending: set[str] = set()
        builder_mod.TOOL_TAPS.append(self.on_tool)

    def close(self) -> None:
        if self.on_tool in builder_mod.TOOL_TAPS:
            builder_mod.TOOL_TAPS.remove(self.on_tool)

    # ------------------------------------------------------------ library

    def _index(self) -> dict[str, Any]:
        try:
            d = json.loads(self.index_path.read_text())
            return d if isinstance(d, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_index(self, idx: dict[str, Any]) -> None:
        try:
            self.index_path.parent.mkdir(parents=True, exist_ok=True)
            self.index_path.write_text(json.dumps(idx, indent=1))
        except OSError:
            log.exception("procedure index write failed")

    def _touch(self, title: str, **fields: Any) -> None:
        idx = self._index()
        e = idx.setdefault(title.lower(), {"title": title})
        uses = fields.pop("uses_inc", 0)
        e["uses"] = int(e.get("uses") or 0) + uses
        for k, v in fields.items():
            if v is not None and (k not in e or k in ("gbrain_slug",)):
                e[k] = v
        self._save_index(idx)

    def drafts(self) -> list[dict[str, Any]]:
        out = []
        if not self.dir.exists():
            return out
        for p in sorted(self.dir.glob("*.json")):
            try:
                d = json.loads(p.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(d, dict) and d.get("title"):
                out.append({**d, "_path": str(p), "_mtime": p.stat().st_mtime})
        return out

    def procedures(self) -> list[dict[str, Any]]:
        """Every known procedure, newest first: local Builder drafts merged with the index (QM, slugs, uses)."""
        idx = self._index()
        seen: dict[str, dict[str, Any]] = {}
        for d in self.drafts():
            k = d["title"].lower()
            e = idx.get(k, {})
            seen[k] = {"title": d["title"], "source": e.get("source") or "claude-code", "steps_count": len(d.get("steps") or []),
                       "steps": slim_steps(d.get("steps")), "trigger": trigger_of(d), "learned_at": e.get("learned_at") or _iso(d["_mtime"]),
                       "uses": int(e.get("uses") or 0), "gbrain_slug": e.get("gbrain_slug"), "path": d["_path"],
                       "_ts": e.get("learned_ts") or d["_mtime"]}
        for k, e in idx.items():
            if k in seen or not e.get("learned_at"):  # recall-only index rows without a draft are not procedures we hold
                continue
            seen[k] = {"title": e.get("title"), "source": e.get("source") or "qm-swarm", "steps_count": e.get("steps_count"),
                       "steps": e.get("steps") or [], "trigger": e.get("trigger"), "learned_at": e.get("learned_at"),
                       "uses": int(e.get("uses") or 0), "gbrain_slug": e.get("gbrain_slug"), "path": None,
                       "_ts": e.get("learned_ts") or 0}
        out = sorted(seen.values(), key=lambda x: x["_ts"], reverse=True)
        for x in out:
            x.pop("_ts")
        return out

    def library_msg(self) -> dict[str, Any]:
        items = [{k: p[k] for k in ("title", "steps_count", "source", "learned_at", "uses", "gbrain_slug")} for p in self.procedures()]
        return {"kind": "procedure_library", "items": items}

    async def send_library(self) -> None:
        await self._send(self.library_msg())

    async def _send(self, msg: dict[str, Any]) -> None:
        try:
            await self.broadcast(msg)
        except Exception:  # noqa: BLE001
            log.exception("procfeed broadcast failed")

    # ------------------------------------------------------------ Builder phases

    def on_tool(self, job_id: str, tool: str, inp: dict[str, Any]) -> None:
        """builder.TOOL_TAPS: count calls, send a coalesced recording tick (sync caller, so schedule the send)."""
        if tool not in builder_mod.CANON:
            return
        self.counts[job_id] = self.counts.get(job_id, 0) + 1
        if job_id not in self.recording or job_id in self._pending:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._pending.add(job_id)
        loop.create_task(self._tick(job_id))

    async def _tick(self, job_id: str) -> None:
        await asyncio.sleep(RECORD_THROTTLE_S)
        self._pending.discard(job_id)
        base = self.recording.get(job_id)
        if base is not None:
            await self._send({**base, "tool_calls_seen": self.counts.get(job_id, 0)})

    async def builder_phase(self, phase: str, job: Any, *, doc: dict[str, Any] | None = None, **kw: Any) -> None:
        """Called by builder.Builder. job: builder.Job."""
        ids = {"event_id": job.event_id, "job_id": job.id}
        if phase == "recording":
            base = procedure_msg("recording", "claude-code", title=job.feature,
                                 trigger=builder_mod.ProcedureMemory.task_line(job.spec), **ids)
            self.recording[job.id] = base
            self.counts.setdefault(job.id, 0)
            await self._send({**base, "tool_calls_seen": self.counts[job.id]})
            return
        if phase in ("extracting", "learned", "refused"):
            self.recording.pop(job.id, None)
        seen = self.counts.get(job.id)
        msg = procedure_msg(phase, "claude-code", doc=doc, tool_calls_seen=seen, **ids, **kw)
        if phase in ("extracting", "refused") and "title" not in msg:
            msg["title"] = job.feature
        await self._send(msg)
        if phase == "learned" and doc and doc.get("title"):
            self._touch(doc["title"], source="claude-code", gbrain_slug=kw.get("gbrain_slug"), learned_at=_iso(time.time()), learned_ts=time.time(),
                        steps_count=len(doc.get("steps") or []), trigger=trigger_of(doc))
            await self.send_library()
        elif phase == "recalled" and doc and doc.get("title"):
            self._touch(doc["title"], uses_inc=1, gbrain_slug=kw.get("gbrain_slug"))
            await self.send_library()

    # ------------------------------------------------------------ QM (POST /procedures)

    async def reported(self, kind: str, draft: dict[str, Any], origin: dict[str, Any] | None, gbrain_slug: str | None) -> dict[str, Any]:
        """A harness (QM swarm) reported a learned / recalled Memorable draft."""
        origin = origin or {}
        phase = kind if kind in ("learned", "recalled", "refused") else "learned"
        src = source_of(origin)
        msg = procedure_msg(phase, src, doc=draft, event_id=origin.get("event_id"), job_id=origin.get("job_id"),
                            gbrain_slug=gbrain_slug, admitted=True if phase == "learned" else None,
                            reason=origin.get("reason") if phase == "refused" else None)
        await self._send(msg)
        title = draft.get("title")
        if title and phase == "learned":
            self._touch(title, source=src, gbrain_slug=gbrain_slug, learned_at=_iso(time.time()), learned_ts=time.time(),
                        steps_count=len(draft.get("steps") or []) or draft.get("steps_count"),
                        steps=slim_steps(draft.get("steps")), trigger=trigger_of(draft))
            await self.send_library()
        elif title and phase == "recalled":
            self._touch(title, uses_inc=1, gbrain_slug=gbrain_slug)
            await self.send_library()
        return msg


def add_procedure_routes(app: Any, feed: ProcFeed) -> None:
    @app.get("/procedures")
    async def get_procedures():
        items = feed.procedures()
        return {"count": len(items), "items": items}
