# ruff: noqa: F811, F401
"""Transactional user import; real isolated PG, supplier transport substitutions only."""

import json
from copy import deepcopy
from uuid import uuid4

import pytest
from test_content_chain import chain, chain_model
from test_story import client, model, new_project, post


def package():
    return {
        "format": "shortfilm-storyboard-import",
        "schemaVersion": 1,
        "shots": [
            {
                "id": f"shot{i}",
                "duration": 4,
                "prompt": f"卡通角色 @[asset{i}] 走过街头",
                "assets": [
                    {
                        "id": f"asset{i}",
                        "kind": "角色",
                        "name": "邮差",
                        "description": "红衣卡通邮差",
                    }
                ],
                "dialogues": [
                    {
                        "id": f"line{i}",
                        "speaker": "邮差",
                        "emotion": "平静",
                        "text": "出发。",
                        "voice": "narrator",
                    }
                ],
                "bindings": {"assetIds": [f"asset{i}"], "dialogueIds": [f"line{i}"]},
            }
            for i in range(3)
        ],
    }


def preview(client, base, script, board, value=None):
    return client.post(
        base + "/storyboard/import/preview",
        json={
            "sourceScriptVersionId": script["version_id"],
            "baseBoardVersionId": board["version_id"],
            "packageJson": json.dumps(
                value if value is not None else package(), ensure_ascii=False
            ),
        },
    )


def commit_body(p):
    return {
        key: p[key]
        for key in ("previewId", "contentHash", "sourceScriptVersionId", "baseBoardVersionId")
    }


def test_import_replaces_entire_board_preserves_history_and_retry(client, chain_model):
    base, _, _, script, board = chain(client)
    seven = deepcopy(board["body"])
    original = seven["shots"][0]
    seven["shots"] = []
    for _ in range(7):
        shot = deepcopy(original)
        shot["id"] = str(uuid4())
        for line in shot["dialogues"]:
            line["id"] = str(uuid4())
        seven["shots"].append(shot)
    saved = client.put(
        base + "/stages/board",
        json={
            "revision": board["revision"],
            "source_version_id": script["version_id"],
            "body": seven,
        },
    )
    assert saved.status_code == 200, saved.text
    board = saved.json()
    assert (
        post(
            client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
        ).status_code
        == 200
    )
    response = preview(client, base, script, board)
    assert response.status_code == 200, response.text
    p = response.json()
    assert p["stats"] == {"shots": 3, "dialogues": 3, "assets": 3, "totalSeconds": 12}
    key = str(uuid4())
    imported = post(client, base + "/storyboard/import/commit", commit_body(p), key)
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert len(result["shots"]) == 3
    assert len(set(result["idMapping"].values())) == 9
    assert all(
        result["idMapping"][f"asset{i}"] in s["prompt"] for i, s in enumerate(result["shots"])
    )
    assert result["item"]["revision"] == board["revision"] + 1
    assert client.get(base + "/stages/board").json()["item"] == result["item"]
    assert post(client, base + "/storyboard/import/commit", commit_body(p), key).json() == result
    assert client.get(base + "/storyboard/import/commits/" + key).json() == result
    history = client.get(base + f"/contents/{board['id']}/versions").json()
    assert history[1]["id"] == board["version_id"]
    assert len(history[1]["body"]["shots"]) == 7
    assert client.get(base + "/stages/board").json()["confirmation"] is None
    assert (
        post(
            client,
            base + f"/contents/{board['id']}/confirm",
            {"version_id": result["boardVersionId"]},
        ).status_code
        == 200
    )
    assets = client.get(base + "/storyboard/import/assets").json()
    assert len(assets) == 3


@pytest.mark.parametrize(
    "raw",
    ['{"format":"a","format":"b"}', '{"x":NaN}', "[" * 70 + "0" + "]" * 70, "{}" + " " * 1048576],
)
def test_import_strict_raw_parser(client, chain_model, raw):
    base, _, _, script, board = chain(client)
    response = client.post(
        base + "/storyboard/import/preview",
        json={
            "sourceScriptVersionId": script["version_id"],
            "baseBoardVersionId": board["version_id"],
            "packageJson": raw,
        },
    )
    assert response.status_code == 422, response.text
    assert client.get(base + "/stages/board").json()["item"] == board


@pytest.mark.parametrize(
    "fault", ["unknown", "bool", "duplicate", "reference", "dialogue", "empty", "range"]
)
def test_import_rejects_invalid_package(client, chain_model, fault):
    base, _, _, script, board = chain(client)
    value = package()
    shot = value["shots"][0]
    if fault == "unknown":
        shot["projectId"] = str(uuid4())
    if fault == "bool":
        shot["duration"] = True
    if fault == "duplicate":
        shot["dialogues"][0]["id"] = "shot0"
    if fault == "reference":
        shot["prompt"] = "@[asset1]"
    if fault == "dialogue":
        shot["bindings"]["dialogueIds"] = ["line1"]
    if fault == "empty":
        value["shots"] = []
    if fault == "range":
        shot["duration"] = 601
    response = preview(client, base, script, board, value)
    assert response.status_code == 422, response.text


