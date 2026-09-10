from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from shortfilm.creation.schemas import ContentOut
from shortfilm.creation.service import (
    append_version,
    content_out,
    current_version,
    enqueue,
    existing_job,
    owned_item,
)
from shortfilm.creation.snapshots import automatic_configuration, configuration
from shortfilm.creation.stage_schemas import (
    ConfirmationOut,
    ConfirmCreate,
    RepairCreate,
    ReportOut,
    ReviewCreate,
    StageGenerate,
    StageOut,
    StageSave,
)
from shortfilm.creation.stage_service import (
    canonical_script,
    confirm,
    confirmation,
    is_stale,
    report_out,
    reports,
    stage_item,
    upstream,
    validate_board,
)
from shortfilm.db import session
from shortfilm.models import ContentItem, ContentReview, ContentVersion, Message
from shortfilm.projects.router import owned_project
from shortfilm.schemas import JobOut

router = APIRouter(prefix="/projects/{pid}", tags=["creation-stages"])
Stage = Literal["script", "board"]


@router.get("/stages/{stage}", response_model=StageOut)
def get_stage(pid: UUID, stage: Stage, db: Session = Depends(session)):
    owned_project(db, pid)
    item = stage_item(db, pid, stage)
    current = content_out(db, item) if item and item.revision else None
    record = confirmation(db, item.id) if item else None
    return dict(
        item=current,
        confirmation=record
        if record and current and record.version_id == current["version_id"]
        else None,
        reports=reports(db, item) if item else [],
    )


