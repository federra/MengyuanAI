"""Atomic full-board import with persisted previews and advisory post-commit jobs."""

import re
from copy import deepcopy
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from shortfilm.assets.models import Entity, EntityVersion
from shortfilm.creation.board_import_contract import SCHEMA, TEMPLATE, parse_package, statistics
from shortfilm.creation.board_import_models import (
    BoardImportAsset,
    BoardImportCommit,
    BoardImportPreview,
)
from shortfilm.creation.schemas import ContentOut
from shortfilm.creation.service import append_version, content_out, current_version, fingerprint
from shortfilm.creation.snapshots import automatic_configuration
from shortfilm.creation.stage_schemas import Shot
from shortfilm.creation.stage_service import (
    confirmation,
    enqueue_review,
    is_stale,
    stage_item,
    validate_board,
)
from shortfilm.db import session
from shortfilm.media.shot_settings import import_overrides, persist
from shortfilm.models import ContentIdentity, ContentItem, Job
from shortfilm.projects.router import owned_project
from shortfilm.schemas import DTO

router = APIRouter(prefix="/projects/{pid}/storyboard/import", tags=["storyboard-import"])


class PreviewRequest(DTO):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=False)
    sourceScriptVersionId: UUID
    baseBoardVersionId: UUID | None
    packageJson: str = Field(min_length=1, max_length=1048576)


class CommitRequest(DTO):
    previewId: UUID
    contentHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    sourceScriptVersionId: UUID
    baseBoardVersionId: UUID | None


class ImportStatistics(DTO):
    shots: int
    dialogues: int
    assets: int
    totalSeconds: float


class PreviewOut(DTO):
    previewId: UUID
    contentHash: str
    sourceScriptVersionId: UUID
    baseBoardVersionId: UUID | None
    stats: ImportStatistics
    warnings: list[str]


class AssetOut(DTO):
    id: UUID
    shot_id: UUID
    entity_version_id: UUID | None
    kind: str
    name: str
    description: str


class CommitOut(DTO):
    boardVersionId: UUID
    sourceScriptVersionId: UUID
    item: ContentOut
    shots: list[Shot]
    idMapping: dict[str, str]
    assets: list[AssetOut]
    stats: ImportStatistics


def sources(db, project, script_id, base_id):
    script = stage_item(db, project.id, "script")
    source = current_version(db, script) if script and script.revision else None
    confirmed = confirmation(db, script.id) if script else None
    if (
        not source
        or source.id != script_id
        or is_stale(db, source)
        or not confirmed
        or confirmed.version_id != source.id
    ):
        raise HTTPException(409, "导入需要当前已确认的剧本；来源已变化请重新预检")
    item = stage_item(db, project.id, "board")
    current = current_version(db, item) if item and item.revision else None
    if (current.id if current else None) != base_id:
        raise HTTPException(409, "分镜版本已变化，请保留文件并重新预检")
    return source, item


def no_active_generation(db, project):
    active = db.scalar(
        select(Job.id)
        .where(
            Job.project_id == project.id,
            Job.state.in_(
                ("queued", "running", "waiting_provider", "waiting_dependency", "unknown")
            ),
            ~Job.kind.endswith(".review"),
        )
        .limit(1)
    )
    if active:
        raise HTTPException(409, "生成任务尚未结束，请先完成或取消任务后导入；暂停中的任务仍需处理")


