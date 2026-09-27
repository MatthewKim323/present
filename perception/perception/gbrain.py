"""GBrain (hosted gbrain.io) sink: WorldEvents -> declarative/episodic memory, and person cards <- memory.

Page layout (all human-readable markdown, user-owned):

  people/<id>                          person page (human-curated, only created if missing, never overwritten)
  relationships/<wearer>--<id>         WORLD-owned running page: summary, what we know, recent, open loops
  events/<situation>                   where the wearer is right now (YC hackathon, SF, date)
  projects/<slug>                      product/project pages (created if missing)
  feedback/ commitments/ decisions/ feature-requests/ bugs/ <date>-<slug>   one page per extracted signal

Writes are queued and applied by a background worker so the HUD never waits on the network.
The relationship state is kept in memory (hydrated from GBrain) so person cards are instant and
compound live; GBrain is the durable copy. If GBrain is down or unauthorized, everything falls
back to StubGBrainSink so the demo never dies.

Privacy: only memory tools are callable (ALLOWED_TOOLS). Never gmail/calendar/drive.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

import httpx

from .events import slug as slugify
from .sinks import StubGBrainSink

log = logging.getLogger("world.gbrain")

PROTOCOL_VERSION = "2025-06-18"

# Hard allowlist: this workspace is also wired to real Gmail/Calendar. Memory tools only.
ALLOWED_TOOLS = frozenset({
    "whoami", "put_page", "get_page", "delete_page", "list_pages", "query", "search",
    "add_timeline_entry", "get_timeline", "add_link", "remove_link", "get_links", "get_backlinks",
    "add_tag", "remove_tag", "get_tags", "remember", "recall", "restore_page",
})


class GBrainError(RuntimeError):
    pass


class NotFound(GBrainError):
    pass


class MCP(Protocol):
    async def call(self, name: str, args: dict[str, Any]) -> Any: ...


# ---------------- minimal MCP client (streamable HTTP, JSON or SSE responses) ----------------

class MCPClient:
    def __init__(self, url: str, tokens: Any, client: httpx.AsyncClient | None = None, timeout: float = 8.0) -> None:
        self.url = url
        self.tokens = tokens  # object with async get() -> str and invalidate()
        self.client = client or httpx.AsyncClient(timeout=timeout)
        self.session_id: str | None = None
        self._initialized = False
        self._next_id = 0
        self._init_lock = asyncio.Lock()

    async def close(self) -> None:
        await self.client.aclose()

    def _id(self) -> int:
        self._next_id += 1
        return self._next_id

    async def _headers(self) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {await self.tokens.get()}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    @staticmethod
    def _parse(r: httpx.Response, want_id: int | None) -> dict[str, Any] | None:
        ctype = r.headers.get("content-type", "")
        if r.status_code == 202 or not r.content:
            return None
        if "text/event-stream" in ctype:
            found = None
            for block in r.text.split("\n\n"):
                data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
                if not data:
                    continue
                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and (want_id is None or msg.get("id") == want_id):
                    found = msg
            return found
        return r.json()

    async def _post(self, payload: dict[str, Any], *, retry: bool = True) -> dict[str, Any] | None:
        r = await self.client.post(self.url, json=payload, headers=await self._headers())
        if r.status_code == 401 and retry:
            if hasattr(self.tokens, "invalidate"):
                self.tokens.invalidate()
            return await self._post(payload, retry=False)
        if r.status_code == 404 and self.session_id and retry and payload.get("method") != "initialize":
            # session expired server-side: re-initialize once
            self.session_id, self._initialized = None, False
            await self.initialize()
            return await self._post(payload, retry=False)
        if r.status_code >= 400:
            raise GBrainError(f"MCP HTTP {r.status_code}: {r.text[:200]}")
        sid = r.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid
        return self._parse(r, payload.get("id"))

    async def initialize(self) -> None:
        async with self._init_lock:
            if self._initialized:
                return
            msg = await self._post({
                "jsonrpc": "2.0", "id": self._id(), "method": "initialize",
                "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                           "clientInfo": {"name": "world-perception", "version": "0.1"}},
            }, retry=True)
            if msg and "error" in msg:
                raise GBrainError(f"initialize failed: {msg['error']}")
            await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
            self._initialized = True

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        if name not in ALLOWED_TOOLS:
            raise GBrainError(f"tool {name!r} is not an allowed memory tool")
        if not self._initialized:
            await self.initialize()
        rid = self._id()
        msg = await self._post({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                                "params": {"name": name, "arguments": args}})
        if msg is None:
            raise GBrainError(f"{name}: empty response")
        if "error" in msg:
            raise GBrainError(f"{name}: {msg['error']}")
        return unwrap_tool_result(name, msg.get("result") or {})


def unwrap_tool_result(name: str, result: dict[str, Any]) -> Any:
    text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    if result.get("isError"):
        if "page_not_found" in text or "not found" in text.lower():
            raise NotFound(f"{name}: {text[:200]}")
        raise GBrainError(f"{name}: {text[:300]}")
    if "structuredContent" in result:
        return result["structuredContent"]
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text


# ---------------- situation (temporal / spatial grounding) ----------------

@dataclass
class Situation:
    name: str = "YC hackathon"
    place: str = "San Francisco"
    date: str = "2026-09-27"
    slug_override: str | None = None

    @property
    def slug(self) -> str:
        return self.slug_override or f"events/{slugify(self.name)}-{self.date}"

    @property
    def label(self) -> str:
        return ", ".join(x for x in (self.name, self.place) if x)

    @classmethod
    def from_env(cls) -> "Situation":
        """WORLD_SITUATION: JSON object, path to a JSON file, or a plain name. Unset -> YC hackathon default."""
        raw = os.environ.get("WORLD_SITUATION", "").strip()
        if not raw:
            return cls()
        data: Any
        if raw.startswith("{"):
            data = json.loads(raw)
        elif Path(raw).exists():
            data = json.loads(Path(raw).read_text())
        else:
            data = {"name": raw}
        return cls(name=data.get("name") or cls.name, place=data.get("place", cls.place),
                   date=data.get("date") or datetime.now().strftime("%Y-%m-%d"), slug_override=data.get("slug"))

    def page(self) -> str:
        return _page({"type": "event", "title": self.name, "place": self.place, "date": self.date},
                     f"# {self.name}\n\n{self.place}, {self.date}.\n\nWhere the wearer is right now. Encounters and conversations link here.\n")


# ---------------- page helpers ----------------

def _yaml_scalar(v: Any) -> str:
    if v is None:
        return "''"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return json.dumps(str(v), ensure_ascii=False)  # JSON strings are valid YAML scalars


def _page(front: dict[str, Any], body: str) -> str:
    lines = ["---"]
    for k, v in front.items():
        if v is None or v == "":
            continue
        if isinstance(v, list):
            lines.append(f"{k}:")
            lines.extend(f"  - {_yaml_scalar(x)}" for x in v)
        else:
            lines.append(f"{k}: {_yaml_scalar(v)}")
    lines.append("---\n")
    return "\n".join(lines) + "\n" + body.strip() + "\n"


def _clean(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper().startswith("TODO"):
        return None  # seed placeholders never reach the HUD
    return s


def parse_sections(md: str) -> dict[str, list[str]]:
    """'## Heading' -> bullet lines (without '- '). Non-bullet text is kept as a single line."""
    out: dict[str, list[str]] = {}
    cur: str | None = None
    for line in md.splitlines():
        m = re.match(r"^##\s+(.*)$", line)
        if m:
            cur = m.group(1).strip().lower()
            out[cur] = []
            continue
        if cur is None:
            continue
        s = line.strip()
        if not s:
            continue
        out[cur].append(s[2:].strip() if s.startswith(("- ", "* ")) else s)
    return out


TIMELINE_RE = re.compile(r"^- \*\*(\d{4}-\d{2}-\d{2})\*\*\s*(?:\|\s*(\S+))?\s*[—-]+\s*(.*)$")


def parse_timeline(md: str) -> list[dict[str, str]]:
    """get_page's rendered timeline -> [{date, source, summary}] in page order."""
    out = []
    for line in (md or "").splitlines():
        m = TIMELINE_RE.match(line.strip())
        if m:
            out.append({"date": m.group(1), "source": m.group(2) or "", "summary": m.group(3).strip()})
    return out


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _parse_ts(v: Any) -> float | None:
    if not v:
        return None
    s = str(v).strip()
    try:
        if len(s) == 10:
            return datetime.strptime(s, "%Y-%m-%d").timestamp()
        if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", s):
            return datetime.strptime(s, "%Y-%m-%d %H:%M").timestamp()
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _ago(sec: float) -> str:
    sec = max(0.0, sec)
    if sec < 90:
        return "just now"
    if sec < 3600:
        return f"{int(sec // 60)}m ago"
    if sec < 86400:
        return f"{int(sec // 3600)}h ago"
    return f"{int(sec // 86400)}d ago"


