import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from perception.conversation import Utterance
from perception.sinks import HudSink, QMSink
from perception.watches import PinchAdopter, WatchBoard, WatchRequester, fallback_parse, prefilter

PEOPLE = {"matthew": "Matthew", "stephen": "Stephen"}


def run(coro):
    return asyncio.run(coro)


class FakeHaiku:
    """Stands in for anthropic.AsyncAnthropic: records requests, returns a canned JSON text block."""

    def __init__(self, data):
        self.data = data
        self.calls = []
        self.messages = self

    async def create(self, **req):
        self.calls.append(req)
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(self.data))])


def requester(client=None):
    out = []

    async def emit(ev):
        out.append(ev)

    return WatchRequester(emit, people=lambda: PEOPLE, client=client), out


@pytest.mark.parametrize("text,hit", [
    ("next time Matthew brings up pricing, prep a counter-offer", True),
    ("remind me when he mentions the tournament", True),
    ("keep an eye on this", True),
    ("whenever he talks about hiring, flag it", True),
    ("watch for anything about the launch", True),
    ("that's Matthew", False),
    ("nice to meet you Matthew", False),
    ("I'll send you the new onboarding demo", False),
    ("the setup was confusing", False),
])
def test_prefilter(text, hit):
    assert prefilter(text) is hit


def test_fallback_parse_shapes():
    p = fallback_parse("next time Matthew brings up pricing, prep a counter-offer", PEOPLE, (None, None))
    assert p["person_id"] == "matthew" and p["topic_terms"] == ["pricing"] and p["action"] == "prep a counter-offer" and p["once"]
    assert p["instruction"] == "next time Matthew brings up pricing, prep a counter-offer"
    p = fallback_parse("remind me when he mentions the tournament", PEOPLE, ("matthew", "Matthew"))
    assert p["person_id"] == "matthew" and p["topic_terms"] == ["tournament"] and not p["once"]
    p = fallback_parse("keep an eye on this", PEOPLE, ("matthew", "Matthew"))
    assert p["person_id"] == "matthew" and p["topic_terms"] == []


def test_haiku_stub_builds_event():
    haiku = FakeHaiku({"is_watch": True, "instruction": "next time Matthew brings up pricing, prep a counter-offer",
                       "person_id": "matthew", "topic_terms": ["Pricing", "price"], "action": "prep a counter-offer", "once": True})
    r, out = requester(haiku)
    ev = run(r.on_utterance(Utterance(0, "next time he brings up pricing, prep a counter-offer", -20, "wearer"), ("matthew", "Matthew"), 3))
    assert ev is out[0] and ev["type"] == "world.watch_requested"
    assert ev["payload"] == {"instruction": "next time Matthew brings up pricing, prep a counter-offer", "topic_terms": ["pricing", "price"],
                             "action": "prep a counter-offer", "once": True, "person_id": "matthew", "person_name": "Matthew", "track_id": 3}
    assert [p["id"] for p in ev["people"]] == ["stephen", "matthew"]  # requester first: QM's requestedBy
    req = haiku.calls[0]
    assert req["model"] == "claude-haiku-4-5" and req["output_config"]["format"]["type"] == "json_schema"
    assert "matthew: Matthew" in req["system"] and "stephen: Stephen" not in req["system"]


def test_haiku_says_not_a_watch():
    haiku = FakeHaiku({"is_watch": False, "instruction": "", "person_id": "", "topic_terms": [], "action": "", "once": False})
    r, out = requester(haiku)
    assert run(r.on_utterance(Utterance(0, "next time we should grab lunch", -20, "wearer"))) is None
    assert out == [] and len(haiku.calls) == 1


def test_no_model_call_without_prefilter_hit():
    haiku = FakeHaiku({})
    r, out = requester(haiku)
    for text in ("that's Matthew", "hey, I'm Matthew", "the canvas setup was confusing"):
        run(r.on_utterance(Utterance(0, text, -20, "wearer"), ("matthew", "Matthew")))
    assert haiku.calls == [] and out == []


def test_only_the_wearer_arms_watches():
    haiku = FakeHaiku({"is_watch": True, "instruction": "x", "person_id": "", "topic_terms": ["pricing"], "action": "a", "once": True})
    r, out = requester(haiku)
    assert run(r.on_utterance(Utterance(0, "next time Stephen brings up pricing, remind me", -40, "other"))) is None
    assert haiku.calls == [] and out == [] and r.rejected[0][0] == "not the wearer"
    # loudness: clearly quieter than the wearer's level = the other person
    for db in (-18, -19, -40):
        run(r.on_utterance(Utterance(0, "ok", db)))
    assert run(r.on_utterance(Utterance(0, "keep an eye on the pricing", -41))) is None
    assert run(r.on_utterance(Utterance(0, "keep an eye on the pricing", -18))) is not None  # loud = wearer


def test_dedupe_and_wearer_is_never_the_target():
    r, out = requester(None)  # deterministic parser
    u = Utterance(0, "next time Matthew brings up pricing, prep a counter-offer", -20, "wearer")
    run(r.on_utterance(u))
    run(r.on_utterance(u))
    assert len(out) == 1
    ev = run(r.on_utterance(Utterance(0, "remind me when Stephen mentions the demo", -20, "wearer")))
    assert "person_id" not in ev["payload"]


