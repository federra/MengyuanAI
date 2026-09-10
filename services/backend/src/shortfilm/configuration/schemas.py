import re
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from shortfilm.schemas import DTO


class ResourceBody(DTO):
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["skill", "prompt", "style"]
    stage: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1)
    required_variables: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_content(self):
        if len(self.content.encode("utf-8")) > 131072:
            raise ValueError("正文不能超过128KB")
        if any("{{" + v + "}}" not in self.content for v in self.required_variables):
            raise ValueError("正文缺少必需变量")
        if self.kind == "skill" and self.stage not in ("story", "script", "storyboard"):
            raise ValueError("Skill适用环节无效")
        return self


class ResourceCreate(ResourceBody):
    @model_validator(mode="after")
    def quantity_variable(self):
        if (
            self.kind == "prompt"
            and self.stage in ("novel", "story.generate")
            and not re.search(r"\{\{\s*storyCount\s*\}\}", self.content)
        ):
            raise ValueError("故事生成模板必须包含{{storyCount}}数量变量")
        return self


class ResourceUpdate(DTO):
    base_version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1)
    required_variables: list[str] = Field(default_factory=list)


class BindingUpdate(DTO):
    base_version: int = Field(ge=0)
    value: dict | None


class ModelRoute(DTO):
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=100)
    endpoint: str
    capability: Literal["text", "image", "video", "audio"]
    credential_ref: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,99}$")
    timeout_seconds: int = Field(default=120, ge=1, le=600)

    @model_validator(mode="after")
    def safe_endpoint(self):
        from urllib.parse import urlsplit

        url = urlsplit(self.endpoint)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("服务地址无效或含敏感参数")
        if url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("远程服务必须使用HTTPS")
        return self


class OutputSpecification(DTO):
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    resolution: Literal["720P", "1080P", "4K"] = "1080P"
    video_model: ModelRoute | None = None
    style_resource_id: UUID | None = None

    @model_validator(mode="after")
    def video_capability(self):
        if self.video_model and self.video_model.capability != "video":
            raise ValueError("视频输出模型必须具备video能力")
        return self


class ResourceOut(ResourceBody):
    id: UUID
    revision: int


class BindingOut(DTO):
    revision: int
    value: dict | None


class ResolvedResource(ResourceOut):
    binding_revision: int
    source: str


class ResolvedModel(BindingOut):
    source: str


class ResolvedConfiguration(DTO):
    schema_version: int
    interaction_key: str
    model: ResolvedModel
    template: ResolvedResource | None
    method: ResolvedResource | None
    style: ResolvedResource | None
    specification: dict


class PreviewOut(DTO):
    content: str
