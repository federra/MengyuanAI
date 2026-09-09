"""Bounded read-only access checks. Never log signed requests or provider response bodies."""

import json
import logging
import re

import httpx
import tos
from volcengine.auth.SignerV4 import SignerV4
from volcengine.base.Request import Request
from volcengine.Credentials import Credentials

# SDK request diagnostics may include signed headers; keep that logger silent.
logging.getLogger("tos").setLevel(logging.CRITICAL + 1)

HOST = "ark.cn-beijing.volcengineapi.com"


def safe_code(code, bundle):
    if isinstance(code, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]{0,127}", code):
        if not any(bundle[k] in code for k in ("access_key", "secret_key")):
            return code
    return "request_failed"


def check_access(bundle, *, check_tos=True):
    cfg = bundle["configuration"]
    result = {"tos": "not_tested", "assets": "not_tested"}
    if check_tos:
        client = tos.TosClientV2(
            bundle["access_key"],
            bundle["secret_key"],
            endpoint="https://tos-cn-beijing.volces.com",
            region="cn-beijing",
            max_retry_count=0,
            follow_redirect_times=0,
            connection_time=5,
            socket_timeout=15,
        )
        try:
            client.head_bucket(cfg["bucket"])
            result["tos"] = "ok"
        except tos.exceptions.TosServerError as exc:
            result["tos"] = safe_code(exc.code, bundle)
            return result
        except Exception:
            result["tos"] = "connection_failed"
            return result
        finally:
            client.close()
    request = Request()
    request.schema, request.host, request.path, request.method = "https", HOST, "/", "POST"
    request.query = {"Action": "ListAssetGroups", "Version": "2024-01-01"}
    request.headers = {"Content-Type": "application/json", "Host": HOST}
    request.body = json.dumps(
        {"ProjectName": cfg["project_name"], "MaxResults": 1, "Filter": {"GroupType": "AIGC"}}
    )
    SignerV4.sign(
        request, Credentials(bundle["access_key"], bundle["secret_key"], "ark", "cn-beijing")
    )
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as http:
            with http.stream(
                "POST",
                "https://" + HOST + "/",
                params=request.query,
                headers=request.headers,
                content=request.body.encode(),
            ) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 262144:
                        result["assets"] = "response_too_large"
                        return result
                raw = json.loads(body)
                error = raw.get("ResponseMetadata", {}).get("Error")
                if error:
                    result["assets"] = safe_code(error.get("Code"), bundle)
                elif response.status_code == 200 and isinstance(raw.get("Result"), dict):
                    result["assets"] = "ok"
                else:
                    result["assets"] = "invalid_response"
    except Exception:
        result["assets"] = "connection_failed"
    return result
