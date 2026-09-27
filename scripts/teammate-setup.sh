#!/usr/bin/env bash
# One-time setup to run your own WORLD stack (world service + Quest client) on your laptop.
#   scripts/teammate-setup.sh        install everything, check keys, sign into gbrain.io, fetch models
#   scripts/teammate-setup.sh run    start world service (:8787) + Quest client (:5173), print the URL
# QM stays on matt's laptop (Docker + Postgres). Your stack runs without it: perception, GBrain, HUD.
# Builder stays OFF here (BUILDER_AUTO=0) so two laptops never open duplicate PRs on Opal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"; mkdir -p "$LOGS"
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

if [ "${1:-}" = "run" ]; then
  (cd "$ROOT/perception" && WORLD_PORT=8787 BUILDER_AUTO=0 nohup uv run python -m perception >"$LOGS/world.log" 2>&1 & echo $! >"$LOGS/world.pid")
  (cd "$ROOT/quest" && WORLD_URL=http://localhost:8787 nohup npm run dev >"$LOGS/quest.log" 2>&1 & echo $! >"$LOGS/quest.pid")
  for _ in $(seq 1 60); do curl -sf -o /dev/null localhost:8787/health && break; sleep 1; done
  curl -s localhost:8787/health | python3 -c 'import sys,json;h=json.load(sys.stdin);print("  world up · gbrain", "up" if h["gbrain"]["up"] else h["gbrain"]["backend"], "· enrolled", h["enrolled"])' || bad "world service not up, see .logs/world.log"
  LAN=$(ipconfig getifaddr en0 2>/dev/null || echo localhost)
  echo; echo "  Quest Browser: https://$LAN:5173   (not private warning -> Advanced -> Proceed)"
  echo "  If the wifi blocks it: cloudflared tunnel --url https://localhost:5173 --no-tls-verify  (use the trycloudflare URL)"
  echo "  Stop: kill \$(cat .logs/world.pid .logs/quest.pid)"
  exit 0
fi

echo "WORLD teammate setup"
command -v uv >/dev/null || { echo "  installing uv"; brew install uv; }
command -v node >/dev/null || { bad "install Node 20+ first (brew install node)"; exit 1; }
ok "uv + node"

cd "$ROOT/perception"
uv sync -q && ok "python deps"
[ -f models/face_detection_yunet_2023mar.onnx ] || uv run python scripts/fetch_models.py
ok "face models"

# keys: perception/.env (ANTHROPIC_API_KEY) and .env.memorable at the repo root (MEMORABLE_API_KEY, MEMORABLE_API_URL)
grep -q '^ANTHROPIC_API_KEY=' .env 2>/dev/null && ok "perception/.env has ANTHROPIC_API_KEY" || bad "add ANTHROPIC_API_KEY=... to perception/.env"
grep -q '^MEMORABLE_API_KEY=' "$ROOT/.env.memorable" 2>/dev/null && ok ".env.memorable present" || bad "create .env.memorable at the repo root with MEMORABLE_API_KEY=... and MEMORABLE_API_URL=https://memorable-extraction-api.memorable.workers.dev"

# gbrain.io: sign in as yourself (you're a member of matt's workspace); memory scope only
if [ -f .env.gbrain ] && uv run python -m perception.gbrain_auth --check >/dev/null 2>&1; then ok "gbrain.io signed in"
else echo "  opening browser for gbrain.io sign-in (approve memory access)"; uv run python -m perception.gbrain_auth; fi

# faces: enrollment is local. Either photos of matt in data/enroll/matthew/*.jpg, or matt AirDrops perception/data/people.json
if [ -f data/people.json ]; then ok "enrolled: $(python3 -c 'import json;print(", ".join(json.load(open("data/people.json")).get("people",{}).keys()) or "none")' 2>/dev/null)"
elif ls data/enroll/*/*.jpg >/dev/null 2>&1; then uv run python -m perception.enroll --from-dir data/enroll/ && ok "enrolled from photos"
else bad "no faces enrolled: put photos in perception/data/enroll/matthew/ and rerun, or get people.json from matt"; fi

cd "$ROOT/quest" && ([ -d node_modules ] || npm install --no-audit --no-fund >/dev/null) && ok "quest deps"
echo; echo "  Done. Start it with: scripts/teammate-setup.sh run"
