import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPanelCommand,
  livePanels,
  PANEL_TYPES,
} from "../src/panel-state.js";
import { PANEL_CATALOG } from "../src/panel-catalog.js";

test("every panel sample satisfies the agent contract", () => {
  assert.equal(PANEL_CATALOG.length, 24);
  assert.deepEqual(
    PANEL_CATALOG.map((p) => p.type),
    PANEL_TYPES,
  );
  for (const entry of PANEL_CATALOG) {
    const panels = new Map();
    assert.equal(
      applyPanelCommand(panels, entry.sample, 1000),
      true,
      entry.type,
    );
    assert.equal(panels.get(entry.sample.id).type, entry.type);
  }
});
test("updates preserve identity and lifetime; expired and dismissed panels disappear", () => {
  const panels = new Map();
  const sample = PANEL_CATALOG[0].sample;
  applyPanelCommand(panels, sample, 1000);
  applyPanelCommand(
    panels,
    { op: "update", id: sample.id, title: "Updated" },
    2000,
  );
  assert.equal(panels.get(sample.id).expiresAt, 61000);
  assert.equal(panels.get(sample.id).title, "Updated");
  assert.equal(livePanels(panels, 61001).length, 0);
  assert.equal(
    applyPanelCommand(
      panels,
      { op: "update", id: sample.id, title: "Stale" },
      62000,
    ),
    false,
  );
  applyPanelCommand(panels, sample, 63000);
  assert.equal(
    applyPanelCommand(panels, { op: "dismiss", id: sample.id }, 64000),
    true,
  );
  assert.equal(panels.size, 0);
});
test("invalid payloads never create a panel; capacity stays at three", () => {
  const panels = new Map();
  for (const entry of PANEL_CATALOG.slice(0, 4))
    applyPanelCommand(panels, entry.sample, 0);
  assert.equal(panels.size, 3);
  assert.equal(panels.has(PANEL_CATALOG[0].sample.id), false);
  const before = [...panels.keys()];
  for (const extra of [
    { type: "script" },
    { title: "x".repeat(65) },
    { progress: NaN },
    {
      actions: [
        { id: "x", label: "a" },
        { id: "x", label: "b" },
      ],
    },
    { body: { html: "<script>" } },
    { unknown: "x" },
  ]) {
    assert.equal(
      applyPanelCommand(panels, { ...PANEL_CATALOG[0].sample, ...extra }, 0),
      false,
    );
  }
  assert.deepEqual([...panels.keys()], before);
});
test("replay accepts a sub-second remaining TTL without extending it", () => {
  const panels = new Map();
  const message = { ...PANEL_CATALOG[0].sample, ttl_ms: 200 };
  assert.equal(applyPanelCommand(panels, message, 0), false);
  assert.equal(
    applyPanelCommand(panels, { kind: "panel", ...message }, 0),
    true,
  );
  assert.equal(livePanels(panels, 201).length, 0);
});

test("expired panels cannot accept actions or delayed receipts", async () => {
  const { beginPanelAction, applyPanelResult } =
    await import("../src/panel-state.js");
  const panels = new Map();
  const sample = PANEL_CATALOG.find((p) => p.type === "approval").sample;
  applyPanelCommand(panels, sample, 0);
  assert.equal(
    beginPanelAction(panels, sample.id, "review", "r1", 59999),
    true,
  );
  assert.equal(
    applyPanelResult(
      panels,
      {
        panel_id: sample.id,
        action_id: "review",
        request_id: "r1",
        status: "received",
      },
      60000,
    ),
    false,
  );
  applyPanelCommand(panels, sample, 0);
  assert.equal(
    beginPanelAction(panels, sample.id, "review", "r2", 60000),
    false,
  );
});
