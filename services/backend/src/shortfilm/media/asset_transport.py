"""Bounded TOS and Ark trusted-asset transports. Never log signed material."""

import hashlib
import json
import logging
import re

import httpx
import tos
from volcengine.auth.SignerV4 import SignerV4
from volcengine.base.Request import Request
from volcengine.Credentials import Credentials

from shortfilm.creation.provider import ProviderFailure

ARK_HOST = "ark.cn-beijing.volcengineapi.com"
ARK_VERSION = "2024-01-01"
ARK_REGION = "cn-beijing"
_MAX_ARK_RESPONSE = 262_144
_MAX_IMAGE_BYTES = 30_000_000
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}")
_KEY_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,511}")

# SDK diagnostics can include request headers and signed URLs.
logging.getLogger("tos").setLevel(logging.CRITICAL + 1)


def _configuration(bundle):
    if not isinstance(bundle, dict):
        raise ProviderFailure("asset_configuration_invalid")
    cfg = bundle.get("configuration")
    if not isinstance(cfg, dict):
        raise ProviderFailure("asset_configuration_invalid")
    bucket = cfg.get("bucket")
    region = cfg.get("region")
    project = cfg.get("project_name")
    access_key = bundle.get("access_key")
    secret_key = bundle.get("secret_key")
    if (
        not isinstance(bucket, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket)
        or region != ARK_REGION
        or not isinstance(project, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project)
        or not isinstance(access_key, str)
        or not access_key
        or not isinstance(secret_key, str)
        or not secret_key
    ):
        raise ProviderFailure("asset_configuration_invalid")
    return cfg


def _valid_key(key):
    return isinstance(key, str) and _KEY_PATTERN.fullmatch(key) and ".." not in key.split("/")


def _tos_client(bundle):
    cfg = _configuration(bundle)
    return tos.TosClientV2(
        bundle["access_key"],
        bundle["secret_key"],
        endpoint="https://tos-cn-beijing.volces.com",
        region=cfg["region"],
        max_retry_count=0,
        follow_redirect_times=0,
        connection_time=5,
        socket_timeout=30,
    )


def upload_private_object(bundle, data, sha256, key):
    cfg = _configuration(bundle)
    if (
        not isinstance(data, bytes)
        or not data
        or len(data) >= _MAX_IMAGE_BYTES
        or not isinstance(sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", sha256)
        or hashlib.sha256(data).hexdigest() != sha256
        or not _valid_key(key)
    ):
        raise ProviderFailure("asset_upload_invalid")
    client = _tos_client(bundle)
    try:
        try:
            existing = client.head_object(cfg["bucket"], key)
        except tos.exceptions.TosServerError as exc:
            if getattr(exc, "status_code", None) == 404:
                existing = None
            elif getattr(exc, "status_code", None) == 403:
                raise ProviderFailure("tos_head_access_denied") from None
            else:
                raise ProviderFailure("tos_head_failed") from None
        except Exception:
            raise ProviderFailure("tos_head_failed") from None
        if existing is not None:
            metadata = getattr(existing, "meta", None)
            if not isinstance(metadata, dict) or metadata.get("sha256") != sha256:
                raise ProviderFailure("tos_object_conflict")
            return {
                "key": key,
                "sha256": sha256,
                "size": len(data),
                "etag": str(getattr(existing, "etag", ""))[:200],
            }
        try:
            output = client.put_object(
                cfg["bucket"],
                key,
                content=data,
                content_length=len(data),
                content_sha256=sha256,
                content_type="application/octet-stream",
                meta={"sha256": sha256},
                forbid_overwrite=True,
            )
        except tos.exceptions.TosServerError as exc:
            if getattr(exc, "status_code", None) == 403:
                raise ProviderFailure("tos_put_access_denied") from None
            if isinstance(getattr(exc, "status_code", None), int) and exc.status_code >= 500:
                raise ProviderFailure("tos_put_acceptance_unknown", unknown=True) from None
            raise ProviderFailure("tos_put_rejected") from None
        except Exception:
            raise ProviderFailure("tos_put_acceptance_unknown", unknown=True) from None
        return {
            "key": key,
            "sha256": sha256,
            "size": len(data),
            "etag": str(getattr(output, "etag", ""))[:200],
        }
    finally:
        client.close()


def presign_get(bundle, key, expires_seconds=600):
    """Return a sensitive, short-lived internal URL that includes the signing AK.

    The caller must not expose this value in public API responses, persistence
    snapshots, exceptions, or logs. TOS signing does not place the SK in the URL.
    """
    cfg = _configuration(bundle)
    if not _valid_key(key) or not isinstance(expires_seconds, int) or not 60 <= expires_seconds <= 3600:
        raise ProviderFailure("asset_presign_invalid")
    client = _tos_client(bundle)
    try:
        try:
            output = client.pre_signed_url(
                tos.HttpMethodType.Http_Method_Get,
                cfg["bucket"],
                key,
                expires_seconds,
            )
            url = output.signed_url
            if not isinstance(url, str) or not url.startswith("https://"):
                raise ValueError()
            return url
        except Exception:
            raise ProviderFailure("asset_presign_failed") from None
    finally:
        client.close()


def _safe_business_code(code):
    if code in ("AccessDenied", "PermissionDenied"):
        return "asset_access_denied"
    if isinstance(code, str) and re.fullmatch(r"InvalidParameter(?:\.[A-Za-z0-9]+){0,3}", code):
        return "asset_invalid_parameter"
    if code in ("ResourceNotFound", "NotFound"):
        return "asset_not_found"
    return "asset_request_failed"


def _ark_call(bundle, action, payload, *, submit):
    _configuration(bundle)
    request = Request()
    request.schema = "https"
    request.host = ARK_HOST
    request.path = "/"
    request.method = "POST"
    request.query = {"Action": action, "Version": ARK_VERSION}
    request.headers = {"Content-Type": "application/json", "Host": ARK_HOST}
    request.body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    SignerV4.sign(
        request,
        Credentials(bundle["access_key"], bundle["secret_key"], "ark", ARK_REGION),
    )
    try:
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            with client.stream(
                "POST",
                "https://" + ARK_HOST + "/",
                params=request.query,
                headers=request.headers,
                content=request.body.encode(),
            ) as response:
                status = response.status_code
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_ARK_RESPONSE:
                        raise ProviderFailure("asset_response_too_large", unknown=submit)
    except ProviderFailure:
        raise
    except (httpx.TimeoutException, httpx.TransportError):
        code = "asset_acceptance_unknown" if submit else "asset_connection_failed"
        raise ProviderFailure(code, unknown=submit) from None
    if status >= 500 or (200 <= status < 300 and status != 200):
        raise ProviderFailure("asset_acceptance_unknown", unknown=submit)
    if status != 200:
        failure = ProviderFailure(f"asset_http_{status}")
        # Keep only a bounded machine code, never the provider message or body.
        try:
            raw_error = json.loads(body)["ResponseMetadata"]["Error"]["Code"]
            if (
                isinstance(raw_error, str)
                and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]{0,127}", raw_error)
                and bundle["access_key"] not in raw_error
                and bundle["secret_key"] not in raw_error
            ):
                failure.provider_code = raw_error
        except (ValueError, TypeError, KeyError):
            pass
        raise failure
    try:
        raw = json.loads(body)
        metadata = raw.get("ResponseMetadata")
        if not isinstance(metadata, dict):
            raise ValueError()
        error = metadata.get("Error")
        if error:
            if not isinstance(error, dict):
                raise ValueError()
            raise ProviderFailure(_safe_business_code(error.get("Code")))
        result = raw.get("Result")
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except ProviderFailure:
        raise
    except (AttributeError, UnicodeDecodeError, ValueError):
        raise ProviderFailure("asset_invalid_response", unknown=submit) from None


