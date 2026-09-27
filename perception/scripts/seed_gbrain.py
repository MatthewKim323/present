"""Upsert the demo seed pages (repo seed/**.md) into hosted gbrain.io. Idempotent.

    uv run python scripts/seed_gbrain.py            # upsert seeds
    uv run python scripts/seed_gbrain.py --reset    # delete WORLD-created demo pages, then upsert seeds
    uv run python scripts/seed_gbrain.py --dry-run  # show what would happen

Slug = path under seed/ without .md (seed/people/matthew.md -> people/matthew).
--reset soft-deletes every page whose frontmatter has created_by: world or seed: world-demo (signal pages,
auto-created people/projects, relationship pages, Memorable procedures/), then re-puts the seeds, so every
take starts identical. --reset --dry-run lists what would be deleted and what is kept, with counts.
Timeline rows cannot be deleted through MCP, so --reset stamps reset_at on relationship seeds and
the sink ignores older "seen by" rows for seen_before. Pages without created_by: world
or seed: world-demo (e.g. the workspace member page) are never touched, whatever their prefix.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from perception.gbrain import MCPClient, NotFound  # noqa: E402
from perception.gbrain_auth import ENV_PATH, MCP_URL, TokenProvider, read_env_file  # noqa: E402

SEED_DIR = Path(__file__).resolve().parents[2] / "seed"
DEMO_PREFIXES = ("feedback/", "commitments/", "decisions/", "feature-requests/", "bugs/", "relationships/", "people/",
                 "projects/", "events/", "procedures/")


def world_owned(frontmatter: dict | None) -> bool:
    """The one reset safety rule: only pages WORLD wrote (created_by: world) or seeded (seed: world-demo)."""
    fm = frontmatter or {}
    return fm.get("created_by") == "world" or fm.get("seed") == "world-demo"


def load_seeds(seed_dir: Path = SEED_DIR) -> dict[str, str]:
    return {str(p.relative_to(seed_dir).with_suffix("")): p.read_text() for p in sorted(seed_dir.rglob("*.md"))}


def stamp_reset(content: str, iso: str) -> str:
    head, sep, rest = content.partition("\n---\n")
    if not content.startswith("---\n") or not sep:
        return content
    lines = [x for x in head.splitlines() if not x.startswith("reset_at:")]
    return "\n".join(lines) + f'\nreset_at: "{iso}"' + sep + rest


async def list_all(mcp) -> list[dict]:
    out, offset = [], 0
    while True:
        rows = await mcp.call("list_pages", {"limit": 100, "offset": offset, "sort": "slug"})
        rows = rows if isinstance(rows, list) else []
        out.extend(rows)
        if len(rows) < 100:
            return out
        offset += 100


async def plan_reset(mcp) -> tuple[list[str], list[str]]:
    """(delete, keep): every listed page lands in exactly one. Nothing is deleted here."""
    delete, keep = [], []
    for row in await list_all(mcp):
        slug = row.get("slug") or ""
        if not slug.startswith(DEMO_PREFIXES):
            keep.append(slug)
            continue
        try:
            page = await mcp.call("get_page", {"slug": slug})
        except NotFound:
            continue
        (delete if world_owned(page.get("frontmatter") if isinstance(page, dict) else None) else keep).append(slug)
    return delete, keep


async def reset(mcp, dry: bool) -> list[str]:
    delete, keep = await plan_reset(mcp)
    by_dir: dict[str, int] = {}
    for slug in delete:
        by_dir[slug.split("/", 1)[0]] = by_dir.get(slug.split("/", 1)[0], 0) + 1
        print(f"  {'would delete' if dry else 'delete'} {slug}")
        if not dry:
            await mcp.call("delete_page", {"slug": slug})
    for slug in keep:
        print(f"  keep {slug} (not WORLD-owned)")
    print(f"{'would delete' if dry else 'deleted'} {len(delete)} WORLD pages "
          f"({', '.join(f'{k}: {v}' for k, v in sorted(by_dir.items())) or 'none'}), kept {len(keep)}")
    return delete


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--env", default=str(ENV_PATH), help="path to .env.gbrain")
    a = ap.parse_args()
    env = Path(a.env)
    mcp = MCPClient(read_env_file(env).get("GBRAIN_URL") or MCP_URL, TokenProvider(env))
    seeds = load_seeds()
    if a.reset:
        await reset(mcp, a.dry_run)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for slug, content in seeds.items():
        if a.reset and slug.startswith("relationships/"):
            content = stamp_reset(content, now)
        print(("would put " if a.dry_run else "put ") + slug)
        if not a.dry_run:
            await mcp.call("put_page", {"slug": slug, "content": content})
    await mcp.close()


if __name__ == "__main__":
    asyncio.run(main())
