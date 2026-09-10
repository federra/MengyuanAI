from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets import strict
from shortfilm.assets.models import Entity, EntityVersion
from shortfilm.assets.schemas import (
    EntityArchiveOut,
    EntityBatch,
    EntityBatchOut,
    EntityBind,
    EntityBindOut,
    EntityChange,
    EntityCreate,
    EntityImages,
    EntityOut,
    EntityUpdate,
)
from shortfilm.assets.service import entity_out, entity_version, owned_entity
from shortfilm.db import session
from shortfilm.jobs.service import now
from shortfilm.projects.router import owned_project
from shortfilm.schemas import DTO, JobOut


class EntityJobsOut(DTO):
    jobs: list[JobOut]


router = APIRouter(prefix="/projects/{pid}/entities", tags=["project-elements"])


@router.get("", response_model=list[EntityOut])
def list_entities(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    entities = db.scalars(
        select(Entity)
        .where(Entity.project_id == pid, Entity.archived.is_(False))
        .order_by(Entity.created_at, Entity.id)
    ).all()
    return [entity_out(e, entity_version(db, e)) for e in entities]


@router.post("", response_model=EntityOut, status_code=201)
def create_entity(pid: UUID, body: EntityCreate, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    entity, version, _, _ = strict.save_one(
        db, project, EntityChange(id=uuid4(), revision=0, **body.model_dump())
    )
    project.updated_at = now()
    result = entity_out(entity, version)
    db.commit()
    return result


@router.put("/batch", response_model=EntityBatchOut)
def save_batch(
    pid: UUID,
    body: EntityBatch,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    return strict.save_batch(db, owned_project(db, pid, lock=True), body, idempotency_key)


@router.post("/image-batches", response_model=EntityJobsOut, status_code=202)
def image_batch(
    pid: UUID,
    body: EntityImages,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    from shortfilm.creation.service import fingerprint
    from shortfilm.media.commands import image_job
    from shortfilm.media.schemas import ImageGenerate

    project = owned_project(db, pid, lock=True)
    request = {"action": "elements.images", **body.model_dump(mode="json")}
    old = strict.replay(db, pid, idempotency_key, request)
    if old is not None:
        return old
    if len({row.entity_id for row in body.items}) != len(body.items):
        raise HTTPException(422, "批量图片目标重复")
    from shortfilm.models import Job

    active_targets = set(
        db.scalars(
            select(Job.snapshot["target_id"].astext).where(
                Job.project_id == pid,
                Job.kind.in_(("image.character", "image.scene", "image.prop")),
                Job.state.in_(
                    ("queued", "running", "waiting_provider", "waiting_dependency", "unknown")
                ),
            )
        )
    )
    if any(str(row.entity_id) in active_targets for row in body.items):
        raise HTTPException(409, "已有元素图片任务处理中，请等待结果或在原任务中恢复，勿重复生成")
    jobs = [
        image_job(
            db,
            project,
            "element-image-" + fingerprint({"key": idempotency_key, "id": str(row.entity_id)}),
            ImageGenerate(**row.model_dump()),
        )
        for row in body.items
    ]
    result = EntityJobsOut(jobs=[JobOut.model_validate(job) for job in jobs]).model_dump(
        mode="json"
    )
    strict.remember(db, pid, idempotency_key, request, result)
    db.commit()
    return result


@router.put("/{eid}", response_model=EntityOut)
def update_entity(pid: UUID, eid: UUID, body: EntityUpdate, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    entity = owned_entity(db, pid, eid)
    previous = entity_version(db, entity)
    value = body.model_dump()
    for field in ("input_file_id", "output_file_id"):
        if field not in body.model_fields_set:
            value[field] = getattr(previous, field)
    entity, latest, before, changed = strict.save_one(db, project, EntityChange(id=eid, **value))
    if changed:
        strict.propagate(
            db, project, strict.current_board(db, pid), {eid: (entity, latest, before)}
        )
    result = entity_out(entity, latest)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return result


@router.post("/{eid}/shot-bindings", response_model=EntityBindOut)
def bind_entity(
    pid: UUID,
    eid: UUID,
    body: EntityBind,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    return strict.bind_entity(db, owned_project(db, pid, lock=True), eid, body, idempotency_key)


@router.delete("/{eid}", response_model=EntityArchiveOut)
def archive_entity(
    pid: UUID, eid: UUID, revision: int = Query(ge=1), db: Session = Depends(session)
):
    return strict.archive(db, owned_project(db, pid, lock=True), eid, revision)


@router.get("/{eid}/versions", response_model=list[EntityOut])
def history(pid: UUID, eid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    entity = owned_entity(db, pid, eid, include_archived=True)
    versions = db.scalars(
        select(EntityVersion)
        .where(EntityVersion.entity_id == eid)
        .order_by(EntityVersion.revision.desc())
    ).all()
    return [entity_out(entity, v) for v in versions]
