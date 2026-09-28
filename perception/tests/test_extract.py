import asyncio
import json
from types import SimpleNamespace

from perception.conversation import ConversationManager, Encounter, Utterance
from perception.extract import OUTPUT_SCHEMA, Extractor, parse_extraction

BLANK = {k: "" for k in OUTPUT_SCHEMA["properties"]["events"]["items"]["required"]}
BLANK["decided_by"] = []


def ev(**kw):
    return {**BLANK, "confidence": 0.9, **kw}


WEARER = {"wearer_id": "stephen", "wearer_name": "Stephen"}


def matthew_enc():
    enc = Encounter("e1", "matthew", "Matthew", 3, 100.0, 100.0)
    enc.utterances = [
        Utterance(101.0, "I couldn't tell how I actually get paid, I'd get my squad on the Discord bot if that were clear.", -38.0),
        Utterance(105.0, "I'll send you the Discord invite and a payouts walkthrough tonight.", -22.0),
    ]
    return enc


LLM_JSON = {
    "summary": "Matthew couldn't tell how Opal pays players; Stephen will send the Discord invite and a payouts walkthrough.",
    "project": "Opal",
    "events": [
        ev(type="customer_feedback.detected", product="Opal", feature="Landing page", sentiment="neg",
           feedback="Unclear how players get paid", buying_signal="Would bring his squad if payouts were clear", confidence=0.93),
        ev(type="commitment.detected", actor="Stephen", recipient="Matthew", commitment="Send Discord invite and payouts walkthrough", confidence=0.94),
        ev(type="decision.detected", decision=""),  # empty -> dropped
        ev(type="not.a.type"),
    ],
}


def test_parse_extraction_maps_contract_payloads():
    out = parse_extraction(json.dumps(LLM_JSON), matthew_enc(), **WEARER)
    types = [e["type"] for e in out]
    assert types == ["customer_feedback.detected", "commitment.detected", "conversation.completed"]
    fb, cm, done = out
    assert fb["payload"] == {"product": "Opal", "feature": "Landing page", "sentiment": "neg",
                             "feedback": "Unclear how players get paid", "buying_signal": "Would bring his squad if payouts were clear"}
    assert fb["project"] == "opal" and fb["confidence"] == 0.93
    assert cm["payload"] == {"actor": "Stephen", "recipient": "Matthew", "commitment": "Send Discord invite and payouts walkthrough"}
    assert {p["id"] for p in cm["people"]} == {"stephen", "matthew"}
    assert done["payload"]["speakers"] == ["stephen", "matthew"]
    assert done["payload"]["utterances"] == 2
    assert "transcript" not in json.dumps(done)
    for e in out:
        assert e["id"].startswith("evt_") and e["ts"].endswith("Z")


def test_parse_handles_bad_values():
    data = {"summary": "", "project": "", "events": [ev(type="customer_feedback.detected", feedback="meh", sentiment="??", confidence="x")]}
    fb = parse_extraction(data, matthew_enc(), **WEARER)[0]
    assert fb["payload"]["sentiment"] == "mixed" and fb["confidence"] == 0.5
    assert "buying_signal" not in fb["payload"]


def test_unknown_partner_has_no_person_id():
    enc = Encounter("e2", None, "UNKNOWN PERSON 03", 5, 0.0, 0.0, [Utterance(1.0, "hi")])
    done = parse_extraction({"summary": "hi", "project": "", "events": []}, enc, **WEARER)[-1]
    assert done["payload"]["speakers"] == ["stephen"]
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
    x = Extractor(client=SimpleNamespace(messages=msgs), **WEARER)
    out = asyncio.run(x.extract(matthew_enc(), source="desktop-sim"))
    assert [e["type"] for e in out][-1] == "conversation.completed"
    assert all(e["source"] == "desktop-sim" for e in out)
    req = msgs.calls[0]
    assert req["model"] == "claude-sonnet-5"
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "likely wearer" in req["messages"][0]["content"]  # loudness hint on the -22 dB line
    assert "Stephen" in req["system"] and "Matthew" in req["system"]


