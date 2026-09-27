import asyncio
import json

from perception import builder as builder_mod
from perception.builder import Builder, BuilderConfig, StreamParser
from perception.devfeed import DevFeed, checks_state, first_hunk, short_target

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


def test_session_tail_from_stream_parser_tap():
    feed, b, _ = make()
    job = builder_mod.Job(id="b1", event_id=None, spec={"feature": "Add How it works section under hero"}, repo="r", branch="w", mode="local",
                          state="running", note="editing LandingPage.tsx")
    job.recalled = {"title": "ship feature", "steps": [{}, {}, {}], "score": 0.8}
    b.jobs["b1"] = job
    parser = StreamParser("/tmp/clone", on_tool=lambda n, i: [t("b1", n, i) for t in builder_mod.TOOL_TAPS])
    parser.feed(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "1", "name": "Edit",
         "input": {"file_path": "/tmp/clone/app/src/landing/LandingPage.tsx", "old_string": "SECRET CONTENT", "new_string": "x"}},
        {"type": "tool_use", "id": "2", "name": "Bash", "input": {"command": "npm run build"}}]}}))
    s = feed.session_msg()
    assert s["kind"] == "dev_session" and s["state"] == "running" and s["step"] == "editing LandingPage.tsx"
    assert s["tail"] == [{"tool": "Edit", "target": "app/src/landing/LandingPage.tsx"}, {"tool": "Bash", "target": "npm run build"}]
    assert "SECRET" not in json.dumps(s)
    assert s["procedure"] == {"title": "ship feature", "steps": 3, "score": 0.8}
    assert feed.active()
    feed.close()
    assert feed.on_tool not in builder_mod.TOOL_TAPS


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