@router.get("/template")
def template(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return TEMPLATE


@router.get("/schema")
def schema(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    return SCHEMA


@router.get("/assets", response_model=list[AssetOut])
def assets(pid: UUID, db: Session = Depends(session)):
    owned_project(db, pid)
    item = stage_item(db, pid, "board")
    version = current_version(db, item) if item and item.revision else None
    if not version:
        return []
    shots = [UUID(s["id"]) for s in version.body["shots"]]
    return list(
        db.scalars(
            select(BoardImportAsset)
            .where(BoardImportAsset.project_id == pid, BoardImportAsset.shot_id.in_(shots))
            .order_by(BoardImportAsset.created_at, BoardImportAsset.id)
        )
    )


@router.post("/preview", response_model=PreviewOut)
def preview(pid: UUID, body: PreviewRequest, db: Session = Depends(session)):
    project = owned_project(db, pid, lock=True)
    package = parse_package(body.packageJson)
    sources(db, project, body.sourceScriptVersionId, body.baseBoardVersionId)
    no_active_generation(db, project)
    overrides = {
        s["id"]: import_overrides(db, project, s.get("generation", {})) for s in package["shots"]
    }
    row = BoardImportPreview(
        project_id=pid,
        source_version_id=body.sourceScriptVersionId,
        base_version_id=body.baseBoardVersionId,
        content_hash=fingerprint(package),
        package=package,
        overrides=overrides,
    )
    db.add(row)
    db.flush()
    result = dict(
        previewId=row.id,
        contentHash=row.content_hash,
        sourceScriptVersionId=row.source_version_id,
        baseBoardVersionId=row.base_version_id,
        stats=statistics(package),
        warnings=[
            "导入将整体替换当前分镜；图片描述待制作，旧媒体保留历史。",
            "导入成功后自动发起建议质检，会使用已配置文本模型；质检失败不撤销导入。",
        ],
    )
    db.commit()
    return result


def existing_result(db, pid, key, command=None):
    row = db.scalar(
        select(BoardImportCommit).where(
            BoardImportCommit.project_id == pid, BoardImportCommit.key == key
        )
    )
    if row and command is not None and row.fingerprint != fingerprint(command):
        raise HTTPException(409, "同一幂等键不能用于不同导入")
    return db.get(BoardImportPreview, row.preview_id).result if row else None


@router.get("/commits/{idempotency_key}", response_model=CommitOut)
def get_commit(pid: UUID, idempotency_key: str, db: Session = Depends(session)):
    owned_project(db, pid)
    result = existing_result(db, pid, idempotency_key)
    if not result:
        raise HTTPException(404, "未找到已提交的导入，请用原幂等键重试")
    return result


def build_body(db, item, package, source_id):
    mapping = {
        identifier: str(uuid4())
        for s in package["shots"]
        for identifier in [
            s["id"],
            *[a["id"] for a in s["assets"]],
            *[d["id"] for d in s["dialogues"]],
        ]
    }
    groups = {"角色": "characters", "场景": "scenes", "道具": "props", "站位": "positions"}
    shots = []
    for s in package["shots"]:
        sid = mapping[s["id"]]
        lines = [{**line, "id": mapping[line["id"]]} for line in s["dialogues"]]
        refs = {g: [] for g in groups.values()}
        for asset in s["assets"]:
            if asset["id"] in s["bindings"]["assetIds"]:
                refs[groups[asset["kind"]]].append(mapping[asset["id"]])
        shots.append(
            {
                "id": sid,
                "duration": s["duration"],
                "prompt": re.sub(
                    r"@\[([^\]]+)\]", lambda match: "@[" + mapping[match[1]] + "]", s["prompt"]
                ),
                "dialogues": lines,
                "dialogue": "\n".join(line["text"].strip() for line in lines).strip(),
                "refs": refs,
            }
        )
        db.add(ContentIdentity(id=UUID(sid), item_id=item.id, kind="shot"))
        for line in lines:
            db.add(
                ContentIdentity(
                    id=UUID(line["id"]), item_id=item.id, parent_id=UUID(sid), kind="line"
                )
            )
    return {"schemaVersion": 2, "scriptId": str(source_id), "shots": shots}, mapping


def create_descriptions(db, project, version, package, mapping):
    kinds = {"角色": "character", "场景": "scene", "道具": "prop"}
    rows = []
    for shot in package["shots"]:
        for asset in shot["assets"]:
            entity_version = None
            if asset["kind"] in kinds:
                entity = Entity(
                    id=uuid4(), project_id=project.id, kind=kinds[asset["kind"]], revision=1
                )
                db.add(entity)
                db.flush()
                entity_version = EntityVersion(
                    id=uuid4(),
                    entity_id=entity.id,
                    revision=1,
                    name=asset["name"],
                    description=asset["description"],
                    voice="",
                    three_view=False,
                )
                db.add(entity_version)
                db.flush()
            row = BoardImportAsset(
                id=UUID(mapping[asset["id"]]),
                project_id=project.id,
                board_version_id=version.id,
                shot_id=UUID(mapping[shot["id"]]),
                entity_version_id=entity_version.id if entity_version else None,
                kind=asset["kind"],
                name=asset["name"],
                description=asset["description"],
            )
            rows.append(row)
            db.add(row)
    db.flush()
    return rows


@router.post("/commit", response_model=CommitOut)
def commit(
    pid: UUID,
    body: CommitRequest,
    idempotency_key: str = Header(min_length=1, max_length=128),
    db: Session = Depends(session),
):
    project = owned_project(db, pid, lock=True)
    command = body.model_dump(mode="json")
    old = existing_result(db, pid, idempotency_key, command)
    if old:
        return old
    row = db.scalar(
        select(BoardImportPreview)
        .where(BoardImportPreview.id == body.previewId, BoardImportPreview.project_id == pid)
        .with_for_update()
    )
    if not row:
        raise HTTPException(404, "预检记录不存在")
    if (
        row.content_hash != body.contentHash
        or row.source_version_id != body.sourceScriptVersionId
        or row.base_version_id != body.baseBoardVersionId
        or fingerprint(row.package) != row.content_hash
    ):
        raise HTTPException(409, "文件或预检基准已变化，请重新预检")
    if row.result:
        db.add(
            BoardImportCommit(
                project_id=pid,
                preview_id=row.id,
                key=idempotency_key,
                fingerprint=fingerprint(command),
            )
        )
        db.commit()
        return row.result
    source, item = sources(db, project, row.source_version_id, row.base_version_id)
    no_active_generation(db, project)
    for shot in row.package["shots"]:
        if import_overrides(db, project, shot.get("generation", {})) != row.overrides[shot["id"]]:
            raise HTTPException(409, "单镜模型配置已变化，请重新预检")
    if not item:
        item = ContentItem(id=uuid4(), project_id=pid, kind="board", revision=0)
        db.add(item)
        db.flush()
    value, mapping = build_body(db, item, row.package, source.id)
    version = append_version(db, project, item, value, "json_import", source.id)
    descriptions = create_descriptions(db, project, version, row.package, mapping)
    version.body = validate_board(db, item, value, source.id)
    for shot in row.package["shots"]:
        overrides = row.overrides[shot["id"]]
        if overrides:
            persist(db, project, version.id, UUID(mapping[shot["id"]]), 0, overrides)
    project.stage = "board"
    context = {"input": version.body, "source": source.body, "market": project.market}
    enqueue_review(
        db, project, item, version, automatic_configuration(db, project, "board", context)
    )
    db.flush()
    result = CommitOut(
        boardVersionId=version.id,
        sourceScriptVersionId=source.id,
        item=content_out(db, item),
        shots=version.body["shots"],
        idMapping=mapping,
        assets=[AssetOut.model_validate(a) for a in descriptions],
        stats=statistics(row.package),
    ).model_dump(mode="json")
    row.result = deepcopy(result)
    db.add(
        BoardImportCommit(
            project_id=pid, preview_id=row.id, key=idempotency_key, fingerprint=fingerprint(command)
        )
    )
    db.commit()
    return result
