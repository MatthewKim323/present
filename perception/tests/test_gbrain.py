"""GBrainIOSink + MCP client + live pass, all against fakes (no network)."""
import json
from types import SimpleNamespace

import httpx
import pytest

from perception.conversation import Encounter, Utterance
from perception.events import make_event
from perception.gbrain import (
    GBrainError, GBrainIOSink, MCPClient, NotFound, RelState, Situation, parse_timeline,
)
from perception.live import RollingExtractor
from perception.sinks import HudSink, StubGBrainSink

SIT = Situation("YC hackathon", "San Francisco", "2026-09-27")
MATT = {"id": "matthew", "name": "Matthew", "enrolled": True}
STEPHEN = {"id": "stephen", "name": "Stephen", "enrolled": True}


def parse_front(content: str) -> tuple[dict, str]:
    assert content.startswith("---\n")
    head, body = content[4:].split("\n---\n", 1)
    fm, key = {}, None
    for line in head.splitlines():
        if line.startswith("  - "):
            fm[key].append(json.loads(line[4:]))
        elif line.endswith(":"):
            key = line[:-1]
            fm[key] = []
        else:
            k, v = line.split(": ", 1)
            fm[k] = json.loads(v) if v[0] in '"0123456789' else v
    return fm, body


class FakeMCP:
    def __init__(self):
        self.pages: dict[str, str] = {}
        self.timeline: dict[str, list[dict]] = {}
        self.links: set[tuple[str, str, str]] = set()
        self.calls: list[tuple[str, dict]] = []
        self.fail = False
        self.now = "2026-09-27T21:00:00.000Z"

    async def call(self, name, args):
        self.calls.append((name, args))
        if self.fail:
            raise GBrainError("down")
        if name == "get_page":
            if args["slug"] not in self.pages:
                raise NotFound(args["slug"])
            fm, body = parse_front(self.pages[args["slug"]])
            tl = "\n".join(f"- **{e['date']}** | {e.get('source', '')} — {e['summary']}" for e in self.timeline.get(args["slug"], []))
            return {"slug": args["slug"], "frontmatter": fm, "compiled_truth": body, "timeline": tl}
        if name == "put_page":
            self.pages[args["slug"]] = args["content"]
            return {"status": "created_or_updated"}
        if name == "add_timeline_entry":
            self.timeline.setdefault(args["slug"], []).append({**args, "created_at": self.now})
            return {"status": "ok"}
        if name == "add_link":
            if args["to"] not in self.pages or args["from"] not in self.pages:
                raise NotFound(args["to"])
            self.links.add((args["from"], args["to"], args.get("link_type", "")))
            return {"status": "ok"}
        if name == "get_timeline":
            return list(reversed(self.timeline.get(args["slug"], [])))
        raise AssertionError(f"unexpected tool {name}")


def make_sink(mcp=None, **kw):
    mcp = mcp if mcp is not None else FakeMCP()
    sink = GBrainIOSink(mcp, StubGBrainSink(None), situation=SIT, wearer_id="stephen", wearer_name="Stephen", **kw)
    return sink, mcp


def enc_event(pid="matthew", label="Matthew"):
    return make_event("person.encountered", {"track_id": 1, "person_id": pid, "label": label, "bbox": [0, 0, 1, 1], "match_score": 0.7},
                      people=[{"id": pid, "name": label, "enrolled": True}])


async def test_encounter_creates_pages_links_timeline_and_debounces():
    sink, mcp = make_sink()
    await sink.emit(enc_event())
    await sink.flush()
    assert {"people/matthew", "relationships/stephen-matthew", "events/yc-hackathon-2026-09-27"} <= set(mcp.pages)
    assert mcp.timeline["people/matthew"][0]["summary"] == "Seen by Stephen at YC hackathon, San Francisco"
    assert mcp.timeline["people/matthew"][0]["source"] == "events/yc-hackathon-2026-09-27"
    assert ("people/matthew", "events/yc-hackathon-2026-09-27", "seen_at") in mcp.links
    await sink.emit(enc_event())  # within 10 min: no second timeline entry
    await sink.flush()
    assert len(mcp.timeline["people/matthew"]) == 1
    fm, _ = parse_front(mcp.pages["relationships/stephen-matthew"])
    assert fm["encounters"] == 1 and fm["last_seen_where"] == "YC hackathon, San Francisco"


async def test_existing_person_page_is_never_overwritten():
    sink, mcp = make_sink()
    mcp.pages["people/matthew"] = '---\ntype: "person"\ntitle: "Matthew"\nrole: "TODO(matt): role"\ncompany: "Kali Labs"\n---\n\n# Matthew\n'
    before = mcp.pages["people/matthew"]
    await sink.emit(enc_event())
    await sink.flush()
    assert mcp.pages["people/matthew"] == before
    ctx = await sink.person_context("matthew")
    assert ctx["subtitle"] == "Kali Labs"  # TODO placeholder filtered out


