"""Self-introduction enrollment: "hey, I'm Matthew" from the other person = their opt-in.

Cheap path, no LLM round trip: a regex over each ASR utterance finds self-introductions
("I'm X", "my name is X", "call me X") and the wearer's greeting ("nice to meet you X").

Who said it matters. A self-intro only enrolls the unknown person in front of the wearer when
it was said by that person, not by the wearer:
  - strong attribution: explicit speaker tag (debug injection / diarization) or the utterance is
    clearly quieter than the wearer's mic level (loudness heuristic, see conversation.py)
    -> start learning right away
  - weak attribution (unclear loudness) -> held as pending; the wearer confirms by greeting them
    by name ("nice to meet you Matthew") within CONFIRM_WINDOW_S, then learning starts
  - said by the wearer ("I'm Stephen") -> ignored; the wearer's greeting alone also counts
    as the confirmation when the other person's intro was missed by ASR

Learning captures fresh samples from that track (embeddings only, never photos; see vision.py).
`uv run python -m perception.enroll --remove <id>` deletes a person.
"""
from __future__ import annotations

import logging
import re
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("world.intro")

INTRO_SAMPLES = 10          # fresh samples captured from the track (8-12 target)
CONFIRM_WINDOW_S = 30.0     # a weak intro waits this long for the wearer's greeting
STRONG_QUIET_DB = 9.0       # utterance this many dB below the wearer's level = clearly the other person

_NAME = r"(?P<name>[A-Z][a-zA-Z'\-]{1,20})"
_NAME_ANYCASE = r"(?P<name>[A-Za-z][a-zA-Z'\-]{1,20})"

# order matters: explicit forms first
INTRO_PATTERNS = [
    re.compile(r"(?i:\bmy\s+name(?:'s|\s+is)\s+)" + _NAME_ANYCASE),
    re.compile(r"(?i:\b(?:you\s+can\s+)?call\s+me\s+)" + _NAME_ANYCASE),
    re.compile(r"(?i:\bname's\s+)" + _NAME_ANYCASE),
    # "I'm X" is ambiguous ("I'm good"), so the name must be capitalized (Whisper capitalizes names)
    re.compile(r"(?i:\b(?:i'm|i\s+am|im)\s+)" + _NAME + r"\b"),
]
CONFIRM_PATTERN = re.compile(
    r"(?i:\b(?:(?:it's\s+|it\s+is\s+|so\s+)?(?:nice|good|great|glad|a\s+pleasure|pleasure)\s+(?:to\s+)?(?:meet(?:ing)?)\s+you|"
    r"nice\s+meeting\s+you),?\s+)" + _NAME_ANYCASE
)

STOP = {w.lower() for w in """
a an the and or but so just not really actually also still very pretty kind sort kinda sorta totally literally basically
honestly definitely probably always never only currently here there back out up down over in on at from with like
good fine great ok okay sorry sure glad happy excited thinking looking building working trying doing going gonna
done busy tired hungry interested curious cool right late early new afraid talking saying wondering hoping planning
using making getting coming leaving staying waiting ready down well yeah yes no nope hey hi hello thanks thank
later tomorrow tonight today anytime whenever sometime maybe soon
all fine super mostly almost about around based from good bad big huge small new old free full part one two
this that these those it its he she they we you me him her them us my your his their our what who why how when
""".split()}


@dataclass
class Intro:
    kind: str            # "self" | "confirm"
    name: str


def parse_intro(text: str) -> Intro | None:
    """First self-introduction or wearer greeting in an utterance, or None."""
    t = (text or "").replace("\u2019", "'")
    m = CONFIRM_PATTERN.search(t)
    if m and m.group("name").lower() not in STOP:
        return Intro("confirm", m.group("name").capitalize())
    for pat in INTRO_PATTERNS:
        for m in pat.finditer(t):
            name = m.group("name")
            if name.lower() in STOP:
                continue
            return Intro("self", name[0].upper() + name[1:])
    return None


