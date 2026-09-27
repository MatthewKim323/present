"""gbrain_op instrumentation, rate limit, and the read-only /gbrain proxy for QM workers (fakes, no network)."""
import json

import pytest
from fastapi.testclient import TestClient

from perception.events import make_event
from perception.gbrain import GBrainIOSink
from perception.gbrain_ops import GBrainOpFeed, normalize_hits, op_message
from perception.sinks import StubGBrainSink
from test_gbrain import MATT, SIT, STEPHEN, FakeMCP, enc_event
from test_service import make_app

SECRET = "world-test-secret-0123456789"
BODY = "SECRET BODY TEXT that must never reach the HUD " * 20


class QueryMCP(FakeMCP):
    async def call(self, name, args):
        if name == "query":
            self.calls.append((name, args))
            return {"results": [
                {"slug": "feedback/2026-09-27-opal-onboarding-feedback", "title": "Opal onboarding feedback", "chunk_text": BODY, "score": 0.9},
                {"slug": "feedback/2026-09-27-opal-onboarding-feedback", "title": "dupe chunk", "chunk_text": "x"},
                {"slug": "procedures/add-discord-command", "title": "add discord command", "chunk_text": "steps"},
            ]}
        return await super().call(name, args)


class Rec:
    def __init__(self):
        self.msgs = []

    async def __call__(self, m):
        self.msgs.append(m)


def feed_sink(mcp=None):
    mcp = mcp or QueryMCP()
    rec = Rec()
    sink = GBrainIOSink(mcp, StubGBrainSink(None), situation=SIT, wearer_id="stephen", wearer_name="Stephen")
    sink.ops = GBrainOpFeed(rec, rate=1000, burst=1000, max_backlog=1000)
    return sink, mcp, rec


async def all_ops(sink, rec):
    await sink.ops.drain()
    return rec.msgs


# ---------------- shape ----------------

async def test_ops_carry_actor_and_never_bodies():
    sink, mcp, rec = feed_sink()
    mcp.pages["people/matthew"] = '---\ntype: "person"\ntitle: "Matthew"\n---\n\n# Matthew\n' + BODY
    await sink.emit(enc_event())  # perception: encounter write job
    await sink.emit(make_event("relationship.updated", {"person_id": "matthew", "summary": "s",
                                                        "deltas": [{"kind": "preference", "text": "prefers async demos"}]},
                               people=[STEPHEN, MATT]))  # live pass
    await sink.flush()
    await sink.person_context("matthew")  # card
    hits = await sink.read_query("matthew opal feedback", actor="qm:Context", event_id="evt_1")
    ops = await all_ops(sink, rec)
    assert {m["kind"] for m in ops} == {"gbrain_op"}
    assert BODY[:20] not in json.dumps(ops)
    actors = {m["actor"] for m in ops}
    assert {"perception", "live", "qm:Context"} <= actors
    live = [m for m in ops if m["actor"] == "live"]
    assert any(m["op"] == "put_page" and m["slug"] == "relationships/stephen-matthew" and m["person_id"] == "matthew" for m in live)
    q = next(m for m in ops if m["op"] == "query")
    assert q == {"kind": "gbrain_op", "op": "query", "actor": "qm:Context", "ms": q["ms"], "ok": True, "query": "matthew opal feedback",
                 "hits": [{"slug": "feedback/2026-09-27-opal-onboarding-feedback", "title": "Opal onboarding feedback"},
                          {"slug": "procedures/add-discord-command", "title": "add discord command"}],
                 "event_id": "evt_1"}
    assert [h["slug"] for h in hits] == ["feedback/2026-09-27-opal-onboarding-feedback", "procedures/add-discord-command"]
    assert all(len(h["snippet"]) <= 200 for h in hits)
    assert all(set(m) <= {"kind", "op", "actor", "slug", "query", "hits", "ms", "ok", "person_id", "event_id", "title", "to", "miss", "count"} for m in ops)
    assert all(len(m.get("slug") or "") <= 80 and len(m.get("query") or "") <= 80 for m in ops)


def test_op_message_truncates_and_maps_people():
    m = op_message("search", {"query": "x" * 200}, [{"slug": f"s/{i}", "title": "t" * 300} for i in range(9)], 12.4, True, actor="card")
    assert len(m["query"]) == 80 and len(m["hits"]) == 5 and all(len(h["title"]) <= 80 for h in m["hits"])
    assert op_message("add_link", {"from": "procedures/p", "to": "people/matthew"}, None, 1, True, actor="memorable")["person_id"] == "matthew"
    miss = op_message("get_page", {"slug": "relationships/stephen-alex"}, None, 3, True, actor="perception", miss=True)
    assert miss["miss"] and miss["person_id"] == "alex"
    assert normalize_hits([{"page": {"slug": "a", "title": "A"}, "text": "t"}]) == [{"slug": "a", "title": "A", "snippet": "t"}]


# ---------------- rate limit / coalesce ----------------

