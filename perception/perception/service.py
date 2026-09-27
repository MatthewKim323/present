"""WORLD world service: FastAPI app on :8787.

  ws  /ws/quest   Quest (or desktop sim) streams frames/audio/gesture/label; receives HUD messages
  ws  /ws/hud     any HUD client; receives HUD messages
  POST /events    inject a WorldEvent (demo scripts, tests)
  POST /hud       push a raw HUD message (e.g. QM agent_activity, watch_fired) to every HUD client
  POST /gbrain/query, GET /gbrain/page/{slug}, GET /gbrain/person/{id}   read-only GBrain for QM workers (bearer)
  GET  /health    status + latency numbers
  debug: POST /debug/utterance, POST /debug/end-conversation, GET /people
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .audio import EnergyVAD, NullTranscriber, Transcriber, make_transcriber, pcm16_to_float, resample
from .config import Settings, get_settings
from .conversation import ConversationManager, Encounter, Utterance
from .events import normalize_event
from .extract import Extractor
from .faces import FaceEngine, LatencyStat, decode_jpeg
from .live import RollingExtractor
from .people import PeopleStore
from .panels import MANIFEST, PanelStore
from .qm_routes import add_qm_routes
from .sinks import FanOut, HudSink, QMSink, StubGBrainSink
from .builder import Builder, BuilderConfig, BuilderSink, add_builder_routes
from .devfeed import DevFeed
from .procfeed import ProcFeed, add_procedure_routes
from .gbrain_ops import GBrainOpFeed, add_gbrain_routes
from .vision import VisionPipeline
from .intro import IntroEnroller
from .visionfx import VisionFx
from .director import add_director_routes
from .watches import PinchAdopter, WatchBoard, WatchRequester, add_watch_routes

log = logging.getLogger("world")


class Hub:
    """HUD fanout to /ws/hud and /ws/quest clients."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self._state: dict[str, tuple[float, str]] = {}
        self._lock = asyncio.Lock()
        self.taps: list[Any] = []  # sync callables seeing every HUD message (director.py keeps its recent log)

    async def replay(self, ws: WebSocket) -> None:
        """Restore bounded cockpit state, never replay actions or transient toasts."""
        async with self._lock:
            now = time.monotonic()
            for key, (received, data) in list(self._state.items()):
                if now - received > 1800:
                    del self._state[key]
                else:
                    await ws.send_text(data)

    async def broadcast(self, msg: dict[str, Any]) -> None:
        for tap in self.taps:
            try:
                tap(msg)
            except Exception:  # noqa: BLE001
                log.exception("hud tap failed")
        data = json.dumps(msg)
        async with self._lock:
            kind = msg.get("kind")
            if kind == "clear":
                self._state.clear()
            elif kind in {"dev_github", "dev_session", "preview_shot", "agent_activity", "qm_swarm", "armed_watches"}:
                # Latest snapshot of each cockpit view; preview JPEG count is bounded to one.
                self._state[kind] = (time.monotonic(), data)
            dead = []
            for ws in list(self.clients):
                try:
                    await ws.send_text(data)
                except Exception:  # noqa: BLE001
                    dead.append(ws)
            for ws in dead:
                self.clients.discard(ws)


