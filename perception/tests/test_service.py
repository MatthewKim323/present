import numpy as np
from fastapi.testclient import TestClient

from conftest import person_embs, unit
from perception.config import Settings
from perception.extract import Extractor
from perception.faces import Face
from perception.audio import NullTranscriber
from perception.people import PeopleStore
from perception.service import WorldService, create_app
from perception.vision import VisionPipeline


def make_app(tmp_path):
    s = Settings()
    s.people_path = tmp_path / "people.json"
    s.events_log_path = tmp_path / "events.jsonl"
    s.qm_url = ""
    s.gbrain_backend = "stub"
    x = Extractor(client=None)
    x.client = None
    svc = WorldService(s, load_models=False, transcriber=NullTranscriber(), extractor=x)
    return svc, create_app(svc)


def test_post_event_fans_out_to_hud(tmp_path):
    svc, app = make_app(tmp_path)
    with TestClient(app) as c, c.websocket_connect("/ws/hud") as hud:
        r = c.post("/events", json={"type": "customer_feedback.detected", "people": [{"id": "matthew", "name": "Matthew", "enrolled": True}],
                                    "payload": {"product": "Opal", "feature": "Landing page", "sentiment": "neg", "feedback": "unclear payouts"}})
        assert r.status_code == 200
        assert hud.receive_json() == {"kind": "memory_event", "text": "CUSTOMER FEEDBACK REMEMBERED", "detail": "Opal Landing page"}
        c.post("/events", json={"type": "commitment.detected", "people": [{"id": "matthew"}],
                                "payload": {"actor": "Stephen", "recipient": "Matthew", "commitment": "Send payouts walkthrough"}})
        hud.receive_json()
        c.post("/events", json={"type": "person.encountered", "payload": {"track_id": 3, "person_id": "matthew", "label": "Matthew", "bbox": [0, 0, 1, 1], "match_score": 0.7}})
        card = hud.receive_json()
        assert card["kind"] == "person_card" and card["name"] == "MATTHEW" and card["anchor_track_id"] == 3
        assert card["you_owe"] == "Send payouts walkthrough"
        assert card["last"] == "Opal Landing page"
    assert (tmp_path / "events.jsonl").read_text().count("\n") == 3


def test_post_event_rejects_bad_type(tmp_path):
    _, app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post("/events", json={"type": "nope"}).status_code == 422
        assert c.post("/hud", json={"kind": "agent_activity", "hook": "x", "workers": []}).status_code == 200


def test_debug_utterance_and_end(tmp_path):
    _, app = make_app(tmp_path)
    with TestClient(app) as c:
        c.post("/debug/utterance", json={"text": "hello", "name": "Matthew"})
        evs = c.post("/debug/end-conversation").json()["events"]
        assert [e["type"] for e in evs] == ["conversation.completed"]
        assert evs[0]["people"][1]["name"] == "Matthew"


class FakeEngine:
    """Returns scripted faces + embeddings so the vision pipeline runs without models."""

    def __init__(self):
        self.faces = []
        self.embs = []

    def detect(self, frame):
        return self.faces

    def embed(self, frame, face):
        return self.embs[self.faces.index(face)]


def test_vision_identifies_enrolled_and_labels_unknown(rng, tmp_path):
    matthew_c, stranger_c = rng.standard_normal(128), rng.standard_normal(128)
    store = PeopleStore(tmp_path / "p.json")
    store.add("Matthew", person_embs(rng, matthew_c))
    eng = FakeEngine()
    v = VisionPipeline(eng, store, enroll_samples=3)
    frame = np.zeros((480, 640, 3), np.uint8)
    events = []
    for i in range(6):
        eng.faces = [Face((100 + i, 100, 80, 80), 0.9, None), Face((400, 100, 80, 80), 0.9, None)]
        eng.embs = [unit(matthew_c + 0.1 * rng.standard_normal(128)), unit(stranger_c)]
        events += v.process(frame, ts=i * 0.2).events
    enc = [e for e in events if e["type"] == "person.encountered"]
    assert len(enc) == 2  # debounced: one per track
    labels = {e["payload"]["label"] for e in enc}
    assert labels == {"Matthew", "UNKNOWN PERSON 01"}
    unknown = next(e for e in enc if e["payload"]["person_id"] is None)

    # opt-in: "that's Sam"
    v.request_label(unknown["payload"]["track_id"], "Sam")
    for i in range(6, 12):
        events = v.process(frame, ts=i * 0.2).events
        if any(e["type"] == "person.enrolled" for e in events):
            break
    assert any(e["type"] == "person.enrolled" and e["payload"]["person_id"] == "sam" for e in events)
    assert "sam" in store.people
    assert store.match(unit(stranger_c))[0] == "sam"
