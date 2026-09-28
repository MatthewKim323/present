"""Conversation -> WorldEvents via Claude structured output.

The LLM returns a flat event list (one schema for all types, unused fields ""),
which parse_extraction() maps onto the typed payloads in contracts/EVENTS.md.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from .conversation import Encounter
from .events import make_event, slug

log = logging.getLogger("world.extract")

LLM_TYPES = [
    "decision.detected",
    "commitment.detected",
    "customer_feedback.detected",
    "feature_request.detected",
    "physical_bug.detected",
    "task.demonstrated",
]

_S = {"type": "string"}
EVENT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": LLM_TYPES},
        "confidence": {"type": "number"},
        "project": _S,
        "decision": _S,
        "constraint": _S,
        "decided_by": {"type": "array", "items": _S},
        "actor": _S,
        "recipient": _S,
        "commitment": _S,
        "due": _S,
        "product": _S,
        "feature": _S,
        "sentiment": {"type": "string", "enum": ["neg", "pos", "mixed", ""]},
        "feedback": _S,
        "buying_signal": _S,
        "request": _S,
        "requested_by": _S,
        "acceptance": {"type": "array", "items": _S},
        "device": _S,
        "symptom": _S,
        "repro": _S,
        "instruction": _S,
        "target": _S,
    },
    "required": [
        "type", "confidence", "project", "decision", "constraint", "decided_by", "actor", "recipient",
        "commitment", "due", "product", "feature", "sentiment", "feedback", "buying_signal", "request", "requested_by", "acceptance", "device",
        "symptom", "repro", "instruction", "target",
    ],
    "additionalProperties": False,
}
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": _S,
        "project": _S,
        "events": {"type": "array", "items": EVENT_SCHEMA},
    },
    "required": ["summary", "project", "events"],
    "additionalProperties": False,
}

SYSTEM = """You turn an in-person conversation, overheard by the wearer's smart glasses, into structured world events for their personal memory and agents.

People:
- The wearer is {wearer_name} (person_id "{wearer_id}"). The wearer never talks to the AI; everything is ordinary conversation.
- The other voice is the person in frame: {other_desc}.
- Lines are ASR text with a loudness hint. The glasses mic sits at the wearer's mouth, so "likely wearer" lines are probably the wearer. Use content first ("I'll send you..." spoken to the other person is the wearer's commitment) and the hint to break ties.

Emit zero or more events. Only emit what was actually said; empty is fine. Types:
- customer_feedback.detected: the other person gives feedback on a product/feature. product, feature, sentiment (neg|pos|mixed), feedback (one crisp sentence, paraphrased), buying_signal ("" if none, e.g. "would roll out if onboarding were easier").
- feature_request.detected: the other person asks for or suggests a CONCRETE product change that an engineer could build (e.g. "onboarding should show a progress checklist"). Emit it in addition to customer_feedback.detected when both apply. product, feature (short imperative title, max 8 words, e.g. "Add onboarding progress checklist"), request (one sentence describing the change as the customer put it, paraphrased), requested_by (display name of who asked), acceptance (1-4 short, visually checkable criteria, e.g. "Checklist shows 4 steps with done state"). Vague complaints with no concrete change are feedback only.
- commitment.detected: someone promises to do something. actor and recipient are display names (e.g. "{wearer_name}", "{other_name}"), commitment is an imperative phrase ("Send updated onboarding demo"), due ("" if unstated).
- decision.detected: a decision was made. decision, constraint ("" if none), decided_by (person_ids, use "{wearer_id}" and "{other_id}").
- physical_bug.detected: a hardware/physical device bug. device, symptom, repro.
- task.demonstrated: someone shows/asks how to do a physical task. instruction, target (whiteboard|object|screen|...).
Set every field not used by the event's type to "". confidence is 0..1. project is a short product/project name if one is clear, else "".
summary: one or two sentences, no quotes, no verbatim transcript. project: the main project, or "".
"""


def llm_timeout_s() -> float:
    return float(os.environ.get("WORLD_LLM_TIMEOUT_S", "15"))


def make_anthropic_client() -> Any:
    """One short-timeout client for extraction, the live pass and the watch parse.

    The SDK default is 600s + 2 retries; the watch parse is awaited inline in the utterance path,
    so a hung call would stall ASR for minutes.
    """
    import anthropic

    return anthropic.AsyncAnthropic(timeout=llm_timeout_s(), max_retries=1)


def format_transcript(enc: Encounter) -> str:
    hints = enc.speaker_hints()
    lines = []
    for u, h in zip(enc.utterances, hints):
        who = u.speaker or h
        lines.append(f"[+{u.ts - enc.started:5.1f}s] ({who}) {u.text}")
    return "\n".join(lines)


def _people_for(enc: Encounter, wearer_id: str, wearer_name: str) -> list[dict[str, Any]]:
    out = [{"id": wearer_id, "name": wearer_name, "enrolled": True}]
    if enc.person_id:
        out.append({"id": enc.person_id, "name": enc.name, "enrolled": True})
    elif enc.name:
        out.append({"id": None, "name": enc.name, "enrolled": False})
    return out


def _nz(v: Any) -> Any:
    return v if v not in ("", None, []) else None


def parse_extraction(
    data: dict[str, Any] | str,
    enc: Encounter,
    *,
    source: str = "quest3s",
    wearer_id: str = "matthew",
    wearer_name: str = "Matthew",
) -> list[dict[str, Any]]:
    """Map the LLM's JSON onto contract WorldEvents. Always ends with conversation.completed."""
    if isinstance(data, str):
        data = json.loads(data)
    people = _people_for(enc, wearer_id, wearer_name)
    default_project = slug(data.get("project") or "")
    events: list[dict[str, Any]] = []
    for raw in data.get("events") or []:
        t = raw.get("type")
        if t not in LLM_TYPES:
            log.warning("dropping unknown extracted type %r", t)
            continue
        try:
            conf = max(0.0, min(1.0, float(raw.get("confidence", 0.5))))
        except (TypeError, ValueError):
            conf = 0.5
        g = lambda k: (raw.get(k) or "").strip() if isinstance(raw.get(k), str) else raw.get(k)  # noqa: E731
        if t == "customer_feedback.detected":
            if not g("feedback"):
                continue
            sentiment = g("sentiment") if g("sentiment") in ("neg", "pos", "mixed") else "mixed"
            payload = {"product": _nz(g("product")), "feature": _nz(g("feature")), "sentiment": sentiment, "feedback": g("feedback")}
            if _nz(g("buying_signal")):
                payload["buying_signal"] = g("buying_signal")
        elif t == "feature_request.detected":
            if not g("feature") and not g("request"):
                continue
            acc = [a.strip() for a in (raw.get("acceptance") or []) if isinstance(a, str) and a.strip()][:4]
            payload = {"product": _nz(g("product")), "feature": g("feature") or g("request")[:60], "request": g("request") or g("feature"),
                       "requested_by": g("requested_by") or enc.name or None}
            if acc:
                payload["acceptance"] = acc
        elif t == "commitment.detected":
            if not g("commitment"):
                continue
            payload = {"actor": g("actor") or wearer_name, "recipient": _nz(g("recipient")), "commitment": g("commitment")}
            if _nz(g("due")):
                payload["due"] = g("due")
        elif t == "decision.detected":
            if not g("decision"):
                continue
            decided_by = [d for d in (raw.get("decided_by") or []) if isinstance(d, str) and d]
            payload = {"decision": g("decision"), "decided_by": decided_by}
            if _nz(g("constraint")):
                payload["constraint"] = g("constraint")
        elif t == "physical_bug.detected":
            if not g("symptom"):
                continue
            payload = {"device": _nz(g("device")), "symptom": g("symptom"), "repro": _nz(g("repro"))}
        else:  # task.demonstrated
            if not g("instruction"):
                continue
            payload = {"instruction": g("instruction"), "target": _nz(g("target")) or "object"}
        project = slug(g("project")) or default_project
        events.append(make_event(t, payload, source=source, confidence=conf, people=people, project=project))

    speakers = [wearer_id] + ([enc.person_id] if enc.person_id else [])
    events.append(
        make_event(
            "conversation.completed",
            {
                "duration_s": round(enc.duration_s, 1),
                "summary": (data.get("summary") or "").strip(),
                "speakers": speakers,
                "utterances": len(enc.utterances),
            },
            source=source,
            confidence=1.0,
            people=people,
            project=default_project,
        )
    )
    return events


