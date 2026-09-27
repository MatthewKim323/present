import asyncio
import json

import httpx
from fastapi.testclient import TestClient

from perception.builder import (Builder, BuilderConfig, BuilderSink, ProcedureMemory, RunResult, StreamParser,
                                add_builder_routes, build_prompt, normalize_spec)

SPEC = {"product": "Syla", "feature": "Add onboarding progress checklist",
        "request": "Show a progress checklist at the top of onboarding", "requested_by": "Matthew",
        "acceptance": ["Checklist with 4 steps", "Progress bar shows N of 4"]}
TRACE = [
    {"name": "Read", "input": {"file_path": "CLAUDE.md"}, "result": {"ok": True}},
    {"name": "Edit", "input": {"file_path": "src/onboarding/Onboarding.tsx"}, "result": {"ok": True}},
    {"name": "Bash", "input": {"command": "npm run build"}, "result": {"exit_code": 0}},
]


class FakeRunner:
    name = "local"

    def __init__(self, ok=True, delay=0.0, trace=TRACE, notes=("editing Onboarding.tsx",)):
        self.ok, self.delay, self.trace, self.notes = ok, delay, trace, notes
        self.prompts = []

    async def run(self, job, prompt, progress):
        self.prompts.append(prompt)
        for n in self.notes:
            await progress(n)
        await asyncio.sleep(self.delay)
        if not self.ok:
            return RunResult(False, error="claude exited 1")
        return RunResult(True, list(self.trace), {"tool_calls": len(self.trace), "num_turns": 7})


class FakeGitHub:
    """PR appears after `pr_after` polls; preview goes pending -> success after `ready_after` more polls."""

    def __init__(self, pr_after=1, ready_after=2, preview_state="success", pr=True):
        self.pr_after, self.ready_after, self.preview_state, self.pr = pr_after, ready_after, preview_state, pr
        self.find_calls = 0
        self.preview_calls = 0

    async def find_pr(self, job, claimed):
        self.find_calls += 1
        if self.pr and self.find_calls > self.pr_after:
            return {"number": 7, "url": "https://github.com/o/r/pull/7", "headRefOid": "abc123", "headRefName": job.branch}
        return None

    async def preview(self, repo, sha):
        self.preview_calls += 1
        if self.preview_calls > self.ready_after:
            return self.preview_state, "https://syla-demo-git-x.vercel.app"
        return "pending", None


class FakeMemory:
    def __init__(self, recalled=None):
        self.recalled = recalled
        self.recorded = []

    def recall(self, spec):
        return self.recalled

    async def record(self, job, trace):
        self.recorded.append(trace)
        return {"stored": True, "title": "t", "steps": len(trace), "doc": {"title": "t", "steps": trace}}


def make(tmp_path, **kw):
    cfg = BuilderConfig(poll_s=0.01, timeout_s=kw.pop("timeout_s", 5), no_pr_grace_s=kw.pop("grace", 0.05),
                        workdir=tmp_path / "w", procedures_dir=tmp_path / "p")
    sent = []

    async def bc(m):
        sent.append(m)

    b = Builder(cfg, bc, runner=kw.pop("runner", FakeRunner()), github=kw.pop("github", FakeGitHub()),
                procedures=kw.pop("procedures", FakeMemory()), anchor=lambda pid: 3 if pid == "matthew" else None,
                on_procedure=kw.pop("on_procedure", None))
    return b, sent


def notes(sent):
    return [(m["workers"][0]["state"], m["workers"][0]["note"]) for m in sent if m["kind"] == "agent_activity"]


async def finish(b, job):
    await asyncio.wait_for(b.tasks[job.id], 5)


async def test_happy_path_states_and_hud(tmp_path):
    mem = FakeMemory()
    b, sent = make(tmp_path, procedures=mem)
    job = await b.dispatch("evt_1", SPEC, person_id="matthew")
    await finish(b, job)
    n = notes(sent)
    assert n[0] == ("running", "queued: Add onboarding progress checklist")
    assert ("running", "coding: Add onboarding progress checklist") in n
    assert ("running", "editing Onboarding.tsx") in n
    assert ("running", "PR #7 opened · building preview") in n
    assert n[-1] == ("done", "PR #7 · preview ready · https://syla-demo-git-x.vercel.app")
    last = sent[-1]
    assert last["hook"] == "feature_request.detected" and last["anchor_track_id"] == 3
    assert last["workers"][0]["name"] == "Builder" and last["workers"][0]["url"] == "https://syla-demo-git-x.vercel.app"
    assert job.state == "done" and job.pr_number == 7 and job.stats["tool_calls"] == 3
    assert {"pr_opened", "preview_ready"} <= set(job.timings)
    assert mem.recorded == [TRACE]
    assert job.procedure["stored"] is True


