"""Resolve immutable media inputs and compare only actual downstream dependencies."""

import json
from copy import deepcopy
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.assets.models import Entity, EntityVersion, ReferenceImage
from shortfilm.assets.references import image_out
from shortfilm.assets.service import entity_version
from shortfilm.config import settings
from shortfilm.configuration import credentials
from shortfilm.configuration.service import render_template, resolve
from shortfilm.creation.service import current_version
from shortfilm.creation.stage_service import confirmation, is_stale, stage_item, upstream
from shortfilm.media.models import LineBinding, MediaOutcome, MediaRun, PreviousFrame
from shortfilm.media.storage import LocalStorage
from shortfilm.models import ContentVersion, Job, MediaFile


def board(db, project, version_id=None, confirmed=False):
    item = stage_item(db, project.id, "board")
    version = current_version(db, item) if item else None
    if not version or (version_id and str(version.id) != str(version_id)) or is_stale(db, version):
        raise HTTPException(409, "分镜或上游已变化，请保存有效分镜")
    if confirmed:
        record = confirmation(db, item.id)
        if not record or record.version_id != version.id:
            raise HTTPException(409, "请先确认当前分镜；不要求质检通过")
    return version


def shot_in(version, shot_id):
    shot = next((s for s in version.body["shots"] if s["id"] == str(shot_id)), None)
    if not shot:
        raise HTTPException(404, "镜头不存在")
    return shot


def line_context(db, project, shot, line_id):
    line = next((line for line in shot["dialogues"] if line["id"] == str(line_id)), None)
    if line is None:
        raise HTTPException(404, "台词不存在")
    binding = db.get(LineBinding, UUID(str(line_id)))
    character = db.get(Entity, binding.entity_id) if binding and binding.entity_id else None
    version = entity_version(db, character) if character else None
    return {
        "id": line["id"],
        "text": line["text"],
        "emotion": line["emotion"],
        "speaker": line["speaker"] if not version else "",
        "entity_id": str(character.id) if character else None,
        "voice": version.voice if version else line["voice"],
        "language": project.market,
    }


def checked_file(db, project, fid):
    file = db.get(MediaFile, UUID(str(fid)))
    if not file or file.project_id != project.id or not file.mime.startswith("image/"):
        raise HTTPException(422, "引用图片不存在或不属于当前项目")
    if not LocalStorage(settings.storage_root).path(file.object_key).is_file():
        raise HTTPException(409, "引用图片文件缺失")
    return {
        "id": str(file.id),
        "sha256": file.sha256,
        "mime": file.mime,
        "object_key": file.object_key,
    }


def reference_valid(db, project, fid, seen=None):
    refs = list(
        db.scalars(
            select(ReferenceImage).where(
                ReferenceImage.project_id == project.id, ReferenceImage.file_id == UUID(str(fid))
            )
        )
    )
    if refs:
        return any(image_out(db, project, ref)["confirmed"] for ref in refs)
    output = db.scalar(
        select(MediaOutcome).where(
            MediaOutcome.project_id == project.id, MediaOutcome.file_id == UUID(str(fid))
        )
    )
    if output:
        return output.confirmation_revision == project.generation_settings[
            "revision"
        ] and not outcome_stale(db, project, output, seen)
    parent = db.scalar(
        select(MediaOutcome).where(
            MediaOutcome.project_id == project.id, MediaOutcome.tail_file_id == UUID(str(fid))
        )
    )
    return bool(parent) and not outcome_stale(db, project, parent, seen)


def reference_version(db, shot_id, ref_id):
    from shortfilm.media.models import ShotReferenceVersion

    return db.scalar(
        select(ShotReferenceVersion)
        .where(
            ShotReferenceVersion.shot_id == UUID(str(shot_id)),
            ShotReferenceVersion.ref_id == UUID(str(ref_id)),
        )
        .order_by(ShotReferenceVersion.revision.desc())
        .limit(1)
    )


