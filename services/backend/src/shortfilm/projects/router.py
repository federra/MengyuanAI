from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.configuration.schemas import OutputSpecification
from shortfilm.configuration.service import latest, save_binding, specification, sync_style_binding
from shortfilm.db import session
from shortfilm.models import Job, Project, ProjectType
from shortfilm.schemas import DTO, ProjectCreate, ProjectList, ProjectOut, ProjectPatch, TypeOut

router = APIRouter(prefix="/projects", tags=["projects"])


def owned_project(db: Session, pid: UUID, lock=False):
    query = select(Project).where(Project.id == pid, Project.owner_id == settings.local_owner_id)
    if lock:
        query = query.with_for_update()
    p = db.scalar(query)
    if not p:
        raise HTTPException(404, "项目不存在")
    return p


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectCreate, db: Session = Depends(session)):
    if body.type_id and not db.get(ProjectType, body.type_id):
        raise HTTPException(422, "项目类型不存在")
    defaults = latest(db, "system", "output")
    values = dict(defaults.value if defaults and defaults.value else {})
    for key in ("aspect_ratio", "resolution", "style_resource_id"):
        value = getattr(body, key)
        if value is not None:
            values[key] = str(value)
    spec = specification(values)
    p = Project(
        **body.model_dump(exclude={"aspect_ratio", "resolution", "style_resource_id"}),
        owner_id=settings.local_owner_id,
        generation_settings=spec,
    )
    db.add(p)
    db.flush()
    save_binding(
        db,
        "project:" + str(p.id),
        "output",
        0,
        OutputSpecification.model_validate(values).model_dump(mode="json"),
    )
    sync_style_binding(db, p, spec.get("style_resource_id"))
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.get("", response_model=ProjectList)
def list_projects(
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    status: Literal["in_progress", "completed"] | None = None,
    sort: Literal["updated_desc", "updated_asc", "name"] = "updated_desc",
    db: Session = Depends(session),
):
    where = Project.owner_id == settings.local_owner_id
    if status:
        where = where & (Project.status == status)
    ordering = {
        "updated_desc": Project.updated_at.desc(),
        "updated_asc": Project.updated_at.asc(),
        "name": Project.name.asc(),
    }[sort]
    return {
        "items": db.scalars(
            select(Project).where(where).order_by(ordering, Project.id).offset(offset).limit(limit)
        ).all(),
        "total": db.scalar(select(func.count()).select_from(Project).where(where)),
    }


class TypeCreate(DTO):
    name: str = Field(min_length=1, max_length=50)


@router.post("/types", response_model=TypeOut, status_code=201)
def add_type(body: TypeCreate, db: Session = Depends(session)):
    row = ProjectType(name=body.name)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "项目类型已存在") from None
    db.refresh(row)
    return row


@router.get("/statistics")
def statistics(db: Session = Depends(session)):
    owned = Project.owner_id == settings.local_owner_id
    return {
        "total": db.scalar(select(func.count()).select_from(Project).where(owned)),
        "in_progress": db.scalar(
            select(func.count()).select_from(Project).where(owned, Project.status == "in_progress")
        ),
        "completed": db.scalar(
            select(func.count()).select_from(Project).where(owned, Project.status == "completed")
        ),
        "failed_jobs": db.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.owner_id == settings.local_owner_id, Job.state == "failed")
        ),
    }


class SpecificationUpdate(OutputSpecification):
    base_version: int = Field(ge=1)


@router.put("/{pid}/specification", response_model=ProjectOut)
def update_specification(pid: UUID, body: SpecificationUpdate, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    current = p.generation_settings or {}
    if current.get("revision", 1) != body.base_version:
        raise HTTPException(409, "项目规格已更新")
    value = body.model_dump(mode="json", exclude={"base_version"})
    prior = latest(db, "project:" + str(pid), "output")
    save_binding(db, "project:" + str(pid), "output", prior.revision if prior else 0, value)
    sync_style_binding(db, p, value.get("style_resource_id"))
    p.generation_settings = {
        **specification(value, body.base_version + 1),
        "media_needs_review": True,
    }
    p.revision += 1
    p.updated_at = func.now()
    p.status = "in_progress"
    db.commit()
    db.refresh(p)
    return p


@router.get("/{pid}", response_model=ProjectOut)
def get_project(pid: UUID, db: Session = Depends(session)):
    return owned_project(db, pid)


@router.patch("/{pid}", response_model=ProjectOut)
def edit_project(pid: UUID, body: ProjectPatch, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    if p.revision != body.revision:
        raise HTTPException(409, "项目已更新，请重新载入后合并草稿")
    p.name, p.revision, p.updated_at = body.name, p.revision + 1, func.now()
    db.commit()
    db.refresh(p)
    return p
