import test from "node:test";
import assert from "node:assert/strict";
import { HudState } from "../src/hud.js";

test("selection normalizes numeric tracks, toggles, and rejects unknown views", () => {
  const hud = new HudState();
  hud.select(3);
  assert.equal(hud.selectedTrack, "3");
  hud.select("3");
  assert.equal(hud.selectedTrack, null);
  hud.select(4);
  hud.select(null);
  assert.equal(hud.selectedTrack, null);
  hud.setView("memories");
  const version = hud.version;
  hud.setView("unknown");
  assert.equal(hud.view, "memories");
  assert.equal(hud.version, version);
});

test("memory history survives toast expiration and retains the newest 30", () => {
  const hud = new HudState();
  for (let i = 0; i < 35; i++)
    hud.apply({ kind: "memory_event", text: `memory ${i}` });
  assert.equal(hud.toasts.length, 3);
  assert.equal(hud.memoryHistory.length, 30);
  assert.equal(hud.memoryHistory[0].text, "memory 5");
  for (const toast of hud.toasts) toast.t = performance.now() - 5000;
  assert.deepEqual(hud.liveToasts(), []);
  assert.equal(hud.memoryHistory.length, 30);
  assert.equal(hud.memoryHistory.at(-1).text, "memory 34");
});

test("clear removes encounter state and history so preview cannot contaminate live mode", () => {
  const hud = new HudState();
  hud.apply({
    kind: "person_card",
    anchor_track_id: 3,
    name: "Alex",
    bbox: [0.1, 0.1, 0.2, 0.3],
  });
  hud.apply({
    kind: "agent_activity",
    anchor_track_id: 3,
    workers: [{ name: "research" }],
  });
  hud.apply({ kind: "memory_event", text: "demo memory" });
  hud.select(3);
  hud.setView("agents");
  hud.apply({ kind: "clear" });
  for (const collection of [hud.cards, hud.activity, hud.tracks])
    assert.equal(collection.size, 0);
  assert.deepEqual(hud.toasts, []);
  assert.deepEqual(hud.memoryHistory, []);
  assert.equal(hud.selectedTrack, null);
  assert.equal(hud.view, "person");
});

test("panel receipts match a pending request, reject stale revisions, and allow rejected retries", () => {
  const hud = new HudState();
  const show = {
    kind: "panel",
    op: "show",
    id: "draft",
    type: "approval",
    title: "Review",
    actions: [
      { id: "review", label: "Review" },
      { id: "hold", label: "Hold" },
    ],
  };
  const receipt = (request_id, action_id = "review", status = "received") => ({
    kind: "panel_result",
    panel_id: "draft",
    request_id,
    action_id,
    status,
  });
  hud.apply(show);
  hud.apply(receipt("unsolicited"));
  assert.equal(hud.panels.get("draft").result, null);
  assert.equal(hud.beginPanelAction("draft", "unknown", "bad"), false);
  assert.equal(hud.beginPanelAction("draft", "review", "first"), true);
  assert.equal(hud.beginPanelAction("draft", "hold", "duplicate"), false);
  hud.apply(receipt("wrong-request"));
  hud.apply(receipt("first", "hold"));
  assert.equal(hud.panels.get("draft").result, null);
  hud.apply(receipt("first", "review", "rejected"));
  assert.equal(hud.panels.get("draft").result.status, "rejected");
  assert.equal(hud.beginPanelAction("draft", "review", "retry"), true);
  hud.apply(receipt("first"));
  assert.equal(hud.panels.get("draft").pendingAction.requestId, "retry");
  hud.apply({
    kind: "panel",
    op: "update",
    id: "draft",
    body: "Revised draft",
  });
  hud.apply(receipt("retry"));
  assert.equal(hud.panels.get("draft").result, null);
  assert.equal(hud.beginPanelAction("draft", "hold", "current"), true);
  hud.apply(receipt("current", "hold"));
  assert.equal(hud.panels.get("draft").result.status, "received");
  assert.equal(hud.beginPanelAction("draft", "review", "after-receipt"), false);
  hud.resetPanels();
  hud.apply(show);
  hud.apply(receipt("current", "hold"));
  assert.equal(hud.panels.get("draft").result, null);
});

test("malformed legacy streams cannot crash or poison rendered names and tracks", () => {
  const hud = new HudState();
  const malformed = [
    { kind: "tracks", tracks: {} },
    { kind: "tracks", tracks: [null, 3, { track_id: 1, bbox: {} }] },
    { kind: "track", track_id: {}, bbox: [0, 0, 0.3, 0.3] },
    { kind: "track", track_id: 1, bbox: [0, 0, NaN, 0.3] },
    { kind: "track", track_id: 1, bbox: [0, 0, -0.3, 0.3] },
    { kind: "track", track_id: 1, bbox: [0, 0, 0.3, 0.3], label: {} },
    { kind: "person_card", anchor_track_id: 1, name: { html: "oops" } },
    { kind: "memory_event", text: {} },
    { kind: "agent_activity", workers: {} },
    { kind: "agent_activity", workers: [null] },
    { kind: "agent_activity", workers: [{ name: {} }] },
  ];
  for (const message of malformed)
    assert.doesNotThrow(() => hud.apply(message));
  assert.equal(hud.cards.size, 0);
  assert.equal(hud.tracks.size, 0);
  assert.equal(hud.activity.size, 0);
  assert.equal(hud.memoryHistory.length, 0);
  hud.apply({
    kind: "tracks",
    w: "invalid",
    h: -1,
    tracks: [{ track_id: 1, bbox: [64, 48, 128, 96], label: "Alex" }],
  });
  assert.deepEqual(hud.frameSize, [640, 480]);
  assert.deepEqual(hud.bboxFor("1"), [0.1, 0.1, 0.2, 0.2]);
});

test('live work pagination preserves both actions and summoned panel priority', () => {
  const hud = new HudState();
  hud.setView('agents');
  hud.workPanels = Array.from({length:5}, (_,i)=>({id:`live:${i}`,view:'agents',actions:[{id:'url'},{id:'details'}]}));
  assert.equal(hud.surfacePanels().length,3);
  assert.equal(hud.surfacePanels()[1].actions[1].id,'details');
  hud.workPage=2;
  assert.equal(hud.surfacePanels()[0].id,'live:4');
  hud.apply({kind:'panel',op:'show',id:'agent-summoned',type:'note',title:'Requested'});
  assert.equal(hud.surfacePanels()[0].id,'agent-summoned');
});