def shot_context(db, project, version, shot, kind, require_refs=False):
    refs = deepcopy(shot["refs"])
    if kind == "image.position":
        refs.pop("positions", None)
    files = []
    for group_name in ("characters", "scenes", "props", "positions"):
        group = refs.get(group_name, [])
        for fid in group:
            binding = reference_version(db, shot["id"], fid)
            actual = binding.file_id if binding else fid
            file = {
                **checked_file(db, project, actual),
                "ref_id": str(fid),
                "reference_revision": binding.revision if binding else 0,
            }
            if require_refs and not reference_valid(db, project, actual):
                raise HTTPException(409, "参考图未确认或已过期，请重新检查")
            files.append(file)
    source = upstream(db, version)
    result = {
        "shot_id": shot["id"],
        "prompt": shot["prompt"],
        "refs": refs,
        "files": files,
        "duration": shot["duration"],
        "script_version_id": str(source.id) if source else None,
    }

    if kind == "media.video":
        from shortfilm.configuration.service import resolved_project_style

        result["dialogues"] = deepcopy(shot["dialogues"])
        result["style"] = resolved_project_style(db, project)
    return result


def frozen_configuration(db, project, kind, context):
    from shortfilm.creation.provider import ProviderFailure
    from shortfilm.media.providers import validate_route

    key = {
        "image.character": "characterImage",
        "image.scene": "sceneImage",
        "image.prop": "propImage",
        "image.position": "blockingImage",
        "media.audio": "tts",
        "media.video": "video",
    }[kind]
    configuration = resolve(db, project, key, "storyboard")
    if kind == "media.video":
        from shortfilm.media.shot_settings import effective

        configuration.update(effective(db, project, context["shot_id"]))
    model = configuration["model"]["value"]
    capability = "image" if kind.startswith("image.") else kind.split(".")[1]
    if not model or model.get("capability") != capability:
        raise HTTPException(422, "请先在设置页面配置对应媒体模型")
    try:
        model = validate_route(model, capability)
        meta = credentials.metadata(model["credential_ref"], model["endpoint"])
        if not meta["configured"]:
            raise credentials.CredentialError("media_credential_missing")
        model = {**model, "credential_revision": meta["revision"]}
    except (credentials.CredentialError, ProviderFailure):
        raise HTTPException(422, "媒体模型能力或凭据不可用，请在设置页面检查") from None
    template, style = configuration["template"], configuration["style"]
    variables = {
        **context,
        "market": project.market,
        "specification": configuration["specification"],
        "current_content": context,
        "input": context,
        "source": context,
        "user_instruction": context.get("instruction", ""),
    }
    variables = {
        k: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        for k, v in variables.items()
    }
    rendered = (
        render_template(template["content"], variables, template["required_variables"])
        if template
        else ""
    )
    prompt = (
        rendered
        + "\n"
        + (style["content"] if style else "")
        + "\n"
        + json.dumps(context, ensure_ascii=False)
    )
    return {
        "kind": kind,
        "configuration": configuration,
        "model": model,
        "specification": deepcopy(configuration["specification"]),
        "compiler_version": 2,
        "prompt": prompt,
    }


def latest_video(db, project, shot_id):
    candidates = db.scalars(
        select(MediaOutcome)
        .join(Job, Job.id == MediaOutcome.job_id)
        .where(
            MediaOutcome.project_id == project.id,
            MediaOutcome.kind == "media.video",
            MediaOutcome.target_id == str(shot_id),
        )
        .order_by(Job.created_at.desc(), Job.id.desc())
    )
    return next((output for output in candidates if not outcome_stale(db, project, output)), None)


def previous_binding(db, project, shot_id):
    return db.scalar(
        select(PreviousFrame)
        .where(PreviousFrame.project_id == project.id, PreviousFrame.shot_id == UUID(str(shot_id)))
        .order_by(PreviousFrame.created_at.desc(), PreviousFrame.id.desc())
        .limit(1)
    )


