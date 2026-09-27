import pytest
from fastapi.testclient import TestClient

from perception.panels import MANIFEST, PanelStore
from test_service import make_app


def show(pid="context", **fields):
    return {"op": "show", "id": pid, "type": "person", "title": "Alex", **fields}


@pytest.mark.parametrize("fields", [
    {"title": ""}, {"title": "   "}, {"title": "\n\t"}, {"extra": True}, {"progress": True}, {"progress": 2}, {"ttl_ms": 999},
    {"type": "unsupported"}, {"title": "x" * 65}, {"items": [{"label": "a", "extra": 1}]},
    {"actions": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},
    {"anchor_track_id": False}, {"items": ["no"]}, {"actions": [{"id": "a"}]},
])
def test_tool_validation(tmp_path, fields):
    _, app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post("/tools/world-panel", json=show(**fields)).status_code == 422
        assert c.get("/panels").json() == {"panels": []}


def test_endpoints_replay_eviction_update_and_dismiss(tmp_path):
    _, app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.get("/tools").json() == {"tools": [MANIFEST["tool"]]}
        assert c.post("/tools/world-panel", json={"op": "show", "id": "no"}).status_code == 422
        assert c.post("/tools/world-panel", json={"op": "update", "id": "no"}).status_code == 422
        assert c.post("/hud", json={"kind": "panel", **show("a")}).status_code == 200
        with c.websocket_connect("/ws/hud") as hud, c.websocket_connect("/ws/quest") as quest:
            for socket in (hud, quest):
                replay = socket.receive_json()
                assert replay["id"] == "a" and replay["op"] == "show"
                assert 0 < replay["ttl_ms"] <= 60000
            for pid in ("b", "c", "d"):
                assert c.post("/tools/world-panel", json=show(pid)).status_code == 200
                for socket in (hud, quest):
                    if pid == "d":
                        assert socket.receive_json() == {"kind": "panel", "op": "dismiss", "id": "a"}
                    assert socket.receive_json()["id"] == pid
            assert c.post("/tools/world-panel", json={"op": "update", "id": "d", "title": "Updated"}).status_code == 200
            for socket in (hud, quest):
                msg = socket.receive_json()
                assert msg["op"] == "update" and msg["title"] == "Updated" and msg["type"] == "person"
            quest.send_json({"kind": "panel_dismiss", "panel_id": "d"})
            for socket in (hud, quest):
                assert socket.receive_json() == {"kind": "panel", "op": "dismiss", "id": "d"}
        assert [p["id"] for p in c.get("/panels").json()["panels"]] == ["b", "c"]


def test_action_validation_dedupe_and_cursor(tmp_path):
    _, app = make_app(tmp_path)
    with TestClient(app) as c, c.websocket_connect("/ws/quest") as quest:
        c.post("/tools/world-panel", json=show(actions=[{"id": "save", "label": "Save"}]))
        quest.receive_json()
        action = {"kind": "panel_action", "panel_id": "context", "action_id": "save", "request_id": "r1"}
        quest.send_json({**action, "action_id": "bad"})
        assert quest.receive_json()["status"] == "rejected"
        quest.send_json({**action, "request_id": []})
        assert quest.receive_json()["status"] == "rejected"
        quest.send_json([])  # malformed message must not kill connection
        for _ in range(2):
            quest.send_json(action)
            result = quest.receive_json()
            assert result["status"] == "received" and result["sequence"] == 1
        records = c.get("/panel-actions?after=0").json()
        assert len(records["actions"]) == 1 and records["cursor"] == 1
        assert c.get("/panel-actions?after=1").json()["actions"] == []
        assert c.get("/panel-actions?after=-1").status_code == 422
        c.post("/tools/world-panel", json={"op": "update", "id": "context", "actions": []})
        quest.receive_json()
        quest.send_json({**action, "request_id": "r2"})
        assert quest.receive_json()["status"] == "rejected"


async def test_ttl_and_same_id_replacement():
    messages = []
    async def broadcast(msg):
        messages.append(msg)
    now = [0]
    store = PanelStore(broadcast, clock=lambda: now[0])
    await store.command(show(body="old", ttl_ms=2000, actions=[{"id": "save", "label": "Save"}]))
    now[0] = 0.5
    assert (await store.snapshot())[0]["ttl_ms"] == 1500
    await store.command({"op": "update", "id": "context", "title": "New"})
    assert (await store.snapshot())[0]["ttl_ms"] == 1500
    now[0] = 2.1
    result = await store.select({"kind": "panel_action", "panel_id": "context", "action_id": "save", "request_id": "late"})
    assert result["status"] == "rejected"
    assert messages[-2] == {"kind": "panel", "op": "dismiss", "id": "context"}
    assert await store.snapshot() == []
    await store.command(show(body="old"))
    await store.command(show(title="Replacement"))
    snapshot = await store.snapshot()
    assert len(snapshot) == 1 and "body" not in snapshot[0]


async def test_action_log_is_bounded():
    async def broadcast(msg):
        pass
    store = PanelStore(broadcast)
    await store.command(show(actions=[{"id": "save", "label": "Save"}]))
    for i in range(105):
        await store.select({"kind": "panel_action", "panel_id": "context", "action_id": "save", "request_id": str(i)})
    log = store.read_actions(0)
    assert len(log["actions"]) == 100
    assert log["cursor"] == 105 and log["oldest_sequence"] == 6


def test_update_rejects_blank_title_without_mutating_panel(tmp_path):
    _, app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post("/tools/world-panel", json=show()).status_code == 200
        for title in ("", "  ", "\n\t"):
            assert c.post("/tools/world-panel", json={"op": "update", "id": "context", "title": title}).status_code == 422
        assert c.get("/panels").json()["panels"][0]["title"] == "Alex"
