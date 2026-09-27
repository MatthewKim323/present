"""On-camera proof that GBrain is being indexed and compounding.

    uv run python scripts/brain_proof.py snapshot before      # -> data/proof/<ts>-before.json (prints the path)
    ... run a take ...
    uv run python scripts/brain_proof.py snapshot after
    uv run python scripts/brain_proof.py report before after  # -> data/proof/<ts>-report.html (prints the path)

`report` takes snapshot paths or labels (a label resolves to the newest snapshot with it), so a
director script can just call `snapshot before`, `snapshot after`, `report before after`.
Options: --env perception/.env.gbrain  --dir data/proof (or WORLD_PROOF_DIR).

Reads hosted gbrain.io through the service's own MCP client (memory tools only, see gbrain.py):
get_brain_identity, list_pages, get_timeline, get_links. Never writes.
"""
from __future__ import annotations

import argparse
import asyncio
import html
import json
import math
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.config import DATA_DIR  # noqa: E402
from perception.gbrain import MCPClient, NotFound  # noqa: E402
from perception.gbrain_auth import ENV_PATH, MCP_URL, TokenProvider, read_env_file  # noqa: E402

PROOF_DIR = Path(os.environ.get("WORLD_PROOF_DIR", str(DATA_DIR / "proof")))
TIMELINE_PREFIXES = ("relationships/", "people/", "procedures/")
FOCUS_REL = "relationships/stephen-matthew"
CONCURRENCY = 6


# ---------------- snapshot ----------------

async def list_all_pages(mcp) -> list[dict[str, Any]]:
    out, offset = [], 0
    while True:
        rows = await mcp.call("list_pages", {"limit": 100, "offset": offset, "sort": "slug"})
        rows = rows if isinstance(rows, list) else []
        out.extend(rows)
        if len(rows) < 100:
            return out
        offset += 100


async def snapshot(mcp, label: str) -> dict[str, Any]:
    ident = await mcp.call("get_brain_identity", {})
    ident = ident if isinstance(ident, dict) else {}
    pages = [{k: r.get(k) for k in ("slug", "type", "title", "updated_at")} for r in await list_all_pages(mcp)]
    sem = asyncio.Semaphore(CONCURRENCY)

    async def guarded(name: str, args: dict[str, Any]) -> list:
        async with sem:
            try:
                res = await mcp.call(name, args)
            except NotFound:
                return []
        return res if isinstance(res, list) else []

    slugs = [p["slug"] for p in pages if p.get("slug")]
    tl_slugs = [s for s in slugs if s.startswith(TIMELINE_PREFIXES)]
    tls = await asyncio.gather(*(guarded("get_timeline", {"slug": s, "limit": 500}) for s in tl_slugs))
    lks = await asyncio.gather(*(guarded("get_links", {"slug": s}) for s in slugs))
    timelines = {s: [{k: e.get(k) for k in ("id", "date", "source", "summary", "detail", "created_at")} for e in rows]
                 for s, rows in zip(tl_slugs, tls)}
    links, seen = [], set()
    for s, rows in zip(slugs, lks):
        for ln in rows:
            key = (ln.get("from_slug") or s, ln.get("to_slug"), ln.get("link_type") or "")
            if key[1] and key not in seen:
                seen.add(key)
                links.append({"from": key[0], "to": key[1], "type": key[2], "source": ln.get("link_source")})
    return {
        "label": label,
        "taken_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "identity": {"page_count": ident.get("page_count"), "chunk_count": ident.get("chunk_count"), "version": ident.get("version")},
        "pages": pages,
        "timelines": timelines,
        "links": links,
    }


def save_snapshot(snap: dict[str, Any], out_dir: Path = PROOF_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in snap["label"]) or "snap"
    path = out_dir / f"{ts}-{safe}.json"
    path.write_text(json.dumps(snap, indent=2))
    return path


def resolve_snapshot(ref: str, out_dir: Path = PROOF_DIR) -> Path:
    p = Path(ref)
    if p.suffix == ".json" and p.exists():
        return p
    hits = sorted(out_dir.glob(f"*-{ref}.json"))
    if not hits:
        raise SystemExit(f"no snapshot {ref!r} (not a file, no *-{ref}.json in {out_dir})")
    return hits[-1]


# ---------------- diff ----------------

def kind_of(slug: str, typ: str | None = None) -> str:
    head = slug.split("/", 1)[0]
    return {"people": "person", "relationships": "relationship", "events": "event", "projects": "project",
            "procedures": "procedure", "feature-requests": "feature-request", "feedback": "feedback",
            "commitments": "commitment", "decisions": "decision", "bugs": "bug"}.get(head, typ or head)