def test_import_conflict_rolls_back_and_cross_project_token_is_hidden(client, chain_model):
    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    other = f"/api/v1/projects/{new_project(client)}"
    assert post(client, other + "/storyboard/import/commit", commit_body(p)).status_code == 404
    changed = deepcopy(board["body"])
    changed["shots"][0]["prompt"] += "晴天"
    saved = client.put(
        base + "/stages/board",
        json={
            "revision": board["revision"],
            "source_version_id": script["version_id"],
            "body": changed,
        },
    )
    assert saved.status_code == 200
    assert post(client, base + "/storyboard/import/commit", commit_body(p)).status_code == 409
    assert client.get(base + "/stages/board").json()["item"] == saved.json()


def test_import_commit_failure_rolls_back_entities_board_and_token(
    client, chain_model, monkeypatch
):
    from shortfilm.assets.models import Entity
    from shortfilm.creation import board_import
    from shortfilm.db import Session
    from sqlalchemy import func, select

    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    with Session() as db:
        before = db.scalar(select(func.count()).select_from(Entity))
    original = board_import.enqueue_review

    def fail(*args, **kwargs):
        raise RuntimeError("injected before commit")

    monkeypatch.setattr(board_import, "enqueue_review", fail)
    key = str(uuid4())
    response = post(client, base + "/storyboard/import/commit", commit_body(p), key)
    assert response.status_code == 503
    assert client.get(base + "/stages/board").json()["item"] == board
    assert client.get(base + "/storyboard/import/commits/" + key).status_code == 404
    with Session() as db:
        assert db.scalar(select(func.count()).select_from(Entity)) == before
    monkeypatch.setattr(board_import, "enqueue_review", original)
    assert post(client, base + "/storyboard/import/commit", commit_body(p), key).status_code == 200


def test_import_hash_mismatch_and_running_generation_do_not_replace(client, chain_model):
    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    body = commit_body(p)
    body["contentHash"] = "0" * 64
    assert post(client, base + "/storyboard/import/commit", body).status_code == 409
    job = post(
        client,
        base + "/stages/board/generate",
        {"source_version_id": script["version_id"], "target_revision": board["revision"]},
    )
    assert job.status_code == 202
    assert post(client, base + "/storyboard/import/commit", commit_body(p)).status_code == 409
    assert client.get(base + "/stages/board").json()["item"] == board


def test_import_committed_review_failure_does_not_undo_replacement(
    client, chain_model, monkeypatch
):
    from uuid import UUID

    from shortfilm.creation import provider
    from shortfilm.db import Session
    from shortfilm.jobs.service import execute_job
    from shortfilm.models import ContentReview
    from sqlalchemy import select

    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    result = post(client, base + "/storyboard/import/commit", commit_body(p)).json()

    def fail(*args, **kwargs):
        raise provider.ProviderFailure("injected_review_failure")

    monkeypatch.setattr(provider, "request_json", fail)
    with Session() as db:
        report = db.scalar(
            select(ContentReview).where(ContentReview.version_id == UUID(result["boardVersionId"]))
        )
        job_id = report.job_id
    assert job_id is not None
    execute_job(str(job_id))
    assert client.get("/api/v1/jobs/" + str(job_id)).json()["state"] == "failed"
    assert client.get(base + "/stages/board").json()["item"] == result["item"]


