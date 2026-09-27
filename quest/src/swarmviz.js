// QM swarm, spatial. A small living graph of the WorldHook run, born from the real
// person the event came from and world-locked beside them:
//
//   person head --beam--> EVENT --> QM --> Context / Product / Builder --> PR
//                                           |                 |    (tool calls orbit Builder)
//                                         GBRAIN <-------- MEMORABLE --> procedure card
//
// Read-only consumer of qm_swarm, agent_activity, dev_session, dev_github,
// memory_event, context_delta, person_card (contracts/EVENTS.md). One simulation
// (SwarmSim, renderer agnostic, local meters, +y up, +z toward the viewer) feeds two
// renderers: XrSwarm (three.js, one instanced sprite batch + ribbon edges + label
// planes) and DesktopSwarm (2D canvas projection). Hooks elsewhere are one-liners.
import * as THREE from 'three';

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5', WARN = '#ffb86b', BAD = '#ff6b7a';
const S = 2; // label supersample

// palette index -> rgb (0..1). Sprites carry the index so desktop can cache tinted sprites.
const K = { accent: 0, warn: 1, bad: 2, white: 3, dim: 4 };
const PAL = [[0.486, 0.941, 0.773], [1, 0.722, 0.42], [1, 0.42, 0.478], [0.93, 0.97, 1], [0.62, 0.68, 0.74]];
const HEX = [ACCENT, WARN, BAD, '#eef7ff', '#9eadbd'];

const CAP = 256;          // sprites per frame (orbs + particles + rings + trails)
const MAX_PARTICLES = 170;
const STRIDE = 9;         // x y z r g b a size shape
const LABEL_M_PER_PX = 0.0017;
const FADE_AFTER_S = 20, FADE_TO = 0.3;

// Local layout, EVENT node at the origin (eye level), graph hangs below it. ~1 m wide incl. labels.
const LAYOUT = {
  event: [0, 0, 0],
  qm: [0, -0.115, 0.02],
  context: [-0.29, -0.235, 0.05],
  product: [0, -0.29, 0.07],
  builder: [0.29, -0.235, 0.05],
  gbrain: [-0.36, -0.44, 0.02],
  memorable: [0.03, -0.47, 0.04],
  pr: [0.44, -0.4, 0.03],
};
const EXTRA = [[-0.125, -0.335, 0.06], [0.125, -0.335, 0.06], [-0.4, -0.27, 0.03]];
const CARD_AT = [0.03, -0.52, 0.05]; // top-center of the procedure card
const SRC_DEFAULT = [0.6, 0.06, -0.25];

