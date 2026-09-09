"""HTTP transports for M2 media providers. No retries and no secret logging."""

import base64
import binascii
import ipaddress
import json
import logging
import re
import socket
from urllib.parse import urlsplit, urlunsplit

import httpx

from shortfilm.configuration.credentials import CredentialError, resolve
from shortfilm.creation.provider import ProviderFailure

_ARK_HOST = "ark.cn-beijing.volces.com"
_MINIMAX_HOSTS = {"api.minimax.cn", "api.minimaxi.com", "api-bj.minimaxi.com"}
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_MAX_IMAGE_BYTES = 20_000_000
_MAX_MEDIA_BYTES = 512 * 1024 * 1024
_MAX_IMAGE_RESPONSE_BYTES = 28_000_000
_MAX_TTS_RESPONSE_BYTES = 16_000_000
_MAX_VIDEO_RESPONSE_BYTES = 2_000_000
_EMOTIONS = {"happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"}


def _endpoint(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise ProviderFailure("provider_endpoint_invalid") from None
    host = (parsed.hostname or "").lower()
    if (
        not host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.scheme not in ("http", "https")
        or (parsed.scheme == "http" and host not in _LOCAL_HOSTS)
    ):
        raise ProviderFailure("provider_endpoint_invalid")
    authority = f"[{host}]" if ":" in host else host
    if port and port != (443 if parsed.scheme == "https" else 80):
        authority += f":{port}"
    return urlunsplit((parsed.scheme, authority, parsed.path.rstrip("/"), "", "")), host


def validate_route(config, kind):
    if not isinstance(config, dict) or kind not in ("image", "video", "audio"):
        raise ProviderFailure("unsupported_media_route")
    expected = "volcengine" if kind in ("image", "video") else "minimax"
    endpoint, host = _endpoint(config.get("endpoint"))
    model = config.get("model")
    valid_model = isinstance(model, str) and (
        (kind == "image" and model.startswith("doubao-seedream-"))
        or (kind == "video" and re.match(r"^doubao-seedance-2-(?:0|5)(?:-|$)", model))
        or (kind == "audio" and model == "speech-2.8-hd")
    )
    official = host == _ARK_HOST if kind in ("image", "video") else host in _MINIMAX_HOSTS
    if host not in _LOCAL_HOSTS and not official:
        raise ProviderFailure("provider_endpoint_invalid")
    if (
        config.get("provider") != expected
        or config.get("capability") != kind
        or not valid_model
        or not isinstance(config.get("credential_ref"), str)
        or not config["credential_ref"]
    ):
        raise ProviderFailure("unsupported_media_route")
    try:
        timeout = max(5, min(int(config.get("timeout_seconds", 60)), 300))
    except (TypeError, ValueError):
        raise ProviderFailure("unsupported_media_route") from None
    normalized = dict(config)
    normalized.update(endpoint=endpoint, timeout_seconds=timeout)
    return normalized


def _credential(config, kind):
    config = validate_route(config, kind)
    try:
        secret = resolve(
            config["credential_ref"], config["endpoint"], config.get("credential_revision")
        )
    except CredentialError as exc:
        raise ProviderFailure(str(exc)) from None
    return config, secret


def _error_fields(body):
    try:
        raw = json.loads(body)
        if not isinstance(raw, dict):
            return "", ""
        metadata = raw.get("ResponseMetadata", raw.get("ResponseMetaData", {}))
        candidates = [raw.get("error"), raw.get("Error")]
        if isinstance(metadata, dict):
            candidates.append(metadata.get("Error"))
        candidates.append(raw)
        for error in candidates:
            if not isinstance(error, dict):
                continue
            code = error.get("code", error.get("Code"))
            if isinstance(code, str):
                message = error.get("message", error.get("Message", ""))
                return code, message if isinstance(message, str) else ""
    except (UnicodeDecodeError, ValueError):
        pass
    return "", ""


def _provider_rejection_code(status_code, body):
    upstream_code, message = _error_fields(body)

    fixed_categories = {
        "ModelNotOpen": "provider_model_not_open",
        "AccessDenied": "provider_access_denied",
        "PermissionDenied": "provider_access_denied",
        "InputImageSensitiveContentDetected": "provider_reference_image_sensitive",
        "InputImageSensitiveContentDetected.PrivacyInformation": "provider_reference_image_privacy",
        "InputImageRiskDetectionFailed": "provider_reference_image_sensitive",
        "ContentPolicyViolation": "provider_content_sensitive",
        "OutputVideoSensitiveContentDetected": "provider_output_video_sensitive",
        "InputTextSensitiveContentDetected": "provider_input_text_sensitive",
    }
    if upstream_code in fixed_categories:
        return fixed_categories[upstream_code]

    if upstream_code == "InvalidParameterValue" or re.fullmatch(
        r"InvalidParameter(?:\.[A-Za-z][A-Za-z0-9]*){0,3}", upstream_code
    ):
        normalized = message.casefold()
        parameter_patterns = (
            ("last_frame", r"return[_ ]last[_ ]frame|last[_ ]frame"),
            ("audio", r"generate[_ ]audio|audio_url"),
            ("resolution", r"\bresolution\b"),
            ("duration", r"\bduration\b|\bframes\b"),
            ("ratio", r"\bratio\b|aspect[_ ]ratio"),
            ("model", r"\bmodel\b"),
            ("reference_image", r"reference[_ ]image|image_url|images?"),
            ("content", r"\bcontent\b|\bprompt\b"),
        )
        for category, pattern in parameter_patterns:
            if re.search(pattern, normalized):
                return "provider_invalid_parameter_" + category
        return "provider_invalid_parameter"

    if status_code == 401:
        return "provider_auth_failed"
    if status_code == 403:
        return "provider_access_denied"
    if status_code == 429:
        return "provider_rate_limited"
    return f"provider_http_{status_code}"


def _request(config, method, path, secret, *, payload=None, unknown_on_transport=True):
    max_bytes = {
        "/images/generations": _MAX_IMAGE_RESPONSE_BYTES,
        "/t2a_v2": _MAX_TTS_RESPONSE_BYTES,
    }.get(path, _MAX_VIDEO_RESPONSE_BYTES)
    try:
        with httpx.Client(timeout=config["timeout_seconds"], follow_redirects=False) as client:
            with client.stream(
                method,
                config["endpoint"] + path,
                headers={"Authorization": f"Bearer {secret}"},
                json=payload,
            ) as response:
                status_code = response.status_code
                declared = response.headers.get("content-length")
                if declared:
                    try:
                        declared_size = int(declared)
                    except ValueError:
                        raise ProviderFailure(
                            "provider_invalid_response", unknown=unknown_on_transport
                        ) from None
                    if declared_size > max_bytes:
                        raise ProviderFailure(
                            "provider_response_too_large", unknown=unknown_on_transport
                        )
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise ProviderFailure(
                            "provider_response_too_large", unknown=unknown_on_transport
                        )
    except ProviderFailure:
        raise
    except httpx.TimeoutException:
        raise ProviderFailure("provider_timeout", unknown=unknown_on_transport) from None
    except httpx.ConnectError:
        raise ProviderFailure("provider_connection_failed", unknown=unknown_on_transport) from None
    except httpx.TransportError:
        raise ProviderFailure("provider_acceptance_unknown", unknown=unknown_on_transport) from None
    if status_code >= 500 or (200 <= status_code < 300 and status_code != 200):
        raise ProviderFailure("provider_acceptance_unknown", unknown=unknown_on_transport)
    if status_code != 200:
        upstream_code, _ = _error_fields(body)
        # Preserve only the machine code, never message/body/headers/prompt or credentials.
        safe_code = (
            upstream_code
            if (
                re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]{0,127}", upstream_code)
                and secret not in upstream_code
            )
            else "unavailable"
        )
        logging.getLogger(__name__).warning(
            "Media provider rejected request: HTTP %s Code=%s", status_code, safe_code
        )
        raise ProviderFailure(_provider_rejection_code(status_code, body))
    try:
        raw = json.loads(body)
    except (UnicodeDecodeError, ValueError):
        raise ProviderFailure("provider_invalid_response", unknown=unknown_on_transport) from None
    if not isinstance(raw, dict):
        raise ProviderFailure("provider_invalid_response", unknown=unknown_on_transport)
    return raw


