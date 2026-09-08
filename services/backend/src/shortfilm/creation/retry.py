from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.creation.kinds import is_text
from shortfilm.creation.schemas import RetryJob
from shortfilm.creation.service import enqueue, existing_job
from shortfilm.db import session
from shortfilm.jobs.router import get_job
from shortfilm.models import ContentReview, Job, Message
from shortfilm.projects.router import owned_project
from shortfilm.schemas import JobOut

router = APIRouter(tags=["jobs"])


@router.post("/jobs/{jid}/retry", response_model=JobOut, status_code=202)
def retry(
    jid: UUID,
    body: RetryJob,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    old = get_job(jid, db)
    p = owned_project(db, old.project_id, lock=True)
    command = {"retry_of": str(jid), **body.model_dump()}
    existing = existing_job(db, p.id, idempotency_key, command)
    if existing:
        return existing
    if not is_text(old.kind) or old.state not in (
        "failed",
        "unknown",
    ):
        raise HTTPException(409, "只有失败或待核实的文本任务可以重试")
    if old.state == "unknown" and not body.confirm_unknown:
        raise HTTPException(409, "供应商可能已受理，确认可能重复计费后才能重新提交")
    child = db.scalar(
        select(Job).where(Job.project_id == p.id, Job.snapshot["retry_of"].astext == str(jid))
    )
    if child:
        return child
    snapshot = {**old.snapshot, "retry_of": str(jid)}
    job = enqueue(db, p, idempotency_key, command, old.kind, snapshot)
    if old.kind.endswith((".revise", ".repair")):
        db.add(
            Message(
                item_id=UUID(snapshot["item_id"]), job_id=job.id, role="user", text=snapshot["text"]
            )
        )
    if old.kind.endswith(".review"):
        db.add(
            ContentReview(
                item_id=UUID(snapshot["item_id"]),
                version_id=UUID(snapshot["base_version_id"]),
                source_version_id=UUID(snapshot["source_version_id"])
                if snapshot.get("source_version_id")
                else None,
                job_id=job.id,
            )
        )
    db.commit()
    return job
