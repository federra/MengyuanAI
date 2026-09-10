"""Persistent previews and pending image descriptions; never manufacture media files."""

from uuid import UUID

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from shortfilm.models import Base, Identity


class BoardImportPreview(Identity, Base):
    __tablename__ = "board_import_previews"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    source_version_id: Mapped[UUID] = mapped_column(ForeignKey("content_versions.id"))
    base_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("content_versions.id"))
    content_hash: Mapped[str] = mapped_column(String(64))
    package: Mapped[dict] = mapped_column(JSONB)
    overrides: Mapped[dict] = mapped_column(JSONB)
    result: Mapped[dict | None] = mapped_column(JSONB)


class BoardImportCommit(Identity, Base):
    __tablename__ = "board_import_commits"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    preview_id: Mapped[UUID] = mapped_column(ForeignKey("board_import_previews.id"))
    key: Mapped[str] = mapped_column(String(128))
    fingerprint: Mapped[str] = mapped_column(String(64))
    __table_args__ = (UniqueConstraint("project_id", "key"),)


class BoardImportAsset(Identity, Base):
    __tablename__ = "board_import_assets"
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id"), index=True)
    board_version_id: Mapped[UUID] = mapped_column(ForeignKey("content_versions.id"))
    shot_id: Mapped[UUID] = mapped_column(ForeignKey("content_identities.id"), index=True)
    entity_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("entity_versions.id"))
    kind: Mapped[str] = mapped_column(String(10))
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)


def pending_reference(db, project_id, shot_id, ref_id):
    try:
        ref_uuid, shot_uuid = UUID(str(ref_id)), UUID(str(shot_id))
    except ValueError:
        return None
    row = db.get(BoardImportAsset, ref_uuid)
    return row if row and row.project_id == project_id and row.shot_id == shot_uuid else None


def has_pending_references(db, project_id, shot_id):
    from shortfilm.creation.service import current_version
    from shortfilm.creation.stage_service import stage_item
    from shortfilm.media.sources import reference_version

    item = stage_item(db, project_id, "board")
    version = current_version(db, item) if item and item.revision else None
    shot = (
        next((s for s in version.body["shots"] if s["id"] == str(shot_id)), None)
        if version
        else None
    )
    refs = {UUID(ref) for group in shot["refs"].values() for ref in group} if shot else set()
    if not refs:
        return False
    rows = db.scalars(
        select(BoardImportAsset).where(
            BoardImportAsset.project_id == project_id,
            BoardImportAsset.shot_id == UUID(str(shot_id)),
            BoardImportAsset.id.in_(refs),
        )
    )
    return any(reference_version(db, shot_id, row.id) is None for row in rows)