def counts(snap: dict[str, Any]) -> dict[str, int]:
    ident = snap.get("identity") or {}
    pages = snap.get("pages") or []
    return {
        "pages": ident.get("page_count") if isinstance(ident.get("page_count"), int) else len(pages),
        "chunks": ident.get("chunk_count") or 0,
        "timeline": sum(len(v) for v in (snap.get("timelines") or {}).values()),
        "links": len(snap.get("links") or []),
        "procedures": sum(1 for p in pages if (p.get("slug") or "").startswith("procedures/")),
    }


def _tl_key(e: dict[str, Any]) -> Any:
    return e.get("id") if e.get("id") is not None else (e.get("date"), e.get("summary"), e.get("created_at"))


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    b_pages = {p["slug"]: p for p in before.get("pages") or []}
    a_pages = {p["slug"]: p for p in after.get("pages") or []}
    new = [a_pages[s] for s in a_pages if s not in b_pages]
    updated = [a_pages[s] for s in a_pages if s in b_pages and a_pages[s].get("updated_at") != b_pages[s].get("updated_at")]
    removed = [b_pages[s] for s in b_pages if s not in a_pages]
    new_tl: dict[str, list[dict[str, Any]]] = {}
    for slug, rows in (after.get("timelines") or {}).items():
        old = {_tl_key(e) for e in (before.get("timelines") or {}).get(slug, [])}
        fresh = [e for e in rows if _tl_key(e) not in old]
        if fresh:
            new_tl[slug] = sorted(fresh, key=lambda e: str(e.get("created_at") or ""))
    b_links = {(x["from"], x["to"], x["type"]) for x in before.get("links") or []}
    new_links = [x for x in after.get("links") or [] if (x["from"], x["to"], x["type"]) not in b_links]
    groups: dict[str, list[dict[str, Any]]] = {}
    for p in new + updated:
        groups.setdefault(kind_of(p["slug"], p.get("type")), []).append({**p, "status": "new" if p in new else "updated"})
    return {"before": counts(before), "after": counts(after), "new": new, "updated": updated, "removed": removed,
            "groups": groups, "new_timeline": new_tl, "new_links": new_links}


# ---------------- graph layout (deterministic force layout, no JS) ----------------

KIND_COLOR = {
    "person": "#7cc4ff", "relationship": "#b79cff", "event": "#ffd166", "project": "#6fe3a1",
    "feature-request": "#ff8fc7", "procedure": "#ffab5e", "feedback": "#5ee6d8", "commitment": "#ff7a7a",
    "decision": "#e0e37a", "bug": "#ff6464",
}
KIND_ORDER = ["person", "relationship", "event", "project", "feedback", "commitment", "feature-request",
              "decision", "bug", "procedure"]


