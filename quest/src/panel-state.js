import manifest from "../../contracts/PANELS.json" with { type: "json" };
export const PANEL_TYPES = manifest.types;
export const PANEL_TOOL = manifest.tool;
const schema = manifest.tool.function.parameters;

function valid(value, rule) {
  if (rule.type === "array")
    return (
      Array.isArray(value) &&
      value.length <= rule.maxItems &&
      value.every((item) => valid(item, rule.items))
    );
  if (rule.type === "object")
    return (
      value != null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      (rule.required || []).every((k) => Object.hasOwn(value, k)) &&
      Object.entries(value).every(
        ([k, v]) => rule.properties[k] && valid(v, rule.properties[k]),
      )
    );
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (
    !types.some((t) =>
      t === "null"
        ? value === null
        : t === "integer"
          ? Number.isInteger(value)
          : typeof value === t,
    )
  )
    return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (rule.minimum ?? -Infinity) ||
      value > (rule.maximum ?? Infinity))
  )
    return false;
  if (
    typeof value === "string" &&
    (value.length < (rule.minLength || 0) ||
      value.length > (rule.maxLength ?? Infinity) ||
      (rule.pattern && !new RegExp(rule.pattern).test(value)))
  )
    return false;
  return true;
}

export function applyPanelCommand(panels, message, time = performance.now()) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return false;
  const { kind, ...command } = message;
  const inboundSchema =
    kind === "panel"
      ? {
          ...schema,
          properties: {
            ...schema.properties,
            ttl_ms: { ...schema.properties.ttl_ms, minimum: 1 },
          },
        }
      : schema;
  if (!valid(command, inboundSchema)) return false;
  const { op, id, ...fields } = command;
  if (op === "dismiss") return panels.delete(id);
  const previous = panels.get(id);
  if (op === "update" && !previous) return false;
  if (op === "show" && (!fields.type || !fields.title?.trim())) return false;
  const next = { ...(op === "update" ? previous : {}), ...fields, id };
  next.expiresAt = fields.ttl_ms
    ? time + fields.ttl_ms
    : op === "update"
      ? previous.expiresAt
      : time + 60000;
  next.result = null;
  next.pendingAction = null;
  if (
    new Set((next.actions || []).map((action) => action.id)).size !==
    (next.actions || []).length
  )
    return false;
  panels.set(id, next);
  while (panels.size > 3) panels.delete(panels.keys().next().value);
  return true;
}

export function livePanels(panels, time = performance.now()) {
  for (const [id, panel] of panels)
    if (panel.expiresAt <= time) panels.delete(id);
  return [...panels.values()];
}

// Correlate receipts to the exact action on the current panel revision.
export function beginPanelAction(
  panels,
  id,
  actionId,
  requestId,
  time = performance.now(),
) {
  const panel = panels.get(id);
  if (
    !panel ||
    panel.expiresAt <= time ||
    panel.pendingAction ||
    panel.result?.status === "received"
  )
    return false;
  if (
    typeof requestId !== "string" ||
    !requestId ||
    !panel.actions?.some((action) => action.id === actionId)
  )
    return false;
  panels.set(id, {
    ...panel,
    result: null,
    pendingAction: { actionId, requestId },
  });
  return true;
}

export function applyPanelResult(panels, message, time = performance.now()) {
  const panel = panels.get(message.panel_id);
  const pending = panel?.pendingAction;
  if (
    !panel ||
    panel.expiresAt <= time ||
    !pending ||
    !["received", "rejected"].includes(message.status)
  )
    return false;
  if (
    message.request_id !== pending.requestId ||
    message.action_id !== pending.actionId ||
    !panel.actions?.some((action) => action.id === message.action_id)
  )
    return false;
  panels.set(panel.id, {
    ...panel,
    pendingAction: null,
    result: { actionId: message.action_id, status: message.status },
  });
  return true;
}
