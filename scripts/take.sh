#!/usr/bin/env bash
# One command before each take: checks the whole stack, fixes what it can, prints a green/red checklist.
#   scripts/take.sh                     check + fix (gc docker, reset GBrain seeds, reset HUD)
#   scripts/take.sh --fresh-face        also forget matthew's face so the "I'm Matthew" learning moment happens
#                                       (people.json is backed up first; a plain take.sh restores it)
#   scripts/take.sh --clear-procedures  move local Builder drafts (perception/data/procedures/*.json) aside
#   scripts/take.sh --keep-procedures   leave them (default)
#   scripts/take.sh --dry               check only, change nothing
# Never touches QM's Memorable tables (that needs matt's say-so).
set -uo pipefail
ROOT="${WORLD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
QM_DIR="${QM_DIR:-$HOME/dev/qm}"
WORLD="${WORLD_URL:-http://localhost:${WORLD_PORT:-8787}}"
QM="${QM_URL:-http://localhost:8091}"
DATA="$ROOT/perception/data"
REPO="${BUILDER_REPO:-qtzx06/opal}"; DEMO_PR="${DEMO_PR:-6}"

FRESH=0; CLEAR=0; DRY=0
for a in "$@"; do case "$a" in
  --fresh-face) FRESH=1 ;; --clear-procedures) CLEAR=1 ;; --keep-procedures) CLEAR=0 ;; --dry|--dry-run) DRY=1 ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  *) echo "unknown flag $a"; exit 2 ;;
esac; done

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; D=$'\e[2m'; N=$'\e[0m'; else G= R= Y= D= N=; fi
FAILS=0; WARNS=0
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; FAILS=$((FAILS+1)); }
warn() { echo "  ${Y}!${N} $*"; WARNS=$((WARNS+1)); }
fix()  { if [ "$DRY" = 1 ]; then echo "    ${D}(dry) would: $*${N}"; return 1; fi; echo "    ${D}fixing: $*${N}"; return 0; }

envval() { [ -f "$1" ] && grep -E "^(export +)?$2=" "$1" | tail -1 | sed -E "s/^(export +)?$2=//; s/^[\"']//; s/[\"']\$//"; }
TOKEN="${DIRECTOR_TOKEN:-${WORLD_HOOKS_SECRET:-$(envval "$ROOT/perception/.env" DIRECTOR_TOKEN)}}"
[ -n "$TOKEN" ] || TOKEN="$(envval "$ROOT/perception/.env" WORLD_HOOKS_SECRET)"
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "authorization: Bearer $TOKEN")
director() { curl -sf -m 10 ${AUTH[@]+"${AUTH[@]}"} -H 'content-type: application/json' -X POST "$WORLD/director/api/action" -d "{\"action\":\"$1\"}"; }
health() { curl -sf -m 5 "$WORLD/health"; }
TO=""; command -v timeout >/dev/null && TO="timeout 20"
hj() { python3 -c "import sys,json;h=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "WORLD take check $(date +%H:%M:%S)$([ "$DRY" = 1 ] && echo ' (dry)')"

# 1. services -----------------------------------------------------------
H="$(health)"; QMOK=0; curl -sf -m 3 -o /dev/null "$QM/healthz" && QMOK=1
if { [ -z "$H" ] || [ "$QMOK" = 0 ]; } && fix "scripts/dev-up.sh (starts whatever is down)"; then
  "$ROOT/scripts/dev-up.sh" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do H="$(health)"; curl -sf -m 3 -o /dev/null "$QM/healthz" && QMOK=1; [ -n "$H" ] && [ "$QMOK" = 1 ] && break; sleep 2; done
fi
if [ -n "$H" ]; then
  ok "world service $WORLD · vision $(echo "$H" | hj 'h["vision"]') · asr $(echo "$H" | hj 'h["asr"]') · llm $(echo "$H" | hj 'h["llm"]')"
  [ "$(echo "$H" | hj 'bool(h["qm_url"])')" = "True" ] || bad "world service has no QM_URL (restart it with QM_URL=$QM)"
else
  bad "world service down at $WORLD (see .logs/world.log)"
fi
[ "$QMOK" = 1 ] && ok "QM up $QM" || bad "QM down at $QM (cd $QM_DIR && scripts/world-dev.sh up, log .logs/qm.log)"

# 2. docker networks ----------------------------------------------------
if [ -x "$QM_DIR/scripts/world-dev.sh" ]; then
  if fix "world-dev.sh gc"; then
    if out="$(cd "$QM_DIR" && scripts/world-dev.sh gc 2>&1)"; then ok "docker gc · $(echo "$out" | tail -1)"; else bad "docker gc failed: $(echo "$out" | tail -1)"; fi
  else
    ok "docker gc skipped (dry) · $(docker ps -q 2>/dev/null | wc -l | tr -d ' ') containers running"
  fi
else
  warn "no $QM_DIR/scripts/world-dev.sh, skipped docker gc"
fi

# 3. GBrain -------------------------------------------------------------
if [ -n "$H" ]; then
  GB="$(echo "$H" | hj 'h["gbrain"].get("backend")') up=$(echo "$H" | hj 'h["gbrain"].get("up")') writes_failed=$(echo "$H" | hj 'h["gbrain"].get("writes_failed")')"
  case "$GB" in gbrain.io*up=True*) ok "gbrain.io reachable ($GB)" ;; *) bad "GBrain not live: $GB (stub = no perception/.env.gbrain)" ;; esac
