from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import Field, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from shortfilm.config_models import Resource
from shortfilm.configuration.schemas import (
    BindingOut,
    BindingUpdate,
    PreviewOut,
    ResolvedConfiguration,
    ResourceCreate,
    ResourceOut,
    ResourceUpdate,
)
from shortfilm.configuration.service import (
    append_resource,
    binding_json,
    latest,
    resolve,
    resource_json,
    save_binding,
)
from shortfilm.db import session
from shortfilm.projects.router import owned_project
from shortfilm.schemas import DTO

router = APIRouter()


def commit(db):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "同类同环节名称已存在") from None


@router.get("/resources", response_model=list[ResourceOut])
def resources(
    kind: str | None = None,
    stage: str | None = None,
    search: str = "",
    db: Session = Depends(session),
):
    rows = db.scalars(select(Resource).order_by(Resource.name)).all()
    result = [
        resource_json(db, r.id)
        for r in rows
        if (not kind or r.kind == kind) and (not stage or r.stage == stage)
    ]
    return [r for r in result if search.casefold() in (r["name"] + r["content"]).casefold()]


@router.post("/resources", status_code=201, response_model=ResourceOut)
def create_resource(body: ResourceCreate, db: Session = Depends(session)):
    try:
        r = append_resource(db, body)
        commit(db)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "同类同环节名称已存在") from None
    return resource_json(db, r.id)


@router.post("/resources/import", status_code=201, response_model=ResourceOut)
async def import_resource(
    name: str = Form(...),
    stage: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(session),
):
    if not file.filename or file.filename.rsplit(".", 1)[-1].lower() not in ("md", "txt"):
        raise HTTPException(422, "仅支持MD/TXT")
    raw = await file.read(131073)
    if len(raw) > 131072:
        raise HTTPException(422, "文件不能超过128KB")
    try:
        body = ResourceCreate(name=name, stage=stage, kind="skill", content=raw.decode("utf-8-sig"))
    except (UnicodeError, ValidationError):
        raise HTTPException(422, "文件必须为非空UTF-8指令文本") from None
    return create_resource(body, db)


@router.get("/resources/{rid}", response_model=ResourceOut)
def get_resource(
    rid: UUID, revision: int | None = Query(None, ge=1), db: Session = Depends(session)
):
    return resource_json(db, rid, revision)


@router.put("/resources/{rid}", response_model=ResourceOut)
def update_resource(rid: UUID, body: ResourceUpdate, db: Session = Depends(session)):
    r = db.scalar(select(Resource).where(Resource.id == rid).with_for_update())
    if not r:
        raise HTTPException(404, "资源不存在")
    if r.revision != body.base_version:
        raise HTTPException(409, "资源已更新，请合并草稿")
    try:
        validated = ResourceCreate(
            kind=r.kind, stage=r.stage, **body.model_dump(exclude={"base_version"})
        )
        append_resource(db, validated, r)
        commit(db)
    except ValidationError:
        raise HTTPException(422, "正文或变量无效") from None
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "同类同环节名称已存在") from None
    return resource_json(db, r.id)


def scope_project(db, scope):
    if scope == "system":
        return None
    try:
        if not scope.startswith("project:"):
            raise ValueError()
        return owned_project(db, UUID(scope[8:]), lock=True)
    except ValueError:
        raise HTTPException(422, "配置作用域无效") from None


@router.get("/bindings/{scope}/{key}", response_model=BindingOut)
def get_binding(scope: str, key: str, db: Session = Depends(session)):
    scope_project(db, scope)
    return binding_json(latest(db, scope, key))


@router.put("/bindings/{scope}/{key}", response_model=BindingOut)
def put_binding(scope: str, key: str, body: BindingUpdate, db: Session = Depends(session)):
    project = scope_project(db, scope)
    if project and (key.startswith("model:") or key == "output"):
        raise HTTPException(422, "项目规格请使用项目规格接口")
    try:
        b = save_binding(db, scope, key, body.base_version, body.value)
    except (ValidationError, ValueError):
        raise HTTPException(422, "配置值无效") from None
    if project:
        from sqlalchemy import func

        project.revision += 1
        project.updated_at = func.now()
    commit(db)
    return binding_json(b)


@router.get("/resolve/{pid}/{key}", response_model=ResolvedConfiguration)
def get_resolved(pid: UUID, key: str, stage: str, db: Session = Depends(session)):
    return resolve(db, owned_project(db, pid), key, stage)


@router.get("/bindings/{scope}/{key}/history", response_model=list[BindingOut])
def binding_history(scope: str, key: str, db: Session = Depends(session)):
    from shortfilm.config_models import Binding

    scope_project(db, scope)
    return [
        binding_json(b)
        for b in db.scalars(
            select(Binding)
            .where(Binding.scope == scope, Binding.key == key)
            .order_by(Binding.revision.desc())
        ).all()
    ]


class Preview(DTO):
    content: str = Field(min_length=1, max_length=131072)
    variables: dict
    required_variables: list[str] = Field(default_factory=list)


@router.post("/preview", response_model=PreviewOut)
def preview(body: Preview):
    from shortfilm.configuration.service import render_template

    return {"content": render_template(body.content, body.variables, body.required_variables)}
