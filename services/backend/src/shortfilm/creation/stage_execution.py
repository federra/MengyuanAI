"""Semantic validation occurs within the bounded correction loop, before persistence."""

from uuid import UUID

from sqlalchemy import select

from shortfilm.creation.schemas import BatchOutput, RevisionOutput, StoryBody
from shortfilm.creation.stage_schemas import (
    BoardBody,
    BoardReviewOutput,
    BodyProposal,
    ReviewOutput,
    ScriptBody,
)
from shortfilm.creation.stage_service import (
    archive_or_activate,
    canonical_script,
    enqueue_review,
    is_stale,
    validate_board,
)
from shortfilm.models import ContentItem, ContentReview, ContentVersion, Message, Proposal


def schema_for(kind):
    if kind == "story.generate":
        return BatchOutput
    if kind in ("story.revise", "idea.revise"):
        return RevisionOutput
    if kind == "script.generate":
        return ScriptBody
    if kind == "board.generate":
        return BoardBody
    if kind.endswith(".review"):
        return BoardReviewOutput if kind.startswith("board.") else ReviewOutput
    return BodyProposal


def validate_output(db, snapshot, raw):
    kind = snapshot["kind"]
    result = schema_for(kind).model_validate(raw).model_dump(mode="json")
    if kind == "script.generate":
        return canonical_script(result)
    if kind == "board.generate":
        item = db.get(ContentItem, UUID(snapshot["item_id"]))
        return validate_board(db, item, result, UUID(snapshot["source_version_id"]), generated=True)
    if kind.endswith((".revise", ".repair")) and kind not in ("story.revise", "idea.revise"):
        stage = kind.split(".")[0]
        if stage == "script":
            result["body"] = canonical_script(result["body"])
        elif stage == "story":
            result["body"] = StoryBody.model_validate(result["body"]).model_dump(mode="json")
        else:
            item = db.get(ContentItem, UUID(snapshot["item_id"]))
            result["body"] = validate_board(
                db,
                item,
                result["body"],
                UUID(snapshot["source_version_id"]),
                preserve=snapshot["input"],
            )
        issue_ids = {i["id"] for i in (snapshot.get("report") or {}).get("issues", [])}
        if not set(result["resolvedIssueIds"]).issubset(issue_ids):
            raise ValueError("修复引用了不存在的问题ID")
    if kind == "board.review":
        if result["baseBoardVersion"] != snapshot["base_revision"]:
            raise ValueError("报告分镜源版本不匹配")
        item = db.get(ContentItem, UUID(snapshot["item_id"]))
        validate_board(
            db,
            item,
            {"schemaVersion": 2, "scriptId": result["scriptId"], "shots": result["proposedShots"]},
            UUID(snapshot["source_version_id"]),
            preserve=snapshot["input"],
        )
        shots = {
            s["id"]: {line["id"] for line in s["dialogues"]} for s in snapshot["input"]["shots"]
        }
        for issue in result["issues"]:
            if issue["shotId"] is not None and issue["shotId"] not in shots:
                raise ValueError("报告引用未知镜头")
            if issue["lineId"] is not None and (
                issue["shotId"] is None or issue["lineId"] not in shots[issue["shotId"]]
            ):
                raise ValueError("报告引用未知台词")
    return result


def save_stage_output(db, project, job, output):
    kind = job.kind
    item = db.get(ContentItem, UUID(job.snapshot["item_id"]))
    if kind.endswith(".review"):
        report = db.scalar(select(ContentReview).where(ContentReview.job_id == job.id))
        report.output = output
    elif kind.endswith(".generate"):
        source = db.get(ContentVersion, UUID(job.snapshot["source_version_id"]))
        source_item = db.get(ContentItem, source.item_id)
        active = (
            item.revision == job.snapshot["target_revision"]
            and source_item.revision == source.revision
            and not is_stale(db, source)
        )
        # A different chosen story/script while this job ran invalidates its target.
        from shortfilm.creation.stage_service import confirmation

        confirmed = confirmation(db, source_item.id)
        active = active and confirmed is not None and confirmed.version_id == source.id
        if source_item.kind == "story":
            from shortfilm.creation.service import selection

            chosen = selection(db, project.id)
            active = active and chosen is not None and chosen.version_id == source.id
        if item.kind == "board":
            output = validate_board(db, item, output, source.id, reserve=True)
        v = archive_or_activate(db, project, item, output, source.id, job, active)
        enqueue_review(db, project, item, v, job.snapshot["review_configuration"])
    else:
        db.add(
            Proposal(
                item_id=item.id,
                job_id=job.id,
                base_version_id=UUID(job.snapshot["base_version_id"]),
                output=output,
            )
        )
        db.add(
            Message(item_id=item.id, job_id=job.id, role="assistant", text=output["changeSummary"])
        )
