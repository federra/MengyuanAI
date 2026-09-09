# ruff: noqa: F811
"""M2 persistence with explicit transport substitutes, never supplier acceptance."""

import io
import subprocess
from copy import deepcopy
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from PIL import Image
from test_content_chain import chain, chain_model  # noqa: F401
from test_story import client, model, new_project, post  # noqa: F401  # noqa: F401


def test_image_job_missing_configuration_fails_before_enqueue(client):
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(base + "/entities", json={"kind": "character", "name": "邮差"}).json()
    response = client.post(
        base + "/media/images",
        json={"entity_id": entity["id"], "entity_revision": 1},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 422, response.text
    assert client.get(base + "/jobs").json() == []


@pytest.fixture
def media_provider(client, monkeypatch, tmp_path):
    from shortfilm.configuration.service import latest, save_binding
    from shortfilm.creation.provider import ProviderFailure
    from shortfilm.db import Session
    from shortfilm.media import providers

    routes = {
        "image": (
            "volcengine",
            "doubao-seedream-4-5-251128",
            "https://ark.cn-beijing.volces.com/api/v3",
        ),
        "video": (
            "volcengine",
            "doubao-seedance-2-0-260128",
            "https://ark.cn-beijing.volces.com/api/v3",
        ),
        "audio": ("minimax", "speech-2.8-hd", "https://api.minimaxi.com/v1"),
    }
    monkeypatch.setenv("M2_TEST_KEY", "test-only")
    with Session.begin() as db:
        for cap, (provider, name, endpoint) in routes.items():
            key = "model:category:" + cap
            binding = latest(db, "system", key)
            save_binding(
                db,
                "system",
                key,
                binding.revision if binding else 0,
                {
                    "provider": provider,
                    "model": name,
                    "endpoint": endpoint,
                    "credential_ref": "M2_TEST_KEY",
                    "capability": cap,
                    "timeout_seconds": 30,
                },
            )
    stream = io.BytesIO()
    Image.new("RGB", (128, 72), "red").save(stream, "PNG")
    audio = tmp_path / "fixture.mp3"
    video = tmp_path / "fixture.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", str(audio)], check=True
    )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=1280x720:r=24:d=5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        check=True,
    )
    calls = {"image": [], "audio": [], "video": [], "poll": [], "fail": False}

    def image_call(config, payload):
        calls["image"].append(deepcopy(payload))
        return {"data": stream.getvalue(), "usage": {"images": 1}}

    def audio_call(config, payload):
        calls["audio"].append(deepcopy(payload))
        return {"data": audio.read_bytes(), "usage": {"characters": len(payload["text"])}}

    def video_call(config, payload):
        calls["video"].append(deepcopy(payload))
        if calls["fail"]:
            calls["fail"] = False
            raise ProviderFailure("provider_rejected")
        return "real-transport-substitute-" + str(len(calls["video"]))

    def poll(config, task):
        calls["poll"].append(task)
        return {"state": "succeeded", "url": "https://fixture.invalid/video", "usage": {}}

    monkeypatch.setattr(providers, "generate_image", image_call)
    monkeypatch.setattr(providers, "generate_audio", audio_call)
    monkeypatch.setattr(providers, "submit_video", video_call)
    monkeypatch.setattr(providers, "poll_video", poll)
    monkeypatch.setattr(providers, "download_media", lambda url: video.read_bytes())
    return calls


def execute(jid):
    from shortfilm.jobs.service import execute_job

    execute_job(jid)


def poll_ready():
    from shortfilm.db import Session
    from shortfilm.jobs.service import now
    from shortfilm.media.execution import release_waiting
    from shortfilm.media.models import MediaRun
    from sqlalchemy import select

    with Session.begin() as db:
        for run in db.scalars(select(MediaRun)):
            run.next_poll_at = now() - timedelta(seconds=1)
    release_waiting()


