import asyncio
import json
import time

from perception import builder as builder_mod
from perception.builder import Builder, BuilderConfig, StreamParser
from perception.devfeed import DevFeed, checks_state, first_hunk, parse_procedure, short_target

DIFF = """diff --git a/package-lock.json b/package-lock.json
index 1..2 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-  "version": "1"
+  "version": "2"
diff --git a/app/src/landing/LandingPage.tsx b/app/src/landing/LandingPage.tsx
index 3..4 100644
--- a/app/src/landing/LandingPage.tsx
+++ b/app/src/landing/LandingPage.tsx
@@ -10,6 +10,7 @@ export default function LandingPage() {
   return (
     <main>
-      <HeroSection />
+      <HeroSection isLoaded />
+      <HowItWorks steps={3} token="ghp_abcdefghijklmnop" />
     </main>
   );
@@ -40,2 +41,2 @@
-  old
+  new
"""

PRS = [
    {"number": 7, "title": "[WORLD] Add How it works section under hero", "headRefName": "world/add-how-it-works-section-under-hero", "headRefOid": "sha7",
     "isDraft": False, "additions": 42, "deletions": 8, "url": "https://github.com/qtzx06/opal/pull/7",
     "files": [{"path": "app/src/landing/LandingPage.tsx"}, {"path": "package-lock.json"}],
     "statusCheckRollup": [{"conclusion": "SUCCESS"}, {"state": "PENDING"}]},
    {"number": 6, "title": "chore: unrelated", "headRefName": "x", "headRefOid": "sha6", "files": []},
    {"number": 5, "title": "[WORLD] Older thing", "headRefName": "world/older", "headRefOid": "sha5",
     "isDraft": True, "additions": 1, "deletions": 1, "files": [], "statusCheckRollup": []},
]


class FakeGh:
    def __init__(self, review_code=0):
        self.calls = []
        self.review_code = review_code

    async def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ("pr", "list"):
            return 0, json.dumps(PRS)
        if args[:2] == ("pr", "diff"):
            return 0, DIFF
        if args[0] == "api" and "statuses" in args[1]:
            return 0, json.dumps([{"state": "success", "environment_url": "https://opal-git-x.vercel.app"}])
        if args[0] == "api":
            return 0, json.dumps([{"id": 99}])
        if args[:2] == ("pr", "review"):
            return self.review_code, "" if self.review_code == 0 else "GraphQL: Can not approve your own pull request"
        if args[:2] == ("pr", "comment"):
            return 0, "https://github.com/qtzx06/opal/pull/7#issuecomment-1"
        return 1, "unexpected"


def make(gh=None):
    sent = []

    async def bc(m):
        sent.append(m)

    b = Builder(BuilderConfig(), bc, runner=object(), github=object(), procedures=object())
    return DevFeed(b, bc, repo="qtzx06/opal", gh=gh or FakeGh()), b, sent


def test_first_hunk_skips_lockfile_and_redacts():
    f, hunk = first_hunk(DIFF)
    assert f == "app/src/landing/LandingPage.tsx"
    assert [h["t"] for h in hunk[:4]] == [" ", " ", "-", "+"]
    assert hunk[2]["s"].strip() == '<HeroSection />'
    assert all("ghp_" not in h["s"] for h in hunk)
    assert all(h["s"] not in ("  old", "  new") for h in hunk)  # only the first hunk


def test_checks_and_targets():
    assert checks_state([]) == "none"
    assert checks_state([{"conclusion": "SUCCESS"}]) == "pass"
    assert checks_state([{"conclusion": "FAILURE"}, {"state": "PENDING"}]) == "fail"
    assert checks_state([{"conclusion": "SUCCESS"}, {"status": "IN_PROGRESS"}]) == "pending"
    assert short_target("Read", {"file_path": "app/src/a.tsx"}) == "app/src/a.tsx"
    assert short_target("Bash", {"command": "npm   run build"}) == "npm run build"
    assert short_target("WebFetch", {"url": "https://vercel.com/docs/x"}) == "vercel.com"


def test_github_msg_filters_world_prs_and_hunks_newest():
    feed, _, _ = make()
    msg = asyncio.run(feed.github_msg())
    assert msg["kind"] == "dev_github" and msg["repo"] == "qtzx06/opal"
    assert [p["number"] for p in msg["prs"]] == [7, 5]
    p7, p5 = msg["prs"]
    assert p7["checks"] == "pending" and p7["preview_url"] == "https://opal-git-x.vercel.app"
    assert p7["files"] == ["app/src/landing/LandingPage.tsx", "package-lock.json"]
    assert p7["hunk_file"] == "app/src/landing/LandingPage.tsx" and p7["hunk"]
    assert p5["state"] == "draft" and p5["hunk"] == [] and p5["checks"] == "none"
    feed.close()


