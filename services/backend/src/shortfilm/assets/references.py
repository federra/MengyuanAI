"""Human reference confirmation remains separate from uploaded immutable files."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets.models import Entity, EntityVersion, ReferenceConfirmation, ReferenceImage
from shortfilm.assets.schemas import ReferenceConfirm, ReferenceCreate, ReferenceOut
from shortfilm.assets.service import entity_version, owned_entity
from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.media.router import owned_file
from shortfilm.media.storage import LocalStorage
from shortfilm.models import MediaFile
from shortfilm.projects.router import owned_project

router = APIRouter(prefix="/projects/{pid}/reference-images", tags=["reference-images"])


def image_out(db, project, image):
    source = db.get(EntityVersion, image.entity_version_id)
    entity = db.get(Entity, source.entity_id)
    current = entity_version(db, entity)
    # A rename or voice change does not invalidate the visual depiction.
    stale = entity.archived or any(
        getattr(source, key) != getattr(current, key) for key in ("description", "three_view", "input_file_id")
    )
    media = db.get(MediaFile, image.file_id)
    readable = LocalStorage(settings.storage_root).path(media.object_key).is_file()
    confirmed = db.scalar(
        select(ReferenceConfirmation).where(
            ReferenceConfirmation.image_id == image.id,
            ReferenceConfirmation.specification_revision == project.generation_settings["revision"],
        )
    )
    return dict(
        id=image.id,
        entity_id=entity.id,
        entity_version_id=source.id,
        file_id=image.file_id,
        kind=entity.kind,
        name=current.name,
        stale=stale or not readable,
        confirmed=bool(confirmed) and not stale and readable,
    )


@router.get("", response_model=list[ReferenceOut])
def list_images(pid: UUID, db: Session = Depends(session)):
    project = owned_project(db, pid)
    images = db.scalars(
        select(ReferenceImage)
        .where(ReferenceImage.project_id == pid)
        .order_by(ReferenceImage.created_at.desc(), ReferenceImage.id)
    ).all()
    return [image_out(db, project, image) for image in images]


@router.post("", response_model=ReferenceOut, status_code=201)
def attach_image(pid: UUID, body: ReferenceCreate, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    entity = owned_entity(db, pid, body.entity_id)
    if entity.revision != body.entity_revision:
        raise HTTPException(409, "元素已更新，请读取最新版本")
    file = owned_file(db, pid, body.file_id)
    if not file.mime.startswith("image/"):
        raise HTTPException(422, "参考素材必须是有效图片")
    if not LocalStorage(settings.storage_root).path(file.object_key).is_file():
        raise HTTPException(409, "图片文件缺失")
    version = entity_version(db, entity)
    image = db.scalar(
        select(ReferenceImage).where(
            ReferenceImage.entity_version_id == version.id, ReferenceImage.file_id == file.id
        )
    )
    if not image:
        image = ReferenceImage(project_id=pid, entity_version_id=version.id, file_id=file.id)
        db.add(image)
        db.flush()
    result = image_out(db, project, image)
    from shortfilm.finishing.service import invalidate_completed
    invalidate_completed(db, pid)
    db.commit()
    return result


@router.post("/{image_id}/confirm", response_model=ReferenceOut)
def confirm_image(
    pid: UUID, image_id: UUID, body: ReferenceConfirm, db: Session = Depends(session)
):
    project = owned_project(db, pid, lock=True)
    image = db.scalar(
        select(ReferenceImage).where(
            ReferenceImage.id == image_id, ReferenceImage.project_id == pid
        )
    )
    if not image:
        raise HTTPException(404, "参考图不存在")
    if project.generation_settings["revision"] != body.specification_revision:
        raise HTTPException(409, "项目规格已变化，请重新检查参考图")
    result = image_out(db, project, image)
    if result["stale"]:
        raise HTTPException(409, "参考图来源已变化或文件缺失，请更新图片")
    if not result["confirmed"]:
        db.add(
            ReferenceConfirmation(
                image_id=image.id, specification_revision=body.specification_revision
            )
        )
        db.flush()
    result = image_out(db, project, image)
    from shortfilm.finishing.service import invalidate_completed
    invalidate_completed(db, pid)
    db.commit()
    return result