async def test_conversation_summary_goes_to_timelines_not_transcript():
    sink, mcp = make_sink()
    ev = make_event("conversation.completed", {"duration_s": 42, "summary": "Opal onboarding pain", "speakers": ["stephen", "matthew"], "utterances": 6},
                    people=[STEPHEN, MATT])
    await sink.emit(ev)
    await sink.flush()
    assert mcp.timeline["people/matthew"][0]["summary"] == "Talked with Stephen: Opal onboarding pain"
    assert mcp.timeline["relationships/stephen-matthew"][0]["summary"].endswith("Opal onboarding pain")
    assert "people/stephen" not in mcp.timeline  # wearer is not a counterpart
    ctx = await sink.person_context("matthew")
    assert ctx["last"] == "Opal onboarding pain"


async def test_signals_become_pages_with_links_and_open_loops():
    sink, mcp = make_sink()
    await sink.emit(make_event("commitment.detected", {"actor": "Stephen", "recipient": "Matthew", "commitment": "Send updated onboarding demo"},
                               people=[STEPHEN, MATT], project="opal"))
    await sink.emit(make_event("commitment.detected", {"actor": "Matthew", "recipient": "Stephen", "commitment": "Intro to his CTO"},
                               people=[STEPHEN, MATT], project="opal"))
    await sink.emit(make_event("customer_feedback.detected", {"product": "Opal", "feature": "Onboarding", "sentiment": "neg", "feedback": "confusing"},
                               people=[STEPHEN, MATT], project="opal"))
    await sink.emit(make_event("feature_request.detected", {"product": "Opal", "feature": "Add onboarding checklist", "request": "show progress", "requested_by": "Matthew"},
                               people=[STEPHEN, MATT], project="opal"))
    await sink.flush()
    slugs = set(mcp.pages)
    commit = next(s for s in slugs if s.startswith("commitments/") and "send-updated-onboarding-demo" in s)
    assert any(s.startswith("feedback/") and "opal-onboarding-feedback" in s for s in slugs)
    assert any(s.startswith("feature-requests/") and "add-onboarding-checklist" in s for s in slugs)
    assert "projects/opal" in slugs
    assert (commit, "people/matthew", "involves") in mcp.links
    assert (commit, "projects/opal", "about") in mcp.links
    assert (commit, "events/yc-hackathon-2026-09-27", "happened_at") in mcp.links
    fm, _ = parse_front(mcp.pages[commit])
    assert fm["actor"] == "Stephen" and fm["status"] == "open"
    ctx = await sink.person_context("matthew")
    assert ctx["you_owe"] == "Send updated onboarding demo"
    assert ctx["owes_you"] == "Intro to his CTO"
    assert ctx["here"] == "YC hackathon, San Francisco"
    rel = mcp.pages["relationships/stephen-matthew"]
    assert "- you owe: Send updated onboarding demo" in rel and "- owes you: Intro to his CTO" in rel


async def test_relationship_deltas_persist_and_hit_hud():
    sink, mcp = make_sink()
    ev = make_event("relationship.updated", {"person_id": "matthew", "summary": "early Opal user, wants easier setup",
                                             "deltas": [{"kind": "preference", "text": "prefers async demos"}, {"kind": "topic", "text": "onboarding setup"}]},
                    people=[STEPHEN, MATT])
    sent = []

    async def bc(m):
        sent.append(m)

    hud = HudSink(bc, gbrain=sink)
    await sink.emit(ev)
    await hud.emit(ev)
    await sink.flush()
    assert [m["text"] for m in sent] == ["+ prefers async demos", "+ onboarding setup"]
    assert all(m["kind"] == "context_delta" and m["person_id"] == "matthew" for m in sent)
    rel = mcp.pages["relationships/stephen-matthew"]
    assert "- prefers async demos" in rel and "early Opal user" in rel
    assert mcp.timeline["relationships/stephen-matthew"][0]["summary"].startswith("Learned: prefers async demos")
    ctx = await sink.person_context("matthew")
    assert ctx["recent_deltas"] == ["onboarding setup", "prefers async demos"]
    assert ctx["relationship"] == "early Opal user, wants easier setup"
    assert ctx["last"] == "onboarding setup"
    card = await hud.person_card(enc_event())
    assert card["recent_deltas"] and card["here"] and "you_owe" in card


