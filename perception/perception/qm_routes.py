"""Fixed WORLD-facing QM routes. The shared hook credential stays on the server."""
from __future__ import annotations

import re
import os
import hmac
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .sinks import QMSink


def add_qm_routes(app: FastAPI, qm: QMSink, *, access_token: str | None = None) -> None:
    # This is a separate browser-facing credential. Never send QM's hook secret
    # to a headset or web client, and fail closed when the token is unset.
    token = access_token if access_token is not None else os.getenv("WORLD_QM_ACCESS_TOKEN", "")

    def authorize(request: Request) -> None:
        if not token:
            raise HTTPException(503, "QM controls require WORLD_QM_ACCESS_TOKEN")
        candidate = request.headers.get("authorization", "")
        if not hmac.compare_digest(candidate, f"Bearer {token}"):
            raise HTTPException(401, "QM access token required")

    async def forward(method: str, path: str, body: dict[str, Any] | None = None):
        if not qm.base_url:
            raise HTTPException(503, "QM is not configured")
        headers = {"authorization": f"Bearer {qm.secret}"} if qm.secret else {}
        try:
            response = await qm.client.request(
                method, f"{qm.base_url}{path}", headers=headers,
                **({"json": body} if body is not None else {}),
                follow_redirects=False,
            )
        except httpx.TimeoutException:
            raise HTTPException(504, "QM request timed out") from None
        except httpx.RequestError:
            raise HTTPException(502, "QM is unreachable") from None

        # Never return arbitrary error pages/messages: they can echo credentials or
        # internal deployment details. Preserve actionable HTTP status codes instead.
        if 400 <= response.status_code < 500:
            detail = {
                400: "QM rejected the request; check the watch or entity fields",
                401: "QM authentication failed; check the server hook credential",
                403: "QM denied this operation",
                404: "QM resource or world-hooks route was not found",
                409: "QM resource conflicts with an existing entry",
                422: "QM rejected the request fields",
                429: "QM rate limit reached; try again later",
            }.get(response.status_code, "QM rejected the request")
            raise HTTPException(response.status_code, detail)
        if not 200 <= response.status_code < 300:
            raise HTTPException(502, "QM returned an upstream error")
        try:
            data = response.json()
        except ValueError:
            raise HTTPException(502, "QM returned invalid JSON") from None
        return JSONResponse(data, status_code=response.status_code)

    @app.get("/qm/runs")
    async def runs(request: Request):
        authorize(request)
        return await forward("GET", "/world-runs")

    @app.get("/qm/watches")
    async def watches(request: Request):
        authorize(request)
        return await forward("GET", "/world-watches")

    @app.post("/qm/watches")
    async def create_watch(request: Request, body: dict[str, Any]):
        authorize(request)
        return await forward("POST", "/world-watches", body)

    @app.delete("/qm/watches/{watch_id}")
    async def delete_watch(request: Request, watch_id: str):
        authorize(request)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", watch_id):
            raise HTTPException(422, "Invalid watch id")
        return await forward("DELETE", f"/world-watches/{watch_id}")

    @app.get("/qm/entities")
    async def entities(request: Request):
        authorize(request)
        return await forward("GET", "/world-entities")

    @app.post("/qm/entities/adopt")
    async def adopt_entity(request: Request, body: dict[str, Any]):
        authorize(request)
        return await forward("POST", "/world-entities/adopt", body)
