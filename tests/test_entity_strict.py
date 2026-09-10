# ruff: noqa: F401, F811
"""Strict element contracts in disposable PostgreSQL; no paid providers."""

from uuid import uuid4

from test_content_chain import chain_model
from test_media_assets import upload_image
from test_media_chain import media_provider
from test_story import client, model, new_project


def batch(client, pid, items, board=None, key=None):
    return client.put(
        f"/api/v1/projects/{pid}/entities/batch",
        json={"base_board_version_id": board, "items": items},
        headers={"Idempotency-Key": key or str(uuid4())},
    )


def row(**values):
    return {
        "id": str(uuid4()),
        "revision": 0,
        "kind": "character",
        "name": "邮差",
        "description": "蓝制服",
        "voice": "",
        "three_view": False,
        "input_file_id": None,
        "output_file_id": None,
        **values,
    }


def test_atomic_elements_conflict_replay_and_separate_images(client):
    pid = new_project(client)
    source = upload_image(client, pid)
    a, b = row(input_file_id=source), row(kind="prop", name="信")
    key = str(uuid4())
    saved = batch(client, pid, [a, b], key=key)
    assert saved.status_code == 200, saved.text
    entities = saved.json()["entities"]
    assert len(entities) == 2
    assert next(e for e in entities if e["id"] == a["id"])["input_file_id"] == source
    assert next(e for e in entities if e["id"] == a["id"])["output_file_id"] is None
    assert client.get(f"/api/v1/projects/{pid}/reference-images").json() == []
    assert batch(client, pid, [a, b], key=key).json() == saved.json()
    bad = batch(client, pid, [{**a, "revision": 1, "name": "不能部分保存"}, {**b, "revision": 9}])
    assert bad.status_code == 409, bad.text
    assert (
        next(
            e for e in client.get(f"/api/v1/projects/{pid}/entities").json() if e["id"] == a["id"]
        )["name"]
        == "邮差"
    )
    assert batch(client, pid, [{**a, "name": "变动"}, b], key=key).status_code == 409


def test_archive_keeps_history_and_blocks_future_generation(client):
    pid = new_project(client)
    a = row()
    saved = batch(client, pid, [a])
    assert saved.status_code == 200, saved.text
    url = f"/api/v1/projects/{pid}/entities/{a['id']}"
    assert client.delete(url, params={"revision": 2}).status_code == 409
    archived = client.delete(url, params={"revision": 1})
    assert archived.status_code == 200, archived.text
    assert client.get(f"/api/v1/projects/{pid}/entities").json() == []
    history = client.get(url + "/versions")
    assert history.status_code == 200, history.text
    assert len(history.json()) == 1


def test_entity_shot_add_replace_pending_replay_and_archive(client, chain_model):
    from test_content_chain import chain

    base, _, _, _, board = chain(client)
    pid, sid = base.split("/")[-1], board["body"]["shots"][0]["id"]
    a, b, c = row(), row(name="第二角色"), row(name="替换角色")
    result = batch(client, pid, [a, b, c], board["version_id"])
    assert result.status_code == 200, result.text
    current = board["version_id"]
    refs = []
    for entity, mode in [(a, "add"), (b, "add"), (c, "replace")]:
        command = {"entity_revision": 1, "board_version_id": current, "shot_id": sid, "mode": mode}
        key = {"Idempotency-Key": str(uuid4())}
        bound = client.post(
            base + f"/entities/{entity['id']}/shot-bindings", json=command, headers=key
        )
        assert bound.status_code == 200, bound.text
        assert (
            client.post(
                base + f"/entities/{entity['id']}/shot-bindings", json=command, headers=key
            ).json()
            == bound.json()
        )
        current = bound.json()["board_version_id"]
        refs.append(bound.json()["ref_id"])
    assert refs[2] == refs[0] and refs[0] != refs[1]
    active = client.get(base + "/stages/board").json()["item"]
    assert active["body"]["shots"][0]["refs"]["characters"] == refs[:2]
    assert active["body"]["shots"][0]["id"] == sid
    assert client.delete(base + f"/entities/{c['id']}?revision=1").status_code == 409
    assert client.delete(base + f"/entities/{a['id']}?revision=1").status_code == 200
    assert client.get(base + f"/entities/{a['id']}/versions").status_code == 200
    display = client.get(base + "/storyboard/import/assets").json()
    assert next(x for x in display if x["id"] == refs[0])["name"] == "替换角色"
    from uuid import UUID

    import pytest
    from fastapi import HTTPException
    from shortfilm.db import Session
    from shortfilm.media.sources import shot_context
    from shortfilm.models import Project

    with Session() as db:
        project = db.get(Project, UUID(pid))
        from shortfilm.assets.strict import current_board

        version = current_board(db, project.id)
        with pytest.raises(HTTPException):
            shot_context(
                db, project, version, version.body["shots"][0], "media.video", require_refs=True
            )


def test_entity_rename_voice_propagates_only_explicit_bound_lines(client, chain_model):
    from test_content_chain import chain

    base, _, _, _, board = chain(client)
    pid = base.split("/")[-1]
    a = row(voice="voice-a")
    assert batch(client, pid, [a], board["version_id"]).status_code == 200
    lines = board["body"]["shots"][0]["dialogues"]
    bind = client.put(
        base + "/media/line-bindings/" + lines[0]["id"],
        json={"board_version_id": board["version_id"], "entity_id": a["id"], "revision": 0},
    )
    assert bind.status_code == 200, bind.text
    changed = batch(
        client,
        pid,
        [{**a, "revision": 1, "name": "新名字", "voice": "voice-b"}],
        board["version_id"],
    )
    assert changed.status_code == 200, changed.text
    new = client.get(base + "/stages/board").json()["item"]
    assert new["version_id"] != board["version_id"]
    assert new["body"]["shots"][0]["dialogues"][0] == {
        **lines[0],
        "speaker": "新名字",
        "voice": "voice-b",
    }
    assert new["body"]["shots"][0]["dialogues"][1] == lines[1]
    assert new["body"]["shots"][0]["refs"] == board["body"]["shots"][0]["refs"]


