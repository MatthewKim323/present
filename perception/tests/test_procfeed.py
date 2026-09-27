import asyncio
import json

from fastapi.testclient import TestClient

from perception import builder as builder_mod
from perception import procfeed
from perception.builder import Builder, BuilderConfig, RunResult
from perception.procfeed import ProcFeed, procedure_msg, slim_steps, step_target
from test_builder import SPEC, TRACE, FakeGitHub

DRAFT = {
    "title": "add discord command",
    "task": "ship customer feature request: Add !recap command",
    "steps": [
        {"seq": 1, "action": "Read", "activity_class": "read", "command": "discord-bot/core/bot.py"},
        {"seq": 2, "action": "Edit", "activity_class": "write", "command": "discord-bot/core/bot.py"},
        {"seq": 3, "action": "Bash", "activity_class": "execute", "command": "python3 -m compileall -q core utils"},
        {"seq": 4, "action": "Bash", "activity_class": "execute",
         "command": "gh pr create --base main --title \"[WORLD] Add !recap\" --body \"$(cat <<'EOF'\nline two\nEOF\n)\""},
    ],
    "trigger_signature": {"summary_text": "Add !recap command"},
}


class TapRunner:
    """Fires builder.TOOL_TAPS like the real StreamParser does, then returns TRACE."""

    name = "local"

    async def run(self, job, prompt, progress):
        for call in TRACE:
            for tap in list(builder_mod.TOOL_TAPS):
                tap(job.id, call["name"], call["input"])
            await asyncio.sleep(0.03)
        return RunResult(True, list(TRACE), {"tool_calls": len(TRACE), "num_turns": 5})


class Mem:
    def __init__(self, result=None, recalled=None, configured=True):
        self.result = result or {"stored": True, "title": DRAFT["title"], "steps": 4, "doc": DRAFT}
        self.recalled, self.configured = recalled, configured

    def recall(self, spec):
        return self.recalled

    async def record(self, job, trace):
        return dict(self.result)


def make(tmp_path, mem, monkeypatch):
    monkeypatch.setattr(procfeed, "RECORD_THROTTLE_S", 0.01)
    sent = []

    async def bc(m):
        sent.append(m)

    feed = ProcFeed(bc, tmp_path / "procedures")
    calls = []

    async def on_procedure(kind, doc, origin):
        calls.append((kind, doc.get("title"), origin.get("harness")))
        return "procedures/add-discord-command"

    cfg = BuilderConfig(poll_s=0.01, timeout_s=5, no_pr_grace_s=0.05, workdir=tmp_path / "w", procedures_dir=tmp_path / "procedures")
    b = Builder(cfg, bc, runner=TapRunner(), github=FakeGitHub(), procedures=mem, on_procedure=on_procedure, procfeed=feed)
    return b, feed, sent, calls


def procs(sent):
    return [m for m in sent if m["kind"] == "procedure"]


async def test_builder_run_records_extracts_learns(tmp_path, monkeypatch):
    b, feed, sent, calls = make(tmp_path, Mem(), monkeypatch)
    try:
        job = await b.dispatch("evt_1", SPEC)
        await asyncio.wait_for(b.tasks[job.id], 5)
    finally:
        feed.close()
    p = procs(sent)
    phases = [m["phase"] for m in p]
    assert phases[0] == "recording" and p[0]["tool_calls_seen"] == 0 and p[0]["source"] == "claude-code"
    assert p[0]["job_id"] == job.id and p[0]["event_id"] == "evt_1" and p[0]["trigger"].startswith("ship customer feature request")
    rec = [m for m in p if m["phase"] == "recording"]
    assert rec[-1]["tool_calls_seen"] == 3  # the counter ticked up with each tapped tool call
    assert phases[-2:] == ["extracting", "learned"]
    learned = p[-1]
    assert learned["title"] == "add discord command" and learned["gbrain_slug"] == "procedures/add-discord-command"
    assert learned["admitted"] is True and learned["tool_calls_seen"] == 3
    assert [s["action"] for s in learned["steps"]] == ["Read", "Edit", "Bash", "Bash"]
    assert learned["steps"][3]["target"].startswith("gh pr create") and "\n" not in learned["steps"][3]["target"]
    assert learned["trigger"] == DRAFT["task"]
    assert learned["metrics"] == {"tool_calls": 3, "turns": 5, "seconds_to_pr": learned["metrics"]["seconds_to_pr"]}
    assert calls == [("learned", "add discord command", "claude-code")]
    lib = [m for m in sent if m["kind"] == "procedure_library"][-1]
    assert lib["items"][0]["title"] == "add discord command" and lib["items"][0]["gbrain_slug"] == "procedures/add-discord-command"