class Extractor:
    """Claude-backed extractor. Without ANTHROPIC_API_KEY it degrades to conversation.completed only."""

    def __init__(self, model: str = "claude-sonnet-5", wearer_id: str = "matthew", wearer_name: str = "Matthew", client: Any = None) -> None:
        self.model = model
        self.wearer_id = wearer_id
        self.wearer_name = wearer_name
        self.client = client
        if self.client is None:
            if os.environ.get("ANTHROPIC_API_KEY"):
                self.client = make_anthropic_client()
            else:
                log.warning("ANTHROPIC_API_KEY unset: no extraction, no live deltas, no watch parse (conversation.completed only)")
        self.last_latency_ms: float | None = None

    def build_request(self, enc: Encounter) -> dict[str, Any]:
        other_name = enc.name or "the other person"
        other_id = enc.person_id or "unknown"
        if enc.person_id:
            other_desc = f'{enc.name} (person_id "{enc.person_id}", enrolled)'
        elif enc.name:
            other_desc = f"{enc.name} (not enrolled, identity unknown)"
        else:
            other_desc = "an unidentified person"
        system = SYSTEM.format(
            wearer_name=self.wearer_name, wearer_id=self.wearer_id, other_desc=other_desc,
            other_name=other_name, other_id=other_id,
        )
        return {
            "model": self.model,
            "max_tokens": 4000,
            "system": system,
            "messages": [{"role": "user", "content": f"Conversation transcript:\n{format_transcript(enc)}"}],
            "output_config": {"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        }

    async def extract(self, enc: Encounter, source: str = "quest3s") -> list[dict[str, Any]]:
        if not enc.utterances:
            return []
        data: dict[str, Any] = {"summary": "", "project": "", "events": []}
        if self.client is None:
            log.warning("ANTHROPIC_API_KEY unset: emitting conversation.completed only")
        else:
            t0 = time.perf_counter()
            try:
                resp = await self.client.messages.create(**self.build_request(enc))
                self.last_latency_ms = (time.perf_counter() - t0) * 1000
                if resp.stop_reason == "refusal":
                    log.warning("extraction refused")
                else:
                    text = next(b.text for b in resp.content if b.type == "text")
                    data = json.loads(text)
                log.info("extraction %.0fms, %d events", self.last_latency_ms, len(data.get("events", [])))
            except Exception:
                log.exception("extraction failed; emitting conversation.completed only")
        return parse_extraction(data, enc, source=source, wearer_id=self.wearer_id, wearer_name=self.wearer_name)