def _name(value, maximum=64):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ProviderFailure("asset_request_invalid")
    return value


def create_asset_group(bundle, name, description=""):
    cfg = _configuration(bundle)
    name = _name(name)
    if not isinstance(description, str) or len(description) > 300:
        raise ProviderFailure("asset_request_invalid")
    result = _ark_call(
        bundle,
        "CreateAssetGroup",
        {
            "Name": name,
            "Description": description,
            "GroupType": "AIGC",
            "ProjectName": cfg["project_name"],
        },
        submit=True,
    )
    group_id = result.get("Id")
    if not isinstance(group_id, str) or not _ID_PATTERN.fullmatch(group_id):
        raise ProviderFailure("asset_invalid_response", unknown=True)
    return group_id


def create_asset(bundle, group_id, url, name):
    cfg = _configuration(bundle)
    name = _name(name)
    if (
        not isinstance(group_id, str)
        or not _ID_PATTERN.fullmatch(group_id)
        or not isinstance(url, str)
        or not url.startswith("https://")
        or len(url) > 8192
    ):
        raise ProviderFailure("asset_request_invalid")
    result = _ark_call(
        bundle,
        "CreateAsset",
        {
            "GroupId": group_id,
            "URL": url,
            "AssetType": "Image",
            "Name": name,
            "ProjectName": cfg["project_name"],
        },
        submit=True,
    )
    asset_id = result.get("Id")
    if not isinstance(asset_id, str) or not _ID_PATTERN.fullmatch(asset_id):
        raise ProviderFailure("asset_invalid_response", unknown=True)
    return asset_id


_ASSET_FAILURE_CODES = {
    "FaceMismatch": "asset_face_mismatch",
    "TranscodingFailed": "asset_transcoding_failed",
    "ContentRestricted": "asset_content_restricted",
    "DownloadFailed": "asset_download_failed",
    "TypeMismatch": "asset_type_mismatch",
    "FormatUnsupported": "asset_format_unsupported",
    "FormatUndetectable": "asset_format_undetectable",
    "FileSizeTooLarge": "asset_file_too_large",
    "InputImageSensitiveContentDetected": "asset_image_sensitive",
    "InputImageSensitiveContentDetected.PolicyViolation": "asset_image_policy_violation",
    "ModerationServiceErrorUploadFailed": "asset_moderation_unavailable",
    "InternalError": "asset_internal_error",
}


def get_asset(bundle, asset_id):
    cfg = _configuration(bundle)
    if not isinstance(asset_id, str) or not _ID_PATTERN.fullmatch(asset_id):
        raise ProviderFailure("asset_request_invalid")
    result = _ark_call(
        bundle,
        "GetAsset",
        {"Id": asset_id, "ProjectName": cfg["project_name"]},
        submit=False,
    )
    if result.get("Id") != asset_id:
        raise ProviderFailure("asset_invalid_response")
    status = result.get("Status")
    if status == "Processing":
        return {"state": "processing"}
    if status == "Active":
        return {"state": "active", "asset_id": asset_id}
    if status == "Failed":
        error = result.get("Error")
        code = error.get("Code") if isinstance(error, dict) else None
        return {"state": "failed", "error": _ASSET_FAILURE_CODES.get(code, "asset_failed")}
    raise ProviderFailure("asset_invalid_response")
