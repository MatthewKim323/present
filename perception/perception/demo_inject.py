"""Scripted demo events, no cameras needed. Stephen (Opal founder) wears the Quest; Matthew is the customer.

  uv run python -m perception.demo_inject                  # Matthew gives Opal feedback + Stephen commits to a follow-up
  uv run python -m perception.demo_inject --feature        # Matthew asks for a `!recap` command in the Opal Discord bot
  uv run python -m perception.demo_inject --customer2      # second, similar bot command (`!streak`), Memorable recall run 2
  uv run python -m perception.demo_inject --via-llm        # inject utterances + end conversation, exercises Claude extraction
  uv run python -m perception.demo_inject --feature --via-llm   # same, through Claude
  run the service with WORLD_WEARER_ID=stephen WORLD_WEARER_NAME=Stephen
  options: --url http://localhost:8787  --delay 1.5  --dry-run
"""
from __future__ import annotations

import argparse
import json
import time

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


def main() -> None:
    ap = argparse.ArgumentParser(prog="perception.demo_inject")
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--customer2", action="store_true", help="similar second request (!streak command), recall run 2")
    ap.add_argument("--via-llm", action="store_true")
    ap.add_argument("--feature", action="store_true", help="!recap feature request (Stephen hears Matthew)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
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
