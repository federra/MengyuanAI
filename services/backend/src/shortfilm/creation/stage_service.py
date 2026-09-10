"""Cross-stage lineage, immutable advisory evidence, and atomic identity validation."""

import re
from copy import deepcopy
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import func, select

from shortfilm.creation.service import current_version, enqueue, selection
from shortfilm.creation.stage_schemas import BoardBody, ScriptBody
from shortfilm.models import (
    ContentConfirmation,
    ContentIdentity,
    ContentItem,
    ContentReview,
    ContentVersion,
    Job,
    MediaFile,
    StorySelection,
)


def upstream(db, version):
    """Follow same-item edits until the immutable cross-stage source is reached."""
    seen = set()
    while version and version.source_version_id:
        if version.id in seen:
            raise ValueError("cyclic source")
        seen.add(version.id)
        parent = db.get(ContentVersion, version.source_version_id)
        if parent.item_id != version.item_id:
            return parent
        version = parent
    return None


def is_stale(db, version):
    parent = upstream(db, version)
    if not parent:
        return False
    item = db.get(ContentItem, parent.item_id)
    if item.revision != parent.revision or is_stale(db, parent):
        return True
    if item.kind == "story":
        selected = selection(db, item.project_id)
        return not selected or selected.version_id != parent.id
    if item.kind == "script":
        confirmed = confirmation(db, item.id)
        return not confirmed or confirmed.version_id != parent.id
    return False


def stage_item(db, pid, stage):
    return db.scalar(
        select(ContentItem).where(ContentItem.project_id == pid, ContentItem.kind == stage)
    )


def confirmation(db, iid):
    return db.scalar(
        select(ContentConfirmation)
        .where(ContentConfirmation.item_id == iid)
        .order_by(ContentConfirmation.created_at.desc(), ContentConfirmation.id.desc())
        .limit(1)
    )


def reports(db, item):
    rows = db.scalars(
        select(ContentReview)
        .where(ContentReview.item_id == item.id)
        .order_by(ContentReview.created_at.desc(), ContentReview.id.desc())
    ).all()
    return [report_out(db, r, item) for r in rows]


def report_out(db, report, item):
    job = db.get(Job, report.job_id) if report.job_id else None
    state = job.state if job else "failed"
    if state in ("queued", "running", "waiting_provider"):
        state = "pending"
    version = db.get(ContentVersion, report.version_id)
    stale = version.revision != item.revision or is_stale(db, version)
    return dict(
        id=report.id,
        version_id=report.version_id,
        source_version_id=report.source_version_id,
        job_id=report.job_id,
        state=state,
        output=report.output,
        error=job.error if job else report.error,
        stale=stale,
        created_at=report.created_at,
    )


def confirm(db, project, item, version_id, decision="keep_current"):
    v = current_version(db, item)
    if v is None or v.id != version_id or is_stale(db, v):
        raise HTTPException(409, "内容或来源已变化，请刷新并更新后确认")
    if item.kind == "board":
        validate_board(db, item, v.body, upstream(db, v).id)
    existing = confirmation(db, item.id)
    rs = reports(db, item)
    latest = rs[0] if rs else None
    report_id = latest["id"] if latest else None
    report_state = ("stale" if latest["stale"] else latest["state"]) if latest else "no_report"
    if item.kind == "story":
        s = selection(db, project.id)
        if not s or s.version_id != v.id:
            db.add(
                StorySelection(
                    project_id=project.id, revision=(s.revision if s else 0) + 1, version_id=v.id
                )
            )
    if (
        existing
        and existing.version_id == v.id
        and existing.decision == decision
        and existing.report_id == report_id
        and existing.report_state == report_state
    ):
        db.flush()
        return existing
    parent = upstream(db, v)
    result = ContentConfirmation(
        item_id=item.id,
        version_id=v.id,
        source_version_id=parent.id if parent else None,
        decision=decision,
        report_id=report_id,
        report_state=report_state,
    )
    db.add(result)
    project.stage = item.kind
    db.flush()
    return result


def canonical_script(body, previous=None, manual=False):
    result = ScriptBody.model_validate(body).model_dump(mode="json")
    if manual and (previous is None or result["text"] != previous["text"]):
        # Plain-text editor is authoritative. Rebuild structure, never retain obsolete scenes.
        paragraphs = [part.strip() for part in result["text"].split("\n\n") if part.strip()]
        result["scenes"] = [
            {"id": str(uuid4()), "heading": f"场景 {i + 1}", "actions": [part], "dialogues": []}
            for i, part in enumerate(paragraphs)
        ]
    elif not manual or result["scenes"] != previous["scenes"]:
        # Unchanged manual structure must retain its authoritative plain text.
        result["text"] = "\n\n".join(
            "\n".join(
                [
                    s["heading"],
                    *s["actions"],
                    *[d["speaker"] + "：" + d["text"] for d in s["dialogues"]],
                ]
            )
            for s in result["scenes"]
        )
    return result


