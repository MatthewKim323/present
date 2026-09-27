# QM (execution layer)

Fork: https://github.com/MatthewKim323/qm, branch `worldhooks` (upstream `yc-software/qm`, MIT). Local clone: `~/dev/qm`.

## What we added

`POST /world-events` (also `/v1/world-events`): takes one WorldEvent (see `contracts/EVENTS.md`), routes it by `type` to a configured owner scope, and wakes a QM turn through the same trigger path signed webhooks use (durable run, idempotent per event `id`). Code: `src/worldhooks/`, route in `src/api/routes/world-events.ts`, docs in `docs/worldhooks.md`, test in `test/world-hook-receiver.test.ts`.

Auth: `Authorization: Bearer $WORLD_HOOKS_SECRET` or `X-Signature: <hex hmac-sha256 of body>`.

Responses: `202` routed (returns `fireKey`, `threadRef`, `swarm` worker names), `200` unrouted type or duplicate id, `400` bad event, `401` bad secret, `404` not configured.

```bash
curl -X POST http://localhost:8090/world-events \
  -H "authorization: Bearer $WORLD_HOOKS_SECRET" -H "content-type: application/json" \
  --data @deploy/worldhooks/sample-customer-feedback.json
```

## Swarm config

Routes live in `deploy/worldhooks/world-hooks.json` (pointed at by `WORLD_HOOKS_FILE`). Each route: `owner`, `ownerScopeId` (default `matt` / `personal:matt`), `action` (standing orders), optional `swarm.workers: [{ role, name, brief }]`.

`customer_feedback.detected` ships with three workers: **Context** (who is this person/company via GBrain), **Product** (similar feedback, count customers, draft issue, don't file), **Follow-up** (find the commitment + asset, draft reply, mark awaiting approval, never send). The woken root agent calls QM's native `POST /v1/swarm {"action":"spawn", "requestId":"world:<event id>", "contexts":[...]}`, broadcasts the event, tails replies, and returns one summary.

## Verified locally (2026-09-27)

Note: this run used the old Alex/Syla/Canvas story, kept as a record. The current demo is Stephen + Matthew + Opal (`demo_inject.py`, see CLAUDE.md).

curl of a `customer_feedback.detected` event -> `202` -> root turn woke in `personal:matt` -> root called `/v1/swarm` spawn -> 3 worker sessions, each on its own local-docker computer -> workers reported back via swarm messages -> root returned: who (Alex, unresolved beyond the event), draft issue "Simplify Canvas onboarding and initial setup", draft reply to Alex, and "awaiting approval: filing the issue and sending the reply. Nothing was sent externally." Context worker could not resolve Alex because GBrain is not wired into QM yet. Harness was `codex` via `~/.codex/auth.json`; roughly 4 minutes wall clock for the whole swarm.

## Run it locally

```bash
cd ~/dev/qm && npm ci
# Postgres (swarms need SESSION_STORE=postgres + RUN_STORE=postgres)
# Docker running + `npm run sandbox:local:build` (workers each get a sandbox computer)
node --env-file=qm.env src/index.ts
```

Minimal `qm.env`: `PORT`, `ORG_ID`, the five distinct secrets (`CORE_SIGNING_SECRET`, `CAPABILITY_SECRET`, `PORTAL_IDENTITY_SECRET`, `CONNECTOR_SECRET_KEY`, `PORTAL_SESSION_SECRET`, plus `SKILL_SIGNING_SECRET`), `DATABASE_URL`, `SESSION_STORE=postgres`, `RUN_STORE=postgres`, `ARTIFACT_STORE=postgres`, `HARNESS` + model auth, `SANDBOX_BACKEND=local`, `SANDBOX_RESOURCES_ENABLED=true` (without it swarm workers fail with "sandbox management is disabled"), `PUBLIC_API_URL=http://host.docker.internal:<port>`, `WORLD_HOOKS_FILE`, `WORLD_HOOKS_SECRET`.

## Memorable

QM has a native Memorable provider (`docs/memory-providers.md` in the fork): set `MEMORY_PROVIDER_CONFIG` with a `{ "type": "memorable" }` provider routed to the `personal` scope with `capture: "automatic"`. QM derives a tool-call trace per turn and runs `memorable record`; recall runs `memorable inject` and appends to the prompt. Needs `npm i -g memorable-cli@latest` (>= 0.5.9), `MEMORABLE_API_URL`, `MEMORABLE_API_KEY`, and per-scope consent: `MEMORABLE_BACKEND=qm MEMORABLE_DB_URL=<QM postgres> memorable enable --scope personal:matt`. Traces live in QM's Postgres.

## GBrain

Two options in QM: register GBrain as an MCP connector (admin, `docs/mcp-connectors.md`) so workers get its tools, or as an `mcp` memory provider in `MEMORY_PROVIDER_CONFIG` (needs OAuth client-credential pairs, no static bearer).

## What matt must provide

- A model credential with credit: `ANTHROPIC_API_KEY` (pi harness), or a funded `OPENAI_API_KEY`, or `HARNESS=codex` with `~/.codex/auth.json` (local dev only; this is what worked today). The shell's `OPENAI_API_KEY` is out of credits.
- Docker running (OrbStack) plus the local sandbox image built, or a hosted sandbox account (E2B, Modal, Sprites, etc.).
- Memorable: `MEMORABLE_API_URL` + `MEMORABLE_API_KEY`.
- GBrain reachable from QM as an MCP connector (URL + credentials).
- A real `WORLD_HOOKS_SECRET` shared with the world service.
- For a hosted deploy: Fly.io or AWS account with billing, admin email, Resend key or SMTP for sign-in.
