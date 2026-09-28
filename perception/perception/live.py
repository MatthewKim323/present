"""Rolling (live) extraction: while a conversation is still going, learn about the person.

Every ~20s or every 4 new utterances, a cheap Claude pass (small/fast model) reads the in-memory
buffer of the open encounter and returns only NEW relationship deltas: facts, preferences, topics,
sentiment, shared context, open loops. Each pass emits one `relationship.updated` WorldEvent, which
GBrain persists immediately and the HUD turns into `context_delta` lines, so the person card
visibly compounds mid-conversation. The final full extraction still runs at conversation end
(extract.py). The transcript never leaves memory except as the prompt to Claude.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .conversation import Encounter
from .events import make_event
from .extract import format_transcript, make_anthropic_client

log = logging.getLogger("world.live")

DELTA_KINDS = ["fact", "preference", "topic", "sentiment", "shared_context", "open_loop_you_owe", "open_loop_owes_you"]

LIVE_SCHEMA = {
    "type": "object",
    "properties": {
        "deltas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": DELTA_KINDS}, "text": {"type": "string"}},
                "required": ["kind", "text"],
                "additionalProperties": False,
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["deltas", "summary"],
    "additionalProperties": False,
}

SYSTEM = """You watch an in-person conversation through the wearer's smart glasses and keep a running relationship memory.
The wearer is {wearer_name}. The other person is {other_name}. The wearer never talks to the AI.

Return ONLY what is new since the "already known" list: at most 3 deltas, each a terse HUD line of max 6 words, lowercase, no trailing period, about {other_name} or the shared context between them.
Kinds:
- fact: stable fact about {other_name} (role, team size, what they use)
- preference: how they like things ("prefers async demos")
- topic: what they are talking about right now
- sentiment: how {other_name} feels about the product or conversation ("frustrated with setup")
- shared_context: something both now share (a plan, an intro, an event)
- open_loop_you_owe: {wearer_name} promised {other_name} something
- open_loop_owes_you: {other_name} promised {wearer_name} something
Only state what was actually said. No guesses, no sensitive personal inferences (health, religion, politics, sexuality). If nothing new, return an empty list.
summary: one line (max 12 words) describing the relationship so far, including anything already known."""


@dataclass
class _EncState:
    enc_id: str
    seen: int = 0
    last_pass: float = 0.0
    emitted: list[str] = field(default_factory=list)


class RollingExtractor:
    def __init__(
        self,
        emit: Callable[[dict[str, Any]], Awaitable[None]],
        *,
        wearer_id: str = "stephen",
        wearer_name: str = "Stephen",
        model: str | None = None,
        every_s: float | None = None,
        every_n: int | None = None,
        known: Callable[[str], list[str]] | None = None,
        client: Any = None,
    ) -> None:
        self.emit = emit
        self.wearer_id = wearer_id
        self.wearer_name = wearer_name
        self.model = model or os.environ.get("WORLD_LIVE_MODEL", "claude-haiku-4-5")
        self.every_s = every_s if every_s is not None else float(os.environ.get("WORLD_LIVE_EVERY_S", "20"))
        self.every_n = every_n if every_n is not None else int(os.environ.get("WORLD_LIVE_EVERY_N", "4"))
        self.known = known or (lambda pid: [])
        self.client = client
        if client is False:  # caller wires the client explicitly
            self.client = None
        elif self.client is None and os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("WORLD_LIVE", "1") != "0":
            self.client = make_anthropic_client()
        self.state: _EncState | None = None
        self._busy = False
        self.last_latency_ms: float | None = None
        self.passes = 0

    def due(self, enc: Encounter | None, now: float) -> bool:
        if enc is None or not enc.person_id or self.client is None or self._busy:
            return False
        if self.state is None or self.state.enc_id != enc.id:
            self.state = _EncState(enc.id, last_pass=now)
        new = len(enc.utterances) - self.state.seen
        if new <= 0:
            return False
        return new >= self.every_n or now - self.state.last_pass >= self.every_s

    async def tick(self, enc: Encounter | None, now: float | None = None) -> dict[str, Any] | None:
        now = now or time.time()
        if not self.due(enc, now):
            return None
        return await self.run_pass(enc, now)  # type: ignore[arg-type]

    def build_request(self, enc: Encounter, st: _EncState) -> dict[str, Any]:
        known = list(dict.fromkeys([*self.known(enc.person_id or ""), *st.emitted]))
        user = (
            "Already known (do not repeat):\n" + ("\n".join(f"- {k}" for k in known[-30:]) or "- nothing yet")
            + f"\n\nConversation so far (lines after #{st.seen} are new):\n{format_transcript(enc)}"
        )
        return {
            "model": self.model,
            "max_tokens": 400,
            "system": SYSTEM.format(wearer_name=self.wearer_name, other_name=enc.name or "the other person"),
            "messages": [{"role": "user", "content": user}],
            "output_config": {"format": {"type": "json_schema", "schema": LIVE_SCHEMA}},
        }

    async def run_pass(self, enc: Encounter, now: float) -> dict[str, Any] | None:
        st = self.state
        assert st is not None
        self._busy = True
        n = len(enc.utterances)
        try:
            t0 = time.perf_counter()
            resp = await self.client.messages.create(**self.build_request(enc, st))
            self.last_latency_ms = (time.perf_counter() - t0) * 1000
            if getattr(resp, "stop_reason", None) == "refusal":
                return None
            text = next(b.text for b in resp.content if b.type == "text")
            data = json.loads(text)
        except Exception:
            log.exception("live pass failed")
            return None
        finally:
            st.seen, st.last_pass = n, now
            self._busy = False
        self.passes += 1
        seen = {x.lower() for x in (*st.emitted, *self.known(enc.person_id or ""))}
        deltas = []
        for d in data.get("deltas") or []:
            t = (d.get("text") or "").strip().rstrip(".")
            if t and d.get("kind") in DELTA_KINDS and t.lower() not in seen:
                seen.add(t.lower())
                deltas.append({"kind": d["kind"], "text": t[:60]})
        deltas = deltas[:3]
        log.info("live pass %.0fms: %s", self.last_latency_ms or 0, [d["text"] for d in deltas])
        if not deltas:
            return None
        st.emitted.extend(d["text"] for d in deltas)
        ev = make_event(
            "relationship.updated",
            {"person_id": enc.person_id, "deltas": deltas, "summary": (data.get("summary") or "").strip()[:120],
             "encounter_id": enc.id, "utterances_seen": n},
            source="quest3s", confidence=0.8,
            people=[{"id": self.wearer_id, "name": self.wearer_name, "enrolled": True},
                    {"id": enc.person_id, "name": enc.name, "enrolled": True}],
        )
        await self.emit(ev)
        return ev

    async def loop(self, current: Callable[[], Encounter | None], interval: float = 2.0) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                enc = current()
                if self.due(enc, time.time()):
                    asyncio.create_task(self.run_pass(enc, time.time()))  # type: ignore[arg-type]
            except Exception:
                log.exception("live tick failed")