def test_entity_image_batch_freezes_input_and_rolls_back_invalid_target(client, media_provider):
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.models import Job

    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    fid = upload_image(client, pid)
    a = row(input_file_id=fid)
    assert batch(client, pid, [a]).status_code == 200
    items = [{"entity_id": a["id"], "entity_revision": 1}]
    bad = client.post(
        base + "/entities/image-batches",
        json={"items": items + [{"entity_id": str(uuid4()), "entity_revision": 1}]},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert bad.status_code == 404, bad.text
    assert client.get(base + "/jobs").json() == []
    key = {"Idempotency-Key": str(uuid4())}
    result = client.post(base + "/entities/image-batches", json={"items": items}, headers=key)
    assert result.status_code == 202, result.text
    repeat = client.post(base + "/entities/image-batches", json={"items": items}, headers=key)
    assert repeat.json() == result.json()
    duplicate = client.post(
        base + "/entities/image-batches",
        json={"items": items},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert duplicate.status_code == 409, duplicate.text
    with Session() as db:
        job = db.get(Job, UUID(result.json()["jobs"][0]["id"]))
        assert [f["id"] for f in job.snapshot["files"]] == [fid]
    assert media_provider["image"] == []  # enqueue is not a provider call


def test_entity_specific_confirmation_cannot_borrow_another_entity_same_file(client, chain_model):
    from uuid import UUID

    import pytest
    from fastapi import HTTPException
    from shortfilm.assets.strict import current_board
    from shortfilm.db import Session
    from shortfilm.media.sources import shot_context
    from shortfilm.models import Project
    from test_content_chain import chain

    base, _, _, _, board = chain(client)
    pid = base.split("/")[-1]
    fid = upload_image(client, pid)
    a, b = row(output_file_id=fid), row(name="另一个角色", output_file_id=fid)
    assert batch(client, pid, [a, b], board["version_id"]).status_code == 200
    images = client.get(base + "/reference-images").json()
    for ref in images:
        assert (
            client.post(
                base + f"/reference-images/{ref['id']}/confirm", json={"specification_revision": 1}
            ).status_code
            == 200
        )
    bound = client.post(
        base + f"/entities/{a['id']}/shot-bindings",
        json={
            "entity_revision": 1,
            "board_version_id": board["version_id"],
            "shot_id": board["body"]["shots"][0]["id"],
            "mode": "add",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert bound.status_code == 200, bound.text
    with Session() as db:
        project = db.get(Project, UUID(pid))
        version = current_board(db, project.id)
        before = shot_context(
            db, project, version, version.body["shots"][0], "media.video", require_refs=True
        )
    changed = batch(
        client,
        pid,
        [{**a, "revision": 1, "description": "新衣服"}],
        bound.json()["board_version_id"],
    )
    assert changed.status_code == 200, changed.text
    assert any(
        i["entity_id"] == b["id"] and i["confirmed"]
        for i in client.get(base + "/reference-images").json()
    )
    with Session() as db:
        project = db.get(Project, UUID(pid))
        version = current_board(db, project.id)
        current = shot_context(db, project, version, version.body["shots"][0], "media.video")
        assert current != before
        with pytest.raises(HTTPException):
            shot_context(
                db, project, version, version.body["shots"][0], "media.video", require_refs=True
            )


def test_clear_generated_preview_persists_new_version_without_deleting_history(client):
    pid = new_project(client)
    a = row()
    original = batch(client, pid, [a]).json()["entities"][0]
    fid = upload_image(client, pid)
    base = f"/api/v1/projects/{pid}"
    ref = client.post(base + "/reference-images", json={"entity_id": a["id"], "entity_revision": 1, "file_id": fid})
    assert ref.status_code == 201, ref.text
    key = str(uuid4())
    cleared = batch(client, pid, [{**a, "revision": 1, "clear_output": True}], key=key)
    assert cleared.status_code == 200, cleared.text
    value = cleared.json()["entities"][0]
    assert value["revision"] == 2 and value["output_file_id"] is None
    assert value["version_id"] != original["version_id"]
    assert batch(client, pid, [{**a, "revision": 1, "clear_output": True}], key=key).json() == cleared.json()
    assert client.get(base + "/entities").json()[0]["version_id"] == value["version_id"]
    assert client.get(base + "/reference-images").json()[0]["entity_version_id"] == original["version_id"]
    assert client.get(base + "/files/" + fid).status_code == 200


def test_normal_save_keeps_legacy_command_shape(client):
    from shortfilm.assets.models import EntityCommand
    from shortfilm.assets.schemas import EntityBatch
    from shortfilm.assets.strict import fingerprint
    from shortfilm.db import Session

    # Adding an optional clear action must not change old pending request fingerprints.
    from sqlalchemy import select
    pid = new_project(client)
    a = row()
    key = str(uuid4())
    first = batch(client, pid, [a], key=key)
    assert first.status_code == 200
    with Session.begin() as db:
        saved = db.scalar(select(EntityCommand).where(EntityCommand.key == key))
        saved.fingerprint = fingerprint({"action": "elements.save", "base_board_version_id": None, "items": [a]})
    explicit_default = EntityBatch(items=[{**a, "clear_output": False}]).model_dump(mode="json")
    replay = client.put(f"/api/v1/projects/{pid}/entities/batch", json=explicit_default, headers={"Idempotency-Key": key})
    assert replay.status_code == 200 and replay.json() == first.json()
