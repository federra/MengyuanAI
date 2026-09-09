"""Fenced deterministic export execution using the existing Job/Outbox lease."""

import hashlib
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.config import settings
from shortfilm.db import Session
from shortfilm.finishing.render import compose
from shortfilm.finishing.service import snapshot_current
from shortfilm.jobs.service import finish_job, heartbeat, now
from shortfilm.media.storage import LocalStorage
from shortfilm.models import Job, JobAttempt, JobEvent, JobResult, MediaFile, Project


def verify_files(snapshot, storage, alive):
    refs = list(snapshot.get("references", []))
    for clip in snapshot["clips"]:
        refs.append(clip["file"])
        refs.extend(line["file"] for line in clip["lines"])
    if snapshot["music"]:
        refs.append(snapshot["music"])
    for ref in {r["object_key"]: r for r in refs}.values():
        sha = hashlib.sha256()
        with storage.path(ref["object_key"]).open("rb") as stream:
            while block := stream.read(1024 * 1024):
                sha.update(block)
                if not alive():
                    raise ValueError("export_lease_lost")
        if sha.hexdigest() != ref["sha256"]:
            raise ValueError("export_source_checksum_mismatch")


def execute_export(jid, token):
    jid = UUID(str(jid))
    storage = LocalStorage(settings.storage_root)
    key = None
    try:
        with Session() as db:
            job = db.get(Job, jid)
            snapshot, pid = job.snapshot, job.project_id
            if not snapshot_current(db, db.get(Project, pid), snapshot):
                raise ValueError("export_source_stale")

        def alive():
            return heartbeat(jid, token)

        verify_files(snapshot, storage, alive)
        with tempfile.TemporaryDirectory(prefix="shortfilm-export-") as temp:
            path = Path(temp) / "output.mp4"
            metadata = compose(snapshot, path, storage.path, alive)
            verify_files(snapshot, storage, alive)
            raw = path.read_bytes()
            fid = uuid4()
            key = f"projects/{pid}/{fid}"
            storage.put(key, raw)
            with Session.begin() as db:
                # Same lock order as export submission; old leases cannot publish.
                p = db.scalar(select(Project).where(Project.id == pid).with_for_update())
                j = db.scalar(select(Job).where(Job.id == jid).with_for_update())
                if j.state != "running" or j.lease_token != token or j.lease_until <= now():
                    raise ValueError("export_lease_lost")
                current = snapshot_current(db, p, snapshot)
                db.add(
                    MediaFile(
                        id=fid,
                        project_id=pid,
                        object_key=key,
                        filename=snapshot["draft"]["filename"] + ".mp4",
                        mime="video/mp4",
                        size=len(raw),
                        sha256=hashlib.sha256(raw).hexdigest(),
                    )
                )
                db.flush()
                db.add(
                    JobResult(
                        job_id=jid,
                        output={
                            "schemaVersion": 1,
                            "file_id": str(fid),
                            "metadata": metadata,
                            "edit_id": snapshot["edit_id"],
                        },
                    )
                )
                j.state, j.error, j.lease_token, j.lease_until, j.updated_at = (
                    "succeeded",
                    None,
                    None,
                    None,
                    now(),
                )
                attempt = db.scalar(select(JobAttempt).where(JobAttempt.token == token))
                attempt.state, attempt.finished_at = "succeeded", now()
                db.add(JobEvent(job_id=jid, state="succeeded"))
                if current:
                    p.status, p.stage, p.updated_at = "completed", "finishing", now()
            key = None
    except (ValueError, OSError, HTTPException, KeyError, StopIteration) as e:
        code = (
            str(e)
            if isinstance(e, ValueError) and str(e).startswith("export_")
            else "export_media_invalid_or_missing"
        )
        finish_job(jid, token, error=code[:200])
    finally:
        if key:
            storage.path(key).unlink(missing_ok=True)