def graph_model(after: dict[str, Any], d: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pages = {p["slug"]: p for p in after.get("pages") or []}
    new = {p["slug"] for p in d["new"]}
    upd = {p["slug"] for p in d["updated"]}
    new_links = {(x["from"], x["to"]) for x in d["new_links"]}
    edges: dict[tuple[str, str], dict[str, Any]] = {}
    for x in after.get("links") or []:
        a, b = x["from"], x["to"]
        if a == b or a not in pages or b not in pages:
            continue
        key = tuple(sorted((a, b)))
        e = edges.setdefault(key, {"a": a, "b": b, "types": set(), "new": False})
        if x["type"] and x["type"] != "mentions":
            e["types"].add(x["type"])
        e["new"] = e["new"] or (a, b) in new_links
    deg: dict[str, int] = {}
    for a, b in edges:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    nodes = [{"slug": s, "title": p.get("title") or s.split("/")[-1], "kind": kind_of(s, p.get("type")),
              "status": "new" if s in new else "updated" if s in upd else "same", "deg": deg.get(s, 0)}
             for s, p in pages.items() if deg.get(s) or s in new]
    return nodes, [{**e, "types": sorted(e["types"]) or ["mentions"]} for e in edges.values()]


def layout(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], w: float, h: float, iters: int = 600) -> dict[str, tuple[float, float]]:
    rnd = random.Random(7)
    n = max(1, len(nodes))
    pos: dict[str, list[float]] = {}
    for i, nd in enumerate(sorted(nodes, key=lambda x: (KIND_ORDER.index(x["kind"]) if x["kind"] in KIND_ORDER else 99, x["slug"]))):
        ang = 2 * math.pi * i / n
        pos[nd["slug"]] = [w / 2 + w * 0.3 * math.cos(ang) + rnd.uniform(-5, 5), h / 2 + h * 0.3 * math.sin(ang) + rnd.uniform(-5, 5)]
    k = math.sqrt(w * h / n) * 0.62
    t = w / 8
    for it in range(iters):
        disp = {s: [0.0, 0.0] for s in pos}
        keys = list(pos)
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
                dist = max(1.0, math.hypot(dx, dy))
                f = k * k / dist
                disp[a][0] += dx / dist * f
                disp[a][1] += dy / dist * f
                disp[b][0] -= dx / dist * f
                disp[b][1] -= dy / dist * f
        for e in edges:
            a, b = e["a"], e["b"]
            dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
            dist = max(1.0, math.hypot(dx, dy))
            f = dist * dist / k
            disp[a][0] -= dx / dist * f
            disp[a][1] -= dy / dist * f
            disp[b][0] += dx / dist * f
            disp[b][1] += dy / dist * f
        for s in keys:  # gentle pull to the center keeps orphans on screen
            disp[s][0] += (w / 2 - pos[s][0]) * 0.02 * k / 10
            disp[s][1] += (h / 2 - pos[s][1]) * 0.02 * k / 10
            dl = max(1e-6, math.hypot(*disp[s]))
            pos[s][0] += disp[s][0] / dl * min(dl, t)
            pos[s][1] += disp[s][1] / dl * min(dl, t)
        t = max(1.0, t * 0.992)
    xs, ys = [p[0] for p in pos.values()], [p[1] for p in pos.values()]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    padx, pady = 120, 46
    sx = (w - 2 * padx) / max(1.0, maxx - minx)
    sy = (h - 2 * pady) / max(1.0, maxy - miny)
    return {s: (padx + (p[0] - minx) * sx, pady + (p[1] - miny) * sy) for s, p in pos.items()}


def _short(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def graph_svg(after: dict[str, Any], d: dict[str, Any], w: int = 1060, h: int = 700) -> str:
    nodes, edges = graph_model(after, d)
    if not nodes:
        return f'<svg viewBox="0 0 {w} {h}" class="graph"><text x="{w/2}" y="{h/2}" class="empty">no linked pages yet</text></svg>'
    pos = layout(nodes, edges, w, h)
    out = [f'<svg viewBox="0 0 {w} {h}" class="graph" role="img" aria-label="GBrain knowledge graph">',
           '<defs><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6" result="b"/>'
           '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>']
    for e in edges:
        (x1, y1), (x2, y2) = pos[e["a"]], pos[e["b"]]
        cls = "edge new" if e["new"] else "edge"
        dash = ' stroke-dasharray="3 5"' if e["types"] == ["mentions"] else ""
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" class="{cls}"{dash}/>')
        if e["types"] != ["mentions"]:
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            out.append(f'<text x="{mx:.1f}" y="{my - 4:.1f}" class="elabel{" new" if e["new"] else ""}">{html.escape(" · ".join(e["types"]))}</text>')
    for nd in sorted(nodes, key=lambda x: x["status"] != "same"):
        x, y = pos[nd["slug"]]
        col = KIND_COLOR.get(nd["kind"], "#9aa4b2")
        r = 7 + min(9, nd["deg"] * 1.3)
        if nd["status"] == "new":
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + 7:.1f}" fill="none" stroke="{col}" stroke-width="2" opacity=".85" filter="url(#glow)"/>')
        elif nd["status"] == "updated":
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r + 5:.1f}" fill="none" stroke="{col}" stroke-width="1.5" stroke-dasharray="3 3" opacity=".8"/>')
        op = "1" if nd["status"] != "same" else ".55"
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="{col}" opacity="{op}"/>')
        anchor, dx = ("start", r + 9) if x < w * 0.72 else ("end", -(r + 9))
        tag = ' <tspan class="badge">NEW</tspan>' if nd["status"] == "new" else ""
        out.append(f'<text x="{x + dx:.1f}" y="{y + 4:.1f}" text-anchor="{anchor}" class="nlabel {nd["status"]}">'
                   f'{html.escape(_short(nd["title"], 34))}{tag}</text>')
    out.append("</svg>")
    return "".join(out)


# ---------------- report ----------------

