# perception: the WORLD world service

Raw perception in, structured WorldEvents out. Implements `contracts/EVENTS.md` on port **8787**.

```
Quest / sim --/ws/quest--> faces (YuNet+SFace, local) --> person.encountered / person.enrolled
                       \-> audio (energy VAD -> faster-whisper) -> per-encounter buffer (memory only)
                                 -> Claude extraction -> decision / commitment / customer_feedback / physical_bug / task + conversation.completed
every WorldEvent -> GBrain sink (stub, TODO) + QM sink (POST $QM_URL/world-events) + HUD (/ws/hud + /ws/quest)
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

## Enroll people (opt-in only)

Only embeddings are stored, in `data/people.json` (gitignored). Photos/frames are never written.

```bash
# from photo folders: data/enroll/<name>/*.jpg, one folder per person
uv run python -m perception.enroll --from-dir data/enroll/
# -> per-person used/skipped counts (no face, or multiple similar-size faces) + leave-one-out self-match check

uv run python -m perception.enroll --live "Alex"            # webcam, 12 samples
uv run python -m perception.enroll --list | --check | --remove alex
uv run python -m perception.enroll --meta alex role=founder company=Acme   # shown on the person card
```

Live, over the wire: `{"kind":"label","track_id":3,"name":"Alex"}` ("that's Alex") captures samples from that track and emits `person.enrolled`. Unknown faces show as `UNKNOWN PERSON NN`.

## Desktop sim (no headset)

```bash
uv run python -m perception            # terminal 1
uv run python -m perception.sim        # terminal 2: webcam + mic, OpenCV window with boxes/labels/HUD
```

Grant camera + mic to your terminal app (System Settings > Privacy). In the sim window: `q` quit, `e` end conversation now, `m` toggle mic. In the sim terminal: `3 Alex` labels track 3, `say <text>` injects an utterance (skips ASR), `end` ends the conversation.

## Demo without cameras

```bash
uv run python -m perception.demo_inject              # Alex scenario: ready-made events -> POST /events
uv run python -m perception.demo_inject --customer2  # second customer, same Canvas complaint (run 2)
uv run python -m perception.demo_inject --via-llm    # inject Alex utterances, end conversation, real Claude extraction
```

## Endpoints

| | |
|---|---|
| `ws /ws/quest` | Quest protocol from EVENTS.md. Receives HUD messages. `?source=desktop-sim` sets event source. `?debug=1` also streams `{"kind":"tracks", tracks:[{track_id,bbox,person_id,label,match_score}], detect_ms, embed_ms}` after each frame (non-contract, debug only) |
| `ws /ws/hud` | HUD messages: `person_card`, `memory_event`, `agent_activity` |
| `POST /events` | inject a WorldEvent (id/ts filled if missing) -> fanned out to all sinks |
| `POST /hud` | push a raw HUD message to every HUD client (QM can post `agent_activity` here) |
| `GET /health` | status, enrolled people, live tracks, latency (detect, embed/face, frame, ASR, LLM) |
| `POST /debug/utterance` | `{text, speaker?: wearer\|other, name?, person_id?}` |
| `POST /debug/end-conversation` | close the open encounter and run extraction now |

## Config (env)

`WORLD_PORT` (8787), `WORLD_MATCH_THRESHOLD` (0.40, SFace cosine, top-3 mean), `WORLD_ASR` (`faster-whisper` \| `none`), `WORLD_ASR_MODEL` (`base.en`, try `small.en`), `WORLD_LLM_MODEL` (`claude-sonnet-5`), `WORLD_CONV_GAP` (10s silence ends a conversation), `WORLD_LEAVE_GRACE` (8s after the person leaves frame), `WORLD_ENCOUNTER_DEBOUNCE` (60s per person), `WORLD_WEARER_ID`/`WORLD_WEARER_NAME` (matthew/Matthew), `QM_URL`, `WORLD_PEOPLE_PATH`, `WORLD_EVENTS_LOG`.

## Privacy

- Recognition only against the local enrolled set; no external lookup.
- Frames and audio are decoded in memory and dropped after processing; transcripts live only in the open encounter's buffer and are cleared after extraction. `data/events.jsonl` (stub GBrain) holds WorldEvents only.

## Swapping parts

- ASR: implement `Transcriber.transcribe(segment) -> str` in `perception/audio.py`, register in `make_transcriber`.
- GBrain: implement `emit(event)` + `person_context(person_id)` (see `StubGBrainSink` TODO in `perception/sinks.py`) and swap it in `WorldService.__init__`.
- New sink: any object with `name` and `async emit(event)`, add to `FanOut`.

## Tests / bench

```bash
uv run pytest -q
uv run python scripts/bench_faces.py --image some_face.jpg    # or --webcam
```
