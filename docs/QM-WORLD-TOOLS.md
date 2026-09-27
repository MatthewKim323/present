# WORLD tools in QM

QM registers HTTP MCP connectors. The project's `.mcp.json` starts a stdio adapter for local MCP clients; it does not register tools inside QM. `quest/scripts/world-mcp-http.mjs` exposes the same eight WORLD tools over authenticated HTTP, including panel commands, selection receipts, people, health, and Builder jobs.

Inspected QM source: [MatthewKim323/qm, branch worldhooks, commit af7fa6967982cd93c187a783e55590b82d3d781a](https://github.com/MatthewKim323/qm/tree/af7fa6967982cd93c187a783e55590b82d3d781a). The `worldhooks` branch contains the WORLD event, watch, entity, and run routes; the inspected `main` branch does not. MCP registration itself is already supported by both.

## Start the adapter

Supply the token through your secret environment configuration, then run from the WORLD repository root:

```sh
WORLD_URL=http://127.0.0.1:8787 node quest/scripts/world-mcp-http.mjs
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORLD_MCP_TOKEN` | Required | Bearer token accepted by the adapter. Use a dedicated strong secret; never commit it. |
| `WORLD_URL` | `http://127.0.0.1:8787` | WORLD backend destination. Set `8790` only when intentionally using the isolated development backend. |
| `WORLD_MCP_HOST` | `127.0.0.1` | Bind address. Set explicitly if QM must connect from another host or container. |
| `WORLD_MCP_PORT` | `8788` | Adapter port. |

The HTTP endpoint is `/mcp`. It accepts JSON-RPC `tools/list` and `tools/call` without a preceding initialization request, matching QM's client. Requests must include the bearer token and `Content-Type: application/json`. Bodies are limited to 1 MiB. Browser `Origin` requests are rejected; use the existing frontend API rather than calling this connector from a browser. No CORS access is granted.

QM must be able to reach the adapter's configured address. `127.0.0.1` refers to QM's own machine or container, so it is appropriate only when both processes share that network namespace. Use a reachable trusted-network address or an HTTPS reverse proxy for remote QM. Do not forward the MCP token into frontend configuration.

## Register with QM

Through the authenticated QM admin API, send **`PUT /v1/admin/mcp-servers/world`** with this body, substituting the adapter address and secret at runtime:

```json
{
  "name": "WORLD",
  "url": "http://127.0.0.1:8788/mcp",
  "auth": "bearer",
  "bearerToken": "<WORLD_MCP_TOKEN>",
  "credentialScope": "shared",
  "readOnly": false,
  "enabled": true,
  "validate": true
}
```

The request requires an authenticated QM administrator with an admin grant. Its admin authentication is separate from both `WORLD_MCP_TOKEN` and `WORLD_HOOKS_SECRET`. Follow that QM deployment's admin authentication; neither WORLD token authorizes this registration endpoint.

`validate: true` probes `tools/list` before saving. A successful response includes the discovered tools. `GET /v1/admin/mcp-servers` shows registered servers and the loaded tool catalog. QM refreshes discovery after registry changes and periodically; registration names namespace tools as follows:

| WORLD tool | Name exposed by QM |
| --- | --- |
| `world_panel` | `world_world_panel` |
| `world_panel_actions` | `world_world_panel_actions` |
| `world_panels` | `world_world_panels` |
| `world_status` | `world_world_status` |
| `world_people` | `world_world_people` |
| `world_jobs` | `world_world_jobs` |
| `world_job` | `world_world_job` |
| `world_dispatch` | `world_world_dispatch` |

`readOnly: false` is necessary because this connector can change panels and start Builder jobs. `world_dispatch` performs real coding work and must only be used for authorized work. A panel selection is intent, not evidence that the selected action has been executed. Read `world_panel_actions` with the last returned cursor, perform the authorized work once, and update the panel with the result. The selection queue is bounded and currently belongs to the WORLD process; it is not a durable job queue.

## WorldHooks are a separate connection

WORLD sends perception events into QM's `/world-events` with `WORLD_HOOKS_SECRET`. QM can also report worker updates back to WORLD using `WORLD_HUD_URL`. Neither direction automatically installs this MCP connector.

The inspected branch additionally exposes `GET /world-runs`, `GET/POST /world-watches`, `DELETE /world-watches/:id`, `GET /world-entities`, and `POST /world-entities/adopt`. WORLD proxies them through `/qm/*` using the server-side WorldHooks secret. Set a separate `WORLD_QM_ACCESS_TOKEN` on the WORLD backend, then enter that token in the frontend's **service → qm** view. The frontend keeps it in page memory and sends it only to `/qm/*`; it never receives `WORLD_HOOKS_SECRET`. Without `WORLD_QM_ACCESS_TOKEN`, WORLD returns 503 for these routes. See the fork's [WorldHooks documentation](https://github.com/MatthewKim323/qm/blob/af7fa6967982cd93c187a783e55590b82d3d781a/docs/worldhooks.md).

## Verification

```sh
cd quest
node --test tests/world-mcp-http.test.js tests/world-mcp.test.js
```

These tests exercise local HTTP discovery, tool calls, unauthorized requests, origin rejection, payload bounds, errors, and mutation non-retry against injected API implementations. They do not register a live QM connector or execute a sponsor workflow.