async def test_feed_rate_limits_coalesces_and_keeps_qm_reads():
    now = [0.0]
    rec = Rec()
    feed = GBrainOpFeed(rec, rate=5, burst=5, max_backlog=8, clock=lambda: now[0])
    for i in range(3):  # identical ops fold into one line with a count
        feed.publish({"kind": "gbrain_op", "op": "add_link", "actor": "perception", "slug": "a", "to": "b", "ms": i, "ok": True})
    assert len(feed.pending) == 1 and feed.pending[0]["count"] == 3
    feed.publish({"kind": "gbrain_op", "op": "get_page", "actor": "qm:Context", "slug": "people/matthew", "ms": 5, "ok": True})
    for i in range(20):
        feed.publish({"kind": "gbrain_op", "op": "put_page", "actor": "perception", "slug": f"p/{i}", "ms": 1, "ok": True})
    assert len(feed.pending) == 8 and feed.dropped == 14
    assert any(p["actor"] == "qm:Context" for p in feed.pending)  # perception chatter is shed first
    assert await feed.drain() == 5  # burst
    assert await feed.drain() == 0  # no time passed: no tokens
    now[0] += 0.4
    assert await feed.drain() == 2  # 5/s
    now[0] += 10
    assert await feed.drain() == 1 and not feed.pending
    assert feed.sent == 8 and len(rec.msgs) == 8


# ---------------- /gbrain proxy ----------------

@pytest.fixture
def proxy(tmp_path, monkeypatch):
    monkeypatch.setenv("WORLD_HOOKS_SECRET", SECRET)
    svc, app = make_app(tmp_path)
    mcp = QueryMCP()
    mcp.pages["people/matthew"] = '---\ntype: "person"\ntitle: "Matthew"\nrole: "builder"\ncompany: "Kali Labs"\n---\n\n# Matthew\n\nlong ' + BODY * 10
    sink = GBrainIOSink(mcp, svc.gbrain, situation=SIT, wearer_id="stephen", wearer_name="Stephen")
    rec = Rec()
    sink.ops = GBrainOpFeed(rec, rate=1000, burst=1000)
    svc.gbrain = sink
    with TestClient(app) as c:
        yield c, sink, mcp, rec


AUTH = {"authorization": f"Bearer {SECRET}"}


def test_proxy_rejects_missing_or_wrong_bearer(proxy):
    c, _, mcp, _ = proxy
    assert c.post("/gbrain/query", json={"q": "x"}).status_code == 401
    assert c.post("/gbrain/query", json={"q": "x"}, headers={"authorization": "Bearer nope-nope-nope-nope"}).status_code == 401
    assert c.get("/gbrain/page/people/matthew").status_code == 401
    assert c.get("/gbrain/person/matthew", headers={"authorization": SECRET[:-1]}).status_code == 401
    assert mcp.calls == []  # nothing reached GBrain


def test_proxy_needs_a_configured_secret(proxy, monkeypatch):
    c, *_ = proxy
    monkeypatch.setenv("WORLD_HOOKS_SECRET", "short")
    assert c.post("/gbrain/query", json={"q": "x"}, headers={"authorization": "Bearer short"}).status_code == 503


def test_proxy_reads_and_emits_ops(proxy):
    c, sink, mcp, rec = proxy
    r = c.post("/gbrain/query", json={"q": "matthew opal feedback", "actor": "Context", "event_id": "evt_9"}, headers=AUTH)
    assert r.status_code == 200 and r.json()["results"][0]["slug"].startswith("feedback/")
    r = c.get("/gbrain/page/people/matthew", params={"actor": "qm:Product"}, headers=AUTH)
    page = r.json()
    assert r.status_code == 200 and page["frontmatter"]["company"] == "Kali Labs" and len(page["compiled_truth"]) < 4100
    assert c.get("/gbrain/page/people/nobody", headers=AUTH).status_code == 404
    r = c.get("/gbrain/person/matthew", params={"actor": "qm:Context", "event_id": "evt_9"}, headers=AUTH)
    card = r.json()
    assert card["subtitle"] == "builder · Kali Labs" and card["relationship_page"] == "relationships/stephen-matthew"
    assert c.get("/gbrain/person/..%2Fetc", headers=AUTH).status_code in (404, 422)
    assert c.post("/gbrain/query", json={"q": "x", "actor": "qm:Context; rm -rf"}, headers=AUTH).status_code == 422
    assert all(name in ("query", "get_page", "get_timeline", "put_page", "add_link", "add_timeline_entry") for name, _ in mcp.calls)
    assert not any(name == "put_page" for name, _ in mcp.calls[:1])
    ops = rec.msgs + sink.ops.pending
    qm = [m for m in ops if m["actor"].startswith("qm:")]
    assert {"qm:Context", "qm:Product"} == {m["actor"] for m in qm}
    assert any(m["op"] == "query" and m["event_id"] == "evt_9" for m in qm)
    assert any(m["op"] == "get_page" and m["slug"] == "people/matthew" and m["actor"] == "qm:Context" and m["person_id"] == "matthew" for m in qm)
    assert BODY[:20] not in json.dumps(ops)


def test_proxy_on_stub_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("WORLD_HOOKS_SECRET", SECRET)
    svc, app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post("/gbrain/query", json={"q": "x"}, headers=AUTH).status_code == 503
        r = c.get("/gbrain/person/matthew", headers=AUTH)
        assert r.status_code == 200 and r.json()["backend"] == "stub"


def test_read_only_proxy_token_is_accepted(monkeypatch):
    import pytest
    from fastapi import HTTPException
    from perception.gbrain_ops import check_bearer
    monkeypatch.setenv("WORLD_HOOKS_SECRET", "w" * 32)
    monkeypatch.setenv("GBRAIN_PROXY_TOKEN", "g" * 32)
    check_bearer("Bearer " + "g" * 32)
    check_bearer("Bearer " + "w" * 32)
    with pytest.raises(HTTPException):
        check_bearer("Bearer " + "x" * 32)
