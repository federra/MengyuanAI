import httpx
from shortfilm.media import asset_access


def test_access_stops_after_first_failure(monkeypatch):
    class Client:
        def __init__(self, *args, **kwargs):
            assert kwargs["max_retry_count"] == 0 and kwargs["follow_redirect_times"] == 0

        def head_bucket(self, bucket):
            raise RuntimeError("dummy-secret")

        def close(self):
            pass

    monkeypatch.setattr(asset_access.tos, "TosClientV2", Client)
    monkeypatch.setattr(
        asset_access.httpx,
        "Client",
        lambda **kw: (_ for _ in ()).throw(AssertionError("must not call Ark")),
    )
    assert asset_access.check_access(bundle()) == {
        "tos": "connection_failed",
        "assets": "not_tested",
    }


def bundle():
    return {
        "access_key": "dummy-ak",
        "secret_key": "dummy-secret",
        "configuration": {"bucket": "test-bucket", "project_name": "test-project"},
    }


def test_access_only_signs_one_read_query(monkeypatch):
    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def head_bucket(self, bucket):
            assert bucket == "test-bucket"

        def close(self):
            pass

    monkeypatch.setattr(asset_access.tos, "TosClientV2", Client)
    original = httpx.Client
    calls = []

    def handle(req):
        calls.append(req)
        assert req.url.params["Action"] == "ListAssetGroups"
        assert "HMAC-SHA256" in req.headers["Authorization"]
        assert b"test-project" in req.content
        import json

        assert json.loads(req.content)["Filter"] == {"GroupType": "AIGC"}
        return httpx.Response(200, json={"ResponseMetadata": {}, "Result": {"Items": []}})

    monkeypatch.setattr(
        asset_access.httpx,
        "Client",
        lambda **kw: original(transport=httpx.MockTransport(handle), **kw),
    )
    assert asset_access.check_access(bundle()) == {"tos": "ok", "assets": "ok"}
    assert len(calls) == 1