const T = () => performance.now() / 1000;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const easeOutBack = (x) => { x = clamp01(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const stateOf = (w) => w.state || 'running';

// ------------------------------------------------------------------ labels (canvas)

function mk(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * S); c.height = Math.ceil(h * S);
  const g = c.getContext('2d');
  g.scale(S, S);
  return [c, g];
}
const probe = document.createElement('canvas').getContext('2d');
function measure(s, font, track = 0) { probe.font = font; return probe.measureText(s).width + s.length * track; }
function txt(g, s, x, y, { size = 11, weight = 400, color = '#e8ecf0', font = FONT, track = 0, max, align = 'left' } = {}) {
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color;
  g.textAlign = align;
  if ('letterSpacing' in g) g.letterSpacing = `${track}px`;
  let str = String(s ?? '');
  if (max) while (str.length > 1 && g.measureText(str).width + str.length * track > max) str = str.slice(0, -2) + '…';
  g.fillText(str, x, y);
  if ('letterSpacing' in g) g.letterSpacing = '0px';
}
function glass(g, w, h, r, edge = 'rgba(255,255,255,0.14)') {
  g.beginPath();
  g.roundRect(0.5, 0.5, w - 1, h - 1, r);
  g.fillStyle = 'rgba(8,10,14,0.74)';
  g.fill();
  g.strokeStyle = edge;
  g.lineWidth = 1;
  g.stroke();
}

// Worker / infra node label: TITLE  tag \n sub
function drawNodeLabel({ title, sub, tag, tagK = K.dim, edgeK = null }) {
  const tf = `600 10.5px ${FONT}`, gf = `600 8.5px ${FONT}`, sf = `400 10px ${FONT}`;
  const tw = measure(title, tf, 1.3) + (tag ? measure(tag, gf, 1) + 10 : 0);
  const sw = sub ? Math.min(178, measure(sub, sf)) : 0;
  const w = Math.ceil(Math.max(56, tw, sw) + 20), h = sub ? 36 : 22;
  const [c, g] = mk(w, h);
  glass(g, w, h, 8, edgeK != null ? hexA(HEX[edgeK], 0.45) : undefined);
  txt(g, title, 10, 15, { size: 10.5, weight: 600, track: 1.3 });
  if (tag) txt(g, tag, w - 10, 15, { size: 8.5, weight: 600, track: 1, color: HEX[tagK], align: 'right' });
  if (sub) txt(g, sub, 10, 29, { size: 10, color: 'rgba(232,236,240,0.66)', max: w - 20 });
  return c;
}
function drawEventLabel(s) {
  const f = `500 10.5px ${MONO}`;
  const w = Math.ceil(Math.min(300, measure(s, f) + 22)), h = 22;
  const [c, g] = mk(w, h);
  glass(g, w, h, 11, hexA(ACCENT, 0.4));
  txt(g, s, 11, 15, { size: 10.5, weight: 500, font: MONO, color: ACCENT, max: w - 22 });
  return c;
}
function drawGhost(s) {
  const f = `500 10px ${MONO}`;
  const w = Math.ceil(Math.min(290, measure(s, f) + 14)), h = 17;
  const [c, g] = mk(w, h);
  g.beginPath(); g.roundRect(0.5, 0.5, w - 1, h - 1, 5);
  g.fillStyle = 'rgba(8,10,14,0.55)'; g.fill();
  txt(g, s, 7, 12, { size: 10, weight: 500, font: MONO, color: 'rgba(232,240,236,0.92)', max: w - 14 });
  return c;
}
function drawPrLabel(pr) {
  const ck = pr.checks === 'pass' ? ['checks ✓', ACCENT] : pr.checks === 'fail' ? ['checks ✗', BAD] : pr.checks === 'pending' ? ['checks …', WARN] : ['', null];
  const parts = [[`PR #${pr.number}`, '#eef3f6', `600 11px ${FONT}`], [' · ', 'rgba(232,236,240,0.4)', `400 11px ${FONT}`],
    [`+${pr.additions ?? 0}`, ACCENT, `500 10.5px ${MONO}`], [' ', null, `400 10.5px ${MONO}`], [`−${pr.deletions ?? 0}`, BAD, `500 10.5px ${MONO}`]];
  if (ck[1]) parts.push([' · ', 'rgba(232,236,240,0.4)', `400 11px ${FONT}`], [ck[0], ck[1], `600 10.5px ${FONT}`]);
  const w = Math.ceil(parts.reduce((a, p) => a + measure(p[0], p[2]), 0) + 22), h = 24;
  const [c, g] = mk(w, h);
  glass(g, w, h, 12, hexA(ck[1] || ACCENT, 0.5));
  let x = 11;
  for (const [s, col, f] of parts) { g.font = f; g.fillStyle = col || '#fff'; g.textAlign = 'left'; g.fillText(s, x, 16); x += g.measureText(s).width; }
  return c;
}
function drawProcCard(p) {
  const steps = Array.isArray(p.steps) ? p.steps : null;
  const n = p.steps_total || (steps ? steps.length : Number(p.steps) || 0);
  const rows = steps ? steps.slice(0, 5) : [];
  const w = 232, h = 50 + rows.length * 14 + (steps && steps.length > 5 ? 12 : 0) + (p.metrics ? 16 : 0) + 8;
  const [c, g] = mk(w, h);
  glass(g, w, h, 10, hexA(ACCENT, 0.45));
  g.fillStyle = ACCENT; g.beginPath(); g.arc(13, 14, 3, 0, Math.PI * 2); g.fill();
  txt(g, p.mode === 'recalled' ? 'RECALLED PROCEDURE' : 'PROCEDURE LEARNED', 22, 17.5, { size: 8.5, weight: 700, color: ACCENT, track: 1.3 });
  txt(g, n ? `${n} steps` : '', w - 10, 17.5, { size: 9, color: 'rgba(232,236,240,0.5)', align: 'right' });
  txt(g, p.title || 'procedure', 10, 36, { size: 11, weight: 500, font: MONO, max: w - 20 });
  let y = 52;
  rows.forEach((s, i) => {
    txt(g, String(i + 1).padStart(2, ' '), 10, y, { size: 9, font: MONO, color: 'rgba(124,240,197,0.6)' });
    txt(g, typeof s === 'string' ? s : s.action ? `${s.action} ${shortTarget(s.target)}`.trim() : s.name || s.title || '', 28, y, { size: 9.5, color: 'rgba(232,236,240,0.72)', max: w - 38 });
    y += 14;
  });
  if (steps && n > 5) { txt(g, `+${n - 5} more`, 28, y, { size: 9, color: 'rgba(232,236,240,0.4)' }); y += 12; }
  if (p.metrics) txt(g, p.metrics, 10, y + 4, { size: 9.5, font: MONO, color: ACCENT, max: w - 20 });
  return c;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const shortTarget = (s) => {
  s = String(s || '');
  if (/[\s]/.test(s)) return s.length > 26 ? s.slice(0, 25) + '…' : s; // a command
  return s.split('/').filter(Boolean).slice(-2).join('/');
};
function parseProc(detail) {
  const d = String(detail || '');
  const m = d.match(/^(.*?)\s*·\s*(\d+)\s*steps?/i);
  return m ? { title: m[1].trim(), steps: Number(m[2]) } : { title: d.split('·')[0].trim() || 'procedure', steps: 0 };
}

// ------------------------------------------------------------------ geometry helpers

const CURVE_N = 24;
function curve(a, b, ctrl) {
  const pts = new Float32Array((CURVE_N + 1) * 3);
  let len = 0, px = a[0], py = a[1], pz = a[2];
  for (let i = 0; i <= CURVE_N; i++) {
    const u = i / CURVE_N, v = 1 - u;
    const x = v * v * a[0] + 2 * v * u * ctrl[0] + u * u * b[0];
    const y = v * v * a[1] + 2 * v * u * ctrl[1] + u * u * b[1];
    const z = v * v * a[2] + 2 * v * u * ctrl[2] + u * u * b[2];
    pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z;
    if (i) len += Math.hypot(x - px, y - py, z - pz);
    px = x; py = y; pz = z;
  }
  return { pts, len };
}
// bulge perpendicular in the graph plane, away from the center line, plus a little toward the viewer
function bendCtrl(a, b, amt = 0.18, lift = 0.03) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, mz = (a[2] + b[2]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L, ny = dx / L;
  if (nx * mx < 0 || (Math.abs(mx) < 1e-3 && ny < 0)) { nx = -nx; ny = -ny; }
  return [mx + nx * L * amt, my + ny * L * amt, mz + lift];
}
function samplePts(pts, u, out) {
  const f = clamp01(u) * CURVE_N, i = Math.min(CURVE_N - 1, Math.floor(f)), r = f - i;
  out[0] = pts[i * 3] + (pts[i * 3 + 3] - pts[i * 3]) * r;
  out[1] = pts[i * 3 + 1] + (pts[i * 3 + 4] - pts[i * 3 + 1]) * r;
  out[2] = pts[i * 3 + 2] + (pts[i * 3 + 5] - pts[i * 3 + 2]) * r;
  return out;
}

// ------------------------------------------------------------------ simulation

export class SwarmSim {
  constructor() {
    this.cur = null;
    this.uid = 0;
    this.lastGh = null;
    this.pendingRecall = null;
    this.buf = new Float32Array(CAP * STRIDE);
    this.kbuf = new Uint8Array(CAP); // palette index per sprite (desktop tints by cached sprite)
    this.n = 0;
    this.lastT = -1;
    this.opacity = 1;
    this.labels = [];
    this._tmp = [0, 0, 0];
  }

  // ---------------------------------------------------------------- ingest
  observe(msg) {
    if (!msg || typeof msg !== 'object') return;
    const now = T();
    switch (msg.kind) {
      case 'clear': this.cur = null; this.lastGh = null; this.pendingRecall = null; return;
      case 'qm_swarm': return this._swarm(msg, now);
      case 'agent_activity': if (msg.hook && (msg.workers || []).length) this._swarm(msg, now); return;
      case 'dev_session': return this._session(msg, now);
      case 'dev_github': this.lastGh = msg; return this._github(msg, now);
      case 'memory_event': return this._memory(msg, now);
      case 'context_delta': return this._brainPulse(now, true);
      case 'person_card': if (this.cur) this._brainPulse(now, false); return;
      case 'gbrain_op': return this._gbrainOp(msg, now);
      case 'procedure': return this._procedure(msg, now);
      default:
    }
  }

  _swarm(msg, now) {
    let s = this.cur;
    const eid = msg.event_id || null, hook = msg.hook || 'world.event';
    const anyRunning = (msg.workers || []).some((w) => stateOf(w) === 'running');
    let fresh = !s;
    if (s) {
      if (eid && s.eventId) fresh = eid !== s.eventId;
      else if (eid) fresh = s.hook !== hook || !!s.completeAt; // adopt an id for the swarm agent_activity started
      else fresh = s.hook !== hook || (!!s.completeAt && ((msg.job_id && msg.job_id !== s.jobId) || (anyRunning && !msg.job_id && !s.jobId)));
    }
    if (fresh) s = this._start(msg, now);
    s.eventId ||= eid;
    s.jobId ||= msg.job_id || null;
    if (msg.anchor_track_id != null) s.anchor = msg.anchor_track_id;
    const feat = msg.feature || msg.label || msg.title;
    if (feat) s.feature = feat;
    for (const w of msg.workers || []) this._worker(s, w, now);
    if (!s.feature) {
      const b = (msg.workers || []).find((w) => /builder/i.test(w.name || ''));
      const note = String(b?.note || '');
      const m = note.match(/![\w-]+/) || note.match(/(?:queued|coding):\s*(.+)$/i);
      if (m) s.feature = (m[1] || m[0]).replace(/\s+command$/i, '');
    }
    if (msg.recalled) this._recall({ ...msg.recalled }, now);
    if (msg.learned) this._learn({ ...msg.learned }, now);
    s.lastAct = now;
  }

  _start(msg, now) {
    const s = {
      uid: ++this.uid, eventId: msg.event_id || null, jobId: msg.job_id || null, hook: msg.hook || 'world.event',
      feature: msg.feature || null, anchor: msg.anchor_track_id ?? null, t0: now,
      nodes: new Map(), edges: new Map(), particles: [], fliers: [], sats: [], rings: [], ghosts: [],
      toolQ: [], nextTool: 0, bghosts: [], recent: [], tails: {}, slot: now + 1.75, extra: 0,
      pr: null, prNote: null, prBase: 0, proc: null, procKey: null, card: null,
      recallLand: 0, completeAt: 0, lastAct: now, src: null, srcVer: 0,
    };
    for (const p of this.lastGh?.prs || []) s.prBase = Math.max(s.prBase, p.number || 0);
    this.cur = s;
    // birth: a bright node leaves the person's head on a light beam, lands as the EVENT node
    this._edge(s, 'src', 'event', now, 0.95, { kind: 'tether' });
    s.fliers.push({ from: 'src', to: 'event', t0: now, dur: 0.95, k: K.white, lift: 0.16 });
    this._node(s, 'event', 'event', LAYOUT.event, now + 0.95);
    this._node(s, 'qm', 'qm', LAYOUT.qm, now + 1.3);
    this._edge(s, 'event', 'qm', now + 1.3, 0.3);
    const pr = this.pendingRecall;
    this.pendingRecall = null;
    if (pr && now - pr.t < 20) setTimeout(() => this.cur === s && this._recall(pr.proc, T()), 0);
    return s;
  }

  _node(s, id, kind, pos, bornAt, extra = {}) {
    const n = { id, kind, pos, bornAt, state: kind === 'worker' ? 'running' : 'idle', note: '', lit: 0, phase: Math.random() * 6.28,
      label: null, labelKey: '', ver: 0, ...extra };
    s.nodes.set(id, n);
    s.rings.push({ id, t0: bornAt, k: kind === 'event' ? K.white : K.accent, big: kind === 'event' });
    return n;
  }

  _edge(s, a, b, bornAt, dur = 0.35, extra = {}) {
    const id = `${a}>${b}`;
    if (s.edges.has(id)) return s.edges.get(id);
    const e = { id, a, b, bornAt, dur, pts: null, len: 0, flow: 0, nextEmit: 0, pulseUntil: 0, kind: 'tree', ver: 0, ...extra };
    s.edges.set(id, e);
    return e;
  }

  _worker(s, w, now) {
    const id = String(w.name || 'worker').toLowerCase().replace(/\s+/g, '_');
    let n = s.nodes.get(id);
    if (!n) {
      const pos = LAYOUT[id] && !['event', 'qm', 'gbrain', 'memorable', 'pr'].includes(id) ? LAYOUT[id] : EXTRA[s.extra++ % EXTRA.length];
      const born = Math.max(now, s.slot);
      s.slot = born + 0.28;
      n = this._node(s, id, 'worker', pos, born, { name: w.name || id });
      this._edge(s, 'qm', id, born - 0.05, 0.35);
      if (id === 'context') { const g = this._gbrain(s, born + 0.45); this._edge(s, 'context', 'gbrain', Math.max(g.bornAt, born + 0.4), 0.4, { bend: 0.1 }); }
    }
    const st = stateOf(w);
    if (st !== n.state) {
      n.state = st;
      if (st !== 'running') { n.doneAt = now; s.rings.push({ id, t0: Math.max(now, n.bornAt + 0.35), k: st === 'failed' ? K.bad : K.accent }); }
    }
    n.note = w.note || '';
    if (w.elapsed_s != null) n.elapsed = w.elapsed_s;
    if (id === 'builder') {
      const m = n.note.match(/PR #(\d+)/);
      if (m) s.prNote = Number(m[1]);
      if (w.pr) s.prNote = Number(w.pr);
      if (s.prNote && !s.pr && this.lastGh) this._github(this.lastGh, now);
      if (w.tail) this._tail(s, 'q', w.tail, now);
    }
  }

  _gbrain(s, at) {
    if (s.nodes.has('gbrain')) return s.nodes.get('gbrain');
    const g = this._node(s, 'gbrain', 'gbrain', LAYOUT.gbrain, at, { name: 'GBRAIN' });
    if (s.nodes.has('context')) this._edge(s, 'context', 'gbrain', at - 0.05, 0.4, { bend: 0.1 });
    return g;
  }

  // gbrain_op: every GBrain read/write becomes a comet. QM workers: reads fly brain -> worker, writes
  // worker -> brain. perception / live ops fly between the person's head and the brain.
  _gbrainOp(msg, now) {
    const s = this.cur;
    if (!s) return;
    const g = this._gbrain(s, Math.max(now, s.t0 + 1.4));
    const op = String(msg.op || 'op');
    const write = /put|write|add|link|timeline|remember|capture|upsert|update|save|tag|delta/i.test(op);
    const m = String(msg.actor || '').match(/^qm:(.+)$/i) || (msg._fromMem ? [null, 'memorable'] : null);
    let other = 'src';
    if (m) {
      const id = m[1].toLowerCase().replace(/\s+/g, '_');
      if (!s.nodes.has(id)) return;
      other = id;
    }
    const n = s.nodes.get(other);
    const t0 = Math.max(now, g.bornAt + 0.2, n ? n.bornAt + 0.2 : 0);
    const dur = other === 'src' ? 1.0 : 0.7;
    if (s.fliers.length < 16) {
      s.fliers.push({ from: write ? other : 'gbrain', to: write ? 'gbrain' : other, t0, dur, small: true,
        k: msg.ok === false ? K.bad : write ? K.accent : K.white, lift: other === 'src' ? 0.12 : 0.04 });
    }
    const hit = write ? t0 + dur : t0;
    g.pulseAt = hit;
    s.rings.push({ id: 'gbrain', t0: hit, k: msg.ok === false ? K.bad : K.accent });
    const what = msg.slug ? ' ' + String(msg.slug).split('/').slice(-1)[0] : msg.query ? ` "${String(msg.query).slice(0, 18)}"` : '';
    const nHits = Array.isArray(msg.hits) ? msg.hits.length : msg.hits; // contract: hits is a list of {slug, title}
    const meta = [nHits != null ? `${nHits} hit${nHits === 1 ? '' : 's'}` : '', msg.ms != null ? `${Math.round(msg.ms)}ms` : ''].filter(Boolean).join(' · ');
    const who = m ? m[1] : msg.actor || '';
    const text = `${who ? who + ' ' : ''}${op}${what}${meta ? ' · ' + meta : ''}`;
    s.bghosts.push({ t0: hit, text, canvas: drawGhost(text), uid: `b${now}${Math.random()}` });
    if (s.bghosts.length > 3) s.bghosts.shift();
    s.lastAct = now;
  }

  // procedure: Memorable's lifecycle. recording = slow pulse wired to Builder, extracting = faster,
  // learned = card forms + saved into GBrain, recalled = card flies into Builder, refused = red.
  _procedure(msg, now) {
    const phase = String(msg.phase || '');
    const p = { title: msg.title || 'procedure', steps: msg.steps ?? 0, steps_total: msg.steps_total };
    const s = this.cur;
    if (phase === 'recalled') return this._recall(p, now);
    if (!s) return;
    if (phase === 'learned') {
      this._learn(p, now);
      const m = s.nodes.get('memorable');
      if (m) m.mstate = 'learned';
      if (msg.gbrain_slug) this._gbrainOp({ op: 'put_page', actor: 'memorable', slug: msg.gbrain_slug, _fromMem: true }, now + 0.9);
      return;
    }
    const m = this._memorable(s, Math.max(now, s.t0 + 1.4));
    m.mstate = phase;
    if (msg.tool_calls_seen != null) m.calls = msg.tool_calls_seen;
    if (msg.reason) m.reason = String(msg.reason);
    if (phase === 'recording' || phase === 'extracting') {
      const e = this._edge(s, 'builder', 'memorable', Math.max(now, m.bornAt), 0.45, { bend: 0.14 });
      e.pulseUntil = now + (phase === 'recording' ? 40 : 8);
    } else if (phase === 'refused') {
      const e = s.edges.get('builder>memorable');
      if (e) e.pulseUntil = 0;
      s.rings.push({ id: 'memorable', t0: now, k: K.bad });
    }
    s.lastAct = now;
  }

  _session(msg, now) {
    const s = this.cur;
    if (!s) return;
    if (msg.feature && !s.feature) s.feature = msg.feature;
    if (!s.nodes.has('builder') && msg.state && msg.state !== 'done') this._worker(s, { name: 'Builder', state: 'running', note: msg.step }, now);
    if (msg.tail) this._tail(s, 'd', msg.tail, now);
    if (msg.procedure && msg.procedure.title) this._recall({ title: msg.procedure.title, steps: msg.procedure.steps }, now);
    if (msg.pr) s.prNote = msg.pr;
  }

  // New tool calls = entries after the overlap between the previous tail and this one.
  _tail(s, src, tail, now) {
    const old = s.tails[src] || [];
    const eq = (a, b) => a && b && a.tool === b.tool && a.target === b.target;
    let k = Math.min(old.length, tail.length);
    for (; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k && ok; i++) ok = eq(old[old.length - k + i], tail[i]);
      if (ok) break;
    }
    s.tails[src] = tail.slice();
    s.recent = s.recent.filter((r) => now - r.t < 4);
    for (const e of tail.slice(k).slice(-6)) {
      const key = `${e.tool}|${e.target}`;
      if (s.recent.some((r) => r.key === key && r.src !== src)) continue; // same call via the other feed
      s.recent.push({ key, src, t: now });
      s.toolQ.push(e);
    }
  }

  _github(msg, now) {
    const s = this.cur;
    if (!s) return;
    const prs = msg.prs || [];
    // the Builder's own PR when it named one, else the newest PR opened after this swarm started
    const pr = s.prNote ? prs.find((p) => p.number === s.prNote) : prs[0];
    if (!pr || (pr.number <= s.prBase && pr.number !== s.prNote)) return;
    s.pr = { number: pr.number, additions: pr.additions, deletions: pr.deletions, checks: pr.checks };
    if (!s.nodes.has('pr')) {
      const b = s.nodes.get('builder');
      const at = Math.max(now, b ? b.bornAt + 0.6 : now);
      this._node(s, 'pr', 'pr', LAYOUT.pr, at, { name: 'PR' });
      this._edge(s, 'builder', 'pr', at - 0.25, 0.3, { bend: -0.12 });
    }
    s.lastAct = now;
  }

  _memory(msg, now) {
    const t = String(msg.text || '').toUpperCase();
    if (/RECALL/.test(t)) this._recall(parseProc(msg.detail), now);
    else if (/LEARNED FROM RUN/.test(t)) { const s = this.cur; if (s && s.proc) { s.proc = { ...s.proc, metrics: msg.detail }; s.procVer = (s.procVer || 0) + 1; s.lastAct = now; } }
    else if (/(PROCEDURE|SKILL).*LEARNED|LEARNED.*(PROCEDURE|SKILL)/.test(t)) this._learn(parseProc(msg.detail), now);
    else if (/REMEMBERED/.test(t)) this._brainPulse(now, true);
  }

  _memorable(s, at) {
    if (s.nodes.has('memorable')) return s.nodes.get('memorable');
    const m = this._node(s, 'memorable', 'memorable', LAYOUT.memorable, at, { name: 'MEMORABLE' });
    this._gbrain(s, at);
    this._edge(s, 'memorable', 'gbrain', Math.max(at + 0.1, s.nodes.get('gbrain').bornAt + 0.1), 0.45, { bend: -0.14 });
    return m;
  }

  _setProc(s, p, mode, at) {
    const key = `${mode}:${p.title}`;
    if (s.procKey === key) return false;
    s.procKey = key;
    s.proc = { ...p, mode };
    s.procVer = (s.procVer || 0) + 1;
    s.card = { bornAt: at };
    return true;
  }

  _recall(p, now) {
    const s = this.cur;
    if (!s || s.completeAt) { this.pendingRecall = { proc: p, t: now }; return; }
    const m = this._memorable(s, Math.max(now, s.t0 + 1.4));
    if (!this._setProc(s, p, 'recalled', m.bornAt + 0.25)) return;
    m.lit = 1;
    s.edges.get('memorable>gbrain').pulseUntil = now + 2.5;
    // the procedure flies from the card into Builder before Builder starts calling tools
    const b = s.nodes.get('builder');
    const t0 = Math.max(s.card.bornAt + 0.7, b ? b.bornAt + 0.2 : s.slot + 0.6);
    s.fliers.push({ from: 'card', to: 'builder', t0, dur: 1.05, k: K.accent, lift: 0.1, land: 'recall' });
    s.recallLand = t0 + 1.05;
    s.lastAct = now;
  }

  _learn(p, now) {
    const s = this.cur;
    if (!s) return;
    const m = this._memorable(s, now);
    if (!this._setProc(s, p, 'learned', Math.max(now, m.bornAt) + 0.6)) return;
    m.lit = 1;
    m.mstate = 'learned';
    // the Builder's trace streams into Memorable, which writes the procedure next to GBrain
    const e = this._edge(s, 'builder', 'memorable', now, 0.45, { bend: 0.14 });
    e.pulseUntil = now + 3;
    s.edges.get('memorable>gbrain').pulseUntil = now + 3.5;
    s.rings.push({ id: 'memorable', t0: Math.max(now, m.bornAt) + 0.5, k: K.accent, big: true });
    s.lastAct = now;
  }

  _brainPulse(now, strong) {
    const s = this.cur;
    if (!s) return;
    const g = s.nodes.get('gbrain');
    if (!g) return;
    g.pulseAt = Math.max(now, g.bornAt);
    s.rings.push({ id: 'gbrain', t0: g.pulseAt, k: K.accent });
    const e = s.edges.get('context>gbrain');
    if (e) e.pulseUntil = now + (strong ? 1.8 : 1);
  }

  setSource(p) {
    const s = this.cur;
    if (!s) return;
    if (s.src && Math.hypot(p[0] - s.src[0], p[1] - s.src[1], p[2] - s.src[2]) < 0.004) return;
    s.src = p.slice();
    s.srcVer++;
  }

  // ---------------------------------------------------------------- per frame
  _pos(s, id, out) {
    if (id === 'src') { const p = s.src || SRC_DEFAULT; out[0] = p[0]; out[1] = p[1] + 0.02; out[2] = p[2]; return out; }
    if (id === 'card') { out[0] = CARD_AT[0]; out[1] = CARD_AT[1] - 0.02; out[2] = CARD_AT[2]; return out; }
    const n = s.nodes.get(id);
    const p = n ? n.pos : LAYOUT.qm;
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    return out;
  }

  emit(x, y, z, k, a, size, shape) {
    if (this.n >= CAP || a <= 0.004) return;
    this.kbuf[this.n] = k;
    const o = this.n++ * STRIDE, b = this.buf, c = PAL[k];
    b[o] = x; b[o + 1] = y; b[o + 2] = z; b[o + 3] = c[0]; b[o + 4] = c[1]; b[o + 5] = c[2];
    b[o + 6] = a; b[o + 7] = size; b[o + 8] = shape;
  }

  step(t = T()) {
    if (t === this.lastT) return;
    this.lastT = t;
    this.n = 0;
    this.labels.length = 0;
    const s = this.cur;
    if (!s) return;
    const tmp = this._tmp;
    const running = (id) => { const n = s.nodes.get(id); return n && n.state === 'running' && t >= n.bornAt; };
    const anyRun = [...s.nodes.values()].some((n) => n.kind === 'worker' && n.state === 'running');

    // completion: every worker settled and (Builder has its PR, failed, or has been done a while)
    const workers = [...s.nodes.values()].filter((n) => n.kind === 'worker');
    const b = s.nodes.get('builder');
    if (!s.completeAt && workers.length && workers.every((n) => n.state !== 'running' && t >= n.bornAt + 0.4) &&
      (!b || s.pr || b.state === 'failed' || t - (b.doneAt || t) > 6)) {
      s.completeAt = t + 0.3;
      const order = ['event', 'qm', 'context', 'product', 'builder', 'gbrain', 'memorable', 'pr'];
      for (const n of s.nodes.values()) {
        const d = order.indexOf(n.id);
        s.rings.push({ id: n.id, t0: s.completeAt + 0.11 * (d < 0 ? 4 : d), k: K.accent, big: n.id === 'pr' });
      }
    }
    // fade to 30% 20 s after the last thing happened
    const quiet = s.completeAt ? t - Math.max(s.completeAt, s.lastAct) - FADE_AFTER_S : -1;
    this.opacity = quiet > 0 ? 1 - (1 - FADE_TO) * easeOut(quiet / 1.5) : 1;
    const breath = s.completeAt ? 1 + 0.035 * Math.sin(Math.PI * clamp01((t - s.completeAt) / 0.9)) : 1;
    this.scale = breath;

    // edges: geometry (lazy), growth, flow
    for (const e of s.edges.values()) {
      if (!e.pts || (e.kind === 'tether' && e.srcVer !== s.srcVer)) {
        const a = this._pos(s, e.a, [0, 0, 0]), bb = this._pos(s, e.b, [0, 0, 0]);
        const ctrl = e.kind === 'tether'
          ? [(a[0] + bb[0]) / 2, Math.max(a[1], bb[1]) + 0.16, (a[2] + bb[2]) / 2 + 0.05]
          : bendCtrl(a, bb, e.bend ?? 0.16, 0.03);
        Object.assign(e, curve(a, bb, ctrl));
        e.srcVer = s.srcVer;
        e.ver++;
      }
      e.progress = e.kind === 'tether' ? easeOut((t - e.bornAt) / e.dur) : easeOut((t - e.bornAt) / e.dur);
      let flowing = false, k = K.dim, alpha = 0.34;
      if (e.kind === 'tether') {
        const age = t - e.bornAt;
        alpha = age < e.dur ? 0.9 : 0.9 - 0.7 * easeOut((age - e.dur) / 2.5);
        k = K.white;
      } else {
        const tgt = s.nodes.get(e.b);
        if (e.b === 'qm') flowing = anyRun;
        else if (tgt && tgt.kind === 'worker') flowing = running(e.b);
        if (t < e.pulseUntil) flowing = true;
        if (e.a === 'context' && running('context')) flowing = true;
        if (tgt && tgt.state === 'failed') k = K.bad;
        else if (flowing || (tgt && (tgt.state === 'done' || tgt.lit || tgt.kind === 'pr'))) k = K.accent;
        alpha = flowing ? 0.62 : k === K.accent ? 0.42 : 0.3;
      }
      e.flow += ((flowing ? 1 : 0) - e.flow) * 0.08;
      e.k = k;
      e.alpha = alpha;
      if (flowing && t >= e.nextEmit && t >= e.bornAt + e.dur && s.particles.length < MAX_PARTICLES) {
        s.particles.push({ e, t0: t, dur: 0.75 + 0.25 * Math.random(), k: e.b === 'gbrain' || e.b === 'memorable' ? K.white : K.accent });
        e.nextEmit = t + 0.16 + 0.1 * Math.random();
      }
    }

    // particles along edges
    s.particles = s.particles.filter((p) => t - p.t0 < p.dur);
    for (const p of s.particles) {
      const u = (t - p.t0) / p.dur;
      samplePts(p.e.pts, u, tmp);
      this.emit(tmp[0], tmp[1], tmp[2], p.k, 0.95 * Math.sin(Math.PI * u), 0.011, 0);
    }

    // nodes
    for (const n of s.nodes.values()) {
      if (t < n.bornAt) continue;
      const age = t - n.bornAt, sc = easeOutBack(age / 0.38);
      let k = K.dim, a = 0.85, size = 0.028;
      switch (n.kind) {
        case 'event': k = age < 1.2 ? K.white : K.accent; size = 0.032; a = 1; break;
        case 'qm': k = anyRun ? K.white : K.accent; size = 0.036; a = 1; break;
        case 'worker':
          if (n.state === 'running') { const br = 0.5 + 0.5 * Math.sin(t * 4.2 + n.phase); k = K.warn; a = 0.55 + 0.45 * br; size = 0.027 * (1 + 0.14 * br); }
          else { k = n.state === 'failed' ? K.bad : K.accent; a = 1; size = 0.028; }
          if (n.id === 'builder' && t < s.recallLand + 0.8 && t > s.recallLand) { k = K.accent; size *= 1 + 0.4 * (1 - (t - s.recallLand) / 0.8); }
          break;
        case 'gbrain': {
          const pa = n.pulseAt ? t - n.pulseAt : 99;
          k = pa < 1.4 ? K.accent : K.dim; a = pa < 1.4 ? 1 : 0.8; size = 0.024 * (pa < 0.5 ? 1.3 - 0.6 * pa : 1); break;
        }
        case 'memorable':
          if (n.mstate === 'refused') { k = K.bad; a = 1; size = 0.024; }
          else if (n.mstate === 'recording' || n.mstate === 'extracting') {
            const br = 0.5 + 0.5 * Math.sin(t * (n.mstate === 'recording' ? 1.7 : 5.5));
            k = K.accent; a = 0.45 + 0.5 * br; size = 0.022 * (1 + 0.18 * br);
          } else { k = n.lit ? K.accent : K.dim; a = n.lit ? 1 : 0.7; size = n.lit ? 0.028 : 0.022; }
          break;
        case 'pr': k = s.pr?.checks === 'fail' ? K.bad : s.pr?.checks === 'pending' ? K.warn : K.accent; size = 0.03; a = 1; break;
      }
      const [x, y, z] = n.pos;
      this.emit(x, y, z, k, a, size * sc * breath, 1);
      this._label(s, n, t);
    }

    // rings (spawn / done / completion pulses)
    s.rings = s.rings.filter((r) => t - r.t0 < 0.9);
    for (const r of s.rings) {
      if (t < r.t0) continue;
      const u = (t - r.t0) / 0.9;
      this._pos(s, r.id, tmp);
      this.emit(tmp[0], tmp[1], tmp[2], r.k, 0.9 * (1 - u) * (1 - u), (r.big ? 0.03 : 0.022) + (r.big ? 0.085 : 0.05) * easeOut(u), 2);
    }

    // fliers (birth beam, recalled procedure) with a short comet trail
    s.fliers = s.fliers.filter((f) => t - f.t0 < f.dur + 0.05);
    for (const f of s.fliers) {
      if (t < f.t0) continue;
      const a = this._pos(s, f.from, [0, 0, 0]), bb = this._pos(s, f.to, [0, 0, 0]);
      if (!f.pts || f.srcVer !== s.srcVer) {
        f.pts = curve(a, bb, [(a[0] + bb[0]) / 2, Math.max(a[1], bb[1]) + f.lift, (a[2] + bb[2]) / 2 + 0.06]).pts;
        f.srcVer = s.srcVer;
      }
      const u = easeInOut((t - f.t0) / f.dur);
      for (let i = 7; i >= 0; i--) {
        const uu = u - i * 0.022;
        if (uu < 0) continue;
        samplePts(f.pts, uu, tmp);
        const sc = f.small ? 0.55 : 1;
        this.emit(tmp[0], tmp[1], tmp[2], i ? f.k : f.small ? f.k : K.white, i ? 0.7 * (1 - i / 8) : 1, (i ? 0.02 * (1 - i / 10) : 0.034) * sc, i ? 0 : 1);
      }
      if (f.land === 'recall' && u >= 1 && !f.landed) { f.landed = true; s.rings.push({ id: 'builder', t0: t, k: K.accent, big: true }); }
    }

    // tool calls: satellites orbit Builder, mono labels ghost out
    if (b && s.toolQ.length && t >= s.nextTool && t >= b.bornAt + 0.45 && t >= s.recallLand) {
      const e = s.toolQ.shift();
      const label = `${e.tool || 'Tool'} ${shortTarget(e.target)}`.trim();
      s.sats.push({ t0: t, dur: 1.7, ph: Math.random() * 6.28, tilt: 0.3 + 0.5 * Math.random(), k: /bash/i.test(e.tool) ? K.white : K.accent });
      s.ghosts.push({ t0: t, text: label, canvas: drawGhost(label), uid: `g${t}` });
      if (s.ghosts.length > 3) s.ghosts.shift();
      b.lastTool = label;
      s.nextTool = t + 0.6;
    }
    s.sats = s.sats.filter((q) => t - q.t0 < q.dur);
    if (b) {
      const [bx, by, bz] = b.pos;
      for (const q of s.sats) {
        const u = (t - q.t0) / q.dur, fade = u < 0.15 ? u / 0.15 : u > 0.6 ? (1 - u) / 0.4 : 1;
        for (let i = 4; i >= 0; i--) {
          const ang = q.ph + (u - i * 0.018) * Math.PI * 3.2, r = 0.05 + 0.012 * u;
          this.emit(bx + Math.cos(ang) * r, by + Math.sin(ang) * r * q.tilt, bz + Math.sin(ang) * r * 0.8, q.k, fade * (i ? 0.5 * (1 - i / 5) : 1), i ? 0.009 : 0.014, i ? 0 : 1);
        }
      }
    }
    s.ghosts = s.ghosts.filter((gh) => t - gh.t0 < 2.4);
    s.ghosts.forEach((gh, i) => {
      if (!b) return;
      const u = (t - gh.t0) / 2.4;
      const a = u < 0.1 ? u / 0.1 : u > 0.55 ? (1 - u) / 0.45 : 1;
      // a tiny rising log: newest at the bottom, older ones pushed up and fading
      const slot = s.ghosts.length - 1 - i;
      this.labels.push({ id: gh.uid, canvas: gh.canvas, x: b.pos[0] + 0.05, y: b.pos[1] + 0.006 + 0.012 * easeOut(u / 0.2) + slot * 0.03, z: b.pos[2] + 0.01, ax: 0, ay: 1, alpha: a * (slot ? 0.6 : 0.95) });
    });

    // GBrain op log beside the GBRAIN node
    const g = s.nodes.get('gbrain');
    s.bghosts = s.bghosts.filter((gh) => t - gh.t0 < 2.8);
    if (g) s.bghosts.forEach((gh, i) => {
      if (t < gh.t0) return;
      const u = (t - gh.t0) / 2.8;
      const a = u < 0.08 ? u / 0.08 : u > 0.6 ? (1 - u) / 0.4 : 1;
      const slot = s.bghosts.length - 1 - i;
      // under the GBRAIN label, newest on top, older ones pushed down
      this.labels.push({ id: gh.uid, canvas: gh.canvas, x: g.pos[0] + 0.02, y: g.pos[1] - 0.105 - 0.008 * easeOut(u / 0.2) - slot * 0.03, z: g.pos[2] + 0.01, ax: 0.6, ay: 0, alpha: a * (slot ? 0.55 : 0.9) });
    });

    // procedure card materializes under Memorable
    if (s.card && s.proc && t >= s.card.bornAt) {
      if (s.card.ver !== s.procVer) { s.card.canvas = drawProcCard(s.proc); s.card.ver = s.procVer; }
      const u = (t - s.card.bornAt) / 0.45;
      this.labels.push({ id: `card${s.procKey}`, canvas: s.card.canvas, ver: s.card.ver, x: CARD_AT[0], y: CARD_AT[1] - 0.012, z: CARD_AT[2], ax: 0.5, ay: 0, alpha: easeOut(u), sy: easeOutBack(u), card: true });
    }
  }

  _label(s, n, t) {
    let key, draw, ax = 0.5, ay = 0, dx = 0, dy = -0.03;
    const sec = Math.floor(t - s.t0);
    switch (n.kind) {
      case 'event': {
        const s1 = s.feature ? `${s.hook} · ${s.feature}` : s.hook;
        key = s1; draw = () => drawEventLabel(s1); ay = 1; dy = 0.03; break;
      }
      case 'qm': {
        const nw = [...s.nodes.values()].filter((x) => x.kind === 'worker').length;
        const el = (s.completeAt ? s.completeAt : t) - s.t0;
        const sub = `WorldHook swarm · ${nw} worker${nw === 1 ? '' : 's'} · ${fmtS(el)}`;
        key = `${sub}|${!!s.completeAt}`;
        draw = () => drawNodeLabel({ title: 'QM', sub, tag: s.completeAt ? 'DONE' : 'LIVE', tagK: s.completeAt ? K.accent : K.warn });
        ax = 0; ay = 0.5; dx = 0.034; dy = 0; break;
      }
      case 'worker': {
        const st = n.state, tag = st === 'running' ? 'RUNNING' : st === 'failed' ? 'FAILED' : 'DONE';
        const tagK = st === 'running' ? K.warn : st === 'failed' ? K.bad : K.accent;
        const sub = n.id === 'builder' && st === 'running' && t < s.recallLand + 1.5 && t > s.recallLand ? 'procedure loaded' :
          n.id === 'builder' && st === 'running' && n.lastTool ? n.lastTool : n.note;
        key = `${st}|${sub}`;
        draw = () => drawNodeLabel({ title: String(n.name).toUpperCase(), sub, tag, tagK });
        dy = -0.032; break;
      }
      case 'gbrain': key = 'g'; draw = () => drawNodeLabel({ title: 'GBRAIN', sub: 'people · commitments' }); dy = -0.028; break;
      case 'memorable': {
        const lit = !!n.lit, ms = n.mstate || '';
        const sub = ms === 'recording' ? `recording trace${n.calls ? ` · ${n.calls} calls` : ''}` : ms === 'extracting' ? 'extracting procedure'
          : ms === 'refused' ? `refused${n.reason ? ': ' + n.reason : ''}` : lit ? 'procedural memory' : null;
        const tag = ms === 'recording' ? 'REC' : ms === 'extracting' ? '···' : ms === 'refused' ? '✗' : lit ? '●' : '';
        key = `m${lit}|${ms}|${n.calls}|${n.reason}`;
        draw = () => drawNodeLabel({ title: 'MEMORABLE', sub, tag, tagK: ms === 'refused' ? K.bad : ms === 'recording' ? K.warn : K.accent });
        ax = 0; ay = 0.5; dx = 0.03; dy = 0.004; break;
      }
      case 'pr': {
        const p = s.pr || {};
        key = `${p.number}|${p.additions}|${p.deletions}|${p.checks}`;
        draw = () => drawPrLabel(p); dy = -0.03; break;
      }
      default: return;
    }
    if (key !== n.labelKey) { n.labelKey = key; n.label = draw(); n.ver++; void sec; }
    const age = t - n.bornAt;
    this.labels.push({ id: n.id, canvas: n.label, ver: n.ver, x: n.pos[0] + dx, y: n.pos[1] + dy, z: n.pos[2] + 0.005, ax, ay, alpha: easeOut((age - 0.1) / 0.35) });
  }
}

function easeInOut(x) { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
const fmtS = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// hud.js hook: one line in HudState.apply
export function observeSwarm(hud, msg) {
  (hud.swarm ||= new SwarmSim()).observe(msg);
}

// ------------------------------------------------------------------ XR renderer

const SPRITE_VS = `
attribute vec3 iPos; attribute vec4 iCol; attribute vec2 iSize;
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  vUv = position.xy * 2.0; vCol = iCol; vShape = iSize.y;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * iSize.x * 2.0;
  gl_Position = projectionMatrix * mv;
}`;
const SPRITE_FS = `
uniform float uOpacity;
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float a; vec3 c = vCol.rgb;
  if (vShape < 0.5) { a = exp(-d * d * 7.0); }
  else if (vShape < 1.5) {
    float core = smoothstep(0.34, 0.26, d);
    a = core + 0.5 * exp(-d * d * 6.0);
    c = mix(c, vec3(1.0), 0.4 * smoothstep(0.16, 0.0, d));
  } else { float r = (d - 0.82) * 11.0; a = exp(-r * r); }
  gl_FragColor = vec4(c, a * vCol.a * uOpacity);
}`;
const EDGE_VS = `
attribute float aU; attribute float aSide;
varying float vU; varying float vSide;
void main() { vU = aU; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EDGE_FS = `
uniform float uTime, uProgress, uFlow, uAlpha, uLen, uOpacity; uniform vec3 uColor;
varying float vU; varying float vSide;
void main() {
  if (vU > uProgress) discard;
  float soft = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
  float dash = step(0.45, fract(vU * uLen / 0.022 - uTime * 1.8));
  float body = mix(1.0, 0.25 + 0.75 * dash, uFlow);
  float tip = uProgress < 1.0 ? smoothstep(0.1, 0.0, uProgress - vU) * 1.5 : 0.0;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), tip * 0.6), soft * (uAlpha * body + tip) * uOpacity);
}`;

const EDGE_W = 0.0032;

export class XrSwarm {
  // xr: the XrHud (for _rayPoint, meshes, config). scene: its three.js scene.
  constructor(scene, xr) {
    this.xr = xr;
    this.hud = xr.hud;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.uid = 0;
    this.edges = new Map();  // id -> { mesh, ver }
    this.labels = new Map(); // id -> { mesh, canvas, ver, w, h }
    this.side = new URLSearchParams(location.search).get('swarmside') === 'right' ? 1 : -1;
    const q = new URLSearchParams(location.search);
    this.off = Number(q.get('swarmx') || 0.6);   // sideways from the person (m)
    this.pull = Number(q.get('swarmz') || 0.45); // toward the wearer (m)

    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const sim = this.hud.swarm || (this.hud.swarm = new SwarmSim());
    this.ib = new THREE.InstancedInterleavedBuffer(sim.buf, STRIDE, 1);
    this.ib.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.ib, 3, 0));
    g.setAttribute('iCol', new THREE.InterleavedBufferAttribute(this.ib, 4, 3));
    g.setAttribute('iSize', new THREE.InterleavedBufferAttribute(this.ib, 2, 7));
    g.instanceCount = 0;
    this.spriteMat = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, uniforms: { uOpacity: { value: 1 } },
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.sprites = new THREE.Mesh(g, this.spriteMat);
    this.sprites.frustumCulled = false;
    this.sprites.renderOrder = 9;
    this.group.add(this.sprites);
    if (import.meta.env?.DEV) window.__xrSwarm = this;
  }

  // Where the swarm lives: EVENT node ~0.6 m beside the person at eye level, a bit toward the wearer.
  _place(s, head, headQ) {
    const xr = this.xr, hud = this.hud, dist = xr.config.cardDistance;
    const b = s.anchor != null ? hud.bboxFor(s.anchor) : [...hud.tracks.keys()].map((id) => hud.bboxFor(id)).find(Boolean);
    let P;
    if (b) P = xr._rayPoint(head, headQ, b[0] + b[2] / 2, Math.max(0, b[1] - 0.02), dist);
    else {
      const card = xr.meshes.get('card:' + (s.anchor ?? 'free')) || [...xr.meshes.entries()].find(([k]) => k.startsWith('card:'))?.[1];
      P = card?.target ? card.target.clone().add(new THREE.Vector3(0, 0.12, 0)) : xr._local(head, headQ, 0, 0.1, -dist);
    }
    const toP = P.clone().sub(head); toP.y = 0; toP.normalize();
    const right = new THREE.Vector3(-toP.z, 0, toP.x);
    const A = P.clone().addScaledVector(right, this.side * this.off);
    A.y = head.y + 0.03;
    const back = head.clone().sub(A); back.y = 0;
    A.addScaledVector(back.normalize(), this.pull); // closer than the person: legible + in front of the cockpit panels
    this.group.position.copy(A);
    this.group.lookAt(head.x, A.y, head.z); // +z of the graph faces the wearer, upright
    this.group.updateMatrixWorld(true);
    const lp = this.group.worldToLocal(P.clone());
    hud.swarm.setSource([lp.x, lp.y, lp.z]);
  }

  _clear() {
    for (const e of this.edges.values()) { this.group.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); }
    for (const l of this.labels.values()) this._dropLabel(l);
    this.edges.clear(); this.labels.clear();
  }

  _dropLabel(l) { this.group.remove(l.mesh); l.mesh.geometry.dispose(); l.mesh.material.map.dispose(); l.mesh.material.dispose(); }

  frame(head, headQ) {
    const sim = this.hud.swarm;
    const s = sim && sim.cur;
    if (!s) { if (this.group.visible) { this.group.visible = false; this._clear(); this.uid = 0; } return; }
    if (this.uid !== s.uid) { this._clear(); this.uid = s.uid; this._place(s, head, headQ); }
    this.group.visible = true;
    const t = T();
    sim.step(t);
    const op = sim.opacity;
    this.group.scale.setScalar(sim.scale || 1);

    this.ib.needsUpdate = true;
    this.ib.clearUpdateRanges?.();
    this.ib.addUpdateRange?.(0, sim.n * STRIDE);
    this.sprites.geometry.instanceCount = sim.n;
    this.spriteMat.uniforms.uOpacity.value = op;

    for (const e of s.edges.values()) {
      if (!e.pts) continue;
      let m = this.edges.get(e.id);
      if (!m || m.ver !== e.ver) {
        if (m) { this.group.remove(m.mesh); m.mesh.geometry.dispose(); m.mesh.material.dispose(); }
        m = { mesh: this._ribbon(e), ver: e.ver };
        this.edges.set(e.id, m);
        this.group.add(m.mesh);
      }
      const u = m.mesh.material.uniforms;
      u.uTime.value = t; u.uProgress.value = t < e.bornAt ? -1 : e.progress; u.uFlow.value = e.flow;
      u.uAlpha.value = e.alpha; u.uOpacity.value = op; u.uLen.value = e.len;
      u.uColor.value.setRGB(...PAL[e.k]);
    }

    const seen = new Set();
    for (const L of sim.labels) {
      seen.add(L.id);
      let l = this.labels.get(L.id);
      const w = (L.canvas.width / S) * LABEL_M_PER_PX, h = (L.canvas.height / S) * LABEL_M_PER_PX;
      if (l && (Math.abs(l.w - w) > 1e-6 || Math.abs(l.h - h) > 1e-6)) { this._dropLabel(l); this.labels.delete(L.id); l = null; }
      if (!l) {
        const tex = new THREE.CanvasTexture(L.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
        mesh.renderOrder = L.card ? 11 : 12;
        this.group.add(mesh);
        l = { mesh, canvas: L.canvas, w, h };
        this.labels.set(L.id, l);
      } else if (l.canvas !== L.canvas) {
        l.mesh.material.map.image = L.canvas;
        l.mesh.material.map.needsUpdate = true;
        l.canvas = L.canvas;
      }
      const sy = L.sy ?? 1;
      l.mesh.scale.set(1, Math.max(0.001, sy), 1);
      l.mesh.position.set(L.x + (0.5 - L.ax) * w, L.y + (L.ay - 0.5) * h * sy, L.z);
      l.mesh.material.opacity = clamp01(L.alpha) * op;
    }
    for (const [id, l] of this.labels) if (!seen.has(id)) { this._dropLabel(l); this.labels.delete(id); }
  }

  _ribbon(e) {
    const n = CURVE_N + 1, pos = new Float32Array(n * 2 * 3), au = new Float32Array(n * 2), side = new Float32Array(n * 2);
    const idx = [];
    const p = e.pts;
    for (let i = 0; i < n; i++) {
      const j = Math.min(i + 1, n - 1), k = Math.max(i - 1, 0);
      let tx = p[j * 3] - p[k * 3], ty = p[j * 3 + 1] - p[k * 3 + 1];
      const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
      const nx = -ty * EDGE_W / 2, ny = tx * EDGE_W / 2;
      for (let sgn = 0; sgn < 2; sgn++) {
        const v = i * 2 + sgn, f = sgn ? 1 : -1;
        pos[v * 3] = p[i * 3] + nx * f; pos[v * 3 + 1] = p[i * 3 + 1] + ny * f; pos[v * 3 + 2] = p[i * 3 + 2];
        au[v] = i / (n - 1); side[v] = f;
      }
      if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aU', new THREE.BufferAttribute(au, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: EDGE_VS, fragmentShader: EDGE_FS, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uProgress: { value: 0 }, uFlow: { value: 0 }, uAlpha: { value: 0.4 }, uLen: { value: e.len }, uOpacity: { value: 1 }, uColor: { value: new THREE.Color() } },
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 8;
    mesh.frustumCulled = false;
    return mesh;
  }
}

// ------------------------------------------------------------------ desktop renderer

const spriteCache = new Map();
function spriteCanvas(k, shape) {
  const key = k * 4 + shape;
  let c = spriteCache.get(key);
  if (c) return c;
  const R = 64;
  c = document.createElement('canvas');
  c.width = c.height = R * 2;
  const g = c.getContext('2d');
  const img = g.createImageData(R * 2, R * 2);
  const [r0, g0, b0] = PAL[k];
  for (let y = 0; y < R * 2; y++) for (let x = 0; x < R * 2; x++) {
    const d = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
    let a = 0, r = r0, gg = g0, b = b0;
    if (d <= 1) {
      if (shape === 0) a = Math.exp(-d * d * 7);
      else if (shape === 1) {
        const core = clamp01((0.34 - d) / 0.08);
        a = Math.min(1, core + 0.5 * Math.exp(-d * d * 6));
        const wmix = 0.4 * clamp01((0.16 - d) / 0.16);
        r += (1 - r) * wmix; gg += (1 - gg) * wmix; b += (1 - b) * wmix;
      } else { const q = (d - 0.82) * 11; a = Math.exp(-q * q); }
    }
    const o = (y * R * 2 + x) * 4;
    img.data[o] = r * 255; img.data[o + 1] = gg * 255; img.data[o + 2] = b * 255; img.data[o + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  spriteCache.set(key, c);
  return c;
}

export class DesktopSwarm {
  constructor(hud) {
    this.hud = hud;
    hud.swarm ||= new SwarmSim();
    this.uid = 0;
    this._p = [0, 0, 0];
  }

  // Graph frame on screen: EVENT node origin, px per meter, slow yaw for parallax.
  // Desktop has no depth, so the graph takes the free area under the person card (the GitHub and
  // QM SWARM panels stack on the left of the person).
  _frame(s, vr) {
    const hud = this.hud;
    const b = s.anchor != null ? hud.bboxFor(s.anchor) : [...hud.tracks.keys()].map((id) => hud.bboxFor(id)).find(Boolean);
    let hx, hy, left, oy;
    if (b) {
      hx = vr.x + (b[0] + b[2] / 2) * vr.w; hy = vr.y + b[1] * vr.h;
      left = vr.x + (b[0] + b[2]) * vr.w + 8;
      oy = hy + 235;
    } else {
      hx = innerWidth * 0.5; hy = innerHeight * 0.25;
      left = innerWidth * 0.45; oy = innerHeight * 0.4;
    }
    left = Math.min(left, innerWidth - 420);
    oy = Math.max(60, Math.min(innerHeight * 0.55, oy));
    const scale = Math.max(300, Math.min(560, (innerWidth - left - 16) / 1.15, (innerHeight - oy - 30) / 0.66));
    return { ox: left + 0.5 * scale, oy, scale, hx, hy };
  }

  _proj(x, y, z, F, t, out) {
    const th = 0.12 * Math.sin(t * 0.23);
    const c = Math.cos(th), s = Math.sin(th);
    const xr = x * c + z * s, zr = -x * s + z * c;
    const k = 2.2 / (2.2 - zr);
    const sc = F.scale * (this.hud.swarm.scale || 1);
    out[0] = F.ox + xr * k * sc; out[1] = F.oy - y * k * sc; out[2] = k;
    return out;
  }

  draw(ctx, vr) {
    const sim = this.hud.swarm;
    const s = sim && sim.cur;
    if (!s) return;
    const t = T();
    const F = this._frame(s, vr);
    // person head (screen) -> graph local, so the birth beam leaves from the real head
    sim.setSource([(F.hx - F.ox) / F.scale, (F.oy - F.hy) / F.scale, -0.15]);
    sim.step(t);
    const op = sim.opacity, p = this._p;
    ctx.save();

    // edges
    ctx.lineCap = 'round';
    for (const e of s.edges.values()) {
      if (!e.pts || t < e.bornAt) continue;
      const last = Math.max(1, Math.round(e.progress * CURVE_N));
      ctx.beginPath();
      for (let i = 0; i <= last; i++) {
        this._proj(e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2], F, t, p);
        i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      }
      const col = HEX[e.k];
      ctx.strokeStyle = hexA(col, e.alpha * op * (e.flow > 0.5 ? 0.5 : 1));
      ctx.lineWidth = 1.4;
      ctx.setLineDash([]);
      ctx.stroke();
      if (e.flow > 0.05) {
        ctx.strokeStyle = hexA(col, Math.min(1, e.alpha * 1.4) * e.flow * op);
        ctx.lineWidth = 1.8;
        ctx.setLineDash([7, 7]);
        ctx.lineDashOffset = -t * 40;
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // sprites
    ctx.globalCompositeOperation = 'lighter';
    const B = sim.buf;
    for (let i = 0; i < sim.n; i++) {
      const o = i * STRIDE;
      this._proj(B[o], B[o + 1], B[o + 2], F, t, p);
      const r = B[o + 7] * F.scale * p[2] * (sim.scale || 1);
      ctx.globalAlpha = clamp01(B[o + 6] * op);
      ctx.drawImage(spriteCanvas(sim.kbuf[i], B[o + 8]), p[0] - r, p[1] - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // labels (1 css px per canvas px, anchored at the projected point)
    for (const L of sim.labels) {
      this._proj(L.x, L.y, L.z, F, t, p);
      const w = L.canvas.width / S, h = (L.canvas.height / S) * (L.sy ?? 1);
      ctx.globalAlpha = clamp01(L.alpha) * op;
      const dy = L.ay === 0 ? 4 : L.ay === 1 ? -4 : 0, dx = L.ax === 0 ? 6 : 0;
      ctx.drawImage(L.canvas, p[0] - L.ax * w + dx, p[1] - L.ay * h + dy, w, h);
    }
    ctx.restore();
  }
}
