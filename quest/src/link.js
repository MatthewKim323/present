// WebSocket link to the world service (/ws/quest). Auto-reconnects with jittered exponential backoff.
// `net` = { state, since, retryAt, reconnects, everOpen } drives the OFFLINE chip (perf.js).
// Pings every 5 s; a server that answers `pong` gives an RTT (?diag=1), and 3 missed pongs on a socket
// that did answer before force a reconnect (half-open sockets after the headset sleeps).
const MAX_MSG = 8e6;          // chars; anything bigger is dropped before JSON.parse
const PING_MS = 5000;

export class Link {
  constructor(url, { onMessage, onStatus } = {}) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.state = 'closed';
    this.sent = 0;
    this.received = 0;
    this.rtt = null;
    this.net = { state: 'closed', since: performance.now(), retryAt: 0, reconnects: 0, everOpen: false };
    this._retry = 500;
    this.stopped = false;
    this._timer = null;
    this._pongSeen = false;
    this._missed = 0;
    this._pingTimer = setInterval(() => this._ping(), PING_MS);
    // back online / tab visible again: don't wait out the backoff
    globalThis.addEventListener?.('online', () => this._now());
    globalThis.document?.addEventListener?.('visibilitychange', () => { if (!document.hidden) this._now(); });
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._set('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._later(); return; }
    this.ws = ws;
    ws.onopen = () => { if (this.stopped || this.ws !== ws) return; this._retry = 500; this._missed = 0; this.net.everOpen = true; this._set('open'); this._ping(); };
    ws.onclose = () => { if (this.stopped || this.ws !== ws) return; this._set('closed'); this._later(); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (this.stopped || this.ws !== ws) return;
      this.received++;
      const data = ev.data;
      if (typeof data !== 'string') return; // binary frames are not part of the contract
      if (data.length > MAX_MSG) { console.warn(`[world] dropped ${(data.length / 1e6).toFixed(1)}MB message`); return; }
      let msg;
      try { msg = JSON.parse(data); } catch { console.warn('[world] non-JSON message dropped'); return; }
      if (msg && msg.kind === 'pong') {
        if (typeof msg.t === 'number') this.rtt = performance.now() - msg.t;
        this._pongSeen = true; this._missed = 0;
        return;
      }
      try { this.onMessage(msg); } catch (e) { console.warn('[world] onMessage threw', e); }
    };
  }

  _ping() {
    if (!this.open) return;
    if (this._pongSeen && ++this._missed > 3) { // it answered before and stopped: assume half-open
      this._missed = 0;
      try { this.ws.close(); } catch {}
      return;
    }
    this.send({ kind: 'ping', t: performance.now() });
  }

  _later() {
    if (this.stopped) return;
    if (this._timer) return;
    const wait = this._retry * (0.8 + 0.4 * Math.random());
    this.net.retryAt = performance.now() + wait;
    this._timer = setTimeout(() => { this._timer = null; this.net.reconnects++; this.connect(); }, wait);
    this._retry = Math.min(this._retry * 1.7, 8000);
  }

  _now() {
    if (this.stopped) return;
    if (this.open || this.state === 'connecting') return;
    this._retry = 500;
    this.connect();
  }

  _set(s) {
    if (s !== this.state) this.net.since = performance.now();
    this.state = s;
    this.net.state = s;
    this.onStatus(s);
  }

  close() {
    this.stopped = true;
    clearTimeout(this._timer);
    clearInterval(this._pingTimer);
    this.ws?.close();
    this._set('closed');
  }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  // Drop instead of queueing when the socket is backed up: stale frames are worthless.
  send(obj, { droppable = false } = {}) {
    if (!this.open) return false;
    if (droppable && this.ws.bufferedAmount > 2_000_000) return false;
    try { this.ws.send(JSON.stringify(obj)); } catch { return false; }
    this.sent++;
    return true;
  }
}
