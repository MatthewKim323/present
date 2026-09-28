"""GBrain observability + read proxy.

GBrainOpFeed: every GBrain call (perception writes, the live pass, person-card reads, QM worker reads)
becomes a `gbrain_op` HUD message so the wearer can watch retrieval happen. Slugs, titles and short
queries only, never page bodies. Coalesced and rate-limited (~5/s) so the headset never floods.

add_gbrain_routes: read-only GBrain for QM swarm workers. The world service holds the gbrain.io OAuth
token; workers call these with the WorldHooks bearer (WORLD_HOOKS_SECRET) from their QM computer:

  POST /gbrain/query        {q, actor, event_id?}  -> {results: [{slug, title, snippet}]}
  GET  /gbrain/page/{slug}  ?actor=&event_id=      -> {slug, title, frontmatter, compiled_truth, timeline} (capped)
  GET  /gbrain/person/{id}  ?actor=&event_id=      -> the HUD person card context + facts / open loops

Only memory tools are ever reached (gbrain.ALLOWED_TOOLS); writes are not exposed here.
"""
from __future__ import annotations

import asyncio
import contextvars
import hmac
import os
import re
import time
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, Header, HTTPException

OPS = ("query", "search", "get_page", "put_page", "add_timeline_entry", "add_link")
READS = ("query", "search", "get_page")
SNIP = 80
MAX_HITS = 5

# (actor, event_id) for the GBrain call in flight. Jobs set it when they run (see GBrainIOSink._enqueue).
ACTOR: contextvars.ContextVar[tuple[str, str | None]] = contextvars.ContextVar("gbrain_actor", default=("perception", None))


def short(v: Any, n: int = SNIP) -> str | None:
    if v is None:
        return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    if not s:
        return None
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def result_items(res: Any) -> list[dict[str, Any]]:
    """query/search results in whatever shape gbrain.io returns -> list of dicts."""
    if isinstance(res, dict):
        for k in ("results", "pages", "hits", "items", "data"):
            if isinstance(res.get(k), list):
                res = res[k]
                break
        else:
            return []
    return [x for x in res if isinstance(x, dict)] if isinstance(res, list) else []


def normalize_hits(res: Any, limit: int = 8, snippet: int = 200) -> list[dict[str, Any]]:
    """Dedupe by slug; {slug, title, snippet} with a short snippet (never the whole page)."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in result_items(res):
        page = it.get("page") if isinstance(it.get("page"), dict) else {}
        slug = it.get("slug") or it.get("page_slug") or page.get("slug")
        if not slug or slug in seen:
            continue
        seen.add(slug)
        title = it.get("title") or it.get("page_title") or page.get("title") or slug.rsplit("/", 1)[-1]
        snip = it.get("chunk_text") or it.get("snippet") or it.get("text") or it.get("content") or ""
        out.append({"slug": slug, "title": short(title, 80), "snippet": short(snip, snippet)})
        if len(out) >= limit:
            break
    return out


def person_of(slug: str | None, wearer_id: str) -> str | None:
    if not slug:
        return None
    if slug.startswith("people/"):
        return slug.split("/", 1)[1] or None
    pre = f"relationships/{wearer_id}-"
    if slug.startswith(pre):
        return slug[len(pre):] or None
    return None


def op_message(name: str, args: dict[str, Any], res: Any, ms: float, ok: bool, *, actor: str,
               event_id: str | None = None, wearer_id: str = "stephen", miss: bool = False) -> dict[str, Any]:
    slug = args.get("slug") or args.get("from")
    msg: dict[str, Any] = {"kind": "gbrain_op", "op": name, "actor": actor, "ms": round(ms), "ok": ok}
    if slug:
        msg["slug"] = short(slug, SNIP)
    if name == "add_link" and args.get("to"):
        msg["to"] = short(args["to"], SNIP)
    if name in ("query", "search") and args.get("query"):
        msg["query"] = short(args["query"], SNIP)
    if name in ("query", "search") and ok:
        hits = normalize_hits(res, MAX_HITS)
        msg["hits"] = [{"slug": h["slug"], "title": h["title"]} for h in hits]
    elif name == "get_page" and ok and not miss and isinstance(res, dict):
        title = res.get("title") or (res.get("frontmatter") or {}).get("title")
        if title:
            msg["title"] = short(title, SNIP)
    if miss:
        msg["miss"] = True
    pid = person_of(slug, wearer_id) or person_of(args.get("to"), wearer_id)
    if pid:
        msg["person_id"] = pid
    if event_id:
        msg["event_id"] = event_id
    return msg


def _key(m: dict[str, Any]) -> tuple:
    return (m.get("op"), m.get("actor"), m.get("slug"), m.get("query"), m.get("to"))


class GBrainOpFeed:
    """Coalescing, rate-limited gbrain_op broadcaster. publish() never blocks the GBrain call path."""

    def __init__(self, broadcast: Callable[[dict[str, Any]], Awaitable[None]], *, rate: float = 5.0,
                 burst: int = 5, max_backlog: int = 24, clock: Callable[[], float] = time.monotonic) -> None:
        self.broadcast = broadcast
        self.rate = rate
        self.burst = burst
        self.max_backlog = max_backlog
        self.clock = clock
        self.tokens = float(burst)
        self.last = clock()
        self.pending: list[dict[str, Any]] = []
        self.sent = 0
        self.dropped = 0
        self._task: asyncio.Task | None = None

    def publish(self, msg: dict[str, Any]) -> None:
        for p in reversed(self.pending):  # same op on the same thing still queued: fold it in
            if _key(p) == _key(msg):
                p["count"] = p.get("count", 1) + 1
                p["ms"], p["ok"] = msg["ms"], p["ok"] and msg["ok"]
                if msg.get("hits") is not None:
                    p["hits"] = msg["hits"]
                return
        self.pending.append(msg)
        while len(self.pending) > self.max_backlog:  # shed perception chatter first, keep QM reads
            i = next((i for i, p in enumerate(self.pending) if not str(p.get("actor", "")).startswith("qm:")), 0)
            self.pending.pop(i)
            self.dropped += 1
        self._kick()

    def _kick(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            self._task = asyncio.get_running_loop().create_task(self._loop())
        except RuntimeError:
            pass  # no loop (sync tests): drain() is called by hand

    def _refill(self) -> None:
        now = self.clock()
        self.tokens = min(float(self.burst), self.tokens + (now - self.last) * self.rate)
        self.last = now

    async def drain(self) -> int:
        """Send what the rate allows right now. Returns how many went out."""
        self._refill()
        n = 0
        while self.pending and self.tokens >= 1.0:
            msg = self.pending.pop(0)
            self.tokens -= 1.0
            try:
                await self.broadcast(msg)
            except Exception:  # noqa: BLE001
                pass
            self.sent += 1
            n += 1
        return n

    async def _loop(self) -> None:
        while self.pending:
            await self.drain()
            if self.pending:
                await asyncio.sleep(1.0 / self.rate)


# ---------------- read proxy for QM workers ----------------

PAGE_CAP = 4000
TIMELINE_CAP = 1500
ACTOR_RE = re.compile(r"^[A-Za-z0-9:_.\- ]{1,40}$")


def _actor(v: str | None) -> str:
    a = (v or "").strip() or "qm"
    if not ACTOR_RE.match(a):
        raise HTTPException(422, "bad actor")
    return a if a.startswith("qm") else f"qm:{a}"


def check_bearer(authorization: str | None) -> None:
    """These endpoints are read-only, so they also take GBRAIN_PROXY_TOKEN: the token QM hands its sandboxes,
    which (unlike WORLD_HOOKS_SECRET) can't post world events."""
    secrets = [s for s in (os.environ.get("GBRAIN_PROXY_TOKEN", ""), os.environ.get("WORLD_HOOKS_SECRET", "")) if len(s) >= 16]
    if not secrets:
        raise HTTPException(503, "GBRAIN_PROXY_TOKEN / WORLD_HOOKS_SECRET not configured")
    got = (authorization or "").removeprefix("Bearer ").removeprefix("bearer ").strip()
    if not got or not any(hmac.compare_digest(got.encode(), s.encode()) for s in secrets):
        raise HTTPException(401, "bad bearer")


