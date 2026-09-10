"""Immutable explicitly published asset copies and replayable project adoptions."""
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class LibraryAsset(Identity, Base):
    __tablename__ = "library_assets"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("principals.id"), index=True)
    source_project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"))
    source_entity_id: Mapped[UUID] = mapped_column(ForeignKey("project_entities.id"))
    source_entity_revision: Mapped[int]
    version: Mapped[int] = mapped_column(default=1)
    kind: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    voice: Mapped[str] = mapped_column(String(200))
    three_view: Mapped[bool]
    images: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (CheckConstraint("version = 1"),)


class LibraryAdoption(Identity, Base):
    __tablename__ = "library_adoptions"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    asset_id: Mapped[UUID] = mapped_column(ForeignKey("library_assets.id"))
    library_version: Mapped[int]
    entity_id: Mapped[UUID] = mapped_column(ForeignKey("project_entities.id"))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    fingerprint: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("project_id", "idempotency_key"),)
