// HUD state: the three visual states from CLAUDE.md, keyed by track.
// Renderer-agnostic. Desktop and XR both read from this.

import { applyDev, withDeltas } from './devpanels.js';

const TOAST_MS = 4200;
const TRACK_STALE_MS = 4000;

export class HudState {
  constructor() {
    this.cards = new Map();      // track_id -> person_card msg
    this.activity = new Map();   // track_id|'free' -> agent_activity msg
    this.tracks = new Map();     // track_id -> { bbox:[x,y,w,h] normalized, label, t }
    this.toasts = [];            // { text, detail, t }
    this.version = 0;            // bumps on any change (renderers re-rasterize)
    this.frameSize = [640, 480]; // last sent frame size, for pixel bboxes
  }

  touch() { this.version++; }

  // Accept HUD messages per contract, plus two tolerant extras for anchoring:
  //   - a forwarded WorldEvent { type: "person.encountered", payload: { track_id, bbox, label } }
  //   - { kind: "track", track_id, bbox, label? }
  // and an optional `bbox` directly on person_card / agent_activity.
  apply(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (applyDev(this, msg)) { this.touch(); return; } // dev cockpit + context_delta (devpanels.js)
    if (msg.type === 'person.encountered' && msg.payload) {
      const p = msg.payload;
      this._track(p.track_id, p.bbox, p.label);
      return;
    }
    switch (msg.kind) {
      case 'person_card':
        if (msg.bbox) this._track(msg.anchor_track_id, msg.bbox, msg.name);
        this.cards.set(key(msg.anchor_track_id), withDeltas(this, { ...msg, t: now() }));
        break;
      case 'memory_event':
        this.toasts.push({ text: msg.text, detail: msg.detail, t: now() });
        this.toasts = this.toasts.slice(-3);
        break;
      case 'agent_activity':
        if (msg.bbox) this._track(msg.anchor_track_id, msg.bbox);
        this.activity.set(key(msg.anchor_track_id), { ...msg, t: now() });
        break;
      case 'track':
        this._track(msg.track_id, msg.bbox, msg.label);
        return;
      case 'tracks': // perception service debug stream (/ws/quest?debug=1): pixel bboxes + frame size
        if (msg.w && msg.h) this.frameSize = [msg.w, msg.h];
        for (const t of msg.tracks || []) this._track(t.track_id, t.bbox, t.label);
        return;
      case 'clear':
        this.cards.clear(); this.activity.clear(); this.toasts = [];
        break;
      default:
        return;
    }
    this.touch();
  }

  _track(id, bbox, label) {
    if (id == null || !bbox) return;
    this.tracks.set(key(id), { bbox: normBbox(bbox, this.frameSize), label, t: now() });
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

const key = (id) => (id == null ? 'free' : String(id));
const now = () => performance.now();

function normBbox(b, [fw, fh]) {
  const [x, y, w, h] = b;
  if (x <= 1 && y <= 1 && w <= 1 && h <= 1) return [x, y, w, h];
  return [x / fw, y / fh, w / fw, h / fh];
}
