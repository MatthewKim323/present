import json

import httpx

from perception.demo_inject import REHEARSAL, Rehearsal


class FakeStack:
    """Director API stand-in: each feature request becomes a job that goes running -> pr_open -> done over 3 polls."""

    def __init__(self):
        self.actions, self.jobs, self.polls, self.auth = [], {}, {}, set()

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.auth.add(req.headers.get("authorization"))
        if req.url.path == "/director/api/action":
            a = json.loads(req.content)["action"]
            self.actions.append(a)
            if a in ("recap", "streak"):
                eid = f"evt_{a}"
                self.jobs[eid] = {"id": f"b{a}", "event_id": eid, "feature": a, "state": "queued", "note": "queued", "pr": None,
                                  "pr_url": None, "timings": {}}
                self.polls[eid] = 0
                return httpx.Response(200, json={"ok": True, "event_id": eid, "qm": True, "builder_auto": True})
            return httpx.Response(200, json={"ok": True, **({"note": "no unknown face in view"} if a == "intro" else {})})
        for eid, j in self.jobs.items():
            if j["state"] == "done":
                continue
            self.polls[eid] += 1
            n = self.polls[eid]
            if n == 2:
                j.update(state="pr_open", note="PR #9 opened", pr=9, pr_url="https://github.com/qtzx06/opal/pull/9", timings={"pr_opened": 80.0})
            elif n >= 3:
                j.update(state="done", note="PR #9 · preview ready", timings={"pr_opened": 80.0, "preview_ready": 140.0})
        swarm = {"hook": "feature_request.detected", "event_id": None,
                 "workers": [{"name": "Builder", "state": "running", "note": "coding"}], "recalled": {"title": "add discord command"}}
        return httpx.Response(200, json={"swarm": swarm, "jobs": list(self.jobs.values())})


def test_rehearse_runs_the_take_and_times_both_builds():
    stack, lines, now = FakeStack(), [], [0.0]

    def sleep(s):
        now[0] += s

    c = httpx.Client(base_url="http://world", transport=httpx.MockTransport(stack))
    runs = Rehearsal(c, token="tok", delay=1.0, poll_s=5.0, clock=lambda: now[0], sleep=sleep, out=lines.append).run()
    assert stack.actions == [n for n, _ in REHEARSAL if n != "wait"]
    assert stack.auth == {"Bearer tok"}
    assert [r["job"]["state"] for r in runs] == ["done", "done"]
    assert runs[0]["event_id"] == "evt_recap" and runs[1]["event_id"] == "evt_streak"
    text = "\n".join(lines)
    assert "run 1 PR #9" in text and "run 2 builder done" in text and "recalled procedure: add discord command" in text
    assert "no unknown face in view" in text
    assert "https://github.com/qtzx06/opal/pull/9" in lines[-3]  # summary rows


def test_rehearse_times_out_without_a_job():
    lines, now = [], [0.0]

    def handler(req):
        if req.url.path.endswith("/action"):
            return httpx.Response(200, json={"ok": True, "event_id": "evt_x", "qm": False, "builder_auto": False})
        return httpx.Response(200, json={"swarm": None, "jobs": []})

    def sleep(s):
        now[0] += s

    c = httpx.Client(base_url="http://world", transport=httpx.MockTransport(handler))
    r = Rehearsal(c, timeout_s=20, poll_s=5, delay=0, clock=lambda: now[0], sleep=sleep, out=lines.append)
    runs = r.run([("recap", "recap"), ("wait", "wait")])
    assert runs[0]["job"] is None
    text = "\n".join(lines)
    assert "nothing will build" in text and "TIMEOUT after 20s (no builder job" in text
