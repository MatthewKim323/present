"""Reality creates standing watches and entity agents in QM.

Voice -> `world.watch_requested`: the WEARER says a standing instruction out loud ("next time Matthew
brings up pricing, prep a counter-offer", "remind me when he mentions the tournament", "keep an eye on
this"). A cheap regex prefilter runs on every utterance; only hits said by the wearer go to one small
Claude call (claude-haiku-4-5) that returns {is_watch, instruction, person_id, topic_terms, action}.
Without a model a deterministic parser handles the common "next time X brings up Y, Z" shape.
QM turns the event into a WorldWatch (see QM docs/worldhooks.md).

Pinch -> `world.entity_adopted`: the Quest's {kind:"gesture", type:"pinch", target_track_id} on a
recognized person adopts them as an entity with its own persistent QM thread. Debounced per person.

WatchBoard is a FanOut sink plus the QMSink response hook. It owns the HUD side:
  memory_event "WATCH ARMED" / "WATCH FIRED" / "AGENT ASSIGNED", an `armed_watches` snapshot, and
  the optional `agent` field on person cards (HudSink.agent_for).
QM does not post anything watch-specific to /hud, so a firing is read from QM's /world-events
response (`watches: [ids]`); POST /hud {kind:"watch_fired", watch_id} is accepted too.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import deque
from typing import Any, Awaitable, Callable

from .events import make_event, slug
from .intro import attribute

log = logging.getLogger("world.watches")

# Cheap gate before any model call. Wearer phrasing for standing, future-triggered instructions.
PREFILTER = re.compile(
    r"\b(?:next\s+time|whenever|every\s+time|keep\s+an?\s+eye|remind\s+me\s+(?:when|if|next)|watch\s+(?:for|out\s+for)|"
    r"let\s+me\s+know\s+(?:when|if)|flag\s+(?:it\s+)?(?:when|if)|if\s+(?:he|she|they)\s+(?:ever\s+)?(?:brings?|mentions?))\b",
    re.I,
)

WATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "is_watch": {"type": "boolean"},
        "instruction": {"type": "string"},
        "person_id": {"type": "string"},
        "topic_terms": {"type": "array", "items": {"type": "string"}},
        "action": {"type": "string"},
        "once": {"type": "boolean"},
    },
    "required": ["is_watch", "instruction", "person_id", "topic_terms", "action", "once"],
    "additionalProperties": False,
}

SYSTEM = """The wearer of smart glasses ({wearer_name}) just said one line out loud. Decide whether it is a STANDING INSTRUCTION to their own assistant that should trigger later: "next time X brings up Y, do Z", "remind me when he mentions Y", "keep an eye on this", "whenever Y comes up, Z".
Ordinary conversation to another person ("next time we should grab lunch", "whenever you're free") is NOT a watch: is_watch false.

Known people (id: name): {people}
Person currently in front of the wearer: {partner}. "he", "she", "him", "her", "them", "this person", "this" (when it points at the person) mean this person.

