// WebSocket link to the world service (/ws/quest). Auto-reconnects.
export class Link {
  constructor(url, { onMessage, onStatus } = {}) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.state = 'closed';
    this.sent = 0;
    this._retry = 500;
    this.connect();
  }

  connect() {
    this._set('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._later(); return; }
    this.ws = ws;
    ws.onopen = () => { this._retry = 500; this._set('open'); };
    ws.onclose = () => { this._set('closed'); this._later(); };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onMessage(msg);
    };
  }

  _later() {
    setTimeout(() => this.connect(), this._retry);
    this._retry = Math.min(this._retry * 1.6, 5000);
  }

  _set(s) { this.state = s; this.onStatus(s); }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  // Drop instead of queueing when the socket is backed up: stale frames are worthless.
  send(obj, { droppable = false } = {}) {
    if (!this.open) return false;
    if (droppable && this.ws.bufferedAmount > 2_000_000) return false;
    this.ws.send(JSON.stringify(obj));
    this.sent++;
    return true;
  }
}
