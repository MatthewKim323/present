import asyncio

import numpy as np
import pytest

from conftest import person_embs, unit
from perception.conversation import Utterance
from perception.faces import Face
from perception.intro import IntroEnroller, attribute, parse_intro
from perception.people import PeopleStore
from perception.sinks import StubGBrainSink
from perception.vision import VisionPipeline
from perception.visionfx import RelationshipVectors, VisionFx, embedding_sig, vision_message


# ---------------------------------------------------------------- intro regex

@pytest.mark.parametrize("text,kind,name", [
    ("Hey, I'm Matthew, I run a small studio", "self", "Matthew"),
    ("hi my name is matthew", "self", "Matthew"),
    ("My name's Priya.", "self", "Priya"),
    ("you can call me Jo", "self", "Jo"),
    ("I am Stephen and this is Opal", "self", "Stephen"),
    ("Nice to meet you, Matthew.", "confirm", "Matthew"),
    ("oh great to meet you matthew", "confirm", "Matthew"),
    ("It’s nice meeting you Sam", "confirm", "Sam"),
])
def test_parse_intro_hits(text, kind, name):
    got = parse_intro(text)
    assert got is not None and (got.kind, got.name) == (kind, name)


@pytest.mark.parametrize("text", [
    "I'm good, thanks", "I'm going to send it later", "i'm matthew",  # lowercase I'm X is too ambiguous
    "I'm Not sure", "I'm Just looking", "nice to meet you", "what's your name", "call me later",
])
def test_parse_intro_misses(text):
    assert parse_intro(text) is None


def test_attribution():
    assert attribute("other person", -40, []) == ("other", True)
    assert attribute("wearer", -20, []) == ("wearer", True)
    assert attribute(None, -30, [-30, -31]) == ("unclear", False)          # too few levels
    assert attribute(None, -28, [-20, -21, -28]) == ("other", False)        # quieter than mid, not by much
    assert attribute(None, -32, [-20, -21, -32]) == ("other", True)         # clearly below the wearer's level
    assert attribute(None, -20, [-20, -21, -32]) == ("wearer", False)


# ---------------------------------------------------------------- learning state machine

class FakeEngine:
    def __init__(self):
        self.faces, self.embs = [], []

    def detect(self, frame):
        return self.faces

    def embed(self, frame, face):
        return self.embs[self.faces.index(face)]


def _row(x, y, w, h, score=0.93):
    r = np.zeros(15, np.float32)
    r[:4] = (x, y, w, h)
    r[4:14] = [x + 0.3 * w, y + 0.4 * h, x + 0.7 * w, y + 0.4 * h, x + 0.5 * w, y + 0.6 * h,
               x + 0.35 * w, y + 0.8 * h, x + 0.65 * w, y + 0.8 * h]
    r[14] = score
    return r


def _setup(rng, tmp_path):
    store = PeopleStore(tmp_path / "p.json")
    store.add("Stephen", person_embs(rng, rng.standard_normal(128)))
    eng = FakeEngine()
    v = VisionPipeline(eng, store, enroll_samples=12)
    return store, eng, v


def _frame_with(eng, center, rng, i):
    b = (200 + i, 120, 120, 140)
    eng.faces = [Face(b, 0.93, _row(*b))]
    eng.embs = [unit(center + 0.1 * rng.standard_normal(128))]


def test_self_intro_learns_unknown_track(rng, tmp_path):
    store, eng, v = _setup(rng, tmp_path)
    frame = np.full((480, 640, 3), 90, np.uint8)
    center = rng.standard_normal(128)
    states = []
    for i in range(5):
        _frame_with(eng, center, rng, i)
        v.process(frame, ts=i * 0.2)
        states.append(vision_message(list(v.tracker.tracks.values()), store, 640, 480)["tracks"][0]["state"])
    assert states[:2] == ["detecting", "matching"] and states[-1] == "unknown"

    intro = IntroEnroller(v, "Stephen", "stephen", samples=8)
    assert intro.on_utterance(Utterance(1.0, "I'm Stephen", -20, speaker="wearer")) is None  # wearer's own name
    act = intro.on_utterance(Utterance(2.0, "hey I'm Matthew", -38, speaker="other person"))
    assert act["action"] == "enroll" and act["name"] == "Matthew"

    events, captures, learning = [], [], []
    for i in range(5, 20):
        _frame_with(eng, center, rng, i)
        res = v.process(frame, ts=i * 0.2)
        events += res.events
        captures += res.captures
        msg = vision_message(list(v.tracker.tracks.values()), store, 640, 480)
        learning.append((msg["tracks"][0]["state"], (msg["tracks"][0].get("samples") or {}).get("n")))
        if any(e["type"] == "person.enrolled" for e in res.events):
            break
    assert learning[0] == ("learning", 1)
    assert [s for s, _ in learning[:-1]] == ["learning"] * (len(learning) - 1) and learning[-1][0] == "recognized"
    enrolled = next(e for e in events if e["type"] == "person.enrolled")
    assert enrolled["payload"] == {"person_id": "matthew", "name": "Matthew", "samples": 8}
    assert len(store.people["matthew"].embeddings) == 8  # fresh samples only
    assert len(captures) == 8 and captures[-1]["n"] == 8 and captures[-1]["needed"] == 8
    assert all(c["kind"] == "face_capture" and len(c["jpeg_b64"]) > 100 for c in captures)
    assert not list(tmp_path.glob("*.jpg"))  # nothing written but people.json


