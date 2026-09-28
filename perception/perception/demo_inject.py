"""Scripted demo events, no cameras needed. Stephen (Opal founder) wears the Quest; Matthew is the customer.

  uv run python -m perception.demo_inject                  # Matthew gives Opal feedback + Stephen commits to a follow-up
  uv run python -m perception.demo_inject --feature        # Matthew asks for a `!recap` command in the Opal Discord bot
  uv run python -m perception.demo_inject --customer2      # second, similar bot command (`!streak`), Memorable recall run 2
  uv run python -m perception.demo_inject --via-llm        # inject utterances + end conversation, exercises Claude extraction
  uv run python -m perception.demo_inject --feature --via-llm   # same, through Claude
  uv run python -m perception.demo_inject --rehearse       # whole stage take through /director, prints a real timeline
  run the service with WORLD_WEARER_ID=stephen WORLD_WEARER_NAME=Stephen
  options: --url http://localhost:8787  --delay 1.5  --dry-run  --timeout 900 (rehearse: per build)
"""
from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any, Callable

import httpx

from .events import make_event

MATT = {"id": "matthew", "name": "Matthew", "enrolled": True}
STEPHEN = {"id": "stephen", "name": "Stephen", "enrolled": True}
PEOPLE = [STEPHEN, MATT]
PROJECT = "opal"
SRC = "manual"


def encountered(track_id: int = 4, score: float = 0.74) -> dict:
    return make_event("person.encountered", {"track_id": track_id, "person_id": "matthew", "label": "Matthew",
                                             "bbox": [412, 188, 164, 212], "match_score": score},
                      source=SRC, confidence=score, people=[MATT])


def completed(summary: str, duration_s: float = 40.0) -> dict:
    return make_event("conversation.completed", {"duration_s": duration_s, "summary": summary,
                                                 "speakers": ["stephen", "matthew"], "utterances": 6},
                      source=SRC, confidence=1.0, people=PEOPLE, project=PROJECT)


def feedback_events() -> list[dict]:
    """Default: Matthew tells Stephen what bugs him about the Opal Discord bot, Stephen commits to a follow-up."""
    return [
        encountered(),
        make_event("customer_feedback.detected", {"product": "Opal", "feature": "Discord bot memory", "sentiment": "mixed",
                                                  "feedback": "Opal remembers stuff mid-session, but he can't see what it knows about him",
                                                  "buying_signal": "Would get his squad on the Discord bot if it felt like it knew them"},
                   source=SRC, confidence=0.92, people=PEOPLE, project=PROJECT),
        make_event("commitment.detected", {"actor": "Stephen", "recipient": "Matthew",
                                           "commitment": "Send Matthew the Opal Discord invite for his squad"},
                   source=SRC, confidence=0.93, people=PEOPLE, project=PROJECT),
        completed("Matthew likes playing with Opal but wants to see what it remembers about him; "
                  "Stephen will send the Discord invite for his squad.", 42.0),
    ]


FEATURE_REQUEST = {
    "product": "Opal",
    "feature": "Add !recap command",
    "request": "A !recap command in the Discord bot that shows what Opal remembers about you from past sessions, in Opal's voice",
    "requested_by": "Matthew",
    "acceptance": ["`!recap` replies in the channel", "Uses the bot's existing memory, in Opal's persona"],
}

FEATURE_REQUEST_2 = {
    "product": "Opal",
    "feature": "Add !streak command",
    "request": "A !streak command in the Discord bot that shows how many days in a row you've played with Opal",
    "requested_by": "Matthew",
    "acceptance": ["`!streak` replies in the channel", "Says the streak count in Opal's persona"],
}


