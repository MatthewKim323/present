"""Dev cockpit feed: GitHub + live Claude Code session state for the HUD (contracts/EVENTS.md, dev_github / dev_session).

  Builder jobs (builder.py) + `gh` polling -> dev_github snapshot (open [WORLD] PRs: checks, +/-, files, preview, top hunk)
  StreamParser tool events (tapped via builder.TOOL_TAPS) -> dev_session snapshot (step, tool tail, elapsed, procedure)
  Quest dev_action {approve|comment|open_preview} -> gh against the Builder repo only, for listed PRs only. Never merges.

All GitHub / Claude access stays here; the Quest only ever sees these snapshots.
No network in tests: `gh` is injectable (see tests/test_devfeed.py).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections import deque
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from . import builder as builder_mod
from .builder import Builder, _redact, _sh

log = logging.getLogger("world.devfeed")

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]
Gh = Callable[..., Awaitable[tuple[int, str]]]  # gh(*args) -> (exit code, stdout)

DEFAULT_REPO = "qtzx06/opal"  # the demo product; approve/comment only ever target this repo (DEVFEED_REPO overrides)
ACTIVE = ("queued", "running", "pr_open")
LOCKFILES = ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "uv.lock", "Cargo.lock")
CANNED_COMMENT = "Checked this with the customer in person, looks right. Captured by WORLD."
PR_FIELDS = "number,title,headRefName,headRefOid,isDraft,additions,deletions,files,statusCheckRollup,url,createdAt"


async def gh_cli(*args: str) -> tuple[int, str]:
    return await _sh("gh", *args, timeout=30)


def short_target(tool: str, inp: dict[str, Any]) -> str:
    """Tool input (already canonical + redacted by builder.canonical_input) -> a short HUD target."""
    for k in ("file_path", "path"):
        if inp.get(k):
            return str(inp[k])[-60:]
    if inp.get("command"):
        c = " ".join(str(inp["command"]).split())
        return c if len(c) <= 48 else c[:47] + "…"
    if inp.get("pattern"):
        return str(inp["pattern"])[:48]
    if inp.get("url"):
        return urlparse(str(inp["url"])).netloc or str(inp["url"])[:48]
    if inp.get("query"):
        return str(inp["query"])[:48]
    return ""


def checks_state(rollup: list[dict[str, Any]] | None) -> str:
    if not rollup:
        return "none"
    states = []
    for c in rollup:
        v = (c.get("conclusion") or c.get("state") or c.get("status") or "").upper()
        states.append(v)
    if any(s in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED") for s in states):
        return "fail"
    if all(s in ("SUCCESS", "NEUTRAL", "SKIPPED") for s in states):
        return "pass"
    return "pending"


def first_hunk(diff: str, max_lines: int = 8) -> tuple[str | None, list[dict[str, str]]]:
    """First hunk of the first non-lockfile in a unified diff -> (file, [{t, s}]), a few lines around the first change."""
    file = None
    lines: list[dict[str, str]] = []
    in_hunk = False
    for raw in diff.splitlines():
        if raw.startswith("diff --git "):
            if lines:
                break
            m = re.search(r" b/(.+)$", raw)
            file = m.group(1) if m else None
            in_hunk = False
            continue
        if file is None or file.rsplit("/", 1)[-1] in LOCKFILES:
            continue
        if raw.startswith("@@"):
            if lines:
                break
            in_hunk = True
            continue
        if not in_hunk or raw.startswith(("+++", "---", "\\")):
            continue
        t = raw[:1] if raw[:1] in "+-" else " "
        lines.append({"t": t, "s": _redact(raw[1:].rstrip())[:90]})
    if not lines:
        return None, []
    first = next((i for i, l in enumerate(lines) if l["t"] != " "), 0)
    start = max(0, first - 2)
    return file, lines[start:start + max_lines]


class DevFeed:
    def __init__(self, builder: Builder, broadcast: Broadcast, *, repo: str | None = None, gh: Gh | None = None,
                 active_poll_s: float = 5.0, idle_poll_s: float = 30.0, resend_s: float = 10.0) -> None:
        self.builder = builder
        self.broadcast = broadcast
        self.repo = repo or os.environ.get("DEVFEED_REPO") or DEFAULT_REPO
        self.gh = gh or gh_cli
        self.active_poll_s, self.idle_poll_s, self.resend_s = active_poll_s, idle_poll_s, resend_s
        self.all_prs = os.environ.get("DEVFEED_ALL_PRS", "0") in ("1", "true")  # demo: show non-[WORLD] PRs too
        self.tails: dict[str, deque] = {}
        self.finished_at: dict[str, float] = {}
        self.github: dict[str, Any] | None = None
        self._hunks: dict[str, tuple[str | None, list]] = {}  # head sha -> hunk
        self._previews: dict[str, str] = {}  # head sha -> preview url (only cached once ready)
        self._last_sent: dict[str, str] = {}
        self._last_sent_t: dict[str, float] = {}
        builder_mod.TOOL_TAPS.append(self.on_tool)

    def close(self) -> None:
        if self.on_tool in builder_mod.TOOL_TAPS:
            builder_mod.TOOL_TAPS.remove(self.on_tool)

    # ------------------------------------------------------------ session

    def on_tool(self, job_id: str, tool: str, inp: dict[str, Any]) -> None:
        self.tails.setdefault(job_id, deque(maxlen=10)).append({"tool": tool, "target": short_target(tool, inp)})

    def _job(self):
        jobs = list(self.builder.jobs.values())
        if not jobs:
            return None
        active = [j for j in jobs if j.state in ACTIVE]
        return max(active or jobs, key=lambda j: j.created)

    def session_msg(self) -> dict[str, Any] | None:
        j = self._job()
        if j is None:
            return None
        if j.state not in ACTIVE:
            self.finished_at.setdefault(j.id, time.time())
        end = self.finished_at.get(j.id, time.time())
        proc = None
        if j.recalled:
            proc = {"title": j.recalled.get("title"), "steps": len(j.recalled.get("steps") or []), "score": j.recalled.get("score")}
        return {"kind": "dev_session", "job_id": j.id, "feature": j.feature, "state": j.state, "mode": j.mode,
                "step": j.note, "tail": list(self.tails.get(j.id, [])), "elapsed_s": int(end - j.created),
                "procedure": proc, "session_url": j.session_url, "pr": j.pr_number}

    def active(self) -> bool:
        now = time.time()
        return any(j.state in ACTIVE or now - self.finished_at.get(j.id, now) < 300 for j in self.builder.jobs.values())

    # ------------------------------------------------------------ github

    async def _gh_json(self, *args: str) -> Any:
        code, out = await self.gh(*args)
        if code:
            raise RuntimeError(out[-200:])
        return json.loads(out or "null")

    async def _preview(self, sha: str) -> str | None:
        if sha in self._previews:
            return self._previews[sha]
        for j in self.builder.jobs.values():
            if j.head_sha == sha and j.preview_url:
                self._previews[sha] = j.preview_url
                return j.preview_url
        deps = await self._gh_json("api", f"repos/{self.repo}/deployments?sha={sha}&per_page=3")
        if not deps:
            return None
        sts = await self._gh_json("api", f"repos/{self.repo}/deployments/{deps[0]['id']}/statuses?per_page=1")
        if sts and sts[0].get("state") == "success":
            url = sts[0].get("environment_url") or sts[0].get("target_url")
            if url:
                self._previews[sha] = url
                return url
        return None

    async def _hunk(self, number: int, sha: str) -> tuple[str | None, list]:
        if sha not in self._hunks:
            code, out = await self.gh("pr", "diff", str(number), "-R", self.repo)
            self._hunks[sha] = first_hunk(out) if code == 0 else (None, [])
        return self._hunks[sha]

    async def github_msg(self) -> dict[str, Any]:
        prs = await self._gh_json("pr", "list", "-R", self.repo, "--state", "open", "--limit", "20", "--json", PR_FIELDS)
        prs = [p for p in prs or [] if self.all_prs or p.get("title", "").startswith("[WORLD]")]
        prs.sort(key=lambda p: p["number"], reverse=True)
        out = []
        for i, p in enumerate(prs[:4]):
            sha = p.get("headRefOid") or ""
            try:
                preview = await self._preview(sha) if sha else None
            except Exception as e:  # noqa: BLE001
                log.debug("preview lookup failed: %s", e)
                preview = None
            hfile, hunk = (await self._hunk(p["number"], sha)) if (i == 0 and sha) else (None, [])
            out.append({
                "number": p["number"], "title": p.get("title", ""), "branch": p.get("headRefName", ""),
                "state": "draft" if p.get("isDraft") else "open", "checks": checks_state(p.get("statusCheckRollup")),
                "additions": p.get("additions", 0), "deletions": p.get("deletions", 0),
                "files": [f.get("path") for f in (p.get("files") or [])][:12], "preview_url": preview,
                "url": p.get("url"), "hunk_file": hfile, "hunk": hunk,
            })
        return {"kind": "dev_github", "repo": self.repo, "prs": out}

    # ------------------------------------------------------------ fanout

    async def _send(self, msg: dict[str, Any] | None, force: bool = False) -> None:
        if msg is None:
            return
        k = msg["kind"]
        body = json.dumps(msg, sort_keys=True)
        now = time.time()
        if not force and body == self._last_sent.get(k) and now - self._last_sent_t.get(k, 0) < self.resend_s:
            return
        self._last_sent[k], self._last_sent_t[k] = body, now
        await self.broadcast(msg)

    async def poll_github(self) -> None:
        try:
            self.github = await self.github_msg()
        except Exception as e:  # noqa: BLE001
            log.warning("devfeed github poll failed: %s", e)
            return
        await self._send(self.github)

    async def loop(self) -> None:
        next_gh = 0.0
        was_active = False
        while True:
            try:
                now = time.time()
                act = self.active()
                if now >= next_gh or (act and not was_active):
                    await self.poll_github()
                    next_gh = time.time() + (self.active_poll_s if act else self.idle_poll_s)
                was_active = act
                await self._send(self.session_msg())
                if self.github is not None:
                    await self._send(self.github)
            except Exception:  # noqa: BLE001
                log.exception("devfeed tick failed")
            await asyncio.sleep(1.0)

    # ------------------------------------------------------------ actions

    async def _toast(self, text: str, detail: str) -> None:
        await self.broadcast({"kind": "memory_event", "text": text, "detail": detail})

    async def handle_action(self, msg: dict[str, Any]) -> dict[str, Any]:
        action = msg.get("action")
        try:
            pr = int(msg.get("pr"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "pr must be a number"}
        listed = {p["number"] for p in (self.github or {}).get("prs", [])}
        if action == "open_preview":
            log.info("dev_action open_preview #%s", pr)
            return {"ok": True}
        if action not in ("approve", "comment"):
            return {"ok": False, "error": f"unknown action {action!r}"}
        if pr not in listed:
            await self._toast(f"{action.upper()} REFUSED", f"#{pr} · not an open WORLD PR")
            return {"ok": False, "error": "pr not listed"}
        if action == "approve":
            code, out = await self.gh("pr", "review", str(pr), "-R", self.repo, "--approve",
                                      "--body", "Approved in person from the WORLD HUD.")
            ok_text, bad_text = "PR APPROVED", "APPROVE FAILED"
        else:
            text = " ".join(str(msg.get("text") or "").split())[:500] or CANNED_COMMENT
            code, out = await self.gh("pr", "comment", str(pr), "-R", self.repo, "--body", text)
            ok_text, bad_text = "COMMENT POSTED", "COMMENT FAILED"
        log.info("dev_action %s #%s -> %s %s", action, pr, code, out.strip()[-160:])
        if code == 0:
            await self._toast(ok_text, f"#{pr}")
            return {"ok": True}
        reason = out.strip().splitlines()[-1][:60] if out.strip() else f"exit {code}"
        await self._toast(bad_text, f"#{pr} · {reason}")
        return {"ok": False, "error": out[-200:]}
