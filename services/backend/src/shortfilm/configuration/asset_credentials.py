"""Atomic, encrypted AK/SK configuration; public responses never include credentials."""

import json
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field, SecretStr, field_validator

from shortfilm.configuration import credentials
from shortfilm.schemas import DTO

router = APIRouter(prefix="/settings/asset-credentials", tags=["settings"])
REF = "ARK_ASSET_STORAGE_BUNDLE"
ENDPOINT = "https://ark.cn-beijing.volcengineapi.com"


class AssetConfiguration(DTO):
    bucket: str = Field(min_length=3, max_length=63, pattern=r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")
    region: Literal["cn-beijing"] = "cn-beijing"
    project_name: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class AssetCredentialSave(AssetConfiguration):
    base_version: int = Field(ge=0)
    access_key: SecretStr = Field(min_length=1, max_length=256)
    secret_key: SecretStr = Field(min_length=1, max_length=256)

    @field_validator("access_key", "secret_key")
    @classmethod
    def valid_secret(cls, value):
        raw = value.get_secret_value()
        if any(ord(c) < 33 or ord(c) > 126 for c in raw):
            raise ValueError("凭据格式无效")
        return value


class AssetCredentialStatus(DTO):
    configured: bool
    revision: int
    configuration: AssetConfiguration | None = None
    connection_state: Literal["not_tested"] = "not_tested"


def status():
    meta = credentials.metadata(REF, ENDPOINT)
    configuration = None
    if meta["configured"]:
        data = json.loads(credentials.resolve(REF, ENDPOINT, meta["revision"]))
        configuration = AssetConfiguration.model_validate(data["configuration"])
    return AssetCredentialStatus(
        configured=meta["configured"], revision=meta["revision"], configuration=configuration
    )


@router.get("", response_model=AssetCredentialStatus)
def get_asset_credentials():
    try:
        return status()
    except (credentials.CredentialError, ValueError, KeyError):
        raise HTTPException(503, "素材凭据存储不可用") from None


@router.put("", response_model=AssetCredentialStatus)
def put_asset_credentials(body: AssetCredentialSave):
    configuration = AssetConfiguration.model_validate(
        body.model_dump(include={"bucket", "region", "project_name"})
    )
    try:
        result = credentials.save(
            REF,
            ENDPOINT,
            json.dumps(
                {
                    "configuration": configuration.model_dump(),
                    "access_key": body.access_key.get_secret_value(),
                    "secret_key": body.secret_key.get_secret_value(),
                }
            ),
            body.base_version,
        )
    except credentials.CredentialError as exc:
        if str(exc) == "credential_revision_conflict":
            raise HTTPException(409, "素材配置已变化，请读取最新基准后重新保存") from None
        raise HTTPException(503, "素材凭据保存失败") from None
    return AssetCredentialStatus(
        configured=True, revision=result["revision"], configuration=configuration
    )


class AssetAccessCheck(DTO):
    base_version: int = Field(ge=1)


class AssetAccessResult(DTO):
    revision: int
    tos: str
    assets: str


@router.post("/test", response_model=AssetAccessResult)
def test_asset_access(body: AssetAccessCheck):
    from shortfilm.media.asset_access import check_access

    try:
        bundle = json.loads(credentials.resolve(REF, ENDPOINT, body.base_version))
    except credentials.CredentialError as exc:
        if str(exc) == "credential_revision_conflict":
            raise HTTPException(409, "素材配置已变化，请读取最新基准") from None
        raise HTTPException(503, "素材凭据不可用") from None
    result = check_access(bundle)
    return AssetAccessResult(revision=body.base_version, **result)
