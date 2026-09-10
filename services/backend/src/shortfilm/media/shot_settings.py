"""Append-only shot configuration. Call writes under the owning project lock."""

from copy import deepcopy

from fastapi import HTTPException

from shortfilm.config_models import Binding
from shortfilm.configuration.service import latest, resolve, specification
from shortfilm.media.schemas import ShotOverrides


def current(db, project, shot_id):
    return latest(db, "project:" + str(project.id), "shot:" + str(shot_id))


def effective(db, project, shot_id):
    config = resolve(db, project, "video", "storyboard")
    row = current(db, project, shot_id)
    overrides = (row.value or {}).get("overrides", {}) if row else {}
    spec = deepcopy(project.generation_settings)
    output = {
        k: spec[k]
        for k in ("aspect_ratio", "resolution", "video_model", "style_resource_id")
        if k in spec
    }
    output.update({k: overrides[k] for k in ("aspect_ratio", "resolution") if k in overrides})
    spec.update(specification(output, spec["revision"], "shot" if overrides else "project"))
    model = deepcopy(config["model"])
    if overrides.get("model"):
        model = {"value": overrides["model"], "source": "shot", "revision": row.revision}
    return {
        "model": model,
        "specification": spec,
        "shot_settings_revision": row.revision if row else 0,
        "shot_overrides": deepcopy(overrides),
    }


def settings_out(db, project, board_version_id, shot_id):
    row = current(db, project, shot_id)
    overrides = (row.value or {}).get("overrides", {}) if row else {}
    result = effective(db, project, shot_id)
    return dict(
        shot_id=shot_id,
        board_version_id=board_version_id,
        revision=row.revision if row else 0,
        overrides=overrides,
        effective=result,
        sources={
            k: "shot"
            if k in overrides
            else ("project" if k != "model" else result["model"]["source"])
            for k in ("model", "aspect_ratio", "resolution")
        },
    )


def persist(db, project, board_version_id, shot_id, revision, overrides):
    old = current(db, project, shot_id)
    if (old.revision if old else 0) != revision:
        raise HTTPException(409, "单镜设置已变化，请保留草稿并刷新")
    value = ShotOverrides.model_validate(overrides).model_dump(mode="json", exclude_none=True)
    row = Binding(
        scope="project:" + str(project.id),
        key="shot:" + str(shot_id),
        revision=revision + 1,
        value={"board_version_id": str(board_version_id), "overrides": value},
    )
    db.add(row)
    db.flush()
    return row


def import_overrides(db, project, generation):
    value = {("aspect_ratio" if k == "aspect" else k): v for k, v in generation.items()}
    if value.get("model"):
        name = value["model"]
        candidates = [resolve(db, project, "video", "storyboard")["model"]["value"]]
        for key in ("model:category:video", "model:step:video"):
            row = latest(db, "system", key)
            if row:
                candidates.append(row.value)
        route = next((r for r in candidates if r and r.get("model") == name), None)
        if not route:
            raise HTTPException(422, "generation.model未匹配已配置视频模型")
        value["model"] = route
    return ShotOverrides.model_validate(value).model_dump(mode="json", exclude_none=True)


def persist_imported_settings(db, project, board_version_id, shot_id, generation):
    if not generation:
        return None
    return persist(
        db, project, board_version_id, shot_id, 0, import_overrides(db, project, generation)
    )