def attribute(speaker: str | None, rms_db: float, recent_levels: list[float]) -> tuple[str, bool]:
    """Who spoke: ("other" | "wearer" | "unclear", strong?).

    Explicit speaker tags are strong. Loudness (wearer's mic is at their mouth, so the wearer is
    louder) is strong only when the utterance is far below the loud cluster.
    """
    sp = (speaker or "").lower()
    if sp in ("wearer", "likely wearer"):
        return "wearer", True
    if sp in ("other", "other person", "likely other"):
        return "other", True
    lv = [x for x in recent_levels if x is not None]
    if len(lv) < 3:
        return "unclear", False
    hi, lo = max(lv), min(lv)
    if hi - lo < 6.0:
        return "unclear", False
    if rms_db >= (hi + lo) / 2:
        return "wearer", False
    return "other", hi - rms_db >= STRONG_QUIET_DB


class IntroEnroller:
    """Watches utterances; starts face learning on the unknown track when someone introduces themselves."""

    def __init__(self, vision: Any, wearer_name: str = "Stephen", wearer_id: str = "stephen", samples: int = INTRO_SAMPLES,
                 confirm_window_s: float = CONFIRM_WINDOW_S) -> None:
        self.vision = vision
        self.wearer = {wearer_name.lower(), wearer_id.lower()}
        self.samples = samples
        self.confirm_window_s = confirm_window_s
        self.levels: deque[float] = deque(maxlen=16)
        self.pending: dict[str, tuple[str, float]] = {}  # name.lower() -> (name, ts)
        self.started: list[tuple[int, str]] = []  # (track_id, name) for health/tests

    def target_track(self):
        """Largest tracked face that is not recognized and not already learning."""
        cands = [t for t in self.vision.tracker.tracks.values() if t.person_id is None and t.enroll_name is None]
        return max(cands, key=lambda t: t.area) if cands else None

    def on_utterance(self, u: Any, now: float | None = None) -> dict[str, Any] | None:
        now = time.time() if now is None else now
        prior = list(self.levels)
        self.levels.append(float(getattr(u, "rms_db", -30.0)))
        intro = parse_intro(getattr(u, "text", ""))
        if intro is None:
            return None
        if intro.name.lower() in self.wearer:
            return None
        who, strong = attribute(getattr(u, "speaker", None), u.rms_db, prior + [u.rms_db])
        self._gc(now)
        if intro.kind == "self":
            if who == "wearer":
                return {"action": "ignored", "name": intro.name, "why": "said by the wearer"}
            if strong:
                return self._start(intro.name, "self-introduced")
            self.pending[intro.name.lower()] = (intro.name, now)
            log.info("heard intro %r (weak attribution: %s); waiting for the wearer's greeting", intro.name, who)
            return {"action": "pending", "name": intro.name, "why": f"attribution {who}"}
        # confirm: the wearer greets someone by name
        if who == "other" and strong:
            return {"action": "ignored", "name": intro.name, "why": "greeting said by the other person"}
        self.pending.pop(intro.name.lower(), None)
        return self._start(intro.name, "wearer confirmed")

    def _gc(self, now: float) -> None:
        for k, (_, ts) in list(self.pending.items()):
            if now - ts > self.confirm_window_s:
                del self.pending[k]

    def _start(self, name: str, why: str) -> dict[str, Any] | None:
        t = self.target_track()
        if t is None:
            return {"action": "no_target", "name": name, "why": why}
        store = getattr(self.vision, "store", None)
        if store is not None and store.match_name(name):
            # someone unrecognized claims an enrolled name: never merge a stranger's face into that person
            log.info("intro: %s is already enrolled; not learning track %s from a spoken name", name, t.track_id)
            return {"action": "name_taken", "name": name, "track_id": t.track_id, "why": why}
        self.vision.request_label(t.track_id, name, fresh=True, samples=self.samples)
        self.started.append((t.track_id, name))
        log.info("intro: learning track %s as %s (%s)", t.track_id, name, why)
        return {"action": "enroll", "name": name, "track_id": t.track_id, "why": why}
