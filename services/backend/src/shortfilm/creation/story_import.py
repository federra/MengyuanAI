"""Synchronous TXT ingestion, with no provider calls or destructive history writes."""

import re
from uuid import UUID, uuid4

from fastapi import HTTPException
from pydantic import ConfigDict, Field, model_validator
from sqlalchemy import select

from shortfilm.config_models import Binding
from shortfilm.configuration.service import latest
from shortfilm.creation.schemas import StoriesOut
from shortfilm.creation.service import append_version, content_out, fingerprint, selection
from shortfilm.models import ContentItem, ContentVersion, StorySelection
from shortfilm.schemas import DTO


class TxtImport(DTO):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=False)
    filename: str = Field(min_length=1, max_length=255)
    text: str = Field(min_length=1, max_length=1048576)
    expected_story_version_id: UUID | None

    @model_validator(mode="after")
    def valid_txt(self):
        if not self.filename.lower().endswith(".txt"):
            raise ValueError("仅支持 UTF-8 TXT 文件")
        if not self.text.lstrip("\ufeff").strip() or "\x00" in self.text:
            raise ValueError("TXT 正文不能为空或包含二进制内容")
        try:
            size = len(self.text.encode("utf-8"))
        except UnicodeEncodeError:
            raise ValueError("TXT 必须使用有效 UTF-8 编码") from None
        if size > 1048576:
            raise ValueError("TXT 文件不能超过 1MB；全文不会截断")
        return self


def txt_item(db, pid):
    item = db.scalar(
        select(ContentItem)
        .where(ContentItem.project_id == pid, ContentItem.kind == "story")
        .order_by(ContentItem.created_at.desc(), ContentItem.id)
        .limit(1)
    )
    if item:
        first = db.scalar(
            select(ContentVersion).where(
                ContentVersion.item_id == item.id, ContentVersion.revision == 1
            )
        )
        if first and first.origin == "txt_import":
            return item
    return None


def import_txt(db, project, body, key):
    scope = "project:" + str(project.id)
    receipt_key = "txt-import:" + fingerprint(key)
    command_hash = fingerprint(body.model_dump(mode="json"))
    receipt = latest(db, scope, receipt_key)
    if receipt:
        if receipt.value["hash"] != command_hash:
            raise HTTPException(409, "同一幂等键不能导入不同文件或版本")
        return receipt.value["response"]
    from shortfilm.creation.board_import import no_active_generation

    no_active_generation(db, project)
    old = selection(db, project.id)
    if (old.version_id if old else None) != body.expected_story_version_id:
        raise HTTPException(409, "故事选择已变化，请保留文件并刷新后导入")
    title = re.split(r"[/\\]", body.filename)[-1][:-4].strip()[:200] or "导入故事"
    excerpt = re.split(r"[。！？!?\r\n]", body.text.lstrip("\ufeff").strip(), maxsplit=1)[0]
    item = ContentItem(id=uuid4(), project_id=project.id, kind="story", revision=0)
    db.add(item)
    db.flush()
    version = append_version(
        db,
        project,
        item,
        {
            "title": title,
            "logline": excerpt[:1000] or "原文摘录，请编辑",
            "direction": "TXT 导入；标题来自文件名，摘要为原文摘录",
            "text": body.text,
        },
        "txt_import",
    )
    db.add(
        StorySelection(
            project_id=project.id, revision=old.revision + 1 if old else 1, version_id=version.id
        )
    )
    db.flush()
    project.stage = "story"
    from shortfilm.finishing.service import invalidate_completed

    invalidate_completed(db, project.id)
    response = StoriesOut(
        items=[content_out(db, item)],
        total=1,
        source_mode="txt",
        selected_version_id=version.id,
        selection_revision=old.revision + 1 if old else 1,
    ).model_dump(mode="json")
    db.add(
        Binding(
            scope=scope,
            key=receipt_key,
            revision=1,
            value={"hash": command_hash, "response": response},
        )
    )
    db.commit()
    return response
