import test from "node:test";
import assert from "node:assert/strict";
import { Link } from "../src/link.js";

test("closing an offline link cancels pending reconnect and later close events cannot restart it", (t) => {
  const sockets = [],
    timers = new Map();
  let timerId = 0;
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      sockets.push(this);
      this.readyState = 0;
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  t.mock.method(globalThis, "setTimeout", (fn) => {
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  const link = new Link("ws://test");
  sockets[0].onclose();
  assert.equal(timers.size, 1);
  const staleRetry = [...timers.values()][0];
  link.close();
  assert.equal(timers.size, 0);
  staleRetry(); // even an already queued callback cannot reconnect
  link.connect();
  assert.equal(sockets.length, 1);
  assert.equal(link.state, "closed");
  assert.equal(link.send({ kind: "frame" }), false);
});
