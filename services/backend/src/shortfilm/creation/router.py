from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from shortfilm.creation import provider
from shortfilm.creation.schemas import (
    BatchCreate,
    ContentOut,
    ConversationOut,
    IdeaSave,
    MessageCreate,
    SelectStory,
    StoriesOut,
    StorySave,
    VersionOut,
)
from shortfilm.creation.service import (
    append_version,
    content_out,
    current_version,
    enqueue,
    existing_job,
    owned_item,
    selection,
)
from shortfilm.db import session
from shortfilm.jobs.service import now
from shortfilm.models import (
    ContentItem,
    ContentVersion,
    Message,
    PromptVersion,
    Proposal,
    StorySelection,
)
from shortfilm.projects.router import owned_project
from shortfilm.schemas import JobOut

router = APIRouter(prefix="/projects/{pid}", tags=["creation"])


@router.get("/idea", response_model=ContentOut | None)
def get_idea(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    item = db.scalar(
        select(ContentItem).where(ContentItem.project_id == pid, ContentItem.kind == "idea")
    )
    return content_out(db, item) if item else None


@router.put("/idea", response_model=ContentOut)
def save_idea(pid: UUID, body: IdeaSave, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    item = db.scalar(
        select(ContentItem).where(ContentItem.project_id == pid, ContentItem.kind == "idea")
    )
    if (item.revision if item else 0) != body.revision:
        raise HTTPException(409, "创意已更新，请读取最新版本并合并草稿")
    if not item:
        item = ContentItem(id=uuid4(), project_id=pid, kind="idea", revision=0)
        db.add(item)
        db.flush()
    old = current_version(db, item)
    if not old or old.body["text"] != body.text:
        append_version(db, p, item, {"text": body.text}, "manual", old.id if old else None)
    db.commit()
    return content_out(db, item)


@router.get("/stories", response_model=StoriesOut)
def list_stories(pid: UUID, offset: int = Query(0, ge=0), db: Session = Depends(session)):
    owned_project(db, pid)
    where = (ContentItem.project_id == pid, ContentItem.kind == "story")
    items = db.scalars(
        select(ContentItem)
        .where(*where)
        .order_by(ContentItem.created_at.desc(), ContentItem.batch_id.desc(), ContentItem.id)
        .offset(offset)
        .limit(3)
    ).all()
    s = selection(db, pid)
    return dict(
        items=[content_out(db, i) for i in items],
        total=db.scalar(select(func.count()).select_from(ContentItem).where(*where)),
        selected_version_id=s.version_id if s else None,
        selection_revision=s.revision if s else 0,
    )


@router.get("/contents/{iid}/versions", response_model=list[VersionOut])
def versions(pid: UUID, iid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    owned_item(db, pid, iid)
    return db.scalars(
        select(ContentVersion)
        .where(ContentVersion.item_id == iid)
        .order_by(ContentVersion.revision.desc())
    ).all()


@router.put("/stories/{iid}", response_model=ContentOut)
def save_story(pid: UUID, iid: UUID, body: StorySave, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    if item.kind != "story":
        raise HTTPException(422, "目标不是故事")
    if item.revision != body.revision:
        raise HTTPException(409, "故事已更新，请读取最新版本并合并草稿")
    old = current_version(db, item)
    if old.body != body.body.model_dump():
        append_version(db, p, item, body.body.model_dump(), "manual", old.id)
    db.commit()
    return content_out(db, item)


@router.post("/stories/{iid}/select", response_model=StoriesOut)
def select_story(pid: UUID, iid: UUID, body: SelectStory, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    old = selection(db, pid)
    if item.kind != "story" or current_version(db, item).id != body.version_id:
        raise HTTPException(409, "请选择当前故事版本")
    if (old.revision if old else 0) != body.selection_revision:
        raise HTTPException(409, "选择已改变，请刷新后重试")
    db.add(
        StorySelection(
            project_id=pid, revision=body.selection_revision + 1, version_id=body.version_id
        )
    )
    p.stage, p.updated_at, p.revision = "story", now(), p.revision + 1
    db.commit()
    return list_stories(pid, 0, db)


def config_or_error():
    try:
        return provider.model_snapshot()
    except provider.ProviderFailure as e:
        raise HTTPException(422, "请先配置服务端文本模型、API 地址和凭据引用：" + e.code) from None


def prompt_snapshot(db, key):
    prompt = db.scalar(
        select(PromptVersion)
        .where(PromptVersion.interaction_key == key)
        .order_by(PromptVersion.revision.desc())
        .limit(1)
    )
    if not prompt or prompt.revision < 2:
        raise HTTPException(422, "请运行种子迁移以安装故事提示词 v2")
    return {
        "id": str(prompt.id),
        "key": key,
        "revision": prompt.revision,
        "template": prompt.template,
        "output_schema": prompt.specification["output_schema"],
    }


@router.post("/story-batches", response_model=JobOut, status_code=202)
def generate(
    pid: UUID,
    body: BatchCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    command = {"kind": "story.generate", **body.model_dump(mode="json")}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    version = db.get(ContentVersion, body.idea_version_id)
    item = owned_item(db, pid, version.item_id) if version else None
    if not item or item.kind != "idea" or item.revision != version.revision:
        raise HTTPException(409, "创意版本已变化，请保存并使用最新版本")
    snapshot = {
        "schemaVersion": 1,
        **command,
        "input": version.body,
        "market": p.market,
        "model": config_or_error(),
        "prompt": prompt_snapshot(db, "novel"),
    }
    job = enqueue(db, p, idempotency_key, command, "story.generate", snapshot)
    db.commit()
    return job


@router.get("/contents/{iid}/conversation", response_model=ConversationOut)
def conversation(pid: UUID, iid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    owned_item(db, pid, iid)
    return dict(
        messages=db.scalars(
            select(Message).where(Message.item_id == iid).order_by(Message.created_at, Message.id)
        ).all(),
        proposals=db.scalars(
            select(Proposal).where(Proposal.item_id == iid).order_by(Proposal.created_at.desc())
        ).all(),
    )


@router.post("/contents/{iid}/messages", response_model=JobOut, status_code=202)
def send_message(
    pid: UUID,
    iid: UUID,
    body: MessageCreate,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    p = owned_project(db, pid, lock=True)
    item = owned_item(db, pid, iid)
    command = {"kind": "story.revise", "item_id": str(iid), **body.model_dump(mode="json")}
    existing = existing_job(db, pid, idempotency_key, command)
    if existing:
        return existing
    version = current_version(db, item)
    if item.kind != "story" or version.id != body.base_version_id:
        raise HTTPException(409, "故事版本已变化，请读取最新内容")
    history = conversation(pid, iid, db)["messages"]
    history_data = [{"role": m.role, "content": m.text} for m in history]
    if sum(len(m["content"]) for m in history_data) > 100000:
        raise HTTPException(422, "对话超过当前上下文预算，请保留故事并开始新的候选")
    snapshot = {
        "schemaVersion": 1,
        **command,
        "input": version.body,
        "market": p.market,
        "history": history_data,
        "model": config_or_error(),
        "prompt": prompt_snapshot(db, "novelRevision"),
    }
    job = enqueue(db, p, idempotency_key, command, "story.revise", snapshot)
    db.add(Message(item_id=iid, job_id=job.id, role="user", text=body.text))
    db.commit()
    return job


@router.post("/proposals/{proposal_id}/apply", response_model=ContentOut)
def apply_proposal(pid: UUID, proposal_id: UUID, db: Session = Depends(session)):
    p = owned_project(db, pid, lock=True)
    proposal = db.get(Proposal, proposal_id)
    if not proposal:
        raise HTTPException(404, "建议不存在")
    item = owned_item(db, pid, proposal.item_id)
    if proposal.applied_version_id:
        # Repeat apply is an acknowledged no-op, never another version.
        result = content_out(db, item)
        return result
    version = current_version(db, item)
    if version.id != proposal.base_version_id:
        raise HTTPException(409, "建议已过期，正文和草稿保留，请重新生成建议")
    v = append_version(
        db,
        p,
        item,
        {**version.body, "text": proposal.output["text"]},
        "proposal",
        version.id,
        proposal.job_id,
    )
    proposal.applied_version_id = v.id
    db.commit()
    return content_out(db, item)
