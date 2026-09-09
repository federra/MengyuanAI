import base64

import httpx
import pytest
from shortfilm.creation.provider import ProviderFailure
from shortfilm.media import providers

REAL_HTTPX_CLIENT = httpx.Client

ARK = {
    "provider": "volcengine",
    "model": "doubao-seedream-4-0-250828",
    "endpoint": "https://ark.cn-beijing.volces.com/api/v3",
    "capability": "image",
    "credential_ref": "ARK_API_KEY",
    "timeout_seconds": 61,
}
VIDEO = {**ARK, "model": "doubao-seedance-2-0-pro-260000", "capability": "video"}
MINIMAX = {
    "provider": "minimax",
    "model": "speech-2.8-hd",
    "endpoint": "https://api.minimaxi.com/v1",
    "capability": "audio",
    "credential_ref": "MINIMAX_API_KEY",
    "timeout_seconds": 60,
}


def install_transport(monkeypatch, handler):
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        providers.httpx,
        "Client",
        lambda *args, **kwargs: REAL_HTTPX_CLIENT(*args, transport=transport, **kwargs),
    )
    monkeypatch.setattr(providers, "resolve", lambda *args: "secret")


def test_validate_route_normalizes_and_rejects_mismatches():
    normalized = providers.validate_route(ARK, "image")
    assert normalized["endpoint"] == "https://ark.cn-beijing.volces.com/api/v3"
    assert normalized["timeout_seconds"] == 61
    with pytest.raises(ProviderFailure, match="unsupported_media_route"):
        providers.validate_route({**ARK, "capability": "video"}, "image")
    with pytest.raises(ProviderFailure, match="provider_endpoint_invalid"):
        providers.validate_route({**ARK, "endpoint": "http://169.254.169.254"}, "image")
    with pytest.raises(ProviderFailure, match="provider_endpoint_invalid"):
        providers.validate_route({**ARK, "endpoint": "https://example.com"}, "image")


def test_validate_route_accepts_minimax_china_primary_endpoint():
    normalized = providers.validate_route(
        {**MINIMAX, "endpoint": "https://api.minimax.cn/v1"}, "audio"
    )
    assert normalized["endpoint"] == "https://api.minimax.cn/v1"


def test_video_route_and_payload_only_allow_documented_multireference_limits():
    with pytest.raises(ProviderFailure, match="unsupported_media_route"):
        providers.validate_route({**VIDEO, "model": "doubao-seedance-1-5-pro-251215"}, "video")
    assert providers.video_limits("doubao-seedance-2-0-pro-260000") == {
        "max_duration": 15,
        "max_references": 9,
        "resolutions": ("720P", "1080P"),
    }
    assert providers.video_limits("doubao-seedance-2-5-pro-260000")["max_references"] == 30
    with pytest.raises(ProviderFailure, match="invalid_video_payload"):
        providers.validate_video_payload(
            VIDEO,
            {
                "prompt": "p",
                "images": ["data:image/png;base64,AA=="] * 10,
                "duration": 5,
                "resolution": "720P",
                "aspect_ratio": "16:9",
            },
        )


@pytest.mark.parametrize("variant", ("fast", "mini"))
def test_seedance_2_fast_and_mini_only_allow_720p(variant):
    config = {**VIDEO, "model": f"doubao-seedance-2-0-{variant}-260000"}
    assert providers.video_limits(config["model"])["resolutions"] == ("720P",)
    with pytest.raises(ProviderFailure, match="invalid_video_payload"):
        providers.validate_video_payload(
            config,
            {
                "prompt": "p",
                "images": ["data:image/png;base64,AA=="],
                "duration": 5,
                "resolution": "1080P",
                "aspect_ratio": "16:9",
            },
        )


def test_generate_image_maps_references_and_decodes_base64(monkeypatch):
    seen = {}

    def handler(request):
        seen.update(json=request.read(), headers=request.headers)
        return httpx.Response(
            200,
            json={
                "id": "img-1",
                "data": [{"b64_json": base64.b64encode(b"png-data").decode()}],
                "usage": {"generated_images": 1},
            },
        )

    install_transport(monkeypatch, handler)
    result = providers.generate_image(
        ARK, {"prompt": "p", "images": ["data:image/png;base64,AA=="], "size": "2K"}
    )
    body = __import__("json").loads(seen["json"])
    assert body == {
        "model": ARK["model"],
        "prompt": "p",
        "image": ["data:image/png;base64,AA=="],
        "size": "2K",
        "sequential_image_generation": "disabled",
        "stream": False,
        "response_format": "b64_json",
        "watermark": False,
    }
    assert result == {
        "data": b"png-data",
        "mime": "application/octet-stream",
        "usage": {"generated_images": 1},
        "provider_request_id": "img-1",
    }
    assert seen["headers"]["authorization"] == "Bearer secret"


