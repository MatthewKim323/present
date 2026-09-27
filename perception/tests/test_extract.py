import asyncio
import json
from types import SimpleNamespace

from perception.conversation import ConversationManager, Encounter, Utterance
from perception.extract import OUTPUT_SCHEMA, Extractor, parse_extraction

BLANK = {k: "" for k in OUTPUT_SCHEMA["properties"]["events"]["items"]["required"]}
BLANK["decided_by"] = []


def ev(**kw):
    return {**BLANK, "confidence": 0.9, **kw}


def alex_enc():
    enc = Encounter("e1", "alex", "Alex", 3, 100.0, 100.0)
    enc.utterances = [
        Utterance(101.0, "Canvas setup was confusing, we'd roll it out if onboarding were easier.", -38.0),
        Utterance(105.0, "I'll send you the new onboarding demo.", -22.0),
    ]
    return enc


LLM_JSON = {
    "summary": "Alex found Canvas setup confusing; Matthew will send the onboarding demo.",
    "project": "Syla",
    "events": [
        ev(type="customer_feedback.detected", product="Syla", feature="Canvas onboarding", sentiment="neg",
           feedback="Canvas setup was confusing", buying_signal="Would roll out if onboarding were easier", confidence=0.93),
        ev(type="commitment.detected", actor="Matthew", recipient="Alex", commitment="Send updated onboarding demo", confidence=0.94),
        ev(type="decision.detected", decision=""),  # empty -> dropped
        ev(type="not.a.type"),
    ],
}


def test_parse_extraction_maps_contract_payloads():
    out = parse_extraction(json.dumps(LLM_JSON), alex_enc())
    types = [e["type"] for e in out]
    assert types == ["customer_feedback.detected", "commitment.detected", "conversation.completed"]
    fb, cm, done = out
    assert fb["payload"] == {"product": "Syla", "feature": "Canvas onboarding", "sentiment": "neg",
                             "feedback": "Canvas setup was confusing", "buying_signal": "Would roll out if onboarding were easier"}
    assert fb["project"] == "syla" and fb["confidence"] == 0.93
    assert cm["payload"] == {"actor": "Matthew", "recipient": "Alex", "commitment": "Send updated onboarding demo"}
    assert {p["id"] for p in cm["people"]} == {"matthew", "alex"}
    assert done["payload"]["speakers"] == ["matthew", "alex"]
    assert done["payload"]["utterances"] == 2
    assert "transcript" not in json.dumps(done)
    for e in out:
        assert e["id"].startswith("evt_") and e["ts"].endswith("Z")


def test_parse_handles_bad_values():
    data = {"summary": "", "project": "", "events": [ev(type="customer_feedback.detected", feedback="meh", sentiment="??", confidence="x")]}
    fb = parse_extraction(data, alex_enc())[0]
    assert fb["payload"]["sentiment"] == "mixed" and fb["confidence"] == 0.5
    assert "buying_signal" not in fb["payload"]


def test_unknown_partner_has_no_person_id():
    enc = Encounter("e2", None, "UNKNOWN PERSON 03", 5, 0.0, 0.0, [Utterance(1.0, "hi")])
    done = parse_extraction({"summary": "hi", "project": "", "events": []}, enc)[-1]
    assert done["payload"]["speakers"] == ["matthew"]
    assert done["people"][1] == {"id": None, "name": "UNKNOWN PERSON 03", "enrolled": False}


class FakeMessages:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(self.payload))])


def test_extractor_with_mocked_llm():
    msgs = FakeMessages(LLM_JSON)
    x = Extractor(client=SimpleNamespace(messages=msgs))
    out = asyncio.run(x.extract(alex_enc(), source="desktop-sim"))
    assert [e["type"] for e in out][-1] == "conversation.completed"
    assert all(e["source"] == "desktop-sim" for e in out)
    req = msgs.calls[0]
    assert req["model"] == "claude-sonnet-5"
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "likely wearer" in req["messages"][0]["content"]  # loudness hint on the -22 dB line
    assert "Matthew" in req["system"] and "Alex" in req["system"]


def test_extractor_without_client_emits_only_completed():
    x = Extractor(client=None)
    x.client = None
    out = asyncio.run(x.extract(alex_enc()))
    assert [e["type"] for e in out] == ["conversation.completed"]


def test_conversation_ends_on_gap_and_leave():
    cm = ConversationManager(gap_s=10, leave_grace_s=4)
    cm.add_utterance(Utterance(0.0, "hi"), "alex", "Alex", 3)
    cm.person_seen("alex", "Alex", 2.0)
    assert cm.tick(5.0) == []
    closed = cm.tick(6.5)  # alex not seen for 4.5s
    assert len(closed) == 1 and closed[0].name == "Alex"
    cm.add_utterance(Utterance(20.0, "yo"), None, None, None)
    assert cm.tick(29.0) == [] and len(cm.tick(30.5)) == 1


def test_partner_change_closes_encounter():
    cm = ConversationManager()
    cm.add_utterance(Utterance(0.0, "a"), "alex", "Alex", 3)
    closed = cm.add_utterance(Utterance(1.0, "b"), "sam", "Sam", 4)
    assert [e.name for e in closed] == ["Alex"] and cm.current.name == "Sam"


def test_parse_feature_request():
    data = {"summary": "s", "project": "Syla", "events": [
        ev(type="feature_request.detected", product="Syla", feature="Add onboarding progress checklist",
           request="Show a checklist at the top of onboarding", requested_by="Matthew",
           acceptance=["Checklist with 4 steps", " ", "Progress bar"]),
        ev(type="feature_request.detected"),  # empty -> dropped
    ]}
    out = parse_extraction(data, alex_enc())
    fr = [e for e in out if e["type"] == "feature_request.detected"]
    assert len(fr) == 1
    assert fr[0]["payload"] == {"product": "Syla", "feature": "Add onboarding progress checklist",
                                "request": "Show a checklist at the top of onboarding", "requested_by": "Matthew",
                                "acceptance": ["Checklist with 4 steps", "Progress bar"]}
    assert fr[0]["project"] == "syla"