def feature_events(spec: dict = FEATURE_REQUEST, summary: str | None = None) -> list[dict]:
    """Stephen (founder, wearing the Quest) talks to Matthew (customer). Matthew asks for a concrete Discord bot command."""
    return [
        encountered(),
        make_event("customer_feedback.detected", {"product": "Opal", "feature": "Discord bot memory", "sentiment": "mixed",
                                                  "feedback": "Opal clearly remembers things, but there's no way to see what it knows about you",
                                                  "buying_signal": "Would get his whole squad on the bot if it had this"},
                   source=SRC, confidence=0.92, people=PEOPLE, project=PROJECT),
        make_event("feature_request.detected", dict(spec), source=SRC, confidence=0.93, people=PEOPLE, project=PROJECT),
        completed(summary or "Matthew asked for a !recap command so he can see what Opal remembers about him; Stephen agreed to ship it today.", 38.0),
    ]


def customer2_events() -> list[dict]:
    """Run 2 for Memorable recall: a similar, not identical, bot command request."""
    return feature_events(FEATURE_REQUEST_2, "Matthew asked for a !streak command showing how many days in a row he's played; "
                                             "Stephen said he'd get it in.")


def feature_request_event(spec: dict = FEATURE_REQUEST, anchor_track_id: int | None = None) -> dict:
    """Just the feature_request.detected (the director's !recap / !streak buttons). QMSink routes it to the swarm."""
    p = dict(spec)
    if anchor_track_id is not None:
        p["anchor_track_id"] = anchor_track_id
    return make_event("feature_request.detected", p, source=SRC, confidence=0.93, people=PEOPLE, project=PROJECT)


LIVE_FACTS = [
    ("fact", "plays Opal on Discord most nights"),
    ("preference", "wants to see what Opal remembers"),
    ("open_loop_owes_you", "bring his squad onto the bot"),
]


def facts_event(deltas: list[tuple[str, str]] = LIVE_FACTS, encounter_id: str = "director") -> dict:
    """A live relationship.updated pass (what live.py emits mid-conversation): context_delta lines on the card."""
    return make_event("relationship.updated", {
        "person_id": "matthew", "deltas": [{"kind": k, "text": t} for k, t in deltas],
        "summary": "Matthew plays Opal on Discord and wants to see what it remembers about him",
        "encounter_id": encounter_id, "utterances_seen": 4,
    }, source=SRC, confidence=0.9, people=[MATT], project=PROJECT)


WATCH_INSTRUCTION = "Next time Matthew brings up pricing, prep a counter-offer"


def watch_event(instruction: str = WATCH_INSTRUCTION) -> dict:
    """The wearer sets a standing watch out loud; QM turns it into a WorldWatch.

    Same payload shape as the live path (watches.WatchRequester): topic_terms + person_name feed the WATCH ARMED toast.
    """
    from .watches import fallback_parse

    parsed = fallback_parse(instruction, {MATT["id"]: MATT["name"]}, (MATT["id"], MATT["name"]))
    payload = {"instruction": instruction, "topic_terms": parsed["topic_terms"], "action": parsed["action"], "once": parsed["once"],
               "person_id": MATT["id"], "person_name": MATT["name"]}
    return make_event("world.watch_requested", payload, source=SRC, confidence=0.95, people=[STEPHEN, MATT], project=PROJECT)


FEEDBACK_LINES = [
    ("other", "Yo, I was playing with Opal on Discord last night. It's actually fun."),
    ("wearer", "Appreciate it. Anything feel off?"),
    ("other", "It clearly remembers stuff about me, but I can't tell what it knows. Kinda spooky."),
    ("other", "If it felt more like it knew me I'd get my whole squad on it."),
    ("wearer", "Fair. I'll send you the Discord invite for your squad tonight."),
    ("other", "Bet, thanks."),
]

FEATURE_LINES = [
    ("other", "Yo, I've been playing with Opal on Discord. It's fire."),
    ("wearer", "Appreciate it. Anything you wish it did?"),
    ("other", "It remembers stuff about me but I can never see what. Like what does it actually know?"),
    ("other", "You should add a bang recap command. I type recap and Opal tells me what it remembers about me, in its own voice."),
    ("wearer", "That's a great call. We can ship that today."),
    ("other", "Do that and I'm getting my whole squad on it."),
]

