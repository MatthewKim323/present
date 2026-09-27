// Shared spatial UI. Rasterized at 2× for desktop and WebXR texture planes.
const FONT = '"DM Sans", ui-sans-serif, -apple-system, system-ui, sans-serif';
const ACCENT = "#ffffff";
const INK = "#f5f5f5";
const MUTED = "#b7b7b7";
const S = 2;

function panel(w, h) {
  const c = document.createElement("canvas");
  c.width = w * S;
  c.height = h * S;
  const ctx = c.getContext("2d");
  ctx.scale(S, S);
  return { c, ctx, w, h };
}

// Text and a quiet readability tint; native XR camera refraction is a separate
// shader behind this canvas, so typography stays sharp.
function glass(ctx, w, h, r = 18, reflect = true) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, r);
  const tint = ctx.createLinearGradient(0, 0, 0, h);
  tint.addColorStop(0, "rgba(42,42,42,0.14)");
  tint.addColorStop(1, "rgba(12,12,12,0.26)");
  ctx.fillStyle = tint;
  ctx.fill();
  if (!reflect) {
    ctx.restore();
    return;
  }
  const edge = ctx.createLinearGradient(0, 0, w, h);
  edge.addColorStop(0, "rgba(255,255,255,0.54)");
  edge.addColorStop(0.4, "rgba(255,255,255,0.10)");
  edge.addColorStop(1, "rgba(255,255,255,0.25)");
  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, r - 2);
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.stroke();
  ctx.restore();
}

