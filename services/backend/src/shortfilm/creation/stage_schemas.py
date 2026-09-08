from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from shortfilm.creation.schemas import ContentOut, StoryBody
from shortfilm.schemas import DTO


class ScriptDialogue(DTO):
    speaker: str = Field(min_length=1)
    emotion: str = ""
    text: str = Field(min_length=1)


class Scene(DTO):
    id: str = Field(min_length=1)
    heading: str = Field(min_length=1)
    actions: list[str] = Field(default_factory=list)
    dialogues: list[ScriptDialogue] = Field(default_factory=list)


class ScriptBody(DTO):
    text: str = Field(min_length=1, max_length=100000)
    scenes: list[Scene] = Field(min_length=1, max_length=500)
    estimatedSeconds: float = Field(gt=0, le=36000)


class Dialogue(DTO):
    id: str = Field(min_length=1, max_length=100)
    speaker: str = ""
    emotion: str = ""
    text: str = ""
    voice: str = ""


class References(DTO):
    characters: list[UUID] = Field(default_factory=list)
    scenes: list[UUID] = Field(default_factory=list)
    props: list[UUID] = Field(default_factory=list)
    positions: list[UUID] = Field(default_factory=list)


class Shot(DTO):
    id: str = Field(min_length=1, max_length=100)
    dialogue: str
    dialogues: list[Dialogue] = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=10000)
    refs: References
    duration: float = Field(gt=0, le=600)


class BoardBody(DTO):
    schemaVersion: Literal[2]
    scriptId: UUID
    shots: list[Shot] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def consistency(self):
        shots = [s.id for s in self.shots]
        lines = [line.id for s in self.shots for line in s.dialogues]
        if len(set(shots + lines)) != len(shots + lines):
            raise ValueError("镜头和台词ID不得重复")
        for shot in self.shots:
            if shot.dialogue != "\n".join(line.text for line in shot.dialogues).strip():
                raise ValueError("台词摘要必须与逐段正文一致")
        return self


class BodyProposal(DTO):
    body: ScriptBody | BoardBody | StoryBody
    changeSummary: str = Field(min_length=1, max_length=2000)
    resolvedIssueIds: list[str] = Field(default_factory=list)


class Issue(DTO):
    id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    evidence: str = Field(min_length=1)
    suggestion: str = Field(min_length=1)
    shotId: str | None = None
    lineId: str | None = None


class ReviewOutput(DTO):
    summary: str = Field(min_length=1, max_length=10000)
    issues: list[Issue] = Field(max_length=500)

    @model_validator(mode="after")
    def distinct(self):
        if len({i.id for i in self.issues}) != len(self.issues):
            raise ValueError("问题ID不得重复")
        return self


class BoardReviewOutput(ReviewOutput):
    schemaVersion: Literal[2]
    scriptId: UUID
    baseBoardVersion: int = Field(ge=1)
    proposedShots: list[Shot] = Field(min_length=1, max_length=1000)


class StageGenerate(DTO):
    source_version_id: UUID
    target_revision: int = Field(ge=0)
    instruction: str = Field(default="", max_length=10000)


class StageSave(DTO):
    revision: int = Field(ge=0)
    source_version_id: UUID
    body: ScriptBody | BoardBody


class ReviewCreate(DTO):
    base_version_id: UUID


class RepairCreate(ReviewCreate):
    report_id: UUID
    text: str = Field(default="", max_length=10000)


class ConfirmCreate(DTO):
    version_id: UUID


class ReportOut(DTO):
    id: UUID
    version_id: UUID
    source_version_id: UUID | None
    job_id: UUID | None
    state: str
    output: dict | None
    error: str | None
    stale: bool
    created_at: datetime


class ConfirmationOut(DTO):
    id: UUID
    version_id: UUID
    source_version_id: UUID | None
    decision: str
    report_id: UUID | None
    report_state: str
    created_at: datetime


class StageOut(DTO):
    item: ContentOut | None
    confirmation: ConfirmationOut | None
    reports: list[ReportOut]
