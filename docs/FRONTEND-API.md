# Frontend and agent integration

The header's **service** drawer connects to the configured world service through Vite's same-origin proxy (`WORLD_URL`, default `http://localhost:8787`). Opening it performs reads only. Health reports unavailable/stub integrations as returned by the server; it does not imply sponsor credentials are configured.

| Surface | Routes |
| --- | --- |
| Overview | `GET /health`, `GET /people` |
| Builds and detail | `GET /builder/jobs`, `GET /builder/jobs/{job_id}` |
| Explicit start build | `POST /builder/dispatch` |
| Tool schema and commands | `GET /tools`, `POST /tools/world-panel` |
| Panels and selections | `GET /panels`, `GET /panel-actions?after=…` |
| Collapsed diagnostic inputs | `POST /events`, `/hud`, `/procedures`, `/debug/utterance`, `/debug/end-conversation` |

`/ws/quest` remains the live frontend transport: person cards, context deltas, memory results, worker activity, build/PR state, preview screenshots, and panel receipts. `/ws/hud` is the receive-only spectator transport; the interactive frontend needs `/ws/quest` to send selections, enrollment, and dev actions.

Sending a panel from the drawer connects the live HUD first. The server replays active panels on connection; show/update/dismiss broadcasts then keep viewers in sync. A selection sends a request ID over the socket, receives its correlated receipt, and appears in the cursor-based action queue. A receipt means intent was recorded, not that any external action completed.

## Agent tools

The project `.mcp.json` now includes the local `world` stdio server. Start the MCP client with the repository as its working directory and reload its project MCP configuration. Node 20+ is required. Existing hosted GBrain configuration is preserved. The checked-in local entry currently points at port 8790, matching the isolated backend used by the running frontend on 5175; change it to your actual world-service address for live sponsor work. The CLI default remains 8787.

```
WORLD_URL=http://127.0.0.1:8787 node quest/scripts/world-mcp.mjs
```

Tools: `world_panel`, `world_panel_actions`, `world_panels`, `world_status`, `world_people`, `world_jobs`, `world_job`, `world_dispatch`. The panel schema comes directly from `contracts/PANELS.json`. The adapter forwards requests to the same HTTP routes used by the frontend. It does not retry mutations. `world_dispatch` starts actual coding work; the agent must already have authorization for that work.

For QM running on another machine/container, register the adapter there and point `WORLD_URL` at an address reachable from that runtime (container localhost is not the host). The separate QM checkout/runtime is absent on this workstation, so that registration was not changed or verified. HTTP-native tool executors can still discover `world_panel` from `GET /tools` and post arguments to `/tools/world-panel`.

Agents should save the action response cursor and pass it on the next read. The queue is bounded, not a durable job system. Agents own interpreting selections and executing their authorized workflows. Person pinches currently refresh context, not create entity-bound agents; no watch CRUD or procedure-history API exists in this backend.

## Verification

Frontend tests cover every HTTP method/body, errors, cancellation, MCP discovery/dispatch, and XR preview input. Browser smoke tested service reads and panel show → WebSocket render → user selection → receipt → MCP action-queue read against an isolated backend. No live build, GitHub review/comment, sponsor write, microphone capture, or external agent run was triggered by these checks.
