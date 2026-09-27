# World event contract (v0)

Single source of truth for every component. Change it here first, then code.

## Topology

```
Quest 3S client  --ws frames/audio-->  world service (perception/, :8787)
                 <--ws HUD states----
world service  --POST /world-events-->  QM fork (qm/)
world service  --put_page / timeline-->  GBrain
QM  --traces-->  Memorable  (native QM integration)
```

- world service WebSocket: `ws://<host>:8787/ws/quest` (Quest connects here)
- world service HTTP: `POST :8787/events` (inject a WorldEvent manually, used by demo scripts + tests)
- world service HUD fanout: `ws://<host>:8787/ws/hud` (any HUD client, including a desktop debug view)
- QM ingress: `POST <qm>/world-events` (body = WorldEvent)

## WorldEvent envelope

```json
{
  "id": "evt_01J...",            // ulid
  "type": "commitment.detected",
  "ts": "2026-09-27T20:14:03Z",
  "source": "quest3s",            // quest3s | desktop-sim | manual
  "confidence": 0.94,
  "people": [{ "id": "matthew", "name": "Matthew", "enrolled": true }],
  "project": "opal",              // nullable
  "payload": { }                  // type-specific, below
}
```

## Types and payloads

| type | payload |
|---|---|
| `person.encountered` | `{ track_id, person_id \| null, label, bbox: [x,y,w,h], match_score }` (unknown -> `person_id: null, label: "UNKNOWN PERSON 03"`) |
| `person.enrolled` | `{ person_id, name, samples: n }` |
| `conversation.completed` | `{ duration_s, summary, speakers: [person_id], utterances: n }` (no raw transcript persisted) |
| `decision.detected` | `{ decision, constraint?, decided_by: [person_id] }` |
| `commitment.detected` | `{ actor, recipient, commitment, due? }` |
| `customer_feedback.detected` | `{ product, feature, sentiment: "neg"\|"pos"\|"mixed", feedback, buying_signal? }` |
| `feature_request.detected` | `{ product, feature, request, requested_by, acceptance?: [string] }` (customer asks for / suggests a concrete product change; `feature` is a short imperative title, `request` one sentence, `acceptance` 1-4 visible checks. Triggers the Builder) |
| `physical_bug.detected` | `{ device, symptom, repro }` |
| `task.demonstrated` / `world.task_requested` | `{ instruction, target: "whiteboard"\|"object"\|..., snapshot_ref? }` |
| `object.state_changed` / `object.last_seen` | `{ object, state?, location? }` |
| `world.watch_requested` | `{ instruction, person_id?, object?, person_name?, topic_terms?: [str], action?, once?, track_id? }` (extras are additive, from the world service's haiku parse, `perception/watches.py`; only the wearer arms watches) (the wearer sets a standing watch out loud: "next time Matthew brings up pricing, prep a counter-offer". QM turns it into a WorldWatch with one model call; later events matching it fire its action. See QM `docs/worldhooks.md`) |
| `world.entity_adopted` | `{ entity_kind: "person"\|"object", entity_id, label, track_id? }` (pinch on a tracked person/object: the world service forwards `{kind:"gesture",type:"pinch",target_track_id}` as this event. QM gives the entity one persistent thread `world:entity:<kind>:<id>`; every later event mentioning it lands there) |
| `relationship.updated` | `{ person_id, deltas: [{ kind, text }], summary, encounter_id, utterances_seen }` emitted LIVE during a conversation (every ~20s or 4 utterances, `perception/live.py`, small fast model). `kind`: `fact` \| `preference` \| `topic` \| `sentiment` \| `shared_context` \| `open_loop_you_owe` \| `open_loop_owes_you`; `text` is a terse HUD line ("prefers async demos"). Only new info, never transcript. GBrain writes it to `relationships/<wearer>-<person>` immediately |

## HUD messages (world service -> Quest, over /ws/hud and /ws/quest)

```json
{ "kind": "person_card", "anchor_track_id": 3, "person_id": "matthew",
  "name": "MATTHEW", "subtitle": "builder · Kali Labs", "last": "Opal landing",
  "owes_you": "feedback", "you_owe": "demo",
  "bbox": [x, y, w, h] }   // optional, normalized 0-1 in source frame, used for XR anchoring

{ "kind": "memory_event", "text": "CUSTOMER FEEDBACK REMEMBERED", "detail": "Opal landing page" }

{ "kind": "agent_activity", "anchor_track_id": 3, "hook": "customer_feedback.detected",
  "workers": [{ "name": "Context", "state": "running" | "done" | "failed", "note": "searching GBrain" }] }

{ "kind": "context_delta", "person_id": "matthew", "delta_kind": "preference", "text": "+ prefers async demos" }
```

QM swarm tracker (WorldHooks) posts to `POST :8787/hud`: `agent_activity` for every routed event and fired watch (`note` = the worker's current tool-call purpose, `anchor_track_id` from `payload.anchor_track_id` or `payload.track_id`), `{ "kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "<title> · <n> steps" }` when Memorable recall fires on a turn, and after a run that recalled finishes `{ "kind": "memory_event", "text": "LEARNED FROM RUN 1", "detail": "tool calls A -> B · turns C -> D · Es -> Fs" }` with measured numbers.

`context_delta`: one per `relationship.updated` delta, so the person card visibly compounds mid-conversation (append under the card, fade old ones).

`person_card` additive fields from GBrain (optional, older clients ignore them):
`seen_before: { when: "2026-09-27 12:03", ago: "2h ago", where: "YC hackathon, San Francisco" } | null` (previous encounter, from GBrain timeline timestamps),
`here: "YC hackathon, San Francisco"` (current situation, `WORLD_SITUATION`),
`relationship: "early Opal user, wants easier setup"` (1-line summary),
`recent_deltas: ["prefers async demos", ...]` (last 3 learned, newest first).
`agent: { state: "assigned", thread: "world:entity:person:<id>" }` (the wearer pinched this person: `world.entity_adopted`; the card shows an AGENT pill).

Watches and entity agents (`perception/watches.py`):

```json
{ "kind": "memory_event", "text": "WATCH ARMED", "detail": "pricing · Matthew" }
{ "kind": "memory_event", "text": "WATCH FIRED", "detail": "pricing · Matthew" }
{ "kind": "memory_event", "text": "AGENT ASSIGNED", "detail": "MATTHEW" }
{ "kind": "armed_watches", "items": [{ "id": "evt_...", "qm_id": "ww_..." | null, "topic": "pricing", "person_id": "matthew",
    "person": "Matthew", "action": "prep a counter-offer", "once": true, "fired": 0, "state": "armed" }] }   // snapshot, replace
```

`WATCH FIRED` comes from QM's `/world-events` reply (`watches: [ids]`) or `POST :8787/hud {"kind":"watch_fired","watch_id":"ww_..."}`. Cards of a watched person get `watching: "pricing"` client-side (WATCHING row).

Builder (feature_request.detected -> coding agent -> PR): same `agent_activity` shape, one worker named `Builder`, plus optional `job_id` on the message and `url` (Vercel preview) / `pr_url` on the worker once known. Notes go `queued: <feature>` -> `coding: <feature>` / `editing LandingPage.tsx` / `building` / `opening PR` -> `PR #N opened · building preview` -> done `PR #N · preview ready · <url>` (or failed `failed: <reason>`). Before coding, a recalled Memorable procedure shows as `{ "kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "<title> · <n> steps" }`.

```json
{ "kind": "agent_activity", "anchor_track_id": 4, "hook": "feature_request.detected", "job_id": "b123451",
  "workers": [{ "name": "Builder", "state": "done", "note": "PR #3 · preview ready · https://opal-git-....vercel.app",
                "url": "https://opal-git-....vercel.app", "pr_url": "https://github.com/qtzx06/opal/pull/3" }] }
```

### Dev cockpit (GitHub + QM SWARM panels, `perception/devfeed.py`)

The world service owns all GitHub access; the Quest never holds a token. Both messages are full
snapshots (replace, don't merge), sent on change and re-sent every ~10s so late clients catch up.

```json
{ "kind": "dev_github", "repo": "qtzx06/opal",
  "prs": [{ "number": 7, "title": "[WORLD] Add How it works section under hero", "branch": "world/add-how-it-works-section-under-hero",
            "state": "open" | "draft", "checks": "pass" | "fail" | "pending" | "none",
            "additions": 42, "deletions": 8, "files": ["app/src/landing/LandingPage.tsx", "..."],
            "preview_url": "https://opal-git-....vercel.app" | null, "url": "https://github.com/qtzx06/opal/pull/7",
            "hunk_file": "app/src/landing/LandingPage.tsx",
            "hunk": [{ "t": "+" | "-" | " ", "s": "<one source line, <=90 chars>" }] }] }

{ "kind": "qm_swarm", "hook": "feature_request.detected", "event_id": "evt_01J..." | null, "anchor_track_id": 4 | null,
  "workers": [{ "name": "Context" | "Product" | "Builder" | "...", "state": "running" | "done" | "failed",
                "note": "Matthew · lifelong friend",
                "tail": [{ "tool": "Read" | "Edit" | "Bash" | "...", "target": "discord-bot/core/bot.py" }],  // Builder only
                "elapsed_s": 134, "pr": 6, "pr_url": "https://github.com/qtzx06/opal/pull/6", "url": "<preview>" }],  // Builder only, once known
  "recalled": { "title": "add discord command", "steps": 5 },   // optional: Memorable procedure recalled for this run
  "learned": { "title": "add discord command", "steps": 5 } }   // optional: procedure learned from this run (steps may be null)
```

`prs`: open PRs on the Builder repo whose title starts with `[WORLD]`, newest first (max 4). Only the newest has a
non-empty `hunk` (first hunk of the first non-lockfile, a few lines). `tail`: tool name + short target only (path, command head,
pattern), never file contents, redacted.

`qm_swarm` is the one panel for the WorldHook swarm (there is no separate Claude Code panel;
Claude Code is only the engine inside QM's Builder worker, run locally as `claude -p`). The world service merges
(a) the `agent_activity` QM's swarm tracker POSTs to `/hud` (lanes for Context / Product / ...; `RECALLED
PROCEDURE` / `PROCEDURE LEARNED` memory_events fill `recalled` / `learned`) with (b) the Builder job from
`builder.py` (lane state + note, last ~6 tool calls as `tail`, Memorable recall/learn). Keyed by `hook` and
`event_id` (QM may add `event_id` to its agent_activity; without it a settled swarm that goes running again is
a new run). The Builder job replaces QM's own `Builder` lane. Without QM (`BUILDER_AUTO=1`) the swarm is just the
Builder lane. Clients: while a `qm_swarm` with the same `hook` is shown, don't render `agent_activity` for that
hook (it is still broadcast for older clients). GitHub polling runs every ~5s while a Builder job or swarm is
active, ~30s otherwise.

### Procedural memory (Memorable, `perception/procfeed.py`, Quest `src/memorypanel.js`)

Memorable is the procedural memory ("what have I learned how to do"), shown apart from GBrain's declarative
memory. One message per phase of a harness run:

```json
{ "kind": "procedure", "phase": "recording" | "extracting" | "learned" | "recalled" | "refused",
  "source": "qm-swarm" | "claude-code", "event_id": "evt_01J..." , "job_id": "b451461",
  "title": "add discord command",
  "steps": [{ "seq": 1, "action": "Read", "activity_class": "read" | "search" | "write" | "execute", "target": "discord-bot/core/bot.py" }],
  "steps_total": 14,                 // only when steps was capped at 12
  "trigger": "ship customer feature request: Add !recap command",
  "gbrain_slug": "procedures/add-discord-command",   // learned/recalled: where GBrain mirrored it (null on the stub)
  "admitted": true, "reason": "no_postcondition",    // refused: Memorable's judge reason, verbatim
  "tool_calls_seen": 7,                               // recording: running count of captured tool calls
  "metrics": { "tool_calls": 14, "turns": 9, "seconds": 63 } }  // learned: measured numbers of the source run (only real values; seconds_to_pr from the Builder)
```

Builder (`claude-code`): `recalled` (before the coder starts, steps injected into its prompt) -> `recording` when the
coder starts, re-sent with a rising `tool_calls_seen` as tool calls stream in -> `extracting` when it POSTs Memorable
`/v1/extract` (skipped when Memorable is not configured) -> `learned` (admitted draft + GBrain slug) or `refused`
(`reason`). QM (`qm-swarm`): `POST :8787/procedures {kind: "learned" | "recalled" | "refused", draft: {title, steps?,
task?}, origin: {harness, event_id?, job_id?, reason?}}` -> GBrain mirror (learned/recalled) -> the same `procedure`
message with the slug. Fields that are unknown are omitted, never faked. `target` is a short redacted path or the first
line of a command.

```json
{ "kind": "procedure_library", "items": [{ "title": "add discord command", "steps_count": 5, "source": "claude-code",
  "learned_at": "2026-09-27T21:04:11Z", "uses": 1, "gbrain_slug": "procedures/add-discord-command" }] }
```

Full snapshot, newest first: local Builder drafts (`perception/data/procedures/*.json`) plus QM-learned procedures
(index in `perception/data/procedure_library.json`, which also holds GBrain slugs and recall counts). Sent to each HUD
client on connect, on service start, and after every learn / recall. `GET :8787/procedures` returns
`{count, items: [...same + steps, trigger, path]}`.

Quest -> world service (over /ws/quest), acting on those panels:

```json
{ "kind": "dev_action", "action": "approve" | "comment" | "open_preview", "pr": 7, "text": "optional comment" }
```

`approve` -> `gh pr review --approve` (never merge), `comment` -> `gh pr comment` (canned text if `text` is
empty), both only against the Builder repo and only for a PR currently listed in `dev_github`. `open_preview`
is handled client-side (desktop: overlay iframe + link; XR: opened when the session ends) and only logged by
the service. The result comes back as a `memory_event` toast (`PR APPROVED` / `COMMENT POSTED` /
`APPROVE FAILED`, detail `#7 · <reason>`).

Preview screenshot (sent once the Builder's PR is done and the world service has served the branch locally):

```json
{ "kind": "preview_shot", "job_id": "b451461", "pr": 5, "title": "[WORLD] Add How it works section under hero",
  "url": "http://192.168.x.x:4301/", "jpeg_b64": "...", "w": 1280, "h": 1600 }
```

`jpeg_b64` is a top-of-page screenshot of the running preview, full page width, may be tall (the Quest crops a
16:10 window and scrolls it). Live pages can't render inside immersive-ar, so this is how the preview reaches the
wearer: XR pops it ~0.9 m in front of the head (world-locked after), desktop shows it as a centered overlay. It
auto-scrolls once toward ~40% of the page; pinch/click scrolls a step, pinch-hold / X / Esc dismisses, OPEN does
the same thing as `open_preview`. Re-sending with the same `job_id` + `pr` swaps the image in place; a new pair pops
a fresh panel. Keep it well under the ws frame limit (JPEG q~0.8, <= ~600 KB).

Debug: `/ws/quest?debug=1` also streams `{ "kind": "tracks", "tracks": [{ "track_id", "bbox", "person_id", "label" }] }` for anchoring.

### GBrain live feed (`perception/gbrain_ops.py`, Quest `src/brainpanel.js`)

Every GBrain call the world service makes (perception writes, the live relationship pass, person-card reads, QM
worker reads through the proxy below, Memorable procedure pages) becomes one `gbrain_op`:

```json
{ "kind": "gbrain_op", "op": "query" | "search" | "get_page" | "put_page" | "add_timeline_entry" | "add_link",
  "actor": "perception" | "live" | "card" | "memorable" | "qm:Context" | "qm:Product" | "qm:Builder" | "qm:<worker>",
  "slug": "relationships/stephen-matthew",      // optional; add_link: the from page, plus "to"
  "query": "matthew opal feedback",             // query/search only, <= 80 chars
  "hits": [{ "slug": "feedback/2026-09-27-opal-landing-feedback", "title": "Opal landing feedback" }],  // query/search, max 5
  "title": "Matthew",                           // get_page, when known
  "ms": 142, "ok": true, "miss": true,          // miss: get_page on a page that does not exist yet
  "person_id": "matthew",                       // when the slug is people/<id> or relationships/<wearer>-<id>
  "event_id": "evt_01J...",                     // the WorldEvent the op serves, when known
  "count": 3 }                                  // coalesced identical ops
```

Slugs, titles and short queries only (each <= 80 chars), never page bodies or snippets. Identical ops still queued
fold into one line (`count`); the feed sends at most ~5/s (burst 5) and, if the backlog passes 24, sheds
non-QM lines first. Reads are `query` / `search` / `get_page`; the rest are writes.

Read-only GBrain for QM swarm workers (the world service holds the gbrain.io token; workers reach it at
`http://host.docker.internal:8787` with `Authorization: Bearer $WORLD_HOOKS_SECRET`, 401 otherwise, 503 if the
secret is unset):

| route | returns |
|---|---|
| `POST /gbrain/query {q, actor, event_id?, limit?}` | `{q, results: [{slug, title, snippet}]}` hybrid query, snippet <= 200 chars (503 on the stub backend) |
| `GET /gbrain/page/{slug}?actor=&event_id=` | `{slug, title, frontmatter, compiled_truth, timeline}` (compiled truth capped at 4000 chars, timeline 1500; 404 if missing) |
| `GET /gbrain/person/{id}?actor=&event_id=` | the person-card context (`subtitle`, `last`, `you_owe`, `owes_you`, `seen_before`, `relationship`, `recent_deltas`) plus `facts`, `recent`, `you_owe_all`, `owes_you_all`, `encounters`, `relationship_page` |

`actor` is the worker name (`Context` becomes `qm:Context`). Every call emits a `gbrain_op` with that actor; a
person read always shows as `get_page people/<id>` so the HUD can link the feed to the person card.

### Perception overlay (`perception/visionfx.py`, Quest `src/visionfx.js`)

`vision` and `face_capture` go only to clients that asked (`/ws/quest?debug=1` or `?vision=1`), never to `/ws/hud`.

```json
{ "kind": "vision", "ts": 1727467443.1, "w": 640, "h": 480,
  "tracks": [{ "track_id": 3, "bbox": [0.38, 0.18, 0.22, 0.30],            // normalized 0-1
               "landmarks": [[0.44, 0.27], [0.53, 0.27], [0.49, 0.32], [0.45, 0.37], [0.52, 0.37]],  // YuNet: eyes, nose, mouth corners; null if unknown
               "det_score": 0.93,
               "state": "detecting" | "matching" | "recognized" | "unknown" | "learning",
               "person_id": "matthew" | null, "name": "MATTHEW" | "UNKNOWN PERSON 03" | null,
               "match_score": 0.87, "top_candidates": [{ "name": "Matthew", "score": 0.87 }],   // enrolled set only, max 3
               "embedding_sig": [0.41, 0.77, ...16],     // fixed random projection of the SFace embedding, squashed 0-1
               "samples": { "n": 4, "needed": 10 } }] }  // only while learning
```

~5 Hz while faces are tracked, plus immediately on any state change. `embedding_sig` is a 16-bar visual barcode, not an
identity key: lossy, never stored, never sent to `/ws/hud`.

```json
{ "kind": "face_capture", "track_id": 3, "name": "Matthew", "n": 4, "needed": 10, "jpeg_b64": "<96x96 JPEG>" }
```

One per sample captured while learning a face (the filmstrip). Crops are made in memory, sent once, never persisted
by the service or the client. Only the embedding goes into `data/people.json`.

```json
{ "kind": "relationship_vector", "person_id": "matthew", "name": "MATTHEW",
  "dims": [{ "label": "familiarity", "value": 0.49 }, { "label": "knowledge", "value": 0.3 }, { "label": "topics", "value": 0.33 },
           { "label": "open loops", "value": 0.25 }, { "label": "warmth", "value": 0.8 }, { "label": "recency", "value": 1.0 }],
  "facts_count": 3, "last_delta": "prefers async demos" }
```

Sent to every HUD client after each `person.encountered` (with a person) and each `relationship.updated`, from GBrain's
relationship state (`relationships/<wearer>-<id>`; stub: this run's events). familiarity = encounters, knowledge = facts,
topics = topics / conversations, open loops = you owe + owes you, warmth = latest sentiment delta, recency = last seen.

Self-introduction enrollment: when the unknown person in front of the wearer says "I'm X" / "my name is X" / "call me X",
that is their opt-in. Attribution: explicit speaker tag or clearly quieter than the wearer's mic = start learning; unclear =
wait for the wearer to greet them by name ("nice to meet you X", which also counts on its own). Learning captures 10 fresh
samples from that track, then `person.enrolled` + `person.encountered` fire as usual. The `label` message below still works.

## Quest -> world service (over /ws/quest)

```json
{ "kind": "frame", "ts": 1727467443.12, "jpeg_b64": "...", "w": 1280, "h": 960, "head_pose": [..7 floats..] }
{ "kind": "audio", "ts": ..., "pcm16_b64": "...", "sample_rate": 16000 }
{ "kind": "gesture", "type": "pinch", "target_track_id": 3 }
{ "kind": "label", "track_id": 3, "name": "Matthew" }   // "that's Matthew" enrollment
{ "kind": "dev_action", "action": "approve", "pr": 7 }   // dev cockpit, see HUD messages above
```

## Privacy invariants

- Recognition only against the local enrolled set. Never external lookup.
- Frames and audio are processed in memory and dropped. Only WorldEvents persist.
- A self-introduction counts as opt-in. Learning stores embeddings only; `face_capture` crops are transient HUD pixels, never written.