class WorldService:
    def __init__(self, settings: Settings | None = None, *, load_models: bool = True, transcriber: Transcriber | None = None, extractor: Extractor | None = None) -> None:
        self.s = settings or get_settings()
        self.store = PeopleStore(self.s.people_path, threshold=self.s.match_threshold)
        self.engine: FaceEngine | None = None
        if load_models:
            try:
                self.engine = FaceEngine(self.s.yunet_path, self.s.sface_path, self.s.detect_score, self.s.detect_max_side)
            except FileNotFoundError as e:
                log.error("%s (vision disabled)", e)
        self.vision = VisionPipeline(
            self.engine, self.store, max_age_s=self.s.track_max_age_s,
            encounter_debounce_s=self.s.encounter_debounce_s, enroll_samples=self.s.enroll_samples,
        )
        self.hub = Hub()
        self.panels = PanelStore(self.hub.broadcast)
        self.debug_clients: set[WebSocket] = set()
        self.gbrain = self._make_gbrain(StubGBrainSink(self.s.events_log_path, people_meta=self._people_meta))
        self.gbrain_ops = GBrainOpFeed(self.hub.broadcast)  # gbrain_op HUD lines, coalesced, <= ~5/s
        if hasattr(self.gbrain, "ops"):
            self.gbrain.ops = self.gbrain_ops
        self.qm = QMSink(self.s.qm_url)
        self.hud = HudSink(self.hub.broadcast, gbrain=self.gbrain)
        bcfg = BuilderConfig.from_env()
        self.procfeed = ProcFeed(self.hub.broadcast, bcfg.procedures_dir)  # Memorable phases + library on the HUD (procfeed.py)
        self.builder = Builder(bcfg, self.hub.broadcast, anchor=self._track_for, on_procedure=self.on_procedure, procfeed=self.procfeed)
        self.watchboard = WatchBoard(self.hub.broadcast)  # spoken watches + pinch-adopted agents (watches.py)
        self.qm.on_response, self.hud.agent_for = self.watchboard.on_qm_response, self.watchboard.agent_for
        self.fanout = FanOut([self.gbrain, self.qm, self.hud, BuilderSink(self.builder), self.watchboard])
        self.devfeed = DevFeed(self.builder, self.hub.broadcast)  # dev cockpit: dev_github / qm_swarm HUD
        self.conv = ConversationManager(self.s.conv_gap_s, self.s.leave_grace_s)
        self.visionfx = VisionFx(self)  # vision / face_capture overlay feed (visionfx.py)
        self.intro = IntroEnroller(self.vision, self.s.wearer_name, self.s.wearer_id)  # "I'm Matthew" = opt-in (intro.py)
        self.extractor = extractor or Extractor(self.s.anthropic_model, self.s.wearer_id, self.s.wearer_name)
        self.live = RollingExtractor(self.emit, wearer_id=self.s.wearer_id, wearer_name=self.s.wearer_name,
                                     known=getattr(self.gbrain, "known_facts", None), client=False)
        self.live.client = self.extractor.client  # live passes only when extraction is enabled
        self.watch_req = WatchRequester(self.emit, wearer_id=self.s.wearer_id, wearer_name=self.s.wearer_name,
                                        people=lambda: {pid: p.name for pid, p in self.store.people.items()}, client=self.live.client)
        self.pinch = PinchAdopter(self.emit, wearer_id=self.s.wearer_id, wearer_name=self.s.wearer_name)
        self.transcriber: Transcriber | None = transcriber
        self.vad = EnergyVAD(16000)
        self.source = "quest3s"
        self._latest_frame: tuple[bytes, float] | None = None
        self._frame_event = asyncio.Event()
        self._seg_queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._tasks: list[asyncio.Task] = []
        self.frame_lat = LatencyStat()
        self.asr_lat = LatencyStat()
        self.frames_in = 0
        self.frames_done = 0
        self.events_out = 0

    async def on_procedure(self, kind: str, doc: dict[str, Any], origin: dict[str, Any]) -> str | None:
        """Memorable -> GBrain: a learned procedure becomes a GBrain page linked to the moment it came from."""
        fn = getattr(self.gbrain, "remember_procedure" if kind == "learned" else "procedure_recalled", None)
        slug = await fn(doc, origin) if fn else None
        if slug and kind == "learned":
            await self.hub.broadcast({"kind": "memory_event", "text": "PROCEDURE LEARNED", "detail": f"{doc.get('title')} · saved to GBrain"})
        return slug

    def _make_gbrain(self, stub: StubGBrainSink):
        from .gbrain_auth import configured

        mode = (self.s.gbrain_backend or "").lower()
        if mode == "stub" or (mode != "io" and not configured()):
            return stub
        from .gbrain import make_gbrain_sink

        log.info("GBrain: hosted gbrain.io (fallback: stub)")
        return make_gbrain_sink(stub, wearer_id=self.s.wearer_id, wearer_name=self.s.wearer_name, people_meta=self._people_meta)

    def _track_for(self, pid: str | None) -> int | None:
        for t in self.vision.tracker.tracks.values():
            if pid and t.person_id == pid:
                return t.track_id
        t = self.vision.primary_track()
        return t.track_id if t else None

    def _people_meta(self, pid: str) -> dict:
        p = self.store.people.get(pid)
        return {**p.meta, "name": p.name} if p else {}

    # lifecycle
    async def start(self) -> None:
        self._frame_event = asyncio.Event()
        self._seg_queue = asyncio.Queue(maxsize=32)
        self._tasks = [
            asyncio.create_task(self._frame_worker()),
            asyncio.create_task(self._asr_worker()),
            asyncio.create_task(self._tick_loop()),
            asyncio.create_task(self.live.loop(lambda: self.conv.current)),
        ]
        if os.environ.get("DEVFEED", "1") != "0":
            self._tasks.append(asyncio.create_task(self.devfeed.loop()))
        self._tasks.append(asyncio.create_task(self.procfeed.send_library()))
        if hasattr(self.gbrain, "warm"):
            self._tasks.append(asyncio.create_task(self.gbrain.warm(sorted(self.store.people))))
        if self.transcriber is None:
            asyncio.create_task(self._load_asr())

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self.devfeed.close()
        self.procfeed.close()
        if self.builder.preview:
            self.builder.preview.stop()

    async def _load_asr(self) -> None:
        try:
            self.transcriber = await asyncio.to_thread(make_transcriber, self.s.asr_backend, self.s.asr_model)
        except Exception:
            log.exception("ASR load failed; audio will be ignored (use /debug/utterance)")
            self.transcriber = NullTranscriber()

    # event emission
    async def emit(self, event: dict[str, Any]) -> None:
        self.events_out += 1
        log.info("EVENT %s %s", event["type"], json.dumps(event["payload"])[:160])
        await self.fanout.emit(event)

    # inbound quest messages
    async def handle_quest_message(self, msg: dict[str, Any], ws: WebSocket | None = None) -> None:
        if not isinstance(msg, dict):
            return
        kind = msg.get("kind")
        if kind == "panel_action":
            await self.panels.select(msg)
            return
        if kind == "panel_dismiss":
            try:
                if set(msg) != {"kind", "panel_id"}:
                    raise ValueError("invalid dismiss fields")
                await self.panels.command({"op": "dismiss", "id": msg.get("panel_id")})
            except ValueError:
                if ws is not None:
                    await ws.send_json({"kind": "panel_result", "panel_id": msg.get("panel_id"), "status": "rejected"})
            return
        if kind == "frame":
            self.frames_in += 1
            self._latest_frame = (base64.b64decode(msg["jpeg_b64"]), float(msg.get("ts") or time.time()))
            self.debug_jpeg = self._latest_frame[0]  # RAM only, overwritten every frame, never written to disk
            self._frame_event.set()
        elif kind == "audio":
            pcm = pcm16_to_float(base64.b64decode(msg["pcm16_b64"]))
            sr = int(msg.get("sample_rate") or 16000)
            for seg in self.vad.feed(resample(pcm, sr, 16000)):
                try:
                    self._seg_queue.put_nowait(seg)
                except asyncio.QueueFull:
                    log.warning("ASR backlog full, dropping segment")
        elif kind == "label":
            self.vision.request_label(int(msg["track_id"]), str(msg["name"]))
        elif kind == "gesture":
            t = self.vision.tracker.tracks.get(int(msg.get("target_track_id") or -1))
            log.info("gesture %s on track %s", msg.get("type"), msg.get("target_track_id"))
            if msg.get("type") == "pinch" and t is not None:
                await self.pinch.on_pinch(t)  # recognized person -> world.entity_adopted
            if t is not None and t.label:
                await self.hub.broadcast(await self.hud.person_card(self.vision._encounter_event(t)))
        elif kind == "dev_action":
            await self.devfeed.handle_action(msg)
        elif kind == "ping":  # Quest link keepalive + RTT (?diag=1); echo the client's clock back
            if ws is not None:
                await ws.send_text(json.dumps({"kind": "pong", "t": msg.get("t")}))
        else:
            log.debug("ignoring message kind %r", kind)

    # workers
    async def _frame_worker(self) -> None:
        while True:
            await self._frame_event.wait()
            self._frame_event.clear()
            item, self._latest_frame = self._latest_frame, None
            if item is None or self.engine is None:
                continue
            data, ts = item
            t0 = time.perf_counter()
            try:
                res = await asyncio.to_thread(self._process_frame, data, ts)
            except Exception:
                log.exception("frame processing failed")
                continue
            del data  # frame bytes never outlive this iteration
            if res is None:
                continue
            self.frame_lat.add((time.perf_counter() - t0) * 1000)
            self.frames_done += 1
            now = time.time()
            for tr in self.vision.tracker.tracks.values():
                if tr.label:
                    self.conv.person_seen(tr.person_id, tr.label, now)
            for ev in res.events:
                ev["source"] = self.source
                await self.emit(ev)
            if self.debug_clients:
                dbg = json.dumps({"kind": "tracks", "ts": ts, "w": res.frame_w, "h": res.frame_h, "tracks": res.tracks,
                                  "detect_ms": round(res.detect_ms, 1), "embed_ms": round(res.embed_ms, 1)})
                for ws in list(self.debug_clients):
                    try:
                        await ws.send_text(dbg)
                    except Exception:  # noqa: BLE001
                        self.debug_clients.discard(ws)
            await self.visionfx.after_frame(res)

    def _process_frame(self, data: bytes, ts: float):
        frame = decode_jpeg(data)
        if frame is None:
            return None
        return self.vision.process(frame, time.time())

    async def _asr_worker(self) -> None:
        while True:
            seg = await self._seg_queue.get()
            if self.transcriber is None or isinstance(self.transcriber, NullTranscriber):
                continue
            t0 = time.perf_counter()
            try:
                text = await asyncio.to_thread(self.transcriber.transcribe, seg)
            except Exception:
                log.exception("transcription failed")
                continue
            finally:
                dur = seg.duration_s
                seg.audio = None  # drop raw audio
            self.asr_lat.add((time.perf_counter() - t0) * 1000)
            if text and any(c.isalnum() for c in text):
                log.info("ASR (%.0fms, %.1fdB): %s", (time.perf_counter() - t0) * 1000, seg.rms_db, text)
                await self.add_utterance(Utterance(time.time(), text, seg.rms_db, duration_s=dur))

    async def add_utterance(self, u: Utterance, partner: tuple[str | None, str | None] | None = None) -> None:
        """partner=(person_id, name) overrides the person in frame (debug injection without a camera)."""
        t = self.vision.primary_track()
        if partner is not None:
            pid, name, tid = partner[0], partner[1], None
        else:
            pid, name, tid = (t.person_id, t.label, t.track_id) if t else (None, None, None)
        self.intro.on_utterance(u)
        closed = self.conv.add_utterance(u, pid, name, tid)
        for enc in closed:
            asyncio.create_task(self._finish_encounter(enc))
        if await self.watch_req.on_utterance(u, (pid, name), tid):  # wearer's standing instruction (regex prefilter, then haiku)
            self.conv.drop_utterance(u)  # said to the AI, not to the person: keep it out of extraction

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            try:
                await self.panels.expire()
                if self._latest_frame is None:
                    self.vision.tick()
                for enc in self.conv.tick(time.time()):
                    asyncio.create_task(self._finish_encounter(enc))
            except Exception:
                log.exception("tick failed")

    async def end_conversation(self) -> list[dict[str, Any]]:
        out = []
        for enc in self.conv.force_end():
            out.extend(await self._finish_encounter(enc))
        return out

    async def _finish_encounter(self, enc: Encounter) -> list[dict[str, Any]]:
        log.info("conversation ended: %s, %d utterances", enc.name, len(enc.utterances))
        events = await self.extractor.extract(enc, source=self.source)
        enc.utterances.clear()  # transcript dropped after extraction
        for ev in events:
            await self.emit(ev)
        return events

    def health(self) -> dict[str, Any]:
        e = self.engine
        r = lambda x: round(x, 2) if x is not None else None  # noqa: E731
        return {
            "ok": True,
            "vision": e is not None,
            "asr": type(self.transcriber).__name__ if self.transcriber else "loading",
            "llm": self.extractor.client is not None,
            "qm_url": self.s.qm_url or None,
            "gbrain": self.gbrain.status() if hasattr(self.gbrain, "status") else {"backend": "stub"},
            "enrolled": sorted(self.store.people),
            "tracks": [self.vision.track_view(t) for t in self.vision.tracker.tracks.values()],
            "conversation_open": bool(self.conv.current),
            "hud_clients": len(self.hub.clients),
            "frames_in": self.frames_in,
            "frames_done": self.frames_done,
            "events_out": self.events_out,
            "latency_ms": {
                "detect": r(e.detect_lat.ms) if e else None,
                "embed_per_face": r(e.embed_lat.ms) if e else None,
                "frame_total": r(self.frame_lat.ms),
                "asr_segment": r(self.asr_lat.ms),
                "llm_extract": r(self.extractor.last_latency_ms),
                "llm_live": r(self.live.last_latency_ms),
            },
        }


