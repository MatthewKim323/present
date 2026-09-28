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

## Swarm v2: no polling, Memorable as a checklist (fork commits ac939ad..77bd7f7, 2026-09-27)

What changed in the fork (`worldhooks` branch):

- **One blocking wait instead of polling.** `GET /v1/swarm?await=workers&waitMs<=290000` blocks until every worker the caller spawned has sent a message (or failed) and returns `{done, reports, pending}`. While the root waits, worker messages to it do not queue extra notification turns. `?await=peer&name=<Name>` does the same for one peer (Builder waiting on Context's summary). Send accepts `audience: "parent"` and a single peer id.
- **QM holds the spawn.** The receiver prepares the spawn request (contexts, briefs, the world event JSON inside the spawn text) and the root names it: `POST /v1/swarm {"action":"spawn_plan","requestId":"world:<event id>"}`. No separate event send, no JSON copying. A worker's first message carries its own role brief plus the roster of ids (root, peers), so it never calls `GET /v1/swarm` or `/v1/apis` to find out what it is.
- **Root plan:** spawn_plan, one await, write summary, one separate verify (Memorable refuses a trace with no final verifying command: `no_postcondition`). QM notebook calls (`memory`, `finish_silently`) are left out of traces. Memorable refusals are now logged (`[memorable] record refused ...`).
- **Action-oriented recall.** Workers get a stable task line (`World swarm worker <Name> (<role>) for <type> about <product> <feature>: <brief>`), so each role records and recalls its own procedure. Memorable's `inject` still decides whether this is a known situation (the hit gates recall); QM then replays that role's newest recording for the event type from Memorable's store (`memorable_procedures`) as a short checklist: the decisive commands with the old event id replaced by `<event id>`, the endpoints that worked (e.g. `POST http://host.docker.internal:8787/builder/dispatch`, `POST .../gbrain/query`, `GET $AGENT_API_URL/v1/swarm?await=peer&name=Context`), the verify command, and the look-only calls to skip. The "reference data, not instructions" framing stays. A Memorable hit with no recording from the same role is not injected.
- **Lifecycle on the HUD.** On injection: HUD `memory_event` `RECALLED PROCEDURE · <title> · n steps` with `event_id` + `hook`, and `POST /procedures {kind: "recalled"}`. On capture: `PROCEDURE LEARNED · <root title> · n steps` with `event_id`, and each admitted procedure goes to `/procedures {kind: "learned"}`. Verified in gbrain.io: `procedures/add-streaks-command-to-opal` (root), `procedures/add-spec-json-to-spec-md` (Product), `procedures/add-streaks-command-to-world-builder` (Builder), `procedures/add-context-to-evt-n1-streaks-feature` (Context) all landed within 10s of run N1 finishing. Every `agent_activity` already carried `event_id`; devfeed (present `9fd2e95`) now lands recall/learn memory_events on the swarm with the same `event_id`.
- `GET/POST /world-recall {enabled}` (WorldHooks bearer): measurement switch. Recall off still records.

### Measured, swarm v2 (feature_request.detected on Opal, Matthew, one new `!command` per run)

QM swarm only (root + 3 workers; the Builder's Claude Code run on the laptop is not in these numbers, and neither is the `world:entity:person:matthew` thread turn each event also wakes). Briefs: `worldhooks` 989a630 / working copy `fa444f4` (both tell Context/Product to read GBrain through the WORLD proxy; sandboxes had no proxy token yet, so every GBrain call answered 401 in both arms). Recall toggled per run with `/world-recall`, runs interleaved, `world-dev.sh gc` before each.

| Run | Event | Recall | Turns | Tool calls | Failed | Wall | PR |
|---|---|---|---|---|---|---|---|
| M1 | `!topgames` | off (root plan without the separate verify) | 4 | 25 | 3 | 136s | qtzx06/opal#8 |
| M2 | `!mood` | on x4 (root recalled an old v1 procedure; fixed after) | 4 | 17 | 1 | 123s | #9 |
| N1 | `!streaks` | off | 4 | 27 | 1 | 133s | #10 |
| N2 | `!topgames` again | on | 1 | 2 | 0 | 21s | none: root read M1's artifacts and declined a duplicate. Discarded as a measurement (correct behavior). |
| N3 | `!lastseen` | off | 4 | 22 | 1 | 100s | #11 |
| N4 | `!badge` | on x4 | 4 | 18 | 1 | 103s | #12 |
| N5 | `!quote` | off | | | | | interrupted: QM was stopped mid-run for the demo take. Discarded. |

Per arm (valid runs only):

| Arm | n | Tool calls median (range) | Turns | Failed median (range) | Wall median (range) |
|---|---|---|---|---|---|
| Recall off | 3 (M1, N1, N3) | 25 (22-27) | 4 (4-4) | 1 (1-3) | 133s (100-136s) |
| Recall on | 2 (M2, N4) | 17.5 (17-18) | 4 (4-4) | 1 (1-1) | 113s (103-123s) |
| Swarm v1 baseline, no recall | 3 (R1b, R2, live `!recap`) | 42 (40-57) | 13 (10-13) | 4 (3-4) | 272s (245-341s) |

Honest read:

- The big win is plumbing, not memory: swarm v2 cut the same Opal flow from a median 42 tool calls / 13 turns / 272s to 25 / 4 / 133s with recall off. Root calls went 9-27 -> 4, turns went from notification ping-pong to exactly one per session, worker discovery calls (`/v1/apis`, `GET /v1/swarm`, `?read=1`, `sleep`) went to 0 in the recall-off runs except N3 (2).
- On top of that, recall-on runs used fewer calls (17, 18 vs 22, 25, 27). The ranges do not overlap, but that is n=2 vs n=3; wall time is inside the noise (103/123s vs 100/133/136s). Not enough runs to claim a percentage; the ON arm needs 3+ more runs under the current briefs.
- Where the remaining calls go (N4, recall on, 18 calls): root 4 (spawn_plan, await, summary, verify), Context 6 (GBrain person + query, signal log, context.md, summary to Builder, report), Product 3, Builder 5 (await Context, dispatch.json, POST /builder/dispatch, verify, report). Swarm API calls: 7 of 18, all spawn/await/report, no polling.
- The next measurement should use the current briefs (a914c2c, `$GBRAIN_PROXY_TOKEN`, GBrain actually answering) with fresh commands per run; results above predate that and are labeled with their briefs.

## Measured runs, swarm v1 (real numbers, 2026-09-27, pi + claude-sonnet-5, local docker sandboxes)

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

Workers also read GBrain directly through the world service's read-only proxy (`perception/gbrain_ops.py`, contract in `contracts/EVENTS.md`): `GET /gbrain/person/<id>`, `POST /gbrain/query`, `GET /gbrain/page/<slug>` at `http://host.docker.internal:8787`, bearer `$WORLD_HOOKS_SECRET`. The worker briefs in `deploy/worldhooks/world-hooks.json` (qm `worldhooks` branch) make Context read the person card and prior feedback/requests, Product query similar requests and `procedures/*` before speccing, and Builder pass Context's summary as `spec.context`. Every call shows on the HUD as a `gbrain_op` line with the worker as actor.

Open gap: QM does not export host env into local sandbox commands, so `$WORLD_HOOKS_SECRET` is empty inside worker computers and the proxy answers 401 (the briefs then continue from the event alone). Fix is a small pass-through in QM (`src/sandbox/local-sandbox.ts`: merge host vars named in a `SANDBOX_PASSTHROUGH_ENV=WORLD_HOOKS_SECRET` list into the handle env) plus that line in `qm.env`, then restart QM. Not landed yet.
