"""Pluggable WorldEvent sinks: GBrain (remember), QM (act), HUD (show).

Every WorldEvent fans out to all sinks concurrently; one failing sink never blocks the others.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

import httpx

log = logging.getLogger("world.sinks")


class Sink(Protocol):
    name: str

    async def emit(self, event: dict[str, Any]) -> None: ...


class GBrainSink(Protocol):
    """Declarative/episodic memory. Also the HUD's source for person cards."""

    name: str

    async def emit(self, event: dict[str, Any]) -> None: ...

    async def person_context(self, person_id: str) -> dict[str, Any] | None:
        """Return {subtitle, last, owes_you, you_owe} for the person card, or None."""
        ...


class StubGBrainSink:
    """In-process stand-in for GBrain.

    Appends events to a local JSONL (events only, never transcripts/footage) and answers
    person_context() from what it has seen this run plus optional meta in people.json.

    TODO(gbrain): replace with the real client once hosted vs local GBrain is decided:
      - person.encountered / person.enrolled -> put_page people/<person_id> + timeline entry
      - conversation.completed -> timeline entry on each speaker's page (summary only)
      - decision/commitment/customer_feedback/physical_bug -> put_page + add_link to person + project
      - person_context -> get_page people/<id> (role/company) + open commitments via backlinks
    """

    name = "gbrain"

    def __init__(self, log_path: Path | None = None, people_meta: Callable[[str], dict] | None = None) -> None:
        self.log_path = log_path
        self.people_meta = people_meta or (lambda pid: {})
        self.events: list[dict[str, Any]] = []

    async def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        if self.log_path:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a") as f:
                f.write(json.dumps(event) + "\n")

    async def person_context(self, person_id: str) -> dict[str, Any] | None:
        meta = self.people_meta(person_id) or {}
        ctx: dict[str, Any] = {
            "subtitle": meta.get("subtitle") or " · ".join(x for x in (meta.get("role"), meta.get("company")) if x) or None,
            "last": meta.get("last"),
            "owes_you": meta.get("owes_you"),
            "you_owe": meta.get("you_owe"),
        }
        for ev in reversed(self.events):
            ids = {p.get("id") for p in ev.get("people", [])}
            if person_id not in ids:
                continue
            p = ev.get("payload", {})
            if ctx["last"] is None and ev["type"] == "conversation.completed" and p.get("summary"):
                ctx["last"] = p["summary"][:60]
            if ev["type"] == "customer_feedback.detected" and ctx["last"] is None:
                ctx["last"] = " ".join(x for x in (p.get("product"), p.get("feature")) if x) or None
            if ev["type"] == "commitment.detected":
                actor = (p.get("actor") or "").lower()
                if actor.startswith(person_id) or actor == (meta.get("name") or "").lower():
                    ctx["owes_you"] = ctx["owes_you"] or p.get("commitment")
                else:
                    ctx["you_owe"] = ctx["you_owe"] or p.get("commitment")
        return ctx