def test_generate_audio_maps_supported_fields_and_decodes_hex(monkeypatch):
    seen = {}

    def handler(request):
        seen["body"] = __import__("json").loads(request.read())
        return httpx.Response(
            200,
            json={
                "data": {"audio": b"mp3".hex(), "status": 2},
                "extra_info": {"usage_characters": 4},
                "trace_id": "trace-1",
                "base_resp": {"status_code": 0, "status_msg": "success"},
            },
        )

    install_transport(monkeypatch, handler)
    result = providers.generate_audio(
        MINIMAX, {"text": "你好", "voice": "male-qn-qingse", "emotion": "happy", "speed": 1.1}
    )
    assert seen["body"] == {
        "model": "speech-2.8-hd",
        "text": "你好",
        "stream": False,
        "voice_setting": {
            "voice_id": "male-qn-qingse",
            "speed": 1.1,
            "vol": 1,
            "pitch": 0,
            "emotion": "happy",
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
        "subtitle_enable": False,
    }
    assert result["data"] == b"mp3"
    assert result["mime"] == "audio/mpeg"
    with pytest.raises(ProviderFailure, match="invalid_audio_payload"):
        providers.generate_audio(
            MINIMAX, {"text": "x", "voice": "v", "emotion": "angry!", "speed": 1}
        )


@pytest.mark.parametrize(
    ("raw", "expected_code"),
    [
        (
            {
                "base_resp": {"status_code": 1004, "status_msg": "sensitive upstream detail"},
                "data": {"audio": "736563726574", "status": 2},
            },
            "provider_audio_status_1004",
        ),
        ({"base_resp": {"status_code": 0}}, "provider_audio_data_missing"),
        (
            {"base_resp": {"status_code": 0}, "data": {"status": 1, "audio": "6d7033"}},
            "provider_audio_status_invalid",
        ),
        (
            {"base_resp": {"status_code": 0}, "data": {"status": 2}},
            "provider_audio_content_invalid",
        ),
    ],
)
def test_generate_audio_returns_sanitized_diagnostic_codes(monkeypatch, raw, expected_code):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json=raw))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_audio(
            MINIMAX, {"text": "x", "voice": "v", "emotion": "neutral", "speed": 1}
        )
    assert error.value.code == expected_code
    assert error.value.unknown
    assert "sensitive" not in str(error.value)
    assert "secret" not in str(error.value)


def test_submit_video_preserves_reference_order_and_options(monkeypatch):
    seen = {}

    def handler(request):
        seen["body"] = __import__("json").loads(request.read())
        return httpx.Response(200, json={"id": "task-1"})

    install_transport(monkeypatch, handler)
    refs = ["data:image/png;base64,AA==", "data:image/jpeg;base64,AQ=="]
    task_id = providers.submit_video(
        VIDEO,
        {
            "prompt": "第二张为上一镜尾帧",
            "images": refs,
            "duration": 5,
            "resolution": "1080P",
            "aspect_ratio": "9:16",
        },
    )
    assert task_id == "task-1"
    assert seen["body"]["content"] == [
        {"type": "text", "text": "第二张为上一镜尾帧"},
        *[
            {"type": "image_url", "image_url": {"url": ref}, "role": "reference_image"}
            for ref in refs
        ],
    ]
    assert seen["body"] | {} == {
        "model": VIDEO["model"],
        "content": seen["body"]["content"],
        "resolution": "1080p",
        "ratio": "9:16",
        "duration": 5,
        "generate_audio": False,
        "return_last_frame": True,
        "watermark": False,
    }


@pytest.mark.parametrize(
    ("provider_error", "expected"),
    [
        ({"code": "ModelNotOpen", "message": "private detail"}, "provider_model_not_open"),
        ({"code": "AccessDenied", "message": "private detail"}, "provider_access_denied"),
        (
            {"code": "InvalidParameterValue", "message": "resolution private detail"},
            "provider_invalid_parameter_resolution",
        ),
        (
            {"code": "InvalidParameter.UnprocessableEntity", "message": "duration detail"},
            "provider_invalid_parameter_duration",
        ),
        (
            {"code": "InputImageSensitiveContentDetected", "message": "private detail"},
            "provider_reference_image_sensitive",
        ),
        ({"code": "UntrustedSecretCode", "message": "secret detail"}, "provider_http_400"),
    ],
)
def test_video_4xx_returns_only_whitelisted_safe_diagnostics(monkeypatch, provider_error, expected):
    install_transport(
        monkeypatch, lambda request: httpx.Response(400, json={"error": provider_error})
    )
    with pytest.raises(ProviderFailure) as error:
        providers.submit_video(
            VIDEO,
            {
                "prompt": "p",
                "images": ["data:image/png;base64,AA=="],
                "duration": 5,
                "resolution": "720P",
                "aspect_ratio": "16:9",
            },
        )
    assert error.value.code == expected
    assert not error.value.unknown
    assert "private" not in str(error.value)
    assert "secret" not in str(error.value)


