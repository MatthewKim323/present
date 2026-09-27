import { applyDev, withDeltas } from "./devpanels.js";
import { applyVision } from "./visionfx.js";
import { observeSwarm } from './swarmviz.js';
import { applyBrain } from './brainpanel.js';
import { applyMemory } from './memorypanel.js';
import { warnOnce } from './perf.js';
import {
  applyPanelCommand,
  livePanels,
  beginPanelAction,
  applyPanelResult,
} from "./panel-state.js";
// HUD state: the three visual states from CLAUDE.md, keyed by track.
// Renderer-agnostic. Desktop and XR both read from this.

const TOAST_MS = 4200;
const TRACK_STALE_MS = 4000;

export class HudState {
  constructor() {
    this.cards = new Map(); // track_id -> person_card msg
    this.activity = new Map(); // track_id|'free' -> agent_activity msg
    this.tracks = new Map(); // track_id -> { bbox:[x,y,w,h] normalized, label, t }
    this.toasts = []; // { text, detail, t }
    this.memoryHistory = [];
    this.panels = new Map();
    this.selectedTrack = null;
    this.view = "person";
    this.dockVisible = true;
    this.watches = [];
    this.version = 0; // bumps on any change (renderers re-rasterize)
    this.frameSize = [640, 480]; // last sent frame size, for pixel bboxes
  }

  touch() {
    this.version++;
  }

  select(id) {
    const next = id == null ? null : key(id);
    this.selectedTrack = this.selectedTrack === next ? null : next;
    this.touch();
  }

  setView(view) {
    if (!["person", "memories", "agents"].includes(view)) return;
    this.view = view;
    this.touch();
  }

  livePanels() {
    return livePanels(this.panels);
  }

  surfacePanels() {
    const summoned = this.livePanels();
    if (this.view === 'person' || summoned.length >= 3) return summoned.slice(0, 3);
    const cards = (this.workPanels || []).filter(panel => panel.view === this.view);
    if (!cards.length) return summoned;
    const slots = 3 - summoned.length;
    if (cards.length <= slots) return [...summoned, ...cards];
    const pageSize = Math.max(1, slots - 1);
    const count = Math.ceil(cards.length / pageSize);
    const page = Math.min(this.workPage || 0, count - 1);
    return [...summoned, ...cards.slice(page * pageSize, (page + 1) * pageSize), {
      id: 'live:navigation', type: 'status', eyebrow: 'Work', title: `${page + 1} / ${count}`,
      body: `${cards.length} live cards`, actions: [
        { id: 'previous-page', label: 'previous' }, { id: 'next-page', label: 'next' },
      ],
    }];
  }

  beginPanelAction(id, actionId, requestId) {
    if (!beginPanelAction(this.panels, id, actionId, requestId)) return false;
    this.touch();
    return true;
  }

  resetPanels() {
    this.panels.clear();
    this.touch();
  }

