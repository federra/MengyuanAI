import hashlib
import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from shortfilm.creation.provider import ProviderFailure
from shortfilm.media import asset_transport

REAL_HTTPX_CLIENT = httpx.Client

BUNDLE = {
    "configuration": {
        "bucket": "media-bucket",
        "region": "cn-beijing",
        "project_name": "mengyuanai",
    },
    "access_key": "test-access",
    "secret_key": "test-secret",
}


class FakeTosError(Exception):
    def __init__(self, status_code, code=""):
        self.status_code = status_code
        self.code = code


class FakeTosClient:
    def __init__(self, *, head=None, put=None, signed_url="https://signed.example/file"):
        self.head_result = head
        self.put_result = put
        self.signed_url = signed_url
        self.calls = []
        self.closed = False

    def head_object(self, bucket, key):
        self.calls.append(("head", bucket, key))
        if isinstance(self.head_result, Exception):
            raise self.head_result
        return self.head_result

    def put_object(self, bucket, key, **kwargs):
        self.calls.append(("put", bucket, key, kwargs))
        if isinstance(self.put_result, Exception):
            raise self.put_result
        return self.put_result

    def pre_signed_url(self, method, bucket, key, expires):
        self.calls.append(("sign", method, bucket, key, expires))
        return type("Signed", (), {"signed_url": self.signed_url})()

    def close(self):
        self.closed = True


def install_tos(monkeypatch, client):
    seen = {}

    def build(*args, **kwargs):
        seen.update(args=args, kwargs=kwargs)
        return client

    monkeypatch.setattr(asset_transport.tos, "TosClientV2", build)
    monkeypatch.setattr(asset_transport.tos.exceptions, "TosServerError", FakeTosError)
    return seen


def test_upload_private_object_heads_then_puts_with_sha(monkeypatch):
    data = b"jpeg"
    digest = hashlib.sha256(data).hexdigest()
    client = FakeTosClient(
        head=FakeTosError(404, "NoSuchKey"), put=type("Put", (), {"etag": "etag-1"})()
    )
    seen = install_tos(monkeypatch, client)
    result = asset_transport.upload_private_object(BUNDLE, data, digest, "assets/abc.jpg")
    assert result == {"key": "assets/abc.jpg", "sha256": digest, "size": 4, "etag": "etag-1"}
    assert client.calls[0] == ("head", "media-bucket", "assets/abc.jpg")
    put = client.calls[1]
    assert put[:3] == ("put", "media-bucket", "assets/abc.jpg")
    assert put[3]["content"] == data
    assert put[3]["content_sha256"] == digest
    assert put[3]["meta"] == {"sha256": digest}
    assert seen["kwargs"]["max_retry_count"] == 0
    assert seen["kwargs"]["follow_redirect_times"] == 0
    assert client.closed


def test_upload_reuses_matching_object_and_distinguishes_permissions(monkeypatch):
    data = b"jpeg"
    digest = hashlib.sha256(data).hexdigest()
    head = type("Head", (), {"meta": {"sha256": digest}, "etag": "old"})()
    client = FakeTosClient(head=head)
    install_tos(monkeypatch, client)
    assert asset_transport.upload_private_object(BUNDLE, data, digest, "assets/abc.jpg")["etag"] == "old"
    assert [call[0] for call in client.calls] == ["head"]

    client = FakeTosClient(head=FakeTosError(403, "AccessDenied"))
    install_tos(monkeypatch, client)
    with pytest.raises(ProviderFailure, match="tos_head_access_denied") as error:
        asset_transport.upload_private_object(BUNDLE, data, digest, "assets/abc.jpg")
    assert not error.value.unknown

    client = FakeTosClient(head=FakeTosError(404), put=FakeTosError(503, "InternalError"))
    install_tos(monkeypatch, client)
    with pytest.raises(ProviderFailure, match="tos_put_acceptance_unknown") as error:
        asset_transport.upload_private_object(BUNDLE, data, digest, "assets/abc.jpg")
    assert error.value.unknown

    client = FakeTosClient(head=FakeTosError(404), put=FakeTosError(403, "AccessDenied"))
    install_tos(monkeypatch, client)
    with pytest.raises(ProviderFailure, match="tos_put_access_denied") as error:
        asset_transport.upload_private_object(BUNDLE, data, digest, "assets/abc.jpg")
    assert not error.value.unknown


def test_upload_rejects_bad_digest_and_key_without_client(monkeypatch):
    monkeypatch.setattr(asset_transport.tos, "TosClientV2", lambda *a, **k: pytest.fail("called"))
    with pytest.raises(ProviderFailure, match="asset_upload_invalid"):
        asset_transport.upload_private_object(BUNDLE, b"x", "0" * 64, "../secret")


