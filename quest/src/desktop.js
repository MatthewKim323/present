import { deltasAnimating, DesktopDev } from "./devpanels.js";
import { drawActionPerson as drawPersonCard } from './person-actions.js';
import { DesktopVision } from "./visionfx.js";
import { DesktopSwarm } from './swarmviz.js';
import { DesktopBrain } from './brainpanel.js';
import { DesktopMemory } from './memorypanel.js';
import { safe, frameBegin, frameEnd } from './perf.js';
// Desktop is a spatial preview: labels stay beside people; detail is intentional.
import {
  drawPersonLabel,
  drawMemoryToast,
  drawMemoryList,
  drawAgentActivity,
  anyRunning,
} from "./panels.js";

const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));

export class DesktopHud {
  constructor({ canvas, video, hud, onPinch }) {
    Object.assign(this, { canvas, video, hud, onPinch });
    this.ctx = canvas.getContext("2d");
    this.cache = new Map();
    this.hits = [];
    this.running = false;
    this.dev = new DesktopDev(hud);
    this.vfx = new DesktopVision(hud); // perception overlay (visionfx.js)
    this.swarm = new DesktopSwarm(hud);
    this.brain = new DesktopBrain(hud);
    this.mem = new DesktopMemory(hud, this.dev);
    this.pointer = { x: -1, y: -1 };
    document.fonts?.ready.then(() => this.cache.clear());
    window.addEventListener("resize", () => this._resize());
    window.addEventListener("pointermove", (e) => {
      this.pointer = e.target.closest?.("#ui, #app-shell, #dev-preview, button, input, a")
        ? { x: -1, y: -1 }
        : { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("click", (e) => {
      if (
        !this.running ||
        e.target.closest?.("#ui, #app-shell, #dev-preview, button, input, a")
      )
        return;
      if (this.dev.click(e.clientX, e.clientY)) return;
      const hit = [...this.hits]
        .reverse()
        .find((h) => this._inside(h, e.clientX, e.clientY));
      if (hit?.localAction) { this.hud.onPersonAction?.(hit.track, hit.localAction); return; }
      if (hit) {
        this.hud.select(hit.track);
        this.onPinch?.(hit.track);
      }
    });
    this._resize();
  }

  _inside(h, x, y) {
    return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
  }

  _resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = innerWidth * d;
    this.canvas.height = innerHeight * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      const t0 = frameBegin();
      safe('desktop draw', () => this.draw());
      frameEnd(t0);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  _videoRect() {
    const preview = document.body.dataset.mode === "preview";
    const scene = document.querySelector("#scene");
    const rect = (preview ? scene : this.video)?.getBoundingClientRect();
    const area =
      rect?.width && rect?.height
        ? rect
        : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    // Preview coordinates belong to the virtual scene; camera coordinates belong
    // to the contained video pixels, including their actual letterbox offsets.
    if (preview) return { x: area.x, y: area.y, w: area.width, h: area.height };
    const vw = this.video.videoWidth || 4,
      vh = this.video.videoHeight || 3;
    const scale = Math.min(area.width / vw, area.height / vh);
    const w = vw * scale,
      h = vh * scale;
    return {
      x: area.x + (area.width - w) / 2,
      y: area.y + (area.height - h) / 2,
      w,
      h,
    };
  }

  _raster(key, msg, fn) {
    if (fn === drawPersonCard && deltasAnimating(msg)) return fn(msg);
    const cached = this.cache.get(key);
    if (cached?.msg === msg) return cached.canvas;
    const canvas = fn(msg);
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(key, { msg, canvas });
    return canvas;
  }

  _contentArea() {
    const surface =
      document.body.dataset.mode === "live"
        ? this.video
        : document.querySelector("#scene");
    const measured = surface?.getBoundingClientRect();
    const rect = measured?.width && measured?.height ? measured : null;
    const left = (rect?.left ?? 12) + 16,
      right = (rect?.right ?? innerWidth - 12) - 16;
    const top = Math.max(165, (rect?.top ?? 94) + 64);
    let bottom = (rect?.bottom ?? innerHeight - 108) - 48;
    if (innerWidth < 900 && document.body.dataset.mode === "preview") {
      bottom = Math.min(bottom, innerHeight - 245);
      for (const selector of [".preview-sequence"]) {
        const control = document
          .querySelector(selector)
          ?.getBoundingClientRect();
        if (control?.height) bottom = Math.min(bottom, control.top - 16);
      }
    }
    return { left, right, top, bottom: Math.max(top + 90, bottom) };
  }

  _place(c, x, y, area = this._contentArea()) {
    const scale = Math.min(
      1,
      (area.right - area.left) / (c.width / 2),
      (area.bottom - area.top) / (c.height / 2),
    );
    const w = (c.width / 2) * scale,
      h = (c.height / 2) * scale;
    const bounds = {
      x: clamp(x, area.left, area.right - w),
      y: clamp(y, area.top, area.bottom - h),
      w,
      h,
    };
    this.ctx.drawImage(c, bounds.x, bounds.y, w, h);
    return bounds;
  }

  draw() {
    const { ctx, hud } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    this.hits = [];
    this.dev.hits = [];
    this.dev.pv = null;
    if (hud.surfacePanels().length) {
      this.dev._preview(ctx, performance.now());
      return;
    }
    const vr = this._videoRect();
    const placed = new Map();
    const selected = hud.selectedTrack;
    const compact = innerWidth < 900;
    const area = this._contentArea();
    const hasDetail =
      hud.view !== "person" || (selected != null && hud.cards.has(selected));

    for (const [id] of hud.tracks) {
      const b = hud.bboxFor(id);
      if (!b) continue;
      const box = {
        track: id,
        x: vr.x + b[0] * vr.w,
        y: vr.y + b[1] * vr.h,
        w: b[2] * vr.w,
        h: b[3] * vr.h,
      };
      this.hits.push(box);
      // Focus brackets replace the surveillance-style bounding rectangle.
      if (id !== selected && !this._inside(box, this.pointer.x, this.pointer.y))
        continue;
      ctx.strokeStyle =
        id === selected ? "rgba(217,242,121,0.75)" : "rgba(242,240,233,0.5)";
      ctx.lineWidth = 1.5;
      for (const [x, y, dx, dy] of [
        [box.x, box.y, 1, 1],
        [box.x + box.w, box.y, -1, 1],
        [box.x, box.y + box.h, 1, -1],
        [box.x + box.w, box.y + box.h, -1, -1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x, y + 15 * dy);
        ctx.lineTo(x, y);
        ctx.lineTo(x + 15 * dx, y);
        ctx.stroke();
      }
    }

    let freeY = area.top;
    for (const [id, msg] of hud.cards) {
      // The expanded panel already identifies its person; don't spend scarce
      // mobile space repeating that label above it.
      if (compact && hasDetail && id === selected) continue;
      const b = hud.bboxFor(id);
      let x = innerWidth - 270,
        y = freeY;
      if (b) {
        x = vr.x + (b[0] + b[2]) * vr.w + 20;
        y = vr.y + b[1] * vr.h;
        if (x + 238 > innerWidth - 16) x = vr.x + b[0] * vr.w - 258;
      }
      const previous = this.cache.get(`bounds:${id}`);
      const focused = previous
        ? this._inside(previous, this.pointer.x, this.pointer.y)
        : false;
      const c = this._raster(
        `label:${id}:${id === selected}:${focused}`,
        msg,
        (m) => drawPersonLabel(m, { selected: id === selected, focused }),
      );
      if (compact) {
        x =
          innerWidth > 700
            ? area.right - c.width / 2
            : (innerWidth - c.width / 2) / 2;
        y = freeY;
      }
      const p = this._place(c, x, y, area);
      this.cache.set(`bounds:${id}`, p);
      placed.set(id, p);
      this.hits.push({ track: id, ...p });
      if (compact || !b) freeY = p.y + p.h + 12;
    }

    let detail = null;
    if (hud.view === "memories") {
      detail = this._raster("memories", hud.memoryHistory, drawMemoryList);
    } else if (hud.view === "agents") {
      const msg =
        hud.activity.get(selected) || [...hud.activity.values()].at(-1);
      detail = msg
        ? anyRunning(msg)
          ? drawAgentActivity(msg)
          : this._raster("activity", msg, drawAgentActivity)
        : this._raster("empty-activity", null, () => drawAgentActivity());
    } else if (selected != null && hud.cards.has(selected)) {
      detail = this._raster(
        `detail:${selected}`,
        hud.cards.get(selected),
        drawPersonCard,
      );
    }
    if (detail) {
      const p = placed.get(selected);
      let x = p?.x ?? area.right - 300,
        y = p ? p.y + p.h + 10 : area.top;
      let detailArea = area;
      if (compact) {
        x =
          innerWidth > 700
            ? area.right - detail.width / 2
            : (innerWidth - detail.width / 2) / 2;
        y = area.top;
      } else if (p)
        detailArea = {
          ...area,
          top: Math.min(p.y + p.h + 10, area.bottom - 90),
        };
      const detailRect = this._place(detail, x, y, detailArea);
      if (hud.view === 'person' && selected != null) {
        const scale = detailRect.w / (detail.width / 2);
        for (const action of detail.localActions || []) this.hits.push({
          track: selected, localAction: action.action,
          x: detailRect.x + action.x * scale, y: detailRect.y + action.y * scale,
          w: action.w * scale, h: action.h * scale,
        });
      }
      if (hud.view === "person" && selected != null) placed.set(selected, detailRect);
    }

    safe('desktop swarm', () => this.swarm.draw(ctx, vr));
    safe('desktop dev', () => this.dev.draw(ctx, placed, vr));
    safe('desktop brain', () => this.brain.draw(ctx, placed, vr));
    safe('desktop memory', () => this.mem.draw(ctx));
    safe('desktop vision', () => this.vfx.draw(ctx, placed, vr, this.hits));

    // One quiet acknowledgement at a time; older events remain in Memories.
    const toast = hud.liveToasts().at(-1);
    if (
      toast &&
      hud.view !== "memories" &&
      !(hasDetail && (compact || document.body.dataset.mode === "preview"))
    ) {
      const c = this._raster(`toast:${toast.t}`, toast, drawMemoryToast);
      ctx.globalAlpha = clamp(
        toast.age < 0.08
          ? toast.age / 0.08
          : toast.age > 0.85
            ? (1 - toast.age) / 0.15
            : 1,
        0,
        1,
      );
      // Keep notifications opposite the context panel on wider displays.
      const toastArea = compact
        ? area
        : { ...area, top: area.bottom - 78, bottom: area.bottom };
      this._place(
        c,
        compact ? (innerWidth - 300) / 2 : area.left,
        area.bottom - c.height / 2,
        toastArea,
      );
      ctx.globalAlpha = 1;
    }
  }
}