def create_app(service: WorldService | None = None) -> FastAPI:
    svc = service or WorldService()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await svc.start()
        yield
        await svc.stop()

    app = FastAPI(title="WORLD world service", lifespan=lifespan)
    app.state.svc = svc
    add_builder_routes(app, svc.builder)
    add_qm_routes(app, svc.qm)
    add_procedure_routes(app, svc.procfeed)
    add_gbrain_routes(app, lambda: svc.gbrain)  # read-only GBrain for QM workers (WorldHooks bearer)
    add_director_routes(app, svc)  # /director stage console (director.py)
    add_watch_routes(app, svc.watchboard)  # GET /watches (watches.py)

    @app.post("/procedures")
    async def post_procedure(body: dict[str, Any]):
        """Any harness (QM swarm, Builder) reports an admitted Memorable draft: {kind?, draft, origin}."""
        draft = body.get("draft") or {}
        if not draft.get("title"):
            raise HTTPException(422, "draft.title required")
        kind = body.get("kind") or "learned"
        slug = await svc.on_procedure(kind, draft, body.get("origin") or {}) if kind in ("learned", "recalled") else None
        await svc.procfeed.reported(kind, draft, body.get("origin") or {}, slug)
        return {"ok": True, "slug": slug}

    @app.websocket("/ws/quest")
    async def ws_quest(ws: WebSocket):
        await ws.accept()
        svc.source = ws.query_params.get("source", "quest3s")
        debug = ws.query_params.get("debug") in ("1", "true")
        await svc.panels.connect(ws, svc.hub.clients, replay=svc.hub.replay)
        await ws.send_text(json.dumps(svc.procfeed.library_msg()))  # late joiners see the procedure library
        if debug:
            svc.debug_clients.add(ws)
        if debug or ws.query_params.get("vision") in ("1", "true"):
            svc.visionfx.clients.add(ws)
        log.info("quest connected (source=%s debug=%s)", svc.source, debug)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await svc.handle_quest_message(msg, ws)
        except WebSocketDisconnect:
            pass
        finally:
            svc.hub.clients.discard(ws)
            svc.debug_clients.discard(ws)
            svc.visionfx.clients.discard(ws)
            log.info("quest disconnected")

    @app.websocket("/ws/hud")
    async def ws_hud(ws: WebSocket):
        await ws.accept()
        await svc.panels.connect(ws, svc.hub.clients, replay=svc.hub.replay)
        await ws.send_text(json.dumps(svc.procfeed.library_msg()))
        try:
            while True:
                await ws.receive_text()  # HUD clients may send pings; ignored
        except WebSocketDisconnect:
            pass
        finally:
            svc.hub.clients.discard(ws)

    @app.post("/events")
    async def post_event(body: dict[str, Any]):
        try:
            ev = normalize_event(body)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        await svc.emit(ev)
        return {"ok": True, "id": ev["id"]}

    @app.post("/hud")
    async def post_hud(body: dict[str, Any]):
        if body.get("kind") == "panel":
            return await post_panel({k: v for k, v in body.items() if k != "kind"})
        kinds = ("person_card", "memory_event", "agent_activity", "context_delta", "dev_github", "qm_swarm", "relationship_vector")
        if body.get("kind") == "watch_fired" and body.get("watch_id"):  # QM (or anyone) reports a fired WorldWatch
            await svc.watchboard.fired(str(body["watch_id"]))
            return {"ok": True}
        if body.get("kind") not in kinds:
            raise HTTPException(422, "kind must be one of " + " | ".join(kinds))
        svc.devfeed.on_hud(body)  # QM's swarm lanes + recall feed the merged qm_swarm panel
        await svc.hub.broadcast(body)
        return {"ok": True}

    @app.get("/tools")
    async def tools():
        return {"tools": [MANIFEST["tool"]]}

    @app.post("/tools/world-panel")
    async def post_panel(body: dict[str, Any]):
        try:
            panel = await svc.panels.command(body)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        return {"ok": True, "panel": panel}

    @app.get("/panels")
    async def panels():
        return {"panels": await svc.panels.snapshot()}

    @app.get("/panel-actions")
    async def panel_actions(after: int = Query(default=0, ge=0)):
        return svc.panels.read_actions(after)

    @app.get("/health")
    async def health():
        return JSONResponse(svc.health())

    @app.get("/people")
    async def people():
        return {pid: {"name": p.name, "samples": len(p.embeddings)} for pid, p in svc.store.people.items()}

    @app.get("/debug/frame")
    async def debug_frame():
        """Latest camera frame as the headset sent it (RAM only), to check what the Quest camera actually sees."""
        from fastapi.responses import Response
        jpeg = getattr(svc, "debug_jpeg", None)
        if not jpeg:
            raise HTTPException(404, "no frame yet")
        return Response(jpeg, media_type="image/jpeg", headers={"cache-control": "no-store"})

    @app.post("/debug/utterance")
    async def debug_utterance(body: dict[str, Any]):
        """Inject transcribed text as if heard. speaker: "wearer" | "other" (optional)."""
        sp = body.get("speaker")
        hint = {"wearer": "wearer", "other": "other person"}.get(sp) if sp else None
        partner = None
        if body.get("name"):
            pid = body.get("person_id") or (svc.store.match_name(body["name"]))
            partner = (pid, body["name"])
            svc.conv.person_seen(pid, body["name"], time.time())
        await svc.add_utterance(Utterance(time.time(), str(body["text"]), float(body.get("rms_db", -30.0)), hint), partner)
        return {"ok": True}

    @app.post("/debug/end-conversation")
    async def debug_end():
        return {"events": await svc.end_conversation()}

    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = get_settings()
    uvicorn.run(create_app(WorldService(s)), host=s.host, port=s.port, log_level="info", ws_max_size=16 * 1024 * 1024)


if __name__ == "__main__":
    main()