def _payload_keys(payload, required):
    if not isinstance(payload, dict) or set(payload) != set(required):
        return False
    return True


def generate_image(config, payload):
    if not _payload_keys(payload, ("prompt", "images", "size")):
        raise ProviderFailure("invalid_image_payload")
    if (
        not isinstance(payload["prompt"], str)
        or not payload["prompt"].strip()
        or not isinstance(payload["images"], list)
        or not all(
            isinstance(item, str) and item.startswith("data:image/") for item in payload["images"]
        )
        or not isinstance(payload["size"], str)
    ):
        raise ProviderFailure("invalid_image_payload")
    config, secret = _credential(config, "image")
    body = {
        "model": config["model"],
        "prompt": payload["prompt"],
        "size": payload["size"],
        "sequential_image_generation": "disabled",
        "stream": False,
        "response_format": "b64_json",
        "watermark": False,
    }
    if payload["images"]:
        body["image"] = payload["images"]
    raw = _request(config, "POST", "/images/generations", secret, payload=body)
    try:
        encoded = raw["data"][0]["b64_json"]
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > _MAX_IMAGE_BYTES or len(raw["data"]) != 1:
            raise ValueError()
        usage = raw.get("usage", {})
        if not isinstance(usage, dict):
            raise ValueError()
    except (KeyError, IndexError, TypeError, ValueError, binascii.Error):
        raise ProviderFailure("provider_invalid_response", unknown=True) from None
    return {
        "data": data,
        "mime": "application/octet-stream",
        "usage": usage,
        "provider_request_id": str(raw.get("id", ""))[:200],
    }