def test_import_pending_reference_can_bind_real_confirmed_image_and_reload(client, chain_model):
    from uuid import UUID

    from shortfilm.creation.board_import_models import has_pending_references
    from shortfilm.db import Session
    from shortfilm.media.sources import board as current_board
    from shortfilm.media.sources import shot_context
    from shortfilm.projects.router import owned_project
    from test_media_assets import upload_image

    base, _, _, script, old = chain(client)
    pid = base.rsplit("/", 1)[1]
    p = preview(client, base, script, old).json()
    imported = post(client, base + "/storyboard/import/commit", commit_body(p)).json()
    shot = imported["shots"][0]
    ref_id = imported["idMapping"]["asset0"]
    with Session() as db:
        assert has_pending_references(db, UUID(pid), shot["id"])
    entity = client.get(base + "/entities").json()[0]
    fid = upload_image(client, pid)
    image = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": entity["revision"], "file_id": fid},
    )
    assert image.status_code == 201, image.text
    assert (
        post(
            client,
            base + f"/reference-images/{image.json()['id']}/confirm",
            {"specification_revision": 1},
        ).status_code
        == 200
    )
    response = client.put(
        base + f"/media/shots/{shot['id']}/references/{ref_id}",
        json={"board_version_id": imported["boardVersionId"], "revision": 0, "file_id": fid},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ref_id"] == ref_id
    assert client.get(base + "/stages/board").json()["item"]["body"]["shots"][0]["refs"][
        "characters"
    ] == [ref_id]
    with Session() as db:
        assert not has_pending_references(db, UUID(pid), shot["id"])
        project = owned_project(db, UUID(pid))
        version = current_board(db, project)
        context = shot_context(db, project, version, shot, "media.video", require_refs=True)
        assert context["files"][0]["id"] == fid
        assert context["files"][0]["ref_id"] == ref_id


def test_import_missing_review_credentials_keeps_new_table(client, chain_model, monkeypatch):
    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    monkeypatch.delenv("STORY_TEST_KEY")
    response = post(client, base + "/storyboard/import/commit", commit_body(p))
    assert response.status_code == 200, response.text
    stage = client.get(base + "/stages/board").json()
    assert stage["item"] == response.json()["item"]
    assert stage["reports"][0]["state"] == "failed"


def test_import_specifications_are_new_shot_scoped_and_wrong_model_is_rejected(client, chain_model):
    base, _, _, script, board = chain(client)
    value = package()
    value["shots"][0]["generation"] = {"aspect": "1:1", "resolution": "1080P"}
    p = preview(client, base, script, board, value)
    assert p.status_code == 200, p.text
    result = post(client, base + "/storyboard/import/commit", commit_body(p.json())).json()
    ids = [s["id"] for s in result["shots"]]
    first = client.get(
        base + f"/media/shots/{ids[0]}/settings",
        params={"board_version_id": result["boardVersionId"]},
    ).json()
    second = client.get(
        base + f"/media/shots/{ids[1]}/settings",
        params={"board_version_id": result["boardVersionId"]},
    ).json()
    assert first["overrides"] == {"aspect_ratio": "1:1", "resolution": "1080P"}
    assert second["overrides"] == {}
    value["shots"][0]["generation"]["model"] = "unregistered-model"
    assert preview(client, base, script, result["item"], value).status_code == 422


def test_import_raw_utf8_byte_limit_and_lone_surrogate_rejected(client, chain_model):
    base, _, _, script, board = chain(client)
    value = json.dumps(package(), ensure_ascii=False)
    for raw in (value + " " * 1048576, value.replace("出发。", "\\ud800")):
        response = client.post(
            base + "/storyboard/import/preview",
            json={
                "sourceScriptVersionId": script["version_id"],
                "baseBoardVersionId": board["version_id"],
                "packageJson": raw,
            },
        )
        assert response.status_code == 422, response.text


def test_old_review_finishes_only_in_old_history_after_import(client, chain_model):
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.jobs.service import execute_job
    from shortfilm.models import ContentReview
    from sqlalchemy import select

    base, _, _, script, board = chain(client)
    with Session() as db:
        old_job = db.scalar(
            select(ContentReview.job_id).where(
                ContentReview.version_id == UUID(board["version_id"])
            )
        )
    p = preview(client, base, script, board).json()
    result = post(client, base + "/storyboard/import/commit", commit_body(p)).json()
    execute_job(str(old_job))
    stage = client.get(base + "/stages/board").json()
    assert stage["item"] == result["item"]
    old_report = next(r for r in stage["reports"] if r["version_id"] == board["version_id"])
    assert old_report["state"] == "succeeded"
    assert old_report["stale"]


def test_import_same_preview_different_retry_key_and_modified_command(client, chain_model):
    base, _, _, script, board = chain(client)
    p = preview(client, base, script, board).json()
    key = str(uuid4())
    result = post(client, base + "/storyboard/import/commit", commit_body(p), key).json()
    assert post(client, base + "/storyboard/import/commit", commit_body(p)).json() == result
    changed = commit_body(p)
    changed["contentHash"] = "0" * 64
    assert post(client, base + "/storyboard/import/commit", changed, key).status_code == 409
    assert client.get(base + "/stages/board").json()["item"]["revision"] == board["revision"] + 1


def test_import_rejects_prompt_that_overflows_internal_limit_after_id_mapping(client, chain_model):
    base, _, _, script, board = chain(client)
    value = package()
    shot = value["shots"][0]
    shot["assets"][0]["id"] = "a"
    shot["bindings"]["assetIds"] = ["a"]
    shot["prompt"] = "x" * 9996 + "@[a]"
    response = preview(client, base, script, board, value)
    assert response.status_code == 422, response.text
    error = response.json()["detail"][0]
    assert error["loc"] == ["packageJson", "shots", 0, "prompt"]
    assert "10000" in error["msg"]
    assert client.get(base + "/stages/board").json()["item"] == board


def test_import_huge_json_integer_is_validation_error_not_server_failure(client, chain_model):
    base, _, _, script, board = chain(client)
    value = package()
    value["shots"][0]["duration"] = 10**400
    response = preview(client, base, script, board, value)
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"] == ["packageJson", "shots", 0, "duration"]
