from fastapi.testclient import TestClient
from shortfilm.main import app


def test_asset_credentials_atomic_private_conflict_and_origin(tmp_path, monkeypatch):
    monkeypatch.setenv("SHORTFILM_CREDENTIAL_ROOT", str(tmp_path / "vault"))
    client = TestClient(app)
    path = "/api/v1/settings/asset-credentials"
    body = dict(
        bucket="mengyuanaibucket",
        region="cn-beijing",
        project_name="mengyuanai",
        base_version=0,
        access_key="dummy-access-123",
        secret_key="dummy-secret-456",
    )
    assert client.get(path).json()["configured"] is False
    assert (
        client.put(path, json=body, headers={"Origin": "https://foreign.example"}).status_code
        == 403
    )
    result = client.put(path, json=body)
    assert result.status_code == 200
    assert result.json()["connection_state"] == "not_tested"
    assert "dummy-" not in result.text
    assert client.get(path).json()["configuration"]["bucket"] == "mengyuanaibucket"
    assert client.put(path, json=body).status_code == 409
    invalid = client.put(path, json={**body, "secret_key": "dummy-secret\n456"})
    assert invalid.status_code == 422 and "dummy-" not in invalid.text
    for file in (tmp_path / "vault").iterdir():
        assert b"dummy-secret-456" not in file.read_bytes()
        assert b"dummy-access-123" not in file.read_bytes()