@router.put("/stages/{stage}", response_model=ContentOut)
def save_stage(pid: UUID, stage: Stage, body: StageSave, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    item = stage_item(db, pid, stage)
    if (item.revision if item else 0) != body.revision:
        raise HTTPException(409, "内容已改变，请读取最新版本并合并草稿")
    source = db.get(ContentVersion, body.source_version_id)
    parent = owned_item(db, pid, source.item_id) if source else None
    if not parent or parent.kind != ("story" if stage == "script" else "script"):
        raise HTTPException(409, "来源不属于当前阶段")
    if source.revision != parent.revision or is_stale(db, source):
        raise HTTPException(409, "来源版本已改变")
    previous = current_version(db, item) if item and item.revision else None
    if previous and upstream(db, previous).id != source.id:
        raise HTTPException(409, "不能用人工保存改变既有内容的来源；请重新生成")
    if not item:
        item = ContentItem(id=uuid4(), project_id=pid, kind=stage, revision=0)
        db.add(item)
        db.flush()
    try:
        value = body.body.model_dump(mode="json")
        value = (
            canonical_script(value, previous.body if previous else None, manual=True)
            if stage == "script"
            else validate_board(db, item, value, source.id, reserve=True)
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if not previous or previous.body != value:
        append_version(db, p, item, value, "manual", previous.id if previous else source.id)
    db.commit()
    return content_out(db, item)


@router.post("/stages/{stage}/generate", response_model=JobOut, status_code=202)
def generate_stage(
    pid: UUID,
    stage: Stage,
    body: StageGenerate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    command = {"kind": stage + ".generate", **body.model_dump(mode="json")}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    target = stage_item(db, pid, stage)
    if (target.revision if target else 0) != body.target_revision:
        raise HTTPException(409, "目标版本已变化，请刷新后生成")
    source = db.get(ContentVersion, body.source_version_id)
    source_item = owned_item(db, pid, source.item_id) if source else None
    if not source_item or source_item.kind != ("story" if stage == "script" else "script"):
        raise HTTPException(409, "来源阶段不正确")
    if source_item.revision != source.revision or is_stale(db, source):
        raise HTTPException(409, "来源内容已过期")
    if len(source.body.get("text", "")) > 50000:
        raise HTTPException(422, "全文已保留；超过当前上下文预算，请先确定改编范围并保存故事新版本")
    context = {**command, "input": source.body, "source": source.body, "market": p.market}
    frozen = configuration(db, p, command["kind"], context)
    # This decision and downstream enqueue are a single transaction.
    confirm(db, p, source_item, source.id)
    if not target:
        target = ContentItem(id=uuid4(), project_id=pid, kind=stage, revision=0)
        db.add(target)
        db.flush()
    snapshot = {
        **context,
        **frozen,
        "item_id": str(target.id),
        "review_configuration": automatic_configuration(db, p, stage, context),
    }
    job = enqueue(db, p, idempotency_key, command, command["kind"], snapshot)
    db.commit()
    return job


@router.get("/contents/{iid}/reports", response_model=list[ReportOut])
def list_reports(pid: UUID, iid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return reports(db, owned_item(db, pid, iid))


@router.post("/contents/{iid}/confirm", response_model=ConfirmationOut)
def confirm_content(pid: UUID, iid: UUID, body: ConfirmCreate, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    if item.kind not in ("story", "script", "board"):
        raise HTTPException(422, "当前阶段无需确认")
    try:
        result = confirm(db, p, item, body.version_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    db.commit()
    return result


def content_command(db, p, item, version_id, kind, text="", report_id=None):
    v = current_version(db, item)
    if v is None or v.id != version_id or is_stale(db, v):
        raise HTTPException(409, "内容或来源版本已变化")
    if len(v.body.get("text", "")) > 50000:
        raise HTTPException(422, "全文已保留；超过当前上下文预算，请先确定改编范围并保存故事新版本")
    parent = upstream(db, v)
    context = {
        "kind": kind,
        "item_id": str(item.id),
        "base_version_id": str(v.id),
        "base_revision": v.revision,
        "input": v.body,
        "source": parent.body if parent else None,
        "source_version_id": str(parent.id) if parent else None,
        "market": p.market,
        "text": text,
    }
    if report_id:
        report = db.get(ContentReview, report_id)
        if not report or report.item_id != item.id:
            raise HTTPException(404, "报告不存在")
        state = report_out(db, report, item)
        if report.version_id != v.id or state["stale"] or state["state"] != "succeeded":
            raise HTTPException(409, "修复需要当前版本的完整报告")
        context.update(report_id=str(report_id), report=report.output)
    return context


@router.post("/contents/{iid}/review", response_model=JobOut, status_code=202)
def review_content(
    pid: UUID,
    iid: UUID,
    body: ReviewCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    if item.kind not in ("story", "script", "board"):
        raise HTTPException(422, "当前阶段不支持质检")
    command = {"kind": item.kind + ".review", "item_id": str(iid), **body.model_dump(mode="json")}
    old = existing_job(db, pid, idempotency_key, command)
    if old:
        return old
    context = content_command(db, p, item, body.base_version_id, command["kind"])
    snapshot = {**context, **configuration(db, p, command["kind"], context)}
    job = enqueue(db, p, idempotency_key, command, command["kind"], snapshot)
    db.add(
        ContentReview(
            item_id=iid,
            version_id=body.base_version_id,
            source_version_id=UUID(context["source_version_id"])
            if context["source_version_id"]
            else None,
            job_id=job.id,
        )
    )
    db.commit()
    return job


@router.post("/contents/{iid}/repair", response_model=JobOut, status_code=202)
def repair_content(
    pid: UUID,
    iid: UUID,
    body: RepairCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    if item.kind not in ("story", "script", "board"):
        raise HTTPException(422, "当前阶段不支持修复")
    command = {"kind": item.kind + ".repair", "item_id": str(iid), **body.model_dump(mode="json")}
    old = existing_job(db, pid, idempotency_key, command)
    if old:
        return old
    context = content_command(
        db, p, item, body.base_version_id, command["kind"], body.text, body.report_id
    )
    snapshot = {
        **context,
        **configuration(db, p, command["kind"], context),
        "review_configuration": automatic_configuration(db, p, item.kind, context),
    }
    job = enqueue(db, p, idempotency_key, command, command["kind"], snapshot)
    db.add(Message(item_id=iid, job_id=job.id, role="user", text=body.text or "按完整质检报告修复"))
    db.commit()
    return job
