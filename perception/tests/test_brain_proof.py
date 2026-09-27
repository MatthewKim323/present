"""brain_proof snapshots/diff/report and the seed_gbrain reset safety rule, against a fake MCP (no network)."""
import importlib.util
from pathlib import Path

from test_gbrain import FakeMCP, make_sink

from perception import demo_inject
from perception.gbrain import NotFound

SCRIPTS = Path(__file__).parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


seed = load("seed_gbrain")
proof = load("brain_proof")


class BrainMCP(FakeMCP):
    """FakeMCP plus the read/list/delete tools the proof and reset scripts use."""

    def __init__(self):
        super().__init__()
        self.tick = 0
        self.updated: dict[str, str] = {}
        self.deleted: list[str] = []

    async def call(self, name, args):
        if name == "put_page":
            self.tick += 1
            self.updated[args["slug"]] = f"2026-09-27T21:00:{self.tick:02d}.000Z"
        if name in ("get_page", "put_page", "add_timeline_entry", "add_link", "get_timeline"):
            return await super().call(name, args)
        self.calls.append((name, args))
        if name == "get_brain_identity":
            return {"version": "0.48.0.0", "page_count": len(self.pages), "chunk_count": 2 * len(self.pages)}
        if name == "list_pages":
            rows = [{"slug": s, "type": s.split("/")[0], "title": s.split("/")[-1], "updated_at": self.updated.get(s)}
                    for s in sorted(self.pages)]
            return rows[args.get("offset", 0): args.get("offset", 0) + args["limit"]]
        if name == "get_links":
            return [{"from_slug": a, "to_slug": b, "link_type": t, "link_source": "world"} for a, b, t in sorted(self.links) if a == args["slug"]]
        if name == "delete_page":
            if args["slug"] not in self.pages:
                raise NotFound(args["slug"])
            del self.pages[args["slug"]]
            self.deleted.append(args["slug"])
            return {"status": "deleted"}
        raise AssertionError(f"unexpected tool {name}")


def page(**front):
    head = "".join(f'{k}: "{v}"\n' for k, v in front.items())
    return f"---\n{head}---\n\n# page\n"


# ---------------- reset safety ----------------

def seeded_workspace() -> BrainMCP:
    m = BrainMCP()
    m.pages.update({
        "procedures/execute-test-for-spec-md-existence": page(type="procedure", created_by="world", source="memorable"),
        "procedures/human-written-runbook": page(type="procedure", title="mine"),
        "feature-requests/2026-09-27-add-recap-command": page(type="feature-request", created_by="world"),
        "people/matthew-kim": page(type="person", title="Matthew Kim"),  # workspace member page
        "people/stephen": page(type="person", seed="world-demo"),
        "people/someone-else": page(type="person", created_by="alice"),
        "notes/world-scratch": page(type="note", created_by="world"),  # outside demo prefixes
    })
    return m


async def test_reset_dry_run_deletes_nothing_and_lists_only_world_pages(capsys):
    m = seeded_workspace()
    before = dict(m.pages)
    gone = await seed.reset(m, dry=True)
    assert sorted(gone) == ["feature-requests/2026-09-27-add-recap-command", "people/stephen",
                            "procedures/execute-test-for-spec-md-existence"]
    assert m.pages == before and not m.deleted
    out = capsys.readouterr().out
    assert "would delete 3 WORLD pages" in out and "kept 4" in out and "keep people/matthew-kim" in out


async def test_reset_never_deletes_pages_without_world_ownership():
    m = seeded_workspace()
    await seed.reset(m, dry=False)
    assert set(m.deleted) == {"feature-requests/2026-09-27-add-recap-command", "people/stephen",
                              "procedures/execute-test-for-spec-md-existence"}
    assert {"procedures/human-written-runbook", "people/matthew-kim", "people/someone-else", "notes/world-scratch"} <= set(m.pages)
    for slug in m.deleted:
        assert slug.startswith(seed.DEMO_PREFIXES)


def test_world_owned_rule():
    assert seed.world_owned({"created_by": "world"}) and seed.world_owned({"seed": "world-demo"})
    assert not seed.world_owned({}) and not seed.world_owned(None) and not seed.world_owned({"created_by": "World "})
    assert not seed.world_owned({"source": "memorable"})  # memorable alone is not enough, WORLD must have written it


# ---------------- snapshot + diff + report ----------------

async def test_snapshot_diff_shows_the_take_compounding(tmp_path):
    sink, m = make_sink(BrainMCP())
    m.pages["people/matthew"] = page(type="person", title="Matthew", seed="world-demo")
    m.updated["people/matthew"] = "2026-09-27T20:00:00.000Z"
    before = await proof.snapshot(m, "before")
    for ev in demo_inject.feedback_events():
        await sink.emit(ev)
    await sink.flush()
    after = await proof.snapshot(m, "after")

    d = proof.diff(before, after)
    assert d["after"]["pages"] > d["before"]["pages"]
    assert d["after"]["timeline"] > d["before"]["timeline"] and d["after"]["links"] > d["before"]["links"]
    new = {p["slug"] for p in d["new"]}
    assert "relationships/stephen-matthew" in new and any(s.startswith("feedback/") for s in new)
    assert any(s.startswith("commitments/") for s in new)
    rel_lines = [e["summary"] for e in d["new_timeline"]["relationships/stephen-matthew"]]
    assert any(x.startswith("Talked with Stephen") for x in rel_lines)
    assert not d["removed"]

    # a second identical snapshot diffs to nothing
    d0 = proof.diff(after, after)
    assert not d0["new"] and not d0["updated"] and not d0["new_timeline"] and not d0["new_links"]

    p_before = proof.save_snapshot(before, tmp_path)
    p_after = proof.save_snapshot(after, tmp_path)
    assert proof.resolve_snapshot("after", tmp_path) == p_after
    out = proof.write_report(p_before, p_after, tmp_path)
    html = out.read_text()
    assert "<svg" in html and "Talked with Stephen" in html and "relationships/stephen-matthew" in html
    assert "cdn" not in html.lower()  # self-contained, screenshots work offline
    assert "—" not in html  # house rule


async def test_snapshot_pages_through_list_pages():
    m = BrainMCP()
    for i in range(230):
        m.pages[f"feedback/x-{i:03d}"] = page(type="feedback", created_by="world")
    snap = await proof.snapshot(m, "big")
    assert len(snap["pages"]) == 230
    assert sum(1 for n, _ in m.calls if n == "list_pages") == 3