def media_board(client, chain_model):
    base, _, _, script, board = chain(client)
    body = deepcopy(board["body"])
    shot = body["shots"][0]
    shot["duration"] = 5
    for line in shot["dialogues"]:
        line["voice"], line["emotion"] = "male-qn-qingse", "neutral"
    for _ in range(2):
        another = deepcopy(shot)
        another["id"] = str(uuid4())
        for line in another["dialogues"]:
            line["id"] = str(uuid4())
        body["shots"].append(another)
    pid = base.split("/")[-1]
    from test_media_assets import upload_image

    entity = client.post(base + "/entities", json={"kind": "scene", "name": "邮局"}).json()
    fid = upload_image(client, pid)
    ref = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": 1, "file_id": fid},
    ).json()
    assert (
        client.put(
            base + "/specification",
            json={"base_version": 1, "aspect_ratio": "16:9", "resolution": "720P"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            base + f"/reference-images/{ref['id']}/confirm", json={"specification_revision": 2}
        ).status_code
        == 200
    )
    for s in body["shots"]:
        s["refs"]["scenes"] = [fid]
    response = client.put(
        base + "/stages/board",
        json={
            "revision": board["revision"],
            "source_version_id": script["version_id"],
            "body": body,
        },
    )
    assert response.status_code == 200, response.text
    board = response.json()
    assert (
        post(
            client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
        ).status_code
        == 200
    )
    return base, board


def test_image_real_bytes_saved_reload_confirm_and_late_source(client, media_provider):
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(
        base + "/entities", json={"kind": "character", "name": "邮差", "description": "蓝衣"}
    ).json()
    command = {"entity_id": entity["id"], "entity_revision": 1}
    job = post(client, base + "/media/images", command, "image-idempotency")
    assert job.status_code == 202, job.text
    assert (
        post(client, base + "/media/images", command, "image-idempotency").json()["id"]
        == job.json()["id"]
    )
    execute(job.json()["id"])
    output = client.get(base + "/media/results").json()[0]
    assert not output["stale"]
    assert client.get(base + "/files/" + output["file_id"]).content.startswith(b"\x89PNG")
    assert client.post(base + f"/media/results/{output['id']}/confirm").json()["confirmed"]
    assert len(media_provider["image"]) == 1
    client.put(
        base + "/entities/" + entity["id"],
        json={"kind": "character", "name": "邮差", "description": "红衣", "revision": 1},
    )
    assert client.get(base + "/media/results").json()[0]["stale"]
    other = f"/api/v1/projects/{new_project(client)}"
    assert client.get(other + "/media/results").json() == []
    assert client.post(other + f"/media/results/{output['id']}/confirm").status_code == 404


def test_sequential_failure_pause_recovery_retains_first_and_tail(
    client, chain_model, media_provider
):
    base, board = media_board(client, chain_model)
    ids = [s["id"] for s in board["body"]["shots"]]
    response = post(
        client,
        base + "/media/videos",
        {"board_version_id": board["version_id"], "shot_ids": ids, "sequential": True},
    )
    assert response.status_code == 202, response.text
    first, second, third = response.json()
    execute(first["id"])
    assert client.get("/api/v1/jobs/" + first["id"]).json()["state"] == "waiting_provider"
    poll_ready()
    execute(first["id"])
    assert client.get("/api/v1/jobs/" + first["id"]).json()["state"] == "succeeded"
    poll_ready()
    media_provider["fail"] = True
    execute(second["id"])
    assert client.get("/api/v1/jobs/" + second["id"]).json()["state"] == "failed"
    poll_ready()
    assert client.get("/api/v1/jobs/" + third["id"]).json()["state"] == "waiting_dependency"
    task = next(t for t in client.get(base + "/media/tasks").json() if t["id"] == second["id"])
    assert task["previous"]["previousShotId"] == ids[0]
    retry = post(client, base + f"/media/tasks/{second['id']}/retry", {}).json()
    poll_ready()
    execute(retry["id"])
    poll_ready()
    execute(retry["id"])
    assert client.get("/api/v1/jobs/" + retry["id"]).json()["state"] == "succeeded"
    client.put(base + "/media/sequences/" + str(task["sequence_id"]), json={"paused": True})
    poll_ready()
    assert client.get("/api/v1/jobs/" + third["id"]).json()["state"] == "waiting_dependency"
    client.put(base + "/media/sequences/" + str(task["sequence_id"]), json={"paused": False})
    poll_ready()
    execute(third["id"])
    poll_ready()
    execute(third["id"])
    assert client.get("/api/v1/jobs/" + third["id"]).json()["state"] == "succeeded"
    assert len(media_provider["video"]) == 4
    assert len(media_provider["video"][0]["images"]) == 1
    assert len(media_provider["video"][1]["images"]) == 2
    assert len(client.get(base + "/media/results").json()) == 3


def test_audio_only_modified_line_stales_and_unknown_never_autoresubmits(
    client, chain_model, media_provider
):
    from shortfilm.db import Session
    from shortfilm.jobs.service import claim_job, now, recover_jobs
    from shortfilm.media.models import MediaRun
    from shortfilm.models import Job

    base, board = media_board(client, chain_model)
    shot = board["body"]["shots"][0]
    jobs = []
    for line in shot["dialogues"]:
        response = post(
            client,
            base + "/media/audio",
            {"board_version_id": board["version_id"], "shot_id": shot["id"], "line_id": line["id"]},
        )
        assert response.status_code == 202, response.text
        execute(response.json()["id"])
        jobs.append(response.json())
    body = deepcopy(board["body"])
    body["shots"][0]["dialogues"][1]["text"] = "我留在这里。"
    body["shots"][0]["dialogue"] = "\n".join(line["text"] for line in body["shots"][0]["dialogues"])
    saved = client.put(
        base + "/stages/board",
        json={
            "revision": board["revision"],
            "source_version_id": board["source_version_id"],
            "body": body,
        },
    )
    assert saved.status_code == 200, saved.text
    outputs = {o["target_id"]: o for o in client.get(base + "/media/results").json()}
    assert not outputs[shot["dialogues"][0]["id"]]["stale"]
    assert outputs[shot["dialogues"][1]["id"]]["stale"]
    entity = client.post(base + "/entities", json={"kind": "prop", "name": "信"}).json()
    job = post(
        client, base + "/media/images", {"entity_id": entity["id"], "entity_revision": 1}
    ).json()
    assert claim_job(job["id"])
    with Session.begin() as db:
        db.get(MediaRun, UUID(job["id"])).submitted = True
        db.get(Job, UUID(job["id"])).lease_until = now() - timedelta(seconds=2)
    recover_jobs()
    execute(job["id"])
    assert client.get("/api/v1/jobs/" + job["id"]).json()["state"] == "unknown"
    assert len(media_provider["image"]) == 0
    assert post(client, base + f"/media/tasks/{job['id']}/retry", {}).status_code == 409


def test_cancelled_dependent_retry_cannot_skip_unfinished_parent(
    client, chain_model, media_provider
):
    base, board = media_board(client, chain_model)
    ids = [s["id"] for s in board["body"]["shots"]]
    jobs = post(
        client,
        base + "/media/videos",
        {"board_version_id": board["version_id"], "shot_ids": ids, "sequential": True},
    ).json()
    client.post(base + f"/media/tasks/{jobs[1]['id']}/cancel")
    retry = post(client, base + f"/media/tasks/{jobs[1]['id']}/retry", {})
    assert retry.status_code == 202, retry.text
    assert retry.json()["state"] == "waiting_dependency"
    tasks = client.get(base + "/media/tasks").json()
    client.put(base + "/media/sequences/" + str(tasks[0]["sequence_id"]), json={"paused": False})
    poll_ready()
    execute(retry.json()["id"])
    assert media_provider["video"] == []


def test_known_provider_receipt_recovers_after_worker_lease_expiry(
    client, chain_model, media_provider
):
    from shortfilm.db import Session
    from shortfilm.jobs.service import claim_job, now, recover_jobs
    from shortfilm.models import Job

    base, board = media_board(client, chain_model)
    jid = post(
        client,
        base + "/media/videos",
        {"board_version_id": board["version_id"], "shot_ids": [board["body"]["shots"][0]["id"]]},
    ).json()[0]["id"]
    execute(jid)
    poll_ready()
    assert claim_job(jid)
    with Session.begin() as db:
        db.get(Job, UUID(jid)).lease_until = now() - timedelta(seconds=1)
    recover_jobs()
    execute(jid)
    assert client.get("/api/v1/jobs/" + jid).json()["state"] == "succeeded"
    assert len(media_provider["video"]) == 1
    assert len(media_provider["poll"]) == 1


def test_paid_success_disk_failure_is_unknown_and_requires_confirmation(
    client, media_provider, monkeypatch
):
    from shortfilm.media.storage import LocalStorage

    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(base + "/entities", json={"kind": "prop", "name": "信"}).json()
    job = post(
        client, base + "/media/images", {"entity_id": entity["id"], "entity_revision": 1}
    ).json()
    original = LocalStorage.put

    def full_disk(self, key, raw):
        if key.startswith("staging/"):
            raise OSError("test disk full")
        return original(self, key, raw)

    monkeypatch.setattr(LocalStorage, "put", full_disk)
    execute(job["id"])
    assert client.get("/api/v1/jobs/" + job["id"]).json()["state"] == "unknown"
    assert post(client, base + f"/media/tasks/{job['id']}/retry", {}).status_code == 409
    assert len(media_provider["image"]) == 1


def test_older_video_completion_does_not_replace_newer_command(client, chain_model, media_provider):
    from shortfilm.db import Session
    from shortfilm.media.sources import latest_video
    from shortfilm.models import Project

    base, board = media_board(client, chain_model)
    sid = board["body"]["shots"][0]["id"]
    body = {"board_version_id": board["version_id"], "shot_ids": [sid]}
    old = post(client, base + "/media/videos", body).json()[0]
    execute(old["id"])
    new = post(client, base + "/media/videos", body).json()[0]
    execute(new["id"])
    poll_ready()
    execute(new["id"])
    execute(old["id"])
    assert client.get(base + "/media/results").json()[0]["job_id"] == new["id"]
    with Session() as db:
        assert latest_video(db, db.get(Project, UUID(base.split("/")[-1])), sid).job_id == UUID(
            new["id"]
        )


def test_reference_replacement_keeps_id_and_invalidates_only_bound_shot(
    client, chain_model, media_provider
):
    from test_media_assets import upload_image

    base, board = media_board(client, chain_model)
    pid = base.split("/")[-1]
    shot = board["body"]["shots"][0]
    fid = shot["refs"]["scenes"][0]
    video = post(
        client,
        base + "/media/videos",
        {"board_version_id": board["version_id"], "shot_ids": [shot["id"]]},
    ).json()[0]
    execute(video["id"])
    poll_ready()
    execute(video["id"])
    entity = client.post(base + "/entities", json={"kind": "scene", "name": "新邮局"}).json()
    new_file = upload_image(client, pid)
    ref = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": 1, "file_id": new_file},
    ).json()
    client.post(base + f"/reference-images/{ref['id']}/confirm", json={"specification_revision": 2})
    path = base + f"/media/shots/{shot['id']}/references/{fid}"
    replaced = client.put(
        path, json={"board_version_id": board["version_id"], "revision": 0, "file_id": new_file}
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["ref_id"] == fid
    assert replaced.json()["file_id"] == new_file
    assert (
        client.put(
            path, json={"board_version_id": board["version_id"], "revision": 0, "file_id": new_file}
        ).status_code
        == 409
    )
    unchanged = client.get(base + "/stages/board").json()["item"]
    assert unchanged["body"]["shots"][0]["refs"]["scenes"] == [fid]
    assert client.get(base + "/media/results").json()[0]["stale"]
    new_job = post(
        client,
        base + "/media/videos",
        {"board_version_id": board["version_id"], "shot_ids": [shot["id"]]},
    ).json()[0]
    assert new_job["snapshot"]["files"][0]["ref_id"] == fid
    assert new_job["snapshot"]["files"][0]["id"] == new_file
    other = f"/api/v1/projects/{new_project(client)}"
    assert client.put(
        other + f"/media/shots/{shot['id']}/references/{fid}",
        json={"board_version_id": board["version_id"], "revision": 1, "file_id": new_file},
    ).status_code in (404, 409)
