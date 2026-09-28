# Session handoff (2026-09-27, ~2pm PT)

Read CLAUDE.md, contracts/EVENTS.md, docs/SPONSORS.md, docs/QM.md first.

## State

| Piece | Where | Status |
|---|---|---|
| Event contract v0 | `contracts/EVENTS.md` | done, binding for all components |
| Perception / world service (:8787) | `perception/` | DONE, 24 tests pass. Faces (YuNet+SFace, ~20ms/frame), whisper ASR verified live, HUD fanout verified. Claude extraction only mock-tested (needs ANTHROPIC_API_KEY, then `demo_inject --via-llm`). GBrain sink is REAL: `GBrainIOSink` -> gbrain.io, auto when `perception/.env.gbrain` exists (stub fallback). Live `relationship.updated` passes (haiku, ~2.2s) every ~20s/4 utterances. QM sink posts to `$QM_URL/world-events`. Extras: `POST /hud` (QM pushes agent_activity), `/ws/quest?debug=1` tracks. matthew enrolled from 5 photos (5/5 self-match). Run: `uv run python -m perception`, sim: `python -m perception.sim`. See `perception/README.md` |
| Quest client | `quest/` | DONE (untested on real headset). WebXR immersive-ar + getUserMedia camera (UNVERIFIED on 3S: whether passthrough cams show up and keep streaming during XR; in-headset status strip tells you in ~10s). Fallback `?video=0`: laptop/phone is the eye, headset does HUD+mic. Needs Horizon OS v76+, dev mode, `npm run adb:reverse`. WebXR raw camera access NOT available. See `quest/README.md` |
| QM fork | `~/dev/qm`, branch `worldhooks` (MatthewKim323/qm) | VERIFIED E2E: curl customer_feedback.detected -> 202 -> root agent spawns Context/Product/Follow-up swarm on Docker sandboxes -> drafts issue + reply, awaits approval, sends nothing. ~4 min per swarm (too slow for stage, needs tuning or pre-warm). Running now: Postgres 16 container `world-qm-postgres` on 127.0.0.1:55433 + QM :8091 (`~/dev/qm/scripts/world-dev.sh up`). Harness `pi` on claude-sonnet-5. Needs SANDBOX_RESOURCES_ENABLED=true. Another session pushed a feature_request swarm (8ffb9f4) and edited deploy/worldhooks/world-hooks.json: confirm customer_feedback route still there. GBrain not wired into QM (needs MCP URL + OAuth client creds). See `docs/QM.md` |
| Sponsor research | `docs/SPONSORS.md` | done. Memorable = QM memory provider `type: "memorable"` in `MEMORY_PROVIDER_CONFIG`, no LLM key needed |
| Enrollment photos | `perception/data/enroll/matthew/` (5 jpgs, gitignored) | need 8-15 pics of Matthew (the customer in front of the headset); Stephen wears it, so he only needs enrolling if he ever steps in front |

## GBrain decision

