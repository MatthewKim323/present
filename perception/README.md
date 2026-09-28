# perception: the WORLD world service

Raw perception in, structured WorldEvents out. Implements `contracts/EVENTS.md` on port **8787**.

```
Quest / sim --/ws/quest--> faces (YuNet+SFace, local) --> person.encountered / person.enrolled
                       \-> audio (energy VAD -> faster-whisper) -> per-encounter buffer (memory only)
                                 -> Claude extraction -> decision / commitment / customer_feedback / physical_bug / task + conversation.completed
                                 -> live pass every ~20s (haiku) -> relationship.updated (card compounds mid-conversation)
every WorldEvent -> GBrain sink (gbrain.io, stub fallback) + QM sink (POST $QM_URL/world-events) + HUD (/ws/hud + /ws/quest)
```

## Setup

```bash
cd perception
uv sync                                   # opencv, fastapi, faster-whisper, anthropic ...
uv run python scripts/fetch_models.py     # YuNet + SFace ONNX -> models/ (gitignored)
export ANTHROPIC_API_KEY=...              # extraction; without it only conversation.completed is emitted
export QM_URL=http://localhost:XXXX       # optional; QM sink is a no-op when unset
uv run python -m perception               # world service on :8787
```

First start downloads the whisper model (`base.en`, ~150MB) in the background; `/health` shows `"asr": "loading"` until ready. Vision works immediately.

## GBrain (hosted gbrain.io)

```bash
uv run python -m perception.gbrain_auth          # once, a human approves in the browser (scope memory:full only)
uv run python -m perception.gbrain_auth --check  # refresh + whoami
uv run python scripts/seed_gbrain.py --reset     # seed/**.md -> gbrain.io; deletes WORLD-created pages first (every take identical)
```

`perception/.env.gbrain` (chmod 600, gitignored) holds client_id + refresh token; access tokens refresh automatically. When it exists the service uses `GBrainIOSink` (`perception/gbrain.py`), else the stub. Force with `GBRAIN_MODE=io|stub`. If gbrain.io is down or unauthorized, writes are skipped for 30s and cards fall back to the stub, so the demo never dies.

Pages: `people/<id>` (human-curated, created only if missing, never overwritten), `relationships/<wearer>-<id>` (WORLD-owned: summary, what we know, recent, open loops), `events/<situation>`, `projects/<slug>`, and one page per signal under `feedback/ commitments/ decisions/ feature-requests/ bugs/`, linked to person + project + situation. Encounters (max once per person per 10 min) and conversation summaries become timeline entries; transcripts never leave memory. Writes run on a background queue; relationship state lives in memory (hydrated from GBrain at startup), so `person_context` is instant and the card shows `seen_before`, `here`, `relationship`, `recent_deltas` on top of the 4 base fields. Only memory tools are callable (allowlist in `gbrain.py`).

Edit `seed/people/matthew.md` + `seed/relationships/stephen-matthew.md` if facts change, then re-run the seed script (a value starting with `TODO` never shows on the HUD).

## Enroll people (opt-in only)

Only embeddings are stored, in `data/people.json` (gitignored). Photos/frames are never written.

```bash
# from photo folders: data/enroll/<name>/*.jpg, one folder per person
uv run python -m perception.enroll --from-dir data/enroll/
# -> per-person used/skipped counts (no face, or multiple similar-size faces) + leave-one-out self-match check

uv run python -m perception.enroll --live "Matthew"         # webcam, 12 samples
uv run python -m perception.enroll --list | --check | --remove matthew
uv run python -m perception.enroll --meta matthew role=builder "company=Kali Labs"   # shown on the person card
```

Live, over the wire: `{"kind":"label","track_id":3,"name":"Matthew"}` ("that's Matthew") captures samples from that track and emits `person.enrolled`. Unknown faces show as `UNKNOWN PERSON NN`.