fi
SEED=(uv run python scripts/seed_gbrain.py --reset); [ "$DRY" = 1 ] && SEED+=(--dry-run)
if out="$(cd "$ROOT/perception" && "${SEED[@]}" 2>&1)"; then
  ok "seeds $([ "$DRY" = 1 ] && echo 'would reset' || echo reset): $(echo "$out" | grep -E 'delete' | sed -E 's/: \[.*//')"
else
  bad "seed_gbrain.py --reset failed: $(echo "$out" | tail -1)"
fi

# 4. face enrollment ----------------------------------------------------
ENR="$(echo "$H" | hj '",".join(h["enrolled"])')"
LAST_BAK="$(ls -t "$DATA"/people.backup-*.json 2>/dev/null | head -1)"
if [ "$FRESH" = 1 ]; then
  if [[ ",$ENR," == *",matthew,"* ]]; then
    if fix "back up people.json, forget matthew"; then
      cp "$DATA/people.json" "$DATA/people.backup-$(date +%Y%m%d-%H%M%S).json"
      director forget_face >/dev/null && ok "matthew forgotten (backup in perception/data/), say \"I'm Matthew\" to learn him live" || bad "forget_face failed (restart the world service for /director, or token mismatch)"
    else warn "matthew still enrolled (dry)"; fi
  else
    ok "matthew not enrolled: face-learning moment armed"
  fi
elif [[ ",$ENR," == *",matthew,"* ]]; then
  ok "matthew enrolled ($ENR)"
elif [ -n "$LAST_BAK" ] && fix "restore $(basename "$LAST_BAK")"; then
  cp "$LAST_BAK" "$DATA/people.json" && director reload_people >/dev/null
  H="$(health)"; ENR="$(echo "$H" | hj '",".join(h["enrolled"])')"
  [[ ",$ENR," == *",matthew,"* ]] && ok "matthew restored from $(basename "$LAST_BAK")" || bad "restore failed, enrolled: ${ENR:-none}"
else
  bad "matthew NOT enrolled (use --fresh-face on purpose, or: cd perception && uv run python -m perception.enroll --from-dir data/enroll/matthew)"
fi

