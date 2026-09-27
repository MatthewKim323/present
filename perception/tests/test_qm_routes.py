import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from perception.qm_routes import add_qm_routes
from perception.sinks import QMSink


def app_for(handler, url="http://qm.test", secret="server-only-secret"):
    app = FastAPI()
    sink = QMSink(url, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), secret=secret)
    add_qm_routes(app, sink)
    return app


@pytest.mark.parametrize("method,path,upstream,body,payload,status", [
    ("GET", "/qm/runs", "/world-runs", None, {"runs": [{"id": "run1"}]}, 200),
    ("GET", "/qm/watches", "/world-watches", None, {"watches": []}, 200),
    ("POST", "/qm/watches", "/world-watches", {"match": {"person_id": "matthew"}, "action": "draft a summary"}, {"ok": True, "watch": {"id": "ww_1"}}, 201),
    ("DELETE", "/qm/watches/ww_1", "/world-watches/ww_1", None, {"ok": True}, 200),
    ("GET", "/qm/entities", "/world-entities", None, {"entities": []}, 200),
    ("POST", "/qm/entities/adopt", "/world-entities/adopt", {"entity_kind": "person", "entity_id": "matthew"}, {"ok": True, "created": True}, 201),
])
def test_routes(method, path, upstream, body, payload, status):
    calls = []

    def handle(request):
        import json
        calls.append(request)
        assert request.method == method
        assert str(request.url) == f"http://qm.test{upstream}"
        assert request.headers["authorization"] == "Bearer server-only-secret"
        assert (json.loads(request.content) if request.content else None) == body
        return httpx.Response(status, json=payload)

    with TestClient(app_for(handle)) as client:
        result = client.request(method, path, **({"json": body} if body else {}), headers={"authorization": "Bearer browser-value"})
    assert result.status_code == status
    assert result.json() == payload
    assert "server-only-secret" not in result.text
    assert len(calls) == 1


def test_unconfigured_and_invalid_id_do_not_call_qm():
    def never(request):
        pytest.fail("unexpected upstream call")
    with TestClient(app_for(never, url="")) as client:
        assert client.get("/qm/runs").status_code == 503
    with TestClient(app_for(never)) as client:
        assert client.delete("/qm/watches/bad%3Fquery").status_code == 422
        assert client.get("/qm/arbitrary").status_code == 404
        assert client.post("/qm/watches", json=[]).status_code == 422


@pytest.mark.parametrize("status,expected", [(400, 400), (401, 401), (403, 403), (404, 404), (422, 422), (429, 429), (500, 502), (302, 502)])
def test_upstream_failures_are_sanitized(status, expected):
    with TestClient(app_for(lambda _: httpx.Response(status, text="server-only-secret internal /private/path", headers={"location": "http://other.test"}))) as client:
        result = client.get("/qm/runs")
    assert result.status_code == expected
    assert "server-only-secret" not in result.text
    assert "/private/path" not in result.text


@pytest.mark.parametrize("error,expected", [(httpx.ReadTimeout, 504), (httpx.ConnectError, 502)])
def test_network_failures(error, expected):
    def fail(request):
        raise error("server-only-secret", request=request)
    with TestClient(app_for(fail)) as client:
        result = client.get("/qm/runs")
    assert result.status_code == expected
    assert "server-only-secret" not in result.text


def test_invalid_upstream_json():
    with TestClient(app_for(lambda _: httpx.Response(200, text="not-json"))) as client:
        assert client.get("/qm/runs").status_code == 502