def test_weak_intro_waits_for_wearer_confirmation(rng, tmp_path):
    _, eng, v = _setup(rng, tmp_path)
    frame = np.zeros((480, 640, 3), np.uint8)
    center = rng.standard_normal(128)
    for i in range(4):
        _frame_with(eng, center, rng, i)
        v.process(frame, ts=i * 0.2)
    intro = IntroEnroller(v, "Stephen", "stephen")
    assert intro.on_utterance(Utterance(1.0, "I'm Matthew", -30), now=1.0)["action"] == "pending"
    assert v._pending_labels == []
    assert intro.on_utterance(Utterance(2.0, "nice to meet you Matthew", -30), now=2.0)["action"] == "enroll"
    assert v._pending_labels[0][:3] == (1, "Matthew", True)


def test_intro_ignores_recognized_people(rng, tmp_path):
    store, eng, v = _setup(rng, tmp_path)
    frame = np.zeros((480, 640, 3), np.uint8)
    stephen = store.people["stephen"].embeddings[0]
    for i in range(4):
        b = (200, 120, 120, 140)
        eng.faces, eng.embs = [Face(b, 0.9, None)], [stephen]
        v.process(frame, ts=i * 0.2)
    intro = IntroEnroller(v, "Wearer", "wearer")
    assert intro.on_utterance(Utterance(1.0, "my name is Stephen", -40, speaker="other"))["action"] == "no_target"


# ---------------------------------------------------------------- vision message shape

def test_vision_message_shape(rng, tmp_path):
    store, eng, v = _setup(rng, tmp_path)
    frame = np.zeros((480, 640, 3), np.uint8)
    center = rng.standard_normal(128)
    for i in range(4):
        _frame_with(eng, center, rng, i)
        v.process(frame, ts=i * 0.2)
    m = vision_message(list(v.tracker.tracks.values()), store, 640, 480, ts=5.0)
    assert m["kind"] == "vision" and (m["w"], m["h"]) == (640, 480)
    t = m["tracks"][0]
    assert set(t) >= {"track_id", "bbox", "landmarks", "det_score", "state", "person_id", "name", "match_score",
                      "top_candidates", "embedding_sig"}
    assert all(0 <= x <= 1 for x in t["bbox"]) and len(t["landmarks"]) == 5
    assert t["det_score"] == 0.93 and t["name"] == "UNKNOWN PERSON 01"
    assert t["top_candidates"][0]["name"] == "Stephen" and len(t["top_candidates"]) == 1
    sig = t["embedding_sig"]
    assert len(sig) == 16 and all(0 <= x <= 1 for x in sig)


def test_embedding_sig_stable_and_distinct(rng):
    a, b = unit(rng.standard_normal(128)), unit(rng.standard_normal(128))
    assert embedding_sig(a) == embedding_sig(a.copy())
    assert embedding_sig(a) != embedding_sig(b)
    assert embedding_sig(None) is None


def test_visionfx_sends_only_to_opted_in_clients(rng, tmp_path):
    store, eng, v = _setup(rng, tmp_path)

    class Svc:
        pass

    svc = Svc()
    svc.vision, svc.store = v, store
    svc.conv = type("C", (), {"current": None})()
    fx = VisionFx(svc)
    sent = []

    class WS:
        async def send_text(self, s):
            sent.append(s)

    frame = np.zeros((480, 640, 3), np.uint8)
    center = rng.standard_normal(128)
    _frame_with(eng, center, rng, 0)
    res = v.process(frame, ts=0.0)
    asyncio.run(fx.after_frame(res))
    assert sent == []
    fx.clients.add(WS())
    _frame_with(eng, center, rng, 1)
    asyncio.run(fx.after_frame(v.process(frame, ts=0.2)))
    assert len(sent) == 1 and '"kind": "vision"' in sent[0]


# ---------------------------------------------------------------- relationship vector

def test_relationship_vector_from_stub():
    stub = StubGBrainSink(None)
    rv = RelationshipVectors()
    out = []

    async def bc(m):
        out.append(m)

    async def run():
        for ev in [
            {"type": "person.encountered", "people": [], "payload": {"person_id": "matthew", "label": "Matthew", "track_id": 3}},
            {"type": "relationship.updated", "people": [{"id": "matthew", "name": "Matthew"}], "payload": {
                "person_id": "matthew", "deltas": [{"kind": "fact", "text": "runs a studio"},
                                                   {"kind": "sentiment", "text": "excited about opal"},
                                                   {"kind": "open_loop_you_owe", "text": "send the preview"}]}},
        ]:
            await stub.emit(ev)
            await rv.on_event(ev, stub, bc)

    asyncio.run(run())
    assert [m["kind"] for m in out] == ["relationship_vector"] * 2
    last = out[-1]
    dims = {d["label"]: d["value"] for d in last["dims"]}
    assert last["person_id"] == "matthew" and last["name"] == "MATTHEW" and last["last_delta"] == "send the preview"
    assert dims["recency"] == 1.0 and dims["warmth"] > 0.5 and dims["open loops"] > 0 and dims["familiarity"] > 0
    assert all(0 <= d["value"] <= 1 for d in last["dims"]) and last["facts_count"] == 1
    assert dims["knowledge"] > out[0]["dims"][1]["value"]
