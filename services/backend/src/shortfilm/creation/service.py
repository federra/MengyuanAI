"""Content writes require the project lock; immutable versions retain source links."""

import hashlib
import json
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select

from shortfilm.config import settings
from shortfilm.jobs.service import now
from shortfilm.models import ContentItem, ContentVersion, Job, JobEvent, Outbox, StorySelection


def current_version(db, item):
    return db.scalar(
        select(ContentVersion).where(
            ContentVersion.item_id == item.id, ContentVersion.revision == item.revision
        )
    )


def owned_item(db, pid, iid):
    item = db.scalar(
        select(ContentItem).where(ContentItem.id == iid, ContentItem.project_id == pid)
    )
    if not item:
        raise HTTPException(404, "内容不存在")
    return item


def selection(db, pid):
    return db.scalar(
        select(StorySelection)
        .where(StorySelection.project_id == pid)
        .order_by(StorySelection.revision.desc())
        .limit(1)
    )


def content_out(db, item):
    v = current_version(db, item)
    from shortfilm.creation.stage_service import is_stale, upstream

    stale = is_stale(db, v)
    parent = upstream(db, v)
    immediate = db.get(ContentVersion, v.source_version_id) if v.source_version_id else None
    return dict(
        id=item.id,
        kind=item.kind,
        revision=item.revision,
        version_id=v.id,
        body=v.body,
        batch_id=item.batch_id,
        source_version_id=parent.id if parent else None,
        previous_version_id=immediate.id if immediate and immediate.item_id == item.id else None,
        stale=stale,
    )


def append_version(db, project, item, body, origin, source=None, job_id=None):
    item.revision = (
        db.scalar(
            select(func.max(ContentVersion.revision)).where(ContentVersion.item_id == item.id)
        )
        or 0
    ) + 1
    v = ContentVersion(
        id=uuid4(),
        item_id=item.id,
        revision=item.revision,
        body=body,
        origin=origin,
        source_version_id=source,
        job_id=job_id,
    )
    db.add(v)
    previous = selection(db, project.id)
    if previous and previous.version_id:
        selected = db.get(ContentVersion, previous.version_id)
        if item.kind == "idea" or selected.item_id == item.id:
            db.add(
                StorySelection(
                    project_id=project.id, revision=previous.revision + 1, version_id=None
                )
            )
    project.revision += 1
    project.updated_at = now()
    project.status = "in_progress"
    db.flush()
    return v


def fingerprint(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def existing_job(db, pid, key, command):
    from shortfilm.finishing.models import ExportCommand
    alias = db.get(ExportCommand, (pid, key))
    if alias:
        if alias.fingerprint != fingerprint(command):
            raise HTTPException(409, "同一幂等键不能用于不同输入")
        return db.get(Job, alias.job_id)
    job = db.scalar(
        select(Job).where(
            Job.project_id == pid,
            Job.owner_id == settings.local_owner_id,
            Job.idempotency_key == key,
        )
    )
    if job and job.snapshot.get("command_fingerprint", job.source_fingerprint) != fingerprint(
        command
    ):
        raise HTTPException(409, "同一幂等键不能用于不同输入")
    return job


def enqueue(db, project, key, command, kind, snapshot):
    snapshot = {**snapshot, "command_fingerprint": fingerprint(command)}
    job = Job(
        id=uuid4(),
        project_id=project.id,
        owner_id=project.owner_id,
        kind=kind,
        idempotency_key=key,
        source_fingerprint=fingerprint(snapshot),
        snapshot=snapshot,
        state="queued",
    )
    db.add(job)
    db.flush()
    db.add_all([Outbox(job_id=job.id), JobEvent(job_id=job.id, state="queued")])
    return job
