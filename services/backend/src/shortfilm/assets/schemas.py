from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from shortfilm.schemas import DTO


class EntityCreate(DTO):
    kind: Literal["character", "scene", "prop"]
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=10000)
    voice: str = Field(default="", max_length=200)
    three_view: bool = False
    input_file_id: UUID | None = None
    output_file_id: UUID | None = None

    @model_validator(mode="after")
    def character_options(self):
        if self.kind != "character" and (self.voice or self.three_view):
            raise ValueError("只有角色可设置音色与三视图")
        return self


class EntityUpdate(EntityCreate):
    revision: int = Field(ge=1)


class EntityOut(EntityCreate):
    library_asset_id: UUID | None = None
    library_version: int | None = None
    id: UUID
    version_id: UUID
    revision: int


class ReferenceCreate(DTO):
    entity_id: UUID
    entity_revision: int = Field(ge=1)
    file_id: UUID


class ReferenceConfirm(DTO):
    specification_revision: int = Field(ge=1)


class ReferenceOut(DTO):
    id: UUID
    entity_id: UUID
    entity_version_id: UUID
    file_id: UUID
    kind: str
    name: str
    stale: bool
    confirmed: bool


class EntityChange(EntityCreate):
    clear_output: bool = False
    id: UUID
    revision: int = Field(ge=0)


class EntityBatch(DTO):
    base_board_version_id: UUID | None = None
    items: list[EntityChange] = Field(min_length=1, max_length=300)


class EntityBatchOut(DTO):
    entities: list[EntityOut]
    board_version_id: UUID | None
    affected_shot_ids: list[UUID]


class EntityBind(DTO):
    entity_revision: int = Field(ge=1)
    board_version_id: UUID
    shot_id: UUID
    mode: Literal["add", "replace"]


class EntityBindOut(DTO):
    board_version_id: UUID
    ref_id: UUID
    affected_shot_ids: list[UUID]


class EntityImageItem(DTO):
    entity_id: UUID
    entity_revision: int = Field(ge=1)
    instruction: str = Field(default="", max_length=10000)


class EntityImages(DTO):
    items: list[EntityImageItem] = Field(min_length=1, max_length=300)


class EntityArchiveOut(DTO):
    id: UUID
    archived: bool
