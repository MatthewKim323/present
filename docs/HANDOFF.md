# Session handoff (2026-09-27, ~2pm PT)

Read CLAUDE.md, contracts/EVENTS.md, docs/SPONSORS.md, docs/QM.md first.

## State

| Piece | Where | Status |
|---|---|---|
| Event contract v0 | `contracts/EVENTS.md` | done, binding for all components |
| Perception / world service (:8787) | `perception/` | DONE, 24 tests pass. Faces (YuNet+SFace, ~20ms/frame), whisper ASR verified live, HUD fanout verified. Claude extraction only mock-tested (needs ANTHROPIC_API_KEY, then `demo_inject --via-llm`). GBrain sink is REAL: `GBrainIOSink` -> gbrain.io, auto when `perception/.env.gbrain` exists (stub fallback). Live `relationship.updated` passes (haiku, ~2.2s) every ~20s/4 utterances. QM sink posts to `$QM_URL/world-events`. Extras: `POST /hud` (QM pushes agent_activity), `/ws/quest?debug=1` tracks. matthew enrolled from 5 photos (5/5 self-match). Run: `uv run python -m perception`, sim: `python -m perception.sim`. See `perception/README.md` |
| Quest client | `quest/` | DONE (untested on real headset). WebXR immersive-ar + getUserMedia camera (UNVERIFIED on 3S: whether passthrough cams show up and keep streaming during XR; in-headset status strip tells you in ~10s). Fallback `?video=0`: laptop/phone is the eye, headset does HUD+mic. Needs Horizon OS v76+, dev mode, `npm run adb:reverse`. WebXR raw camera access NOT available. See `quest/README.md` |
| QM fork | `~/dev/qm`, branch `worldhooks` (MatthewKim323/qm) | VERIFIED E2E: curl customer_feedback.detected -> 202 -> root agent spawns Context/Product/Follow-up swarm on Docker sandboxes -> drafts issue + reply, awaits approval, sends nothing. ~4 min per swarm (too slow for stage, needs tuning or pre-warm). Running now: Postgres 17 :55432 + QM :8090 (started from a scratchpad dir). Uses HARNESS=codex (~/.codex/auth.json) because shell OPENAI_API_KEY is OUT OF CREDITS. Needs SANDBOX_RESOURCES_ENABLED=true. Another session pushed a feature_request swarm (8ffb9f4) and edited deploy/worldhooks/world-hooks.json: confirm customer_feedback route still there. GBrain not wired into QM (needs MCP URL + OAuth client creds). See `docs/QM.md` |
| Sponsor research | `docs/SPONSORS.md` | done. Memorable = QM memory provider `type: "memorable"` in `MEMORY_PROVIDER_CONFIG`, no LLM key needed |
| Enrollment photos | `perception/data/enroll/matthew/` (5 jpgs, gitignored) | need 8-15 pics of Matthew (the customer in front of the headset); Stephen wears it, so he only needs enrolling if he ever steps in front |

## GBrain decision

- **Use hosted gbrain.io** via MCP `gbrain-io` (project-scoped in `.mcp.json`). matt must `/mcp` -> gbrain-io -> OAuth.
- **NEVER touch matt's personal brain** (MCP `gbrain`, localhost:3131, Postgres at /Volumes/Vault/gbrain-pgdata, `~/.gbrain`, global `gbrain` binary 0.32.5). It has 8.4k private DMs. Do not run the global `gbrain` CLI at all: at 1:51-1:54pm an agent invocation of it auto-applied pending schema migrations (v0.11 -> v0.18.1) to the personal DB. Data verified intact (11,506 pages, healthy), but no more.
- Local demo brain (`~/dev/gbrain-demo`) is **abandoned**.
- **DONE (2026-09-27):** perception talks to gbrain.io with its own OAuth client (`python -m perception.gbrain_auth`, scope memory:full ONLY, matt approved; creds in `perception/.env.gbrain`). Verified e2e on the hosted workspace: encounter -> people/timeline, conversation summary, commitment page + links, relationship deltas; a fresh process rebuilds the card (you_owe, last, relationship, recent_deltas) from GBrain alone. Card read is ~0ms after startup warm; a burst of 4 events flushes in ~3.5s in the background.
- Demo shape: Stephen (founder, wearer) talks to Matthew (customer, enrolled). Wearer defaults are now stephen/Stephen. Pages: `people/matthew`, `people/stephen`, `relationships/stephen-matthew` (gbrain.io collapses `--` in slugs), `projects/opal` (Opal = Stephen's startup, github.com/qtzx06/opal), `events/yc-hackathon-2026-09-27`, signal pages under feedback/ commitments/ decisions/ feature-requests/ bugs/.
- Seeds in `seed/`, TODO(matt) placeholders for real relationship facts (never shown on HUD). Before each take: `cd perception && uv run python scripts/seed_gbrain.py --reset`.
- NOT done: calendar grounding (`calendar:read`) was blocked by the permission classifier because the approval came relayed through an agent, not from matt in that session. `here` comes from `WORLD_SITUATION` instead. Timeline rows can't be deleted via MCP; `--reset` stamps `reset_at` so older "seen by" rows are ignored.

## Builder decision (matt, 2026-09-27)

No cloud Claude Code (routines are gone from the code). QM is the execution layer and the interface; Claude Code is only the engine inside QM's Builder worker, run locally as headless `claude -p` (`perception/builder.py`). The HUD shows one `qm_swarm` panel (Context / Product / Builder lanes, Builder tool tail, recalled/learned procedure), see contracts/EVENTS.md.

## Blockers on matt

1. ~~`MEMORABLE_API_KEY`~~ DONE via device flow, lives in `.env.memorable` (gitignored). `set -a; . ./.env.memorable; set +a` to load.
2. ~~gbrain.io OAuth~~ DONE (`perception/.env.gbrain`). Still TODO: fill `TODO(matt)` lines in `seed/people/matthew.md` + `seed/relationships/stephen-matthew.md`, then re-seed.
3. ~~`ANTHROPIC_API_KEY`~~ DONE in `perception/.env` (auto-loaded). Real extraction verified on the old Alex scenario (pre-Opal story): correct customer_feedback + commitment + summary, but 9.4s latency on claude-sonnet-5, consider haiku for stage. OpenAI key in `~/.zshrc` is OUT OF CREDITS (breaks embeddings + openai harness), top it up.
4. Quest in dev mode, USB-C, Horizon OS version.
5. Approve `memorable enable --scope <worldhook scope>` (human consent required).
6. Booth asks: GBrain (self-hosted ok? credits), Memorable (credits, ORG_ID still needed?), QM (which scope for event-triggered swarm).

## Next up

1. Wire perception QM sink -> `~/dev/qm` `/world-events`, end to end with `demo_inject.py`.
2. ~~GBrain sink -> gbrain.io~~ DONE. Quest HUD should render `context_delta` + the extra person_card fields (`seen_before`, `here`, `relationship`, `recent_deltas`), see contracts/EVENTS.md.
3. Enable Memorable on the WorldHook scope. Run 1 must include a write step (traces that only read are refused). Measure run 1 vs run 2 (turns, tool calls, corrections, time). Real numbers only.
4. Get Quest camera frames flowing (see quest/README.md fallback if direct camera access blocks).
5. Don't run `memorable install-hooks` (edits global ~/.claude settings) or `memorable init gbrain`.

## Rules

Commit + push small and often, no AI attribution in commits, no em dashes, long commands in background.