def _hhmm(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time()).strftime("%H:%M")


# ---------------- relationship state ----------------

@dataclass
class RelState:
    person_id: str
    name: str
    summary: str | None = None
    facts: list[str] = field(default_factory=list)
    recent: list[str] = field(default_factory=list)  # newest first
    you_owe: list[str] = field(default_factory=list)
    owes_you: list[str] = field(default_factory=list)
    last_topic: str | None = None
    sentiment: str | None = None
    last_seen: str | None = None  # "2026-09-27 14:03"
    last_seen_where: str | None = None
    prev_seen: str | None = None  # the encounter before the current one
    prev_seen_where: str | None = None
    deltas: list[str] = field(default_factory=list)  # newest last
    encounters: int = 0
    hydrated: bool = False
    reset_at: str | None = None  # set by seed_gbrain --reset: older timeline rows belong to previous takes

    MAX_RECENT = 10
    MAX_FACTS = 30

    def add_fact(self, text: str) -> bool:
        t = text.strip()
        if not t or t.lower() in (f.lower() for f in self.facts):
            return False
        self.facts.append(t)
        del self.facts[: max(0, len(self.facts) - self.MAX_FACTS)]
        return True

    def add_recent(self, text: str) -> None:
        t = text.strip()
        if t:
            self.recent.insert(0, t)
            del self.recent[self.MAX_RECENT:]

    def add_loop(self, direction: str, item: str) -> None:
        lst = self.you_owe if direction == "you_owe" else self.owes_you
        if item and item.lower() not in (x.lower() for x in lst):
            lst.insert(0, item)

    def page(self, wearer_name: str, situation: Situation) -> str:
        front = {
            "type": "relationship", "title": f"{wearer_name} and {self.name}", "person": self.person_id, "created_by": "world",
            "summary": self.summary, "last_topic": self.last_topic, "sentiment": self.sentiment,
            "last_seen": self.last_seen, "last_seen_where": self.last_seen_where,
            "encounters": self.encounters or None, "reset_at": self.reset_at,
        }
        loops = [f"you owe: {x}" for x in self.you_owe] + [f"owes you: {x}" for x in self.owes_you]
        body = (
            f"# {wearer_name} and {self.name}\n\nMaintained live by WORLD from in-person encounters. "
            f"Person: [[people/{self.person_id}]]. Current situation: [[{situation.slug}]].\n\n"
            f"## Summary\n\n{self.summary or ''}\n\n"
            "## What we know\n\n" + "".join(f"- {x}\n" for x in self.facts) + "\n"
            "## Recent\n\n" + "".join(f"- {x}\n" for x in self.recent) + "\n"
            "## Open loops\n\n" + "".join(f"- {x}\n" for x in loops)
        )
        return _page(front, body)

    @classmethod
    def from_page(cls, person_id: str, name: str, page: dict[str, Any]) -> "RelState":
        fm = page.get("frontmatter") or {}
        secs = parse_sections(page.get("compiled_truth") or "")
        st = cls(person_id, name)
        summ = secs.get("summary") or []
        st.summary = _clean(fm.get("summary")) or _clean(" ".join(summ))
        st.facts = [x for x in secs.get("what we know", []) if _clean(x)]
        st.recent = [x for x in secs.get("recent", []) if _clean(x)]
        for x in secs.get("open loops", []):
            if not _clean(x):
                continue
            low = x.lower()
            if low.startswith("you owe:"):
                st.you_owe.append(x.split(":", 1)[1].strip())
            elif low.startswith("owes you:"):
                st.owes_you.append(x.split(":", 1)[1].strip())
        st.last_topic = _clean(fm.get("last_topic"))
        st.sentiment = _clean(fm.get("sentiment"))
        st.last_seen = _clean(fm.get("last_seen"))
        st.last_seen_where = _clean(fm.get("last_seen_where"))
        st.reset_at = _clean(fm.get("reset_at"))
        try:
            st.encounters = int(fm.get("encounters") or 0)
        except (TypeError, ValueError):
            st.encounters = 0
        return st