CUSTOMER2_LINES = [
    ("other", "Okay recap is sick."),
    ("wearer", "Nice, anything else?"),
    ("other", "My friends are gonna want to flex how much they play though."),
    ("other", "Add a bang streak command. It says how many days in a row you've played with Opal."),
    ("wearer", "Easy, I'll get that in."),
    ("other", "Perfect."),
]


# ---------------------------------------------------------------- rehearsal (no people needed)

REHEARSAL = [
    ("reset", "Reset HUD"),
    ("intro", "Matthew: \"I'm Matthew\" (enrolls only with his face in view)"),
    ("recognized", "Matthew recognized, person card"),
    ("facts", "live facts (context deltas)"),
    ("recap", "!recap feature request -> QM swarm + Builder (run 1)"),
    ("wait", "wait for run 1 PR + preview"),
    ("streak", "!streak feature request (run 2, recall)"),
    ("wait", "wait for run 2 PR + preview"),
]
SETTLED = ("done", "failed")


class Rehearsal:
    """Drives the stage take through the director API (same path as the buttons) and records a timeline."""

    def __init__(self, client: httpx.Client, *, token: str = "", delay: float = 3.0, timeout_s: float = 900.0,
                 poll_s: float = 2.0, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
                 out: Callable[[str], None] = print) -> None:
        self.c, self.delay, self.timeout_s, self.poll_s = client, delay, timeout_s, poll_s
        self.headers = {"authorization": f"Bearer {token}"} if token else {}
        self.clock, self.sleep, self.out = clock, sleep, out
        self.t0 = clock()
        self.timeline: list[tuple[float, str]] = []
        self.runs: list[dict[str, Any]] = []

    def mark(self, text: str) -> None:
        t = round(self.clock() - self.t0, 1)
        self.timeline.append((t, text))
        self.out(f"[{t:7.1f}s] {text}")

    def action(self, name: str) -> dict[str, Any]:
        r = self.c.post("/director/api/action", json={"action": name}, headers=self.headers)
        r.raise_for_status()
        return r.json()

    def status(self) -> dict[str, Any]:
        r = self.c.get("/director/api/status", headers=self.headers)
        r.raise_for_status()
        return r.json()

    def wait(self, event_id: str, label: str) -> dict[str, Any]:
        """Poll until the Builder job for event_id settles; print every lane / job change as it happens."""
        start, seen, job = self.clock(), set(), None
        while self.clock() - start < self.timeout_s:
            s = self.status()
            sw = s.get("swarm") or {}
            if not sw.get("event_id") or sw.get("event_id") == event_id:
                for w in sw.get("workers") or []:
                    key = ("lane", w.get("name"), w.get("state"))
                    if key not in seen:
                        seen.add(key)
                        self.mark(f"{label} lane {w.get('name')}: {w.get('state')}" + (f" · {w['note'][:70]}" if w.get("note") else ""))
                for k in ("recalled", "learned"):
                    if sw.get(k) and (k,) not in seen:
                        seen.add((k,))
                        self.mark(f"{label} {k} procedure: {sw[k].get('title')}")
            job = next((j for j in s.get("jobs") or [] if j.get("event_id") == event_id), None)
            if job:
                if ("job", job["state"]) not in seen:
                    seen.add(("job", job["state"]))
                    self.mark(f"{label} builder {job['state']}: {(job.get('note') or '')[:80]}")
                if job.get("pr") and ("pr",) not in seen:
                    seen.add(("pr",))
                    self.mark(f"{label} PR #{job['pr']} {job.get('pr_url') or ''}")
                if job["state"] in SETTLED:
                    break
            self.sleep(self.poll_s)
        else:
            self.mark(f"{label} TIMEOUT after {self.timeout_s:.0f}s" + ("" if job else " (no builder job: is QM up or BUILDER_AUTO=1?)"))
        run = {"label": label, "event_id": event_id, "wall_s": round(self.clock() - start, 1), "job": job}
        self.runs.append(run)
        return run

    def run(self, steps: list[tuple[str, str]] = REHEARSAL) -> list[dict[str, Any]]:
        self.t0 = self.clock()
        pending, n = None, 0
        for name, text in steps:
            if name == "wait":
                if pending:
                    self.wait(pending, f"run {n}")
                pending = None
                continue
            r = self.action(name)
            extra = r.get("note") or r.get("event_id") or ""
            self.mark(text + (f"  ({extra})" if extra else ""))
            if name in ("recap", "streak"):
                pending, n = r.get("event_id"), n + 1
                if not r.get("qm") and not r.get("builder_auto"):
                    self.mark("warning: QM_URL unset and BUILDER_AUTO off, nothing will build")
            self.sleep(self.delay)
        self.summary()
        return self.runs

    def summary(self) -> None:
        self.out("\nrun      state      wall  pr_opened  preview_ready  PR")
        for r in self.runs:
            j = r["job"] or {}
            tm = j.get("timings") or {}
            self.out(f"{r['label']:<8} {j.get('state', 'none'):<8} {r['wall_s']:>6.1f}s  {tm.get('pr_opened', '-')!s:>9}  "
                     f"{tm.get('preview_ready', '-')!s:>13}  {j.get('pr_url') or '-'}")
        self.out("(builder timings: seconds since the job was queued. QM turns/tool calls per worker: "
                 "~/dev/qm/scripts/world-metrics.sh <event id>)")


