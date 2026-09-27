"""OAuth 2.1 for hosted gbrain.io (memory scope only).

One-time login (a human clicks approve in the browser):

    uv run python -m perception.gbrain_auth

Does dynamic client registration + PKCE (S256) with a localhost callback, then stores
client_id + refresh_token in perception/.env.gbrain (chmod 600, gitignored via .env.*).

Only `memory:full` is ever requested. That workspace is also wired to real Gmail/Calendar;
this code never asks for those scopes and the sink never calls those tools.

Runtime: TokenProvider.get() returns a cached access token and refreshes it (~1h tokens)
using the stored refresh token, persisting a rotated refresh token back to the file.
GBRAIN_TOKEN (a static bearer) short-circuits all of this if set.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

import httpx

from .config import ROOT_DIR

ISSUER = os.environ.get("GBRAIN_ISSUER", "https://gbrain.io")
MCP_URL = os.environ.get("GBRAIN_URL", "https://gbrain.io/mcp")
SCOPE = "memory:full"  # never add gmail/calendar/drive scopes
ENV_PATH = Path(os.environ.get("GBRAIN_ENV_PATH", str(ROOT_DIR / ".env.gbrain")))
CALLBACK_PORT = int(os.environ.get("GBRAIN_CALLBACK_PORT", "8976"))


def read_env_file(path: Path = ENV_PATH) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def write_env_file(values: dict[str, str], path: Path = ENV_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "# gbrain.io OAuth (memory:full only). Written by perception.gbrain_auth. Do not commit.\n"
    body += "".join(f"{k}={v}\n" for k, v in values.items())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)
    os.chmod(path, 0o600)


def configured(path: Path = ENV_PATH) -> bool:
    if os.environ.get("GBRAIN_TOKEN"):
        return True
    env = read_env_file(path)
    return bool(env.get("GBRAIN_CLIENT_ID") and env.get("GBRAIN_REFRESH_TOKEN"))


class AuthError(RuntimeError):
    pass


class TokenProvider:
    """Async access-token getter with caching + refresh. Safe to share across tasks."""

    def __init__(self, path: Path = ENV_PATH, client: httpx.AsyncClient | None = None) -> None:
        self.path = path
        self.client = client or httpx.AsyncClient(timeout=10.0)
        self.static = os.environ.get("GBRAIN_TOKEN")
        self._token: str | None = None
        self._exp = 0.0
        self._lock = asyncio.Lock()

    def invalidate(self) -> None:
        self._token, self._exp = None, 0.0

    async def get(self) -> str:
        if self.static:
            return self.static
        if self._token and time.time() < self._exp - 60:
            return self._token
        async with self._lock:
            if self._token and time.time() < self._exp - 60:
                return self._token
            env = read_env_file(self.path)
            cid, rt = env.get("GBRAIN_CLIENT_ID"), env.get("GBRAIN_REFRESH_TOKEN")
            if not cid or not rt:
                raise AuthError(f"gbrain.io not authorized: run `uv run python -m perception.gbrain_auth` ({self.path} missing)")
            token_url = env.get("GBRAIN_TOKEN_ENDPOINT") or f"{ISSUER}/oauth/token"
            r = await self.client.post(token_url, data={
                "grant_type": "refresh_token", "refresh_token": rt, "client_id": cid,
                "resource": env.get("GBRAIN_URL") or MCP_URL,
            })
            if r.status_code >= 400:
                raise AuthError(f"refresh failed: {r.status_code} {r.text[:200]}")
            tok = r.json()
            self._token = tok["access_token"]
            self._exp = time.time() + float(tok.get("expires_in") or 3600)
            if tok.get("refresh_token") and tok["refresh_token"] != rt:
                env["GBRAIN_REFRESH_TOKEN"] = tok["refresh_token"]
                write_env_file(env, self.path)
            return self._token


# ---------- interactive login ----------

def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _wait_for_code(port: int, state: str, timeout: float = 300.0) -> str:
    result: dict[str, str] = {}
    done = threading.Event()

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" not in q and "error" not in q:
                self.send_response(404)
                self.end_headers()
                return
            result.update({k: v[0] for k, v in q.items()})
            ok = "code" in q and q.get("state", [""])[0] == state
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.end_headers()
            msg = "WORLD is connected to GBrain. You can close this tab." if ok else f"Auth failed: {q.get('error', ['state mismatch'])[0]}"
            self.wfile.write(f"<html><body style='font-family:system-ui'><h3>{msg}</h3></body></html>".encode())
            done.set()

        def log_message(self, *a):  # quiet
            pass

    srv = http.server.HTTPServer(("127.0.0.1", port), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        if not done.wait(timeout):
            raise AuthError("timed out waiting for browser approval")
    finally:
        srv.shutdown()
    if result.get("error"):
        raise AuthError(f"authorization error: {result.get('error')} {result.get('error_description', '')}")
    if result.get("state") != state:
        raise AuthError("state mismatch")
    return result["code"]


def login(port: int = CALLBACK_PORT, open_browser: bool = True) -> dict[str, str]:
    with httpx.Client(timeout=15.0) as c:
        meta = c.get(f"{ISSUER}/.well-known/oauth-authorization-server").json()
        redirect = f"http://127.0.0.1:{port}/callback"
        reg = c.post(meta["registration_endpoint"], json={
            "client_name": "WORLD perception (memory only)",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": SCOPE,
        })
        if reg.status_code >= 400:
            raise AuthError(f"client registration failed: {reg.status_code} {reg.text[:300]}")
        client_id = reg.json()["client_id"]
        verifier, challenge = _pkce()
        state = secrets.token_urlsafe(16)
        url = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": client_id, "redirect_uri": redirect,
            "scope": SCOPE, "state": state, "code_challenge": challenge,
            "code_challenge_method": "S256", "resource": MCP_URL,
        })
        print(f"\nOpen this URL and approve (scope: {SCOPE} only):\n\n  {url}\n", flush=True)
        if open_browser:
            webbrowser.open(url)
        code = _wait_for_code(port, state)
        tok = c.post(meta["token_endpoint"], data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect,
            "client_id": client_id, "code_verifier": verifier, "resource": MCP_URL,
        })
        if tok.status_code >= 400:
            raise AuthError(f"token exchange failed: {tok.status_code} {tok.text[:300]}")
        t = tok.json()
        if not t.get("refresh_token"):
            raise AuthError("server returned no refresh_token")
        granted = t.get("scope", SCOPE)
        extra = set(granted.split()) - {"memory:full", "memory:read"}
        if extra:
            print(f"warning: server granted extra scopes {sorted(extra)}; the sink only uses memory tools", file=sys.stderr)
        values = {
            "GBRAIN_URL": MCP_URL,
            "GBRAIN_TOKEN_ENDPOINT": meta["token_endpoint"],
            "GBRAIN_CLIENT_ID": client_id,
            "GBRAIN_REFRESH_TOKEN": t["refresh_token"],
        }
        write_env_file(values)
        return {"client_id": client_id, "scope": granted, "expires_in": str(t.get("expires_in"))}


async def _check() -> None:
    from .gbrain import MCPClient  # local import: avoid cycle at module load

    tp = TokenProvider()
    mcp = MCPClient(MCP_URL, tp)
    res = await mcp.call("whoami", {})
    print("whoami:", json.dumps(res)[:400])
    await mcp.close()


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Authorize WORLD against gbrain.io (memory:full only)")
    ap.add_argument("--check", action="store_true", help="refresh a token and call whoami instead of logging in")
    ap.add_argument("--no-browser", action="store_true", help="print the URL only")
    ap.add_argument("--port", type=int, default=CALLBACK_PORT)
    a = ap.parse_args()
    if a.check:
        asyncio.run(_check())
        return
    info = login(a.port, open_browser=not a.no_browser)
    print(f"ok: client {info['client_id']} scope={info['scope']} -> {ENV_PATH} (chmod 600)")
    asyncio.run(_check())


if __name__ == "__main__":
    main()