def generate_audio(config, payload):
    if not _payload_keys(payload, ("text", "voice", "emotion", "speed")):
        raise ProviderFailure("invalid_audio_payload")
    emotion = payload["emotion"]
    speed = payload["speed"]
    if (
        not isinstance(payload["text"], str)
        or not payload["text"].strip()
        or not isinstance(payload["voice"], str)
        or not payload["voice"].strip()
        or emotion not in _EMOTIONS
        or isinstance(speed, bool)
        or not isinstance(speed, (int, float))
        or not 0.5 <= speed <= 2.0
    ):
        raise ProviderFailure("invalid_audio_payload")
    config, secret = _credential(config, "audio")
    body = {
        "model": config["model"],
        "text": payload["text"],
        "stream": False,
        "voice_setting": {
            "voice_id": payload["voice"],
            "speed": speed,
            "vol": 1,
            "pitch": 0,
            "emotion": emotion,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
        "subtitle_enable": False,
    }
    raw = _request(config, "POST", "/t2a_v2", secret, payload=body)
    base_resp = raw.get("base_resp")
    if not isinstance(base_resp, dict):
        raise ProviderFailure("provider_audio_base_status_invalid", unknown=True)
    status_code = base_resp.get("status_code")
    if (
        isinstance(status_code, bool)
        or not isinstance(status_code, int)
        or not -999_999_999 <= status_code <= 999_999_999
    ):
        raise ProviderFailure("provider_audio_base_status_invalid", unknown=True)
    if status_code != 0:
        raise ProviderFailure(f"provider_audio_status_{status_code}", unknown=True)
    audio_data = raw.get("data")
    if not isinstance(audio_data, dict):
        raise ProviderFailure("provider_audio_data_missing", unknown=True)
    if audio_data.get("status") != 2:
        raise ProviderFailure("provider_audio_status_invalid", unknown=True)
    encoded_audio = audio_data.get("audio")
    if not isinstance(encoded_audio, str) or not encoded_audio:
        raise ProviderFailure("provider_audio_content_invalid", unknown=True)
    try:
        data = bytes.fromhex(encoded_audio)
        if not data or len(data) > _MAX_MEDIA_BYTES:
            raise ValueError()
        usage = raw.get("extra_info", {})
        if not isinstance(usage, dict):
            raise ValueError()
    except (TypeError, ValueError):
        raise ProviderFailure("provider_audio_content_invalid", unknown=True) from None
    return {
        "data": data,
        "mime": "audio/mpeg",
        "usage": usage,
        "provider_request_id": str(raw.get("trace_id", ""))[:200],
    }


def video_limits(model):
    if isinstance(model, str) and re.match(r"^doubao-seedance-2-0(?:-|$)", model):
        resolutions = (
            ("720P",)
            if re.match(r"^doubao-seedance-2-0-(?:fast|mini)(?:-|$)", model)
            else ("720P", "1080P")
        )
        return {
            "max_duration": 15,
            "max_references": 9,
            "resolutions": resolutions,
        }
    if isinstance(model, str) and re.match(r"^doubao-seedance-2-5(?:-|$)", model):
        return {
            "max_duration": 30,
            "max_references": 30,
            "resolutions": ("720P", "1080P"),
        }
    raise ProviderFailure("unsupported_media_route")


def validate_video_payload(config, payload):
    config = validate_route(config, "video")
    limits = video_limits(config["model"])
    if not _payload_keys(payload, ("prompt", "images", "duration", "resolution", "aspect_ratio")):
        raise ProviderFailure("invalid_video_payload")
    if (
        not isinstance(payload["prompt"], str)
        or not payload["prompt"].strip()
        or not isinstance(payload["images"], list)
        or not payload["images"]
        or len(payload["images"]) > limits["max_references"]
        or not all(
            isinstance(item, str) and item.startswith("data:image/") for item in payload["images"]
        )
        or payload["resolution"] not in limits["resolutions"]
        or payload["aspect_ratio"] not in ("9:16", "16:9", "1:1")
        or isinstance(payload["duration"], bool)
        or not isinstance(payload["duration"], int)
        or not 4 <= payload["duration"] <= limits["max_duration"]
    ):
        raise ProviderFailure("invalid_video_payload")
    return payload


def submit_video(config, payload):
    validate_video_payload(config, payload)
    config, secret = _credential(config, "video")
    content = [{"type": "text", "text": payload["prompt"]}]
    content.extend(
        {"type": "image_url", "image_url": {"url": image}, "role": "reference_image"}
        for image in payload["images"]
    )
    body = {
        "model": config["model"],
        "content": content,
        "resolution": payload["resolution"].lower(),
        "ratio": payload["aspect_ratio"],
        "duration": payload["duration"],
        "generate_audio": False,
        "return_last_frame": True,
        "watermark": False,
    }
    raw = _request(config, "POST", "/contents/generations/tasks", secret, payload=body)
    task_id = raw.get("id")
    if not isinstance(task_id, str) or not task_id or len(task_id) > 200:
        raise ProviderFailure("provider_invalid_response", unknown=True)
    return task_id


def poll_video(config, external_id):
    if not isinstance(external_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", external_id):
        raise ProviderFailure("invalid_external_id")
    config, secret = _credential(config, "video")
    raw = _request(
        config,
        "GET",
        "/contents/generations/tasks/" + external_id,
        secret,
        unknown_on_transport=False,
    )
    state = raw.get("status")
    usage = raw.get("usage", {})
    if not isinstance(usage, dict):
        raise ProviderFailure("provider_invalid_response")
    if state in ("queued", "running"):
        return {"state": "pending", "usage": usage}
    if state == "failed":
        return {"state": "failed", "usage": usage, "error": "provider_task_failed"}
    if state == "succeeded":
        try:
            url = raw["content"]["video_url"]
            if not isinstance(url, str) or not url.startswith("https://"):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise ProviderFailure("provider_invalid_response") from None
        return {"state": "succeeded", "url": url, "usage": usage}
    raise ProviderFailure("provider_invalid_response")


def _safe_media_url(url):
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except (TypeError, ValueError):
        raise ProviderFailure("media_url_invalid") from None
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
        or port not in (None, 443)
    ):
        raise ProviderFailure("media_url_invalid")
    try:
        addresses = socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
        safe_addresses = []
        for item in addresses:
            address = ipaddress.ip_address(item[4][0])
            if not address.is_global:
                raise ProviderFailure("media_url_invalid")
            safe_addresses.append(str(address))
        if not safe_addresses:
            raise ProviderFailure("media_url_invalid")
    except ProviderFailure:
        raise
    except (OSError, ValueError):
        raise ProviderFailure("media_url_invalid") from None
    address = safe_addresses[0]
    authority = f"[{address}]" if ":" in address else address
    pinned = urlunsplit(("https", authority, parsed.path, parsed.query, ""))
    return pinned, host


def download_media(url):
    safe_url, original_host = _safe_media_url(url)
    try:
        with httpx.Client(timeout=300, follow_redirects=False) as client:
            with client.stream(
                "GET",
                safe_url,
                headers={"Host": original_host},
                extensions={"sni_hostname": original_host.encode("ascii")},
            ) as response:
                if response.status_code != 200:
                    raise ProviderFailure("media_download_rejected")
                declared = response.headers.get("content-length")
                if declared and int(declared) > _MAX_MEDIA_BYTES:
                    raise ProviderFailure("media_too_large")
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > _MAX_MEDIA_BYTES:
                        raise ProviderFailure("media_too_large")
    except ProviderFailure:
        raise
    except (httpx.TimeoutException, httpx.TransportError, ValueError):
        raise ProviderFailure("media_download_failed") from None
    return bytes(data)