def rehearse(url: str, *, dry: bool, delay: float, timeout_s: float) -> None:
    if dry:
        print("rehearsal plan (dry run: nothing sent, no PRs):")
        for i, (_, text) in enumerate(REHEARSAL, 1):
            print(f"  {i}. {text}")
        return
    from . import config  # noqa: F401  (loads perception/.env so the bearer matches the service)

    token = os.environ.get("DIRECTOR_TOKEN") or os.environ.get("WORLD_HOOKS_SECRET") or ""
    with httpx.Client(base_url=url, timeout=30) as c:
        Rehearsal(c, token=token, delay=delay, timeout_s=timeout_s).run()


def main() -> None:
    ap = argparse.ArgumentParser(prog="perception.demo_inject")
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--customer2", action="store_true", help="similar second request (!streak command), recall run 2")
    ap.add_argument("--via-llm", action="store_true")
    ap.add_argument("--feature", action="store_true", help="!recap feature request (Stephen hears Matthew)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--rehearse", action="store_true", help="whole take via /director, waits for both PRs, prints a timeline")
    ap.add_argument("--timeout", type=float, default=900.0, help="rehearse: max seconds to wait per build")
    a = ap.parse_args()
    if a.rehearse:
        rehearse(a.url, dry=a.dry_run, delay=max(a.delay, 3.0), timeout_s=a.timeout)
        return
    c = httpx.Client(base_url=a.url, timeout=90)

    if a.via_llm:
        lines = FEATURE_LINES if a.feature else CUSTOMER2_LINES if a.customer2 else FEEDBACK_LINES
        who = MATT
        for speaker, text in lines:
            print(f"say ({speaker}): {text}")
            if not a.dry_run:
                c.post("/debug/utterance", json={"text": text, "speaker": speaker, "name": who["name"], "person_id": who["id"]}).raise_for_status()
            time.sleep(0.3)
        if a.dry_run:
            return
        t0 = time.perf_counter()
        r = c.post("/debug/end-conversation")
        r.raise_for_status()
        print(f"extracted in {time.perf_counter() - t0:.1f}s:")
        for ev in r.json()["events"]:
            print(" ", ev["type"], json.dumps(ev["payload"]))
        return

    events = feature_events() if a.feature else customer2_events() if a.customer2 else feedback_events()
    for ev in events:
        print(ev["type"], json.dumps(ev["payload"]))
        if not a.dry_run:
            c.post("/events", json=ev).raise_for_status()
            time.sleep(a.delay)


if __name__ == "__main__":
    main()
