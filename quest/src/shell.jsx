import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  ArrowUpRight,
  ArrowRight,
  CircleHelp,
  Focus,
  Layers3,
  Mic,
  MicOff,
  Play,
  Scan,
  Settings2,
  Users,
  X,
  Zap,
  Check,
  Glasses,
  RotateCcw,
} from "lucide-react";
import { PanelLibrary, ToolPanels } from "./PanelLibrary.jsx";
import Dock from "./components/Dock.jsx";
import { ServicePanel } from "./ServicePanel.jsx";

const views = [
  { id: "person", label: "context", Icon: Users },
  { id: "memories", label: "memories", Icon: Layers3 },
  { id: "agents", label: "agents", Icon: Zap },
];
const chapters = ["the encounter", "a memory made", "a little help"];

function Shell({ api }) {
  const [state, setState] = useState(api.snapshot);
  const [settings, setSettings] = useState(false);
  const [service, setService] = useState(false);
  const [serviceTarget, setServiceTarget] = useState(null);
  useEffect(() => {
    const open = event => { setServiceTarget(event.detail); setService(true); };
    window.addEventListener('world:details', open);
    return () => window.removeEventListener('world:details', open);
  }, []);
  const [help, setHelp] = useState(false);
  const [name, setName] = useState("");
  const [track, setTrack] = useState("");
  const [enrolled, setEnrolled] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => api.subscribe(() => setState(api.snapshot())), [api]);
  useEffect(() => {
    const onKey = (event) => {
      if (
        event.target.closest("input,select,textarea") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.key === "Escape") {
        setSettings(false);
        setService(false);
        setHelp(false);
        api.dismiss();
      }
      if (state.mode !== "idle" && ["1", "2", "3"].includes(event.key))
        api.view(views[Number(event.key) - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, state.mode]);
  const active = state.mode !== "idle";
  const preview = state.mode === "preview";
  const transition = { duration: reduced ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] };
  const dockItems = views.map(({ id, label, Icon }) => ({
    icon: (
      <span className="dock-glyph">
        <Icon size={21} strokeWidth={1.5} />
        <span>{label}</span>
      </span>
    ),
    label: `${label} · ${views.findIndex((v) => v.id === id) + 1}`,
    className: state.view === id ? "is-active" : "",
    onClick: () => api.view(id),
  }));
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="WORLD home">
          <span className="world-symbol">
            <i />
            <i />
            <i />
          </span>
          world<span className="wordmark-period">.</span>
        </a>
        <div className="topbar-center">
          <span className="hairline" /> a reality layer for your life{" "}
          <span className="hairline" />
        </div>
        <div className="topbar-actions">
          {state.mode !== "live" && <button className="library-toggle" onClick={api.connectAgent}>connect live</button>}
          <button className="library-toggle" aria-expanded={service}
            onClick={() => { setService(!service); setServiceTarget(null); setSettings(false); setHelp(false); }}>
            service
          </button>
          <button className="library-toggle" onClick={api.openStudio}>
            panels <span>24</span>
          </button>
          <span className={`mode-badge ${active ? "is-active" : ""}`}>
            <span />
            {state.studio
              ? "panel lab"
              : preview
                ? "preview"
                : active
                  ? "live session"
                  : "standby"}
          </span>
          <button
            className="icon-button"
            aria-label="How to use WORLD"
            aria-expanded={help}
            onClick={() => {
              setHelp(!help);
              setSettings(false);
            }}
          >
            <CircleHelp size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Open settings"
            aria-expanded={settings}
            onClick={() => {
              setSettings(!settings);
              setHelp(false);
            }}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {service && <ServicePanel target={serviceTarget} onClose={() => { setService(false); setServiceTarget(null); }} onConnect={api.connectAgent} />}
      <main
        className={`experience ${active ? "is-active" : ""} ${state.studio ? "is-studio" : ""}`}
      >
        <div className="frame-corner top-left" />
        <div className="frame-corner top-right" />
        <div className="frame-corner bottom-left" />
        <div className="frame-corner bottom-right" />
        <div className="scene-caption">
          <span className="tiny-cross">+</span>
          {state.camera
            ? "your perspective"
            : "spatial interface / environment preview"}
        </div>
        {!state.studio && (
          <AnimatePresence mode="wait">
            {!active ? (
              <motion.section
                className="welcome"
                key="welcome"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={transition}
              >
                <div className="eyebrow">
                  <span className="short-rule" /> HERE. NOW. WITH CONTEXT.
                </div>
                <h1>
                  a little more
                  <br />
                  <em>present.</em>
                </h1>
                <p>
                  keep the conversation.
                  <br />
                  we’ll keep the context.
                </p>
                <div className="welcome-actions">
                  <button className="button-primary" onClick={api.preview}>
                    step inside <ArrowUpRight size={18} />
                  </button>
                  <span>no headset needed</span>
                </div>
              </motion.section>
            ) : (
              <motion.section
                className="session-context"
                key="session"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={transition}
              >
                <div className="eyebrow">
                  <span className="short-rule" />
                  {preview
                    ? `0${state.previewPhase + 1} / ${chapters[state.previewPhase]}`
                    : "your world, in context"}
                </div>
                <h1>
                  {preview ? (
                    [
                      "stay in the\nmoment.",
                      "worth\nremembering.",
                      "already\nin motion.",
                    ][state.previewPhase]
                      .split("\n")
                      .map((line, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <br />}
                          {line}
                        </React.Fragment>
                      ))
                  ) : (
                    <>
                      room for
                      <br />
                      real life.
                    </>
                  )}
                </h1>
                <p>
                  {preview
                    ? [
                        "Matthew is a simulated encounter. Select the label to explore the context.",
                        "Feedback and a promise, captured as two useful memories.",
                        "Three agents turn the conversation into context and drafts.",
                      ][state.previewPhase]
                    : state.connected
                      ? "select a person to bring their context into view."
                      : "waiting for the world service. camera and headset controls remain available."}
                </p>
                <div className="session-meta">
                  <span className="live-dot" />
                  {preview
                    ? "simulated session · no capture"
                    : state.connected
                      ? "world service connected"
                      : "world service offline"}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        )}

        {!active && (
          <section className="setup-card" aria-label="Start a live session">
            <div className="setup-top">
              <Glasses size={23} strokeWidth={1.3} />
              <span>made for the real world</span>
              <span className="setup-index">01</span>
            </div>
            <h2>
              bring your world
              <br />
              into view.
            </h2>
            <p>connect your camera, or open WORLD in your Quest browser.</p>
            <button
              className="button-light"
              disabled={state.busy}
              onClick={api.live}
            >
              {state.busy ? "connecting…" : "start camera + mic"}
              <ArrowRight size={17} />
            </button>
            <div className="setup-foot">
              <span className="mini-dot" /> camera & microphone permission
              required
            </div>
          </section>
        )}
        {active && !state.studio && !(preview && state.previewPhase === 2) && (
          <div className="people-access" aria-label="People in view">
            {state.people.map((person) => (
              <button
                key={person.id}
                className={
                  state.selectedTrack === person.id
                    ? "person-chip selected"
                    : "person-chip"
                }
                onClick={() => api.select(person.id)}
                aria-pressed={state.selectedTrack === person.id}
              >
                <Focus size={14} />
                {person.name.toLowerCase()}
                <span>
                  {state.selectedTrack === person.id ? "selected" : "select"}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="viewfinder-center" aria-hidden="true">
          <span />
          <span />
        </div>
        {preview && !state.studio && (
          <div className="preview-sequence">
            <div className="sequence-heading">
              <span>explore the encounter</span>
              <button
                className="icon-button small"
                aria-label="Restart preview"
                onClick={() => api.phase(0)}
              >
                <RotateCcw size={14} />
              </button>
            </div>
            <div className="sequence-steps">
              {chapters.map((chapter, i) => (
                <button
                  key={chapter}
                  onClick={() => api.phase(i)}
                  className={state.previewPhase === i ? "current" : ""}
                  aria-pressed={state.previewPhase === i}
                >
                  <span>0{i + 1}</span>
                  {chapter}
                  {state.previewPhase === i && <ArrowUpRight size={14} />}
                </button>
              ))}
            </div>
          </div>
        )}
        {active && !preview && !state.people.length && !state.panels.length && (
          <div className="waiting-label">
            <Scan size={20} strokeWidth={1.25} />
            <span>
              {state.connected
                ? "waiting for a person to enter the frame"
                : "connect the world service to receive context"}
            </span>
          </div>
        )}
        {state.studio && <PanelLibrary state={state} api={api} />}
        <div className="scene-footer">
          <span>
            {preview
              ? "DEMO / FICTIONAL DATA"
              : state.camera
                ? "LIVE / CAMERA VIEW"
                : "WORLD / SPATIAL INTERFACE"}
          </span>
          <span>
            {preview
              ? "click to select · 1 / 2 / 3 to switch"
              : "built for presence"}
          </span>
        </div>
      </main>
      <ToolPanels state={state} api={api} />

      <footer className="bottom-bar">
        <div className="connection-summary">
          <span
            className={`connection-dot ${state.connected || preview ? "ok" : ""}`}
          />
          <span>
            {preview
              ? state.camera
                ? "local camera preview"
                : "preview environment"
              : active
                ? state.connected
                  ? "connected"
                  : "service offline"
                : "ready when you are"}
            <small>
              {preview
                ? state.camera
                  ? "camera on · stays on this device · microphone off"
                  : "camera & microphone off"
                : state.camera
                  ? `${state.fps.toFixed(1)} fps · ${state.mic ? (state.muted ? "microphone muted" : "microphone on") : "microphone off"}`
                  : "nothing is being captured"}
            </small>
          </span>
        </div>
        {active && !state.studio ? (
          <div className="dock-wrap">
            <Dock
              items={dockItems}
              baseItemSize={62}
              magnification={reduced ? 62 : 68}
              panelHeight={69}
              dockHeight={84}
              distance={100}
              spring={{ mass: 0.15, stiffness: 220, damping: 25 }}
            />
          </div>
        ) : (
          <div className="bottom-philosophy">
            {state.studio
              ? "a thought, given form."
              : "less interface. more life."}
          </div>
        )}
        <div className="session-actions">
          {state.mode === "live" && !state.camera && <button disabled={state.busy} onClick={api.live}>{state.busy ? "connecting…" : "start camera + mic"}</button>}
          {active && (
            <>
              {state.mic && (
                <button
                  className="icon-button"
                  onClick={api.toggleMic}
                  aria-label={
                    state.muted ? "Unmute microphone" : "Mute microphone"
                  }
                  aria-pressed={state.muted}
                >
                  {state.muted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
              )}
              {state.arSupported && (
                <button
                  className="button-quiet"
                  disabled={state.busy || state.inAR}
                  onClick={api.enterAR}
                >
                  <Glasses size={17} />
                  {state.inAR ? "in AR" : "enter AR"}
                </button>
              )}
              <button
                className="button-quiet end-session"
                onClick={api.endSession}
                disabled={state.busy}
              >
                <X size={15} />
                exit
              </button>
            </>
          )}
          {!active && <span className="edition">FIELD NOTES / 001</span>}
        </div>
      </footer>

      <section
        className="sr-only"
        aria-live="polite"
        aria-label="Selected context"
      >
        {state.view === "person" &&
          state.people
            .filter((p) => p.id === state.selectedTrack)
            .map((p) => (
              <div key={p.id}>
                <h2>{p.name}</h2>
                <p>{p.subtitle}</p>
                {p.person_id && <><button disabled={!!p._actionState?.adopt} onClick={() => api.personAction(p.id, 'adopt')}>give {p.name} an agent</button><button disabled={!!p._actionState?.watch} onClick={() => api.personAction(p.id, 'watch')}>watch feature requests from {p.name}</button></>}
                <p>
                  last conversation: {p.last || "none yet"}. from them:{" "}
                  {p.owes_you || "nothing pending"}. your next step:{" "}
                  {p.you_owe || "nothing pending"}.
                </p>
              </div>
            ))}
        {state.view === "memories" && (
          <>
            <h2>recent memories</h2>
            {state.memories.length ? (
              state.memories.slice(-3).map((m, i) => (
                <p key={i}>
                  {m.text}: {m.detail}
                </p>
              ))
            ) : (
              <p>saved moments will collect here.</p>
            )}
          </>
        )}
        {state.view === "agents" && (
          <>
            <h2>agent activity</h2>
            {state.workers.length ? (
              state.workers.map((w, i) => (
                <p key={i}>
                  {w.name}: {w.state}. {w.note}
                </p>
              ))
            ) : (
              <p>nothing needs your attention.</p>
            )}
          </>
        )}
      </section>
      <AnimatePresence>
        {state.error && (
          <motion.div
            role="alert"
            className="error-notice"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <span>{state.error}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(settings || help) && (
          <motion.aside
            className="utility-panel"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={transition}
            aria-label={settings ? "Settings" : "How to use WORLD"}
          >
            <div className="utility-heading">
              <h2>{settings ? "your setup" : "a few small gestures"}</h2>
              <button
                className="icon-button"
                aria-label="Close panel"
                onClick={() => {
                  setSettings(false);
                  setHelp(false);
                }}
              >
                <X size={18} />
              </button>
            </div>
            {help ? (
              <>
                <div className="help-row">
                  <Focus />
                  <div>
                    <h3>select what matters</h3>
                    <p>
                      click a person label on desktop. in AR, point with your
                      hand or controller and pinch or press the trigger.
                    </p>
                  </div>
                </div>
                <div className="help-row">
                  <Layers3 />
                  <div>
                    <h3>go a little deeper</h3>
                    <p>
                      use the dock for context, memories, and agent progress.
                      keyboard: 1, 2, 3. escape closes details.
                    </p>
                  </div>
                </div>
                <div className="help-row">
                  <Glasses />
                  <div>
                    <h3>take it into the room</h3>
                    <p>
                      on Quest: start camera + mic, allow permissions, then
                      select enter AR. preview also works in the emulator.
                    </p>
                  </div>
                </div>
                <p className="privacy-note">
                  recognition uses enrolled people only. raw camera and audio
                  are processed transiently; the world service stores structured
                  events.
                </p>
              </>
            ) : (
              <>
                <div className="setting-row">
                  <span>world service</span>
                  <span
                    className={state.connected ? "text-accent" : "text-muted"}
                  >
                    {state.connected
                      ? "connected"
                      : preview
                        ? "not used in preview"
                        : "offline"}
                  </span>
                </div>
                <div className="setting-row">
                  <span>headset</span>
                  <span className="text-muted">
                    {state.arSupported
                      ? "AR available"
                      : "AR unavailable in this browser"}
                  </span>
                </div>
                {state.cameras.length > 0 && (
                  <label className="field-label">
                    camera
                    <select
                      value={state.cameraId}
                      disabled={state.busy}
                      onChange={(e) => api.camera(e.target.value)}
                    >
                      {state.cameras.map((camera) => (
                        <option key={camera.deviceId} value={camera.deviceId}>
                          {camera.label || "camera"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  className="button-light"
                  disabled={state.busy}
                  onClick={async () => {
                    await api.live();
                  }}
                >
                  {state.busy
                    ? "connecting…"
                    : state.camera
                      ? "reconnect camera + mic"
                      : "start camera + mic"}
                  <ArrowUpRight size={17} />
                </button>
                <button
                  className="button-quiet full"
                  disabled={state.busy}
                  onClick={() => {
                    api.preview();
                    setSettings(false);
                  }}
                >
                  <Play size={14} />
                  explore the preview
                </button>
                {state.mode === "live" && (
                  <form
                    className="enroll-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (api.label(track, name)) {
                        setEnrolled(true);
                        setName("");
                      }
                    }}
                  >
                    <h3>enroll someone you know</h3>
                    <p>
                      only with their permission. enter the track number
                      supplied by perception.
                    </p>
                    <div className="form-row">
                      <label className="field-label">
                        name
                        <input
                          required
                          value={name}
                          onChange={(e) => {
                            setName(e.target.value);
                            setEnrolled(false);
                          }}
                          placeholder="e.g. Matthew"
                        />
                      </label>
                      <label className="field-label track-field">
                        track
                        <input
                          required
                          type="number"
                          min="0"
                          value={track}
                          onChange={(e) => setTrack(e.target.value)}
                          placeholder="3"
                        />
                      </label>
                    </div>
                    <button
                      className="button-quiet full"
                      type="submit"
                      disabled={!state.connected}
                    >
                      <Check size={14} />
                      {enrolled ? "enrollment requested" : "enroll person"}
                    </button>
                  </form>
                )}
                <details className="diagnostics">
                  <summary>connection details</summary>
                  <pre>
                    {state.logs.join("\n") || "no connection activity yet"}
                  </pre>
                </details>
              </>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
export function mountShell(api) {
  createRoot(document.getElementById("app-shell")).render(<Shell api={api} />);
}
