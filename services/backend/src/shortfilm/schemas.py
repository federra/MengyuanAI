from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DTO(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=True)


class ProjectCreate(DTO):
    name: str = Field(min_length=1, max_length=50)
    market: Literal["zh", "en"] = "zh"
    type_id: UUID | None = None


class ProjectPatch(DTO):
    name: str = Field(min_length=1, max_length=50)
    revision: int = Field(ge=1)


class ProjectOut(ProjectCreate):
    id: UUID
    revision: int
    stage: str
    status: str
    generation_settings: dict | None
    updated_at: datetime


class ProjectList(DTO):
    items: list[ProjectOut]
    total: int


class FileOut(DTO):
    id: UUID
    project_id: UUID
    filename: str
    mime: str
    size: int
    sha256: str
    created_at: datetime


class JobCreate(DTO):
    kind: Literal["file.verify"]
    file_id: UUID


class JobOut(DTO):
    id: UUID
    project_id: UUID
    kind: str
    state: str
    snapshot: dict
    error: str | None
    created_at: datetime
    updated_at: datetime


class TypeOut(DTO):
    id: UUID
    name: str


class SettingsOut(DTO):
    mode: Literal["local"] = "local"
    milestone: Literal["M0"] = "M0"
    project_types: list[TypeOut]
    prompt_count: int
    max_upload_bytes: int
    enabled_job_kinds: list[str] = ["file.verify"]
