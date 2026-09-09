"""Immutable edit decisions; jobs freeze these decisions and own render results."""

from uuid import UUID

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class EditVersion(Identity, Base):
    __tablename__ = "export_versions"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    revision: Mapped[int]
    draft: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("project_id", "revision"),)


class ExportCommand(Base):
    __tablename__ = "export_commands"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    key: Mapped[str] = mapped_column(primary_key=True)
    fingerprint: Mapped[str]
    job_id: Mapped[UUID] = mapped_column(ForeignKey("generation_jobs.id"))
