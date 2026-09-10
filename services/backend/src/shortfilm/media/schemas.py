from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from shortfilm.configuration.schemas import ModelRoute
from shortfilm.schemas import DTO


class ImageGenerate(DTO):
    entity_id: UUID | None = None
    entity_revision: int | None = Field(default=None, ge=1)
    board_version_id: UUID | None = None
    shot_id: UUID | None = None
    reference_file_ids: list[UUID] = Field(default_factory=list, max_length=8)
    instruction: str = Field(default="", max_length=10000)

    @model_validator(mode="after")
    def target(self):
        if self.entity_id:
            if not self.entity_revision or self.shot_id or self.board_version_id:
                raise ValueError("元素生成需指定版本，不能混合镜头目标")
        elif not self.shot_id or not self.board_version_id:
            raise ValueError("站位图需指定镜头与分镜版本")
        return self


class AudioGenerate(DTO):
    board_version_id: UUID
    shot_id: UUID
    line_id: UUID
    speed: float = Field(default=1, ge=0.5, le=2)
    emotion: (
        Literal["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"] | None
    ) = None


class VideoGenerate(DTO):
    board_version_id: UUID
    shot_ids: list[UUID] = Field(min_length=1, max_length=1000)
    sequential: bool = False

    @model_validator(mode="after")
    def unique(self):
        if len(self.shot_ids) != len(set(self.shot_ids)):
            raise ValueError("镜头重复")
        return self


class LineBind(DTO):
    board_version_id: UUID
    entity_id: UUID | None
    revision: int = Field(ge=0)


class LineBindingOut(DTO):
    line_id: UUID
    entity_id: UUID | None
    revision: int
    name: str | None
    voice: str | None


class OutcomeOut(DTO):
    id: UUID
    job_id: UUID
    kind: str
    target_id: str
    file_id: UUID
    tail_file_id: UUID | None
    metadata: dict
    stale: bool
    confirmed: bool
    created_at: datetime


class MediaTaskOut(DTO):
    id: UUID
    kind: str
    state: str
    error: str | None
    target_id: str
    shot_id: str | None
    sequence_id: UUID | None
    paused: bool
    stale: bool
    external_id: str | None
    previous: dict | None
    snapshot: dict
    created_at: datetime


class MediaRetry(DTO):
    confirm_unknown: bool = False


class SequenceControl(DTO):
    paused: bool


class PreviousBind(DTO):
    board_version_id: UUID
    previous_video_version_id: UUID


class ReferenceReplace(DTO):
    board_version_id: UUID
    revision: int = Field(ge=0)
    file_id: UUID


class ShotReferenceOut(DTO):
    shot_id: UUID
    ref_id: UUID
    entity_id: UUID | None = None
    file_id: UUID | None
    revision: int


class ShotOverrides(DTO):
    model: ModelRoute | None = None
    aspect_ratio: Literal["9:16", "16:9", "1:1"] | None = None
    resolution: Literal["720P", "1080P", "4K"] | None = None

    @model_validator(mode="after")
    def video_model(self):
        if self.model and self.model.capability != "video":
            raise ValueError("单镜模型必须具备视频能力")
        return self


class ShotSettingsSave(DTO):
    board_version_id: UUID
    revision: int = Field(ge=0)
    overrides: ShotOverrides


class ShotSettingsOut(DTO):
    shot_id: UUID
    board_version_id: UUID
    revision: int
    overrides: dict
    effective: dict
    sources: dict


class IndependentBatch(DTO):
    board_version_id: UUID
    shot_ids: list[UUID] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def unique(self):
        if len(set(self.shot_ids)) != len(self.shot_ids):
            raise ValueError("镜头重复")
        return self


class BatchItem(DTO):
    shot_id: UUID
    job_id: UUID | None
    reason: str | None


class IndependentBatchOut(DTO):
    batch_id: UUID
    items: list[BatchItem]