def previous_context(output):
    return {
        "previousShotId": output.target_id,
        "previousVideoVersionId": str(output.id),
        "frameAssetVersionId": str(output.tail_file_id),
        "refId": str(output.tail_file_id),
    }


def previous_valid(db, project, version, shot_id, previous, seen=None):
    shots = [s["id"] for s in version.body["shots"]]
    if str(shot_id) not in shots:
        return False
    index = shots.index(str(shot_id))
    if index == 0 or shots[index - 1] != previous["previousShotId"]:
        return False
    output = latest_video(db, project, shots[index - 1])
    return (
        bool(output)
        and str(output.id) == previous["previousVideoVersionId"]
        and str(output.tail_file_id) == previous["refId"]
        and not outcome_stale(db, project, output, seen)
    )


def source_stale(db, project, snapshot, previous=None, seen=None):
    kind = snapshot["kind"]
    if (
        kind != "media.audio"
        and snapshot["specification"]["revision"] != project.generation_settings["revision"]
    ):
        return True
    try:
        for file in snapshot.get("files", []):
            if checked_file(db, project, file["id"]) != {
                key: file[key] for key in ("id", "sha256", "mime", "object_key")
            }:
                return True
        if snapshot.get("entity_version_id"):
            source = db.get(EntityVersion, UUID(snapshot["entity_version_id"]))
            entity = db.get(Entity, source.entity_id)
            current = entity_version(db, entity)
            return any(
                getattr(source, key) != getattr(current, key)
                for key in ("description", "three_view")
            )
        version = board(db, project)
        shot = shot_in(version, snapshot["shot_id"])
        original = db.get(ContentVersion, UUID(snapshot["board_version_id"]))
        if (upstream(db, original).id if upstream(db, original) else None) != (
            upstream(db, version).id if upstream(db, version) else None
        ):
            return True
        if kind == "media.audio":
            return snapshot["input"] != line_context(db, project, shot, snapshot["target_id"])
        current = shot_context(db, project, version, shot, kind)
        if snapshot.get("compiler_version", 1) < 2:
            # Legacy compilers used JSONB object order. Preserve their comparison order;
            # immutable supplier snapshots remain untouched, and changed refs still differ.
            original_order = {
                f.get("ref_id", f["id"]): i
                for i, f in enumerate(snapshot["input"].get("files", []))
            }
            current["files"].sort(
                key=lambda f: original_order.get(f.get("ref_id", f["id"]), len(original_order))
            )
        if kind == "media.video":
            if snapshot.get("compiler_version", 1) < 2:
                current.pop("dialogues", None)
                current.pop("style", None)
            from shortfilm.media.shot_settings import effective

            active = effective(db, project, shot["id"])
            if active["model"]["value"] != snapshot["configuration"]["model"]["value"] or any(
                active["specification"][k] != snapshot["specification"][k]
                for k in ("aspect_ratio", "resolution")
            ):
                return True
        if current != snapshot["input"]:
            return True
        if kind == "media.video" and any(
            not reference_valid(db, project, file["id"], seen) for file in snapshot["files"]
        ):
            return True
        return bool(previous) and not previous_valid(
            db, project, version, shot["id"], previous, seen
        )
    except (HTTPException, ValueError, AttributeError):
        return True


def outcome_stale(db, project, output, seen=None):
    seen = set(seen or ())
    if output.id in seen:
        return True
    seen.add(output.id)
    job, run = db.get(Job, output.job_id), db.get(MediaRun, output.job_id)
    if run.cancelled:
        return True
    for fid in (output.file_id, output.tail_file_id):
        if fid:
            media = db.get(MediaFile, fid)
            if (
                not media
                or not LocalStorage(settings.storage_root).path(media.object_key).is_file()
            ):
                return True
    return source_stale(db, project, job.snapshot, run.previous, seen)
