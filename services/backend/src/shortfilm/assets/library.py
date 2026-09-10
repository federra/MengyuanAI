"""Library assets are immutable opt-in copies, never cross-project file aliases."""

import hashlib
import json
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets.library_models import LibraryAdoption, LibraryAsset
from shortfilm.assets.models import Entity, ReferenceImage
from shortfilm.assets.schemas import EntityCreate, EntityOut
from shortfilm.assets.service import append_entity, entity_out, entity_version, owned_entity
from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.jobs.service import now
from shortfilm.media.router import owned_file
from shortfilm.media.storage import LocalStorage
from shortfilm.models import MediaFile
from shortfilm.projects.router import owned_project
from shortfilm.schemas import DTO

router = APIRouter(tags=["asset-library"])


class SnapshotCreate(DTO):
    entity_revision: int = Field(ge=1)


class AdoptionCreate(DTO):
    library_version: int = Field(ge=1)
    id: UUID


class LibraryImageOut(DTO):
    id: UUID
    filename: str
    mime: str
    size: int
    sha256: str
    url: str


class LibraryOut(DTO):
    id: UUID
    version: int
    kind: Literal["character", "scene", "prop"]
    name: str
    description: str
    voice: str
    three_view: bool
    source_project_id: UUID
    source_entity_id: UUID
    source_entity_revision: int
    input_image: LibraryImageOut | None
    output_image: LibraryImageOut | None
    created_at: datetime


def owned_asset(db, aid):
    asset = db.scalar(
        select(LibraryAsset).where(
            LibraryAsset.id == aid,
            LibraryAsset.owner_id == settings.local_owner_id,
        )
    )
    if not asset:
        raise HTTPException(404, "资产库快照不存在")
    return asset


def public_asset(asset):
    def image(role):
        value = asset.images.get(role)
        if not value:
            return None
        return {key: value[key] for key in ("id", "filename", "mime", "size", "sha256")} | {
            "url": f"/api/v1/library/assets/{asset.id}/images/{value['id']}"
        }

    return {
        key: getattr(asset, key)
        for key in (
            "id",
            "version",
            "kind",
            "name",
            "description",
            "voice",
            "three_view",
            "source_project_id",
            "source_entity_id",
            "source_entity_revision",
            "created_at",
        )
    } | {"input_image": image("input"), "output_image": image("output")}


def verified_bytes(storage, value):
    try:
        raw = storage.read(value["object_key"])
    except OSError:
        raise HTTPException(409, "图片文件缺失，请恢复文件后重试") from None
    if len(raw) != value["size"] or hashlib.sha256(raw).hexdigest() != value["sha256"]:
        raise HTTPException(409, "图片文件校验失败，请恢复文件后重试")
    return raw


@router.get("/library/assets", response_model=list[LibraryOut])
def list_library(db: Session = Depends(session)):
    rows = db.scalars(
        select(LibraryAsset)
        .where(
            LibraryAsset.owner_id == settings.local_owner_id,
        )
        .order_by(LibraryAsset.created_at.desc(), LibraryAsset.id)
    ).all()
    return [public_asset(row) for row in rows]