@pytest.mark.parametrize(
    ("code", "message", "expected"),
    [
        (
            "InvalidParameter.UnsupportedParameter",
            "return_last_frame unsupported with image content",
            "provider_invalid_parameter_last_frame",
        ),
        (
            "InvalidParameter.InvalidValue",
            "generate_audio unsupported with reference_image",
            "provider_invalid_parameter_audio",
        ),
        (
            "InvalidParameter.OutOfRange",
            "resolution conflicts with image content",
            "provider_invalid_parameter_resolution",
        ),
        (
            "InvalidParameter.ReferenceImage",
            "reference_image invalid",
            "provider_invalid_parameter_reference_image",
        ),
        (
            "InvalidParameter.Bad-Suffix",
            "return_last_frame private detail",
            "provider_http_400",
        ),
    ],
)
def test_invalid_parameter_namespace_is_strict_and_specific_fields_win(
    monkeypatch, code, message, expected
):
    install_transport(
        monkeypatch,
        lambda request: httpx.Response(400, json={"error": {"code": code, "message": message}}),
    )
    with pytest.raises(ProviderFailure) as error:
        providers.submit_video(
            VIDEO,
            {
                "prompt": "p",
                "images": ["data:image/png;base64,AA=="],
                "duration": 5,
                "resolution": "720P",
                "aspect_ratio": "16:9",
            },
        )
    assert error.value.code == expected
    assert not error.value.unknown


@pytest.mark.parametrize(
    ("provider_status", "expected"),
    [
        ("queued", "pending"),
        ("running", "pending"),
        ("succeeded", "succeeded"),
        ("failed", "failed"),
    ],
)
def test_poll_video_maps_states_without_downloading(monkeypatch, provider_status, expected):
    def handler(request):
        body = {"id": "task-1", "status": provider_status, "usage": {"total_tokens": 2}}
        if provider_status == "succeeded":
            body["content"] = {"video_url": "https://cdn.example.test/signed?secret=x"}
        if provider_status == "failed":
            body["error"] = {"code": "ContentPolicy"}
        return httpx.Response(200, json=body)

    install_transport(monkeypatch, handler)
    result = providers.poll_video(VIDEO, "task-1")
    assert result["state"] == expected
    if expected == "succeeded":
        assert result["url"].startswith("https://cdn.example.test/")
    if expected == "failed":
        assert result["error"] == "provider_task_failed"


def test_timeout_and_malformed_success_are_unknown(monkeypatch):
    install_transport(monkeypatch, lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("late")))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_image(ARK, {"prompt": "p", "images": [], "size": "2K"})
    assert error.value.code == "provider_timeout" and error.value.unknown

    install_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": []}))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_image(ARK, {"prompt": "p", "images": [], "size": "2K"})
    assert error.value.code == "provider_invalid_response" and error.value.unknown

    install_transport(monkeypatch, lambda request: httpx.Response(202, json={}))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_image(ARK, {"prompt": "p", "images": [], "size": "2K"})
    assert error.value.code == "provider_acceptance_unknown" and error.value.unknown

    install_transport(monkeypatch, lambda request: httpx.Response(200, json=[]))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_image(ARK, {"prompt": "p", "images": [], "size": "2K"})
    assert error.value.code == "provider_invalid_response" and error.value.unknown


def test_video_task_id_matches_database_and_safe_path_limits(monkeypatch):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json={"status": "queued"}))
    assert providers.poll_video(VIDEO, "a" * 200) == {"state": "pending", "usage": {}}
    for invalid in ("a" * 201, "task/child", "task?secret", "task%2Fchild"):
        with pytest.raises(ProviderFailure, match="invalid_external_id"):
            providers.poll_video(VIDEO, invalid)

    install_transport(monkeypatch, lambda request: httpx.Response(200, json=[]))
    with pytest.raises(ProviderFailure) as error:
        providers.submit_video(
            VIDEO,
            {
                "prompt": "p",
                "images": ["data:image/png;base64,AA=="],
                "duration": 5,
                "resolution": "720P",
                "aspect_ratio": "16:9",
            },
        )
    assert error.value.code == "provider_invalid_response" and error.value.unknown


