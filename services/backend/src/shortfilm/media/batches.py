"""Persistent independent batches reuse sequence pause metadata, never dependency edges."""

from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.config_models import Binding
from shortfilm.configuration.service import latest
from shortfilm.media.commands import videos
from shortfilm.media.models import JobDependency, MediaOutcome, MediaRun, MediaSequence
from shortfilm.media.schemas import VideoGenerate
from shortfilm.media.sources import board, latest_video, previous_binding, shot_in, source_stale
from shortfilm.models import Job


def independent(db, project, key, body):
    import hashlib

    command = body.model_dump(mode="json")
    scope = "project:" + str(project.id)
    binding_key = "video-batch:" + hashlib.sha256(key.encode()).hexdigest()
    old = latest(db, scope, binding_key)
    if old:
        if old.value["command"] != command:
            raise HTTPException(409, "幂等键已用于不同批次输入")
        return old.value["result"]
    version = board(db, project, body.board_version_id, confirmed=True)
    sequence = MediaSequence(id=uuid4(), project_id=project.id)
    db.add(sequence)
    db.flush()
    items = []
    for sid in body.shot_ids:
        item = {"shot_id": str(sid), "job_id": None, "reason": None}
        try:
            shot = shot_in(version, sid)
            refs = [fid for group in shot["refs"].values() for fid in group]
            tail = (
                db.scalar(
                    select(MediaOutcome.id).where(
                        MediaOutcome.project_id == project.id,
                        MediaOutcome.tail_file_id.in_([UUID(r) for r in refs]),
                    )
                )
                if refs
                else None
            )
            recent = db.scalar(
                select(Job)
                .where(
                    Job.project_id == project.id,
                    Job.kind == "media.video",
                    Job.snapshot["shot_id"].astext == str(sid),
                )
                .order_by(Job.created_at.desc(), Job.id.desc())
                .limit(1)
            )
            recent_run = db.get(MediaRun, recent.id) if recent else None
            dependency = bool(
                recent
                and (db.get(JobDependency, recent.id) or (recent_run and recent_run.previous))
            )
            if previous_binding(db, project, sid) or tail or dependency:
                item["reason"] = "previous_frame_dependency"
            elif latest_video(db, project, sid):
                item["reason"] = "current_success"
            elif db.scalar(
                select(Job.id).where(
                    Job.project_id == project.id,
                    Job.kind == "media.video",
                    Job.snapshot["shot_id"].astext == str(sid),
                    Job.state.in_(
                        ("queued", "running", "waiting_provider", "waiting_dependency", "unknown")
                    ),
                )
            ):
                item["reason"] = "active_task"
            elif (
                recent
                and recent.state in ("failed", "cancelled")
                and recent_run
                and not source_stale(db, project, recent.snapshot, recent_run.previous)
            ):
                item["reason"] = "failed_task_retry_required"
            else:
                with db.begin_nested():
                    job = videos(
                        db,
                        project,
                        "batch:" + str(sequence.id) + ":" + str(sid),
                        VideoGenerate(board_version_id=version.id, shot_ids=[sid]),
                    )[0]
                    db.get(MediaRun, job.id).sequence_id = sequence.id
                    item["job_id"] = str(job.id)
        except HTTPException as error:
            item["reason"] = str(error.detail)
        items.append(item)
    result = {"batch_id": str(sequence.id), "items": items}
    db.add(
        Binding(
            scope=scope, key=binding_key, revision=1, value={"command": command, "result": result}
        )
    )
    db.flush()
    return result
