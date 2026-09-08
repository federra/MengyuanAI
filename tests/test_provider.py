import json

import httpx
import pytest


def test_deepseek_payload_is_bounded_and_credential_stays_out_of_snapshot(monkeypatch):
    from shortfilm.config import settings
    from shortfilm.creation import provider

    monkeypatch.setattr(settings, "text_endpoint", "https://api.deepseek.com")
    monkeypatch.setattr(settings, "text_model", "deepseek-v4-pro")
    monkeypatch.setattr(settings, "text_credential_ref", "STORY_TEST_KEY")
    monkeypatch.setenv("STORY_TEST_KEY", "test-only-secret")
    config = provider.model_snapshot()
    assert "test-only-secret" not in json.dumps(config)
    real_client = httpx.Client

    def handler(request):
        assert request.url == "https://api.deepseek.com/chat/completions"
        assert request.headers["authorization"] == "Bearer test-only-secret"
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        assert body["max_tokens"] == 8192
        assert body["thinking"] == {"type": "disabled"}
        return httpx.Response(
            200,
            json={
                "id": "response-1",
                "choices": [{"message": {"content": '{"text":"故事"}'}}],
                "usage": {"total_tokens": 20},
            },
        )

    monkeypatch.setattr(
        provider.httpx,
        "Client",
        lambda **kw: real_client(**kw, transport=httpx.MockTransport(handler)),
    )
    result, metadata = provider.request_json(config, [{"role": "user", "content": "json"}], {})
    assert result == {"text": "故事"}
    assert metadata["provider_request_id"] == "response-1"


@pytest.mark.parametrize("status,unknown", [(401, False), (429, False), (503, True)])
def test_provider_errors_never_return_response_secrets(monkeypatch, status, unknown):
    from shortfilm.creation import provider

    monkeypatch.setenv("STORY_TEST_KEY", "test-only-secret")
    real_client = httpx.Client
    monkeypatch.setattr(
        provider.httpx,
        "Client",
        lambda **kw: real_client(
            **kw,
            transport=httpx.MockTransport(
                lambda req: httpx.Response(status, text="test-only-secret")
            ),
        ),
    )
    config = {
        "model": "test",
        "endpoint": "https://api.deepseek.com",
        "credential_ref": "STORY_TEST_KEY",
        "json_mode": "json_object",
        "timeout_seconds": 10,
        "max_tokens": 8192,
        "thinking": "disabled",
    }
    with pytest.raises(provider.ProviderFailure) as error:
        provider.request_json(config, [], {})
    assert error.value.unknown is unknown
    assert "test-only-secret" not in str(error.value)


def test_redis_guard_rejects_foreign_directory(tmp_path):
    import importlib.util

    spec = importlib.util.spec_from_file_location("local_script", "scripts/local.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert hasattr(module, "verify_redis_owner"), "Redis instance ownership guard is missing"

    class Client:
        def config_get(self, name):
            return {"dir": str(tmp_path)}

    with pytest.raises(SystemExit):
        module.verify_redis_owner(Client())


def test_provider_read_timeout_is_unknown(monkeypatch):
    from shortfilm.creation import provider

    monkeypatch.setenv("STORY_TEST_KEY", "test-only-secret")
    real_client = httpx.Client

    def timeout(request):
        raise httpx.ReadTimeout("upstream accepted then timed out", request=request)

    monkeypatch.setattr(
        provider.httpx,
        "Client",
        lambda **kw: real_client(**kw, transport=httpx.MockTransport(timeout)),
    )
    config = {
        "model": "test",
        "endpoint": "https://api.deepseek.com",
        "credential_ref": "STORY_TEST_KEY",
        "json_mode": "json_object",
        "timeout_seconds": 10,
        "max_tokens": 8192,
    }
    with pytest.raises(provider.ProviderFailure) as error:
        provider.request_json(config, [], {})
    assert error.value.unknown is True