# ---------------- the sink ----------------

SIGNAL_DIRS = {
    "customer_feedback.detected": "feedback",
    "commitment.detected": "commitments",
    "decision.detected": "decisions",
    "feature_request.detected": "feature-requests",
    "physical_bug.detected": "bugs",
}


class GBrainIOSink:
    name = "gbrain"

    def __init__(
        self,
        mcp: MCP | None,
        fallback: StubGBrainSink,
        *,
        wearer_id: str = "stephen",
        wearer_name: str = "Stephen",
        situation: Situation | None = None,
        encounter_debounce_s: float = 600.0,
        person_ttl_s: float = 60.0,
        read_timeout_s: float = 2.0,
        write_timeout_s: float = 10.0,
        retry_after_s: float = 30.0,
        people_meta: Any = None,
    ) -> None:
        self.mcp = mcp
        self.fallback = fallback
        self.wearer_id = wearer_id
        self.wearer_name = wearer_name
        self.situation = situation or Situation.from_env()
        self._timelines: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self.encounter_debounce_s = encounter_debounce_s
        self.person_ttl_s = person_ttl_s
        self.read_timeout_s = read_timeout_s
        self.write_timeout_s = write_timeout_s
        self.retry_after_s = retry_after_s
        self.people_meta = people_meta or (lambda pid: {})
        self.rel: dict[str, RelState] = {}
        self._person: dict[str, tuple[float, dict[str, Any] | None]] = {}
        self._known_pages: set[str] = set()
        self._linked: set[tuple[str, str]] = set()
        self._last_encounter: dict[str, float] = {}
        self._hydrate_locks: dict[str, asyncio.Lock] = {}
        self._down_until = 0.0
        self._queue: asyncio.Queue | None = None
        self._worker: asyncio.Task | None = None
        self.writes_ok = 0
        self.writes_failed = 0

    # ---------- health ----------
    @property
    def up(self) -> bool:
        return self.mcp is not None and time.time() >= self._down_until

    def _mark_down(self, err: Exception) -> None:
        self._down_until = time.time() + self.retry_after_s
        log.warning("gbrain.io unavailable (%s); using stub for %.0fs", err, self.retry_after_s)

    def status(self) -> dict[str, Any]:
        return {"backend": "gbrain.io", "up": self.up, "writes_ok": self.writes_ok,
                "writes_failed": self.writes_failed, "situation": self.situation.slug}

    # ---------- plumbing ----------
    async def _call(self, name: str, args: dict[str, Any], timeout: float | None = None) -> Any:
        if self.mcp is None:
            raise GBrainError("no MCP client")
        return await asyncio.wait_for(self.mcp.call(name, args), timeout or self.write_timeout_s)

    async def _ensure_page(self, slug: str, content: str) -> None:
        if slug in self._known_pages:
            return
        try:
            await self._call("get_page", {"slug": slug})
        except NotFound:
            await self._call("put_page", {"slug": slug, "content": content})
        self._known_pages.add(slug)

    async def _link(self, frm: str, to: str, link_type: str, context: str = "") -> None:
        key = (frm, to)
        if key in self._linked:
            return
        args = {"from": frm, "to": to, "link_type": link_type, "link_source": "world"}
        if context:
            args["context"] = context[:200]
        await self._call("add_link", args)
        self._linked.add(key)

    async def _timeline(self, slug: str, summary: str, detail: str = "") -> None:
        args = {"slug": slug, "date": _today(), "summary": summary[:300], "source": self.situation.slug}
        if detail:
            args["detail"] = detail[:1000]
        await self._call("add_timeline_entry", args)

    def _ensure_worker(self) -> asyncio.Queue:
        if self._queue is None:
            self._queue = asyncio.Queue()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())
        return self._queue

    async def _run(self) -> None:
        q = self._queue
        assert q is not None
        while True:
            job = await q.get()
            try:
                if self.up:
                    await job()
                    self.writes_ok += 1
                else:
                    self.writes_failed += 1
            except Exception as e:  # noqa: BLE001
                self.writes_failed += 1
                if isinstance(e, (GBrainError, httpx.HTTPError, asyncio.TimeoutError, OSError)) and not isinstance(e, NotFound):
                    self._mark_down(e)
                else:
                    log.warning("gbrain write failed: %r", e)
            finally:
                q.task_done()

    def _enqueue(self, job) -> None:
        if self.mcp is None:
            return
        self._ensure_worker().put_nowait(job)

    async def flush(self) -> None:
        if self._queue is not None:
            await self._queue.join()

    # ---------- people ----------
    def _others(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        return [p for p in event.get("people", []) if p.get("id") and p.get("id") != self.wearer_id]

    def _name(self, pid: str, fallback: str | None = None) -> str:
        meta = self.people_meta(pid) or {}
        return fallback or meta.get("name") or pid.replace("-", " ").title()

    def rel_slug(self, pid: str) -> str:
        return f"relationships/{self.wearer_id}--{pid}"

    def _person_stub_page(self, pid: str, name: str) -> str:
        return _page({"type": "person", "title": name, "created_by": "world"},
                     f"# {name}\n\nCreated by WORLD on first in-person encounter with {self.wearer_name}. "
                     f"Relationship: [[{self.rel_slug(pid)}]].\n")

    def _rel(self, pid: str, name: str | None = None) -> RelState:
        st = self.rel.get(pid)
        if st is None:
            st = self.rel[pid] = RelState(pid, self._name(pid, name))
        return st

    async def _ensure_person(self, pid: str, name: str) -> None:
        await self._ensure_page(self.situation.slug, self.situation.page())
        await self._ensure_page(f"people/{pid}", self._person_stub_page(pid, name))
        st = self._rel(pid, name)
        await self._ensure_page(self.rel_slug(pid), st.page(self.wearer_name, self.situation))
        await self._link(self.rel_slug(pid), f"people/{pid}", "about")
        await self._link(f"people/{pid}", self.situation.slug, "seen_at", f"seen by {self.wearer_name}")

    async def _write_rel(self, pid: str) -> None:
        st = self.rel[pid]
        await self._call("put_page", {"slug": self.rel_slug(pid), "content": st.page(self.wearer_name, self.situation)})
        self._known_pages.add(self.rel_slug(pid))

    async def hydrate(self, pid: str) -> RelState | None:
        """Load the relationship page (and person page) from GBrain into memory. Returns None if unreachable."""
        if not self.up:
            return None
        try:
            page = await self._call("get_page", {"slug": self.rel_slug(pid)}, timeout=self.read_timeout_s)
            loaded = RelState.from_page(pid, self._name(pid), page)
            local = self.rel.get(pid)
            if local is not None:  # keep anything learned locally before hydration
                for f in local.facts:
                    loaded.add_fact(f)
                for r in reversed(local.recent):
                    if r not in loaded.recent:
                        loaded.add_recent(r)
                for x in local.you_owe:
                    loaded.add_loop("you_owe", x)
                for x in local.owes_you:
                    loaded.add_loop("owes_you", x)
                loaded.deltas = local.deltas
                loaded.last_topic = local.last_topic or loaded.last_topic
                loaded.summary = local.summary or loaded.summary
                if local.last_seen:
                    if local.prev_seen:
                        loaded.prev_seen, loaded.prev_seen_where = local.prev_seen, local.prev_seen_where
                    else:  # encountered before hydration: the durable last_seen is the previous encounter
                        loaded.prev_seen, loaded.prev_seen_where = loaded.last_seen, loaded.last_seen_where
                    loaded.last_seen, loaded.last_seen_where = local.last_seen, local.last_seen_where
                loaded.encounters += local.encounters
                loaded.reset_at = loaded.reset_at or local.reset_at
            loaded.hydrated = True
            self.rel[pid] = loaded
            self._known_pages.add(self.rel_slug(pid))
            return loaded
        except NotFound:
            st = self._rel(pid)
            st.hydrated = True
            return st
        except Exception as e:  # noqa: BLE001
            self._mark_down(e)
            return None

    async def _person_page(self, pid: str) -> dict[str, Any] | None:
        hit = self._person.get(pid)
        if hit and time.time() - hit[0] < self.person_ttl_s:
            return hit[1]
        if not self.up:
            return hit[1] if hit else None
        try:
            page = await self._call("get_page", {"slug": f"people/{pid}"}, timeout=self.read_timeout_s)
            self._known_pages.add(f"people/{pid}")
        except NotFound:
            page = None
        except Exception as e:  # noqa: BLE001
            self._mark_down(e)
            return hit[1] if hit else None
        self._person[pid] = (time.time(), page)
        try:
            tl = await self._call("get_timeline", {"slug": f"people/{pid}", "limit": 30}, timeout=self.read_timeout_s)
            self._timelines[pid] = (time.time(), tl if isinstance(tl, list) else [])
        except Exception:  # noqa: BLE001
            pass
        return page

    async def warm(self, person_ids: list[str]) -> None:
        await asyncio.gather(*(self._warm_one(pid) for pid in person_ids), return_exceptions=True)

    async def _warm_one(self, pid: str) -> None:
        lock = self._hydrate_locks.setdefault(pid, asyncio.Lock())
        async with lock:  # the card read and the write worker may both hydrate; merge exactly once
            if pid not in self.rel or not self.rel[pid].hydrated:
                await self.hydrate(pid)
        await self._person_page(pid)

    # ---------- emit ----------
    async def emit(self, event: dict[str, Any]) -> None:
        await self.fallback.emit(event)
        t = event.get("type")
        try:
            if t == "person.encountered":
                self._on_encounter(event)
            elif t == "conversation.completed":
                self._on_conversation(event)
            elif t == "relationship.updated":
                self._on_relationship(event)
            elif t in SIGNAL_DIRS:
                self._on_signal(event)
            elif t == "person.enrolled":
                p = event.get("payload", {})
                if p.get("person_id"):
                    pid, name = p["person_id"], p.get("name") or p["person_id"]
                    self._enqueue(lambda: self._ensure_person(pid, name))
        except Exception:  # noqa: BLE001
            log.exception("gbrain mapping failed for %s", t)

    def _on_encounter(self, event: dict[str, Any]) -> None:
        p = event.get("payload", {})
        pid = p.get("person_id")
        if not pid or pid == self.wearer_id:
            return
        now = time.time()
        last = self._last_encounter.get(pid)
        if last is not None and now - last < self.encounter_debounce_s:
            return
        self._last_encounter[pid] = now
        name = self._name(pid, p.get("label"))
        st = self._rel(pid, name)
        st.prev_seen, st.prev_seen_where = st.last_seen, st.last_seen_where
        st.last_seen = datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M")
        st.last_seen_where = self.situation.label
        st.encounters += 1

        async def job() -> None:
            await self._warm_one(pid)  # hydrate before writing so we never clobber the durable page
            await self._ensure_person(pid, name)
            summary = f"Seen by {self.wearer_name} at {self.situation.label}"
            await self._timeline(f"people/{pid}", summary, f"{_hhmm(now)}, match {p.get('match_score', '')}")
            await self._write_rel(pid)

        self._enqueue(job)

    def _on_conversation(self, event: dict[str, Any]) -> None:
        p = event.get("payload", {})
        summary = (p.get("summary") or "").strip()  # never a transcript
        dur = p.get("duration_s")
        for person in self._others(event):
            pid = person["id"]
            name = self._name(pid, person.get("name"))
            st = self._rel(pid, name)
            if summary:
                st.add_recent(f"{_today()}: {summary}")
                st.last_topic = summary[:80]

            async def job(pid=pid, name=name) -> None:
                await self._warm_one(pid)
                await self._ensure_person(pid, name)
                line = f"Talked with {self.wearer_name}: {summary}" if summary else f"Talked with {self.wearer_name}"
                detail = f"{_hhmm()} at {self.situation.label}" + (f", {dur:.0f}s" if isinstance(dur, (int, float)) else "")
                await self._timeline(f"people/{pid}", line, detail)
                await self._timeline(self.rel_slug(pid), line, detail)
                await self._write_rel(pid)

            self._enqueue(job)

    def _on_relationship(self, event: dict[str, Any]) -> None:
        p = event.get("payload", {})
        pid = p.get("person_id") or next((x["id"] for x in self._others(event)), None)
        if not pid:
            return
        name = self._name(pid, next((x.get("name") for x in self._others(event) if x.get("id") == pid), None))
        st = self._rel(pid, name)
        texts = []
        for d in p.get("deltas") or []:
            kind, text = d.get("kind"), (d.get("text") or "").strip()
            if not text:
                continue
            texts.append(text)
            st.deltas.append(text)
            if kind in ("fact", "shared_context", "preference"):
                st.add_fact(text)
            elif kind == "topic":
                st.last_topic = text
            elif kind == "sentiment":
                st.sentiment = text
            elif kind == "open_loop_you_owe":
                st.add_loop("you_owe", text)
            elif kind == "open_loop_owes_you":
                st.add_loop("owes_you", text)
            else:
                st.add_fact(text)
        del st.deltas[:-20]
        if p.get("summary"):
            st.summary = p["summary"]
        if not texts:
            return

        async def job() -> None:
            await self._warm_one(pid)
            await self._ensure_person(pid, name)
            await self._timeline(self.rel_slug(pid), "Learned: " + "; ".join(texts), f"{_hhmm()} live, at {self.situation.label}")
            await self._write_rel(pid)

        self._enqueue(job)

    def _is_wearer(self, who: str | None) -> bool:
        w = (who or "").strip().lower()
        return bool(w) and (w == self.wearer_name.lower() or w == self.wearer_id or w.startswith(self.wearer_id))

    def _on_signal(self, event: dict[str, Any]) -> None:
        t = event["type"]
        p = event.get("payload", {})
        others = self._others(event)
        project = event.get("project") or p.get("product")
        title, body_lines, front = self._signal_content(t, p)
        date = (event.get("ts") or "")[:10] or _today()
        slug = f"{SIGNAL_DIRS[t]}/{date}-{(slugify(title) or 'item')[:60]}"
        front.update({"type": SIGNAL_DIRS[t].rstrip("s") if t != "feature_request.detected" else "feature-request",
                      "title": title, "date": date, "created_by": "world", "event_id": event.get("id"), "event_type": t,
                      "confidence": event.get("confidence"), "situation": self.situation.slug,
                      "people": [x["id"] for x in others] or None, "project": slugify(project) if project else None})
        refs = [f"[[people/{x['id']}]]" for x in others] + ([f"[[projects/{slugify(project)}]]"] if project else []) + [f"[[{self.situation.slug}]]"]
        body = f"# {title}\n\n" + "".join(f"- {x}\n" for x in body_lines if x) + f"\nCaptured in person by WORLD. Related: {', '.join(refs)}\n"
        content = _page(front, body)

        # live relationship state (instant on the card)
        for x in others:
            st = self._rel(x["id"], x.get("name"))
            if t == "commitment.detected":
                st.add_loop("you_owe" if self._is_wearer(p.get("actor")) else "owes_you", p.get("commitment") or title)
            elif t in ("customer_feedback.detected", "feature_request.detected"):
                st.last_topic = " ".join(v for v in (p.get("product"), p.get("feature")) if v) or title
                st.add_recent(f"{date}: {title}")
            elif t == "decision.detected":
                st.add_recent(f"{date}: decided {p.get('decision') or title}")
            elif t == "physical_bug.detected":
                st.add_recent(f"{date}: bug {title}")

        pids = [(x["id"], self._name(x["id"], x.get("name"))) for x in others]
        pslug = f"projects/{slugify(project)}" if project else None

        async def job() -> None:
            await self._call("put_page", {"slug": slug, "content": content})
            self._known_pages.add(slug)
            await self._ensure_page(self.situation.slug, self.situation.page())
            await self._link(slug, self.situation.slug, "happened_at")
            if pslug:
                await self._ensure_page(pslug, _page({"type": "project", "title": project, "created_by": "world"}, f"# {project}\n\nCreated by WORLD from in-person signals.\n"))
                await self._link(slug, pslug, "about")
            for pid, name in pids:
                await self._warm_one(pid)
                await self._ensure_person(pid, name)
                await self._link(slug, f"people/{pid}", "involves")
                await self._timeline(f"people/{pid}", f"{title} ({SIGNAL_DIRS[t]})", f"see [[{slug}]]")
                await self._write_rel(pid)

        self._enqueue(job)

    @staticmethod
    def _signal_content(t: str, p: dict[str, Any]) -> tuple[str, list[str], dict[str, Any]]:
        if t == "commitment.detected":
            title = p.get("commitment") or "Commitment"
            return title, [f"Actor: {p.get('actor')}", f"Recipient: {p.get('recipient')}", f"Due: {p['due']}" if p.get("due") else ""], \
                {"actor": p.get("actor"), "recipient": p.get("recipient"), "due": p.get("due"), "status": "open"}
        if t == "decision.detected":
            title = p.get("decision") or "Decision"
            return title, [f"Constraint: {p['constraint']}" if p.get("constraint") else "", f"Decided by: {', '.join(p.get('decided_by') or [])}"], \
                {"constraint": p.get("constraint")}
        if t == "customer_feedback.detected":
            title = " ".join(x for x in (p.get("product"), p.get("feature"), "feedback") if x)
            return title, [f"Feedback: {p.get('feedback')}", f"Sentiment: {p.get('sentiment')}", f"Buying signal: {p['buying_signal']}" if p.get("buying_signal") else ""], \
                {"product": p.get("product"), "feature": p.get("feature"), "sentiment": p.get("sentiment"), "buying_signal": p.get("buying_signal")}
        if t == "feature_request.detected":
            title = p.get("feature") or p.get("request") or "Feature request"
            acc = [f"Acceptance: {a}" for a in (p.get("acceptance") or []) if a]
            return title, [f"Request: {p.get('request')}", f"Product: {p.get('product')}", f"Requested by: {p.get('requested_by')}", *acc], \
                {"product": p.get("product"), "feature": p.get("feature"), "requested_by": p.get("requested_by")}
        title = " ".join(x for x in (p.get("device"), p.get("symptom")) if x) or "Physical bug"
        return title, [f"Device: {p.get('device')}", f"Symptom: {p.get('symptom')}", f"Repro: {p.get('repro')}" if p.get("repro") else ""], \
            {"device": p.get("device"), "symptom": p.get("symptom")}

    def _seen_before(self, pid: str, st: RelState | None, page: dict[str, Any] | None) -> dict[str, Any] | None:
        """Previous encounter (not the current one): timeline timestamps first, relationship page second."""
        cutoff = self._last_encounter.get(pid, time.time() + 1) - 5
        floor = _parse_ts(st.reset_at) if st and st.reset_at else None
        best: tuple[float, str | None] | None = None
        for e in (self._timelines.get(pid) or (0, []))[1]:
            summ = str(e.get("summary") or "")
            if not summ.lower().startswith("seen by"):
                continue
            ts = _parse_ts(e.get("created_at"))
            if ts is None or ts >= cutoff or (floor is not None and ts < floor):
                continue
            where = summ.split(" at ", 1)[1] if " at " in summ else None
            if best is None or ts > best[0]:
                best = (ts, where)
        if best is None and st and st.prev_seen:
            ts = _parse_ts(st.prev_seen)
            if ts is not None:
                best = (ts, st.prev_seen_where)
        if best is None and page and floor is None:
            earlier = [x for x in parse_timeline(page.get("timeline") or "") if x["summary"].lower().startswith("seen by") and x["date"] < _today()]
            if earlier:
                d = max(earlier, key=lambda x: x["date"])
                best = (_parse_ts(d["date"]) or 0.0, d["summary"].split(" at ", 1)[1] if " at " in d["summary"] else None)
        if best is None:
            return None
        ts, where = best
        return {"when": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M"), "ago": _ago(time.time() - ts), "where": where}

    def known_facts(self, pid: str) -> list[str]:
        st = self.rel.get(pid)
        if st is None:
            return []
        return [*st.facts, *st.deltas, *(f"you owe: {x}" for x in st.you_owe), *(f"owes you: {x}" for x in st.owes_you)]

    # ---------- person card ----------
    async def person_context(self, person_id: str) -> dict[str, Any] | None:
        base = await self.fallback.person_context(person_id) or {}
        if self.up and (person_id not in self.rel or not self.rel[person_id].hydrated):
            try:
                await asyncio.wait_for(self._warm_one(person_id), self.read_timeout_s + 0.5)
            except Exception:  # noqa: BLE001
                pass
        st = self.rel.get(person_id)
        page = await self._person_page(person_id) if self.up else (self._person.get(person_id) or (0, None))[1]
        fm = (page or {}).get("frontmatter") or {}
        subtitle = _clean(fm.get("subtitle")) or " · ".join(x for x in (_clean(fm.get("role")), _clean(fm.get("company"))) if x) or None
        rel_line = (st and st.summary) or _clean(fm.get("relationship"))
        seen = self._seen_before(person_id, st, page)
        ctx = dict(base)
        ctx.update({
            "subtitle": subtitle or base.get("subtitle"),
            "last": (st and (st.last_topic or (st.recent[0].split(": ", 1)[-1] if st.recent else None))) or _clean(fm.get("last_topic")) or base.get("last"),
            "owes_you": (st and st.owes_you[0] if st and st.owes_you else None) or _clean(fm.get("owes_you")) or base.get("owes_you"),
            "you_owe": (st and st.you_owe[0] if st and st.you_owe else None) or _clean(fm.get("you_owe")) or base.get("you_owe"),
            "seen_before": seen,
            "here": self.situation.label,
            "relationship": rel_line,
            "recent_deltas": list(reversed(st.deltas[-3:])) if st else [],
        })
        return ctx


# ---------------- factory ----------------

def make_gbrain_sink(fallback: StubGBrainSink, *, wearer_id: str, wearer_name: str, people_meta: Any = None) -> GBrainIOSink:
    from .gbrain_auth import MCP_URL, TokenProvider, read_env_file

    url = read_env_file().get("GBRAIN_URL") or MCP_URL
    return GBrainIOSink(MCPClient(url, TokenProvider()), fallback, wearer_id=wearer_id, wearer_name=wearer_name,
                        people_meta=people_meta,
                        encounter_debounce_s=float(os.environ.get("GBRAIN_ENCOUNTER_DEBOUNCE", "600")))