@router.get("/library/assets/{aid}/images/{image_id}")
def preview(aid: UUID, image_id: UUID, db: Session = Depends(session)):
    asset = owned_asset(db, aid)
    image = next((v for v in asset.images.values() if v and v["id"] == str(image_id)), None)
    if not image:
        raise HTTPException(404, "快照图片不存在")
    storage = LocalStorage(settings.storage_root)
    verified_bytes(storage, image)
    return FileResponse(
        storage.path(image["object_key"]),
        media_type=image["mime"],
        filename=image["filename"],
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.post(
    "/projects/{pid}/entities/{eid}/library-snapshots", response_model=LibraryOut, status_code=201
)
def create_snapshot(
    pid: UUID,
    eid: UUID,
    body: SnapshotCreate,
    idempotency_key: str | None = Header(default=None, min_length=1, max_length=128),
    db: Session = Depends(session),
):
    from shortfilm.assets.strict import remember, replay

    owned_project(db, pid, lock=True)
    request = {"action": "library.snapshot", "entity_id": str(eid), **body.model_dump(mode="json")}
    if idempotency_key:
        prior = replay(db, pid, idempotency_key, request)
        if prior is not None:
            return prior
    entity = owned_entity(db, pid, eid)
    if entity.revision != body.entity_revision:
        raise HTTPException(409, "元素已更新，请读取最新版本再存入资产库")
    version = entity_version(db, entity)
    aid = uuid4()
    storage, written, images = LocalStorage(settings.storage_root), [], {}
    try:
        for role in ("input", "output"):
            fid = getattr(version, role + "_file_id")
            if not fid:
                images[role] = None
                continue
            file = owned_file(db, pid, fid)
            if file.mime not in ("image/png", "image/jpeg", "image/webp"):
                raise HTTPException(422, "资产快照只支持PNG、JPEG、WebP图片")
            metadata = {
                key: getattr(file, key)
                for key in (
                    "filename",
                    "mime",
                    "size",
                    "sha256",
                    "object_key",
                )
            }
            raw = verified_bytes(storage, metadata)
            image_id = uuid4()
            key = f"library/{aid}/{image_id}"
            storage.put(key, raw)
            written.append(key)
            images[role] = metadata | {"id": str(image_id), "object_key": key}
        asset = LibraryAsset(
            id=aid,
            owner_id=settings.local_owner_id,
            source_project_id=pid,
            source_entity_id=eid,
            source_entity_revision=entity.revision,
            version=1,
            kind=entity.kind,
            images=images,
            **{
                key: getattr(version, key)
                for key in (
                    "name",
                    "description",
                    "voice",
                    "three_view",
                )
            },
        )
        db.add(asset)
        db.flush()
        result = LibraryOut.model_validate(public_asset(asset)).model_dump(mode="json")
        if idempotency_key:
            remember(db, pid, idempotency_key, request, result)
        db.commit()
        return result
    except Exception:
        db.rollback()
        for key in written:
            storage.path(key).unlink(missing_ok=True)
        raise


@router.post(
    "/projects/{pid}/library-assets/{aid}/adoptions", response_model=EntityOut, status_code=201
)
def adopt(
    pid: UUID,
    aid: UUID,
    body: AdoptionCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    asset = owned_asset(db, aid)
    fingerprint = hashlib.sha256(
        json.dumps({"asset": str(aid), **body.model_dump(mode="json")}, sort_keys=True).encode()
    ).hexdigest()
    prior = db.scalar(
        select(LibraryAdoption).where(
            LibraryAdoption.project_id == pid,
            LibraryAdoption.idempotency_key == idempotency_key,
        )
    )
    if prior:
        if prior.fingerprint != fingerprint:
            raise HTTPException(409, "重复请求参数不一致")
        return prior.response
    if asset.version != body.library_version:
        raise HTTPException(409, "资产库版本不匹配，请重新选择")
    if db.get(Entity, body.id):
        raise HTTPException(409, "元素ID已存在，请刷新后重试")
    storage, written, files = LocalStorage(settings.storage_root), [], {}
    try:
        for role in ("input", "output"):
            image = asset.images.get(role)
            files[role + "_file_id"] = None
            if not image:
                continue
            raw = verified_bytes(storage, image)
            fid = uuid4()
            key = f"projects/{pid}/{fid}"
            storage.put(key, raw)
            written.append(key)
            db.add(
                MediaFile(
                    id=fid,
                    project_id=pid,
                    object_key=key,
                    **{key: image[key] for key in ("filename", "mime", "size", "sha256")},
                )
            )
            files[role + "_file_id"] = fid
        db.flush()
        entity = Entity(id=body.id, project_id=pid, kind=asset.kind, revision=1)
        db.add(entity)
        db.flush()
        created = EntityCreate(
            kind=asset.kind,
            **files,
            **{key: getattr(asset, key) for key in ("name", "description", "voice", "three_view")},
        )
        version = append_entity(db, entity, created)
        version.library_asset_id, version.library_version = aid, asset.version
        if files["output_file_id"]:
            db.add(
                ReferenceImage(
                    project_id=pid, entity_version_id=version.id, file_id=files["output_file_id"]
                )
            )
        result = EntityOut.model_validate(entity_out(entity, version)).model_dump(mode="json")
        db.add(
            LibraryAdoption(
                project_id=pid,
                asset_id=aid,
                library_version=asset.version,
                entity_id=entity.id,
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                response=result,
            )
        )
        project.updated_at = now()
        from shortfilm.finishing.service import invalidate_completed

        invalidate_completed(db, pid)
        db.commit()
        return result
    except Exception:
        db.rollback()
        for key in written:
            storage.path(key).unlink(missing_ok=True)
        raise
