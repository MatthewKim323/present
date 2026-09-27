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
{ "type": "commitment.detected", "actor": "Matthew", "recipient": "Alex",
  "project": "Syla", "commitment": "Send updated onboarding demo", "confidence": 0.94 }
```

QM fork adds a first-class ingress: `POST /world-events` alongside cron / webhook / watch.

## THE demo (one flow, don't build six)

1. Wear Quest, see **Alex** (opted-in, enrolled). HUD shows GBrain context: role, last interaction, open loop.
2. Alex: "Canvas setup was confusing, we'd roll it out if onboarding were easier." matt: "I'll send you the new onboarding demo." matt never talks to the AI.
3. WORLD extracts: customer feedback + buying signal + commitment (matt -> Alex).
4. GBrain updates Alex / Syla / Canvas onboarding / feedback.
5. `customer_feedback.detected` fires QM WorldHook -> swarm: **context agent** (who/what), **product agent** (N other Canvas complaints, likely OAuth stage, draft issue), **follow-up agent** (find demo, draft reply, ask approval before sending).
6. Memorable captures the trace -> procedure `handle_in_person_customer_feedback` (resolve person, resolve project, persist feedback, search similar, merge signals, resolve commitments, prep follow-up, approval before external send).
7. **Customer #2** says similar thing -> Memorable recall -> QM runs learned procedure. Show run 1 vs run 2 metrics (turns, tool calls, corrections, time). **Use real measured numbers only**, not the placeholders in the pitch or Memorable's 19% claim.

Stretch: whiteboard decision ("legacy auth stays until mobile ships, new stuff uses middleware v2") -> GBrain decision -> later coding worker gets it. Physical bug (LED freezes purple on double-press) -> firmware swarm.

## HUD: exactly three visual states

1. **Person card**: name, role/company, last topic, owes you / you owe.
2. **Memory event**: `✓ CUSTOMER FEEDBACK REMEMBERED · Canvas onboarding`.
3. **Agent activity**: WorldHook swarm status, spatially anchored near the person/object that caused it. Pinch/look to select a real thing and assign intelligence to it (RTS over reality).

Subtle, not giant holograms. Don't burn 70% of time on visuals.

## Privacy (part of the product, not an afterthought)

- Face recognition only for explicitly enrolled, opted-in people. Local embeddings, local match. Unknowns are `UNKNOWN PERSON 03` until matt says "that's Alex".
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
