#!/usr/bin/env bash
# Mirror the Quest 3S view onto this laptop and record it (what Stephen sees, passthrough + HUD).
#   scripts/cast-quest.sh               mirror only (USB)
#   scripts/cast-quest.sh --record      mirror + record to recordings/quest-<time>.mp4
#   scripts/cast-quest.sh --wifi        switch the headset to adb over wifi first (then unplug USB)
# Needs: Quest in developer mode, USB-C cable, "Allow USB debugging" accepted inside the headset.
# Tune: QUEST_CROP=w:h:x:y to show one eye only (default shows the full frame, both eyes).
#       QUEST_FPS (default 60), QUEST_BITRATE (default 16M), QUEST_MAX (max size, default 1920).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REC=0; WIFI=0
for a in "$@"; do case "$a" in --record) REC=1 ;; --wifi) WIFI=1 ;; esac; done

if [ "$WIFI" = 1 ]; then
  ip=$(adb shell ip route 2>/dev/null | awk '/wlan0/ {print $9; exit}')
  [ -n "$ip" ] || { echo "no headset ip; plug in USB and accept debugging first"; exit 1; }
  adb tcpip 5555 >/dev/null && sleep 1 && adb connect "$ip:5555"
  echo "connected over wifi at $ip:5555, you can unplug USB"
fi

adb get-state >/dev/null 2>&1 || { echo "no headset found: plug in USB-C, put on the headset, accept 'Allow USB debugging'"; exit 1; }

args=(--no-control --window-title "WORLD · Stephen POV" --max-fps "${QUEST_FPS:-60}" --video-bit-rate "${QUEST_BITRATE:-16M}" --max-size "${QUEST_MAX:-1920}")
[ -n "${QUEST_CROP:-}" ] && args+=(--crop "$QUEST_CROP")
if [ "$REC" = 1 ]; then
  mkdir -p "$ROOT/recordings"
  out="$ROOT/recordings/quest-$(date +%Y%m%d-%H%M%S).mp4"
  args+=(--record "$out")
  echo "recording to $out (close the window or ctrl-c to stop)"
fi
exec scrcpy "${args[@]}"