def _job(b, jid="b1", event_id=None, state="running", note="editing core/bot.py", created=None):
    job = builder_mod.Job(id=jid, event_id=event_id, spec={"feature": "Add !recap command"}, repo="r", branch="w",
                          state=state, note=note)
    if created is not None:
        job.created = created
    b.jobs[jid] = job
    return job


def _tap(jid, *calls):
    parser = StreamParser("/tmp/clone", on_tool=lambda n, i: [t(jid, n, i) for t in builder_mod.TOOL_TAPS])
    parser.feed(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": str(k), "name": n, "input": inp} for k, (n, inp) in enumerate(calls)]}}))


QM_LANES = {"kind": "agent_activity", "anchor_track_id": 4, "hook": "feature_request.detected", "workers": [
    {"name": "Context", "state": "done", "note": "Matthew · lifelong friend"},
    {"name": "Product", "state": "done", "note": "spec: !recap, 2 checks"},
    {"name": "Builder", "state": "done", "note": "dispatched"}]}


def test_builder_only_swarm_when_qm_is_not_running():
    feed, b, _ = make()
    job = _job(b, event_id="evt_1")
    job.anchor_track_id = 3
    job.recalled = {"title": "add discord command", "steps": [{}] * 5, "score": 0.8}
    _tap("b1", ("Read", {"file_path": "/tmp/clone/discord-bot/core/bot.py"}),
         ("Edit", {"file_path": "/tmp/clone/discord-bot/core/bot.py", "old_string": "SECRET CONTENT", "new_string": "x"}),
         ("Bash", {"command": "cd discord-bot && python3 -m compileall -q core utils"}))
    s = feed.swarm_msg()
    assert s["kind"] == "qm_swarm" and s["hook"] == "feature_request.detected" and s["event_id"] == "evt_1"
    assert s["anchor_track_id"] == 3 and [w["name"] for w in s["workers"]] == ["Builder"]
    lane = s["workers"][0]
    assert lane["state"] == "running" and lane["note"] == "editing core/bot.py"
    assert lane["tail"][:2] == [{"tool": "Read", "target": "discord-bot/core/bot.py"}, {"tool": "Edit", "target": "discord-bot/core/bot.py"}]
    assert lane["tail"][2]["tool"] == "Bash" and "SECRET" not in json.dumps(s)
    assert s["recalled"] == {"title": "add discord command", "steps": 5} and "learned" not in s
    assert feed.active()
    feed.close()
    assert feed.on_tool not in builder_mod.TOOL_TAPS


def test_tail_keeps_last_six():
    feed, b, _ = make()
    _job(b)
    _tap("b1", *[("Read", {"file_path": f"/tmp/clone/f{i}.py"}) for i in range(9)])
    assert [e["target"] for e in feed.swarm_msg()["workers"][0]["tail"]] == [f"f{i}.py" for i in range(3, 9)]
    feed.close()


def test_qm_lanes_merge_with_builder_job():
    feed, b, _ = make()
    feed.on_hud(QM_LANES)
    job = _job(b, event_id="evt_2", state="pr_open", note="PR #6 opened · building preview")
    job.pr_number, job.pr_url = 6, "https://github.com/qtzx06/opal/pull/6"
    job.procedure = {"stored": True, "title": "add discord command", "steps": 5}
    s = feed.swarm_msg()
    assert [w["name"] for w in s["workers"]] == ["Context", "Product", "Builder"]
    assert s["workers"][0] == {"name": "Context", "state": "done", "note": "Matthew · lifelong friend"}
    builder = s["workers"][2]
    assert builder["state"] == "running" and builder["pr"] == 6 and "tail" in builder  # the job, not QM's "dispatched"
    assert s["anchor_track_id"] == 4 and s["event_id"] == "evt_2"
    assert s["learned"] == {"title": "add discord command", "steps": 5}
    feed.close()


def test_qm_only_swarm_and_recall_toast():
    feed, b, _ = make()
    _job(b, state="done", note="PR #5 · preview ready", created=time.time() - 600)  # an old run
    feed.on_hud({"kind": "agent_activity", "hook": "customer_feedback.detected", "workers": [
        {"name": "Context", "state": "running", "note": "searching GBrain"}, {"name": "Follow-up", "state": "bogus"}]})
    feed.on_hud({"kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "handle feedback · 7 steps"})
    s = feed.swarm_msg()
    assert s["hook"] == "customer_feedback.detected"
    assert [(w["name"], w["state"]) for w in s["workers"]] == [("Context", "running"), ("Follow-up", "running")]
    assert s["recalled"] == {"title": "handle feedback", "steps": 7}
    feed.close()


def test_builder_own_agent_activity_is_ignored_and_newer_direct_job_wins():
    feed, b, _ = make()
    feed.on_hud({**QM_LANES, "hook": "customer_feedback.detected"})
    feed.on_hud({"kind": "agent_activity", "hook": "feature_request.detected", "job_id": "b9", "workers": [{"name": "Builder"}]})
    assert set(feed.swarms) == {"customer_feedback.detected"}
    _job(b, created=time.time() + 1)
    s = feed.swarm_msg()
    assert s["hook"] == "feature_request.detected" and [w["name"] for w in s["workers"]] == ["Builder"]
    feed.close()


def test_new_event_id_resets_the_swarm():
    feed, _, _ = make()
    feed.on_hud({**QM_LANES, "event_id": "e1"})
    feed.on_hud({"kind": "memory_event", "text": "PROCEDURE LEARNED", "detail": "feature_request.detected · 2 workflows"})
    assert feed.swarm_msg()["learned"] == {"title": "feature_request.detected", "steps": None}
    feed.on_hud({**QM_LANES, "event_id": "e2", "workers": [{"name": "Context", "state": "running"}]})
    s = feed.swarm_msg()
    assert s["event_id"] == "e2" and "learned" not in s and len(s["workers"]) == 1
    feed.close()


def test_parse_procedure():
    assert parse_procedure("add discord command · 5 steps") == {"title": "add discord command", "steps": 5}
    assert parse_procedure("x") == {"title": "x", "steps": None}


def test_actions_only_for_listed_prs_and_never_merge():
    gh = FakeGh()
    feed, _, sent = make(gh)
    asyncio.run(feed.poll_github())
    assert sent[-1]["kind"] == "dev_github"
    r = asyncio.run(feed.handle_action({"kind": "dev_action", "action": "approve", "pr": 6}))  # not [WORLD]
    assert not r["ok"] and sent[-1]["text"] == "APPROVE REFUSED"
    assert asyncio.run(feed.handle_action({"action": "approve", "pr": 7}))["ok"]
    assert sent[-1] == {"kind": "memory_event", "text": "PR APPROVED", "detail": "#7"}
    assert asyncio.run(feed.handle_action({"action": "comment", "pr": "7"}))["ok"]
    body = [c for c in gh.calls if c[:2] == ("pr", "comment")][0]
    assert body[-1].startswith("Checked this with the customer")
    assert not any("merge" in c for call in gh.calls for c in call)
    assert all(c[c.index("-R") + 1] == "qtzx06/opal" for c in gh.calls if "-R" in c)
    feed.close()


def test_approve_failure_toasts_reason():
    feed, _, sent = make(FakeGh(review_code=1))
    asyncio.run(feed.poll_github())
    assert not asyncio.run(feed.handle_action({"action": "approve", "pr": 7}))["ok"]
    assert sent[-1]["text"] == "APPROVE FAILED" and "own pull request" in sent[-1]["detail"]
    feed.close()


def test_actions_run_as_the_wearer_when_a_token_is_set(monkeypatch):
    reader, actor = FakeGh(), FakeGh()
    sent = []

    async def bc(m):
        sent.append(m)

    b = Builder(BuilderConfig(), bc, runner=object(), github=object(), procedures=object())
    feed = DevFeed(b, bc, repo="qtzx06/opal", gh=reader, actor_gh=actor)
    asyncio.run(feed.poll_github())
    assert asyncio.run(feed.handle_action({"action": "approve", "pr": 7}))["ok"]
    assert [c[:2] for c in actor.calls] == [("pr", "review")]  # the wearer approves
    assert not any(c[:2] == ("pr", "review") for c in reader.calls)  # the builder's account only reads
    feed.close()


def test_actor_gh_from_env_uses_token(monkeypatch):
    from perception import devfeed
    monkeypatch.delenv("DEVFEED_GH_TOKEN", raising=False)
    assert devfeed.actor_gh_from_env() is None
    monkeypatch.setenv("DEVFEED_GH_TOKEN", "ghp_test")
    seen = {}

    async def fake_sh(*args, env=None, timeout=0):
        seen["token"] = env["GH_TOKEN"]
        return 0, ""

    monkeypatch.setattr(devfeed, "_sh", fake_sh)
    asyncio.run(devfeed.actor_gh_from_env()("pr", "comment"))
    assert seen["token"] == "ghp_test"
