"""Validated, ephemeral agent panels. A selection is an acknowledgement, never execution."""
from __future__ import annotations

import asyncio
import copy
import json
import math
import re
import time
from collections import OrderedDict, deque
from pathlib import Path

# Wheels carry the shared contract beside this module; editable/source checkouts
# read the canonical repository file so schema edits take effect immediately.
_packaged_manifest = Path(__file__).with_name("PANELS.json")
_manifest_path = _packaged_manifest if _packaged_manifest.is_file() else Path(__file__).resolve().parents[2] / "contracts" / "PANELS.json"
MANIFEST = json.loads(_manifest_path.read_text())
SCHEMA = MANIFEST["tool"]["function"]["parameters"]


def validate(value, schema, path="command"):
    """Validate the JSON Schema vocabulary used by the shared panel contract."""
    types = schema.get("type", [])
    types = types if isinstance(types, list) else [types]
    matches = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "integer": type(value) is int,
        "number": type(value) is int or (type(value) is float and math.isfinite(value)),
        "boolean": type(value) is bool, "null": value is None,
    }
    if types and not any(matches[t] for t in types):
        raise ValueError(f"{path}: expected {' or '.join(types)}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: unsupported value")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False and value.keys() - props.keys():
            raise ValueError(f"{path}: unknown fields")
        if set(schema.get("required", [])) - value.keys():
            raise ValueError(f"{path}: missing required fields")
        for key, item in value.items():
            if key in props:
                validate(item, props[key], f"{path}.{key}")
    elif isinstance(value, list):
        if len(value) > schema.get("maxItems", math.inf):
            raise ValueError(f"{path}: too many items")
        for item in value:
            validate(item, schema.get("items", {}), path)
    elif isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf):
            raise ValueError(f"{path}: invalid length")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise ValueError(f"{path}: invalid characters")
    elif type(value) in (int, float):
        if not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            raise ValueError(f"{path}: out of range")


class PanelStore:
    def __init__(self, broadcast, clock=time.monotonic):
        self.broadcast = broadcast
        self.clock = clock
        self.lock = asyncio.Lock()
        self.panels = OrderedDict()
        self.actions = deque(maxlen=100)
        self.requests = OrderedDict()
        self.sequence = 0

    async def _expire(self):
        now = self.clock()
        for pid, (_, expires) in list(self.panels.items()):
            if expires <= now:
                del self.panels[pid]
                await self.broadcast({"kind": "panel", "op": "dismiss", "id": pid})

    async def expire(self):
        async with self.lock:
            await self._expire()

    def _snapshot(self):
        now = self.clock()
        return [{**copy.deepcopy(panel), "op": "show", "ttl_ms": max(1, math.ceil((expires - now) * 1000))}
                for panel, expires in self.panels.values()]

    async def snapshot(self):
        async with self.lock:
            await self._expire()
            return self._snapshot()

    async def connect(self, ws, clients, replay=None):
        async with self.lock:
            await self._expire()
            for panel in self._snapshot():
                await ws.send_json(panel)
            if replay is not None:
                await replay(ws)
            clients.add(ws)

    async def command(self, command):
        validate(command, SCHEMA)
        op, pid = command["op"], command["id"]
        if op == "show" and not all(key in command for key in ("type", "title")):
            raise ValueError("show requires type and title")
        action_ids = [action["id"] for action in command.get("actions", [])]
        if len(set(action_ids)) != len(action_ids):
            raise ValueError("action ids must be unique")
        if op == "dismiss" and set(command) != {"op", "id"}:
            raise ValueError("dismiss accepts only op and id")
        async with self.lock:
            await self._expire()
            if op == "dismiss":
                self.panels.pop(pid, None)
                result = {"kind": "panel", **command}
            else:
                if op == "update" and pid not in self.panels:
                    raise ValueError("update requires an active panel id")
                if pid not in self.panels and len(self.panels) >= 3:
                    oldest, _ = self.panels.popitem(last=False)
                    await self.broadcast({"kind": "panel", "op": "dismiss", "id": oldest})
                previous = self.panels.get(pid)
                panel = {**(previous[0] if previous and op == "update" else {}), **copy.deepcopy(command), "kind": "panel"}
                # Content updates preserve the existing deadline unless an explicit TTL is supplied.
                deadline = previous[1] if previous and op == "update" and "ttl_ms" not in command else self.clock() + command.get("ttl_ms", 60000) / 1000
                panel["ttl_ms"] = max(1, math.ceil((deadline - self.clock()) * 1000))
                result = {**panel, "op": op}
                self.panels[pid] = ({**panel, "op": "show"}, deadline)
            await self.broadcast(result)
            return copy.deepcopy(result)

    async def select(self, message):
        async with self.lock:
            await self._expire()
            fields = ("panel_id", "action_id", "request_id")
            result = {"kind": "panel_result", **{key: message.get(key) for key in fields}, "status": "rejected"}
            if set(message) != {"kind", *fields} or not all(isinstance(message.get(k), str) and 0 < len(message[k]) <= 128 for k in fields):
                await self.broadcast(result)
                return result
            pid, aid, rid = (message[k] for k in fields)
            previous = self.requests.get(rid)
            if previous:
                if (previous["panel_id"], previous["action_id"]) == (pid, aid):
                    result = {**previous, "kind": "panel_result"}
            elif pid in self.panels and any(a["id"] == aid for a in self.panels[pid][0].get("actions", [])):
                self.sequence += 1
                result.update(status="received", sequence=self.sequence)
                record = {k: v for k, v in result.items() if k != "kind"}
                self.actions.append(record)
                self.requests[rid] = record
                if len(self.requests) > 1000:
                    self.requests.popitem(last=False)
            await self.broadcast(result)
            return result

    def read_actions(self, after):
        return {"actions": [copy.deepcopy(a) for a in self.actions if a["sequence"] > after], "cursor": self.sequence,
                "oldest_sequence": self.actions[0]["sequence"] if self.actions else None}
