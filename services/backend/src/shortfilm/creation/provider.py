"""OpenAI-compatible text transport. No automatic HTTP retries or secret logging."""

import json
import os
from urllib.parse import urlsplit

import httpx

from shortfilm.config import settings


class ProviderFailure(Exception):
    def __init__(self, code, unknown=False):
        self.code, self.unknown = code, unknown
        super().__init__(code)


def model_snapshot():
    endpoint = settings.text_endpoint.rstrip("/")
    parts = urlsplit(endpoint)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise ProviderFailure("text_endpoint_not_configured")
    if not settings.text_model or not os.environ.get(settings.text_credential_ref):
        raise ProviderFailure("text_model_or_credential_missing")
    if settings.text_json_mode not in ("json_object", "json_schema", "text"):
        raise ProviderFailure("unsupported_json_mode")
    return {
        "provider": "openai-compatible",
        "endpoint": endpoint,
        "model": settings.text_model,
        "credential_ref": settings.text_credential_ref,
        "timeout_seconds": max(5, min(settings.text_timeout_seconds, 300)),
        "json_mode": settings.text_json_mode,
        "max_tokens": max(1024, min(settings.text_max_tokens, 32768)),
        "thinking": "disabled" if parts.hostname == "api.deepseek.com" else None,
    }


def request_json(config, messages, schema):
    credential = os.environ.get(config["credential_ref"])
    if not credential:
        raise ProviderFailure("text_credential_missing")
    payload = {
        "model": config["model"],
        "messages": messages,
        "stream": False,
        "max_tokens": config["max_tokens"],
    }
    if config.get("thinking"):
        payload["thinking"] = {"type": config["thinking"]}
    if config["json_mode"] == "json_schema":
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "story_output", "strict": True, "schema": schema},
        }
    elif config["json_mode"] == "json_object":
        payload["response_format"] = {"type": "json_object"}
    try:
        # Endpoint is operator-configured, never supplied by an API request. Redirects
        # are forbidden so an upstream cannot forward Authorization to another host.
        with httpx.Client(timeout=config["timeout_seconds"], follow_redirects=False) as client:
            response = client.post(
                config["endpoint"] + "/chat/completions",
                headers={"Authorization": f"Bearer {credential}"},
                json=payload,
            )
    except httpx.ConnectError:
        raise ProviderFailure("provider_connection_failed") from None
    except (httpx.TimeoutException, httpx.TransportError):
        raise ProviderFailure("provider_acceptance_unknown", unknown=True) from None
    if response.status_code >= 500:
        raise ProviderFailure("provider_acceptance_unknown", unknown=True)
    if response.status_code != 200:
        code = "provider_auth_failed" if response.status_code in (401, 403) else "provider_rejected"
        if response.status_code == 429:
            code = "provider_rate_limited"
        raise ProviderFailure(code)
    try:
        raw = response.json()
        content = raw["choices"][0]["message"]["content"]
        if not isinstance(content, str) or len(content) > 250000:
            raise ValueError()
        metadata = {
            "provider_request_id": str(raw.get("id", ""))[:200],
            "usage": raw.get("usage", {}),
        }
        try:
            return json.loads(content), metadata
        except ValueError:
            return None, metadata
    except (ValueError, KeyError, IndexError, TypeError):
        raise ProviderFailure("provider_invalid_response") from None