def test_download_has_no_auth_rejects_redirect_and_limits_size(monkeypatch):
    seen = {}

    def handler(request):
        seen["headers"] = request.headers
        return httpx.Response(200, content=b"ok")

    install_transport(monkeypatch, handler)
    monkeypatch.setattr(
        providers.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))],
    )
    assert providers.download_media("https://cdn.example.test/file") == b"ok"
    assert "authorization" not in seen["headers"]
    assert seen["headers"]["host"] == "cdn.example.test"

    install_transport(
        monkeypatch, lambda request: httpx.Response(302, headers={"location": "http://127.0.0.1"})
    )
    with pytest.raises(ProviderFailure, match="media_download_rejected"):
        providers.download_media("https://cdn.example.test/file")
    with pytest.raises(ProviderFailure, match="media_url_invalid"):
        providers.download_media("http://169.254.169.254/latest/meta-data")

    monkeypatch.setattr(providers, "_MAX_MEDIA_BYTES", 10)
    install_transport(monkeypatch, lambda request: httpx.Response(200, content=b"x" * 11))
    with pytest.raises(ProviderFailure, match="media_too_large"):
        providers.download_media("https://cdn.example.test/file")


def test_download_pins_verified_ip_and_original_tls_hostname(monkeypatch):
    calls = []

    def resolve_once(*args, **kwargs):
        calls.append(args[0])
        return [(2, 1, 6, "", ("93.184.216.34", 443))]

    def handler(request):
        assert request.url.host == "93.184.216.34"
        assert request.headers["host"] == "cdn.example.test"
        assert request.extensions["sni_hostname"] == b"cdn.example.test"
        return httpx.Response(200, content=b"ok")

    install_transport(monkeypatch, handler)
    monkeypatch.setattr(providers.socket, "getaddrinfo", resolve_once)
    assert providers.download_media("https://cdn.example.test/path?q=signed") == b"ok"
    assert calls == ["cdn.example.test"]


def test_provider_json_body_is_stream_limited(monkeypatch):
    monkeypatch.setattr(providers, "_MAX_TTS_RESPONSE_BYTES", 10)
    install_transport(monkeypatch, lambda request: httpx.Response(200, content=b"{" + b"x" * 10))
    with pytest.raises(ProviderFailure) as error:
        providers.generate_audio(
            MINIMAX, {"text": "x", "voice": "v", "emotion": "neutral", "speed": 1}
        )
    assert error.value.code == "provider_response_too_large" and error.value.unknown


@pytest.mark.parametrize(
    "body",
    [
        {"Code": "OutputVideoSensitiveContentDetected", "Message": "private secret"},
        {"Error": {"Code": "OutputVideoSensitiveContentDetected", "Message": "private secret"}},
        {
            "ResponseMetadata": {
                "Error": {
                    "Code": "OutputVideoSensitiveContentDetected",
                    "Message": "private secret",
                }
            }
        },
        {"error": {"code": "OutputVideoSensitiveContentDetected", "message": "private secret"}},
    ],
)
def test_video_error_envelopes_preserve_safe_category(body):
    import json

    assert (
        providers._provider_rejection_code(400, json.dumps(body))
        == "provider_output_video_sensitive"
    )


@pytest.mark.parametrize(
    "body", [[], None, {"Error": "private secret"}, {"Code": "PrivateSecretValue"}]
)
def test_video_malformed_error_envelopes_do_not_leak(body):
    import json

    assert providers._provider_rejection_code(400, json.dumps(body)) == "provider_http_400"


def test_real_privacy_rejection_category():
    import json

    body = {"error": {"code": "InputImageSensitiveContentDetected.PrivacyInformation"}}
    assert (
        providers._provider_rejection_code(400, json.dumps(body))
        == "provider_reference_image_privacy"
    )


@pytest.mark.parametrize("code", ["containssecretvalue", "Bad\nInjected", "A" * 129])
def test_rejection_log_excludes_secret_and_unbounded_codes(monkeypatch, caplog, code):
    install_transport(
        monkeypatch,
        lambda request: httpx.Response(
            400,
            json={"Code": code, "Message": "secret private body data:image/png;base64,AA=="},
            headers={"X-Secret": "secret"},
        ),
    )
    with pytest.raises(ProviderFailure):
        providers._request(
            {"endpoint": ARK["endpoint"], "timeout_seconds": 5},
            "POST",
            "/contents/generations/tasks",
            "secret",
            payload={},
        )
    assert "Code=unavailable" in caplog.text
    assert "secret" not in caplog.text
    assert "private" not in caplog.text
    assert "base64" not in caplog.text
    assert "Injected" not in caplog.text
