# Session handoff (2026-09-27, ~2pm PT)

Read CLAUDE.md, contracts/EVENTS.md, docs/SPONSORS.md, docs/QM.md first.

## State

| Piece | Where | Status |
|---|---|---|
| Event contract v0 | `contracts/EVENTS.md` | done, binding for all components |
| Perception / world service (:8787) | `perception/` | DONE, 24 tests pass. Faces (YuNet+SFace, ~20ms/frame), whisper ASR verified live, HUD fanout verified. Claude extraction only mock-tested (needs ANTHROPIC_API_KEY, then `demo_inject --via-llm`). GBrain sink is a STUB (`sinks.py` StubGBrainSink, writes data/events.jsonl) -> replace with gbrain.io. QM sink posts to `$QM_URL/world-events`. Extras: `POST /hud` (QM pushes agent_activity), `/ws/quest?debug=1` tracks. matthew enrolled from 5 photos (5/5 self-match). Run: `uv run python -m perception`, sim: `python -m perception.sim`. See `perception/README.md` |
| Quest client | `quest/` | DONE (untested on real headset). WebXR immersive-ar + getUserMedia camera (UNVERIFIED on 3S: whether passthrough cams show up and keep streaming during XR; in-headset status strip tells you in ~10s). Fallback `?video=0`: laptop/phone is the eye, headset does HUD+mic. Needs Horizon OS v76+, dev mode, `npm run adb:reverse`. WebXR raw camera access NOT available. See `quest/README.md` |
| QM fork | `~/dev/qm`, branch `worldhooks`, fork of yc-software/qm | `POST /world-events` ingress added + sample customer feedback event. See `docs/QM.md` |
| Sponsor research | `docs/SPONSORS.md` | done. Memorable = QM memory provider `type: "memorable"` in `MEMORY_PROVIDER_CONFIG`, no LLM key needed |
| Enrollment photos | `perception/data/enroll/matthew/` (5 jpgs, gitignored) | need 8-15 pics each of the in-front-of-headset people (Alex actor, customer #2 actor) |

## GBrain decision

- **Use hosted gbrain.io** via MCP `gbrain-io` (project-scoped in `.mcp.json`). matt must `/mcp` -> gbrain-io -> OAuth.
- **NEVER touch matt's personal brain** (MCP `gbrain`, localhost:3131, Postgres at /Volumes/Vault/gbrain-pgdata, `~/.gbrain`, global `gbrain` binary 0.32.5). It has 8.4k private DMs. Do not run the global `gbrain` CLI at all: at 1:51-1:54pm an agent invocation of it auto-applied pending schema migrations (v0.11 -> v0.18.1) to the personal DB. Data verified intact (11,506 pages, healthy), but no more.
- Local demo brain (`~/dev/gbrain-demo`, partially cloned) is **abandoned**. Seed data for hosted still needs writing: Alex (Acme founder, Syla prospect, open loop: trial access), Syla project, 3 prior Canvas onboarding complaints (sarah/email, david/support, priya/discord). Put seeds in `seed/*.md` + a reset script so every take starts identical.

## Blockers on matt

1. ~~`MEMORABLE_API_KEY`~~ DONE via device flow, lives in `.env.memorable` (gitignored). `set -a; . ./.env.memorable; set +a` to load.
2. gbrain.io OAuth via `/mcp`.
3. ~~`ANTHROPIC_API_KEY`~~ DONE in `perception/.env` (auto-loaded). Real extraction verified on Alex scenario: correct customer_feedback + commitment + summary, but 9.4s latency on claude-sonnet-5, consider haiku for stage. OpenAI key is in `~/.zshrc`.
4. Quest in dev mode, USB-C, Horizon OS version.
5. Approve `memorable enable --scope <worldhook scope>` (human consent required).
6. Booth asks: GBrain (self-hosted ok? credits), Memorable (credits, ORG_ID still needed?), QM (which scope for event-triggered swarm).

## Next up

1. Wire perception QM sink -> `~/dev/qm` `/world-events`, end to end with `demo_inject.py`.
2. GBrain sink -> gbrain.io (person pages, timeline entries, HUD person-card query).
3. Enable Memorable on the WorldHook scope. Run 1 must include a write step (traces that only read are refused). Measure run 1 vs run 2 (turns, tool calls, corrections, time). Real numbers only.
4. Get Quest camera frames flowing (see quest/README.md fallback if direct camera access blocks).
5. Don't run `memorable install-hooks` (edits global ~/.claude settings) or `memorable init gbrain`.

## Rules

Commit + push small and often, no AI attribution in commits, no em dashes, long commands in background.
