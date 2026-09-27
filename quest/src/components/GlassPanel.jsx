import React from "react";
import GlassSurface from "./GlassSurface.jsx";
import SpecularButton from "./SpecularButton.jsx";
import "./GlassPanel.css";

const STATES = {
  waiting: "Waiting",
  running: "Working",
  done: "Complete",
  failed: "Needs attention",
};

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
    >
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function StateMark({ state, done }) {
  const complete = done === true || state === "done";
  return (
    <span
      className={`glass-panel__state ${complete ? "is-done" : ""} ${state ? `is-${state}` : ""}`}
      aria-label={complete ? "Complete" : STATES[state] || "Not complete"}
    >
      {complete && (
        <svg
          viewBox="0 0 12 12"
          width="10"
          height="10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m2.5 6 2.2 2.2L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      )}
      {state === "failed" && <span aria-hidden="true">!</span>}
    </span>
  );
}

function PanelItems({ panel }) {
  const items = (panel.items || []).slice(0, 4);
  if (!items.length) return null;
  if (panel.type === "compare")
    return (
      <div className="glass-panel__compare">
        {items.map((item, i) => (
          <div className="glass-panel__option" key={i}>
            <span className="glass-panel__option-index" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{item.label}</h3>
            <p>{item.value}</p>
          </div>
        ))}
      </div>
    );
  return (
    <ul
      className={`glass-panel__items ${["checklist", "procedure", "swarm", "status"].includes(panel.type) ? "is-structured" : ""}`}
    >
      {items.map((item, i) => (
        <li key={i}>
          {(item.state || typeof item.done === "boolean") && (
            <StateMark state={item.state} done={item.done} />
          )}
          <div className="glass-panel__item-copy">
            <span className={item.done ? "is-complete" : ""}>{item.label}</span>
            {item.value && (
              <span className="glass-panel__item-value">{item.value}</span>
            )}
          </div>
          {item.state && (
            <span className="glass-panel__state-label">
              {STATES[item.state]}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** onAction(panelId, actionId) records intent only. No external work runs here. */
export function GlassPanel({ panel, onAction, onDismiss, compact = false }) {
  if (!panel) return null;
  const numeric = ["metric", "timer", "navigation", "meeting"].includes(
    panel.type,
  );
  const result = panel.result;
  const resultText =
    result?.status === "rejected" ? "Not recorded" : "Choice recorded";
  const selectedAction = panel.actions?.find(
    (action) => action.id === result?.actionId,
  )?.label;
  const titleId = `glass-title-${panel.id}`;
  return (
    <GlassSurface
      width="100%"
      height="auto"
      borderRadius={24}
      borderWidth={0.08}
      brightness={50}
      backgroundOpacity={0.08}
      saturation={0}
      distortionScale={-55}
      redOffset={0}
      greenOffset={0}
      blueOffset={0}
      className={`glass-panel glass-panel--${panel.type || "note"}${compact ? " glass-panel--compact" : ""}`}
    >
      <article className="glass-panel__inner" aria-labelledby={titleId}>
        <header className="glass-panel__header">
          <span className="glass-panel__eyebrow">
            {panel.eyebrow || panel.type || "Context"}
          </span>
          {onDismiss && (
            <button
              className="glass-panel__dismiss"
              type="button"
              aria-label={`Dismiss ${panel.title || panel.type || "panel"}`}
              onClick={() => onDismiss(panel.id)}
            >
              <CloseIcon />
            </button>
          )}
        </header>
        <h2 id={titleId} className="glass-panel__title">
          {panel.title || "A little context"}
        </h2>
        {panel.value && (
          <div
            className={`glass-panel__reading${numeric ? " is-numeric" : ""}`}
          >
            {panel.type === "navigation" && (
              <svg
                className="glass-panel__direction"
                viewBox="0 0 40 40"
                width="36"
                height="36"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M20 33V7m0 0L9 18M20 7l11 11"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            )}
            <span>{panel.value}</span>
            {panel.unit && (
              <span className="glass-panel__unit">{panel.unit}</span>
            )}
          </div>
        )}
        {panel.body &&
          (panel.type === "quote" ? (
            <blockquote className="glass-panel__quote">{panel.body}</blockquote>
          ) : panel.type === "code" ? (
            <pre className="glass-panel__code">
              <code>{panel.body}</code>
            </pre>
          ) : (
            <p className="glass-panel__body">{panel.body}</p>
          ))}
        <PanelItems panel={panel} />
        {typeof panel.progress === "number" && (
          <div
            className="glass-panel__progress"
            role="progressbar"
            aria-label={`${panel.title || "Task"} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(
              Math.max(0, Math.min(1, panel.progress)) * 100,
            )}
          >
            <span
              style={{
                width: `${Math.max(0, Math.min(1, panel.progress)) * 100}%`,
              }}
            />
          </div>
        )}
        {panel.meta && <p className="glass-panel__meta">{panel.meta}</p>}
        {!!panel.actions?.length && (
          <div className="glass-panel__actions">
            {panel.actions.slice(0, 2).map((action, i) => (
              <SpecularButton
                key={action.id}
                type="button"
                size="sm"
                radius={9}
                autoAnimate={false}
                followMouse={true}
                tint="#ffffff"
                tintOpacity={i === 0 ? 0.13 : 0.035}
                textColor="#f5f5f5"
                lineColor="#ffffff"
                baseColor="#737373"
                intensity={0.8}
                shineSize={14}
                shineFade={35}
                thickness={0.7}
                className={i === 0 ? "is-primary" : ""}
                onClick={() => onAction?.(panel.id, action.id)}
                disabled={
                  !!panel.pendingAction ||
                  result?.status === "received" ||
                  !onAction
                }
              >
                {action.label}
                <span aria-hidden="true">↗</span>
              </SpecularButton>
            ))}
          </div>
        )}
        {panel.pendingAction && (
          <p className="glass-panel__receipt" role="status">
            Recording choice…
          </p>
        )}
        {result && (
          <p className="glass-panel__receipt" role="status">
            <StateMark
              done={result?.status !== "rejected"}
              state={result?.status === "rejected" ? "failed" : "done"}
            />
            <span>
              {resultText}
              {selectedAction && <small>{selectedAction}</small>}
            </span>
          </p>
        )}
      </article>
    </GlassSurface>
  );
}

export default GlassPanel;
