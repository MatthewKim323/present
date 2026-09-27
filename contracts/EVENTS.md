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
| `physical_bug.detected` | `{ device, symptom, repro }` |
| `task.demonstrated` / `world.task_requested` | `{ instruction, target: "whiteboard"\|"object"\|..., snapshot_ref? }` |
| `object.state_changed` / `object.last_seen` | `{ object, state?, location? }` |

## HUD messages (world service -> Quest, over /ws/hud and /ws/quest)

```json
{ "kind": "person_card", "anchor_track_id": 3, "person_id": "alex",
  "name": "ALEX", "subtitle": "founder · Acme", "last": "Syla onboarding",
  "owes_you": "feedback", "you_owe": "demo" }

{ "kind": "memory_event", "text": "CUSTOMER FEEDBACK REMEMBERED", "detail": "Canvas onboarding" }

{ "kind": "agent_activity", "anchor_track_id": 3, "hook": "customer_feedback.detected",
  "workers": [{ "name": "Context", "state": "running" | "done" | "failed", "note": "searching GBrain" }] }
```

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
