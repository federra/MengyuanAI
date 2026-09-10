from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets.models import Entity, ReferenceConfirmation, ReferenceImage
from shortfilm.assets.service import entity_version, owned_entity
from shortfilm.creation.service import enqueue, existing_job
from shortfilm.db import session
from shortfilm.media import commands, shot_settings
from shortfilm.media.models import (
    JobDependency,
    LineBinding,
    MediaOutcome,
    MediaRun,
    MediaSequence,
    PreviousFrame,
)
from shortfilm.media.schemas import (
    AudioGenerate,
    ImageGenerate,
    IndependentBatch,
    IndependentBatchOut,
    LineBind,
    LineBindingOut,
    MediaRetry,
    MediaTaskOut,
    OutcomeOut,
    PreviousBind,
    ReferenceReplace,
    SequenceControl,
    ShotReferenceOut,
    ShotSettingsOut,
    ShotSettingsSave,
    VideoGenerate,
)
from shortfilm.media.sources import (
    board,
    latest_video,
    outcome_stale,
    previous_context,
    shot_in,
    source_stale,
)
from shortfilm.models import Job, JobEvent
from shortfilm.projects.router import owned_project
from shortfilm.schemas import JobOut

router = APIRouter(prefix="/projects/{pid}/media", tags=["media-generation"])


