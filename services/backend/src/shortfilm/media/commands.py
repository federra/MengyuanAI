"""Project-locked generation commands; no provider side effects occur in API transactions."""

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.assets.service import entity_version, owned_entity
from shortfilm.creation.service import enqueue, existing_job
from shortfilm.media.models import JobDependency, MediaRun, MediaSequence
from shortfilm.media.sources import (
    board,
    checked_file,
    frozen_configuration,
    line_context,
    outcome_stale,
    previous_binding,
    previous_context,
    previous_valid,
    shot_context,
    shot_in,
)
from shortfilm.models import Job, JobEvent


def add_run(db, project, key, command, snapshot, sequence=None, parent=None):
    job = enqueue(db, project, key, command, snapshot["kind"], snapshot)
    run = MediaRun(job_id=job.id, sequence_id=sequence.id if sequence else None)
    db.add(run)
    if parent:
        job.state = "waiting_dependency"
        db.add(JobDependency(child_id=job.id, parent_id=parent.id))
        db.add(JobEvent(job_id=job.id, state="waiting_dependency"))
    return job, run


def image_job(db, project, key, body):
    command = {"action": "media.image", **body.model_dump(mode="json")}
    old = existing_job(db, project.id, key, command)
    if old:
        return old
    files = [checked_file(db, project, fid) for fid in body.reference_file_ids]
    if len({f["id"] for f in files}) != len(files):
        raise HTTPException(422, "参考图不能重复")
    if body.entity_id:
        entity = owned_entity(db, project.id, body.entity_id)
        if entity.revision != body.entity_revision:
            raise HTTPException(409, "元素版本已变化")
        version = entity_version(db, entity)
        kind = "image." + entity.kind
        context = {
            "name": version.name,
            "description": version.description,
            "three_view": version.three_view,
            "instruction": body.instruction,
        }
        target = {
            "entity_version_id": str(version.id),
            "target_id": str(entity.id),
            "input": context,
        }
    else:
        version = board(db, project, body.board_version_id, confirmed=True)
        shot = shot_in(version, body.shot_id)
        kind = "image.position"
        context = shot_context(db, project, version, shot, kind, require_refs=True)
        files = context["files"] + files
        files = list({f["id"]: f for f in files}.values())
        target = {
            "board_version_id": str(version.id),
            "shot_id": shot["id"],
            "target_id": shot["id"],
            "input": context,
        }
        context = {**context, "instruction": body.instruction}
    frozen = frozen_configuration(db, project, kind, context)
    snapshot = {**frozen, **target, "files": files, "instruction": body.instruction}
    job, _ = add_run(db, project, key, command, snapshot)
    return job


def audio_job(db, project, key, body):
    command = {"action": "media.audio", **body.model_dump(mode="json")}
    old = existing_job(db, project.id, key, command)
    if old:
        return old
    version = board(db, project, body.board_version_id, confirmed=True)
    shot = shot_in(version, body.shot_id)
    context = line_context(db, project, shot, body.line_id)
    if not context["text"].strip() or not context["voice"].strip():
        raise HTTPException(422, "当前台词或音色未填写；请选择角色音色或逐段音色")
    emotion = body.emotion or (
        context["emotion"]
        if context["emotion"]
        in ("neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised")
        else "neutral"
        if not context["emotion"]
        else None
    )
    if emotion is None:
        raise HTTPException(422, "请显式选择供应商支持的配音表现，原台词情绪保留")
    frozen = frozen_configuration(db, project, "media.audio", context)
    snapshot = {
        **frozen,
        "board_version_id": str(version.id),
        "shot_id": shot["id"],
        "target_id": str(body.line_id),
        "input": context,
        "speed": body.speed,
        "performance_emotion": emotion,
        "files": [],
    }
    job, _ = add_run(db, project, key, command, snapshot)
    return job


def videos(db, project, key, body):
    command = {"action": "media.videos", **body.model_dump(mode="json")}
    old = existing_job(db, project.id, key, command)
    if old:
        group = db.get(MediaRun, old.id).sequence_id
        if group:
            return list(
                db.scalars(
                    select(Job)
                    .join(MediaRun, Job.id == MediaRun.job_id)
                    .where(MediaRun.sequence_id == group)
                    .order_by(Job.created_at, Job.id)
                ).all()
            )
        return [old]
    version = board(db, project, body.board_version_id, confirmed=True)
    requested = [str(i) for i in body.shot_ids]
    ordered = [s["id"] for s in version.body["shots"]]
    if body.sequential and (requested != ordered[: len(requested)]):
        raise HTTPException(422, "顺序生成请从第一镜开始选择连续镜头")
    if not body.sequential and len(requested) != 1:
        raise HTTPException(422, "独立生成一次选择一个镜头")
    snapshots = []
    for sid in requested:
        shot = shot_in(version, sid)
        context = shot_context(db, project, version, shot, "media.video", require_refs=True)
        frozen = frozen_configuration(db, project, "media.video", context)
        spec = frozen["specification"]
        if spec["resolution"] not in ("720P", "1080P"):
            raise HTTPException(422, "当前视频适配器不支持该分辨率，请显式修改项目生成规格")
        if not 4 <= shot["duration"] <= 15 or not float(shot["duration"]).is_integer():
            raise HTTPException(422, "当前视频模型要求4至15秒的整数镜头时长")
        # Conservative supported baseline across selected Seedance versions; never discard refs.
        if len(context["files"]) + (1 if body.sequential and sid != requested[0] else 0) > 9:
            raise HTTPException(422, "当前适配最多9张参考图（含前镜尾帧），请显式调整引用")
        from shortfilm.creation.provider import ProviderFailure
        from shortfilm.media.providers import validate_video_payload

        try:
            validate_video_payload(
                frozen["model"],
                {
                    "prompt": frozen["prompt"],
                    "images": ["data:image/png;base64,AA=="]
                    * (
                        len(context["files"])
                        + (1 if body.sequential and sid != requested[0] else 0)
                    ),
                    "duration": int(shot["duration"]),
                    "resolution": spec["resolution"],
                    "aspect_ratio": spec["aspect_ratio"],
                },
            )
        except ProviderFailure:
            raise HTTPException(422, "当前模型不支持这些参考图、时长或分辨率，请检查配置") from None
        snapshots.append(
            {
                **frozen,
                "board_version_id": str(version.id),
                "shot_id": sid,
                "target_id": sid,
                "input": context,
                "files": context["files"],
            }
        )
    sequence = MediaSequence(id=uuid4(), project_id=project.id) if body.sequential else None
    if sequence:
        db.add(sequence)
        db.flush()
    jobs, parent = [], None
    for index, snapshot in enumerate(snapshots):
        job, run = add_run(
            db,
            project,
            key if index == 0 else "sequence:" + str(sequence.id) + ":" + str(index),
            command if index == 0 else {**command, "index": index},
            snapshot,
            sequence,
            parent,
        )
        if not body.sequential:
            binding = previous_binding(db, project, snapshot["shot_id"])
            if binding:
                from shortfilm.media.models import MediaOutcome

                output = db.get(MediaOutcome, binding.outcome_id)
                previous = previous_context(output)
                if outcome_stale(db, project, output) or not previous_valid(
                    db, project, version, snapshot["shot_id"], previous
                ):
                    raise HTTPException(409, "上一视频尾帧绑定已过期，请重新绑定")
                run.previous = previous
        jobs.append(job)
        parent = job
    return jobs
