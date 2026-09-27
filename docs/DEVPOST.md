# Present: Devpost submission

**Tagline:** Your AI shouldn't stop knowing you when you close your laptop.

## Inspiration

Our agents got memory (GBrain), a workforce (QM) and the ability to learn from experience (Memorable). But all three only see what we type. The moments that matter most for a founder happen in person: a customer saying what's broken, a promise made across a table, a decision on a whiteboard. Today we come home and manually turn our lives into prompts. We wanted that step to disappear.

## What it does

Present is a reality layer for personal AI. You wear a Meta Quest 3S (our dev kit for open smart glasses) and have a normal conversation. You never talk to the AI.

1. The headset recognizes the person in front of you, only if they opted in, and shows a small card from GBrain: who they are, last topic, what you owe each other.
2. While you talk, a live pass writes new relationship facts to GBrain and the card grows.
3. When they ask for something ("can the Discord bot get a `!recap` command?"), Present extracts a structured WorldEvent (`feature_request.detected`, never a transcript).
4. The event fires a QM WorldHook: a swarm of Context, Product and Builder agents. The Builder runs Claude Code and opens a real PR on the product repo. You watch the swarm in space next to the person, and can approve the PR with a pinch.
5. Memorable records the swarm's tool trace as a procedure, mirrors it into GBrain, and recalls it the next time a similar request comes up.

## How we built it

- **Quest client** (`quest/`): WebXR `immersive-ar` page (three.js + Vite) streaming camera frames and 16 kHz mic audio over a WebSocket, rendering the HUD in passthrough. Same page runs on a laptop webcam; `?mock=1` plays a scripted demo.
- **World service** (`perception/`, Python + FastAPI): OpenCV YuNet detection + SFace embeddings matched locally (~20ms/frame), faster-whisper ASR, Claude extraction at the end of a conversation, and a live Claude haiku pass (~2.2s) every ~20s for relationship deltas. Every WorldEvent fans out to GBrain, QM and the HUD.
- **GBrain** (hosted gbrain.io over MCP, our own OAuth client): people, relationship, signal and procedure pages, plus a read-only proxy so QM workers can query it.
- **QM fork** (MatthewKim323/qm, branch `worldhooks`): `POST /world-events` ingress, swarm plans per event type, a swarm tracker that streams to the HUD and measures runs, WorldWatches, entity-bound agents.
- **Memorable**: QM's `type: "memorable"` provider, extended so event-triggered swarms record and recall; plus a bridge that turns learned procedures into GBrain pages.
- **Builder**: headless `claude -p` in a warm local clone, on a `world/<feature>` branch, opens a `[WORLD]` PR; GitHub status and the diff hunk stream back to the HUD.

## Challenges we ran into

- **QM's Memorable integration didn't fire for us.** Upstream skips capture on automated turns and never does query-based recall, so event-triggered swarms learned nothing. We added capture on swarm completion and recall on every turn, keyed on a stable task line derived from the event.
- **Memorable refuses read-only traces.** Workers had to use canonical tool names and end on a verifying command that exits 0, or no procedure was admitted.
- **Recall didn't make runs cheaper.** See the numbers below. We chose to show that on the HUD instead of faking a win.
- **Camera access in WebXR.** Quest Browser doesn't expose raw camera access to WebXR, so we use `getUserMedia` with a fallback where a laptop is the eye and the headset does HUD + mic.
- **Ops.** Docker address pools ran out from old worker sandboxes (one run was discarded; fixed with a `gc` command). We also kept every piece of demo memory on an isolated gbrain.io workspace so no personal data could reach the stage.

## Accomplishments that we're proud of

- A real conversation turns into a real PR with no typed prompt ([qtzx06/opal #5, #6, #7](https://github.com/qtzx06/opal/pulls)).
- A new QM trigger type (WorldHooks) plus WorldWatches you can set by speaking.
- Procedural memory recorded and recalled off real-world events, and bridged into GBrain so declarative and procedural memory link up.
- Privacy by construction: opt-in by self-introduction, local embeddings only, no footage persisted.

## What we learned

- Structured events, not transcripts, are the right interface between perception and agents. They are small, private and routable.
- Swarm overhead dominates cost: the root spends most calls on spawn / send / poll, workers spend 3-5 calls finding the swarm API before two real steps. That is where procedural memory should help next.
- Measure with baselines. Four no-recall runs of the same event ranged 30-45 tool calls, more than any recall effect we saw.

### Measured (from docs/QM.md, pi + claude-sonnet-5)

| Pair | Tool calls | Turns | Wall |
|---|---|---|---|
| Customer feedback E -> F (recall) | 41 -> 50 | 9 -> 7 | 285s -> 248s |
| Customer feedback C -> D (recall) | 36 -> 47 | 10 -> 10 | 235s -> 361s |
| Opal feature request R1b -> R2 (recall) | 40 -> 42 | 10 -> 13 | 245s -> 272s |

Record and recall work end to end. A run 2 gain has not shown up yet.

## What's next

- Recalled procedures that skip swarm plumbing, then n>=5 runs per arm to see if recall actually saves calls.
- Faster swarms (pre-warmed sandboxes) so the loop closes inside the conversation.
- Native Quest camera (Passthrough Camera API) for aligned anchoring, then real glasses.
- Whiteboard decisions and physical bugs as first-class events (`decision.detected`, `physical_bug.detected` already exist in the contract).
- GBrain as a native QM connector instead of a proxy.

## Built with

Meta Quest 3S, WebXR, three.js, Vite, JavaScript, Python, FastAPI, OpenCV (YuNet, SFace), faster-whisper, Anthropic Claude (Sonnet, Haiku), Claude Code, GBrain (gbrain.io, MCP, OAuth), QM (TypeScript, Node, Postgres, Docker), Memorable, GitHub CLI, scrcpy, adb, ngrok, uv