async def test_recall_comes_before_recording_and_counts_uses(tmp_path, monkeypatch):
    (tmp_path / "procedures").mkdir()
    (tmp_path / "procedures" / "add-discord-command-b1.json").write_text(json.dumps(DRAFT))
    b, feed, sent, _ = make(tmp_path, Mem(recalled={**DRAFT, "score": 0.8}), monkeypatch)
    try:
        job = await b.dispatch("evt_2", {**SPEC, "feature": "Add !streak command"})
        await asyncio.wait_for(b.tasks[job.id], 5)
    finally:
        feed.close()
    p = procs(sent)
    assert [m["phase"] for m in p][:2] == ["recalled", "recording"]
    assert p[0]["title"] == "add discord command" and len(p[0]["steps"]) == 4 and p[0]["gbrain_slug"]
    libs = [m for m in sent if m["kind"] == "procedure_library"]
    assert libs[0]["items"][0]["uses"] == 1 and libs[0]["items"][0]["steps_count"] == 4


async def test_refused_is_reported_honestly(tmp_path, monkeypatch):
    b, feed, sent, calls = make(tmp_path, Mem(result={"stored": False, "reason": "no_postcondition"}), monkeypatch)
    try:
        job = await b.dispatch(None, SPEC)
        await asyncio.wait_for(b.tasks[job.id], 5)
    finally:
        feed.close()
    last = procs(sent)[-1]
    assert last["phase"] == "refused" and last["reason"] == "no_postcondition" and last["admitted"] is False
    assert last["title"] == SPEC["feature"] and calls == []


async def test_unconfigured_memorable_shows_no_extraction(tmp_path, monkeypatch):
    mem = Mem(result={"stored": False, "reason": "memorable not configured"}, configured=False)
    b, feed, sent, _ = make(tmp_path, mem, monkeypatch)
    try:
        job = await b.dispatch(None, SPEC)
        await asyncio.wait_for(b.tasks[job.id], 5)
    finally:
        feed.close()
    assert {m["phase"] for m in procs(sent)} == {"recording"}


def test_step_targets_are_short_and_redacted():
    assert step_target({"command": "cat .env && echo sk-abcdefghijklmnop"}) == "cat .env && echo <redacted>"
    long_path = "app/src/" + "x" * 80 + "/LandingPage.tsx"
    assert step_target({"command": long_path}).startswith("…") and step_target({"command": long_path}).endswith("LandingPage.tsx")
    assert step_target({"targets": ["a.py", "b.py"]}) == "a.py, b.py"
    assert step_target({}) is None
    many = slim_steps([{"action": "Read", "activity_class": "read"}] * 20)
    assert len(many) == 12 and many[0]["seq"] == 1 and "target" not in many[0]
    m = procedure_msg("learned", "qm-swarm", doc={"title": "t", "steps": [{}] * 14})
    assert m["steps_total"] == 14 and len(m["steps"]) == 12 and "trigger" not in m


def test_service_routes_qm_procedures(tmp_path):
    from test_service import make_app

    svc, app = make_app(tmp_path)
    (tmp_path / "procedures").mkdir()
    (tmp_path / "procedures" / "add-discord-command-b1.json").write_text(json.dumps(DRAFT))
    qm_draft = {"title": "triage customer feedback", "steps": [{"seq": 1, "action": "gbrain_search", "activity_class": "search"}]}
    with TestClient(app) as c, c.websocket_connect("/ws/hud") as hud:
        first = hud.receive_json()
        assert first["kind"] == "procedure_library" and [i["title"] for i in first["items"]] == ["add discord command"]
        r = c.post("/procedures", json={"kind": "learned", "draft": qm_draft, "origin": {"harness": "qm-swarm", "event_id": "evt_9",
                                                                              "metrics": {"tool_calls": 14, "turns": 9, "seconds": 63, "x": "no"}}})
        assert r.status_code == 200
        msg = hud.receive_json()
        assert msg["kind"] == "procedure" and msg["phase"] == "learned" and msg["source"] == "qm-swarm"
        assert msg["event_id"] == "evt_9" and msg["steps"][0]["activity_class"] == "search" and msg["admitted"] is True
        assert msg["metrics"] == {"tool_calls": 14, "turns": 9, "seconds": 63}
        lib = hud.receive_json()
        assert lib["kind"] == "procedure_library" and lib["items"][0]["title"] == "triage customer feedback"
        c.post("/procedures", json={"kind": "recalled", "draft": {"title": "add discord command"}, "origin": {"harness": "qm"}})
        assert hud.receive_json()["phase"] == "recalled"
        lib = hud.receive_json()
        assert {i["title"]: i["uses"] for i in lib["items"]} == {"triage customer feedback": 0, "add discord command": 1}
        got = c.get("/procedures").json()
        assert got["count"] == 2 and {i["source"] for i in got["items"]} == {"qm-swarm", "claude-code"}
        assert c.post("/procedures", json={"kind": "learned", "draft": {}}).status_code == 422
    svc.procfeed.close()