class QMSink:
    """POST every WorldEvent to <QM_URL>/world-events. No-op when QM_URL is unset."""

    name = "qm"

    def __init__(
        self,
        base_url: str,
        client: httpx.AsyncClient | None = None,
        timeout: float = 5.0,
        secret: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = client or httpx.AsyncClient(timeout=timeout)
        self.secret = secret if secret is not None else os.environ.get("WORLD_HOOKS_SECRET", "")

    async def emit(self, event: dict[str, Any]) -> None:
        if not self.base_url:
            return
        headers = {"authorization": f"Bearer {self.secret}"} if self.secret else {}
        r = await self.client.post(f"{self.base_url}/world-events", json=event, headers=headers)
        if r.status_code >= 400:
            log.warning("QM rejected %s: %s %s", event["type"], r.status_code, r.text[:200])


MEMORY_TEXT = {
    "person.enrolled": "PERSON ENROLLED",
    "conversation.completed": "CONVERSATION REMEMBERED",
    "decision.detected": "DECISION REMEMBERED",
    "commitment.detected": "COMMITMENT REMEMBERED",
    "customer_feedback.detected": "CUSTOMER FEEDBACK REMEMBERED",
    "feature_request.detected": "FEATURE REQUEST REMEMBERED",
    "physical_bug.detected": "BUG REMEMBERED",
    "task.demonstrated": "TASK REMEMBERED",
    "world.task_requested": "TASK REQUESTED",
    "object.state_changed": "OBJECT UPDATED",
    "object.last_seen": "OBJECT SEEN",
}


def memory_detail(event: dict[str, Any]) -> str:
    p = event.get("payload", {})
    t = event["type"]
    if t == "customer_feedback.detected":
        return " ".join(x for x in (p.get("product"), p.get("feature")) if x) or (p.get("feedback") or "")[:48]
    if t == "feature_request.detected":
        return " · ".join(x for x in (p.get("product"), p.get("feature")) if x) or (p.get("request") or "")[:48]
    if t == "commitment.detected":
        return p.get("commitment") or ""
    if t == "decision.detected":
        return p.get("decision") or ""
    if t == "physical_bug.detected":
        return " · ".join(x for x in (p.get("device"), p.get("symptom")) if x)
    if t == "conversation.completed":
        names = [x.get("name") for x in event.get("people", [])[1:] if x.get("name")]
        return ("with " + ", ".join(names)) if names else f"{p.get('utterances', 0)} utterances"
    if t == "person.enrolled":
        return f"{p.get('name')} · {p.get('samples')} samples"
    if t in ("task.demonstrated", "world.task_requested"):
        return p.get("instruction") or ""
    return p.get("object") or ""


class HudSink:
    """Turns WorldEvents into HUD messages (memory_event, person_card) and broadcasts them."""

    name = "hud"

    def __init__(self, broadcast: Callable[[dict[str, Any]], Awaitable[None]], gbrain: GBrainSink | None = None) -> None:
        self.broadcast = broadcast
        self.gbrain = gbrain

    async def emit(self, event: dict[str, Any]) -> None:
        t = event["type"]
        if t == "person.encountered":
            await self.broadcast(await self.person_card(event))
            return
        text = MEMORY_TEXT.get(t)
        if text:
            await self.broadcast({"kind": "memory_event", "text": text, "detail": memory_detail(event)})

    async def person_card(self, event: dict[str, Any]) -> dict[str, Any]:
        p = event["payload"]
        pid = p.get("person_id")
        ctx: dict[str, Any] = {}
        if pid and self.gbrain is not None:
            try:
                ctx = await self.gbrain.person_context(pid) or {}
            except Exception:
                log.exception("gbrain person_context failed")
        return {
            "kind": "person_card",
            "anchor_track_id": p.get("track_id"),
            "person_id": pid,
            "name": (p.get("label") or "").upper(),
            "subtitle": ctx.get("subtitle"),
            "last": ctx.get("last"),
            "owes_you": ctx.get("owes_you"),
            "you_owe": ctx.get("you_owe"),
        }


class FanOut:
    def __init__(self, sinks: list[Sink]) -> None:
        self.sinks = sinks
        # HUD should see GBrain's write before building a card, so run gbrain first, the rest in parallel
        self.ordered = sorted(sinks, key=lambda s: 0 if s.name == "gbrain" else 1)

    async def emit(self, event: dict[str, Any]) -> None:
        first = [s for s in self.ordered if s.name == "gbrain"]
        rest = [s for s in self.ordered if s.name != "gbrain"]
        for s in first:
            await self._safe(s, event)
        await asyncio.gather(*(self._safe(s, event) for s in rest))

    @staticmethod
    async def _safe(s: Sink, event: dict[str, Any]) -> None:
        try:
            await s.emit(event)
        except Exception as e:  # noqa: BLE001
            log.warning("sink %s failed on %s: %s", s.name, event.get("type"), e)