function text(
  ctx,
  value,
  x,
  y,
  { size = 13, weight = 400, color = INK, max = 268, track = 0 } = {},
) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${track}px`;
  let str = String(value ?? "");
  if (ctx.measureText(str).width > max) {
    while (str.length && ctx.measureText(`${str}…`).width > max)
      str = str.slice(0, -1);
    str += "…";
  }
  ctx.fillText(str, x, y);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

function lines(ctx, value, width, size = 13, maxLines = 2) {
  ctx.font = `400 ${size}px ${FONT}`;
  const words = String(value ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const result = [];
  let row = "";
  for (const word of words) {
    if (row && ctx.measureText(`${row} ${word}`).width > width) {
      result.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  if (row) result.push(row);
  if (result.length > maxLines)
    return [
      ...result.slice(0, maxLines - 1),
      result.slice(maxLines - 1).join(" "),
    ];
  return result;
}

function rule(ctx, y, w = 300) {
  ctx.beginPath();
  ctx.moveTo(18, y);
  ctx.lineTo(w - 18, y);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function brackets(ctx, w, h, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const [x, y, dx, dy] of [
    [2, 2, 1, 1],
    [w - 2, 2, -1, 1],
    [2, h - 2, 1, -1],
    [w - 2, h - 2, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * 8);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * 8, y);
    ctx.stroke();
  }
}

export function drawPersonLabel(m, { selected = false, focused = false } = {}) {
  const { c, ctx, w, h } = panel(238, 66);
  glass(ctx, w, h, 13);
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(20, 23, 3, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, m.name || "Someone nearby", 33, 28, {
    size: 17,
    weight: 500,
    max: 184,
  });
  text(ctx, m.subtitle || "Select to see context", 33, 47, {
    size: 11,
    color: MUTED,
    max: 184,
  });
  if (m.agent) text(ctx, 'AGENT', 184, 28, { size: 9, weight: 600, color: MUTED, max: 45, track: 0.8 });
  if (selected || focused)
    brackets(ctx, w, h, selected ? ACCENT : "rgba(255,255,255,0.7)");
  return c;
}

export function drawPersonCard(m) {
  const probe = panel(1, 1).ctx;
  const rows = [
    m.relationship && ["RELATIONSHIP", m.relationship],
    m.seen_before && ["LAST SEEN", [m.seen_before.ago || m.seen_before.when, m.seen_before.where].filter(Boolean).join(" · ")],
    m.here && ["HERE", m.here],
    m.last && ["LAST CONVERSATION", m.last],
    m.owes_you && ["FROM THEM", m.owes_you],
    m.you_owe && ["YOUR NEXT STEP", m.you_owe],
    m.watching && ["WATCHING", m.watching],
  ]
    .filter(Boolean)
    .map(([label, value]) => ({
      label,
      content: lines(probe, value, 262, 14, 2),
    }));
  const h =
    88 +
    rows.reduce((sum, row) => sum + 32 + row.content.length * 19, 0) +
    (rows.length ? 4 : 34);
  const { c, ctx, w } = panel(300, h);
  glass(ctx, w, h);
  text(ctx, "PERSON CONTEXT", 18, 25, {
    size: 9,
    weight: 600,
    color: MUTED,
    track: 1.5,
  });
  text(ctx, m.name || "Someone nearby", 18, 53, {
    size: 23,
    weight: 500,
    max: 264,
  });
  text(ctx, m.subtitle || "Your shared context", 18, 74, {
    size: 12,
    color: MUTED,
    max: 264,
  });
  let y = 89;
  for (const row of rows) {
    rule(ctx, y);
    text(ctx, row.label, 18, y + 21, {
      size: 9,
      weight: 600,
      color: row.label === "YOUR NEXT STEP" ? ACCENT : MUTED,
      track: 1,
    });
    row.content.forEach((line, i) =>
      text(ctx, line, 18, y + 41 + i * 19, { size: 14, max: 262 }),
    );
    y += 32 + row.content.length * 19;
  }
  if (!rows.length)
    text(ctx, "Shared history will appear here.", 18, 108, {
      size: 13,
      color: MUTED,
    });
  return c;
}

export function drawMemoryToast(m) {
  const { c, ctx, w, h } = panel(300, m.detail ? 70 : 48);
  glass(ctx, w, h, 14);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(18, 25);
  ctx.lineTo(22, 29);
  ctx.lineTo(29, 21);
  ctx.stroke();
  text(ctx, sentence(m.text || "Memory saved"), 40, 29, {
    size: 13,
    weight: 500,
    max: 241,
  });
  if (m.detail)
    text(ctx, m.detail, 40, 50, { size: 12, color: MUTED, max: 241 });
  return c;
}

export function drawMemoryList(history = []) {
  const items = history.slice(-3).reverse();
  const { c, ctx, w, h } = panel(
    300,
    items.length ? 56 + items.length * 76 : 126,
  );
  glass(ctx, w, h);
  text(ctx, "RECENT MEMORIES", 18, 26, {
    size: 10,
    weight: 600,
    color: ACCENT,
    track: 1.3,
  });
  if (!items.length) {
    text(ctx, "A little more present.", 18, 64, { size: 18, weight: 500 });
    text(ctx, "Saved moments will collect here.", 18, 88, {
      size: 12,
      color: MUTED,
    });
  }
  items.forEach((m, i) => {
    const y = 49 + i * 76;
    rule(ctx, y);
    text(ctx, sentence(m.text || "Memory saved"), 18, y + 24, {
      size: 13,
      weight: 500,
      max: 264,
    });
    lines(
      ctx,
      m.detail || "Available in your shared context",
      264,
      12,
      2,
    ).forEach((line, index) => {
      text(ctx, line, 18, y + 44 + index * 16, {
        size: 12,
        color: MUTED,
        max: 264,
      });
    });
  });
  return c;
}

export function drawAgentActivity(m = {}, t = performance.now()) {
  const workers = (Array.isArray(m.workers) ? m.workers : []).slice(0, 5);
  const running = workers.filter(
    (w) => (w.state || "running") === "running",
  ).length;
  const { c, ctx, w, h } = panel(
    300,
    workers.length ? 76 + workers.length * 64 : 126,
  );
  glass(ctx, w, h);
  text(ctx, "WORKING WITH YOU", 18, 26, {
    size: 10,
    weight: 600,
    color: ACCENT,
    track: 1.2,
  });
  text(
    ctx,
    workers.length
      ? running
        ? `${running} task${running === 1 ? "" : "s"} in motion`
        : "Your work is ready to review"
      : "Nothing needs your attention.",
    18,
    51,
    { size: 14, max: 264 },
  );
  if (!workers.length)
    text(ctx, "Agents appear when there’s work to do.", 18, 81, {
      size: 12,
      color: MUTED,
      max: 264,
    });
  workers.forEach((worker, i) => {
    const y = 68 + i * 64;
    const state = worker.state || "running";
    const label =
      state === "done"
        ? "Ready"
        : state === "failed"
          ? "Needs attention"
          : "Working";
    rule(ctx, y);
    ctx.fillStyle = state === "failed" ? "#ffffff" : ACCENT;
    ctx.globalAlpha =
      state === "running" ? 0.6 + 0.4 * Math.sin(t / 600) ** 2 : 1;
    ctx.beginPath();
    ctx.arc(22, y + 22, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    text(ctx, worker.name || "Assistant", 34, y + 27, {
      size: 13,
      weight: 500,
      max: 124,
    });
    text(ctx, label, 168, y + 26, {
      size: 10,
      color: state === "failed" ? "#ffffff" : MUTED,
      max: 112,
    });
    text(
      ctx,
      sentence(worker.note || "Finding the next useful step"),
      18,
      y + 48,
      { size: 12, color: MUTED, max: 264 },
    );
  });
  return c;
}

export function drawDock(view = "person") {
  const { c, ctx, w, h } = panel(300, 64);
  glass(ctx, w, h, 20);
  ["person", "memories", "agents"].forEach((item, i) => {
    const x = i * 100;
    if (item === view) {
      ctx.beginPath();
      ctx.roundRect(x + 6, 6, 88, 52, 14);
      ctx.fillStyle = "rgba(255,255,255,0.11)";
      ctx.fill();
    }
    const color = item === view ? ACCENT : MUTED;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (item === "person") {
      ctx.arc(x + 50, 20, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + 50, 32, 8, Math.PI, 0);
    } else if (item === "memories") {
      ctx.roundRect(x + 43, 15, 14, 16, 2);
      ctx.moveTo(x + 46, 20);
      ctx.lineTo(x + 54, 20);
      ctx.moveTo(x + 46, 25);
      ctx.lineTo(x + 52, 25);
    } else {
      ctx.arc(x + 50, 23, 3, 0, Math.PI * 2);
      ctx.moveTo(x + 40, 23);
      ctx.lineTo(x + 44, 23);
      ctx.moveTo(x + 56, 23);
      ctx.lineTo(x + 60, 23);
      ctx.moveTo(x + 50, 13);
      ctx.lineTo(x + 50, 17);
      ctx.moveTo(x + 50, 29);
      ctx.lineTo(x + 50, 33);
    }
    ctx.stroke();
    ctx.textAlign = "center";
    text(ctx, item[0].toUpperCase() + item.slice(1), x + 50, 48, {
      size: 10,
      weight: 500,
      color,
      max: 85,
    });
    ctx.textAlign = "left";
  });
  return c;
}

export function drawStatus(line) {
  const { c, ctx, w, h } = panel(360, 30);
  glass(ctx, w, h, 15);
  text(ctx, line, 14, 20, { size: 10, color: MUTED, max: 332 });
  return c;
}

function sentence(value) {
  const str = String(value).replaceAll("_", " ").replaceAll(".", " ").trim();
  return str && str === str.toUpperCase()
    ? str[0] + str.slice(1).toLowerCase()
    : str;
}

export const anyRunning = (m) =>
  (Array.isArray(m.workers) ? m.workers : []).some((w) => (w.state || "running") === "running");

// All 24 tool types share a restrained hierarchy. The fields determine the
// content, never executable markup. Hit rectangles are in unscaled CSS pixels.
export function drawToolPanel(m = {}) {
  const { c, ctx, w, h } = panel(320, 240);
  glass(ctx, w, h, 24, false);
  c.panelDismiss = { x: 280, y: 9, w: 30, h: 30 };
  c.panelActions = [];
  text(ctx, m.eyebrow || m.type || "panel", 20, 26, {
    size: 9,
    weight: 500,
    color: MUTED,
    track: 1.4,
    max: 252,
  });
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(292, 20);
  ctx.lineTo(300, 28);
  ctx.moveTo(300, 20);
  ctx.lineTo(292, 28);
  ctx.stroke();
  text(ctx, m.title || "Untitled", 20, 55, { size: 22, weight: 500, max: 280 });
  const items = (m.items || []).slice(0, 4);
  const hasValue = m.value != null && m.value !== "";
  const bodyLines = lines(
    ctx,
    m.body,
    280,
    13,
    items.length || hasValue ? 1 : 4,
  );
  bodyLines.forEach((line, i) =>
    text(ctx, line, 20, 80 + i * 20, {
      size: m.type === "quote" ? 16 : 13,
      color: MUTED,
      max: 280,
    }),
  );
  if (hasValue) {
    text(ctx, m.value, 20, items.length ? 110 : 142, {
      size: items.length ? 22 : 42,
      weight: 400,
      max: m.unit ? 220 : 280,
    });
    if (m.unit)
      text(ctx, m.unit, 240, items.length ? 108 : 139, {
        size: 11,
        color: MUTED,
        max: 60,
      });
  }
  const firstRow = hasValue ? 131 : 107;
  const rowGap = hasValue ? 17 : 22;
  items.forEach((item, i) => {
    const y = firstRow + i * rowGap;
    const checklist = ["checklist", "procedure"].includes(m.type);
    if (checklist) {
      ctx.beginPath();
      ctx.roundRect(20, y - 9, 9, 9, 2);
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.stroke();
      if (item.done) {
        ctx.beginPath();
        ctx.moveTo(22, y - 5);
        ctx.lineTo(24, y - 3);
        ctx.lineTo(28, y - 7);
        ctx.stroke();
      }
    }
    text(ctx, item.label, checklist ? 38 : 20, y, {
      size: 12,
      color: item.done ? MUTED : INK,
      max: item.value || item.state ? 174 : 280,
    });
    if (item.value || item.state) {
      ctx.textAlign = "right";
      text(ctx, item.value || item.state, 300, y, {
        size: 11,
        color: MUTED,
        max: 98,
      });
      ctx.textAlign = "left";
    }
  });
  if (m.result?.status === "rejected") {
    text(ctx, "Not recorded · try again", 20, 189, {
      size: 10,
      color: MUTED,
      max: 280,
    });
  } else if (typeof m.progress === "number") {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(20, 190, 280, 2);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(20, 190, 280 * Math.max(0, Math.min(1, m.progress)), 2);
  } else if (m.meta)
    text(ctx, m.meta, 20, 189, { size: 10, color: MUTED, max: 280 });
  if (m.pendingAction || m.result?.status === "received") {
    const label = m.pendingAction ? "Recording…" : "Choice recorded";
    text(ctx, label, 20, 220, { size: 12, color: MUTED, max: 280 });
  } else {
    const actions = (m.actions || []).slice(0, 2);
    const width = actions.length === 1 ? 280 : 136;
    actions.forEach((action, i) => {
      const rect = { id: action.id, x: 20 + i * 144, y: 203, w: width, h: 26 };
      c.panelActions.push(rect);
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
      ctx.fillStyle = "rgba(255,255,255,0.09)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.textAlign = "center";
      text(ctx, action.label, rect.x + rect.w / 2, 220, {
        size: 11,
        weight: 500,
        max: rect.w - 16,
      });
      ctx.textAlign = "left";
    });
  }
  return c;
}