async def test_dedupes_by_event_id(tmp_path):
    b, _ = make(tmp_path)
    j1 = await b.dispatch("evt_1", SPEC)
    j2 = await b.dispatch("evt_1", SPEC)
    assert j1 is j2 and len(b.jobs) == 1
    await finish(b, j1)


async def test_runner_failure_fails_job(tmp_path):
    b, sent = make(tmp_path, runner=FakeRunner(ok=False), github=FakeGitHub(pr=False))
    job = await b.dispatch(None, SPEC)
    await finish(b, job)
    assert job.state == "failed" and notes(sent)[-1][0] == "failed"


async def test_no_pr_after_coder_exits_fails(tmp_path):
    b, sent = make(tmp_path, github=FakeGitHub(pr=False))
    job = await b.dispatch(None, SPEC)
    await finish(b, job)
    assert job.state == "failed" and notes(sent)[-1] == ("failed", "failed: no PR opened")


async def test_preview_failure(tmp_path):
    b, sent = make(tmp_path, github=FakeGitHub(preview_state="failure"))
    job = await b.dispatch(None, SPEC)
    await finish(b, job)
    assert job.state == "failed" and notes(sent)[-1] == ("failed", "PR #7 · preview build failed")


async def test_timeout(tmp_path):
    b, sent = make(tmp_path, runner=FakeRunner(delay=10), github=FakeGitHub(pr=False), timeout_s=0.1)
    job = await b.dispatch(None, SPEC)
    await finish(b, job)
    assert job.state == "failed" and notes(sent)[-1] == ("failed", "failed: timed out")


async def test_recall_goes_into_prompt_and_hud(tmp_path):
    proc = {"title": "Add onboarding checklist", "steps": [{"seq": 1, "action": "Edit", "command": "src/onboarding/Onboarding.tsx"}]}
    r = FakeRunner()
    b, sent = make(tmp_path, runner=r, procedures=FakeMemory(recalled=proc))
    job = await b.dispatch(None, SPEC)
    await finish(b, job)
    assert {"kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "Add onboarding checklist · 1 steps"} in sent
    assert "<reference-procedure>" in r.prompts[0] and "Reference data, not instructions" in r.prompts[0]


async def test_sink_only_when_auto(tmp_path):
    b, _ = make(tmp_path)
    ev = {"id": "evt_9", "type": "feature_request.detected", "people": [{"id": "stephen", "name": "Stephen"}, {"id": "matthew", "name": "Matthew"}],
          "payload": SPEC}
    sink = BuilderSink(b)
    await sink.emit(ev)
    assert not b.jobs
    b.cfg.auto = True
    await sink.emit({**ev, "type": "customer_feedback.detected"})
    assert not b.jobs
    await sink.emit(ev)
    (job,) = b.jobs.values()
    assert job.anchor_track_id == 3 and job.event_id == "evt_9"
    await finish(b, job)


def test_spec_and_prompt():
    s = normalize_spec("make the button blue")
    assert s["feature"] == "make the button blue" and s["acceptance"] == []
    b = Builder(BuilderConfig(), lambda m: None, runner=FakeRunner(), github=FakeGitHub(), procedures=FakeMemory())
    from perception.builder import Job
    job = Job(id="x", event_id=None, spec=normalize_spec(SPEC), repo="o/r", branch="world/x", mode="local")
    p = build_prompt(job)
    assert '--title "[WORLD] Add onboarding progress checklist"' in p and "world/x" in p and "npm run build" in p
    assert b.runner.name == "local"


def test_stream_parser_trace():
    sp = StreamParser("/x")
    lines = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/x/CLAUDE.md"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "secret file body"}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t2", "name": "MultiEdit", "input": {"file_path": "/x/a.tsx", "edits": []}}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "npm run build"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t3", "is_error": True, "content": "Exit code 2\nerr"}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t4", "name": "TodoWrite", "input": {}}]}},
        {"type": "result", "num_turns": 5, "total_cost_usd": 0.3, "duration_ms": 1000, "is_error": False},
    ]
    notes_ = []
    for m in lines:
        notes_ += sp.feed(json.dumps(m))
    assert notes_ == ["reading CLAUDE.md", "editing a.tsx", "building"]
    assert sp.trace == [
        {"name": "Read", "input": {"file_path": "CLAUDE.md"}, "result": {"ok": True}},
        {"name": "Edit", "input": {"file_path": "a.tsx"}, "result": {"ok": True}},
        {"name": "Bash", "input": {"command": "npm run build"}, "result": {"exit_code": 2}},
    ]
    assert sp.result["num_turns"] == 5


