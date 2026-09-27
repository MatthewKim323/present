"""WorldEvent envelope helpers. Mirrors contracts/EVENTS.md (v0)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ulid import ULID

EVENT_TYPES = {
    "person.encountered",
    "person.enrolled",
    "conversation.completed",
    "decision.detected",
    "commitment.detected",
    "customer_feedback.detected",
    "physical_bug.detected",
    "task.demonstrated",
    "world.task_requested",
    "object.state_changed",
    "object.last_seen",
}
SOURCES = {"quest3s", "desktop-sim", "manual"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id() -> str:
    return f"evt_{ULID()}"


def make_event(
    type: str,
    payload: dict[str, Any],
    *,
    source: str = "quest3s",
    confidence: float = 1.0,
    people: list[dict[str, Any]] | None = None,
    project: str | None = None,
) -> dict[str, Any]:
    if type not in EVENT_TYPES:
        raise ValueError(f"unknown event type: {type}")
    return {
        "id": new_id(),
        "type": type,
        "ts": now_iso(),
        "source": source,
        "confidence": round(float(confidence), 3),
        "people": people or [],
        "project": project,
        "payload": payload,
    }


def normalize_event(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate an externally supplied event (POST /events), filling id/ts/defaults."""
    if not isinstance(raw, dict):
        raise ValueError("event must be an object")
    t = raw.get("type")
    if t not in EVENT_TYPES:
        raise ValueError(f"unknown event type: {t!r}")
    ev = {
        "id": raw.get("id") or new_id(),
        "type": t,
        "ts": raw.get("ts") or now_iso(),
        "source": raw.get("source") or "manual",
        "confidence": float(raw.get("confidence", 1.0)),
        "people": raw.get("people") or [],
        "project": raw.get("project"),
        "payload": raw.get("payload") or {},
    }
    if not isinstance(ev["payload"], dict) or not isinstance(ev["people"], list):
        raise ValueError("payload must be an object and people a list")
    return ev


def slug(s: str | None) -> str | None:
    if not s:
        return None
    out = "".join(c.lower() if c.isalnum() else "-" for c in s.strip())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-") or None
