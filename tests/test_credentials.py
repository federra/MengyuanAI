"""Credential boundary tests use generated dummy tokens only."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest


def test_encrypted_vault_rotation_endpoint_and_process_visibility(tmp_path, monkeypatch):
    from shortfilm.configuration import credentials

    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(tmp_path / "vault"))
    monkeypatch.setenv("DUMMY_KEY", "environment-dummy")
    assert credentials.metadata("DUMMY_KEY", "https://example.com")["source"] == "environment"
    credentials.save("DUMMY_KEY", "https://EXAMPLE.com/", "dummy-token-one", 0)
    assert credentials.resolve("DUMMY_KEY", "https://example.com") == "dummy-token-one"
    assert credentials.metadata("DUMMY_KEY", "https://other.example")["configured"] is False
    with pytest.raises(credentials.CredentialError, match="endpoint"):
        credentials.resolve("DUMMY_KEY", "https://other.example")
    for p in (tmp_path / "vault").iterdir():
        assert b"dummy-token-one" not in p.read_bytes()
        assert p.stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "vault").stat().st_mode & 0o777 == 0o700
    with pytest.raises(credentials.CredentialError, match="conflict"):
        credentials.save("DUMMY_KEY", "https://example.com", "dummy-token-two", 0)
    credentials.save("DUMMY_KEY", "https://example.com", "dummy-token-two", 1)
    assert credentials.resolve("DUMMY_KEY", "https://example.com") == "dummy-token-two"
    import os
    import subprocess

    result = subprocess.run(
        [
            os.sys.executable,
            "-c",
            "from shortfilm.configuration.credentials import resolve; assert resolve('DUMMY_KEY','https://example.com') == 'dummy-token-two'",
        ],
        capture_output=True,
    )
    assert result.returncode == 0


def test_vault_concurrent_writes_permissions_and_symlinks(tmp_path, monkeypatch):
    from shortfilm.configuration import credentials

    root = tmp_path / "vault"
    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(root))

    def save(i):
        credentials.save(f"KEY_{i}", "https://example.com", f"dummy-{i}", 0)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(save, range(12)))
    assert all(
        credentials.resolve(f"KEY_{i}", "https://example.com") == f"dummy-{i}" for i in range(12)
    )
    (root / "vault.enc").chmod(0o644)
    with pytest.raises(credentials.CredentialError):
        credentials.resolve("KEY_0", "https://example.com")
    (root / "vault.enc").chmod(0o600)
    alias = tmp_path / "alias"
    alias.symlink_to(root)
    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(alias))
    with pytest.raises(credentials.CredentialError):
        credentials.resolve("KEY_0", "https://example.com")


def test_sensitive_validation_and_cross_origin_never_echo_secret():
    from fastapi.testclient import TestClient
    from shortfilm.main import app

    with TestClient(app) as client:
        path = "/api/v1/settings/model-credentials/model:category:text"
        for body in (
            {"secret": "dummy-sensitive", "base_version": "invalid"},
            {"secret": {"bad": "dummy-sensitive"}},
        ):
            response = client.put(path, json=body)
            assert response.status_code == 422
            assert "dummy-sensitive" not in response.text
        response = client.put(
            path, json={"secret": "dummy-sensitive"}, headers={"Origin": "https://evil.example"}
        )
        assert response.status_code == 403
        assert "dummy-sensitive" not in response.text
        response = client.post(path + "/test", json={}, headers={"Sec-Fetch-Site": "cross-site"})
        assert response.status_code == 403


@pytest.fixture
def credential_api(monkeypatch):
    from types import SimpleNamespace

    from fastapi.testclient import TestClient
    from shortfilm.configuration import credential_router
    from shortfilm.db import session
    from shortfilm.main import app

    binding = SimpleNamespace(
        revision=3,
        value={
            "provider": "fixture",
            "model": "fixture",
            "endpoint": "http://127.0.0.1:9",
            "capability": "text",
            "credential_ref": "FIXTURE_CREDENTIAL_KEY",
            "timeout_seconds": 1,
        },
    )
    monkeypatch.setattr(credential_router, "latest", lambda *args: binding)
    app.dependency_overrides[session] = lambda: None
    try:
        with TestClient(app) as client:
            yield client, binding
    finally:
        app.dependency_overrides.pop(session, None)


def test_api_saved_route_credentials_and_conflicts(credential_api):
    client, binding = credential_api
    path = "/api/v1/settings/model-credentials/model:category:text"
    assert client.get(path).json() == {
        "configured": False,
        "source": "none",
        "revision": 0,
        "binding_revision": 3,
    }
    body = {"secret": "dummy-api-secret", "base_version": 0, "binding_revision": 3}
    result = client.put(path, json=body, headers={"Origin": "http://localhost:5180"})
    assert result.status_code == 200
    assert "dummy-api-secret" not in result.text
    assert "dummy-api-secret" not in json.dumps(binding.value)
    assert client.put(path, json=body).status_code == 409
    assert (
        client.post(path + "/test", json={"base_version": 1, "binding_revision": 2}).status_code
        == 409
    )
    binding.value["endpoint"] = "https://other.example"
    result = client.post(path + "/test", json={"base_version": 1, "binding_revision": 3})
    assert result.json()["state"] == "credential_endpoint_mismatch"
    for secret in ("x" * 4097, "bad\nheader", {"token": "dummy-sensitive"}):
        result = client.put(path, json={**body, "secret": secret})
        assert result.status_code == 422
        assert "dummy-sensitive" not in result.text and "bad" not in result.text


@pytest.mark.parametrize(
    "status,content,expected",
    [
        (200, '{"ok":true}', "ok"),
        (200, "not-json", "provider_invalid_response"),
        (401, "", "provider_auth_failed"),
        (429, "", "provider_rate_limited"),
        (302, "", "provider_rejected"),
        (500, "", "provider_acceptance_unknown"),
    ],
)
def test_connection_uses_real_http_saved_route_and_sanitizes(
    credential_api, status, content, expected
):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    client, binding = credential_api
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            calls.append(
                (
                    self.path,
                    self.headers.get("Authorization"),
                    json.loads(self.rfile.read(int(self.headers["Content-Length"]))),
                )
            )
            self.send_response(status)
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "id": "dummy-secret-reflected",
                        "choices": [{"message": {"content": content}}],
                        "usage": {
                            "total_tokens": 8,
                            "unsafe": "dummy-secret-reflected",
                            "prompt_tokens": "dummy-secret-reflected",
                        },
                    }
                ).encode()
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        binding.value["endpoint"] = f"http://127.0.0.1:{server.server_port}"
        path = "/api/v1/settings/model-credentials/model:category:text"
        assert (
            client.put(
                path, json={"secret": "dummy-http-secret", "base_version": 0, "binding_revision": 3}
            ).status_code
            == 200
        )
        result = client.post(path + "/test", json={"base_version": 1, "binding_revision": 3})
        assert result.status_code == 200, result.text
        assert result.json()["state"] == expected
        assert "dummy" not in result.text
        assert len(calls) == 1
        assert calls[0][0] == "/chat/completions"
        assert calls[0][1] == "Bearer dummy-http-secret"
        assert calls[0][2]["max_tokens"] == 64
        assert calls[0][2]["model"] == "fixture"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_rotation_after_connection_snapshot_is_rejected(tmp_path, monkeypatch):
    from shortfilm.configuration import credentials

    credentials.save("ROTATE_KEY", "https://example.com", "dummy-one", 0)
    with pytest.raises(credentials.CredentialError, match="revision_conflict"):
        credentials.resolve("ROTATE_KEY", "https://example.com", revision=0)


def test_connection_timeout_has_distinct_sanitized_status(credential_api, monkeypatch):
    import httpx
    from shortfilm.creation import provider

    client, binding = credential_api
    path = "/api/v1/settings/model-credentials/model:category:text"
    client.put(path, json={"secret": "dummy-timeout", "base_version": 0, "binding_revision": 3})
    real_client = httpx.Client

    def timeout(request):
        raise httpx.ReadTimeout("dummy-timeout", request=request)

    monkeypatch.setattr(
        provider.httpx,
        "Client",
        lambda **kw: real_client(**kw, transport=httpx.MockTransport(timeout)),
    )
    response = client.post(path + "/test", json={"base_version": 1, "binding_revision": 3})
    assert response.json()["state"] == "provider_timeout"
    assert "dummy-timeout" not in response.text


def test_broken_vault_symlink_cannot_fall_back_to_environment(tmp_path, monkeypatch):
    from shortfilm.configuration import credentials

    credentials.save("LINK_KEY", "https://example.com", "dummy", 0)
    root = __import__("pathlib").Path(__import__("os").environ["SHORTFILM_CREDENTIAL_ROOT"])
    (root / "vault.enc").unlink()
    (root / "vault.enc").symlink_to(tmp_path / "missing")
    monkeypatch.setenv("LINK_KEY", "environment-fallback")
    with pytest.raises(credentials.CredentialError):
        credentials.resolve("LINK_KEY", "https://example.com")


def test_public_origin_allows_settings_but_rejects_cross_site_writes(monkeypatch):
    from fastapi.testclient import TestClient
    from shortfilm.config import settings
    from shortfilm.main import app
    monkeypatch.setattr(settings, 'public_origin', 'https://121.199.40.214')
    with TestClient(app) as client:
        response = client.put('/api/v1/settings/asset-credentials', json={}, headers={'Origin': 'https://121.199.40.214'})
        assert response.status_code == 422
        response = client.post('/api/v1/projects', json={}, headers={'Origin': 'https://foreign.example'})
        assert response.status_code == 403
        response = client.post('/api/v1/projects', json={}, headers={'Sec-Fetch-Site': 'cross-site'})
        assert response.status_code == 403
