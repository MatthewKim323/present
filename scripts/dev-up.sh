#!/usr/bin/env bash
# One command for the whole WORLD stack on this laptop.
#   scripts/dev-up.sh            QM + world service + Quest client (LAN)
#   scripts/dev-up.sh --tunnel   same, plus an ngrok https URL for a headset not on this wifi
#   scripts/dev-up.sh down       stop everything this script started
#   scripts/dev-up.sh status     health of each piece
# Logs go to .logs/. Keys stay on this machine (perception/.env, .env.memorable, perception/.env.gbrain).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"; mkdir -p "$LOGS"
QM_DIR="${QM_DIR:-$HOME/dev/qm}"
WORLD_PORT="${WORLD_PORT:-8787}"
LAN="$(ipconfig getifaddr en0 2>/dev/null || echo localhost)"

pidfile() { echo "$LOGS/$1.pid"; }
running() { [ -f "$(pidfile "$1")" ] && kill -0 "$(cat "$(pidfile "$1")")" 2>/dev/null; }
start() {  # name, dir, command...
  local name=$1 dir=$2; shift 2
  if running "$name"; then echo "  $name already running"; return; fi
  (cd "$dir" && nohup "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$(pidfile "$name")")
  echo "  $name started (log .logs/$name.log)"
}
stop() {
  local name=$1
  if running "$name"; then kill "$(cat "$(pidfile "$name")")" 2>/dev/null || true; echo "  $name stopped"; fi
  rm -f "$(pidfile "$name")"
}
wait_http() {  # url, seconds
  for _ in $(seq 1 "$2"); do curl -skf -o /dev/null "$1" && return 0; sleep 1; done; return 1
}

case "${1:-up}" in
  down)
    for n in ngrok quest world qm; do stop "$n"; done
    exit 0 ;;
  status)
    curl -s "localhost:$WORLD_PORT/health" | python3 -c 'import sys,json;h=json.load(sys.stdin);print("world  ok · gbrain",h["gbrain"],"· enrolled",h["enrolled"],"· qm",h["qm_url"])' 2>/dev/null || echo "world  down"
    { curl -skf -o /dev/null "https://localhost:5173/" || curl -sf -o /dev/null "http://localhost:5173/"; } && echo "quest  ok" || echo "quest  down"
    curl -sf -o /dev/null "localhost:8091/healthz" && echo "qm     ok" || echo "qm     down (or not on :8091)"
    exit 0 ;;
esac

TUNNEL=0; [ "${1:-}" = "--tunnel" ] && TUNNEL=1
echo "WORLD dev stack"

if [ -x "$QM_DIR/scripts/world-dev.sh" ]; then
  start qm "$QM_DIR" scripts/world-dev.sh up  # runs in the foreground, so background it like the rest
fi

[ -f "$ROOT/perception/.env.gbrain" ] || echo "  note: no perception/.env.gbrain, GBrain falls back to the local stub (run: cd perception && uv run python -m perception.gbrain_auth)"
start world "$ROOT/perception" env WORLD_PORT="$WORLD_PORT" BUILDER_AUTO="${BUILDER_AUTO:-1}" QM_URL="${QM_URL:-http://localhost:8091}" uv run python -m perception
[ -d "$ROOT/quest/node_modules" ] || (cd "$ROOT/quest" && npm install --no-audit --no-fund >"$LOGS/quest-install.log" 2>&1)
start quest "$ROOT/quest" env WORLD_URL="http://localhost:$WORLD_PORT" npm run dev

wait_http "http://localhost:$WORLD_PORT/health" 60 && echo "  world up" || echo "  world not answering yet, see .logs/world.log"
wait_http "https://localhost:5173/" 30 && echo "  quest up" || echo "  quest not answering yet, see .logs/quest.log"

URL="https://$LAN:5173/"
if [ "$TUNNEL" = 1 ]; then
  start ngrok "$ROOT" ngrok http "https://localhost:5173" --log stdout
  for _ in $(seq 1 20); do
    T=$(curl -s localhost:4040/api/tunnels | python3 -c 'import sys,json;print(next((t["public_url"] for t in json.load(sys.stdin)["tunnels"] if t["public_url"].startswith("https")),""))' 2>/dev/null || true)
    [ -n "$T" ] && break; sleep 1
  done
  [ -n "${T:-}" ] && URL="$T/" || echo "  ngrok url not ready, see .logs/ngrok.log"
fi

cat <<MSG

Open on the Quest (Quest Browser):
  $URL
  1. tap "Camera + mic" and accept both prompts, 2. tap "Enter AR"
  no server needed:  ${URL}?mock=1
Before a take:  cd perception && uv run python scripts/seed_gbrain.py --reset
Health:  scripts/dev-up.sh status      Stop:  scripts/dev-up.sh down
MSG
