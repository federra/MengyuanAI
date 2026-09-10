"""Atomic project element changes and stable, explicit shot associations."""

from copy import deepcopy
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select

from shortfilm.assets.models import Entity, EntityCommand, EntityVersion, ReferenceImage
from shortfilm.assets.schemas import EntityOut
from shortfilm.assets.service import append_entity, entity_out, entity_version, owned_entity
from shortfilm.creation.service import append_version, current_version, fingerprint
from shortfilm.creation.stage_service import stage_item, upstream, validate_board
from shortfilm.media.models import LineBinding, ShotReferenceVersion
from shortfilm.models import ContentItem

FIELDS = ("name", "description", "voice", "three_view", "input_file_id", "output_file_id")
VISUAL = ("description", "three_view", "input_file_id")
GROUPS = {"character": "characters", "scene": "scenes", "prop": "props"}


def replay(db, pid, key, request):
    record = db.scalar(
        select(EntityCommand).where(EntityCommand.project_id == pid, EntityCommand.key == key)
    )
    if record and record.fingerprint != fingerprint(request):
        raise HTTPException(409, "请求身份已用于其他修改，请核对草稿")
    return record.response if record else None


def remember(db, pid, key, request, response):
    db.add(
        EntityCommand(project_id=pid, key=key, fingerprint=fingerprint(request), response=response)
    )


def current_board(db, pid):
    item = stage_item(db, pid, "board")
    return current_version(db, item) if item and item.revision else None


def check_board(db, pid, expected):
    version = current_board(db, pid)
    if (version.id if version else None) != expected:
        raise HTTPException(409, "分镜版本已变化，请保留草稿并重新载入")
    return version


def ref_entity(db, pid, shot_id, ref_id):
    from shortfilm.creation.board_import_models import pending_reference
    from shortfilm.media.sources import reference_version

    binding = reference_version(db, shot_id, ref_id)
    if binding and binding.entity_id:
        return binding.entity_id
    descriptor = pending_reference(db, pid, shot_id, ref_id)
    if descriptor and descriptor.entity_version_id:
        return db.get(EntityVersion, descriptor.entity_version_id).entity_id
    # Legacy files are not silently guessed to be an entity, even if names match.
    return None


def validate_files(db, project, value):
    from shortfilm.media.sources import checked_file

    for field in ("input_file_id", "output_file_id"):
        if getattr(value, field):
            checked_file(db, project, getattr(value, field))


def save_one(db, project, value):
    entity = db.get(Entity, value.id)
    if entity:
        if entity.project_id != project.id or entity.archived:
            raise HTTPException(404, "项目元素不存在")
        if entity.revision != value.revision:
            raise HTTPException(409, "元素已更新，请保留全部草稿并重新载入")
        if entity.kind != value.kind:
            raise HTTPException(422, "已有元素不能改变类型")
        previous = entity_version(db, entity)
    else:
        if value.revision != 0:
            raise HTTPException(409, "新增元素版本必须为0")
        entity = Entity(id=value.id, project_id=project.id, kind=value.kind, revision=1)
        db.add(entity)
        db.flush()
        previous = None
    if getattr(value, "clear_output", False) and value.output_file_id:
        raise HTTPException(422, "清除图片时不能同时选用输出图片")
    validate_files(db, project, value)
    changed = getattr(value, "clear_output", False) or previous is None or any(
        getattr(previous, field) != getattr(value, field) for field in FIELDS
    )
    if changed:
        if previous:
            entity.revision += 1
        version = append_entity(db, entity, value)
        version._clear_output = getattr(value, "clear_output", False)
        if previous:
            version.library_asset_id = previous.library_asset_id
            version.library_version = previous.library_version
        if value.output_file_id and (
            previous is None or previous.output_file_id != value.output_file_id
        ):
            # A chosen existing generation retains its explicit confirmation only when its
            # visual source still matches. Uploads become new, unconfirmed outputs.
            candidates = db.scalars(
                select(ReferenceImage).where(
                    ReferenceImage.project_id == project.id,
                    ReferenceImage.file_id == value.output_file_id,
                )
            ).all()
            matching = any(
                (source := db.get(EntityVersion, ref.entity_version_id)).entity_id == entity.id
                and all(getattr(source, field) == getattr(version, field) for field in VISUAL)
                for ref in candidates
            )
            if not matching:
                db.add(
                    ReferenceImage(
                        project_id=project.id,
                        entity_version_id=version.id,
                        file_id=value.output_file_id,
                    )
                )
        db.flush()
    else:
        version = previous
    return entity, version, previous if changed else None, changed