def validate_board(db, item, body, source_id, preserve=None, generated=False, reserve=False):
    value = BoardBody.model_validate(body).model_dump(mode="json")
    if value["scriptId"] != str(source_id):
        raise ValueError("分镜scriptId必须匹配原剧本版本")
    if preserve is not None:
        before = {s["id"]: {line["id"] for line in s["dialogues"]} for s in preserve["shots"]}
        after = {s["id"]: {line["id"] for line in s["dialogues"]} for s in value["shots"]}
        if before != after:
            raise ValueError("完整修复必须保留全部镜头和每镜台词ID集合")
    for shot in value["shots"]:
        refs = [ref for group in shot["refs"].values() for ref in group]
        if len(refs) != len(set(refs)):
            raise ValueError("图片引用重复")
        for ref in refs:
            media = db.get(MediaFile, UUID(ref))
            from shortfilm.creation.board_import_models import pending_reference

            pending = pending_reference(db, item.project_id, shot["id"], ref)
            from shortfilm.media.sources import reference_version
            binding = reference_version(db, shot["id"], ref)
            bound = binding and binding.project_id == item.project_id
            if not pending and not bound and (
                not media
                or media.project_id != item.project_id
                or not media.mime.startswith("image/")
            ):
                raise ValueError("图片引用不存在或不属于本项目及当前镜头")
        if not set(re.findall(r"@\[([^\]]+)\]", shot["prompt"])).issubset(set(refs)):
            raise ValueError("提示词包含未绑定的图片引用")
        if generated:
            shot["id"] = str(uuid4())
            for line in shot["dialogues"]:
                line["id"] = str(uuid4())
        for identifier, kind, parent in [
            (shot["id"], "shot", None),
            *[(line["id"], "line", shot["id"]) for line in shot["dialogues"]],
        ]:
            uid = UUID(identifier)
            old = db.get(ContentIdentity, uid)
            if old and (
                old.item_id != item.id
                or old.kind != kind
                or str(old.parent_id or "") != str(parent or "")
            ):
                raise ValueError("ID已属于其他内容或镜头")
            if reserve and not old:
                db.add(
                    ContentIdentity(
                        id=uid,
                        item_id=item.id,
                        kind=kind,
                        parent_id=UUID(parent) if parent else None,
                    )
                )
    return value


def archive_or_activate(db, project, item, body, source, job, active):
    from shortfilm.creation.service import append_version

    if active:
        return append_version(db, project, item, body, "generation", source, job.id)
    revision = (
        db.scalar(
            select(func.max(ContentVersion.revision)).where(ContentVersion.item_id == item.id)
        )
        or 0
    )
    v = ContentVersion(
        item_id=item.id,
        revision=revision + 1,
        body=body,
        origin="late_generation",
        source_version_id=source,
        job_id=job.id,
    )
    db.add(v)
    db.flush()
    return v


def enqueue_review(db, project, item, version, frozen):
    parent = upstream(db, version)
    if "configuration_error" in frozen:
        db.add(
            ContentReview(
                item_id=item.id,
                version_id=version.id,
                source_version_id=parent.id if parent else None,
                error=frozen["configuration_error"],
            )
        )
        return
    command = {
        "kind": item.kind + ".review",
        "item_id": str(item.id),
        "base_version_id": str(version.id),
    }
    snapshot = {
        **deepcopy(frozen),
        **command,
        "base_revision": version.revision,
        "input": version.body,
        "market": project.market,
        "source": parent.body if parent else None,
        "source_version_id": str(parent.id) if parent else None,
    }
    from shortfilm.creation.snapshots import render_configuration

    try:
        snapshot.update(render_configuration(frozen, snapshot))
    except HTTPException as exc:
        db.add(
            ContentReview(
                item_id=item.id,
                version_id=version.id,
                source_version_id=parent.id if parent else None,
                error=str(exc.detail),
            )
        )
        return
    job = enqueue(db, project, "auto-review:" + str(version.id), command, command["kind"], snapshot)
    db.add(
        ContentReview(
            item_id=item.id,
            version_id=version.id,
            source_version_id=parent.id if parent else None,
            job_id=job.id,
        )
    )