  // Accept HUD messages per contract, plus two tolerant extras for anchoring:
  //   - a forwarded WorldEvent { type: "person.encountered", payload: { track_id, bbox, label } }
  //   - { kind: "track", track_id, bbox, label? }
  // and an optional `bbox` directly on person_card / agent_activity.
  apply(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const bad = oversized(msg);
    if (bad) { warnOnce(`drop ${msg.kind}: ${bad}`); return; }
    const tag = msg.kind || msg.type || '?';
    try { observeSwarm(this, msg); } catch (e) { warnOnce(`swarm ${tag}`, e); }
    try { if (applyMemory(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`memory ${tag}`, e); return; }
    try { if (applyBrain(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`brain ${tag}`, e); return; }
    try { if (applyDev(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`dev ${tag}`, e); return; }
    try { if (applyVision(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`vision ${tag}`, e); return; }
    try { this._applyCore(msg); } catch (e) { warnOnce(`hud ${tag}`, e); }
  }

  _applyCore(msg) {
    if (msg.type === "person.encountered" && msg.payload) {
      const p = msg.payload;
      this._track(p.track_id, p.bbox, p.label);
      return;
    }
    switch (msg.kind) {
      case "panel":
        if (applyPanelCommand(this.panels, msg)) this.touch();
        return;
      case "panel_result":
        if (applyPanelResult(this.panels, msg)) this.touch();
        return;
      case "person_card":
        if (
          !validId(msg.anchor_track_id, true) ||
          !validText(msg.name) ||
          !["subtitle", "last", "owes_you", "you_owe"].every((field) =>
            validText(msg[field], true),
          )
        )
          return;
        if (msg.bbox) this._track(msg.anchor_track_id, msg.bbox, msg.name);
        this.cards.set(key(msg.anchor_track_id), withDeltas(this, { ...msg, watching: this._watching(msg.person_id), t: now() }));
        break;
      case 'armed_watches':
        this.watches = Array.isArray(msg.items) ? msg.items : [];
        for (const [k, c] of this.cards) this.cards.set(k, { ...c, watching: this._watching(c.person_id) });
        break;
      case "memory_event":
        if (!validText(msg.text) || !validText(msg.detail, true)) return;
        const memory = { text: msg.text, detail: msg.detail, t: now() };
        this.toasts.push(memory);
        this.memoryHistory = [...this.memoryHistory, memory].slice(-30);
        this.toasts = this.toasts.slice(-3);
        break;
      case "agent_activity":
        if (
          !validId(msg.anchor_track_id, true) ||
          !Array.isArray(msg.workers) ||
          msg.workers.some(
            (worker) =>
              !worker ||
              !validText(worker.name) ||
              !validText(worker.note, true) ||
              (worker.state != null &&
                !["running", "done", "failed", "waiting"].includes(
                  worker.state,
                )),
          )
        )
          return;
        if (msg.bbox) this._track(msg.anchor_track_id, msg.bbox);
        this.activity.set(key(msg.anchor_track_id), { ...msg, t: now() });
        break;
      case "track":
        this._track(msg.track_id, msg.bbox, msg.label);
        return;
      case "tracks": // perception service debug stream (/ws/quest?debug=1): pixel bboxes + frame size
        if (!Array.isArray(msg.tracks)) return;
        if (
          [msg.w, msg.h].every((value) => Number.isFinite(value) && value > 0)
        )
          this.frameSize = [msg.w, msg.h];
        for (const t of msg.tracks)
          if (t && typeof t === "object")
            this._track(t.track_id, t.bbox, t.label);
        return;
      case "clear":
        this.cards.clear();
        this.activity.clear();
        this.tracks.clear();
        this.toasts = [];
        this.panels.clear();
        this.memoryHistory = [];
        this.selectedTrack = null;
        this.view = "person";
        break;
      default:
        return;
    }
    this.touch();
  }

  _watching(pid) {
    if (!pid) return null;
    const topics = this.watches.filter(w => w?.person_id === pid).map(w => w.topic || w.action).filter(Boolean);
    return topics.length ? topics.join(', ') : null;
  }

  _track(id, bbox, label) {
    if (
      !validId(id) ||
      !validText(label, true) ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      bbox.some((value) => value < 0) ||
      bbox[2] === 0 ||
      bbox[3] === 0
    )
      return;
    this.tracks.set(key(id), {
      bbox: normBbox(bbox, this.frameSize),
      label,
      t: now(),
    });
  }

  // Normalized [x,y,w,h] for a track, or null if we have not seen it recently.
  bboxFor(id) {
    const tr = this.tracks.get(key(id));
    if (!tr || now() - tr.t > TRACK_STALE_MS) return null;
    return tr.bbox;
  }

  liveToasts() {
    const t = now();
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((x) => t - x.t < TOAST_MS);
    if (this.toasts.length !== before) this.touch();
    for (const x of this.toasts) x.age = (t - x.t) / TOAST_MS;
    return [...this.toasts];
  }
}

const key = (id) => (id == null ? "free" : String(id));
const B64_CAP = { face_capture: 256e3, preview_shot: 6e6 };
function oversized(msg) {
  const cap = B64_CAP[msg.kind];
  if (!cap) return null;
  const b64 = msg.jpeg_b64;
  if (b64 != null && typeof b64 !== 'string') return 'jpeg_b64 not a string';
  if (b64 && b64.length > cap) return `jpeg_b64 ${(b64.length / 1e6).toFixed(1)}MB > ${(cap / 1e6).toFixed(2)}MB`;
  return null;
}
const now = () => performance.now();

function normBbox(b, [fw, fh]) {
  const [x, y, w, h] = b;
  if (x <= 1 && y <= 1 && w <= 1 && h <= 1) return [x, y, w, h];
  return [x / fw, y / fh, w / fw, h / fh];
}

const validId = (value, optional = false) =>
  (optional && value == null) ||
  (typeof value === "string" && value.length > 0 && value.length <= 128) ||
  (typeof value === "number" && Number.isFinite(value));
const validText = (value, optional = false) =>
  (optional && value == null) ||
  (typeof value === "string" && value.length <= 2000);
