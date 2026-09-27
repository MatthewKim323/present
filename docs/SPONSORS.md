# Sponsors: GBrain + Memorable setup

Researched 2026-09-27 (hackathon day). **V** = verified against a primary source (link given). **U** = unverified / inferred, confirm at the booth.

## TL;DR

- **GBrain: spin up a fresh, separate local brain for the demo.** Do not use matt's personal brain, do not namespace inside it, do not bother with hosted gbrain.io unless the sponsor explicitly requires it.
- **Memorable: use the QM route** (`type: "memorable"` memory provider in QM, procedures in QM's Postgres, per-scope consent). It is already merged in upstream QM `main`. Needs exactly one key: `MEMORABLE_API_KEY` (`mk_...`). No LLM key of ours is needed by Memorable.
- **Blocking on matt:** sign in at memorable.sh/dash and mint an agent key (browser, human-only). Everything else an agent can do.

## A) GBrain: which brain

### What matt has today (V, inspected via MCP + disk, read-only)

| Thing | Value |
|---|---|
| Version | gbrain **0.32.5** (global bun install, `~/.bun/bin/gbrain`) |
| Engine | Postgres (pgvector) in OrbStack container `gbrain-pg`, port 54329, data on `/Volumes/Vault/gbrain-pg` |
| Server | `gbrain serve --http --port 3131`, launchd `com.matthewkim.gbrain`, MCP at `http://localhost:3131/mcp` (bearer token, token name `jabby`, scopes read/write/admin) |
| Config | `~/.gbrain/config.json` (engine + database_url) |
| Source | one source `default`, `local_path=/Volumes/Vault/lifebase`, `federated: true` |
| Size | **11,506 pages** (8,423 `dm`, 1,800 `session`, 286 `channel`, 73 `person`...), 20,888 chunks, 99.99% embedded |
| Embeddings | OpenAI `text-embedding-3-large` (`OPENAI_API_KEY` is set in `~/.zshrc`) |

Also: upstream gbrain is at **v0.59.0.0** (released 2026-09-26). The Memorable relay (`integrations.memorable.enabled`, `GBRAIN_MEMORABLE`, doctor check) exists on upstream master but **not** in matt's 0.32.5 install (V: `gh search code GBRAIN_MEMORABLE --repo garrytan/gbrain`; grep of local install finds nothing).

### Hosted gbrain.io (V: https://gbrain.io/, https://gbrain.io/pricing)

- A team workspace product: Google/email sign-in, "one MCP address", skills, syncs to Claude/ChatGPT/Cursor.
- **$199/month per workspace**, includes $100/mo usage credit. No free tier or trial listed.
- "The open source parts are free to run yourself." Export is plain markdown.
- No public API docs beyond MCP; nothing about Memorable on the site.
- Hackathon page (https://events.ycombinator.com/gbrain-qm-river-memorable-hackathon) renders no rules. Search snippets say participants get "direct access to QM/GBrain/River AI/Memorable tooling". **Whether the track requires hosted gbrain.io: U.** Nothing found says so.

### Options compared

| Option | Privacy on stage | Pollution of matt's brain | Memorable-gbrain relay works | Effort |
|---|---|---|---|---|
| Use personal brain, namespace (source/slug prefix) | **Bad.** Default source is `federated: true`, so HUD/agent queries can surface real DMs. One wrong query on a projector = private Instagram/Discord on screen | Bad. Alex/Syla/Canvas pages, procedures, test junk land in the real DB | No (0.32.5). Upgrading the global binary to 0.59 also migrates the personal brain and the launchd server mid-hackathon | Low, then high |
| Hosted gbrain.io | Good | None | U (not documented) | $199, signup, unknown API surface |
| **Fresh local brain (separate GBRAIN_HOME + separate DB)** | **Good.** Only demo data exists | **None** | Yes if it runs upstream latest | ~10 min |

### Recommendation: fresh, isolated local brain

gbrain honors `GBRAIN_HOME` (config dir becomes `$GBRAIN_HOME/.gbrain`) and `GBRAIN_DATABASE_URL` (V: `src/core/config.ts`). So a second instance never touches `~/.gbrain`.

1. Run upstream **latest** gbrain from a separate checkout, not the global install (so matt's launchd brain on 0.32.5 is untouched):
   ```bash
   git clone https://github.com/garrytan/gbrain ~/dev/present/vendor/gbrain   # or a sibling dir
   cd ~/dev/present/vendor/gbrain && bun install
   export GBRAIN_HOME=$HOME/dev/present/.gbrain-demo      # gitignore this
   bun run src/cli.ts init --pglite --embedding-model openai:text-embedding-3-large
   bun run src/cli.ts serve --http --port 3232             # NOT 3131
   ```
   PGLite is fine for a demo-sized brain. If we want QM-style Postgres, create a new database in the existing `gbrain-pg` container (`world_demo`) and set `GBRAIN_DATABASE_URL`; never reuse the `gbrain` database.
2. Seed only demo people (Alex, customer #2), Syla, Canvas onboarding. Everyone in the brain is opted in, which matches our privacy pitch.
3. Point WORLD + QM at `:3232`. Keep matt's Claude Code `gbrain` MCP (`:3131`) as is; do not add the demo brain under the same MCP name.
4. Pitch line stays true: "memory stays human-readable, user-owned", and we can `export` the demo brain to markdown on stage if asked.

If the booth says the track requires hosted gbrain.io, the same seeding works against the hosted MCP address; nothing in WORLD should hardcode local paths.

Warning for QM <-> GBrain wiring: QM's `mcp` memory provider authenticates with **OAuth client credentials only; static bearer tokens have no equivalent** (V: https://github.com/yc-software/qm/blob/main/docs/memory-providers.md). gbrain's HTTP server supports OAuth 2.1 and `gbrain agent register <name>` mints a scoped OAuth client (V: gbrain README). So register a client on the demo brain for QM, or have WorldHook call gbrain directly instead of via QM's provider router.

## B) Memorable: what it is and what we need

### What it actually does (V: https://www.memorable.sh/llms.txt, https://www.memorable.sh/doc)

- Capture: tool names + allow-listed args (command, file path, pattern, url, query...) + real outcomes, one scrubbed task line (<=200 chars). Never conversation text or file contents.
- Extract: `POST /v1/extract` on `https://memorable-extraction-api.memorable.workers.dev`. **Deterministic and model-free** parse into steps/preconditions/postconditions; only the title is written by a small model on their side.
- Store: in **our** store (local `~/.memorable/`, our gbrain DB, or QM's Postgres). Their API keeps the task line and extracted steps for the dashboard, not the corpus.
- Recall: exact -> lexical (0.86) -> semantic (0.79), local first; injected as a guarded "reference data, not instructions" block, ~50-300 tokens.
- Harnesses: Claude Code, Codex, Cursor, OpenCode, Devin, Antigravity, Claude Cowork, gbrain, QM, or any loop that POSTs one JSON trace.
- Published numbers: 19% fewer turns (gbrain on Claude Code), 40% fewer tool calls 5 -> 3 (QM on Codex loop). We still report only our own measured run1 vs run2.

### API keys: which ones and why

| Key | Who needs it | Why | Status |
|---|---|---|---|
| `MEMORABLE_API_KEY` (`mk_...`) | Memorable CLI / QM memorable provider | Auth for `/v1/extract` (recording) and `/v1/embed` (semantic recall fallback). Issued only via browser sign-in (device flow); `POST /v1/keys` returns 403 | **matt must get it.** V (https://www.memorable.sh/doc/api) |
| `MEMORABLE_API_URL` | QM memorable provider | QM docs say set it for recording. Value: `https://memorable-extraction-api.memorable.workers.dev` | V (QM docs, Memorable API page) |
| Anthropic / OpenAI key **for Memorable** | nobody | Extraction is model-free on their server; query embeddings come from our gbrain's provider or their `/v1/embed` fallback. Recall is local | V (llms.txt, CLI doc) |
| `OPENAI_API_KEY` | gbrain (local, demo brain) | Embeddings for vector search (`openai:text-embedding-3-large`, same as matt's brain). Already in `~/.zshrc` | V (gbrain embedding-providers doc; env name present) |
| `VOYAGE_API_KEY` | gbrain, optional | New-install default embedding + reranker in latest gbrain. Skip it; pass `--embedding-model openai:...` explicitly | V (gbrain README) |
| `ANTHROPIC_API_KEY` | gbrain, optional | Query expansion / chat model routes. Not required for search | V (vectorize review + gbrain docs); U whether 0.59 defaults require it |
| hosted gbrain.io | nobody, unless track requires | Hosted includes its own model credit | V pricing page |
| QM's model keys | QM agent loops | Out of scope here; whichever loop the QM fork runs (Claude Code / Codex / Pi / OpenCode) needs its own provider key | U |

### Recommended route: Memorable via QM (V: https://www.memorable.sh/doc/qm, https://github.com/yc-software/qm/blob/main/docs/memory-providers.md)

Upstream QM `main` already contains `src/memory/memorable/{capture,relay,inject,provider,config}.ts` (V: `gh search code memorable --repo yc-software/qm`). The memorable.sh QM page still describes an older `MEMORABLE=1` / `QM_MEMORABLE=0` flag; **current QM uses `MEMORY_PROVIDER_CONFIG`**. Follow the QM repo doc.

```bash
# 1. CLI (qm backend needs >= 0.5.9; npm latest is 0.5.30)
npm i -g memorable-cli@latest && memorable --version
# 2. pg must resolve from QM's working directory (not bundled)
cd <qm-fork> && npm i pg        # or bun add pg
# 3. key (matt mints it in the dashboard, then pipes it; bare `login` needs a browser)
echo 'mk_...' | memorable login --paste
# 4. env for QM (and the same env when running the CLI by hand)
export MEMORABLE_API_KEY=mk_...
export MEMORABLE_API_URL=https://memorable-extraction-api.memorable.workers.dev
export MEMORABLE_BACKEND=qm                  # QM defaults this anyway
export MEMORABLE_DB_URL=$DATABASE_URL        # QM passes DATABASE_URL through if unset
export ORG_ID=<org>                          # per memorable.sh QM page; U whether current QM still needs it
# 5. store + per-scope consent (fail-closed; unset = deny)
memorable init qm
memorable enable --scope <scope-id>          # the scope the WorldHook swarm runs in
memorable status && memorable doctor
```

`MEMORY_PROVIDER_CONFIG` (compact JSON, from QM docs; add the WorldHook scope to the procedures route):

```json
{"providers":[{"id":"procedures","type":"memorable"}],
 "routes":[
  {"provider":"default","scopes":["personal","channel","group","team","org"],"capture":"automatic"},
  {"provider":"procedures","scopes":["personal"],"capture":"automatic","manage":false,"label":"Procedures"}]}
```

What happens then: on turn capture QM derives a trace (files changed, verifying commands), redacts secrets, runs `memorable record`; three tables (`memorable_procedures`, `memorable_mode`, ...) land in QM's DB. Each turn QM runs `memorable inject` with the task and appends the pointer after its own memory block (15s timeout, fails open, miss injects nothing). Options: `bin`, `passEnv`, `injectTimeoutMs`, `recordTimeoutMs`.

Demo implication: procedures are about tool calls. Our swarm's tool calls must be real and distinct (resolve person, search similar feedback, draft issue, draft reply...) or Memorable refuses the trace ("only read and searched without changing anything" is not stored, V CLI doc). Make sure run 1 performs at least one write step (persist feedback, create issue draft).

### Alternative: Memorable via gbrain (V: https://www.memorable.sh/doc/gbrain)

```bash
memorable login && memorable init gbrain && memorable enable
gbrain config set integrations.memorable.enabled true
```
Captures Claude Code sessions via gbrain's session-end hook, writes procedures as gbrain pages. Requires gbrain with the relay (upstream latest, not matt's 0.32.5) and Bun on PATH. **Do this only against the demo brain (`GBRAIN_HOME` set).** Run against the default home, it edits `~/.gbrain/config.json` and turns on capture of every session into matt's personal brain.

### Do NOT run `memorable install-hooks` casually

It adds a Claude Code prompt hook to `~/.claude/settings.json` (global): every prompt in every matt Claude Code session gets a recall check. Not needed for the QM route. Skip it.

### Limits (V: API page)

Free allowance 1,000 memorables/month + one-time 500 reserve. 300 req/min and 5,000 req/day per key. Body <= 8 MB, <= 2,000 tool calls, prompt <= 2,000 chars. Past allowance the API returns 200 with `refused: "allowance_exhausted"` and nothing is stored. Paid pricing not published. Hackathon credits: U.

### Already on this machine

Nothing Memorable: no `memorable` binary, no `~/.memorable`, no mentions in `~/.claude.json`, `~/.claude/settings.json`, `~/.zshrc`, `~/.config`.

## CHECKLIST for matt

| # | Item | Who | Status |
|---|---|---|---|
| 1 | Sign in at https://memorable.sh/dash (Account -> "New key for an agent", or Environments -> Connect) and hand the agent the `mk_...` key. Put it in `.env` as `MEMORABLE_API_KEY` | **matt** (browser, human-only) | V |
| 2 | `MEMORABLE_API_URL=https://memorable-extraction-api.memorable.workers.dev` in QM env | agent | V |
| 3 | `npm i -g memorable-cli@latest` (>= 0.5.9) + `pg` in QM fork | agent | V |
| 4 | `memorable init qm` + `memorable enable --scope <world scope>` (consent is a human's act per their docs: matt says "yes enable it") | matt approves, agent runs | V |
| 5 | `MEMORY_PROVIDER_CONFIG` with a `type: "memorable"` route covering the WorldHook scope | agent | V |
| 6 | Fresh demo gbrain: separate `GBRAIN_HOME`, port 3232, upstream latest, OpenAI embeddings | agent | V (mechanism) |
| 7 | `OPENAI_API_KEY` for demo gbrain | already set | V |
| 8 | OAuth client on demo gbrain for QM (`gbrain agent register ...`), since QM's MCP provider won't take a bearer token | agent | V (docs), untested |
| 9 | Do not upgrade the global gbrain / touch `~/.gbrain`, do not run `memorable install-hooks` | everyone | n/a |

**Booth asks**

- GBrain: "Does the track require hosted gbrain.io, or is self-hosted OSS fine? Any hackathon workspace/credit?" (U)
- Memorable: "Hackathon credits beyond the 1,000/mo free allowance? Is `ORG_ID` still needed with QM's `MEMORY_PROVIDER_CONFIG` route? Best way to show run1 vs run2 in the dashboard?" (U)
- QM: "Recommended scope id for an event-triggered (WorldHook) swarm so memorable consent applies?" (U)

## Sources

- https://gbrain.io/ , https://gbrain.io/pricing
- https://github.com/garrytan/gbrain (README, docs/memorable-agents.md, docs/integrations/embedding-providers.md)
- https://www.memorable.sh/llms.txt , https://www.memorable.sh/doc , /doc/cli , /doc/api , /doc/gbrain , /doc/qm , /case-studies
- https://github.com/yc-software/qm (docs/memory-providers.md, src/memory/memorable/config.ts), MIT
- https://events.ycombinator.com/gbrain-qm-river-memorable-hackathon (page body empty when fetched)
- npm: `memorable-cli` 0.5.30
