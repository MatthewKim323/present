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
| `world.watch_requested` | `{ instruction, person_id?, object? }` (the wearer sets a standing watch out loud: "next time Matthew brings up pricing, prep a counter-offer". QM turns it into a WorldWatch with one model call; later events matching it fire its action. See QM `docs/worldhooks.md`) |
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

Builder (feature_request.detected -> coding agent -> PR): same `agent_activity` shape, one worker named `Builder`, plus optional `job_id` on the message and `url` (Vercel preview) / `pr_url` on the worker once known. Notes go `queued: <feature>` -> `coding: <feature>` / `editing LandingPage.tsx` / `building` / `opening PR` -> `PR #N opened · building preview` -> done `PR #N · preview ready · <url>` (or failed `failed: <reason>`). Before coding, a recalled Memorable procedure shows as `{ "kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "<title> · <n> steps" }`.

```json
{ "kind": "agent_activity", "anchor_track_id": 4, "hook": "feature_request.detected", "job_id": "b123451",
  "workers": [{ "name": "Builder", "state": "done", "note": "PR #3 · preview ready · https://opal-git-....vercel.app",
                "url": "https://opal-git-....vercel.app", "pr_url": "https://github.com/qtzx06/opal/pull/3" }] }
```

### Dev cockpit (GitHub + Claude Code panels, `perception/devfeed.py`)

The world service owns all GitHub / Claude access; the Quest never holds a token. Both messages are full
snapshots (replace, don't merge), sent on change and re-sent every ~10s so late clients catch up.

```json
{ "kind": "dev_github", "repo": "qtzx06/opal",
  "prs": [{ "number": 7, "title": "[WORLD] Add How it works section under hero", "branch": "world/add-how-it-works-section-under-hero",
            "state": "open" | "draft", "checks": "pass" | "fail" | "pending" | "none",
            "additions": 42, "deletions": 8, "files": ["app/src/landing/LandingPage.tsx", "..."],
            "preview_url": "https://opal-git-....vercel.app" | null, "url": "https://github.com/qtzx06/opal/pull/7",
            "hunk_file": "app/src/landing/LandingPage.tsx",
            "hunk": [{ "t": "+" | "-" | " ", "s": "<one source line, <=90 chars>" }] }] }

{ "kind": "dev_session", "job_id": "b123451", "feature": "Add How it works section under hero",
  "state": "queued" | "running" | "pr_open" | "done" | "failed", "mode": "local" | "cloud",
  "step": "editing LandingPage.tsx", "tail": [{ "tool": "Edit", "target": "app/src/landing/LandingPage.tsx" }],
  "elapsed_s": 134, "procedure": { "title": "...", "steps": 8, "score": 0.8 } | null,
  "session_url": "https://claude.ai/code/..." | null, "pr": 7 | null }
```

`prs`: open PRs on the Builder repo whose title starts with `[WORLD]`, newest first (max 4). Only the newest has a
non-empty `hunk` (first hunk of the first non-lockfile, a few lines). `tail`: last ~10 tool calls of the live
builder session, tool name + short target only (path, command head, pattern), never file contents, redacted.
`session_url` is set when the cloud routine runner is used. Polling runs every ~5s while a Builder job is
active, ~30s otherwise.

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
