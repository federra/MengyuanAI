from copy import deepcopy
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from shortfilm.config import settings
from shortfilm.config_models import Binding, Resource, ResourceVersion
from shortfilm.configuration.schemas import ModelRoute, OutputSpecification, ResourceCreate
from shortfilm.models import Project, PromptVersion


def latest(db, scope, key):
    return db.scalar(
        select(Binding)
        .where(Binding.scope == scope, Binding.key == key)
        .order_by(Binding.revision.desc())
        .limit(1)
    )


def binding_json(b):
    return {"revision": b.revision if b else 0, "value": deepcopy(b.value) if b else None}


def resource_json(db, rid, revision=None):
    r = db.get(Resource, rid)
    if not r:
        raise HTTPException(404, "资源不存在")
    v = db.scalar(
        select(ResourceVersion).where(
            ResourceVersion.resource_id == rid, ResourceVersion.revision == (revision or r.revision)
        )
    )
    if not v:
        raise HTTPException(404, "资源版本不存在")
    return {
        "id": str(r.id),
        "kind": r.kind,
        "stage": r.stage,
        "name": v.name,
        "revision": v.revision,
        "content": v.content,
        "required_variables": v.required_variables,
    }


def append_resource(db, body, resource=None):
    if resource is None:
        resource = Resource(name=body.name, kind=body.kind, stage=body.stage, revision=1)
        db.add(resource)
        db.flush()
    else:
        resource.name = body.name
        resource.revision += 1
    db.add(
        ResourceVersion(
            resource_id=resource.id,
            revision=resource.revision,
            name=body.name,
            content=body.content,
            required_variables=body.required_variables,
        )
    )
    db.flush()
    return resource