Self-introduction (`perception/intro.py`): when the unknown person in front of the wearer says "I'm Matthew" / "my name is Matthew" / "call me Matthew", that counts as their opt-in. A regex on the ASR text finds it (no LLM call). If the speaker is clearly the other person (explicit tag, or well below the wearer's mic level) the service learns their face right away: 10 fresh samples from that track over ~2s, then `person.enrolled`. If attribution is unclear it waits up to 30s for the wearer to greet them by name ("nice to meet you Matthew"), which also counts on its own. Intros said by the wearer are ignored. Only embeddings go to `data/people.json`; the 96px crops the headset shows as a filmstrip (`face_capture`) are made in memory, sent once to opted-in HUD clients, never written. Delete anyone with `uv run python -m perception.enroll --remove <id>`.

```bash
curl -s localhost:8787/debug/utterance -H 'content-type: application/json' -d '{"text":"hey, I'\''m Matthew","speaker":"other"}'
```

Perception overlay (`perception/visionfx.py`): clients on `/ws/quest?debug=1` or `?vision=1` get `vision` (~5 Hz: bbox, YuNet landmarks, state detecting/matching/recognized/unknown/learning, top enrolled candidates, a 16-bar embedding barcode) and `face_capture`; every HUD client gets `relationship_vector` (radar next to the card). Shapes in `contracts/EVENTS.md`.

## Desktop sim (no headset)

```bash
uv run python -m perception            # terminal 1
uv run python -m perception.sim        # terminal 2: webcam + mic, OpenCV window with boxes/labels/HUD
```

Grant camera + mic to your terminal app (System Settings > Privacy). In the sim window: `q` quit, `e` end conversation now, `m` toggle mic. In the sim terminal: `3 Matthew` labels track 3, `say <text>` injects an utterance (skips ASR), `end` ends the conversation.

## Demo without cameras

```bash
uv run python -m perception.demo_inject              # Matthew gives Stephen Opal feedback + a commitment: ready-made events -> POST /events
uv run python -m perception.demo_inject --feature    # Matthew asks for a `!recap` command in the Opal Discord bot (Builder run 1)
uv run python -m perception.demo_inject --customer2  # similar second request, `!streak` command (Memorable recall, run 2)
uv run python -m perception.demo_inject --via-llm    # same scenarios as utterances, end conversation, real Claude extraction
```

## Builder: live coding from reality

A customer asks for a concrete product change in person -> `feature_request.detected` -> a coding agent ships it as a PR on Opal ([qtzx06/opal](https://github.com/qtzx06/opal), Discord bot in `discord-bot/`, `BUILDER_SUBDIR`; override the repo with `BUILDER_REPO`) -> HUD shows it. Code: `perception/builder.py`.

- Trigger: `BUILDER_AUTO=1` (BuilderSink dispatches on the event, no QM needed) or QM's Builder worker calls `POST /builder/dispatch {event_id, spec, repo?}`. Deduped per `event_id`, so both paths firing yields one job.
- Runner: always local (QM is the execution layer; Claude Code is the engine inside its Builder worker) = fresh clone under `data/builder/<job>/`, `npm install`, headless `claude -p` (stream-json, `--strict-mcp-config`, subscription login: `ANTHROPIC_API_KEY` is stripped unless `BUILDER_USE_API_KEY=1`) on branch `world/<feature>`, agent commits/pushes/opens `[WORLD] <feature>`; if it doesn't, the runner opens the PR.
- Progress: polls GitHub (`gh`) every `BUILDER_POLL_S` (4s): PR on the branch, then the Vercel GitHub deployment status of the PR head sha -> preview URL. Vercel blocks every `[WORLD]` PR deployment today (git author not on the Vercel team), so the job degrades to done `PR #N opened`; `BUILDER_LOCAL_PREVIEW=1` serves the branch locally (`vite preview` on `BUILDER_PREVIEW_PORT` 4300) and screenshots it for the HUD instead.
- HUD `agent_activity`, worker `Builder`: `queued: <feature>` -> `coding: <feature>` / `reading X` / `editing X` / `building` / `opening PR` -> `PR #N opened · building preview` -> done `PR #N · preview ready · <url>` (worker also carries `url`, `pr_url`) or failed.
- Memorable (procedural memory): after a local run the canonical tool trace (names + command/file_path only, never contents) goes to `POST $MEMORABLE_API_URL/v1/extract` (key from `../.env.memorable`). Admitted drafts land in `data/procedures/`. Next job with a similar request recalls the best one (lexical), injects it into the prompt as reference-only, and the HUD shows `RECALLED PROCEDURE · <title> · <n> steps`.
- HUD `qm_swarm` (`devfeed.py`): one panel per WorldHook run, QM's worker lanes merged with the Builder job (state, last ~6 tool calls, recalled/learned procedure). Without QM it is just the Builder lane.
- Jobs: `GET /builder/jobs`, `GET /builder/jobs/<id>` (state, PR, preview, timings, tool_calls, turns, cost, procedure).

```bash
BUILDER_AUTO=1 WORLD_WEARER_ID=stephen WORLD_WEARER_NAME=Stephen uv run python -m perception
uv run python -m perception.demo_inject --feature --via-llm   # Matthew asks Stephen for a !recap command in the Opal Discord bot
```

## Watches and entity agents: reality creates them (`perception/watches.py`)

Voice -> `world.watch_requested`. The wearer says a standing instruction out loud: "next time Matthew brings up pricing, prep a counter-offer", "remind me when he mentions the tournament", "keep an eye on this". A regex prefilter (`next time`, `whenever`, `every time`, `keep an eye`, `remind me when`, `watch for`, `let me know when`, ...) gates every utterance, so ordinary talk never costs a model call. Hits go to one `claude-haiku-4-5` call (`WORLD_WATCH_MODEL`, same client as the live pass) that returns `{is_watch, instruction, person_id, topic_terms, action, once}`: pronouns resolve to the person in frame, "next time we should grab lunch" is `is_watch: false`. Without an API key a deterministic parser covers the "next time X brings up Y, Z" shape.
- Only the wearer arms watches: an explicit `other` tag or a clearly quieter voice (loudness heuristic, same as `intro.py`) is rejected before the model call. Unclear attribution is allowed.
- The instruction was said to the AI, not the person, so it is dropped from the conversation buffer (otherwise extraction turns it into a commitment that fires the watch it just made).
- QM turns the event into a WorldWatch (one model call on its side) and replies with the watch; QMSink hands that reply to `WatchBoard`, which keeps the QM id. Later events that match come back from QM with `watches: [ids]` -> HUD `WATCH FIRED`. `POST /hud {"kind":"watch_fired","watch_id"}` works too.
- HUD: `memory_event WATCH ARMED · pricing · Matthew`, `armed_watches` snapshot (Quest shows a WATCHING row on that person's card), `WATCH FIRED · pricing · Matthew`.

Pinch -> `world.entity_adopted`. The Quest sends `{kind:"gesture", type:"pinch", target_track_id}` (desktop: click a card or face box). On a recognized person the service emits `{entity_kind:"person", entity_id, label, track_id}` (debounced per person, `WORLD_PINCH_DEBOUNCE_S` 10s; unknown people are never adopted) -> QM gives them one persistent thread `world:entity:person:<id>`. HUD: `AGENT ASSIGNED · MATTHEW`, and every later `person_card` for them carries `agent: {state, thread}` (AGENT pill). The existing card refresh on pinch and the `label` / self-intro enrollment paths are unchanged.

```bash
curl -s localhost:8787/debug/utterance -H 'content-type: application/json' \
  -d '{"text":"next time he brings up pricing, prep a counter-offer","speaker":"wearer","name":"Matthew","person_id":"matthew"}'
curl -s localhost:8787/watches          # this run's watches (qm_id once QM confirms) + pinch-assigned agents
```

Verified live 2026-09-27 (worktree service on :8799 -> QM :8091): the utterance above -> haiku parse 3.8s -> QM `watch ww_8dfc6ccafa8b457d created via world: {"person_id":"matthew","text_contains":["pricing"]}` (spec via model) -> HUD `WATCH ARMED`, `armed_watches` gained the QM id; then a `conversation.completed` mentioning pricing -> QM claimed `world-watch:ww_8dfc6ccafa8b457d:<event>` -> HUD `WATCH FIRED · pricing · Matthew`, list emptied (once). `world.entity_adopted` with this payload is accepted by QM (202, idempotent adopt).

## Endpoints

| | |
|---|---|
| `ws /ws/quest` | Quest protocol from EVENTS.md. Receives HUD messages. `?source=desktop-sim` sets event source. `?debug=1` also streams `{"kind":"tracks", tracks:[{track_id,bbox,person_id,label,match_score}], detect_ms, embed_ms}` after each frame (non-contract, debug only) |
| `ws /ws/hud` | HUD messages: `person_card`, `memory_event`, `agent_activity` |
| `POST /events` | inject a WorldEvent (id/ts filled if missing) -> fanned out to all sinks |
| `POST /hud` | push a raw HUD message to every HUD client (QM's swarm tracker posts `agent_activity` here; it also feeds the merged `qm_swarm` panel, see `devfeed.py`) |
| `GET /health` | status, enrolled people, live tracks, latency (detect, embed/face, frame, ASR, LLM) |
| `POST /debug/utterance` | `{text, speaker?: wearer\|other, name?, person_id?}` |
| `GET /watches` | spoken watches this run (armed / fired / rejected, with QM id) + pinch-assigned entity agents |
| `POST /builder/dispatch` | `{event_id, spec, repo?, person_id?, anchor_track_id?}` -> start a Builder job (QM's Builder worker calls this) |
| `GET /builder/jobs[/<id>]` | Builder job state, PR, preview URL, timings |
| `POST /debug/end-conversation` | close the open encounter and run extraction now |

## Config (env)

`WORLD_PORT` (8787), `WORLD_MATCH_THRESHOLD` (0.40, SFace cosine, top-3 mean), `WORLD_ASR` (`faster-whisper` \| `none`), `WORLD_ASR_MODEL` (`base.en`, try `small.en`), `WORLD_LLM_MODEL` (`claude-sonnet-5`), `WORLD_CONV_GAP` (10s silence ends a conversation), `WORLD_LEAVE_GRACE` (8s after the person leaves frame), `WORLD_ENCOUNTER_DEBOUNCE` (60s per person), `WORLD_WEARER_ID`/`WORLD_WEARER_NAME` (stephen/Stephen), `WORLD_LIVE_MODEL` (`claude-haiku-4-5`), `WORLD_LIVE_EVERY_S` (20) / `WORLD_LIVE_EVERY_N` (4), `WORLD_LIVE=0` disables live passes, `WORLD_SITUATION` (JSON, JSON file path, or a name; default YC hackathon, San Francisco, 2026-09-27), `GBRAIN_MODE` (io \| stub, default auto), `GBRAIN_ENCOUNTER_DEBOUNCE` (600s), `QM_URL`, `WORLD_PEOPLE_PATH`, `WORLD_EVENTS_LOG`.

## Privacy

- Recognition only against the local enrolled set; no external lookup.
- Frames and audio are decoded in memory and dropped after processing; transcripts live only in the open encounter's buffer and are cleared after extraction. `data/events.jsonl` (stub GBrain) holds WorldEvents only. GBrain gets summaries and extracted signals, never transcripts.

## Swapping parts

- ASR: implement `Transcriber.transcribe(segment) -> str` in `perception/audio.py`, register in `make_transcriber`.
- GBrain: `GBrainIOSink` in `perception/gbrain.py` implements the `GBrainSink` protocol (`emit` + `person_context`); `WorldService._make_gbrain` picks it.
- New sink: any object with `name` and `async emit(event)`, add to `FanOut`.

## Tests / bench

```bash
uv run pytest -q
uv run python scripts/bench_faces.py --image some_face.jpg    # or --webcam
```
