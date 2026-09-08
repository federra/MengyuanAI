import hashlib
import io
import warnings
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.media.storage import LocalStorage
from shortfilm.models import MediaFile
from shortfilm.projects.router import owned_project
from shortfilm.schemas import FileOut

router = APIRouter(prefix="/projects/{pid}/files", tags=["files"])


def owned_file(db, pid, fid):
    owned_project(db, pid)
    f = db.scalar(select(MediaFile).where(MediaFile.id == fid, MediaFile.project_id == pid))
    if not f:
        raise HTTPException(404, "文件不存在")
    return f


@router.get("", response_model=list[FileOut])
def list_files(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return db.scalars(
        select(MediaFile).where(MediaFile.project_id == pid).order_by(MediaFile.created_at.desc())
    ).all()


@router.post("", response_model=FileOut, status_code=201)
def upload(pid: UUID, file: UploadFile, db: Session = Depends(session)):
    owned_project(db, pid)
    raw = file.file.read(settings.max_upload_bytes + 1)
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(413, "文件超过大小限制")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as img:
                fmt = img.format
                if fmt not in ("PNG", "JPEG", "WEBP"):
                    raise ValueError("unsupported")
                img.verify()
            with Image.open(io.BytesIO(raw)) as img:
                img.load()
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        raise HTTPException(422, "请上传有效的 PNG、JPEG 或 WebP 图片") from None
    fid = uuid4()
    key = f"projects/{pid}/{fid}"
    storage = LocalStorage(settings.storage_root)
    storage.put(key, raw)
    f = MediaFile(
        id=fid,
        project_id=pid,
        object_key=key,
        filename=Path(file.filename or "image").name[:255],
        mime=Image.MIME[fmt],
        size=len(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
    )
    db.add(f)
    try:
        db.commit()
    except Exception:
        storage.path(key).unlink(missing_ok=True)
        raise
    db.refresh(f)
    return f


@router.get("/{fid}")
def download(pid: UUID, fid: UUID, db: Session = Depends(session)):
    f = owned_file(db, pid, fid)
    path = LocalStorage(settings.storage_root).path(f.object_key)
    if not path.is_file():
        raise HTTPException(404, "文件缺失，请从备份恢复")
    return FileResponse(
        path,
        media_type=f.mime,
        filename=f.filename,
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff"},
    )