def test_presign_get_real_sdk_returns_sensitive_internal_url_without_secret_key():
    url = asset_transport.presign_get(BUNDLE, "assets/abc.jpg", expires_seconds=600)
    query = parse_qs(urlsplit(url).query)
    assert query["X-Tos-Expires"] == ["600"]
    assert "test-access" in query["X-Tos-Credential"][0]
    assert "test-secret" not in url


def install_http(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        asset_transport.httpx,
        "Client",
        lambda *args, **kwargs: REAL_HTTPX_CLIENT(*args, transport=transport, **kwargs),
    )
    monkeypatch.setattr(
        asset_transport.SignerV4,
        "sign",
        lambda request, credentials: request.headers.update({"Authorization": "signed"}),
    )


def ok(result):
    return {"ResponseMetadata": {"RequestId": "req-1"}, "Result": result}


def test_create_asset_group_signs_expected_action_and_body(monkeypatch):
    seen = {}

    def handler(request):
        seen["request"] = request
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json=ok({"Id": "group-1"}))

    install_http(monkeypatch, handler)
    assert asset_transport.create_asset_group(BUNDLE, "角色甲", "描述") == "group-1"
    assert dict(seen["request"].url.params) == {
        "Action": "CreateAssetGroup",
        "Version": "2024-01-01",
    }
    assert seen["body"] == {
        "Name": "角色甲",
        "Description": "描述",
        "GroupType": "AIGC",
        "ProjectName": "mengyuanai",
    }
    assert seen["request"].headers["authorization"] == "signed"


def test_create_asset_uses_signed_get_url_and_exact_contract(monkeypatch):
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json=ok({"Id": "asset-1"}))

    install_http(monkeypatch, handler)
    asset_id = asset_transport.create_asset(
        BUNDLE, "group-1", "https://signed.example/file?sig=private", "角色甲正面"
    )
    assert asset_id == "asset-1"
    assert seen["body"] == {
        "GroupId": "group-1",
        "URL": "https://signed.example/file?sig=private",
        "AssetType": "Image",
        "Name": "角色甲正面",
        "ProjectName": "mengyuanai",
    }


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ({"Id": "asset-1", "Status": "Processing"}, {"state": "processing"}),
        ({"Id": "asset-1", "Status": "Active"}, {"state": "active", "asset_id": "asset-1"}),
        (
            {"Id": "asset-1", "Status": "Failed", "Error": {"Code": "ContentRestricted", "Message": "private"}},
            {"state": "failed", "error": "asset_content_restricted"},
        ),
    ],
)
def test_get_asset_maps_states_and_sanitizes_failure(monkeypatch, result, expected):
    install_http(monkeypatch, lambda request: httpx.Response(200, json=ok(result)))
    assert asset_transport.get_asset(BUNDLE, "asset-1") == expected


def test_ark_200_business_error_and_create_unknown_are_safe(monkeypatch):
    install_http(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            json={
                "ResponseMetadata": {"Error": {"Code": "AccessDenied", "Message": "secret"}}
            },
        ),
    )
    with pytest.raises(ProviderFailure, match="asset_access_denied") as error:
        asset_transport.get_asset(BUNDLE, "asset-1")
    assert not error.value.unknown and "secret" not in str(error.value)

    install_http(monkeypatch, lambda request: httpx.Response(503, json={}))
    with pytest.raises(ProviderFailure, match="asset_acceptance_unknown") as error:
        asset_transport.create_asset_group(BUNDLE, "角色甲")
    assert error.value.unknown


def test_ark_4xx_is_fixed_safe_code(monkeypatch):
    install_http(monkeypatch, lambda request: httpx.Response(403, json={"message": "secret"}))
    with pytest.raises(ProviderFailure, match="asset_http_403") as error:
        asset_transport.create_asset_group(BUNDLE, "角色甲")
    assert not error.value.unknown and "secret" not in str(error.value)


@pytest.mark.parametrize('code,expected', [
    ('AccessDenied', 'AccessDenied'),
    ('Forbidden.ProjectPermission', 'Forbidden.ProjectPermission'),
    ('test-secret', None),
    ('https://private.example/signed', None),
])
def test_ark_403_keeps_only_safe_business_code(monkeypatch, code, expected):
    install_http(monkeypatch, lambda request: httpx.Response(403, json={
        'ResponseMetadata': {'Error': {'Code': code, 'Message': 'private details'}}
    }))
    with pytest.raises(ProviderFailure) as error:
        asset_transport.create_asset_group(BUNDLE, '角色甲')
    assert error.value.code == 'asset_http_403'
    assert getattr(error.value, 'provider_code', None) == expected
    assert 'private details' not in str(error.value)
