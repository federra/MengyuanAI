import hashlib
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.creation.service import enqueue, existing_job, fingerprint
from shortfilm.db import session
from shortfilm.finishing import service
from shortfilm.finishing.models import EditVersion, ExportCommand
from shortfilm.finishing.schemas import EditSave, EditState, ExportCreate
from shortfilm.jobs.service import now
from shortfilm.media.processing import inspect_media
from shortfilm.media.router import owned_file
from shortfilm.media.storage import LocalStorage
from shortfilm.models import Job, JobResult, MediaFile
from shortfilm.projects.router import owned_project
from shortfilm.schemas import FileOut, JobOut

router = APIRouter(prefix="/projects/{pid}", tags=["finishing"])


@router.get("/finishing", response_model=EditState)
def get_state(pid: UUID, db: Session = Depends(session)):
    return service.state(db, owned_project(db, pid))


@router.get("/finishing/defaults", response_model=EditState)
def defaults(pid: UUID, db: Session = Depends(session)):
    p = owned_project(db, pid)
    result = service.state(db, p)
    result["draft"] = service.default_draft(db, p)
    return result


@router.put("/finishing", response_model=EditState)
def save(pid: UUID, body: EditSave, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    previous = service.latest_edit(db, pid)
    draft = body.draft.model_dump(mode="json")
    # Lost response is safe to replay without creating an extra revision.
    if previous and previous.revision == body.revision + 1 and previous.draft == draft:
        return service.state(db, p)
    if (previous.revision if previous else 0) != body.revision:
        raise HTTPException(409, "剪辑已更新，请载入最新版本并合并草稿")
    if draft["music_file_id"]:
        service.file_ref(db, p, draft["music_file_id"], "audio/")
    if previous and previous.draft == draft:
        return service.state(db, p)
    db.add(EditVersion(project_id=pid, revision=body.revision + 1, draft=draft))
    p.status, p.updated_at, p.revision = "in_progress", now(), p.revision + 1
    db.commit()
    return service.state(db, p)


@router.post("/exports", response_model=JobOut, status_code=202)
def submit(
    pid: UUID,
    body: ExportCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    command = {"export_revision": body.revision}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    edit = service.latest_edit(db, pid)
    if not edit or edit.revision != body.revision:
        raise HTTPException(409, "请先保存当前剪辑")
    snapshot = {
        **service.freeze(db, p, edit.draft),
        "edit_id": str(edit.id),
        "edit_revision": edit.revision,
    }
    # Deduplicate only identical frozen sources; refreshed TTS can change without an edit.
    candidates = db.scalars(
        select(Job)
        .where(
            Job.project_id == pid,
            Job.kind == "export.render",
            Job.snapshot["edit_id"].astext == str(edit.id),
            Job.state.in_(["queued", "running", "succeeded"]),
        )
        .order_by(Job.created_at.desc())
        .limit(50)
    ).all()
    existing = next(
        (
            j
            for j in candidates
            if service.snapshot_current(db, p, j.snapshot)
            and (j.state != "succeeded" or service.output_available(db, j))
        ),
        None,
    )
    if existing:
        db.add(
            ExportCommand(
                project_id=pid,
                key=idempotency_key,
                fingerprint=fingerprint(command),
                job_id=existing.id,
            )
        )
        db.commit()
        return existing
    job = enqueue(db, p, idempotency_key, command, "export.render", snapshot)
    p.status = "in_progress"
    db.commit()
    return job


@router.post("/exports/{jid}/retry", response_model=JobOut, status_code=202)
def retry(
    pid: UUID,
    jid: UUID,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    old = db.get(Job, jid)
    if not old or old.project_id != pid or old.kind != "export.render":
        raise HTTPException(404, "导出任务不存在")
    command = {"retry_export": str(jid)}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    if old.state != "failed":
        raise HTTPException(409, "仅失败合成可以重试")
    if not service.snapshot_current(db, p, old.snapshot):
        raise HTTPException(409, "原剪辑素材已变化，请更新剪辑后重新导出")
    child = db.scalar(
        select(Job).where(
            Job.project_id == pid,
            Job.kind == "export.render",
            Job.snapshot["retry_of"].astext == str(jid),
        )
    )
    if child:
        db.add(
            ExportCommand(
                project_id=pid,
                key=idempotency_key,
                fingerprint=fingerprint(command),
                job_id=child.id,
            )
        )
        db.commit()
        return child
    job = enqueue(
        db, p, idempotency_key, command, "export.render", {**old.snapshot, "retry_of": str(jid)}
    )
    db.commit()
    return job


@router.get("/exports/{jid}/download")
def download(pid: UUID, jid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    job = db.get(Job, jid)
    if not job or job.project_id != pid or job.kind != "export.render" or job.state != "succeeded":
        raise HTTPException(404, "成片尚未成功")
    result = db.get(JobResult, jid)
    file = owned_file(db, pid, UUID(result.output["file_id"]))
    path = LocalStorage(settings.storage_root).path(file.object_key)
    if not path.is_file():
        raise HTTPException(404, "成片文件缺失，请从备份恢复")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=file.filename,
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.post("/finishing/music", response_model=FileOut, status_code=201)
def upload_music(pid: UUID, file: UploadFile, db: Session = Depends(session)):
    owned_project(db, pid)
    raw = file.file.read(settings.max_upload_bytes + 1)
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(413, "背景音乐超过上传大小限制")
    try:
        with tempfile.TemporaryDirectory(prefix="shortfilm-music-") as tmp:
            path = Path(tmp) / "input"
            path.write_bytes(raw)
            metadata = inspect_media(path, "audio")
    except ValueError:
        raise HTTPException(422, "请上传可完整解码的MP3、WAV、FLAC或OGG音频") from None
    fid = uuid4()
    key = f"projects/{pid}/{fid}"
    storage = LocalStorage(settings.storage_root)
    storage.put(key, raw)
    row = MediaFile(
        id=fid,
        project_id=pid,
        object_key=key,
        filename=Path(file.filename or "music").name[:255],
        mime=metadata["mime"],
        size=len(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
    )
    db.add(row)
    try:
        db.commit()
    except Exception:
        storage.path(key).unlink(missing_ok=True)
        raise
    db.refresh(row)
    return row
