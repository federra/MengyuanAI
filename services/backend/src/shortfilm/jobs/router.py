import hashlib
import json
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.db import session
from shortfilm.media.router import owned_file
from shortfilm.models import Job, JobEvent, Outbox
from shortfilm.projects.router import owned_project
from shortfilm.schemas import JobCreate, JobOut

router = APIRouter(tags=["jobs"])


@router.post("/projects/{pid}/jobs", response_model=JobOut, status_code=202)
def submit(
    pid: UUID,
    body: JobCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    f = owned_file(db, pid, body.file_id)
    snapshot = {"schemaVersion": 1, "kind": body.kind, "file_id": str(f.id), "sha256": f.sha256}
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    jid = uuid4()
    inserted = db.execute(
        insert(Job)
        .values(
            id=jid,
            project_id=pid,
            owner_id=settings.local_owner_id,
            kind=body.kind,
            idempotency_key=idempotency_key,
            source_fingerprint=fingerprint,
            snapshot=snapshot,
            state="queued",
        )
        .on_conflict_do_nothing(index_elements=["owner_id", "project_id", "idempotency_key"])
        .returning(Job.id)
    ).scalar_one_or_none()
    if inserted:
        db.add(Outbox(job_id=jid))
        db.add(JobEvent(job_id=jid, state="queued"))
        db.commit()
        return db.get(Job, jid)
    existing = db.scalar(
        select(Job).where(
            Job.owner_id == settings.local_owner_id,
            Job.project_id == pid,
            Job.idempotency_key == idempotency_key,
        )
    )
    if existing.source_fingerprint != fingerprint:
        raise HTTPException(409, "同一幂等键不能用于不同输入")
    return existing


@router.get("/jobs/{jid}", response_model=JobOut)
def get_job(jid: UUID, db: Session = Depends(session)):
    j = db.scalar(select(Job).where(Job.id == jid, Job.owner_id == settings.local_owner_id))
    if not j:
        raise HTTPException(404, "任务不存在")
    return j


@router.get("/projects/{pid}/jobs", response_model=list[JobOut])
def list_jobs(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return db.scalars(
        select(Job)
        .where(Job.project_id == pid, Job.owner_id == settings.local_owner_id)
        .order_by(Job.created_at.desc())
        .limit(100)
    ).all()
