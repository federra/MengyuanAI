"""PostgreSQL owns state; Redis messages only carry a job ID.

M0 file.verify is deterministic and safe to replay. Future paid provider tasks
must use reconciliation, not this local retry policy.
"""

import hashlib
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select, update

from shortfilm.config import settings
from shortfilm.creation.kinds import is_text
from shortfilm.db import Session
from shortfilm.media.storage import LocalStorage
from shortfilm.models import Job, JobAttempt, JobEvent, JobResult, MediaFile, Outbox


def now():
    return datetime.now(UTC)


def as_uuid(value):
    return UUID(str(value))


def claim_job(job_id):
    with Session.begin() as db:
        j = db.scalar(select(Job).where(Job.id == as_uuid(job_id)).with_for_update())
        if not j or j.state != "queued":
            return None
        token = uuid4()
        j.state, j.lease_token = "running", token
        j.updated_at = now()
        j.lease_until = now() + timedelta(seconds=settings.lease_seconds)
        db.add(JobAttempt(job_id=j.id, token=token))
        db.add(JobEvent(job_id=j.id, state="running"))
        return token


def heartbeat(job_id, token):
    with Session.begin() as db:
        result = db.execute(
            update(Job)
            .where(
                Job.id == as_uuid(job_id),
                Job.lease_token == token,
                Job.state == "running",
                Job.lease_until > now(),
            )
            .values(lease_until=now() + timedelta(seconds=settings.lease_seconds))
        )
        return result.rowcount == 1


def finish_job(job_id, token, output=None, error=None, unknown=False):
    with Session.begin() as db:
        j = db.scalar(select(Job).where(Job.id == as_uuid(job_id)).with_for_update())
        if not j or j.state != "running" or j.lease_token != token or j.lease_until <= now():
            return False
        j.state = ("unknown" if unknown else "failed") if error else "succeeded"
        j.error, j.updated_at, j.lease_until, j.lease_token = error, now(), None, None
        attempt = db.scalar(select(JobAttempt).where(JobAttempt.token == token))
        attempt.state, attempt.finished_at = j.state, now()
        if not error:
            if is_text(j.kind):
                from shortfilm.creation.execution import save_output

                save_output(db, j, output)
            db.add(JobResult(job_id=j.id, output=output))
        db.add(JobEvent(job_id=j.id, state=j.state))
        return True


def execute_job(job_id):
    token = claim_job(job_id)
    if token is None:
        return
    try:
        with Session() as db:
            j = db.get(Job, as_uuid(job_id))
            if is_text(j.kind):
                snapshot = j.snapshot
            else:
                snapshot = None
        if snapshot is not None:
            from shortfilm.creation.execution import execute_text

            execute_text(job_id, token, snapshot)
            return
        with Session() as db:
            j = db.get(Job, as_uuid(job_id))
            if j.kind != "file.verify":
                raise ValueError("unsupported kind")
            f = db.get(MediaFile, as_uuid(j.snapshot["file_id"]))
            key, expected = f.object_key, j.snapshot["sha256"]
        sha = hashlib.sha256()
        with LocalStorage(settings.storage_root).path(key).open("rb") as stream:
            while block := stream.read(1024 * 1024):
                sha.update(block)
                if not heartbeat(job_id, token):
                    return
        if sha.hexdigest() != expected:
            finish_job(job_id, token, error="file_checksum_mismatch")
        else:
            finish_job(
                job_id, token, {"schemaVersion": 1, "sha256": sha.hexdigest(), "verified": True}
            )
    except (FileNotFoundError, OSError, ValueError):
        finish_job(job_id, token, error="file_verification_failed")


def recover_jobs():
    with Session.begin() as db:
        expired = db.scalars(
            select(Job)
            .where(Job.state == "running", Job.lease_until < now())
            .with_for_update(skip_locked=True)
        ).all()
        for j in expired:
            attempt = db.scalar(select(JobAttempt).where(JobAttempt.token == j.lease_token))
            if attempt:
                attempt.state, attempt.finished_at = "interrupted", now()
            # Only local deterministic jobs may be automatically resubmitted.
            j.state = "queued" if j.kind == "file.verify" else "unknown"
            j.lease_token, j.lease_until, j.updated_at = None, None, now()
            db.add(JobEvent(job_id=j.id, state=j.state))
            if j.state == "queued":
                db.get(Outbox, j.id).sent_at = None
        # Redis loss / a published message lost before claim is recoverable from PG.
        rows = db.scalars(
            select(Outbox)
            .join(Job, Job.id == Outbox.job_id)
            .where(
                Job.state == "queued",
                Outbox.sent_at < now() - timedelta(seconds=settings.redispatch_seconds),
            )
            .with_for_update(of=Outbox, skip_locked=True)
        ).all()
        for row in rows:
            row.sent_at = None
        return len(expired)