def test_extractor_without_client_emits_only_completed():
    x = Extractor(client=None)
    x.client = None
    out = asyncio.run(x.extract(matthew_enc()))
    assert [e["type"] for e in out] == ["conversation.completed"]


def test_conversation_ends_on_gap_and_leave():
    cm = ConversationManager(gap_s=10, leave_grace_s=4)
    cm.add_utterance(Utterance(0.0, "hi"), "matthew", "Matthew", 3)
    cm.person_seen("matthew", "Matthew", 2.0)
    assert cm.tick(5.0) == []
    closed = cm.tick(6.5)  # matthew not seen for 4.5s
    assert len(closed) == 1 and closed[0].name == "Matthew"
    cm.add_utterance(Utterance(20.0, "yo"), None, None, None)
    assert cm.tick(29.0) == [] and len(cm.tick(30.5)) == 1


def test_partner_change_closes_encounter():
    cm = ConversationManager()
    cm.add_utterance(Utterance(0.0, "a"), "matthew", "Matthew", 3)
    closed = cm.add_utterance(Utterance(1.0, "b"), "sam", "Sam", 4)
    assert [e.name for e in closed] == ["Matthew"] and cm.current.name == "Sam"


def test_parse_feature_request():
    data = {"summary": "s", "project": "Opal", "events": [
        ev(type="feature_request.detected", product="Opal", feature="Add How it works section under hero",
           request="Show three steps under the hero", requested_by="Matthew",
           acceptance=["Section below the hero", " ", "Three numbered steps"]),
        ev(type="feature_request.detected"),  # empty -> dropped
    ]}
    out = parse_extraction(data, matthew_enc(), **WEARER)
    fr = [e for e in out if e["type"] == "feature_request.detected"]
    assert len(fr) == 1
    assert fr[0]["payload"] == {"product": "Opal", "feature": "Add How it works section under hero",
                                "request": "Show three steps under the hero", "requested_by": "Matthew",
                                "acceptance": ["Section below the hero", "Three numbered steps"]}
    assert fr[0]["project"] == "opal"


def test_anthropic_client_has_a_short_timeout(monkeypatch):
    # the watch parse is awaited inline in the utterance path: the SDK default (600s, 2 retries) would stall ASR
    from perception.live import RollingExtractor

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("WORLD_LLM_TIMEOUT_S", raising=False)
    x = Extractor(**WEARER)
    assert x.client.timeout == 15.0 and x.client.max_retries == 1
    monkeypatch.setenv("WORLD_LLM_TIMEOUT_S", "3")
    live = RollingExtractor(lambda ev: None)
    assert live.client.timeout == 3.0 and live.client.max_retries == 1


def test_missing_api_key_warns_once_at_startup(monkeypatch, caplog):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with caplog.at_level("WARNING", logger="world.extract"):
        x = Extractor(**WEARER)
    assert x.client is None
    assert [r for r in caplog.records if "ANTHROPIC_API_KEY" in r.getMessage() and r.levelname == "WARNING"]


def test_identify_names_open_unknown_encounter():
    # live extraction skips encounters without a person_id: recognizing Matthew mid-talk must keep the same encounter
    cm = ConversationManager()
    cm.add_utterance(Utterance(0.0, "hey"), None, None, None)
    first = cm.current
    assert cm.identify("matthew", "Matthew", 4)
    assert cm.current is first and first.person_id == "matthew" and first.name == "Matthew" and first.track_id == 4
    assert not cm.identify("sam", "Sam", 5)  # already identified: never re-labelled
    cm.add_utterance(Utterance(1.0, "yo"), None, None, 7)
    cm.force_end()
    cm.add_utterance(Utterance(2.0, "hi"), None, "UNKNOWN PERSON 02", 7)
    assert not cm.identify("matthew", "Matthew", 8)  # a different tracked face is not this encounter's partner
    assert cm.identify("matthew", "Matthew", 7)
