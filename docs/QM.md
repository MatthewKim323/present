# QM (execution layer)

Fork: https://github.com/MatthewKim323/qm, branch `worldhooks` (upstream `yc-software/qm`, MIT). Local clone: `~/dev/qm`. Fork docs: `docs/worldhooks.md`.

## Run it

```bash
cd ~/dev/qm && scripts/world-dev.sh up      # QM on :8091 (PORT=... to change)
scripts/world-dev.sh consent                # prints the memorable enable command (human consent)
scripts/world-metrics.sh <event id>         # turns / tool calls / errors / wall time per worker
```

`world-dev.sh` writes `qm.env` once (gitignored; secrets generated, `ANTHROPIC_API_KEY` from `perception/.env`, Memorable key from `.env.memorable`), starts the Postgres container `world-qm-postgres` (127.0.0.1:55433, volume `world-qm-pgdata`), checks the local sandbox image, and runs `node --env-file=qm.env src/index.ts`. Harness `pi` on `claude-sonnet-5`, `SANDBOX_BACKEND=local`, owner scope `personal:stephen`.

`perception/.env` has `QM_URL=http://localhost:8091` and the matching `WORLD_HOOKS_SECRET`; `QMSink` sends it as a bearer. QM posts HUD messages to `WORLD_HUD_URL` (default `http://localhost:8787/hud`) and procedures to `<same origin>/procedures`.

Memorable consent (matt ran it 2026-09-27): `cd ~/dev/qm && MEMORABLE_BACKEND=qm MEMORABLE_DB_URL=postgres://qm:qm@127.0.0.1:55433/qm memorable enable --scope personal:stephen`.

## What the fork adds

| Piece | What |
|---|---|
| WorldHooks | `POST /world-events`: routes a WorldEvent by type to a standing-orders turn, optionally a swarm (`deploy/worldhooks/world-hooks.json`). `customer_feedback.detected` -> Context / Product / Follow-up. `feature_request.detected` -> Context / Product / Builder (Builder POSTs `{event_id, person_id, spec}` to `:8787/builder/dispatch`). Every worker writes files and ends on a verifying command so Memorable admits the trace. |
| Swarm tracker | Follows root + workers in Postgres, POSTs `agent_activity` (with `hook`, `event_id`, `anchor_track_id`, lanes Context / Product / Builder) to the HUD on every change, measures the run, keeps reports at `GET /world-runs` (table `world_runs`). |
| Memorable for event-triggered swarms | Upstream QM skips capture on automated turns and never calls query-based recall on a turn. The fork captures every session of a finished world swarm, recalls procedures on every turn by task line, and keys both on a stable world-event task line (`Handle world event <type> about <product> <feature>: <standing orders>`), so a similar real-world event recalls with no typed prompt. Look-only shell commands (curl GET, cat, ls, jq, sleep) are recorded as reads so recalled procedures list them as skippable context. `MEMORABLE_VARIANT=l2` renders the decisive steps. HUD gets `RECALLED PROCEDURE` and a measured run 1 vs run 2 line; learned / recalled procedures go to the world service `/procedures` (Memorable -> GBrain bridge). |
| WorldWatches | Standing watches whose predicate runs over world events (`POST/GET/DELETE /world-watches`, match on type / person / project / text). `world.watch_requested` turns a spoken instruction into a watch with one model call (verified live: "next time Matthew brings up pricing, prep a counter-offer" -> `{person_id: matthew, text_contains: [pricing]}`, once). |
| Entity-bound agents | `POST /world-entities/adopt` or a `world.entity_adopted` event (Quest pinch) gives a person/object one persistent thread `world:entity:<kind>:<id>`; later events mentioning it land in that thread. |

## Measured runs (real numbers, 2026-09-27, pi + claude-sonnet-5, local docker sandboxes)

Totals across root + workers, from `scripts/world-metrics.sh` / the tracker. "Recall" = procedure recall fired on the run's turns.

| Run | Event | Memorable | Turns | Tool calls | Failed calls | Wall |
|---|---|---|---|---|---|---|
| warmup | customer feedback (Matthew) | consent granted mid-run, not recorded; root had to create its sandbox | 10 | 32 | 3 | 211s |
| A | customer feedback (Matthew) | recorded, recall not yet wired | 9 | 30 | 3 | 166s |
| B | customer feedback (Priya) | recorded, recall not yet wired | 10 | 45 | 3 | 249s |
| C | customer feedback (Matthew) | baseline, store cleared first | 10 | 36 | 4 | 235s |
| D | customer feedback (Priya) | recall x10 (default `l3b` inject) | 10 | 47 | 4 | 361s |
| E | customer feedback (Matthew) | baseline, store cleared, reads classified | 9 | 41 | 2 | 285s |
| F | customer feedback (Priya) | recall x7 (`l2` inject) | 7 | 50 | 1 | 248s |
| G | feature request (dark mode, old Builder brief) | baseline | 7 | 29 | 1 | 276s |
| R1 | feature request `!recap` (Opal) | swarm never spawned: docker address pools exhausted by old worker computers; root did all roles alone. Discarded (fixed with `world-dev.sh gc`) | 1 | 16 | 0 | 251s |
| R1b | feature request `!recap` (Opal) | baseline, store cleared | 10 | 40 | 4 | 245s |
| R2 | feature request `!streak` (Opal) | recall x13 | 13 | 42 | 4 | 272s |

Honest read:

- Record and recall work end to end off real world events: C/E stored 6/5 procedures under `personal:stephen`, D/F recalled on every root and worker turn with no typed prompt.
- Recall has not made the customer-feedback swarm cheaper. Pair C->D got worse on every axis. After fixing trace classification, E->F: turns 9 -> 7, wall 285s -> 248s, failed calls 2 -> 1, but tool calls 41 -> 50.
- Opal pair R1b -> R2 (the demo flow): no gain, tool calls 40 -> 42, turns 10 -> 13, 245s -> 272s. The HUD says so (`RUN 2 VS RUN 1 (NO GAIN)`) instead of claiming a win.
- Builder dispatch in every feature-request run hit `http://host.docker.internal:8787/builder/dispatch` with nothing listening (no world service was running), so the Builder recorded `unreachable` and no job or PR was created.
- Baseline noise is larger than the effect: four no-recall customer-feedback runs (A, B, C, E) span 30-45 tool calls (median 38.5), 9-10 turns, 166-285s (median 242s). Recall runs: n=2 customer-feedback (D, F, different inject formats) and n=1 feature-request (R2), so no medians per arm.
- Where the cost goes: the root agent spends most calls on swarm plumbing (spawn, send, poll `/v1/swarm?read=1`), and each worker spends 3-5 calls discovering the swarm API before doing its two real steps (write file, verify). A recalled procedure that says "the event is at `GET /v1/swarm?read=1`, report with one `POST /v1/swarm` send" should cut those; the `l2` block now shows those decisive calls.

Recall evidence (the block `memorable inject --scope personal:stephen` returned for run F's root task line) is in `~/dev/qm/data/world/recall-evidence-root.txt`; QM logs each hit as `[memorable] recall hit scope=personal:stephen chars=<n>`.

## GBrain

QM workers get person context from the event payload plus a `gbrain_context` block the world service attaches; GBrain itself is not a QM connector (gbrain.io needs OAuth). Procedures flow the other way through the world service `/procedures` bridge.
