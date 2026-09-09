from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets.models import Entity, EntityVersion
from shortfilm.assets.schemas import EntityCreate, EntityOut, EntityUpdate
from shortfilm.assets.service import append_entity, entity_out, entity_version, owned_entity
from shortfilm.db import session
from shortfilm.jobs.service import now
from shortfilm.projects.router import owned_project

router = APIRouter(prefix="/projects/{pid}/entities", tags=["project-elements"])


@router.get("", response_model=list[EntityOut])
def list_entities(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    entities = db.scalars(
        select(Entity).where(Entity.project_id == pid).order_by(Entity.created_at, Entity.id)
    ).all()
    return [entity_out(e, entity_version(db, e)) for e in entities]


@router.post("", response_model=EntityOut, status_code=201)
def create_entity(pid: UUID, body: EntityCreate, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    entity = Entity(project_id=pid, kind=body.kind)
    db.add(entity)
    db.flush()
    version = append_entity(db, entity, body)
    project.updated_at = now()
    result = entity_out(entity, version)
    db.commit()
    return result


@router.put("/{eid}", response_model=EntityOut)
def update_entity(pid: UUID, eid: UUID, body: EntityUpdate, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    entity = owned_entity(db, pid, eid)
    if entity.revision != body.revision:
        raise HTTPException(409, "元素已更新，请读取最新版本并合并草稿")
    if entity.kind != body.kind:
        raise HTTPException(422, "已有元素不能改变类型")
    previous = entity_version(db, entity)
    if any(
        getattr(previous, field) != getattr(body, field)
        for field in ("name", "description", "voice", "three_view")
    ):
        entity.revision += 1
        previous = append_entity(db, entity, body)
        project.updated_at = now()
    result = entity_out(entity, previous)
    db.commit()
    return result


@router.get("/{eid}/versions", response_model=list[EntityOut])
def history(pid: UUID, eid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    entity = owned_entity(db, pid, eid)
    versions = db.scalars(
        select(EntityVersion)
        .where(EntityVersion.entity_id == eid)
        .order_by(EntityVersion.revision.desc())
    ).all()
    return [entity_out(entity, v) for v in versions]
