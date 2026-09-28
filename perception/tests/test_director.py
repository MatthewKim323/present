from fastapi.testclient import TestClient

from perception.director import DirectorLog, summarize
from test_service import make_app


class FakeQM:
    name = "qm"
    base_url = "http://qm.test"

    def __init__(self):
        self.events = []

    async def emit(self, event):
        self.events.append(event)


def app_with_fake_qm(tmp_path, monkeypatch, token=""):
    monkeypatch.setenv("WORLD_HOOKS_SECRET", token)
    monkeypatch.delenv("DIRECTOR_TOKEN", raising=False)
    svc, app = make_app(tmp_path)
    qm = FakeQM()
    svc.qm = qm
    svc.fanout.sinks = [qm if s.name == "qm" else s for s in svc.fanout.sinks]
    svc.fanout.ordered = [qm if s.name == "qm" else s for s in svc.fanout.ordered]
    return svc, app, qm


def test_page_served_and_token_required(tmp_path, monkeypatch):
    _, app, _ = app_with_fake_qm(tmp_path, monkeypatch, token="s3cret")
    with TestClient(app) as c:
        assert "WORLD · DIRECTOR" in c.get("/director").text
        assert c.get("/director/api/status").status_code == 401
        assert c.post("/director/api/action", json={"action": "facts"}).status_code == 401
        assert c.get("/director/api/status", headers={"authorization": "Bearer s3cret"}).status_code == 200
        assert c.get("/director/api/status?token=s3cret").status_code == 200


def test_actions_flow_through_fanout(tmp_path, monkeypatch):
    svc, app, qm = app_with_fake_qm(tmp_path, monkeypatch)
    with TestClient(app) as c, c.websocket_connect("/ws/hud") as hud:
        hud.receive_json()  # procedure_library on connect
        r = c.post("/director/api/action", json={"action": "recognized"}).json()
        assert r["type"] == "person.encountered"
        card = hud.receive_json()
        assert card["kind"] == "person_card" and card["name"] == "MATTHEW" and card["anchor_track_id"] == 4

        c.post("/director/api/action", json={"action": "facts"})
        r = c.post("/director/api/action", json={"action": "recap"}).json()
        assert r["qm"] is True
        c.post("/director/api/action", json={"action": "watch"})
        types = [e["type"] for e in qm.events]
        assert types == ["person.encountered", "relationship.updated", "feature_request.detected", "world.watch_requested"]
        fr = qm.events[2]
        assert fr["id"] == r["event_id"] and fr["payload"]["feature"] == "Add !recap command" and fr["payload"]["anchor_track_id"] == 4

        s = c.get("/director/api/status").json()
        kinds = [m["kind"] for m in s["recent"]]
        assert "person_card" in kinds and "context_delta" in kinds
        assert s["qm_url"] == "http://qm.test" and s["enrolled"] == []
        assert [a["action"] for a in s["actions"]][:2] == ["watch", "recap"]

        svc.devfeed.on_hud({"kind": "agent_activity", "hook": "feature_request.detected", "workers": [{"name": "Context", "state": "running"}]})
        assert c.get("/director/api/status").json()["swarm"]["workers"][0]["name"] == "Context"
        c.post("/director/api/action", json={"action": "reset"})
        assert c.get("/director/api/status").json()["swarm"] is None
        assert c.post("/director/api/action", json={"action": "nope"}).status_code == 422


def test_intro_goes_through_utterance_path(tmp_path, monkeypatch):
    svc, app, _ = app_with_fake_qm(tmp_path, monkeypatch)
    seen = []
    svc.intro.on_utterance = lambda u: seen.append((u.text, u.speaker))
    with TestClient(app) as c:
        r = c.post("/director/api/action", json={"action": "intro"}).json()
    assert seen == [("Hey, I'm Matthew.", "other person")]
    assert "no unknown face" in r["note"]


def test_forget_face_and_reload(tmp_path, monkeypatch, rng):
    from conftest import person_embs, unit

    svc, app, _ = app_with_fake_qm(tmp_path, monkeypatch)
    svc.store.add("Matthew", person_embs(rng, unit(rng.standard_normal(128))))
    backup = (tmp_path / "people.json").read_text()
    with TestClient(app) as c:
        assert c.post("/director/api/action", json={"action": "forget_face"}).json()["enrolled"] == []
        (tmp_path / "people.json").write_text(backup)
        assert c.post("/director/api/action", json={"action": "reload_people"}).json()["enrolled"] == ["matthew"]


def test_log_folds_duplicates_and_counts_gbrain_ops():
    log = DirectorLog(n=3)
    for _ in range(3):
        log({"kind": "memory_event", "text": "X", "detail": "y"})
    log({"kind": "gbrain_op", "op": "get_page", "actor": "card", "slug": "people/matthew", "count": 2})
    log({"kind": "vision", "tracks": []})
    assert len(log.recent) == 2 and log.recent[0]["n"] == 3
    assert log.counts["gbrain_op"] == 2 and "vision" not in log.counts
    assert summarize({"kind": "qm_swarm", "hook": "h", "workers": [{"name": "Builder", "state": "done"}]}) == "h [Builder:done]"


def test_recognized_relabels_open_unknown_encounter(tmp_path, monkeypatch):
    # Matthew starts talking before recognition: the encounter opens with no person_id, and live.py skips such encounters
    svc, app, _ = app_with_fake_qm(tmp_path, monkeypatch)
    with TestClient(app) as c:
        c.post("/director/api/action", json={"action": "intro"})
        enc = svc.conv.current
        assert enc is not None and enc.person_id is None
        c.post("/director/api/action", json={"action": "recognized"})
        assert svc.conv.current is enc and enc.person_id == "matthew" and enc.name == "Matthew"


def test_watch_button_carries_topic_and_person(tmp_path, monkeypatch):
    # the WATCH ARMED toast detail is built from topic_terms + person_name; the button used to send only the instruction
    svc, app, qm = app_with_fake_qm(tmp_path, monkeypatch)
    with TestClient(app) as c, c.websocket_connect("/ws/hud") as hud:
        hud.receive_json()  # procedure_library
        c.post("/director/api/action", json={"action": "watch"})
        assert hud.receive_json() == {"kind": "memory_event", "text": "WATCH ARMED", "detail": "pricing · Matthew"}
    p = qm.events[0]["payload"]
    assert p["topic_terms"] == ["pricing"] and p["person_name"] == "Matthew" and p["action"] == "prep a counter-offer" and p["once"]


def test_reset_clears_gbrain_memory_and_status_has_health_pills(tmp_path, monkeypatch):
    svc, app, _ = app_with_fake_qm(tmp_path, monkeypatch)
    calls = []

    async def reset_memory():
        calls.append(1)

    svc.gbrain.reset_memory = reset_memory
    with TestClient(app) as c:
        c.post("/director/api/action", json={"action": "reset"})
        s = c.get("/director/api/status").json()
    assert calls == [1]
    assert s["llm"] is False and s["asr"] == "NullTranscriber" and s["vision"] is False and s["memorable"] is False