@router.post("/images", response_model=JobOut, status_code=202)
def generate_image(
    pid: UUID,
    body: ImageGenerate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    job = commands.image_job(db, project, idempotency_key, body)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return job


@router.post("/audio", response_model=JobOut, status_code=202)
def generate_audio(
    pid: UUID,
    body: AudioGenerate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    job = commands.audio_job(db, project, idempotency_key, body)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return job


@router.post("/videos", response_model=list[JobOut], status_code=202)
def generate_video(
    pid: UUID,
    body: VideoGenerate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    jobs = commands.videos(db, project, idempotency_key, body)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return jobs


def binding_out(db, binding):
    entity = db.get(Entity, binding.entity_id) if binding.entity_id else None
    version = entity_version(db, entity) if entity else None
    return dict(
        line_id=binding.line_id,
        entity_id=binding.entity_id,
        revision=binding.revision,
        name=version.name if version else None,
        voice=version.voice if version else None,
    )


@router.get("/line-bindings", response_model=list[LineBindingOut])
def get_line_bindings(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return [
        binding_out(db, b)
        for b in db.scalars(select(LineBinding).where(LineBinding.project_id == pid))
    ]


@router.put("/line-bindings/{line_id}", response_model=LineBindingOut)
def bind_line(pid: UUID, line_id: UUID, body: LineBind, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    version = board(db, project, body.board_version_id)
    if not any(
        line["id"] == str(line_id) for s in version.body["shots"] for line in s["dialogues"]
    ):
        raise HTTPException(404, "台词不属于当前分镜")
    if body.entity_id and owned_entity(db, pid, body.entity_id).kind != "character":
        raise HTTPException(422, "台词只能绑定角色")
    binding = db.get(LineBinding, line_id)
    if (binding.revision if binding else 0) != body.revision:
        raise HTTPException(409, "角色绑定已变化")
    if binding:
        binding.entity_id, binding.revision = body.entity_id, binding.revision + 1
    else:
        binding = LineBinding(line_id=line_id, project_id=pid, entity_id=body.entity_id, revision=1)
        db.add(binding)
    db.flush()
    result = binding_out(db, binding)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return result


def outcome_out(db, project, output):
    stale = outcome_stale(db, project, output)
    confirmed = output.confirmation_revision == project.generation_settings["revision"]
    if output.kind.startswith("image.") and output.kind != "image.position":
        from shortfilm.assets.references import image_out

        image = db.scalar(select(ReferenceImage).where(ReferenceImage.file_id == output.file_id))
        confirmed = bool(image) and image_out(db, project, image)["confirmed"]
    return dict(
        id=output.id,
        job_id=output.job_id,
        kind=output.kind,
        target_id=output.target_id,
        file_id=output.file_id,
        tail_file_id=output.tail_file_id,
        metadata=output.metadata_json,
        stale=stale,
        confirmed=confirmed and not stale,
        created_at=output.created_at,
    )


@router.get("/results", response_model=list[OutcomeOut])
def results(pid: UUID, db: Session = Depends(session)):
    project = owned_project(db, pid)
    return [
        outcome_out(db, project, output)
        for output in db.scalars(
            select(MediaOutcome)
            .join(Job, Job.id == MediaOutcome.job_id)
            .where(MediaOutcome.project_id == pid)
            .order_by(Job.created_at.desc(), Job.id.desc())
        )
    ]


@router.post("/results/{rid}/confirm", response_model=OutcomeOut)
def confirm_result(pid: UUID, rid: UUID, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    output = db.scalar(
        select(MediaOutcome).where(MediaOutcome.id == rid, MediaOutcome.project_id == pid)
    )
    if not output:
        raise HTTPException(404, "媒体结果不存在")
    if not output.kind.startswith("image.") or outcome_stale(db, project, output):
        raise HTTPException(409, "只可确认当前有效参考图")
    output.confirmation_revision = project.generation_settings["revision"]
    image = db.scalar(select(ReferenceImage).where(ReferenceImage.file_id == output.file_id))
    if image and not db.scalar(
        select(ReferenceConfirmation).where(
            ReferenceConfirmation.image_id == image.id,
            ReferenceConfirmation.specification_revision == output.confirmation_revision,
        )
    ):
        db.add(
            ReferenceConfirmation(
                image_id=image.id, specification_revision=output.confirmation_revision
            )
        )
    db.flush()
    result = outcome_out(db, project, output)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return result


@router.get("/tasks", response_model=list[MediaTaskOut])
def tasks(pid: UUID, db: Session = Depends(session)):
    project = owned_project(db, pid)
    rows = db.execute(
        select(Job, MediaRun)
        .join(MediaRun, Job.id == MediaRun.job_id)
        .where(Job.project_id == pid)
        .order_by(Job.created_at.desc(), Job.id.desc())
    ).all()
    return [
        dict(
            id=j.id,
            kind=j.kind,
            state=j.state,
            error=j.error,
            target_id=j.snapshot["target_id"],
            shot_id=j.snapshot.get("shot_id"),
            sequence_id=r.sequence_id,
            paused=bool(r.sequence_id and db.get(MediaSequence, r.sequence_id).paused),
            stale=source_stale(db, project, j.snapshot, r.previous),
            external_id=r.external_id,
            previous=r.previous,
            snapshot=j.snapshot,
            created_at=j.created_at,
        )
        for j, r in rows
    ]


def owned_run(db, pid, jid):
    job = db.scalar(select(Job).where(Job.project_id == pid, Job.id == jid).with_for_update())
    run = db.get(MediaRun, jid) if job else None
    if not run:
        raise HTTPException(404, "媒体任务不存在")
    return job, run


@router.post("/tasks/{jid}/retry", response_model=JobOut, status_code=202)
def retry(
    pid: UUID,
    jid: UUID,
    body: MediaRetry,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    old, run = owned_run(db, pid, jid)
    command = {"retry_of": str(jid), **body.model_dump()}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    if old.state not in ("failed", "unknown", "cancelled"):
        raise HTTPException(409, "只有失败、待核实或取消的任务可以重试")
    if source_stale(db, project, old.snapshot, run.previous):
        raise HTTPException(409, "旧输入已过期，请从当前内容重新生成")
    child = db.scalar(
        select(Job).where(Job.project_id == pid, Job.snapshot["retry_of"].astext == str(jid))
    )
    if child:
        return child
    if old.state == "unknown" and not run.external_id and not body.confirm_unknown:
        raise HTTPException(409, "供应商可能已受理，请核实并确认可能重复计费后再提交")
    job = enqueue(
        db, project, idempotency_key, command, old.kind, {**old.snapshot, "retry_of": str(jid)}
    )
    # A known accepted task is reconciled/downloaded again; no second create call.
    reuse = bool(run.receipt and run.receipt.get("staged_key")) or bool(
        run.external_id
        and (
            old.state == "unknown"
            or old.error
            in ("media_download_failed", "media_invalid", "last_frame_extraction_failed")
        )
    )
    db.add(
        MediaRun(
            job_id=job.id,
            sequence_id=run.sequence_id,
            external_id=run.external_id if reuse else None,
            submitted=reuse,
            receipt=run.receipt if reuse else None,
            previous=run.previous,
        )
    )
    parent = db.get(JobDependency, old.id)
    if parent:
        db.add(JobDependency(child_id=job.id, parent_id=parent.parent_id))
        if not reuse:
            job.state = "waiting_dependency"
            db.add(JobEvent(job_id=job.id, state="waiting_dependency"))
    for dependency in db.scalars(select(JobDependency).where(JobDependency.parent_id == old.id)):
        waiting = db.get(Job, dependency.child_id)
        if waiting.state == "waiting_dependency":
            dependency.parent_id = job.id
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return job


@router.post("/tasks/{jid}/cancel", response_model=JobOut)
def cancel(pid: UUID, jid: UUID, db: Session = Depends(session)):
    owned_project(db, pid, lock=True)
    job, run = owned_run(db, pid, jid)
    if job.state in ("succeeded", "failed", "unknown", "cancelled"):
        return job
    run.cancelled = True
    if run.sequence_id:
        db.get(MediaSequence, run.sequence_id).paused = True
    if job.state in ("queued", "waiting_dependency") and not run.submitted:
        job.state = "cancelled"
    else:
        # Keep provider polling alive; UI shows cancellation requested, late output archived.
        job.error = "cancel_requested"
    db.add(
        JobEvent(
            job_id=job.id, state="cancel_requested" if job.state != "cancelled" else "cancelled"
        )
    )
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return job


@router.put("/sequences/{sid}")
def control_sequence(pid: UUID, sid: UUID, body: SequenceControl, db: Session = Depends(session)):
    owned_project(db, pid, lock=True)
    sequence = db.scalar(
        select(MediaSequence).where(MediaSequence.id == sid, MediaSequence.project_id == pid)
    )
    if not sequence:
        raise HTTPException(404, "顺序任务不存在")
    sequence.paused = body.paused
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return {"id": str(sid), "paused": sequence.paused}


@router.post("/shots/{shot_id}/previous-frame")
def bind_previous(pid: UUID, shot_id: UUID, body: PreviousBind, db: Session = Depends(session)):
    from copy import deepcopy

    from shortfilm.creation.service import append_version
    from shortfilm.creation.stage_service import upstream
    from shortfilm.models import ContentItem

    project = owned_project(db, pid, lock=True)
    version = board(db, project, body.board_version_id)
    shots = version.body["shots"]
    ids = [s["id"] for s in shots]
    if str(shot_id) not in ids or ids.index(str(shot_id)) == 0:
        raise HTTPException(422, "当前镜头没有前镜")
    output = latest_video(db, project, ids[ids.index(str(shot_id)) - 1])
    if (
        not output
        or output.id != body.previous_video_version_id
        or outcome_stale(db, project, output)
    ):
        raise HTTPException(409, "前镜视频已变化、过期或尚未生成")
    existing = db.scalar(
        select(PreviousFrame).where(
            PreviousFrame.shot_id == shot_id, PreviousFrame.outcome_id == output.id
        )
    )
    if existing:
        return {**previous_context(output), "board_version_id": str(version.id)}
    from shortfilm.media.sources import previous_binding

    previous = previous_binding(db, project, shot_id)
    value = deepcopy(version.body)
    shot = shot_in(type("Version", (), {"body": value})(), shot_id)
    if previous:
        old_output = db.get(MediaOutcome, previous.outcome_id)
        old_id = str(old_output.tail_file_id)
        shot["refs"]["positions"] = [fid for fid in shot["refs"]["positions"] if fid != old_id]
        shot["prompt"] = shot["prompt"].replace("@[" + old_id + "]", "")
    fid = str(output.tail_file_id)
    if fid not in shot["refs"]["positions"]:
        shot["refs"]["positions"].append(fid)
    shot["prompt"] += "\n以前镜真实尾帧作为连续性参考：@[" + fid + "]"
    item = db.get(ContentItem, version.item_id)
    new_version = append_version(db, project, item, value, "manual", upstream(db, version).id)
    db.add(PreviousFrame(project_id=pid, shot_id=shot_id, outcome_id=output.id))
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return {**previous_context(output), "board_version_id": str(new_version.id)}


@router.get("/reference-bindings", response_model=list[ShotReferenceOut])
def reference_bindings(pid: UUID, db: Session = Depends(session)):
    from shortfilm.media.models import ShotReferenceVersion

    owned_project(db, pid)
    rows = db.scalars(
        select(ShotReferenceVersion)
        .where(ShotReferenceVersion.project_id == pid)
        .order_by(ShotReferenceVersion.revision.desc())
    ).all()
    unique = {}
    for row in rows:
        unique.setdefault((row.shot_id, row.ref_id), row)
    return list(unique.values())


@router.put("/shots/{shot_id}/references/{ref_id}", response_model=ShotReferenceOut)
def replace_reference(
    pid: UUID, shot_id: UUID, ref_id: UUID, body: ReferenceReplace, db: Session = Depends(session)
):
    from shortfilm.media.models import ShotReferenceVersion
    from shortfilm.media.sources import checked_file, reference_valid, reference_version

    project = owned_project(db, pid, lock=True)
    version = board(db, project, body.board_version_id)
    shot = shot_in(version, shot_id)
    if str(ref_id) not in [fid for group in shot["refs"].values() for fid in group]:
        raise HTTPException(404, "引用不属于当前镜头")
    checked_file(db, project, body.file_id)
    if not reference_valid(db, project, body.file_id):
        raise HTTPException(409, "替换图片必须已确认且有效")
    if db.scalar(select(MediaOutcome).where(MediaOutcome.tail_file_id == ref_id)):
        raise HTTPException(422, "前镜尾帧须通过参考上一视频尾帧操作替换")
    old = reference_version(db, shot_id, ref_id)
    if (old.revision if old else 0) != body.revision:
        raise HTTPException(409, "图片引用版本已变化，请刷新后重试")
    row = ShotReferenceVersion(
        project_id=pid,
        shot_id=shot_id,
        ref_id=ref_id,
        file_id=body.file_id,
        revision=body.revision + 1,
    )
    db.add(row)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return row


@router.get("/shots/{shot_id}/settings", response_model=ShotSettingsOut)
def get_shot_settings(
    pid: UUID, shot_id: UUID, board_version_id: UUID, db: Session = Depends(session)
):
    project = owned_project(db, pid)
    version = board(db, project, board_version_id)
    shot_in(version, shot_id)
    return shot_settings.settings_out(db, project, version.id, shot_id)


@router.put("/shots/{shot_id}/settings", response_model=ShotSettingsOut)
def put_shot_settings(
    pid: UUID, shot_id: UUID, body: ShotSettingsSave, db: Session = Depends(session)
):
    project = owned_project(db, pid, lock=True)
    version = board(db, project, body.board_version_id)
    shot_in(version, shot_id)
    shot_settings.persist(
        db, project, version.id, shot_id, body.revision, body.overrides.model_dump(mode="json")
    )
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    result = shot_settings.settings_out(db, project, version.id, shot_id)
    db.commit()
    return result


@router.post("/videos/independent", response_model=IndependentBatchOut, status_code=202)
def independent_videos(
    pid: UUID,
    body: IndependentBatch,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    from shortfilm.media.batches import independent

    project = owned_project(db, pid, lock=True)
    result = independent(db, project, idempotency_key, body)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, pid)
    db.commit()
    return result
