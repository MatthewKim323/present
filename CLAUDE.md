# WORLD // a reality layer for personal AGI

Hackathon build (YC, 2026-09-27). Dev rig: **Meta Quest 3S**.

**New session? Read `docs/HANDOFF.md` first** (current state, blockers, never-touch-personal-gbrain rule).

**Tagline:** Your AI shouldn't stop knowing you when you close your laptop.
**Technical:** Reality as a first-class context source, trigger surface, and learning environment for agents.
**Productivity thesis:** Humans shouldn't have to manually convert their lives into prompts.

Quest 3S is not "the VR product". It's the prototyping rig for future smart glasses: camera, mic, head pose, hands, passthrough, spatial rendering.

## The stack (each sponsor answers a different question)

| Layer | Role | Question |
|---|---|---|
| Quest 3S | perceive | What is happening right now? |
| WORLD (us) | understand: raw perception -> structured world events | What just happened? |
| **GBrain** | declarative + episodic memory (people, convos, decisions, commitments) | What do I know? |
| **QM** | execution: forked, adds WorldHooks, event-triggered swarms | What can I do? |
| **Memorable** | procedural memory, learns from QM tool traces | What have I learned how to do? |
| jabby | matt's always-on agent (`~/dev/jabby`) | sits on top |

Keep the boundaries clean: GBrain owns world knowledge, QM owns execution, Memorable watches QM traces. Never call GBrain and Memorable both "memory" without the declarative vs procedural distinction.

## Pipeline

```
Quest camera + mic -> perception (people / conversation / objects) -> WORLD EVENTS
  -> GBrain (remember) -> QM WorldHook (act, swarm) -> Memorable (skillify) -> better next time
```

World event types: `person.encountered`, `conversation.completed`, `decision.detected`, `commitment.detected`, `customer_feedback.detected`, `physical_bug.detected`, `task.demonstrated`, `object.state_changed`, `object.last_seen`, `world.task_requested`.

Events are structured JSON, never transcripts:

```json
{ "type": "commitment.detected", "actor": "Matthew", "recipient": "Stephen",
  "project": "opal", "commitment": "Send screenshots of the flow", "confidence": 0.94 }
```

QM fork adds a first-class ingress: `POST /world-events` alongside cron / webhook / watch.

## THE demo (one flow, don't build six). Updated 2026-09-27: replaces the old Alex/Syla/Canvas story

Product is **Opal** (Stephen's real startup, github.com/qtzx06/opal, web app in `app/`). No Syla, no Canvas, no Alex.

1. **Stephen** (founder) wears the Quest. He looks at **Matthew** (matt, enrolled, an Opal customer). OpenCV (YuNet + SFace, local) recognizes him; HUD person card comes from GBrain: relationship to Stephen, last seen (timeline timestamps, "2h ago at YC hackathon"), open loops.
2. They talk. Nobody talks to the AI. During the conversation a rolling pass ships relationship deltas into GBrain (`relationships/stephen-matthew`) and the HUD shows `context_delta` lines: the card compounds live.
3. Matthew suggests a concrete Opal change -> `feature_request.detected` (plus feedback / commitments).
4. QM WorldHook swarm (Context / Product / Builder) spins up, status anchored on the HUD. Builder runs Claude Code as its engine (local headless `claude -p`, no cloud routines; QM is the interface) -> PR `[WORLD] <feature>` on qtzx06/opal + Vercel preview URL on the HUD. Never merged.
5. Memorable records the QM swarm trace and the Claude Code builder trace (cross-harness).
6. Second similar request -> recall fires off the real-world event (no typed prompt) -> HUD `RECALLED PROCEDURE` + run 1 vs run 2 metrics. **Real measured numbers only.**

QM extension story: reality as a first-class trigger (WorldHooks), WorldWatches (standing watches whose predicate runs over world events, created by voice), entity-bound agents (pinch a person/object to adopt it).

## HUD: exactly three visual states

1. **Person card**: name, role/company, last topic, owes you / you owe.
2. **Memory event**: `✓ CUSTOMER FEEDBACK REMEMBERED · Opal landing`.
3. **Agent activity**: WorldHook swarm status, spatially anchored near the person/object that caused it. Pinch/look to select a real thing and assign intelligence to it (RTS over reality).

Subtle, not giant holograms. Don't burn 70% of time on visuals.

## Privacy (part of the product, not an afterthought)

- Face recognition only for explicitly enrolled, opted-in people. Local embeddings, local match. Unknowns are `UNKNOWN PERSON 03` until the wearer says "that's <name>".
- No internet identification.
- Raw video/audio processed transiently, discarded. Persist events, not footage.
- Memory stays human-readable (GBrain notes), user-owned.

## Team split

- **Quest**: camera/mic stream, person tracking + opt-in recognition, HUD, emit structured events.
- **GBrain**: world event -> people/projects/decisions/commitments pages + retrieval for HUD.
- **QM**: fork QM (MIT, source forks supported), add WorldHook ingestion + one world-event swarm.
- **Memorable**: enable native QM integration (stores in QM's Postgres, per-scope consent), verify traces recorded, get recall working on run 2.

## Unverified claims (from pitch research, check against real docs before relying)

- QM: crons/watches/webhooks, swarm API with roles + recursive spawn. (VERIFIED 2026-09-27: MIT license at github.com/yc-software/qm; per-scope durable computer and four agent loops Pi/Codex/OpenCode/Claude Code per memorable.sh/doc/qm; scope-aware `MEMORY_PROVIDER_CONFIG` router in docs/memory-providers.md. See docs/SPONSORS.md.)
- Memorable: VERIFIED 2026-09-27. Native GBrain + QM integrations exist; trace -> procedure extraction is deterministic and model-free (`POST /v1/extract`); QM recall is injected every turn via `memorable inject` (15s timeout, fails open). QM route is now a `type: "memorable"` memory provider (upstream QM main), not the `MEMORABLE=1` flag the Memorable site still shows. gbrain relay needs upstream gbrain, not matt's local 0.32.5. 19% = fewer turns on gbrain/Claude Code; QM number is 40% fewer tool calls. Details + checklist in docs/SPONSORS.md.
- GBrain: scheduled skills over person history. (Still unverified. Hosted gbrain.io is $199/mo per workspace, no free tier listed.)

## Pitch close

> GBrain gave agents memory. QM gave agents a workforce. Memorable lets that workforce learn from experience. We gave all three access to reality.

Six verbs: SEE (Quest) -> UNDERSTAND (World) -> REMEMBER (GBrain) -> ACT (QM) -> LEARN (Memorable) -> BETTER NEXT TIME.

Anti-positioning: not "Granola with agents". Quest adds person grounding, visual deixis ("this prototype"), spatial state, look+point+speak direction.
