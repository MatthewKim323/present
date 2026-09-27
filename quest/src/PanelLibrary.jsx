import React, { useState } from "react";
import { ArrowUpRight, Plus, X, Copy, Check } from "lucide-react";
import { PANEL_CATALOG } from "./panel-catalog.js";
import { GlassPanel } from "./components/GlassPanel.jsx";

export function PanelLibrary({ state, api }) {
  const [filter, setFilter] = useState("all");
  const [showCall, setShowCall] = useState(false);
  const [copied, setCopied] = useState(false);
  const [keepVisible, setKeepVisible] = useState(false);
  const categories = ["all", ...new Set(PANEL_CATALOG.map((p) => p.category))];
  const current =
    PANEL_CATALOG.find((p) => p.type === state.studioType) || PANEL_CATALOG[0];
  const example = JSON.stringify(current.sample, null, 2);
  return (
    <>
      <aside className="panel-library" aria-label="Panel library">
        <div className="library-heading">
          <span>THE SURFACE LIBRARY</span>
          <span>{String(PANEL_CATALOG.length).padStart(2, "0")}</span>
        </div>
        <h1>just enough.</h1>
        <p>one thought. one surface.</p>
        <div
          className="library-filters"
          role="group"
          aria-label="Panel categories"
        >
          {categories.map((category) => (
            <button
              key={category}
              className={filter === category ? "selected" : ""}
              aria-pressed={filter === category}
              onClick={() => setFilter(category)}
            >
              {category}
            </button>
          ))}
        </div>
        <div className="library-types">
          {PANEL_CATALOG.filter(
            (p) => filter === "all" || p.category === filter,
          ).map((entry, index) => (
            <button
              key={entry.type}
              className={entry.type === state.studioType ? "selected" : ""}
              aria-pressed={entry.type === state.studioType}
              onClick={() => api.summon(entry.type, keepVisible)}
            >
              <span>
                {String(PANEL_CATALOG.indexOf(entry) + 1).padStart(2, "0")}
              </span>
              {entry.label}
              <ArrowUpRight size={13} />
            </button>
          ))}
        </div>
        <div className="library-footer">
          <button
            aria-pressed={keepVisible}
            onClick={() => setKeepVisible(!keepVisible)}
          >
            <Plus size={13} />
            {keepVisible ? "keeping · max 3" : "keep in view"}
          </button>
          <button
            onClick={() => setShowCall(!showCall)}
            aria-expanded={showCall}
          >
            tool call <span>↗</span>
          </button>
        </div>
      </aside>
      <div className="library-caption">
        <span>{current.label}</span>
        <span>{current.description}</span>
      </div>
      <div className="library-session">
        <span>illustrative content · no actions executed</span>
        <button className="button-quiet" onClick={api.connectAgent}>
          connect agent <ArrowUpRight size={14} />
        </button>
      </div>
      {showCall && (
        <section
          className="tool-call-panel"
          aria-label="Agent tool call example"
        >
          <header>
            <span>world_panel</span>
            <button
              className="icon-button"
              onClick={() => setShowCall(false)}
              aria-label="Close tool call"
            >
              <X size={16} />
            </button>
          </header>
          <p>POST /tools/world-panel · schema at GET /tools</p>
          <pre>{example}</pre>
          <button
            className="button-quiet"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(example);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "copied" : "copy arguments"}
          </button>
        </section>
      )}
    </>
  );
}

export function ToolPanels({ state, api }) {
  if (!state.panels.length)
    return state.studio ? (
      <div className="panel-empty">
        <span>space to think.</span>
        <button
          className="button-quiet"
          onClick={() => api.summon(state.studioType)}
        >
          summon panel <Plus size={14} />
        </button>
      </div>
    ) : null;
  return (
    <div
      className={`tool-panels ${state.studio ? "in-library" : ""} count-${state.panels.length} position-${state.panels[0]?.position || "center"}`}
      aria-label="Spatial panels"
    >
      {[...state.panels]
        .sort(
          (a, b) =>
            ["left", "center", "right"].indexOf(a.position || "center") -
            ["left", "center", "right"].indexOf(b.position || "center"),
        )
        .map((panel) => (
          <GlassPanel
            key={panel.id}
            panel={panel}
            onAction={(id, action) => api.panelAction(id, action)}
            onDismiss={(id) => api.panelDismiss(id)}
          />
        ))}
    </div>
  );
}