Return:
- is_watch: true only for a standing instruction to the assistant.
- instruction: the instruction restated as one plain sentence in the form "next time <Name> brings up <topic>, <action>" (or "whenever <Name> comes up, <action>" when there is no topic). Use real names, never pronouns.
- person_id: the id from the known list the watch is about, or "" if none.
- topic_terms: 1-3 short lowercase keywords that would appear in what is said later (e.g. ["pricing", "price"]); [] if no topic.
- action: what the assistant should do when it fires, imperative, short (e.g. "prep a counter-offer"). Default "brief me".
- once: true for "next time"/"once", false for "whenever"/"every time"/"keep an eye on"."""

_TOPIC_RE = re.compile(
    r"(?:brings?\s+up|mentions?|talks?\s+about|asks?\s+about|says|eye\s+on|watch\s+(?:out\s+)?for)\s+"
    r"(?P<topic>[a-z0-9 '_-]{2,40}?)(?:[,.;!?]|\s+(?:prep|prepare|draft|then|remind|send|make|tell|ping|let|and|flag)\b|$)",
    re.I,
)
_STOP = {"the", "a", "an", "his", "her", "their", "our", "my", "this", "that", "it", "again", "up", "about", "any", "some", "him", "them"}
_PRONOUN = re.compile(r"\b(?:he|she|him|her|they|them|this\s+person|this\s+guy|this)\b", re.I)


def prefilter(text: str) -> bool:
    return bool(PREFILTER.search(text or ""))


def fallback_parse(text: str, people: dict[str, str], partner: tuple[str | None, str | None]) -> dict[str, Any]:
    """Model-free parse: person by known name or pronoun -> partner, topic after 'brings up / mentions'."""
    t = (text or "").strip()
    lower = t.lower()
    if partner[0] and partner[1]:
        people = {**people, partner[0]: partner[1]}
    pid = next((p for p, name in people.items() if name and re.search(rf"\b{re.escape(name.lower())}\b", lower)), None)
    if pid is None and partner[0] and _PRONOUN.search(t):
        pid = partner[0]
    m = _TOPIC_RE.search(lower)
    terms = [w for w in (m.group("topic").split() if m else []) if w not in _STOP and len(w) > 2][:2]
    if terms and pid and people.get(pid, "").lower() in terms:
        terms = [w for w in terms if w != people[pid].lower()]
    action_m = re.search(r",\s*(.+)$", t)
    action = action_m.group(1).strip().rstrip(".") if action_m else "brief me"
    once = bool(re.search(r"\bnext\s+time\b|\bonce\b", lower))
    name = people.get(pid or "", "") or (partner[1] if pid and pid == partner[0] else "") or ""
    if terms:
        inst = f"next time {name or 'someone'} brings up {' '.join(terms)}, {action}"
    else:
        inst = f"whenever {name or 'this'} comes up, {action}"
    return {"is_watch": True, "instruction": inst, "person_id": pid or "", "topic_terms": terms, "action": action, "once": once}


class WatchRequester:
    """Wearer utterance -> world.watch_requested (prefilter, wearer-only, one Haiku call)."""

    def __init__(
        self,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
        *,
        wearer_id: str = "stephen",
        wearer_name: str = "Stephen",
        people: Callable[[], dict[str, str]] | None = None,
        model: str | None = None,
        client: Any = None,
        dedupe_s: float = 15.0,
    ) -> None:
        self.emit = emit
        self.wearer_id = wearer_id
        self.wearer_name = wearer_name
        self.people = people or (lambda: {})
        self.model = model or os.environ.get("WORLD_WATCH_MODEL", "claude-haiku-4-5")
        self.client = client
        self.dedupe_s = dedupe_s
        self.levels: deque[float] = deque(maxlen=16)
        self._recent: dict[str, float] = {}
        self.last_latency_ms: float | None = None
        self.rejected: list[tuple[str, str]] = []  # (why, text[:40]) for tests / health

    def build_request(self, text: str, partner: tuple[str | None, str | None]) -> dict[str, Any]:
        people = self.people()
        plist = ", ".join(f"{pid}: {name}" for pid, name in sorted(people.items()) if pid != self.wearer_id) or "none"
        pdesc = f'{partner[1]} (id "{partner[0]}")' if partner[0] else (partner[1] or "nobody identified")
        return {
            "model": self.model,
            "max_tokens": 300,
            "system": SYSTEM.format(wearer_name=self.wearer_name, people=plist, partner=pdesc),
            "messages": [{"role": "user", "content": f"Wearer said: {text}"}],
            "output_config": {"format": {"type": "json_schema", "schema": WATCH_SCHEMA}},
        }

    async def parse(self, text: str, partner: tuple[str | None, str | None]) -> dict[str, Any] | None:
        if self.client is None:
            return fallback_parse(text, self.people(), partner)
        t0 = time.perf_counter()
        try:
            resp = await self.client.messages.create(**self.build_request(text, partner))
            self.last_latency_ms = (time.perf_counter() - t0) * 1000
            if getattr(resp, "stop_reason", None) == "refusal":
                return None
            data = json.loads(next(b.text for b in resp.content if b.type == "text"))
            log.info("watch parse %.0fms: %s", self.last_latency_ms, data)
            return data
        except Exception:
            log.exception("watch parse failed; using the deterministic parser")
            return fallback_parse(text, self.people(), partner)

    async def on_utterance(self, u: Any, partner: tuple[str | None, str | None] = (None, None),
                           track_id: int | None = None) -> dict[str, Any] | None:
        text = getattr(u, "text", "") or ""
        prior = list(self.levels)
        rms = float(getattr(u, "rms_db", -30.0))
        self.levels.append(rms)
        if not prefilter(text):
            return None
        who, _ = attribute(getattr(u, "speaker", None), rms, prior + [rms])
        if who == "other":  # only the wearer arms watches; unclear (no tag, too few levels) is allowed
            self.rejected.append(("not the wearer", text[:40]))
            log.info("watch phrase from the other person ignored")
            return None
        data = await self.parse(text, partner)
        if not data or not data.get("is_watch"):
            self.rejected.append(("not a watch", text[:40]))
            return None
        people = self.people()
        pid = (data.get("person_id") or "").strip().lower() or None
        if pid and pid not in people and pid != partner[0]:
            pid = slug(pid) if slug(pid) in people else None
        if pid == self.wearer_id:
            pid = None
        terms = [t.strip().lower() for t in data.get("topic_terms") or [] if isinstance(t, str) and t.strip()][:3]
        instruction = (data.get("instruction") or text).strip()[:300]
        key = f"{pid}|{','.join(terms)}|{(data.get('action') or '').lower()}"
        now = time.time()
        if now - self._recent.get(key, -1e9) < self.dedupe_s:
            return None
        self._recent[key] = now
        name = people.get(pid or "") or (partner[1] if pid and pid == partner[0] else None)
        payload: dict[str, Any] = {
            "instruction": instruction,
            "topic_terms": terms,
            "action": (data.get("action") or "brief me").strip()[:200],
            "once": bool(data.get("once")),
        }
        if pid:
            payload["person_id"] = pid
            payload["person_name"] = name
        if track_id is not None:
            payload["track_id"] = track_id
        people_list = [{"id": self.wearer_id, "name": self.wearer_name, "enrolled": True}]
        if pid:
            people_list.append({"id": pid, "name": name, "enrolled": True})
        ev = make_event("world.watch_requested", payload, source="quest3s", confidence=0.9, people=people_list)
        await self.emit(ev)
        return ev


class PinchAdopter:
    """Pinch on a recognized person -> world.entity_adopted (debounced per person)."""

    def __init__(self, emit: Callable[[dict[str, Any]], Awaitable[None]], *, wearer_id: str = "stephen",
                 wearer_name: str = "Stephen", debounce_s: float | None = None) -> None:
        self.emit = emit
        self.wearer_id = wearer_id
        self.wearer_name = wearer_name
        self.debounce_s = debounce_s if debounce_s is not None else float(os.environ.get("WORLD_PINCH_DEBOUNCE_S", "10"))
        self._last: dict[str, float] = {}

    async def on_pinch(self, track: Any, now: float | None = None) -> dict[str, Any] | None:
        pid = getattr(track, "person_id", None)
        if track is None or not pid:
            return None  # unknown people are never adopted
        now = time.time() if now is None else now
        if now - self._last.get(pid, -1e9) < self.debounce_s:
            return None
        self._last[pid] = now
        label = getattr(track, "label", None) or pid
        ev = make_event(
            "world.entity_adopted",
            {"entity_kind": "person", "entity_id": pid, "label": label, "track_id": getattr(track, "track_id", None)},
            source="quest3s", confidence=1.0,
            people=[{"id": self.wearer_id, "name": self.wearer_name, "enrolled": True}, {"id": pid, "name": label, "enrolled": True}],
        )
        await self.emit(ev)
        return ev


class WatchBoard:
    """HUD state for watches and entity agents. A FanOut sink + QMSink.on_response hook."""

    name = "watches"

    def __init__(self, broadcast: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self.broadcast = broadcast
        self.watches: dict[str, dict[str, Any]] = {}   # world event id -> watch entry
        self.agents: dict[str, dict[str, Any]] = {}    # person_id -> agent badge

    # sink
    async def emit(self, event: dict[str, Any]) -> None:
        t = event.get("type")
        p = event.get("payload") or {}
        if t == "world.watch_requested":
            w = self._register(event)
            await self.broadcast({"kind": "memory_event", "text": "WATCH ARMED", "detail": self._detail(w)})
            await self.send_list()
        elif t == "world.entity_adopted" and p.get("entity_kind", "person") == "person" and p.get("entity_id"):
            pid = p["entity_id"]
            self.agents[pid] = {"state": "assigned", "label": p.get("label") or pid, "thread": f"world:entity:person:{pid.lower()}",
                                "since": time.time()}
            await self.broadcast({"kind": "memory_event", "text": "AGENT ASSIGNED", "detail": (p.get("label") or pid).upper()})

    def _register(self, event: dict[str, Any]) -> dict[str, Any]:
        """Entry for a watch request; idempotent (the QM reply can race the sink)."""
        if event["id"] in self.watches:
            return self.watches[event["id"]]
        p = event.get("payload") or {}
        terms = p.get("topic_terms") or []
        w = {
            "id": event["id"], "qm_id": None, "topic": terms[0] if terms else None, "topic_terms": terms,
            "person_id": p.get("person_id"), "person": p.get("person_name"), "instruction": p.get("instruction"),
            "action": p.get("action"), "once": bool(p.get("once")), "fired": 0, "state": "armed", "t": time.time(),
        }
        self.watches[event["id"]] = w
        return w

    def agent_for(self, pid: str | None) -> dict[str, Any] | None:
        a = self.agents.get(pid or "")
        return {"state": a["state"], "thread": a["thread"]} if a else None

    @staticmethod
    def _detail(w: dict[str, Any]) -> str:
        return " · ".join(x for x in (w.get("topic") or (w.get("action") or "")[:32], w.get("person")) if x)

    def armed(self) -> list[dict[str, Any]]:
        return [{k: w[k] for k in ("id", "qm_id", "topic", "person_id", "person", "action", "once", "fired", "state")}
                for w in self.watches.values() if w["state"] == "armed"]

    async def send_list(self) -> None:
        await self.broadcast({"kind": "armed_watches", "items": self.armed()})

    # QM feedback
    async def on_qm_response(self, event: dict[str, Any], status: int, body: Any) -> None:
        if not isinstance(body, dict):
            return
        t = event.get("type")
        if t == "world.watch_requested":
            w = self._register(event)
            qw = body.get("watch") if isinstance(body.get("watch"), dict) else None
            if status >= 400 or qw is None:
                w["state"] = "rejected"
                log.warning("QM did not create a watch for %s: %s %s", event["id"], status, str(body)[:160])
                await self.send_list()
                return
            w["qm_id"], w["once"], w["match"] = qw.get("id"), bool(qw.get("once")), qw.get("match")
            await self.send_list()
        elif t == "world.entity_adopted":
            pid = (event.get("payload") or {}).get("entity_id")
            if pid in self.agents and body.get("threadRef"):
                self.agents[pid]["thread"] = body["threadRef"]
        for qid in body.get("watches") or []:
            await self.fired(qid, event)

    async def fired(self, qm_id: str, event: dict[str, Any] | None = None) -> bool:
        w = next((x for x in self.watches.values() if x.get("qm_id") == qm_id), None)
        if w is None:
            await self.broadcast({"kind": "memory_event", "text": "WATCH FIRED", "detail": qm_id})
            return False
        w["fired"] += 1
        if w["once"]:
            w["state"] = "fired"
        await self.broadcast({"kind": "memory_event", "text": "WATCH FIRED", "detail": self._detail(w)})
        await self.send_list()
        return True
