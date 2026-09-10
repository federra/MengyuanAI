"""Project elements retain stable identities and append-only creative settings."""

from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class Entity(Identity, Base):
    __tablename__ = "project_entities"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    revision: Mapped[int] = mapped_column(default=1)
    archived: Mapped[bool] = mapped_column(default=False)
    __table_args__ = (
        CheckConstraint("kind in ('character','scene','prop')"),
        CheckConstraint("revision > 0"),
    )


class EntityVersion(Identity, Base):
    __tablename__ = "entity_versions"
    entity_id: Mapped[UUID] = mapped_column(ForeignKey("project_entities.id"), index=True)
    revision: Mapped[int]
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    voice: Mapped[str] = mapped_column(String(200))
    three_view: Mapped[bool] = mapped_column(default=False)
    input_file_id: Mapped[UUID | None] = mapped_column(ForeignKey("media_files.id"))
    output_file_id: Mapped[UUID | None] = mapped_column(ForeignKey("media_files.id"))
    library_asset_id: Mapped[UUID | None]
    library_version: Mapped[int | None]
    __table_args__ = (UniqueConstraint("entity_id", "revision"),)


class ReferenceImage(Identity, Base):
    __tablename__ = "reference_images"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    entity_version_id: Mapped[UUID] = mapped_column(ForeignKey("entity_versions.id"))
    file_id: Mapped[UUID] = mapped_column(ForeignKey("media_files.id"))
    __table_args__ = (UniqueConstraint("entity_version_id", "file_id"),)


class ReferenceConfirmation(Identity, Base):
    __tablename__ = "reference_confirmations"
    image_id: Mapped[UUID] = mapped_column(ForeignKey("reference_images.id"))
    specification_revision: Mapped[int]
    __table_args__ = (UniqueConstraint("image_id", "specification_revision"),)


class EntityCommand(Identity, Base):
    __tablename__ = "entity_commands"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    key: Mapped[str] = mapped_column(String(128))
    fingerprint: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("project_id", "key"),)