def test_pinch_debounce_and_unknown():
    out = []

    async def emit(ev):
        out.append(ev)

    a = PinchAdopter(emit, debounce_s=10)
    t = SimpleNamespace(person_id="matthew", label="Matthew", track_id=4)
    ev = run(a.on_pinch(t, now=100))
    assert ev["type"] == "world.entity_adopted"
    assert ev["payload"] == {"entity_kind": "person", "entity_id": "matthew", "label": "Matthew", "track_id": 4}
    assert run(a.on_pinch(t, now=105)) is None
    assert run(a.on_pinch(t, now=111)) is not None
    assert run(a.on_pinch(SimpleNamespace(person_id=None, label="UNKNOWN PERSON 02", track_id=5), now=200)) is None
    assert len(out) == 2


def test_board_hud_flow():
    sent = []

    async def bc(m):
        sent.append(m)

    board = WatchBoard(bc)
    r, out = requester(None)
    ev = run(r.on_utterance(Utterance(0, "next time Matthew brings up pricing, prep a counter-offer", -20, "wearer")))
    run(board.emit(ev))
    assert sent[0] == {"kind": "memory_event", "text": "WATCH ARMED", "detail": "pricing · Matthew"}
    assert sent[1]["kind"] == "armed_watches" and sent[1]["items"][0]["topic"] == "pricing"
    run(board.on_qm_response(ev, 202, {"ok": True, "watch": {"id": "ww_1", "once": True, "match": {"person_id": "matthew"}}}))
    assert sent[-1]["items"][0]["qm_id"] == "ww_1"
    later = {"id": "evt_2", "type": "conversation.completed", "payload": {}}
    run(board.on_qm_response(later, 202, {"ok": True, "watches": ["ww_1"]}))
    assert {"kind": "memory_event", "text": "WATCH FIRED", "detail": "pricing · Matthew"} in sent
    assert sent[-1] == {"kind": "armed_watches", "items": []}  # once-watch is spent

    run(board.emit({"id": "e3", "type": "world.entity_adopted", "payload": {"entity_kind": "person", "entity_id": "matthew", "label": "Matthew"}}))
    assert sent[-1] == {"kind": "memory_event", "text": "AGENT ASSIGNED", "detail": "MATTHEW"}
    hud = HudSink(bc)
    hud.agent_for = board.agent_for
    card = run(hud.person_card({"payload": {"track_id": 4, "person_id": "matthew", "label": "Matthew"}}))
    assert card["agent"] == {"state": "assigned", "thread": "world:entity:person:matthew"}
    card = run(hud.person_card({"payload": {"track_id": 5, "person_id": "alex", "label": "Alex"}}))
    assert "agent" not in card


def test_qmsink_forwards_and_reports_response():
    seen, replies = [], []

    def handler(req):
        seen.append((json.loads(req.content), req.headers.get("authorization"), req.extensions.get("timeout")))
        return httpx.Response(202, json={"ok": True, "watch": {"id": "ww_9", "once": True}})

    async def on_resp(ev, status, body):
        replies.append((ev["type"], status, body["watch"]["id"]))

    async def go():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        sink = QMSink("http://qm", client=client, secret="s3", on_response=on_resp)
        r, _ = requester(None)
        ev = await r.on_utterance(Utterance(0, "next time Matthew brings up pricing, prep a counter-offer", -20, "wearer"))
        await sink.emit(ev)

    run(go())
    body, auth, timeout = seen[0]
    assert body["type"] == "world.watch_requested" and body["payload"]["person_id"] == "matthew"
    assert auth == "Bearer s3" and timeout["read"] == 45.0
    assert replies == [("world.watch_requested", 202, "ww_9")]


def test_service_wiring(tmp_path):
    from test_service import make_app

    svc, app = make_app(tmp_path)
    svc.store.people.clear()
    with TestClient(app) as c, c.websocket_connect("/ws/hud") as hud:
        hud.receive_json()  # procedure_library
        c.post("/debug/utterance", json={"text": "next time Matthew brings up pricing, prep a counter-offer", "speaker": "wearer",
                                         "name": "Matthew", "person_id": "matthew"})
        assert hud.receive_json() == {"kind": "memory_event", "text": "WATCH ARMED", "detail": "pricing · Matthew"}
        assert hud.receive_json()["kind"] == "armed_watches"
        # the instruction was said to the AI: it never reaches conversation extraction (no self-firing commitment)
        assert svc.conv.current is None or not svc.conv.current.utterances
        assert c.get("/watches").json()["watches"][0]["topic"] == "pricing"
        c.post("/debug/utterance", json={"text": "next time I bring up pricing, remind me", "speaker": "other", "name": "Matthew"})
        assert len(svc.watchboard.watches) == 1
        # a pinch on a recognized track adopts the person; the refreshed card carries the agent badge
        tr = SimpleNamespace(track_id=7, person_id="matthew", label="Matthew", bbox=(0, 0, 1, 1), match_score=0.8)
        svc.vision.tracker.tracks[7] = tr
        svc.vision._encounter_event = lambda t: {"payload": {"track_id": t.track_id, "person_id": t.person_id, "label": t.label}}
        with c.websocket_connect("/ws/quest") as q:
            q.receive_json()
            q.send_json({"kind": "gesture", "type": "pinch", "target_track_id": 7})
            assert q.receive_json() == {"kind": "memory_event", "text": "AGENT ASSIGNED", "detail": "MATTHEW"}
            card = q.receive_json()
            assert card["kind"] == "person_card" and card["agent"]["state"] == "assigned"
        assert c.post("/hud", json={"kind": "watch_fired", "watch_id": "ww_unknown"}).status_code == 200
