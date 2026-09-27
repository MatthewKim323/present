"""Rolling per-encounter conversation buffer. Memory only; the transcript is dropped after extraction."""
from __future__ import annotations

from dataclasses import dataclass, field

from ulid import ULID


@dataclass
class Utterance:
    ts: float
    text: str
    rms_db: float = -30.0
    speaker: str | None = None  # explicit speaker when known (debug injection), else inferred downstream
    duration_s: float = 0.0  # speech length; ts is when it ended


@dataclass
class Encounter:
    id: str
    person_id: str | None
    name: str | None  # enrolled name or "UNKNOWN PERSON NN"
    track_id: int | None
    started: float
    last_activity: float
    utterances: list[Utterance] = field(default_factory=list)
    person_last_seen: float = 0.0

    @property
    def duration_s(self) -> float:
        if not self.utterances:
            return 0.0
        return max(0.0, self.utterances[-1].ts - self.started)

    def speaker_hints(self) -> list[str]:
        """Loudness heuristic: the wearer's mic sits at their mouth, so their voice is louder.

        Returns per-utterance "likely wearer" / "likely other" / "unclear".
        """
        levels = [u.rms_db for u in self.utterances]
        if not levels:
            return []
        hi, lo = max(levels), min(levels)
        if hi - lo < 6.0:
            return ["unclear"] * len(levels)
        mid = (hi + lo) / 2
        return ["likely wearer" if lvl >= mid else "likely other" for lvl in levels]


class ConversationManager:
    def __init__(self, gap_s: float = 10.0, leave_grace_s: float = 4.0) -> None:
        self.gap_s = gap_s
        self.leave_grace_s = leave_grace_s
        self.current: Encounter | None = None

    def add_utterance(
        self,
        u: Utterance,
        person_id: str | None,
        name: str | None,
        track_id: int | None,
    ) -> list[Encounter]:
        """Append an utterance to the open encounter. Returns any encounter closed because the partner changed."""
        closed: list[Encounter] = []
        cur = self.current
        if cur is not None and name is not None and cur.name is not None and (person_id, name) != (cur.person_id, cur.name):
            closed.append(self._close())
            cur = None
        if cur is None:
            start = u.ts - u.duration_s
            cur = self.current = Encounter(str(ULID()), person_id, name, track_id, start, u.ts, person_last_seen=u.ts)
        elif cur.name is None and name is not None:
            cur.person_id, cur.name, cur.track_id = person_id, name, track_id  # partner identified mid-conversation
        cur.utterances.append(u)
        cur.last_activity = u.ts
        return closed

    def person_seen(self, person_id: str | None, name: str | None, ts: float) -> None:
        cur = self.current
        if cur and cur.name is not None and (person_id, name) == (cur.person_id, cur.name):
            cur.person_last_seen = ts

    def tick(self, ts: float) -> list[Encounter]:
        cur = self.current
        if cur is None:
            return []
        if ts - cur.last_activity >= self.gap_s:
            return [self._close()]
        if cur.track_id is not None and ts - max(cur.person_last_seen, cur.last_activity) >= self.leave_grace_s:
            return [self._close()]
        return []

    def force_end(self) -> list[Encounter]:
        return [self._close()] if self.current else []

    def _close(self) -> Encounter:
        cur, self.current = self.current, None
        return cur
