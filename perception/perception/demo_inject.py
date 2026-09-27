"""Scripted demo events, no cameras needed.

  uv run python -m perception.demo_inject                  # Alex scenario: POST ready-made WorldEvents to /events
  uv run python -m perception.demo_inject --customer2      # second customer, similar Canvas complaint (run 2)
  uv run python -m perception.demo_inject --via-llm        # inject utterances + end conversation, exercises Claude extraction
  options: --url http://localhost:8787  --delay 1.5  --dry-run
"""
from __future__ import annotations

import argparse
import json
import time

import httpx

from .events import make_event

ALEX = {"id": "alex", "name": "Alex", "enrolled": True}
PRIYA = {"id": "priya", "name": "Priya", "enrolled": True}
MATT = {"id": "matthew", "name": "Matthew", "enrolled": True}


def scenario(person: dict, track_id: int, feedback: str, buying: str | None, commitment: str) -> list[dict]:
    src = "manual"
    people = [MATT, person]
    fb = {"product": "Syla", "feature": "Canvas onboarding", "sentiment": "neg", "feedback": feedback}
    if buying:
        fb["buying_signal"] = buying
    return [
        make_event("person.encountered", {"track_id": track_id, "person_id": person["id"], "label": person["name"],
                                          "bbox": [412, 188, 164, 212], "match_score": 0.71},
                   source=src, confidence=0.71, people=[person]),
        make_event("customer_feedback.detected", fb, source=src, confidence=0.93, people=people, project="syla"),
        make_event("commitment.detected", {"actor": "Matthew", "recipient": person["name"], "commitment": commitment},
                   source=src, confidence=0.94, people=people, project="syla"),
        make_event("conversation.completed", {"duration_s": 42.0,
                                              "summary": f"{person['name']} found Canvas setup confusing; Matthew will send the new onboarding demo.",
                                              "speakers": ["matthew", person["id"]], "utterances": 6},
                   source=src, confidence=1.0, people=people, project="syla"),
    ]


ALEX_EVENTS = lambda: scenario(ALEX, 3, "Canvas setup was confusing", "Would roll it out if onboarding were easier",  # noqa: E731
                               "Send updated onboarding demo")
PRIYA_EVENTS = lambda: scenario(PRIYA, 7, "Connecting Canvas during setup was hard to figure out", None,  # noqa: E731
                                "Send onboarding walkthrough")

ALEX_LINES = [
    ("other", "Hey, so we tried the Syla trial with the team last week."),
    ("wearer", "Oh nice, how did it go?"),
    ("other", "Honestly the Canvas setup was confusing. Nobody could figure out the connect step."),
    ("other", "If onboarding were easier we'd probably roll it out to the whole org."),
    ("wearer", "Totally fair. We just rebuilt onboarding. I'll send you the new onboarding demo tonight."),
    ("other", "Perfect, thanks."),
]


def main() -> None:
    ap = argparse.ArgumentParser(prog="perception.demo_inject")
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--customer2", action="store_true")
    ap.add_argument("--via-llm", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    c = httpx.Client(base_url=a.url, timeout=90)

    if a.via_llm:
        for speaker, text in ALEX_LINES:
            print(f"say ({speaker}): {text}")
            if not a.dry_run:
                c.post("/debug/utterance", json={"text": text, "speaker": speaker, "name": "Alex", "person_id": "alex"}).raise_for_status()
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

    events = PRIYA_EVENTS() if a.customer2 else ALEX_EVENTS()
    for ev in events:
        print(ev["type"], json.dumps(ev["payload"]))
        if not a.dry_run:
            c.post("/events", json=ev).raise_for_status()
            time.sleep(a.delay)


if __name__ == "__main__":
    main()
