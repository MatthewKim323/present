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
  "people": [{ "id": "alex", "name": "Alex", "enrolled": true }],
  "project": "syla",              // nullable
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
| `relationship.updated` | `{ person_id, deltas: [{ kind, text }], summary, encounter_id, utterances_seen }` emitted LIVE during a conversation (every ~20s or 4 utterances, `perception/live.py`, small fast model). `kind`: `fact` \| `preference` \| `topic` \| `sentiment` \| `shared_context` \| `open_loop_you_owe` \| `open_loop_owes_you`; `text` is a terse HUD line ("prefers async demos"). Only new info, never transcript. GBrain writes it to `relationships/<wearer>-<person>` immediately |

## HUD messages (world service -> Quest, over /ws/hud and /ws/quest)

```json
{ "kind": "person_card", "anchor_track_id": 3, "person_id": "alex",
  "name": "ALEX", "subtitle": "founder · Acme", "last": "Syla onboarding",
  "owes_you": "feedback", "you_owe": "demo",
  "bbox": [x, y, w, h] }   // optional, normalized 0-1 in source frame, used for XR anchoring

{ "kind": "memory_event", "text": "CUSTOMER FEEDBACK REMEMBERED", "detail": "Canvas onboarding" }

{ "kind": "agent_activity", "anchor_track_id": 3, "hook": "customer_feedback.detected",
  "workers": [{ "name": "Context", "state": "running" | "done" | "failed", "note": "searching GBrain" }] }

{ "kind": "context_delta", "person_id": "matthew", "delta_kind": "preference", "text": "+ prefers async demos" }
```

`context_delta`: one per `relationship.updated` delta, so the person card visibly compounds mid-conversation (append under the card, fade old ones).

`person_card` additive fields from GBrain (optional, older clients ignore them):
`seen_before: { when: "2026-09-27 12:03", ago: "2h ago", where: "YC hackathon, San Francisco" } | null` (previous encounter, from GBrain timeline timestamps),
`here: "YC hackathon, San Francisco"` (current situation, `WORLD_SITUATION`),
`relationship: "early Syla user, wants easier setup"` (1-line summary),
`recent_deltas: ["prefers async demos", ...]` (last 3 learned, newest first).

Builder (feature_request.detected -> coding agent -> PR): same `agent_activity` shape, one worker named `Builder`, plus optional `job_id` on the message and `url` (Vercel preview) / `pr_url` on the worker once known. Notes go `queued: <feature>` -> `coding: <feature>` / `editing Onboarding.tsx` / `building` / `opening PR` -> `PR #N opened · building preview` -> done `PR #N · preview ready · <url>` (or failed `failed: <reason>`). Before coding, a recalled Memorable procedure shows as `{ "kind": "memory_event", "text": "RECALLED PROCEDURE", "detail": "<title> · <n> steps" }`.

```json
{ "kind": "agent_activity", "anchor_track_id": 4, "hook": "feature_request.detected", "job_id": "b123451",
  "workers": [{ "name": "Builder", "state": "done", "note": "PR #3 · preview ready · https://syla-demo-git-....vercel.app",
                "url": "https://syla-demo-git-....vercel.app", "pr_url": "https://github.com/MatthewKim323/syla-demo/pull/3" }] }
```

Debug: `/ws/quest?debug=1` also streams `{ "kind": "tracks", "tracks": [{ "track_id", "bbox", "person_id", "label" }] }` for anchoring.

## Quest -> world service (over /ws/quest)

```json
{ "kind": "frame", "ts": 1727467443.12, "jpeg_b64": "...", "w": 1280, "h": 960, "head_pose": [..7 floats..] }
{ "kind": "audio", "ts": ..., "pcm16_b64": "...", "sample_rate": 16000 }
{ "kind": "gesture", "type": "pinch", "target_track_id": 3 }
{ "kind": "label", "track_id": 3, "name": "Alex" }   // "that's Alex" enrollment
```

## Privacy invariants

- Recognition only against the local enrolled set. Never external lookup.
- Frames and audio are processed in memory and dropped. Only WorldEvents persist.