CSS = """
:root{--bg:#0b0d12;--panel:#12151d;--line:#222735;--text:#e8ebf2;--mute:#8a93a6;--dim:#5b6376;--up:#6fe3a1;--accent:#ffab5e}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1880px;margin:0 auto;padding:28px 36px 36px}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px}
h1{margin:0;font-size:30px;letter-spacing:-.02em;font-weight:650}h1 span{color:var(--up)}
.sub{color:var(--mute);margin-top:4px;font-size:14px}.meta{color:var(--dim);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:18px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 18px}
.kpi .k{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.09em}
.kpi .v{display:flex;align-items:baseline;gap:10px;margin-top:6px;font-variant-numeric:tabular-nums}
.kpi .from{color:var(--dim);font-size:22px}.kpi .arrow{color:var(--dim)}.kpi .to{font-size:34px;font-weight:650;letter-spacing:-.02em}
.kpi .d{margin-left:auto;font-size:15px;font-weight:600;color:var(--up);background:rgba(111,227,161,.1);border-radius:999px;padding:2px 10px}
.kpi .d.zero{color:var(--dim);background:transparent}
.main{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:18px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 20px}
.panel h2{margin:0 0 10px;font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.09em;font-weight:600}
.graph{width:100%;height:auto;display:block}
.edge{stroke:#394155;stroke-width:1.2}.edge.new{stroke:var(--up);stroke-width:2;opacity:.9}
.elabel{fill:#5b6376;font:10.5px ui-monospace,Menlo,monospace;text-anchor:middle;paint-order:stroke;stroke:var(--panel);stroke-width:4px}.elabel.new{fill:#8fe9b8}
.nlabel{fill:#aab2c2;font-size:13.5px;paint-order:stroke;stroke:var(--panel);stroke-width:5px;stroke-linejoin:round}.nlabel.new{fill:#fff;font-weight:600}.nlabel.updated{fill:#dfe4ee}.nlabel.same{fill:#6d7588}
.badge{fill:var(--up);font-size:10px;font-weight:700;letter-spacing:.08em}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:6px;color:var(--mute);font-size:12px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.side{display:flex;flex-direction:column;gap:18px;min-width:0}
table{width:100%;border-collapse:collapse;font-size:13.5px}
td{padding:5px 0;border-top:1px solid var(--line);vertical-align:top}
table{table-layout:fixed}td{padding:8px 0}td.kind{width:150px;text-transform:uppercase;font-size:11px;letter-spacing:.08em;padding-top:11px}
.pg{padding:2px 0 4px;min-width:0}.pg .tt{display:flex;align-items:center;min-width:0}.pg .tt b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg code{display:block;color:var(--dim);font:12px ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.pill{flex:none;font-size:10.5px;font-weight:700;letter-spacing:.07em;border-radius:999px;padding:1px 8px;margin-right:8px}
.pill.new{color:#0b0d12;background:var(--up)}.pill.updated{color:var(--accent);border:1px solid rgba(255,171,94,.5)}
.tl{list-style:none;margin:0;padding:0}.tl li{padding:7px 0;border-top:1px solid var(--line)}
.tl .s{font-size:14px}.tl .t{color:var(--dim);font:11.5px ui-monospace,Menlo,monospace;margin-top:2px}
.more,.empty{color:var(--dim);font-size:12.5px;padding-top:6px}text.empty{fill:#5b6376;text-anchor:middle}
"""

LABELS = [("pages", "Pages"), ("chunks", "Indexed chunks"), ("timeline", "Timeline entries"), ("links", "Graph links"), ("procedures", "Procedures")]


def _fmt_ts(s: str | None) -> str:
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
    except ValueError:
        return s


def _tl_meta(e: dict[str, Any]) -> str:
    when, detail = _fmt_ts(e.get("created_at")), (e.get("detail") or "").strip()
    if detail and when and detail.startswith(when[:5]):
        detail = detail[5:].lstrip(" ,")
    return " · ".join(x for x in (f"written {when}" if when else "", detail) if x)