# 5. procedures (local Builder drafts only) -----------------------------
NDRAFT=$(ls "$DATA"/procedures/*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$CLEAR" = 1 ] && [ "$NDRAFT" -gt 0 ]; then
  if fix "move $NDRAFT local drafts aside"; then
    B="$DATA/procedures.bak-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B" && mv "$DATA"/procedures/*.json "$B"/ && ok "moved $NDRAFT Builder drafts to ${B#$ROOT/}"
    # the HUD library index (QM titles, recall counts) goes with them so the strip starts at zero
    [ -f "$DATA/procedure_library.json" ] && mv "$DATA/procedure_library.json" "$B"/ && ok "moved procedure_library.json aside"
  fi
else
  ok "local Builder drafts: $NDRAFT $([ "$CLEAR" = 1 ] && echo '(none to clear)' || echo '(kept)')"
fi

# 6. Memorable (read-only) ----------------------------------------------
if command -v memorable >/dev/null; then
  if out="$(cd "$QM_DIR" 2>/dev/null && MEMORABLE_BACKEND=qm MEMORABLE_DB_URL="${MEMORABLE_DB_URL:-postgres://qm:qm@127.0.0.1:55433/qm}" $TO memorable status --scope "${WORLD_SCOPE:-personal:stephen}" 2>&1)"; then
    line="$(echo "$out" | grep -E 'capture|stored' | sed -E 's/^ *//; s/ +/ /g' | paste -sd"|" - | sed "s/|/ · /g")"
    if echo "$out" | grep -q 'capture on'; then ok "Memorable: $line"; else bad "Memorable capture not on: $line"; fi
  else
    bad "memorable status failed: $(echo "$out" | tail -1)"
  fi
else
  bad "memorable CLI not installed"
fi

# 7. demo PR ------------------------------------------------------------
if st="$(gh pr view "$DEMO_PR" -R "$REPO" --json state,title -q '.state+" · "+.title' 2>&1)"; then
  [[ "$st" == OPEN* ]] && ok "demo PR #$DEMO_PR on $REPO: $st" || bad "demo PR #$DEMO_PR on $REPO is $st"
else
  bad "gh pr view $DEMO_PR failed: $st"
fi

# 8. Builder idle + Quest client ------------------------------------------
if [ -n "$H" ]; then
  busy="$(curl -sf -m 5 "$WORLD/builder/jobs" | python3 -c 'import sys,json;print(sum(j["state"] in ("queued","running","pr_open") for j in json.load(sys.stdin)))' 2>/dev/null)"
  [ "${busy:-0}" = 0 ] && ok "Builder idle" || warn "Builder has $busy job(s) still running"
fi
curl -skf -m 3 -o /dev/null "https://localhost:5173/" && ok "Quest client dev server https://localhost:5173" || bad "Quest client down (scripts/dev-up.sh, log .logs/quest.log)"
HUDN="$(echo "$H" | hj 'h["hud_clients"]')"
[ "${HUDN:-0}" -gt 0 ] 2>/dev/null && ok "HUD clients connected: $HUDN" || warn "no HUD client connected yet (headset not in the page?)"
if command -v adb >/dev/null; then
  [ "$(adb get-state 2>/dev/null)" = device ] && ok "headset on adb" || warn "no headset on adb (only needed for cast-quest.sh / adb reverse)"
fi

# 9. clean HUD ----------------------------------------------------------
if [ -n "$H" ] && fix "Reset HUD"; then
  director reset >/dev/null && ok "HUD reset" || bad "HUD reset failed (world service older than /director: restart it; or token mismatch)"
fi

echo
if [ "$FAILS" = 0 ]; then
  echo "${G}READY${N} ($WARNS warning(s)). Director: $WORLD/director$([ -n "$TOKEN" ] && echo "?token=<WORLD_HOOKS_SECRET>")"
else
  echo "${R}NOT READY: $FAILS failed${N}, $WARNS warning(s). Fallbacks: director buttons, quest ?mock=1, recorded video."
  exit 1
fi