async def test_second_encounter_card_is_richer_from_hydrated_page():
    # a previous run left a relationship page behind; a fresh process should pick it up
    mcp = FakeMCP()
    old = RelState("matthew", "Matthew", summary="met at demo day", facts=["runs a 4 person team"], you_owe=["send demo"],
                   last_seen="2026-09-20 10:00", last_seen_where="Demo day, SF", encounters=1)
    mcp.pages["relationships/stephen-matthew"] = old.page("Stephen", SIT)
    sink, _ = make_sink(mcp)
    await sink.emit(enc_event())
    ctx = await sink.person_context("matthew")
    await sink.flush()
    assert ctx["seen_before"]["when"] == "2026-09-20 10:00" and ctx["seen_before"]["where"] == "Demo day, SF"
    assert ctx["seen_before"]["ago"].endswith("d ago")
    assert ctx["you_owe"] == "send demo" and ctx["relationship"] == "met at demo day"
    fm, body = parse_front(mcp.pages["relationships/stephen-matthew"])
    assert fm["encounters"] == 2 and "- runs a 4 person team" in body


async def test_gbrain_down_falls_back_to_stub():
    mcp = FakeMCP()
    mcp.fail = True
    sink, _ = make_sink(mcp)
    await sink.emit(make_event("commitment.detected", {"actor": "Stephen", "recipient": "Matthew", "commitment": "Send demo"}, people=[STEPHEN, MATT]))
    await sink.emit(enc_event())
    await sink.flush()
    assert not sink.up and sink.writes_failed >= 1
    ctx = await sink.person_context("matthew")
    assert ctx["you_owe"] == "Send demo"  # live state + stub keep the card alive
    assert ctx["here"] == "YC hackathon, San Francisco"


async def test_no_mcp_at_all_is_pure_stub():
    sink = GBrainIOSink(None, StubGBrainSink(None), situation=SIT)
    await sink.emit(make_event("conversation.completed", {"summary": "hi", "utterances": 1}, people=[STEPHEN, MATT]))
    assert (await sink.person_context("matthew"))["last"] == "hi"


def test_situation_from_env(monkeypatch, tmp_path):
    monkeypatch.delenv("WORLD_SITUATION", raising=False)
    assert Situation.from_env().slug == "events/yc-hackathon-2026-09-27"
    monkeypatch.setenv("WORLD_SITUATION", '{"name": "Demo Day", "place": "SF", "date": "2026-10-01"}')
    assert Situation.from_env().slug == "events/demo-day-2026-10-01"
    f = tmp_path / "s.json"
    f.write_text('{"name": "Coffee", "place": "Palo Alto", "date": "2026-10-02"}')
    monkeypatch.setenv("WORLD_SITUATION", str(f))
    assert Situation.from_env().label == "Coffee, Palo Alto"


def test_parse_timeline():
    tl = parse_timeline("## Timeline\n\n- **2026-09-27** | events/x — seen by Stephen\n  detail\n- **2026-09-20** — met")
    assert tl == [{"date": "2026-09-27", "source": "events/x", "summary": "seen by Stephen"},
                  {"date": "2026-09-20", "source": "", "summary": "met"}]


# ---------------- MCP client over a mock HTTP transport ----------------

class Tok:
    def __init__(self):
        self.invalidated = 0

    async def get(self):
        return "tkn"

    def invalidate(self):
        self.invalidated += 1


async def test_mcp_client_handles_sse_session_and_errors():
    seen = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append((body.get("method"), req.headers.get("mcp-session-id"), req.headers.get("authorization")))
        if body["method"] == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": "2025-06-18"}},
                                  headers={"mcp-session-id": "sess1"})
        if body["method"] == "notifications/initialized":
            return httpx.Response(202)
        name = body["params"]["name"]
        if name == "get_page":
            res = {"content": [{"type": "text", "text": '{"error":"page_not_found"}'}], "isError": True}
        else:
            res = {"content": [{"type": "text", "text": '{"status":"ok"}'}]}
        sse = f"event: message\ndata: {json.dumps({'jsonrpc': '2.0', 'id': body['id'], 'result': res})}\n\n"
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    c = MCPClient("https://x/mcp", Tok(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await c.call("add_timeline_entry", {"slug": "a", "date": "2026-09-27", "summary": "s"}) == {"status": "ok"}
    with pytest.raises(NotFound):
        await c.call("get_page", {"slug": "nope"})
    with pytest.raises(GBrainError):
        await c.call("gmail_search", {})  # not a memory tool: refused locally
    assert seen[0] == ("initialize", None, "Bearer tkn")
    assert seen[2][1] == "sess1"
    assert all(m != "tools/call" or True for m, *_ in seen)
    assert sum(1 for m, *_ in seen if m == "tools/call") == 2


async def test_mcp_client_retries_once_on_401():
    tok = Tok()
    n = {"calls": 0}

    def handler(req):
        body = json.loads(req.content)
        if body.get("method") == "tools/call":
            n["calls"] += 1
            if n["calls"] == 1:
                return httpx.Response(401, json={"error": "invalid_token"})
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"content": [{"type": "text", "text": "plain"}]}})
        if body.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}})
        return httpx.Response(202)

    c = MCPClient("https://x/mcp", tok, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await c.call("whoami", {}) == "plain"
    assert tok.invalidated == 1


# ---------------- live rolling pass ----------------

class FakeClaude:
    def __init__(self, out):
        self.out = out
        self.reqs = []
        self.messages = self

    async def create(self, **req):
        self.reqs.append(req)
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(self.out))])


