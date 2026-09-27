"""Scripted demo events, no cameras needed. Stephen (Opal founder) wears the Quest; Matthew is the customer.

  uv run python -m perception.demo_inject                  # Matthew gives Opal feedback + Stephen commits to a follow-up
  uv run python -m perception.demo_inject --feature        # Matthew asks for a "How it works" section on the Opal landing page
  uv run python -m perception.demo_inject --customer2      # second, similar landing page request ("How payouts work"), Memorable recall run 2
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
    """Default: Matthew tells Stephen what's confusing about Opal, Stephen commits to a follow-up."""
    return [
        encountered(),
        make_event("customer_feedback.detected", {"product": "Opal", "feature": "Landing page", "sentiment": "mixed",
                                                  "feedback": "Landing page sells the data engine but never says how a player actually gets paid",
                                                  "buying_signal": "Would get his friends on the Discord bot if the payout flow were clear"},
                   source=SRC, confidence=0.92, people=PEOPLE, project=PROJECT),
        make_event("commitment.detected", {"actor": "Stephen", "recipient": "Matthew",
                                           "commitment": "Send Matthew the Opal Discord invite and a walkthrough of payouts"},
                   source=SRC, confidence=0.93, people=PEOPLE, project=PROJECT),
        completed("Matthew liked Opal but couldn't tell from the landing page how players get paid; "
                  "Stephen will send the Discord invite and a payouts walkthrough.", 42.0),
    ]


FEATURE_REQUEST = {
    "product": "Opal",
    "feature": "Add How it works section under hero",
    "request": "Show three steps under the hero: play, Opal labels your gameplay, get paid",
    "requested_by": "Matthew",
    "acceptance": ["Section directly below the hero", "Three numbered steps"],
}

FEATURE_REQUEST_2 = {
    "product": "Opal",
    "feature": "Add How payouts work section above the final CTA",
    "request": "Explain payouts in three short points above the final call to action: you play, your gameplay gets labeled, you get paid in SOL or USDC",
    "requested_by": "Matthew",
    "acceptance": ["Section directly above the final CTA", "Mentions SOL and USDC payouts"],
}


def feature_events(spec: dict = FEATURE_REQUEST, summary: str | None = None) -> list[dict]:
    """Stephen (founder, wearing the Quest) talks to Matthew (customer). Matthew asks for a concrete landing page change."""
    return [
        encountered(),
        make_event("customer_feedback.detected", {"product": "Opal", "feature": "Landing page", "sentiment": "mixed",
                                                  "feedback": "The hero looks sick but it doesn't say what a player actually does",
                                                  "buying_signal": "Would share the site with his gaming group chat once it's clear"},
                   source=SRC, confidence=0.92, people=PEOPLE, project=PROJECT),
        make_event("feature_request.detected", dict(spec), source=SRC, confidence=0.93, people=PEOPLE, project=PROJECT),
        completed(summary or "Matthew asked for a How it works section under the Opal hero; Stephen agreed to ship it today.", 38.0),
    ]


def customer2_events() -> list[dict]:
    """Run 2 for Memorable recall: a similar, not identical, landing page request."""
    return feature_events(FEATURE_REQUEST_2, "Matthew asked for a How payouts work section above the final CTA; "
                                             "Stephen said he'd get it in.")


FEEDBACK_LINES = [
    ("other", "Yo, I was messing with Opal last night. The landing page goes crazy."),
    ("wearer", "Appreciate it. Anything feel off?"),
    ("other", "Honestly I couldn't tell how I actually get paid. It says players aren't seeing a cent, then it's all data engine stuff."),
    ("other", "If the payout part were clearer I'd get my whole squad on the Discord bot."),
    ("wearer", "Fair. I'll send you the Discord invite and a quick walkthrough of how payouts work tonight."),
    ("other", "Bet, thanks."),
]

FEATURE_LINES = [
    ("other", "Yo, I checked out the Opal site. The hero looks sick."),
    ("wearer", "Appreciate it. Did it make sense what we do?"),
    ("other", "Kinda? I get it's for AI, but it doesn't say what I actually do as a player."),
    ("other", "You should put a How it works section right under the hero. Three numbered steps: you play, Opal labels your gameplay, you get paid."),
    ("wearer", "That's a great call. We can ship that today."),
    ("other", "Do that and I'm sending it to my whole group chat."),
]

CUSTOMER2_LINES = [
    ("other", "Okay the How it works part is way better."),
    ("wearer", "Nice, anything else?"),
    ("other", "People are gonna ask how payouts work though. Like what do I get paid in?"),
    ("other", "Add a How payouts work section right above the last call to action. Three short points, and say it's SOL or USDC."),
    ("wearer", "Easy, I'll get that in."),
    ("other", "Perfect."),
]


def main() -> None:
    ap = argparse.ArgumentParser(prog="perception.demo_inject")
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--customer2", action="store_true", help="similar second request (How payouts work), recall run 2")
    ap.add_argument("--via-llm", action="store_true")
    ap.add_argument("--feature", action="store_true", help="How it works feature request (Stephen hears Matthew)")
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
