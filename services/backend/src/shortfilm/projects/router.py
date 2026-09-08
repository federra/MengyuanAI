from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.models import Project, ProjectType
from shortfilm.schemas import ProjectCreate, ProjectList, ProjectOut, ProjectPatch

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
    p = Project(**body.model_dump(), owner_id=settings.local_owner_id)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.get("", response_model=ProjectList)
def list_projects(
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(session),
):
    where = Project.owner_id == settings.local_owner_id
    return {
        "items": db.scalars(
            select(Project)
            .where(where)
            .order_by(Project.updated_at.desc(), Project.id)
            .offset(offset)
            .limit(limit)
        ).all(),
        "total": db.scalar(select(func.count()).select_from(Project).where(where)),
    }


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
