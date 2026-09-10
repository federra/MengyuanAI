from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.assets.models import Entity, EntityVersion


def owned_entity(db, pid, eid, include_archived=False):
    entity = db.scalar(select(Entity).where(Entity.id == eid, Entity.project_id == pid))
    if not entity or (entity.archived and not include_archived):
        raise HTTPException(404, "项目元素不存在")
    return entity


def entity_version(db, entity):
    return db.scalar(
        select(EntityVersion).where(
            EntityVersion.entity_id == entity.id, EntityVersion.revision == entity.revision
        )
    )


def entity_out(entity, version):
    return {
        "id": entity.id,
        "kind": entity.kind,
        "version_id": version.id,
        "revision": version.revision,
        "name": version.name,
        "description": version.description,
        "voice": version.voice,
        "three_view": version.three_view,
        "input_file_id": version.input_file_id,
        "output_file_id": version.output_file_id,
        "library_asset_id": version.library_asset_id,
        "library_version": version.library_version,
    }


def append_entity(db, entity, body):
    version = EntityVersion(
        entity_id=entity.id,
        revision=entity.revision,
        **body.model_dump(exclude={"kind", "revision", "id", "clear_output"}),
    )
    db.add(version)
    db.flush()
    return version