def specification(value, revision=1, source="project"):
    spec = OutputSpecification.model_validate(value).model_dump(mode="json")
    short = {"720P": 720, "1080P": 1080, "4K": 2160}[spec["resolution"]]
    spec["width"], spec["height"] = {
        "9:16": (short, short * 16 // 9),
        "16:9": (short * 16 // 9, short),
        "1:1": (short, short),
    }[spec["aspect_ratio"]]
    return {**spec, "revision": revision, "source": source}


def capability(key):
    if key.startswith(("image.", "reference.")) or key in (
        "characterImage",
        "sceneImage",
        "propImage",
        "costumeImage",
        "clothingImage",
        "blockingImage",
        "image",
    ):
        return "image"
    if key.startswith("video.") or key == "video":
        return "video"
    if key.startswith(("audio.", "tts.", "music.")) or key in ("tts", "voice", "music"):
        return "audio"
    return "text"


def validate_binding(db, key, value):
    if key not in (
        "output",
        "style",
        "method:story",
        "method:script",
        "method:storyboard",
    ) and not key.startswith(("model:category:", "model:step:", "scenario:")):
        raise HTTPException(422, "未知配置键")
    if value is None:
        return
    if key.startswith("model:"):
        route = ModelRoute.model_validate(value)
        expected = (
            key.split(":", 2)[2]
            if key.startswith("model:category:")
            else capability(key.split(":", 2)[2])
        )
        if route.capability != expected:
            raise HTTPException(422, "模型能力不匹配")
    elif key == "output":
        output = OutputSpecification.model_validate(value)
        if output.style_resource_id:
            validate_binding(db, "style", {"resource_id": str(output.style_resource_id)})
    elif key.startswith(("method:", "scenario:")) or key == "style":
        if set(value) - {"resource_id", "revision", "content"}:
            raise HTTPException(422, "不支持的绑定字段")
        if "revision" in value and (type(value["revision"]) is not int or value["revision"] < 1):
            raise HTTPException(422, "资源版本必须为正整数")
        try:
            resource = resource_json(db, UUID(value["resource_id"]), value.get("revision"))
        except (KeyError, ValueError):
            raise HTTPException(422, "资源ID无效") from None
        if key.startswith("method:") and (
            resource["kind"] not in ("skill", "prompt") or resource["stage"] != key.split(":")[1]
        ):
            raise HTTPException(422, "方法适用环节不匹配")
        if key.startswith("scenario:") and resource["kind"] != "prompt":
            raise HTTPException(422, "场景必须绑定提示词")
        if key == "style" and resource["kind"] != "style":
            raise HTTPException(422, "风格资源类型不匹配")
        if "content" in value:
            ResourceCreate(
                name=resource["name"],
                kind=resource["kind"],
                stage=resource["stage"],
                content=value["content"],
                required_variables=resource["required_variables"],
            )
    else:
        raise HTTPException(422, "未知配置键")


def save_binding(db, scope, key, base_version, value):
    # Advisory lock covers the absent-row case too; all revisions remain append-only.
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": scope + "/" + key}
    )
    previous = latest(db, scope, key)
    if (previous.revision if previous else 0) != base_version:
        raise HTTPException(409, "配置已更新，请合并草稿")
    validate_binding(db, key, value)
    b = Binding(scope=scope, key=key, revision=base_version + 1, value=value)
    db.add(b)
    db.flush()
    return b


def resolved_resource(db, project, key):
    b = latest(db, "project:" + str(project.id), key)
    source = "project"
    if not b or b.value is None:
        b, source = latest(db, "system", key), "system"
    if not b or b.value is None:
        return None
    result = resource_json(db, UUID(b.value["resource_id"]), b.value.get("revision"))
    if "content" in b.value:
        result["content"] = b.value["content"]
    return {**result, "binding_revision": b.revision, "source": source}


def resolve(db: Session, project: Project, key: str, stage: str):
    """JSON snapshot: model{value,revision,source}, template/method/style resource snapshots, specification.

    No credential values are accessed. Consumers must validate route availability at submission.
    Call inside their transaction after locking the owned project; persist returned JSON in Job.snapshot.
    """
    cap = capability(key)
    b = latest(db, "system", "model:step:" + key)
    source = "step_override"
    if not b or b.value is None:
        b, source = latest(db, "system", "model:category:" + cap), "category_default"
    model = {**binding_json(b), "source": source if b and b.value else "unconfigured"}
    spec = deepcopy(project.generation_settings or {})
    if cap == "video" and spec.get("video_model"):
        model = {"value": spec["video_model"], "revision": spec["revision"], "source": "project"}
    return {
        "schema_version": 1,
        "interaction_key": key,
        "model": model,
        "template": resolved_resource(db, project, "scenario:" + key),
        "method": resolved_resource(db, project, "method:" + stage)
        if stage in ("story", "script", "storyboard")
        else None,
        "style": resolved_project_style(db, project),
        "specification": spec,
    }


def seed_configuration(db):
    from shortfilm.configuration.style_seeds import seed_styles

    seed_styles(db)
    if not latest(db, "system", "output"):
        db.add(
            Binding(
                scope="system",
                key="output",
                revision=1,
                value=OutputSpecification().model_dump(mode="json"),
            )
        )
    if not latest(db, "system", "model:category:text"):
        db.add(
            Binding(
                scope="system",
                key="model:category:text",
                revision=1,
                value={
                    "provider": "deepseek",
                    "model": settings.text_model,
                    "endpoint": settings.text_endpoint,
                    "capability": "text",
                    "credential_ref": settings.text_credential_ref,
                    "timeout_seconds": settings.text_timeout_seconds,
                },
            )
        )
    for stage, names in {
        "story": ["人物弧光故事法", "悬念反转故事法"],
        "script": ["三幕分场剧本法", "忠于原作改编法"],
        "storyboard": ["连续动作分镜法", "画面节奏分镜法"],
    }.items():
        for name in names:
            rid = uuid5(NAMESPACE_URL, "shortfilm:method:" + name)
            if not db.get(Resource, rid):
                r = Resource(id=rid, name=name, kind="skill", stage=stage, revision=1)
                db.add(r)
                db.flush()
                db.add(
                    ResourceVersion(
                        resource_id=rid,
                        revision=1,
                        name=name,
                        content=f"采用{name}：明确人物目标、冲突和结果；保持原作事实与角色动机一致；将信息转为可拍摄动作；检查前后因果、空间连续及节奏。",
                        required_variables=[],
                    )
                )
    keys = db.scalars(select(PromptVersion.interaction_key).distinct()).all()
    aliases = {"novel": "story.generate", "novelRevision": "story.revise"}
    for key in keys:
        prompt = db.scalar(
            select(PromptVersion)
            .where(PromptVersion.interaction_key == key)
            .order_by(PromptVersion.revision.desc())
            .limit(1)
        )
        rid = uuid5(NAMESPACE_URL, "shortfilm:scenario:" + key)
        if not db.get(Resource, rid):
            db.add(Resource(id=rid, name="场景·" + key, kind="prompt", stage=key, revision=1))
            db.flush()
            db.add(
                ResourceVersion(
                    resource_id=rid,
                    revision=1,
                    name="场景·" + key,
                    content=prompt.template,
                    required_variables=[],
                )
            )
        for target in {key, aliases.get(key, key)}:
            if not latest(db, "system", "scenario:" + target):
                db.add(
                    Binding(
                        scope="system",
                        key="scenario:" + target,
                        revision=1,
                        value={"resource_id": str(rid)},
                    )
                )
    db.flush()


def render_template(content: str, variables: dict, required_variables: list[str] | None = None):
    """Expand {{identifier}} once, without evaluating expressions or recursively interpreting inputs."""
    import re

    required = set(required_variables or []) | set(
        re.findall(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}", content)
    )
    if any(key not in variables or variables[key] is None for key in required):
        raise HTTPException(422, "缺少模板变量")
    return re.sub(
        r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}", lambda m: str(variables[m.group(1)]), content
    )


def sync_style_binding(db, project, style_id):
    """Project specification owns style identity; binding retains optional version/body selection."""
    previous = latest(db, "project:" + str(project.id), "style")
    previous_id = previous.value.get("resource_id") if previous and previous.value else None
    target_id = str(style_id) if style_id else None
    if previous_id != target_id:
        save_binding(
            db,
            "project:" + str(project.id),
            "style",
            previous.revision if previous else 0,
            {"resource_id": target_id} if target_id else None,
        )


def resolved_project_style(db, project):
    style_id = (project.generation_settings or {}).get("style_resource_id")
    if not style_id:
        return None
    binding = latest(db, "project:" + str(project.id), "style")
    if binding and binding.value and binding.value.get("resource_id") == style_id:
        return resolved_resource(db, project, "style")
    return {**resource_json(db, UUID(style_id)), "binding_revision": 0, "source": "project"}


def sync_specification_style(db, project, value):
    """Support library style binding edits by atomically updating the authoritative specification."""
    current = project.generation_settings or {}
    style_id = value["resource_id"] if value else None
    updated = {
        **current,
        "style_resource_id": style_id,
        "revision": current.get("revision", 1) + 1,
        "media_needs_review": True,
    }
    output = {key: updated[key] for key in OutputSpecification.model_fields if key in updated}
    prior = latest(db, "project:" + str(project.id), "output")
    save_binding(db, "project:" + str(project.id), "output", prior.revision if prior else 0, output)
    project.generation_settings = updated
    project.status = "in_progress"
