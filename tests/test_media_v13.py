# ruff: noqa: F811
from uuid import uuid4

import pytest
from test_content_chain import chain_model  # noqa: F401
from test_media_chain import execute, media_board, media_provider  # noqa: F401
from test_story import client, model  # noqa: F401


@pytest.fixture(autouse=True)
def isolated_supplier_queue(client):
    # Tests share a disposable database: older scenarios deliberately retain unknown receipts.
    # Clear only that fixture queue before each V13 case so the global capacity starts empty.
    from shortfilm.db import Session
    from shortfilm.models import Job
    from sqlalchemy import update

    with Session.begin() as db:
        db.execute(
            update(Job)
            .where(
                Job.kind == "media.video",
                Job.state.in_(
                    ("running", "queued", "waiting_provider", "waiting_dependency", "unknown")
                ),
            )
            .values(state="failed")
        )


def test_shot_settings_and_video_prompt(client, chain_model, media_provider):
    base, board = media_board(client, chain_model)
    shot = board["body"]["shots"][0]
    from uuid import UUID

    from shortfilm.configuration.schemas import ResourceCreate
    from shortfilm.configuration.service import append_resource
    from shortfilm.db import Session
    from shortfilm.models import Project

    with Session.begin() as db:
        style = append_resource(
            db,
            ResourceCreate(
                name="V13风格" + str(uuid4()),
                kind="style",
                stage="visual",
                content="水墨留白，细线描边，低饱和暖光。",
            ),
        )
        project = db.get(Project, UUID(base.split("/")[-1]))
        project.generation_settings = {
            **project.generation_settings,
            "style_resource_id": str(style.id),
        }
    route = base + "/media/shots/" + shot["id"] + "/settings"
    initial = client.get(route, params={"board_version_id": board["version_id"]})
    assert initial.status_code == 200, initial.text
    changed = client.put(
        route,
        json={
            "board_version_id": board["version_id"],
            "revision": 0,
            "overrides": {"aspect_ratio": "1:1", "resolution": "720P"},
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["effective"]["specification"]["aspect_ratio"] == "1:1"
    conflict = client.put(
        route, json={"board_version_id": board["version_id"], "revision": 0, "overrides": {}}
    )
    assert conflict.status_code == 409
    response = client.post(
        base + "/media/videos",
        json={"board_version_id": board["version_id"], "shot_ids": [shot["id"]]},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 202, response.text
    task = next(
        t for t in client.get(base + "/media/tasks").json() if t["id"] == response.json()[0]["id"]
    )
    assert task["snapshot"]["configuration"]["shot_settings_revision"] == 1
    execute(response.json()[0]["id"])
    payload = media_provider["video"][0]
    assert "水墨留白，细线描边，低饱和暖光。" in payload["prompt"]
    assert payload["aspect_ratio"] == "1:1"
    for line in shot["dialogues"]:
        assert line["id"] in payload["prompt"]
        assert line["text"] in payload["prompt"]


def test_independent_batch_idempotent_and_pause(client, chain_model, media_provider):
    base, board = media_board(client, chain_model)
    key = str(uuid4())
    request = {
        "board_version_id": board["version_id"],
        "shot_ids": [s["id"] for s in board["body"]["shots"]],
    }
    response = client.post(
        base + "/media/videos/independent", json=request, headers={"Idempotency-Key": key}
    )
    assert response.status_code == 202, response.text
    value = response.json()
    assert len(value["items"]) == 3
    assert all(i["job_id"] for i in value["items"])
    repeat = client.post(
        base + "/media/videos/independent", json=request, headers={"Idempotency-Key": key}
    )
    assert repeat.json() == value
    assert (
        client.put(
            base + "/media/sequences/" + value["batch_id"], json={"paused": True}
        ).status_code
        == 200
    )
    execute(value["items"][0]["job_id"])
    assert not media_provider["video"]


def test_independent_supplier_capacity_persists(client, chain_model, media_provider):
    base, board = media_board(client, chain_model)
    response = client.post(
        base + "/media/videos/independent",
        json={
            "board_version_id": board["version_id"],
            "shot_ids": [s["id"] for s in board["body"]["shots"]],
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 202, response.text
    for item in response.json()["items"]:
        execute(item["job_id"])
    assert len(media_provider["video"]) == 2
    tasks = client.get(base + "/media/tasks").json()
    assert len([t for t in tasks if t["state"] == "waiting_provider"]) == 2
    assert len([t for t in tasks if t["error"] == "supplier_capacity_wait"]) == 1
    from test_media_chain import poll_ready

    jobs = [item["job_id"] for item in response.json()["items"]]
    poll_ready()
    execute(jobs[0])
    execute(jobs[2])
    assert len(media_provider["video"]) == 3


def test_shot_setting_change_stales_only_target_and_tail_dependents(
    client, chain_model, media_provider
):
    from test_media_chain import poll_ready

    base, board = media_board(client, chain_model)
    shots = board["body"]["shots"]
    response = client.post(
        base + "/media/videos/independent",
        json={"board_version_id": board["version_id"], "shot_ids": [s["id"] for s in shots[:2]]},
        headers={"Idempotency-Key": str(uuid4())},
    )
    for item in response.json()["items"]:
        execute(item["job_id"])
    poll_ready()
    for item in response.json()["items"]:
        execute(item["job_id"])
    results = client.get(base + "/media/results").json()
    assert len(results) == 2 and not any(r["stale"] for r in results)
    changed = client.put(
        base + "/media/shots/" + shots[0]["id"] + "/settings",
        json={
            "board_version_id": board["version_id"],
            "revision": 0,
            "overrides": {"aspect_ratio": "1:1"},
        },
    )
    assert changed.status_code == 200, changed.text
    results = {r["target_id"]: r for r in client.get(base + "/media/results").json()}
    assert results[shots[0]["id"]]["stale"]
    assert not results[shots[1]["id"]]["stale"]


def test_shot_override_validation_inheritance_and_cross_project(
    client, chain_model, media_provider
):
    from test_story import new_project

    base, board = media_board(client, chain_model)
    shot = board["body"]["shots"][0]
    route = base + "/media/shots/" + shot["id"] + "/settings"
    assert (
        client.put(
            route,
            json={
                "board_version_id": board["version_id"],
                "revision": 0,
                "overrides": {"resolution": "8K"},
            },
        ).status_code
        == 422
    )
    first = client.put(
        route,
        json={
            "board_version_id": board["version_id"],
            "revision": 0,
            "overrides": {"resolution": "1080P"},
        },
    )
    assert first.status_code == 200
    reset = client.put(
        route, json={"board_version_id": board["version_id"], "revision": 1, "overrides": {}}
    )
    assert reset.json()["effective"]["specification"]["resolution"] == "720P"
    other = new_project(client)
    denied = client.put(
        f"/api/v1/projects/{other}/media/shots/{shot['id']}/settings",
        json={"board_version_id": board["version_id"], "revision": 0, "overrides": {}},
    )
    assert denied.status_code == 409
    reload = client.get(route, params={"board_version_id": board["version_id"]}).json()
    assert reload["revision"] == 2 and reload["overrides"] == {}


def test_independent_does_not_resubmit_accepted_failed_task(client, chain_model, media_provider):
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.models import Job

    base, board = media_board(client, chain_model)
    request = {
        "board_version_id": board["version_id"],
        "shot_ids": [board["body"]["shots"][0]["id"]],
    }
    first = client.post(
        base + "/media/videos/independent", json=request, headers={"Idempotency-Key": str(uuid4())}
    ).json()
    jid = first["items"][0]["job_id"]
    execute(jid)
    with Session.begin() as db:
        job = db.get(Job, UUID(jid))
        job.state, job.error = "failed", "media_download_failed"
    repeated = client.post(
        base + "/media/videos/independent", json=request, headers={"Idempotency-Key": str(uuid4())}
    ).json()
    assert repeated["items"][0]["reason"] == "failed_task_retry_required"
    assert repeated["items"][0]["job_id"] is None
    assert len(media_provider["video"]) == 1


def test_batch_excludes_existing_sequence_tail_dependencies(client, chain_model, media_provider):
    from test_media_chain import poll_ready

    base, board = media_board(client, chain_model)
    ids = [s["id"] for s in board["body"]["shots"]]
    response = client.post(
        base + "/media/videos",
        json={"board_version_id": board["version_id"], "shot_ids": ids, "sequential": True},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 202, response.text
    for item in response.json():
        poll_ready()
        execute(item["id"])
        poll_ready()
        execute(item["id"])
    changed = client.put(
        base + "/media/shots/" + ids[0] + "/settings",
        json={
            "board_version_id": board["version_id"],
            "revision": 0,
            "overrides": {"aspect_ratio": "1:1"},
        },
    )
    assert changed.status_code == 200
    assert all(r["stale"] for r in client.get(base + "/media/results").json())
    batch = client.post(
        base + "/media/videos/independent",
        json={"board_version_id": board["version_id"], "shot_ids": ids},
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    assert batch["items"][0]["job_id"]
    assert [i["reason"] for i in batch["items"][1:]] == [
        "previous_frame_dependency",
        "previous_frame_dependency",
    ]


def test_simultaneous_workers_respect_supplier_capacity(
    client, chain_model, media_provider, monkeypatch
):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    from shortfilm.media import providers

    base, board = media_board(client, chain_model)
    response = client.post(
        base + "/media/videos/independent",
        json={
            "board_version_id": board["version_id"],
            "shot_ids": [s["id"] for s in board["body"]["shots"]],
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    original = providers.submit_video
    lock = threading.Lock()
    counters = {"active": 0, "peak": 0}
    barrier = threading.Barrier(2)

    def submit(config, payload):
        with lock:
            counters["active"] += 1
            counters["peak"] = max(counters["active"], counters["peak"])
        try:
            barrier.wait(timeout=5)
            return original(config, payload)
        finally:
            with lock:
                counters["active"] -= 1

    monkeypatch.setattr(providers, "submit_video", submit)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(execute, [i["job_id"] for i in response.json()["items"]]))
    assert counters["peak"] == 2
    assert len(media_provider["video"]) == 2


def test_legacy_multi_reference_order_does_not_become_stale(client, chain_model, media_provider):
    from copy import deepcopy
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.media.sources import shot_context, source_stale
    from shortfilm.models import ContentVersion, Project
    from test_media_assets import upload_image

    base, board = media_board(client, chain_model)
    pid = base.split("/")[-1]
    second = upload_image(client, pid)
    with Session.begin() as db:
        project = db.get(Project, UUID(pid))
        version = db.get(ContentVersion, UUID(board["version_id"]))
        body = deepcopy(version.body)
        body["shots"][0]["refs"]["characters"] = [second]
        version.body = body
        db.flush()
        shot = body["shots"][0]
        context = shot_context(db, project, version, shot, "image.position")
        context["files"].reverse()  # Older compiler followed JSONB key order.
        snapshot = {
            "kind": "image.position",
            "specification": project.generation_settings,
            "input": context,
            "files": context["files"],
            "board_version_id": str(version.id),
            "shot_id": shot["id"],
        }
        assert not source_stale(db, project, snapshot)


def test_reconciled_unknown_receipt_releases_capacity(
    client, chain_model, media_provider, monkeypatch
):
    from uuid import UUID

    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.models import Job

    monkeypatch.setattr(settings, "media_video_concurrency", 1)
    base, board = media_board(client, chain_model)
    shots = board["body"]["shots"]
    request = {"board_version_id": board["version_id"], "shot_ids": [shots[0]["id"]]}
    original = client.post(
        base + "/media/videos", json=request, headers={"Idempotency-Key": str(uuid4())}
    ).json()[0]
    execute(original["id"])
    with Session.begin() as db:
        old = db.get(Job, UUID(original["id"]))
        old.state = "unknown"
    retry = client.post(
        base + "/media/tasks/" + original["id"] + "/retry",
        json={},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert retry.status_code == 202, retry.text
    execute(retry.json()["id"])
    assert client.get("/api/v1/jobs/" + retry.json()["id"]).json()["state"] == "succeeded"
    next_job = client.post(
        base + "/media/videos",
        json={"board_version_id": board["version_id"], "shot_ids": [shots[1]["id"]]},
        headers={"Idempotency-Key": str(uuid4())},
    ).json()[0]
    execute(next_job["id"])
    assert len(media_provider["video"]) == 2
