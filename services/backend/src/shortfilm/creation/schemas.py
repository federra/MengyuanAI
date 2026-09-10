from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, ValidationInfo, model_validator

from shortfilm.schemas import DTO


class StoryBody(DTO):
    title: str = Field(min_length=1, max_length=200)
    logline: str = Field(min_length=1, max_length=1000)
    direction: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1, max_length=50000)


class BatchOutput(DTO):
    stories: list[StoryBody] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def distinct(self, info: ValidationInfo):
        expected = (info.context or {}).get("story_count", 3)
        if len(self.stories) != expected:
            raise ValueError(f"故事数量必须恰好为{expected}份")
        for field in ("title", "direction", "text"):
            if len({getattr(s, field).casefold() for s in self.stories}) != len(self.stories):
                raise ValueError("故事的标题、方向和正文必须不同")
        return self


class RevisionOutput(DTO):
    text: str = Field(min_length=1, max_length=50000)
    changeSummary: str = Field(min_length=1, max_length=2000)


class IdeaSave(DTO):
    story_count: int = Field(default=3, strict=True, ge=1, le=3)
    revision: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=10000)


class StorySave(DTO):
    revision: int = Field(ge=1)
    body: StoryBody


class BatchCreate(DTO):
    story_count: int = Field(default=3, strict=True, ge=1, le=3)
    idea_version_id: UUID
    instruction: str = Field(default="", max_length=10000)
    style: str = Field(default="", max_length=2000)
    writing_mode: Literal["prompt", "skill"] = "prompt"


class MessageCreate(DTO):
    base_version_id: UUID
    text: str = Field(min_length=1, max_length=10000)


class SelectStory(DTO):
    version_id: UUID
    selection_revision: int = Field(ge=0)


class RetryJob(DTO):
    confirm_unknown: bool = False


class ContentOut(DTO):
    id: UUID
    kind: str
    revision: int
    version_id: UUID
    body: dict
    batch_id: UUID | None
    source_version_id: UUID | None
    stale: bool = False
    previous_version_id: UUID | None = None


class VersionOut(DTO):
    id: UUID
    revision: int
    body: dict
    source_version_id: UUID | None
    origin: str
    created_at: datetime


class StoriesOut(DTO):
    items: list[ContentOut]
    total: int
    selected_version_id: UUID | None
    selection_revision: int


class MessageOut(DTO):
    id: UUID
    role: str
    text: str
    job_id: UUID
    created_at: datetime


class ProposalOut(DTO):
    id: UUID
    base_version_id: UUID
    output: dict
    applied_version_id: UUID | None
    created_at: datetime


class ConversationOut(DTO):
    messages: list[MessageOut]
    proposals: list[ProposalOut]