def propagate(db, project, version, changes):
    from shortfilm.media.sources import reference_version

    if not version:
        return None, []
    value = deepcopy(version.body)
    affected = set()
    for shot in value["shots"]:
        sid = UUID(shot["id"])
        for refs in shot["refs"].values():
            for ref in refs:
                eid = ref_entity(db, project.id, sid, UUID(ref))
                if eid not in changes:
                    continue
                entity, latest, previous = changes[eid]
                affected.add(sid)
                if previous is not None and (previous.output_file_id != latest.output_file_id or getattr(latest, "_clear_output", False)):
                    old = reference_version(db, sid, ref)
                    db.add(
                        ShotReferenceVersion(
                            project_id=project.id,
                            shot_id=sid,
                            ref_id=UUID(ref),
                            entity_id=eid,
                            file_id=latest.output_file_id,
                            revision=(old.revision if old else 0) + 1,
                        )
                    )
        for line in shot["dialogues"]:
            binding = db.get(LineBinding, UUID(line["id"]))
            if binding and binding.entity_id in changes:
                _, latest, _ = changes[binding.entity_id]
                line["speaker"] = latest.name
                line["voice"] = latest.voice
                affected.add(sid)
        shot["dialogue"] = "\n".join(line["text"] for line in shot["dialogues"] if line["text"])
    db.flush()
    if value != version.body:
        version = append_board(db, project, version, value)
    return version, sorted(affected, key=str)


def append_board(db, project, version, value):
    item = db.get(ContentItem, version.item_id)
    try:
        validated = validate_board(db, item, value, upstream(db, version).id, reserve=True)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return append_version(db, project, item, validated, "manual", version.id)


def response(db, pid, version, affected):
    entities = db.scalars(
        select(Entity)
        .where(Entity.project_id == pid, Entity.archived.is_(False))
        .order_by(Entity.created_at, Entity.id)
    ).all()
    return {
        "entities": [
            EntityOut.model_validate(entity_out(e, entity_version(db, e))).model_dump(mode="json")
            for e in entities
        ],
        "board_version_id": str(version.id) if version else None,
        "affected_shot_ids": [str(s) for s in affected],
    }


def save_batch(db, project, body, key):
    payload = body.model_dump(mode="json")
    # Preserve the exact pre-clear-command fingerprint for outstanding old submissions.
    for item in payload["items"]:
        if not item.get("clear_output"):
            item.pop("clear_output", None)
    request = {"action": "elements.save", **payload}
    old = replay(db, project.id, key, request)
    if old is not None:
        return old
    if len({item.id for item in body.items}) != len(body.items):
        raise HTTPException(422, "元素ID重复")
    version = check_board(db, project.id, body.base_board_version_id)
    changes = {}
    for value in body.items:
        entity, latest, previous, changed = save_one(db, project, value)
        if changed:
            changes[entity.id] = (entity, latest, previous)
    version, affected = propagate(db, project, version, changes)
    from shortfilm.finishing.service import invalidate_completed

    if changes:
        invalidate_completed(db, project.id)
    result = response(db, project.id, version, affected)
    remember(db, project.id, key, request, result)
    db.commit()
    return result


def bind_entity(db, project, eid, body, key):
    from shortfilm.media.sources import reference_version, shot_in

    request = {"action": "element.bind", "entity_id": str(eid), **body.model_dump(mode="json")}
    remembered = replay(db, project.id, key, request)
    if remembered is not None:
        return remembered
    entity = owned_entity(db, project.id, eid)
    if entity.revision != body.entity_revision:
        raise HTTPException(409, "元素版本已变化")
    version = check_board(db, project.id, body.board_version_id)
    if not version:
        raise HTTPException(409, "请先保存分镜")
    value = deepcopy(version.body)
    shot = shot_in(type("Version", (), {"body": value}), body.shot_id)
    group = shot["refs"].setdefault(GROUPS[entity.kind], [])
    if any(ref_entity(db, project.id, body.shot_id, ref) == eid for ref in group):
        raise HTTPException(409, "镜头已引用此元素")
    if body.mode == "replace" and group:
        ref = UUID(group[0])
    else:
        ref = uuid4()
        group.append(str(ref))
        shot["prompt"] = shot["prompt"].rstrip() + f" @[{ref}]"
    latest = entity_version(db, entity)
    old = reference_version(db, body.shot_id, ref)
    db.add(
        ShotReferenceVersion(
            project_id=project.id,
            shot_id=body.shot_id,
            ref_id=ref,
            entity_id=eid,
            file_id=latest.output_file_id,
            revision=(old.revision if old else 0) + 1,
        )
    )
    db.flush()
    version = append_board(db, project, version, value)
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, project.id)
    result = {
        "board_version_id": str(version.id),
        "ref_id": str(ref),
        "affected_shot_ids": [str(body.shot_id)],
    }
    remember(db, project.id, key, request, result)
    db.commit()
    return result


def archive(db, project, eid, revision):
    entity = owned_entity(db, project.id, eid)
    if entity.revision != revision:
        raise HTTPException(409, "元素版本已变化")
    version = current_board(db, project.id)
    used = []
    if version:
        for shot in version.body["shots"]:
            if any(
                ref_entity(db, project.id, shot["id"], ref) == eid
                for refs in shot["refs"].values()
                for ref in refs
            ) or any(
                (binding := db.get(LineBinding, UUID(line["id"]))) and binding.entity_id == eid
                for line in shot["dialogues"]
            ):
                used.append(shot["id"])
    if used:
        raise HTTPException(409, {"message": "该元素仍被镜头引用，请先替换关联", "shot_ids": used})
    entity.archived = True
    db.commit()
    return {"id": eid, "archived": True}
