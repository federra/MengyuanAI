from typing import Literal
from uuid import UUID

from pydantic import Field

from shortfilm.schemas import DTO


class LineTiming(DTO):
    line_id: UUID
    start: float = Field(ge=0, le=36000, allow_inf_nan=False)


class Clip(DTO):
    shot_id: UUID
    video_id: UUID | None = None
    trim_start: float = Field(default=0, ge=0, le=36000, allow_inf_nan=False)
    duration: float = Field(gt=0, le=600, allow_inf_nan=False)
    lines: list[LineTiming] = Field(default_factory=list, max_length=100)


class EditDraft(DTO):
    board_version_id: UUID | None = None
    filename: str = Field(
        default="我的作品", min_length=1, max_length=100, pattern=r"^[^/\\\x00-\x1f]+$"
    )
    clips: list[Clip] = Field(default_factory=list, max_length=200)
    fps: Literal[24, 25, 30] = 24
    fit: Literal["pad", "crop"] = "pad"
    narration: bool = True
    subtitles: bool = True
    original_audio: bool = False
    voice_volume: float = Field(default=1, ge=0.1, le=2, allow_inf_nan=False)
    original_volume: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False)
    music_file_id: UUID | None = None
    music_volume: float = Field(default=0.15, ge=0, le=1, allow_inf_nan=False)
    continuity_ack: bool = False


class EditSave(DTO):
    revision: int = Field(ge=0)
    draft: EditDraft


class ExportCreate(DTO):
    revision: int = Field(ge=1)


class EditState(DTO):
    revision: int
    draft: EditDraft
    specification: dict
    blockers: list[str]
    timeline: list[dict]
    exports: list[dict]