def _cap(v: Any, n: int) -> Any:
    if isinstance(v, str) and len(v) > n:
        return v[:n] + "\n…[truncated]"
    return v


def add_gbrain_routes(app: FastAPI, get_sink: Callable[[], Any]) -> None:
    def io_sink():
        s = get_sink()
        if not hasattr(s, "read_query") or not getattr(s, "up", False):
            raise HTTPException(503, "gbrain.io unavailable")
        return s

    @app.post("/gbrain/query")
    async def gbrain_query(body: dict[str, Any], authorization: str | None = Header(default=None)):
        check_bearer(authorization)
        q = str(body.get("q") or body.get("query") or "").strip()
        if not q:
            raise HTTPException(422, "q required")
        who = _actor(body.get("actor"))
        s = io_sink()
        try:
            hits = await s.read_query(q[:300], actor=who, event_id=body.get("event_id"),
                                      limit=min(int(body.get("limit") or 8), 15))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"gbrain query failed: {str(e)[:120]}") from e
        return {"q": q, "results": hits}

    @app.get("/gbrain/page/{slug:path}")
    async def gbrain_page(slug: str, actor: str | None = None, event_id: str | None = None,
                          authorization: str | None = Header(default=None)):
        check_bearer(authorization)
        who = _actor(actor)
        s = io_sink()
        from .gbrain import NotFound

        try:
            page = await s.read_page(slug, actor=who, event_id=event_id)
        except NotFound as e:
            raise HTTPException(404, f"no page {slug}") from e
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"gbrain get_page failed: {str(e)[:120]}") from e
        fm = page.get("frontmatter") or {}
        return {"slug": page.get("slug") or slug, "title": page.get("title") or fm.get("title"), "frontmatter": fm,
                "compiled_truth": _cap(page.get("compiled_truth") or "", PAGE_CAP),
                "timeline": _cap(page.get("timeline") or "", TIMELINE_CAP)}

    @app.get("/gbrain/person/{person_id}")
    async def gbrain_person(person_id: str, actor: str | None = None, event_id: str | None = None,
                            authorization: str | None = Header(default=None)):
        check_bearer(authorization)
        if not re.match(r"^[a-z0-9][a-z0-9\-]{0,40}$", person_id):
            raise HTTPException(422, "bad person id")
        s = get_sink()
        if hasattr(s, "read_person"):
            return await s.read_person(person_id, actor=_actor(actor), event_id=event_id)
        ctx = await s.person_context(person_id) or {}  # stub backend: this run's events only
        return {"person_id": person_id, "backend": "stub", **ctx}
