"""Export preflight shares M2 source validity, but never invokes a provider."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.config import settings
from shortfilm.finishing.models import EditVersion
from shortfilm.finishing.schemas import EditDraft
from shortfilm.media.models import MediaOutcome
from shortfilm.media.sources import board, outcome_stale, shot_context
from shortfilm.media.storage import LocalStorage
from shortfilm.models import Job, JobResult, MediaFile


def latest_edit(db, pid):
    return db.scalar(
        select(EditVersion)
        .where(EditVersion.project_id == pid)
        .order_by(EditVersion.revision.desc())
        .limit(1)
    )


def latest_outcome(db, pid, kind, target):
    return db.scalar(
        select(MediaOutcome)
        .where(
            MediaOutcome.project_id == pid,
            MediaOutcome.kind == kind,
            MediaOutcome.target_id == str(target),
        )
        .order_by(MediaOutcome.created_at.desc(), MediaOutcome.id.desc())
        .limit(1)
    )


def file_ref(db, project, fid, prefix):
    f = db.get(MediaFile, UUID(str(fid)))
    if not f or f.project_id != project.id or not f.mime.startswith(prefix):
        raise HTTPException(409, "素材类型无效或不属于当前项目")
    if not LocalStorage(settings.storage_root).path(f.object_key).is_file():
        raise HTTPException(409, "素材文件缺失，请从备份恢复")
    return {"id": str(f.id), "object_key": f.object_key, "sha256": f.sha256, "mime": f.mime}


def default_draft(db, p):
    value = EditDraft()
    try:
        version = board(db, p)
    except HTTPException:
        return value.model_dump(mode="json")
    clips = []
    for shot in version.body["shots"]:
        video = latest_outcome(db, p.id, "media.video", shot["id"])
        cursor, lines = 0, []
        for line in spoken_lines(shot):
            audio = latest_outcome(db, p.id, "media.audio", line["id"])
            lines.append({"line_id": line["id"], "start": round(cursor, 6)})
            cursor += float(audio.metadata_json["duration"]) if audio else 0
        clips.append(
            {
                "shot_id": shot["id"],
                "video_id": str(video.id) if video else None,
                "trim_start": 0,
                "duration": shot["duration"],
                "lines": lines,
            }
        )
    return EditDraft(board_version_id=version.id, clips=clips).model_dump(mode="json")


def freeze(db, p, draft):
    """Fail closed; a saved draft can remain incomplete without losing edits."""
    version = board(db, p, draft["board_version_id"], confirmed=True)
    if str(version.id) != draft["board_version_id"]:
        raise HTTPException(409, "剪辑来源分镜已更新，请载入当前分镜后重新检查剪辑")
    shots = {s["id"]: s for s in version.body["shots"]}
    ids = [c["shot_id"] for c in draft["clips"]]
    if not ids or len(ids) != len(set(ids)) or set(ids) != set(shots):
        raise HTTPException(409, "剪辑必须完整包含当前分镜且不重复镜头")
    if ids != list(shots) and not draft["continuity_ack"]:
        raise HTTPException(409, "镜头顺序已改变，请确认已检查尾帧连续性与音画同步")
    clips, total, references = [], 0, []
    for index, c in enumerate(draft["clips"]):
        shot = shots[c["shot_id"]]
        context = shot_context(db, p, version, shot, "media.video", require_refs=True)
        references.extend(context["files"])
        video = db.get(MediaOutcome, UUID(c["video_id"])) if c["video_id"] else None
        if (
            not video
            or video.project_id != p.id
            or video.kind != "media.video"
            or video.target_id != c["shot_id"]
        ):
            raise HTTPException(409, f"第{index + 1}镜缺少有效视频")
        if outcome_stale(db, p, video):
            raise HTTPException(409, f"第{index + 1}镜视频已过期或文件失效")
        duration = c["duration"]
        if abs(duration * draft["fps"] - round(duration * draft["fps"])) > 0.001:
            raise HTTPException(409, f"第{index + 1}镜时长须为1/{draft['fps']}秒的整数倍")
        if c["trim_start"] + duration > float(video.metadata_json["duration"]) + 0.001:
            raise HTTPException(409, f"第{index + 1}镜裁剪超出真实视频时长；请缩短或重新生成视频")
        timings = {x["line_id"]: x["start"] for x in c["lines"]}
        if len(timings) != len(c["lines"]) or set(timings) != {x["id"] for x in spoken_lines(shot)}:
            raise HTTPException(409, f"第{index + 1}镜台词列表已变化，请重新载入分镜")
        lines = []
        if draft["narration"] or draft["subtitles"]:
            end = 0
            for line in spoken_lines(shot):
                audio = latest_outcome(db, p.id, "media.audio", line["id"])
                if not audio or outcome_stale(db, p, audio):
                    raise HTTPException(
                        409, f"第{index + 1}镜台词配音缺失或过期：{line['text'][:30]}"
                    )
                length, start = float(audio.metadata_json["duration"]), timings[line["id"]]
                if start + 0.000001 < end:
                    raise HTTPException(409, f"第{index + 1}镜台词重叠，请调整开始时间")
                end = start + length
                if end > duration + 0.000001:
                    raise HTTPException(
                        409,
                        f"第{index + 1}镜台词需要至少{end:.3f}秒，当前{duration:.3f}秒；请调整镜头或配音，禁止截断",
                    )
                lines.append(
                    {
                        "line_id": line["id"],
                        "text": line["text"],
                        "start": start,
                        "duration": length,
                        "outcome_id": str(audio.id),
                        "file": file_ref(db, p, audio.file_id, "audio/"),
                    }
                )
        clips.append(
            {**c, "file": file_ref(db, p, video.file_id, "video/"), "lines": lines, "offset": total}
        )
        total += duration
    if total > 3600:
        raise HTTPException(409, "基础合成单片上限60分钟")
    return {
        "schemaVersion": 1,
        "board_version_id": str(version.id),
        "specification": p.generation_settings,
        "draft": draft,
        "clips": clips,
        "duration": total,
        "references": references,
        "music": file_ref(db, p, draft["music_file_id"], "audio/")
        if draft["music_file_id"]
        else None,
    }


def snapshot_current(db, p, snapshot):
    edit = latest_edit(db, p.id)
    if not edit or str(edit.id) != snapshot["edit_id"]:
        return False
    try:
        return freeze(db, p, edit.draft) == {
            k: snapshot[k]
            for k in (
                "schemaVersion",
                "board_version_id",
                "specification",
                "draft",
                "clips",
                "duration",
                "references",
                "music",
            )
        }
    except (HTTPException, ValueError, TypeError):
        return False


def state(db, p):
    edit = latest_edit(db, p.id)
    draft = edit.draft if edit else default_draft(db, p)
    blockers, timeline = [], []
    try:
        timeline = freeze(db, p, draft)["clips"]
    except HTTPException as e:
        blockers.append(str(e.detail))
    exports = []
    for j in db.scalars(
        select(Job)
        .where(Job.project_id == p.id, Job.kind == "export.render")
        .order_by(Job.created_at.desc())
        .limit(50)
    ):
        result = db.get(JobResult, j.id)
        exports.append(
            {
                "id": str(j.id),
                "state": j.state,
                "error": j.error,
                "created_at": j.created_at.isoformat(),
                "revision": j.snapshot["edit_revision"],
                "stale": not snapshot_current(db, p, j.snapshot),
                "output": result.output if result else None,
            }
        )
    return {
        "revision": edit.revision if edit else 0,
        "draft": draft,
        "specification": p.generation_settings,
        "blockers": blockers,
        "timeline": timeline,
        "exports": exports,
    }


def output_available(db, job):
    import hashlib

    result = db.get(JobResult, job.id)
    file = db.get(MediaFile, UUID(result.output["file_id"])) if result else None
    if not file:
        return False
    path = LocalStorage(settings.storage_root).path(file.object_key)
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == file.sha256


def invalidate_completed(db, pid):
    """Called inside source mutation's existing project lock, after its writes."""
    from shortfilm.models import Project

    project = db.get(Project, pid)
    if not project or project.status != "completed":
        return
    db.flush()
    job = db.scalar(
        select(Job)
        .where(Job.project_id == pid, Job.kind == "export.render", Job.state == "succeeded")
        .order_by(Job.created_at.desc())
        .limit(1)
    )
    if not job or not snapshot_current(db, project, job.snapshot):
        project.status = "in_progress"


def spoken_lines(shot):
    return [line for line in shot["dialogues"] if line["text"].strip()]
