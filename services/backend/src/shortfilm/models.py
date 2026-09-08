from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Identity:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Principal(Identity, Base):
    __tablename__ = "principals"
    name: Mapped[str] = mapped_column(String(100))


class ProjectType(Identity, Base):
    __tablename__ = "project_types"
    name: Mapped[str] = mapped_column(String(50), unique=True)


class Project(Identity, Base):
    __tablename__ = "projects"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("principals.id"))
    name: Mapped[str] = mapped_column(String(50))
    type_id: Mapped[UUID | None] = mapped_column(ForeignKey("project_types.id"))
    market: Mapped[str] = mapped_column(String(2), default="zh")
    stage: Mapped[str] = mapped_column(String(20), default="idea")
    status: Mapped[str] = mapped_column(String(20), default="in_progress")
    revision: Mapped[int] = mapped_column(default=1)
    generation_settings: Mapped[dict | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        CheckConstraint("market in ('zh','en')"),
        CheckConstraint("revision > 0"),
        Index("ix_projects_owner_updated", "owner_id", "updated_at", "id"),
    )


class MediaFile(Identity, Base):
    __tablename__ = "media_files"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    object_key: Mapped[str] = mapped_column(String(300), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int]
    sha256: Mapped[str] = mapped_column(String(64))


class PromptVersion(Identity, Base):
    __tablename__ = "prompt_versions"
    interaction_key: Mapped[str] = mapped_column(String(100))
    revision: Mapped[int] = mapped_column(default=1)
    template: Mapped[str] = mapped_column(Text)
    specification: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("interaction_key", "revision"),)


class Job(Identity, Base):
    __tablename__ = "generation_jobs"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("principals.id"))
    kind: Mapped[str] = mapped_column(String(50))
    state: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128))
    source_fingerprint: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    lease_token: Mapped[UUID | None]
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(200))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("owner_id", "project_id", "idempotency_key"),)


class Outbox(Base):
    __tablename__ = "outbox"
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), primary_key=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobAttempt(Identity, Base):
    __tablename__ = "job_attempts"
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), index=True)
    token: Mapped[UUID] = mapped_column(unique=True)
    state: Mapped[str] = mapped_column(String(30), default="running")
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    provider_calls: Mapped[list | None] = mapped_column(JSONB)


class JobEvent(Identity, Base):
    __tablename__ = "job_events"
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), index=True)
    state: Mapped[str] = mapped_column(String(30))


class JobResult(Base):
    __tablename__ = "job_results"
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), primary_key=True)
    output: Mapped[dict] = mapped_column(JSONB)


class ContentItem(Identity, Base):
    __tablename__ = "content_items"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    batch_id: Mapped[UUID | None] = mapped_column(ForeignKey("generation_jobs.id"))
    revision: Mapped[int] = mapped_column(default=0)
    __table_args__ = (
        Index("uq_project_idea", "project_id", unique=True, postgresql_where=(kind == "idea")),
    )


class ContentVersion(Identity, Base):
    __tablename__ = "content_versions"
    item_id: Mapped[UUID] = mapped_column(ForeignKey("content_items.id"), index=True)
    revision: Mapped[int]
    body: Mapped[dict] = mapped_column(JSONB)
    source_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("content_versions.id"))
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("generation_jobs.id"))
    origin: Mapped[str] = mapped_column(String(20))
    __table_args__ = (UniqueConstraint("item_id", "revision"), CheckConstraint("revision > 0"))


class StorySelection(Identity, Base):
    __tablename__ = "story_selections"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    revision: Mapped[int]
    version_id: Mapped[UUID | None] = mapped_column(ForeignKey("content_versions.id"))
    __table_args__ = (UniqueConstraint("project_id", "revision"),)


class Message(Identity, Base):
    __tablename__ = "messages"
    item_id: Mapped[UUID] = mapped_column(ForeignKey("content_items.id"), index=True)
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"))
    role: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("job_id", "role"),)


class Proposal(Identity, Base):
    __tablename__ = "proposals"
    item_id: Mapped[UUID] = mapped_column(ForeignKey("content_items.id"), index=True)
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), unique=True)
    base_version_id: Mapped[UUID] = mapped_column(ForeignKey("content_versions.id"))
    output: Mapped[dict] = mapped_column(JSONB)
    applied_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("content_versions.id"))