async def test_live_pass_emits_relationship_deltas_and_dedupes():
    out = []

    async def emit(ev):
        out.append(ev)

    claude = FakeClaude({"deltas": [{"kind": "preference", "text": "prefers async demos."}, {"kind": "fact", "text": "runs a 4 person team"}],
                         "summary": "early user"})
    live = RollingExtractor(emit, wearer_id="stephen", wearer_name="Stephen", every_s=20, every_n=4,
                            known=lambda pid: ["runs a 4 person team"], client=claude)
    enc = Encounter("e1", "matthew", "Matthew", 1, 100.0, 100.0)
    enc.utterances = [Utterance(101.0 + i, f"line {i}") for i in range(3)]
    assert await live.tick(enc, 105.0) is None  # 3 new lines, 5s: not due yet
    enc.utterances.append(Utterance(106.0, "we like async demos"))
    ev = await live.tick(enc, 106.0)
    assert ev["type"] == "relationship.updated" and ev["payload"]["person_id"] == "matthew"
    assert ev["payload"]["deltas"] == [{"kind": "preference", "text": "prefers async demos"}]  # known fact dropped
    assert "transcript" not in json.dumps(ev["payload"]) and "line 0" not in json.dumps(ev)
    assert claude.reqs[0]["model"]
    assert await live.tick(enc, 107.0) is None  # nothing new
    enc.utterances.append(Utterance(130.0, "more"))
    assert live.due(enc, 130.0)  # time-based trigger after 20s


async def test_live_skips_unknown_people():
    live = RollingExtractor(lambda ev: None, client=FakeClaude({"deltas": [], "summary": ""}))
    enc = Encounter("e2", None, "UNKNOWN PERSON 01", 1, 0.0, 0.0)
    enc.utterances = [Utterance(float(i), "x") for i in range(10)]
    assert not live.due(enc, 100.0)


async def test_seen_before_uses_timeline_timestamps_and_skips_current_encounter():
    import time as _t
    from datetime import datetime, timezone

    mcp = FakeMCP()
    sink, _ = make_sink(mcp)
    two_h = datetime.fromtimestamp(_t.time() - 7200, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    mcp.pages["people/matthew"] = '---\ntype: "person"\ntitle: "Matthew"\n---\n\n# Matthew\n'
    mcp.timeline["people/matthew"] = [{"slug": "people/matthew", "date": "2026-09-27", "summary": "Seen by Stephen at Coffee, Palo Alto", "created_at": two_h}]
    mcp.now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    await sink.emit(enc_event())
    await sink.flush()
    sink._person.clear()  # force re-read so the current encounter's own entry is in the timeline
    ctx = await sink.person_context("matthew")
    assert ctx["seen_before"]["ago"] == "2h ago" and ctx["seen_before"]["where"] == "Coffee, Palo Alto"
    # after a --reset, rows from earlier takes no longer count
    sink.rel["matthew"].reset_at = mcp.now
    assert (await sink.person_context("matthew"))["seen_before"] is None


def test_seed_files_load_and_reset_stamp():
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("seed_gbrain", Path(__file__).parents[1] / "scripts" / "seed_gbrain.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    seeds = mod.load_seeds()
    assert {"people/matthew", "people/stephen", "relationships/stephen-matthew", "projects/opal", "events/yc-hackathon-2026-09-27"} <= set(seeds)
    stamped = mod.stamp_reset(seeds["relationships/stephen-matthew"], "2026-09-27T20:00:00Z")
    fm, body = parse_front(stamped)
    assert fm["reset_at"] == "2026-09-27T20:00:00Z" and "## Open loops" in body
    st = RelState.from_page("matthew", "Matthew", {"frontmatter": fm, "compiled_truth": body})
    assert st.summary is None and st.facts == [] and st.reset_at  # TODO placeholders never reach the card
