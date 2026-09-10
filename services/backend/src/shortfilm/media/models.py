"""Durable provider receipt, sequence dependencies and immutable media outcomes."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class MediaSequence(Identity, Base):
    __tablename__ = "media_sequences"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    paused: Mapped[bool] = mapped_column(default=False)


class MediaRun(Base):
    __tablename__ = "media_runs"
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), primary_key=True)
    sequence_id: Mapped[UUID | None] = mapped_column(ForeignKey("media_sequences.id"), index=True)
    external_id: Mapped[str | None] = mapped_column(String(200))
    submitted: Mapped[bool] = mapped_column(default=False)
    receipt: Mapped[dict | None] = mapped_column(JSONB)
    previous: Mapped[dict | None] = mapped_column(JSONB)
    next_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled: Mapped[bool] = mapped_column(default=False)


class JobDependency(Base):
    __tablename__ = "job_dependencies"
    child_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), primary_key=True)
    parent_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), index=True)


class MediaOutcome(Identity, Base):
    __tablename__ = "media_outcomes"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"), unique=True)
    kind: Mapped[str] = mapped_column(String(30))
    target_id: Mapped[str] = mapped_column(String(100), index=True)
    file_id: Mapped[UUID] = mapped_column(ForeignKey("media_files.id"))
    tail_file_id: Mapped[UUID | None] = mapped_column(ForeignKey("media_files.id"))
    metadata_json: Mapped[dict] = mapped_column(JSONB)
    confirmation_revision: Mapped[int | None]


class LineBinding(Base):
    __tablename__ = "line_bindings"
    line_id: Mapped[UUID] = mapped_column(ForeignKey("content_identities.id"), primary_key=True)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    entity_id: Mapped[UUID | None] = mapped_column(ForeignKey("project_entities.id"))
    revision: Mapped[int] = mapped_column(default=1)


class PreviousFrame(Identity, Base):
    __tablename__ = "previous_frame_bindings"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    shot_id: Mapped[UUID] = mapped_column(ForeignKey("content_identities.id"))
    outcome_id: Mapped[UUID] = mapped_column(ForeignKey("media_outcomes.id"))
    __table_args__ = (UniqueConstraint("shot_id", "outcome_id"),)


class ShotReferenceVersion(Identity, Base):
    __tablename__ = "shot_reference_versions"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    shot_id: Mapped[UUID] = mapped_column(ForeignKey("content_identities.id"))
    # Stable reference may be a pending import descriptor; writes validate project and shot.
    ref_id: Mapped[UUID] = mapped_column()
    entity_id: Mapped[UUID | None] = mapped_column(ForeignKey("project_entities.id"))
    file_id: Mapped[UUID | None] = mapped_column(ForeignKey("media_files.id"))
    revision: Mapped[int]
    __table_args__ = (UniqueConstraint("shot_id", "ref_id", "revision"),)
