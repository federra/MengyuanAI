"""Write-only credential entry and bounded tests of a saved model binding."""

import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, SecretStr, field_validator
from sqlalchemy.orm import Session

from shortfilm.configuration import credentials
from shortfilm.configuration.schemas import ModelRoute
from shortfilm.configuration.service import latest
from shortfilm.creation.provider import ProviderFailure, request_json
from shortfilm.db import session
from shortfilm.schemas import DTO

router = APIRouter(prefix="/model-credentials")


class CredentialVersion(DTO):
    base_version: int = Field(ge=0)
    binding_revision: int = Field(ge=1)


class CredentialSave(CredentialVersion):
    secret: SecretStr = Field(min_length=1, max_length=4096)

    @field_validator("secret")
    @classmethod
    def valid_secret(cls, value):
        raw = value.get_secret_value()
        if not raw.strip() or any(ord(c) < 33 or ord(c) > 126 for c in raw):
            raise ValueError("凭据格式无效")
        return value


class CredentialStatus(DTO):
    configured: bool
    source: Literal["stored", "environment", "none", "endpoint_mismatch"]
    revision: int
    binding_revision: int


class ConnectionResult(DTO):
    state: str
    latency_ms: int
    usage: dict[str, int]
    binding_revision: int
    credential_revision: int


def saved_route(db, key, revision=None):
    if not key.startswith(("model:category:", "model:step:")):
        raise HTTPException(422, "请选择模型配置")
    binding = latest(db, "system", key)
    if not binding or not binding.value:
        raise HTTPException(422, "请先保存独立模型配置；继承节点请到类别默认配置凭据")
    if revision is not None and binding.revision != revision:
        raise HTTPException(409, "模型配置已更新，请读取最新配置")
    return binding, ModelRoute.model_validate(binding.value).model_dump()


def status_for(route):
    try:
        return credentials.metadata(route["credential_ref"], route["endpoint"])
    except credentials.CredentialError:
        raise HTTPException(503, "凭据存储不可用，请检查服务端安全配置") from None


@router.get("/{key}", response_model=CredentialStatus)
def get_credential(key: str, db: Session = Depends(session)):
    binding, route = saved_route(db, key)
    return {**status_for(route), "binding_revision": binding.revision}


@router.put("/{key}", response_model=CredentialStatus)
def put_credential(key: str, body: CredentialSave, db: Session = Depends(session)):
    binding, route = saved_route(db, key, body.binding_revision)
    try:
        result = credentials.save(
            route["credential_ref"],
            route["endpoint"],
            body.secret.get_secret_value(),
            body.base_version,
        )
    except credentials.CredentialError as exc:
        if str(exc) == "credential_revision_conflict":
            raise HTTPException(409, "凭据已更新，请刷新状态后重新保存") from None
        raise HTTPException(503, "凭据保存失败，请检查服务端安全配置") from None
    return {**result, "binding_revision": binding.revision}


@router.post("/{key}/test", response_model=ConnectionResult)
def test_connection(key: str, body: CredentialVersion, db: Session = Depends(session)):
    binding, route = saved_route(db, key, body.binding_revision)
    if route["capability"] != "text":
        raise HTTPException(422, "当前仅支持文本模型连接测试")
    status = status_for(route)
    if status["revision"] != body.base_version:
        raise HTTPException(409, "凭据已更新，请刷新状态后重试")
    start, state, usage = time.monotonic(), "ok", {}
    if not status["configured"]:
        state = (
            "credential_endpoint_mismatch"
            if status["source"] == "endpoint_mismatch"
            else "text_credential_missing"
        )
    else:
        from urllib.parse import urlsplit

        config = {
            **route,
            "credential_revision": status["revision"],
            "endpoint": route["endpoint"].rstrip("/"),
            "json_mode": "json_object",
            "max_tokens": 64,
            "timeout_seconds": min(route["timeout_seconds"], 20),
            "thinking": "disabled"
            if urlsplit(route["endpoint"]).hostname == "api.deepseek.com"
            else None,
        }
        try:
            result, meta = request_json(
                config, [{"role": "user", "content": 'Return only JSON: {"ok":true}'}], {}
            )
            state = (
                "ok"
                if isinstance(result, dict) and result.get("ok") is True
                else "provider_invalid_response"
            )
            raw_usage = meta.get("usage", {})
            if isinstance(raw_usage, dict):
                usage = {
                    k: v
                    for k, v in raw_usage.items()
                    if k in ("prompt_tokens", "completion_tokens", "total_tokens")
                    and type(v) is int
                    and v >= 0
                }
        except ProviderFailure as exc:
            state = exc.code
    return {
        "state": state,
        "latency_ms": int((time.monotonic() - start) * 1000),
        "usage": usage,
        "binding_revision": binding.revision,
        "credential_revision": status["revision"],
    }
