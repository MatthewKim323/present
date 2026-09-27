"""Desktop simulator: Mac webcam + mic speaking the /ws/quest protocol, with an OpenCV debug window.

    uv run python -m perception.sim [--url ws://localhost:8787/ws/quest] [--no-mic] [--fps 10]

Window keys:  q quit   e end conversation now   m toggle mic
Terminal:     "<track_id> <name>"  -> label message ("that's Matthew", opt-in enrollment)
              "say <text>"         -> inject an utterance as if heard (skips ASR)
              "end"                -> end the conversation now
"""
from __future__ import annotations

import argparse
import base64
import json
import queue
import sys
import threading
import time
from collections import deque
from urllib.parse import urlparse

import cv2
import httpx
import numpy as np
from websockets.sync.client import connect

SR = 16000


class Sim:
    def __init__(self, url: str, fps: float, use_mic: bool, cam: int, width: int) -> None:
        self.url = url
        u = urlparse(url)
        self.http = f"{'https' if u.scheme == 'wss' else 'http'}://{u.netloc}"
        self.fps = fps
        self.use_mic = use_mic
        self.mic_on = use_mic
        self.cam = cam
        self.width = width
        self.out: queue.Queue = queue.Queue(maxsize=64)
        self.tracks: list[dict] = []
        self.track_meta: dict = {}
        self.hud: deque = deque(maxlen=6)
        self.card: dict | None = None
        self.running = True

    # threads
    def sender(self, ws) -> None:
        while self.running:
            try:
                msg = self.out.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                ws.send(json.dumps(msg))
            except Exception as e:  # noqa: BLE001
                print("send failed:", e)
                self.running = False

    def receiver(self, ws) -> None:
        while self.running:
            try:
                raw = ws.recv(timeout=0.5)
            except TimeoutError:
                continue
            except Exception:  # noqa: BLE001
                self.running = False
                return
            msg = json.loads(raw)
            k = msg.get("kind")
            if k == "tracks":
                self.tracks = msg["tracks"]
                self.track_meta = msg
            elif k == "person_card":
                self.card = msg
                print("HUD person_card:", json.dumps(msg))
            elif k in ("memory_event", "agent_activity"):
                self.hud.append((time.time(), msg))
                print(f"HUD {k}:", json.dumps(msg))

    def stdin_loop(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line == "end":
                self.end_conversation()
            elif line.startswith("say "):
                httpx.post(f"{self.http}/debug/utterance", json={"text": line[4:]}, timeout=5)
            else:
                parts = line.split(maxsplit=1)
                if len(parts) == 2 and parts[0].isdigit():
                    self.put({"kind": "label", "track_id": int(parts[0]), "name": parts[1]})
                    print(f"label sent: track {parts[0]} = {parts[1]}")
                else:
                    print('commands: "<track_id> <name>" | "say <text>" | "end"')

    def end_conversation(self) -> None:
        try:
            r = httpx.post(f"{self.http}/debug/end-conversation", timeout=60)
            print("end-conversation ->", [e["type"] for e in r.json().get("events", [])])
        except Exception as e:  # noqa: BLE001
            print("end-conversation failed:", e)

    def put(self, msg: dict) -> None:
        try:
            self.out.put_nowait(msg)
        except queue.Full:
            pass  # drop under backpressure (frames are latest-wins anyway)

    def mic_callback(self, indata, frames, t, status) -> None:
        if not self.mic_on:
            return
        pcm = (np.clip(indata[:, 0], -1, 1) * 32767).astype("<i2").tobytes()
        self.put({"kind": "audio", "ts": time.time(), "pcm16_b64": base64.b64encode(pcm).decode(), "sample_rate": SR})

    # main thread (OpenCV UI must live here on macOS)
    def run(self) -> None:
        cap = cv2.VideoCapture(self.cam)
        if not cap.isOpened():
            sys.exit("cannot open webcam (System Settings > Privacy > Camera: allow your terminal)")
        full = f"{self.url}{'&' if '?' in self.url else '?'}source=desktop-sim&debug=1"
        with connect(full, max_size=16 * 1024 * 1024) as ws:
            print("connected", full)
            threading.Thread(target=self.sender, args=(ws,), daemon=True).start()
            threading.Thread(target=self.receiver, args=(ws,), daemon=True).start()
            threading.Thread(target=self.stdin_loop, daemon=True).start()
            stream = None
            if self.use_mic:
                import sounddevice as sd

                stream = sd.InputStream(samplerate=SR, channels=1, dtype="float32", blocksize=SR // 10, callback=self.mic_callback)
                stream.start()
            period, last = 1.0 / self.fps, 0.0
            while self.running:
                ok, frame = cap.read()
                if not ok:
                    continue
                h, w = frame.shape[:2]
                if w > self.width:
                    frame = cv2.resize(frame, (self.width, int(h * self.width / w)))
                now = time.time()
                if now - last >= period:
                    last = now
                    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                    self.put({"kind": "frame", "ts": now, "jpeg_b64": base64.b64encode(jpg).decode(),
                              "w": frame.shape[1], "h": frame.shape[0], "head_pose": [0, 0, 0, 0, 0, 0, 1]})
                self.draw(frame)
                cv2.imshow("WORLD sim", frame)
                k = cv2.waitKey(1) & 0xFF
                if k == ord("q"):
                    self.running = False
                elif k == ord("e"):
                    threading.Thread(target=self.end_conversation, daemon=True).start()
                elif k == ord("m") and self.use_mic:
                    self.mic_on = not self.mic_on
                    print("mic", "on" if self.mic_on else "off")
            if stream:
                stream.stop()
        cap.release()
        cv2.destroyAllWindows()

    def draw(self, frame) -> None:
        for t in self.tracks:
            x, y, w, h = t["bbox"]
            known = t.get("person_id") is not None
            color = (80, 220, 80) if known else (0, 180, 255)
            if t.get("enrolling"):
                color = (255, 160, 0)
            cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
            label = f"#{t['track_id']} {t.get('label') or '...'}"
            if known:
                label += f" {t.get('match_score', 0):.2f}"
            if t.get("enrolling"):
                label += " (enrolling)"
            cv2.putText(frame, label, (x, max(20, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        m = self.track_meta
        status = f"detect {m.get('detect_ms', 0)}ms embed {m.get('embed_ms', 0)}ms  mic {'on' if self.mic_on else 'off'}"
        cv2.putText(frame, status, (10, frame.shape[0] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        y = 24
        if self.card:
            c = self.card
            for line in [c.get("name"), c.get("subtitle"), c.get("last") and f"last: {c['last']}",
                         c.get("owes_you") and f"owes you: {c['owes_you']}", c.get("you_owe") and f"you owe: {c['you_owe']}"]:
                if line:
                    cv2.putText(frame, str(line), (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
                    y += 20
        for ts, msg in list(self.hud):
            if time.time() - ts > 8:
                continue
            txt = f"v {msg.get('text')} . {msg.get('detail')}" if msg["kind"] == "memory_event" else f"agents: {msg.get('hook')}"
            cv2.putText(frame, txt, (10, y + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (120, 255, 200), 1)
            y += 22


def main() -> None:
    ap = argparse.ArgumentParser(prog="perception.sim")
    ap.add_argument("--url", default="ws://localhost:8787/ws/quest")
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("--no-mic", action="store_true")
    ap.add_argument("--cam", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    a = ap.parse_args()
    Sim(a.url, a.fps, not a.no_mic, a.cam, a.width).run()


if __name__ == "__main__":
    main()