def _local(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%b %d %H:%M:%S")
    except ValueError:
        return iso


def render_report(before: dict[str, Any], after: dict[str, Any], focus: str = FOCUS_REL, max_rows: int = 8) -> str:
    d = diff(before, after)
    kpis = []
    for key, name in LABELS:
        a, b = d["before"][key], d["after"][key]
        delta = b - a
        dcls = "d" if delta else "d zero"
        dtxt = f"+{delta}" if delta > 0 else str(delta) if delta else "±0"
        kpis.append(f'<div class="kpi"><div class="k">{name}</div><div class="v"><span class="from">{a}</span>'
                    f'<span class="arrow">→</span><span class="to">{b}</span><span class="{dcls}">{dtxt}</span></div></div>')
    rows = []
    for kind in sorted(d["groups"], key=lambda k: KIND_ORDER.index(k) if k in KIND_ORDER else 99):
        items = sorted(d["groups"][kind], key=lambda p: (p["status"] != "new", p["slug"]))
        cells = "".join(f'<div class="pg"><div class="tt"><span class="pill {p["status"]}">{p["status"].upper()}</span><b>{html.escape(p.get("title") or "")}</b></div>'
                        f'<code>{html.escape(p["slug"])}</code></div>' for p in items[:max_rows])
        if len(items) > max_rows:
            cells += f'<div class="more">+{len(items) - max_rows} more</div>'
        rows.append(f'<tr><td class="kind" style="color:{KIND_COLOR.get(kind, "#9aa4b2")}">{html.escape(kind)}</td><td>{cells}</td></tr>')
    table = f"<table>{''.join(rows)}</table>" if rows else '<div class="empty">no new or updated pages</div>'
    fl = d["new_timeline"].get(focus, [])
    tl = "".join(f'<li><div class="s">{html.escape(e.get("summary") or "")}</div>'
                 f'<div class="t">{html.escape(_tl_meta(e))}</div></li>' for e in fl[-max_rows:])
    if len(fl) > max_rows:
        tl = f'<li class="more">{len(fl) - max_rows} earlier lines not shown</li>' + tl
    tl_html = f'<ul class="tl">{tl}</ul>' if fl else '<div class="empty">no new timeline lines on this page</div>'
    legend = "".join(f'<span><i style="background:{KIND_COLOR[k]}"></i>{k}</span>' for k in KIND_ORDER)
    legend += '<span style="margin-left:auto">glow = new · dashed ring = updated · green edge = new link · dotted = markdown mention</span>'
    total_new = len(d["new"])
    title = f"GBrain grew by <span>{total_new} page{'s' if total_new != 1 else ''}</span> and {d['after']['timeline'] - d['before']['timeline']} memories this take"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GBrain Proof</title><style>{CSS}</style></head><body><div class="wrap">
<header><div><h1>{title}</h1><div class="sub">Live read of the hosted gbrain.io workspace WORLD writes to: before vs after one in-person conversation.</div></div>
<div class="meta">{html.escape(before.get("label", ""))} · {html.escape(_local(before.get("taken_at")))}<br>{html.escape(after.get("label", ""))} · {html.escape(_local(after.get("taken_at")))}<br>gbrain {html.escape(str((after.get("identity") or {}).get("version") or ""))}</div></header>
<div class="kpis">{''.join(kpis)}</div>
<div class="main"><div class="panel"><h2>Knowledge graph</h2>{graph_svg(after, d)}<div class="legend">{legend}</div></div>
<div class="side"><div class="panel"><h2>New timeline on {html.escape(focus)}</h2>{tl_html}</div>
<div class="panel"><h2>New and updated pages</h2>{table}</div></div></div>
</div></body></html>"""


def write_report(before_path: Path, after_path: Path, out_dir: Path = PROOF_DIR) -> Path:
    before, after = json.loads(before_path.read_text()), json.loads(after_path.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-report.html"
    path.write_text(render_report(before, after))
    return path


# ---------------- CLI ----------------

def make_client(env: Path) -> MCPClient:
    return MCPClient(read_env_file(env).get("GBRAIN_URL") or MCP_URL, TokenProvider(env), timeout=30.0)


async def take_snapshot(label: str, env: Path = ENV_PATH, out_dir: Path = PROOF_DIR) -> Path:
    mcp = make_client(env)
    try:
        snap = await snapshot(mcp, label)
    finally:
        await mcp.close()
    return save_snapshot(snap, out_dir)


def main() -> None:
    ap = argparse.ArgumentParser(description="GBrain before/after proof")
    ap.add_argument("--env", default=str(ENV_PATH), help="path to .env.gbrain")
    ap.add_argument("--dir", default=str(PROOF_DIR), help="where snapshots and reports go")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("label")
    r = sub.add_parser("report")
    r.add_argument("before", help="snapshot path or label")
    r.add_argument("after", help="snapshot path or label")
    a = ap.parse_args()
    out_dir = Path(a.dir)
    if a.cmd == "snapshot":
        path = asyncio.run(take_snapshot(a.label, Path(a.env), out_dir))
        c = counts(json.loads(path.read_text()))
        print(" ".join(f"{k}={v}" for k, v in c.items()), file=sys.stderr)
        print(path)
    else:
        print(write_report(resolve_snapshot(a.before, out_dir), resolve_snapshot(a.after, out_dir), out_dir))


if __name__ == "__main__":
    main()