- **Use hosted gbrain.io** via MCP `gbrain-io` (project-scoped in `.mcp.json`). matt must `/mcp` -> gbrain-io -> OAuth.
- **NEVER touch matt's personal brain** (MCP `gbrain`, localhost:3131, Postgres at /Volumes/Vault/gbrain-pgdata, `~/.gbrain`, global `gbrain` binary 0.32.5). It has 8.4k private DMs. Do not run the global `gbrain` CLI at all: at 1:51-1:54pm an agent invocation of it auto-applied pending schema migrations (v0.11 -> v0.18.1) to the personal DB. Data verified intact (11,506 pages, healthy), but no more.
- Local demo brain (`~/dev/gbrain-demo`) is **abandoned**.
- **DONE (2026-09-27):** perception talks to gbrain.io with its own OAuth client (`python -m perception.gbrain_auth`, scope memory:full ONLY, matt approved; creds in `perception/.env.gbrain`). Verified e2e on the hosted workspace: encounter -> people/timeline, conversation summary, commitment page + links, relationship deltas; a fresh process rebuilds the card (you_owe, last, relationship, recent_deltas) from GBrain alone. Card read is ~0ms after startup warm; a burst of 4 events flushes in ~3.5s in the background.
- Demo shape: Stephen (founder, wearer) talks to Matthew (customer, enrolled). Wearer defaults are now stephen/Stephen. Pages: `people/matthew`, `people/stephen`, `relationships/stephen-matthew` (gbrain.io collapses `--` in slugs), `projects/opal` (Opal = Stephen's startup, github.com/qtzx06/opal), `events/yc-hackathon-2026-09-27`, signal pages under feedback/ commitments/ decisions/ feature-requests/ bugs/.
- Seeds in `seed/` (no placeholders left; a `TODO` value would be hidden from the HUD anyway). Before each take: `cd perception && uv run python scripts/seed_gbrain.py --reset`.
- NOT done: calendar grounding (`calendar:read`) was blocked by the permission classifier because the approval came relayed through an agent, not from matt in that session. `here` comes from `WORLD_SITUATION` instead. Timeline rows can't be deleted via MCP; `--reset` stamps `reset_at` so older "seen by" rows are ignored.

## Builder decision (matt, 2026-09-27)

No cloud Claude Code (routines are gone from the code). QM is the execution layer and the interface; Claude Code is only the engine inside QM's Builder worker, run locally as headless `claude -p` (`perception/builder.py`). The HUD shows one `qm_swarm` panel (Context / Product / Builder lanes, Builder tool tail, recalled/learned procedure), see contracts/EVENTS.md.

## Blockers on matt

1. ~~`MEMORABLE_API_KEY`~~ DONE via device flow, lives in `.env.memorable` (gitignored). `set -a; . ./.env.memorable; set +a` to load.
2. ~~gbrain.io OAuth~~ DONE (`perception/.env.gbrain`). Seeds are filled in (`seed/people/matthew.md`, `seed/relationships/stephen-matthew.md`); edit + re-seed only if facts change.
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

## Stage runbook

Roles: **Stephen** wears the Quest (founder). **Matthew** is the customer in front of him. **Director** (third teammate) sits at the laptop with `/director` open and the terminal. Nobody talks to the AI.

### Once, before the first take

```bash
git -C ~/dev/qm pull                       # QM fork moves fast; pull before starting it
export PRESENT_DIR=~/Documents/GitHub/present   # world-dev.sh defaults to ~/dev/present (or: ln -s ~/Documents/GitHub/present ~/dev/present)
command -v memorable || npm i -g memorable-cli  # QM's memorable provider shells out to bare `memorable`: it must be on the PATH of the shell that starts QM
scripts/dev-up.sh                          # QM :8091 + world :8787 + Quest client :5173 (logs in .logs/); restart world after pulling new code
scripts/take.sh --dry                      # checklist only, changes nothing
cd perception && uv run python -m perception.demo_inject --rehearse   # optional full rehearsal, no people (~10 min, opens 2 real PRs)
```

Recommended stage settings in `perception/.env` (see `perception/.env.example`):

- `BUILDER_LOCAL_PREVIEW=1`: Vercel blocks every `[WORLD]` PR deployment (git author not on the Vercel team), so the Builder serves the branch locally and screenshots it for the HUD instead.
- `WORLD_LLM_MODEL=claude-haiku-4-5`: end-of-conversation extraction took 9.4s on sonnet; the haiku live pass runs in 2.2s.
- `WORLD_CONV_GAP=5`: 5s of silence ends the conversation (default 10s), so extraction fires while Matthew is still there.

Open the director console on the laptop: `http://localhost:8787/director?token=<WORLD_HOOKS_SECRET from perception/.env>` (the token is kept in localStorage, so later just `/director`). `DIRECTOR_TOKEN` overrides it if set on the world service. Mirror the headset: `scripts/cast-quest.sh --record` (records every take to `recordings/`, which is also the fallback video).

### Before every take

```bash
scripts/dev-up.sh down && scripts/dev-up.sh   # restart the world service: relationship state is in memory and must start clean
scripts/take.sh                  # matthew stays enrolled: the take opens on recognition
scripts/take.sh --fresh-face     # forget matthew (people.json backed up) so "I'm Matthew" learns his face live
```

`take.sh` must end in green `READY`. It starts anything that is down (dev-up.sh), runs `world-dev.sh gc` (stale swarm computers exhaust docker address pools and the swarm never spawns, see QM.md R1), resets the GBrain seeds, checks matthew's enrollment (a plain `take.sh` after a `--fresh-face` take restores the backup), prints Memorable status (read-only; QM's Memorable tables are never touched), checks demo PR #6 on qtzx06/opal is open, checks the Builder is idle and the Quest page is up, then resets the HUD. `--clear-procedures` moves local Builder drafts aside (run 1 then has nothing to recall); default keeps them.

### The take (live), with the director button for each beat

| # | Beat | Live trigger | Director button if it flakes |
|---|---|---|---|
| 1 | (fresh-face only) Matthew: "hey, I'm Matthew" | ASR intro -> face learning, filmstrip | `Matthew: "I'm Matthew"` (still needs his face tracked) |
| 2 | Stephen looks at Matthew, person card from GBrain | face match | `Matthew recognized` |
| 3 | They talk; card compounds with context deltas | live relationship pass (~20s / 4 utterances) | `Live facts` |
| 4 | Matthew: "you should add a bang recap command" | extraction -> `feature_request.detected` -> QM swarm (Context / Product / Builder) -> PR + diff hunk on the HUD (~4-5 min) | `Matthew asks for !recap` |
| 5 | While run 1 builds: Stephen: "next time Matthew brings up pricing, prep a counter-offer" | `world.watch_requested` | `Watch: next time Matthew mentions pricing` |
| 6 | Matthew: "add a bang streak command" | run 2, `RECALLED PROCEDURE` on the HUD, run 1 vs run 2 line (real numbers, may say NO GAIN) | `Matthew asks for !streak` |

Director watches the right-hand columns: QM SWARM lanes, BUILDER job + PR link, HUD (last 30) to confirm each beat actually reached the headset, header pills (QM, gbrain op count, HUD clients, enrolled/tracks). `Reset HUD` clears cards, toasts and the swarm panel between beats if something stale sticks.

### Fallbacks, in order

1. **ASR or extraction misses a line**: press that beat's director button. Same code path as live (events go through GBrain, QMSink, HUD, Builder), so the swarm and PR are real.
2. **Recognition flakes**: `Matthew recognized` (anchors to the tracked face if there is one, else track 4).
3. **Swarm is slow on stage**: talk over it; the demo PR #6 (`[WORLD] Add !recap command`, `DEMO_PR` in take.sh) is already open to show if run 1 isn't done in time. The HUD shows the PR + diff hunk, not a Vercel preview (blocked on every `[WORLD]` PR); `BUILDER_LOCAL_PREVIEW=1` gives a local screenshot instead.
4. **Headset or world service dies**: Quest page with `?mock=1` (scripted HUD, no server) or `?mockseq=swarm` for the swarm sequence.
5. **Everything dies**: play the last good recording from `recordings/`.

## Rules

Commit + push small and often, no AI attribution in commits, no em dashes, long commands in background.