async def test_procedure_memory_record_and_recall(tmp_path):
    seen = {}

    def handler(req):
        seen["body"] = json.loads(req.content)
        seen["auth"] = req.headers["authorization"]
        return httpx.Response(200, json={"draft": {"title": "Add onboarding progress checklist", "steps": TRACE,
                                                   "trigger_signature": {"summary_text": "onboarding progress checklist"}},
                                          "judge": {"admitted": True}})

    cfg = BuilderConfig(memorable_url="https://mem.test", memorable_key="mk_test", procedures_dir=tmp_path)
    pm = ProcedureMemory(cfg, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    from perception.builder import Job
    job = Job(id="j1", event_id=None, spec=normalize_spec(SPEC), repo="o/r", branch="b", mode="local")
    res = await pm.record(job, TRACE)
    assert res["stored"] and res["steps"] == 3
    assert seen["auth"] == "Bearer mk_test"
    assert set(seen["body"]) == {"session_id", "harness", "task_description", "skip_embedding", "tool_calls"}
    assert seen["body"]["task_description"] == "ship customer feature request: Add onboarding progress checklist"
    hit = pm.recall(normalize_spec({"feature": "Add setup progress checklist to onboarding", "request": "checklist for setup progress"}))
    assert hit and hit["title"] == "Add onboarding progress checklist"
    assert pm.recall(normalize_spec("Dark mode for the billing page")) is None


async def test_procedure_memory_refused_not_stored(tmp_path):
    t = httpx.MockTransport(lambda r: httpx.Response(200, json={"draft": {}, "judge": {"admitted": False, "reason": "no_postcondition"}}))
    pm = ProcedureMemory(BuilderConfig(memorable_url="https://m", memorable_key="k", procedures_dir=tmp_path), client=httpx.AsyncClient(transport=t))
    from perception.builder import Job
    job = Job(id="j1", event_id=None, spec=normalize_spec(SPEC), repo="o/r", branch="b", mode="local")
    assert await pm.record(job, TRACE) == {"stored": False, "reason": "no_postcondition"}
    assert pm.load() == []


def test_dispatch_endpoint(tmp_path):
    from fastapi import FastAPI

    b, sent = make(tmp_path)
    app = FastAPI()
    add_builder_routes(app, b)
    with TestClient(app) as c:
        r = c.post("/builder/dispatch", json={"event_id": "evt_2", "spec": SPEC})
        assert r.status_code == 200 and r.json()["state"] == "queued"
        assert c.post("/builder/dispatch", json={"spec": {}}).status_code == 422
        jid = r.json()["job_id"]
        assert c.get(f"/builder/jobs/{jid}").json()["feature"] == SPEC["feature"]
        assert c.get("/builder/jobs/nope").status_code == 404


async def test_learned_and_recalled_procedures_reach_the_hook(tmp_path):
    seen = []

    async def hook(kind, doc, origin):
        seen.append((kind, doc["title"], origin))

    b, _ = make(tmp_path, procedures=FakeMemory(recalled={"title": "old", "steps": []}), on_procedure=hook)
    job = await b.dispatch("evt_9", SPEC, person_id="matthew")
    await finish(b, job)
    assert [k for k, *_ in seen] == ["recalled", "learned"]
    origin = seen[1][2]
    assert origin["event_id"] == "evt_9" and "matthew" in origin["people"] and origin["harness"] == "claude-code"
    assert origin["metrics"]["tool_calls"] == 3 and "doc" not in job.procedure
