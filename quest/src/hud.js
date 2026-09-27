// HUD state: the three visual states from CLAUDE.md, keyed by track.
// Renderer-agnostic. Desktop and XR both read from this.

import { applyDev, withDeltas } from './devpanels.js';
import { applyVision } from './visionfx.js';
import { observeSwarm } from './swarmviz.js';
import { applyBrain } from './brainpanel.js';
import { applyMemory } from './memorypanel.js';
import { warnOnce } from './perf.js';

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
    this.watches = [];           // armed_watches items (spoken standing watches, QM WorldWatches)
  }

  touch() { this.version++; }

  // Accept HUD messages per contract, plus two tolerant extras for anchoring:
  //   - a forwarded WorldEvent { type: "person.encountered", payload: { track_id, bbox, label } }
  //   - { kind: "track", track_id, bbox, label? }
  // and an optional `bbox` directly on person_card / agent_activity.
  // Never throws: a malformed or unknown message is dropped with a (rate-limited) console warning, and each
  // layer is isolated so one broken consumer doesn't starve the others.
  apply(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const bad = oversized(msg);
    if (bad) { warnOnce(`drop ${msg.kind}: ${bad}`); return; }
    const tag = msg.kind || msg.type || '?';
    try { observeSwarm(this, msg); } catch (e) { warnOnce(`swarm ${tag}`, e); } // spatial QM swarm graph (swarmviz.js), read-only
    try { if (applyMemory(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`memory ${tag}`, e); return; } // Memorable: procedure phases + library (memorypanel.js)
    try { if (applyBrain(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`brain ${tag}`, e); return; } // GBRAIN live feed (brainpanel.js)
    try { if (applyDev(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`dev ${tag}`, e); return; } // dev cockpit + context_delta (devpanels.js)
    try { if (applyVision(this, msg)) { this.touch(); return; } } catch (e) { warnOnce(`vision ${tag}`, e); return; } // perception overlay: vision / face_capture / relationship_vector (visionfx.js)
    try { this._applyCore(msg); } catch (e) { warnOnce(`hud ${tag}`, e); }
  }

  _applyCore(msg) {
    if (msg.type === 'person.encountered' && msg.payload) {
      const p = msg.payload;
      this._track(p.track_id, p.bbox, p.label);
      return;
    }
    switch (msg.kind) {
      case 'person_card':
        if (msg.bbox) this._track(msg.anchor_track_id, msg.bbox, msg.name);
        this.cards.set(key(msg.anchor_track_id), withDeltas(this, { ...msg, watching: this._watching(msg.person_id), t: now() }));
        break;
      case 'armed_watches': // snapshot; re-clone cards so the WATCHING row re-rasterizes
        this.watches = msg.items || [];
        for (const [k, c] of this.cards) this.cards.set(k, { ...c, watching: this._watching(c.person_id) });
        break;
      case 'memory_event':
        this.toasts.push({ text: String(msg.text ?? ''), detail: msg.detail == null ? '' : String(msg.detail), t: now() });
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
        if (msg.w > 0 && msg.h > 0) this.frameSize = [msg.w, msg.h];
        for (const t of Array.isArray(msg.tracks) ? msg.tracks : []) if (t) this._track(t.track_id, t.bbox, t.label);
        return;
      case 'clear':
        this.cards.clear(); this.activity.clear(); this.toasts = [];
        break;
      default:
        return;
    }
    this.touch();
  }

  _watching(pid) {
    if (!pid) return null;
    const topics = this.watches.filter((w) => w.person_id === pid).map((w) => w.topic || w.action).filter(Boolean);
    return topics.length ? topics.join(', ') : null;
  }

  _track(id, bbox, label) {
    if (id == null || !validBox(bbox)) return;
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
const validBox = (b) => Array.isArray(b) && b.length >= 4 && b.every((v, i) => i > 3 || Number.isFinite(v));

// Base64 payload caps. A runaway preview or crop decodes to a huge bitmap on a mobile GPU; drop it instead.
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
