# ruff: noqa: F811
"""M3 database/API tests; supplier fixtures are not real supplier acceptance."""

from test_story import client, new_project, post  # noqa: F401


def test_empty_export_is_blocked_and_draft_is_persistent(client):
    base = f"/api/v1/projects/{new_project(client)}"
    response = client.get(base + "/finishing")
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["revision"] == 0 and state["blockers"]
    draft = state["draft"]
    draft["filename"] = "我的成片"
    saved = client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    assert saved.status_code == 200, saved.text
    assert client.get(base + "/finishing").json()["draft"]["filename"] == "我的成片"
    assert (
        client.put(
            base + "/finishing", json={"revision": 0, "draft": {**draft, "filename": "冲突"}}
        ).status_code
        == 409
    )
    assert post(client, base + "/exports", {"revision": 1}).status_code == 409
    assert not client.get(base + "/jobs").json()


def test_music_upload_validates_audio_and_project_ownership(client, tmp_path):
    import subprocess

    base = f"/api/v1/projects/{new_project(client)}"
    music = tmp_path / "music.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", str(music)],
        check=True,
    )
    raw = music.read_bytes()
    uploaded = client.post(
        base + "/finishing/music", files={"file": ("music.wav", raw, "audio/wav")}
    )
    assert uploaded.status_code == 201, uploaded.text
    fid = uploaded.json()["id"]
    assert client.get(base + f"/files/{fid}").content == raw
    assert (
        client.post(
            base + "/finishing/music", files={"file": ("fake.mp3", b"invalid", "audio/mpeg")}
        ).status_code
        == 422
    )
    other = f"/api/v1/projects/{new_project(client)}"
    assert client.get(other + f"/files/{fid}").status_code == 404
    draft = client.get(other + "/finishing").json()["draft"]
    draft["music_file_id"] = fid
    assert client.put(other + "/finishing", json={"revision": 0, "draft": draft}).status_code == 409


def test_render_real_mp4_has_audio_subtitle_and_exact_duration(tmp_path):
    import subprocess

    from shortfilm.finishing import render

    video, voice = tmp_path / "video.mp4", tmp_path / "voice.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:d=2:r=24",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        check=True,
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.5", str(voice)], check=True
    )
    snapshot = {
        "specification": {"width": 320, "height": 180},
        "draft": {
            "fps": 24,
            "fit": "pad",
            "narration": True,
            "subtitles": True,
            "original_audio": False,
            "voice_volume": 1,
            "original_volume": 0.5,
            "music_volume": 0.15,
        },
        "clips": [
            {
                "file": {"object_key": str(video)},
                "trim_start": 0,
                "duration": 1,
                "lines": [
                    {
                        "text": "你好{世界}\\n测试",
                        "start": 0.1,
                        "duration": 0.55,
                        "file": {"object_key": str(voice)},
                    }
                ],
            }
        ],
        "duration": 1,
        "music": None,
    }
    target = tmp_path / "output.mp4"
    metadata = render.compose(snapshot, target, lambda key: key, lambda: True)
    assert target.exists() and metadata["width"] == 320 and metadata["height"] == 180
    assert abs(metadata["duration"] - 1) < 0.06 and metadata["audio_codec"] == "aac"
    assert metadata["fps"] == 24


from test_content_chain import chain_model  # noqa: F401, E402
from test_media_chain import execute, media_board, media_provider, poll_ready  # noqa: F401, E402
from test_story import model  # noqa: F401, E402


def ready_media(client, chain_model):
    base, board = media_board(client, chain_model)
    for shot in board["body"]["shots"]:
        for line in shot["dialogues"]:
            response = post(
                client,
                base + "/media/audio",
                {
                    "board_version_id": board["version_id"],
                    "shot_id": shot["id"],
                    "line_id": line["id"],
                },
            )
            assert response.status_code == 202, response.text
            execute(response.json()["id"])
    response = post(
        client,
        base + "/media/videos",
        {
            "board_version_id": board["version_id"],
            "shot_ids": [s["id"] for s in board["body"]["shots"]],
            "sequential": True,
        },
    )
    assert response.status_code == 202, response.text
    for job in response.json():
        execute(job["id"])
        poll_ready()
        execute(job["id"])
        poll_ready()
    return base, board


def test_export_real_encoding_idempotency_isolation_and_stale(client, chain_model, media_provider):
    base, board = ready_media(client, chain_model)
    state = client.get(base + "/finishing").json()
    assert state["blockers"] == [], state
    draft = state["draft"]
    draft["filename"] = "三镜验收"
    response = client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    assert response.status_code == 200, response.text
    response = post(client, base + "/exports", {"revision": 1}, "export-one")
    assert response.status_code == 202, response.text
    jid = response.json()["id"]
    assert post(client, base + "/exports", {"revision": 1}, "export-two").json()["id"] == jid
    execute(jid)
    state = client.get(base + "/finishing").json()
    assert state["exports"][0]["state"] == "succeeded", state["exports"]
    output = state["exports"][0]["output"]
    assert output["metadata"]["duration"] == 15
    assert client.get(base).json()["status"] == "completed"
    downloaded = client.get(base + f"/exports/{jid}/download")
    assert downloaded.status_code == 200 and downloaded.headers["content-type"] == "video/mp4"
    other = f"/api/v1/projects/{new_project(client)}"
    assert client.get(other + f"/exports/{jid}/download").status_code == 404
    draft["clips"][0]["duration"] = 1
    response = client.put(base + "/finishing", json={"revision": 1, "draft": draft})
    assert response.status_code == 200
    assert response.json()["blockers"] and "台词" in response.json()["blockers"][0]
    assert post(client, base + "/exports", {"revision": 2}).status_code == 409
    assert client.get(base).json()["status"] == "in_progress"
    assert client.get(base + "/finishing").json()["exports"][0]["stale"]
    assert client.get(base + f"/exports/{jid}/download").status_code == 200


def test_deterministic_export_lease_is_requeued_without_provider(client):
    from datetime import timedelta
    from uuid import UUID

    from shortfilm.creation.service import enqueue
    from shortfilm.db import Session
    from shortfilm.jobs.service import claim_job, now, recover_jobs
    from shortfilm.models import Job, JobAttempt, Outbox
    from shortfilm.projects.router import owned_project

    pid = new_project(client)
    with Session.begin() as db:
        job = enqueue(db, owned_project(db, UUID(pid)), "lease-export", {}, "export.render", {})
        jid = job.id
    token = claim_job(jid)
    with Session.begin() as db:
        db.get(Job, jid).lease_until = now() - timedelta(seconds=1)
    recover_jobs()
    with Session() as db:
        assert db.get(Job, jid).state == "queued"
        assert db.get(Outbox, jid).sent_at is None
        from sqlalchemy import select

        assert db.scalar(select(JobAttempt).where(JobAttempt.token == token)).state == "interrupted"


def test_new_tts_changes_export_source_and_completed_state(client, chain_model, media_provider):
    base, board = ready_media(client, chain_model)
    draft = client.get(base + "/finishing").json()["draft"]
    assert client.put(base + "/finishing", json={"revision": 0, "draft": draft}).status_code == 200
    first = post(client, base + "/exports", {"revision": 1}, "first").json()["id"]
    execute(first)
    assert client.get(base).json()["status"] == "completed"
    shot = board["body"]["shots"][0]
    audio = post(
        client,
        base + "/media/audio",
        {
            "board_version_id": board["version_id"],
            "shot_id": shot["id"],
            "line_id": shot["dialogues"][0]["id"],
        },
    ).json()
    execute(audio["id"])
    assert client.get(base).json()["status"] == "in_progress"
    assert client.get(base + "/finishing").json()["exports"][0]["stale"]
    second = post(client, base + "/exports", {"revision": 1}, "second")
    assert second.status_code == 202 and second.json()["id"] != first


def test_alias_key_cannot_be_reused_for_different_export_input(client, chain_model, media_provider):
    base, _ = ready_media(client, chain_model)
    draft = client.get(base + "/finishing").json()["draft"]
    client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    job = post(client, base + "/exports", {"revision": 1}, "key-a").json()
    assert post(client, base + "/exports", {"revision": 1}, "key-b").json()["id"] == job["id"]
    draft["filename"] = "另一作品"
    client.put(base + "/finishing", json={"revision": 1, "draft": draft})
    assert post(client, base + "/exports", {"revision": 2}, "key-b").status_code == 409


def test_export_failure_retry_late_result_and_source_checksum(
    client, chain_model, media_provider, monkeypatch
):
    from uuid import UUID

    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.finishing import execution
    from shortfilm.media.storage import LocalStorage
    from shortfilm.models import Job, MediaFile

    base, _ = ready_media(client, chain_model)
    draft = client.get(base + "/finishing").json()["draft"]
    client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    job = post(client, base + "/exports", {"revision": 1}).json()
    original = execution.compose

    def broken(*args):
        raise ValueError("export_encoding_failed")

    monkeypatch.setattr(execution, "compose", broken)
    execute(job["id"])
    assert client.get(base + "/finishing").json()["exports"][0]["error"] == "export_encoding_failed"
    assert client.get(base + "/finishing").json()["draft"] == draft
    retry = post(client, base + f"/exports/{job['id']}/retry", {}).json()
    assert post(client, base + f"/exports/{job['id']}/retry", {}).json()["id"] == retry["id"]

    def late(snapshot, target, resolve, alive):
        metadata = original(snapshot, target, resolve, alive)
        updated = {**draft, "filename": "合成时修改"}
        response = client.put(base + "/finishing", json={"revision": 1, "draft": updated})
        assert response.status_code == 200
        return metadata

    monkeypatch.setattr(execution, "compose", late)
    execute(retry["id"])
    state = client.get(base + "/finishing").json()
    assert state["exports"][0]["state"] == "succeeded" and state["exports"][0]["stale"]
    assert client.get(base).json()["status"] == "in_progress"
    current = post(client, base + "/exports", {"revision": 2}).json()
    with Session() as db:
        source = db.get(Job, UUID(current["id"])).snapshot["clips"][0]["file"]["id"]
        path = LocalStorage(settings.storage_root).path(db.get(MediaFile, UUID(source)).object_key)
    prior = path.read_bytes()
    path.write_bytes(b"corrupt")
    execute(current["id"])
    path.write_bytes(prior)
    assert (
        client.get(base + "/finishing").json()["exports"][0]["error"]
        == "export_source_checksum_mismatch"
    )


def test_export_alias_cannot_be_borrowed_by_file_verify(client, chain_model, media_provider):
    base, _ = ready_media(client, chain_model)
    draft = client.get(base + "/finishing").json()["draft"]
    client.put(base + "/finishing", json={"revision": 0, "draft": draft})
    first = post(client, base + "/exports", {"revision": 1}, "original-export").json()
    post(client, base + "/exports", {"revision": 1}, "alias-export")
    file_id = first["snapshot"]["clips"][0]["file"]["id"]
    assert (
        post(
            client, base + "/jobs", {"kind": "file.verify", "file_id": file_id}, "alias-export"
        ).status_code
        == 409
    )


def test_empty_dialogue_placeholder_does_not_require_tts(client, chain_model, media_provider):
    base, board = ready_media(client, chain_model)
    from copy import deepcopy

    body = deepcopy(board["body"])
    for shot in body["shots"][1:]:
        shot["dialogues"] = shot["dialogues"][:1]
        shot["dialogue"] = ""
        for line in shot["dialogues"]:
            line["text"] = ""
    updated = client.put(
        base + "/stages/board",
        json={
            "revision": board["revision"],
            "source_version_id": board["source_version_id"],
            "body": body,
        },
    )
    assert updated.status_code == 200, updated.text
    current = updated.json()
    assert (
        post(
            client,
            base + f"/contents/{current['id']}/confirm",
            {"version_id": current["version_id"]},
        ).status_code
        == 200
    )
    outcomes = {
        row["target_id"]: row
        for row in client.get(base + "/media/results").json()
        if row["kind"] == "media.video"
    }
    assert not outcomes[body["shots"][0]["id"]]["stale"]
    assert all(outcomes[shot["id"]]["stale"] for shot in body["shots"][1:])
    audio_calls = len(media_provider["audio"])
    # V13 binds dialogue to video inputs. Rebuild the tail chain through the public
    # sequential API (which starts at shot one); empty placeholders require no new TTS.
    regenerated = post(
        client,
        base + "/media/videos",
        {
            "board_version_id": current["version_id"],
            "shot_ids": [shot["id"] for shot in body["shots"]],
            "sequential": True,
        },
    )
    assert regenerated.status_code == 202, regenerated.text
    for job in regenerated.json():
        execute(job["id"])
        poll_ready()
        execute(job["id"])
        poll_ready()
    assert len(media_provider["audio"]) == audio_calls
    state = client.get(base + "/finishing").json()
    assert state["blockers"] == [], state["blockers"]
    assert all(not c["lines"] for c in state["draft"]["clips"][1:])


def test_background_loop_original_audio_and_crop_are_rendered(tmp_path):
    import array
    import subprocess

    from shortfilm.finishing.render import compose

    video = tmp_path / "source.mp4"
    music = tmp_path / "music.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=green:s=320x180:d=2:r=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=800:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(video),
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=400:duration=0.2",
            str(music),
        ],
        check=True,
    )
    draft = {
        "fps": 24,
        "fit": "crop",
        "narration": False,
        "subtitles": False,
        "original_audio": True,
        "voice_volume": 1,
        "original_volume": 0.5,
        "music_volume": 0.3,
    }
    snapshot = {
        "specification": {"width": 180, "height": 320},
        "draft": draft,
        "clips": [
            {"file": {"object_key": str(video)}, "trim_start": 0.5, "duration": 1, "lines": []}
        ],
        "duration": 1,
        "music": {"object_key": str(music)},
    }
    output = tmp_path / "output.mp4"
    result = compose(snapshot, output, lambda key: key, lambda: True)
    assert result["width"] == 180 and result["height"] == 320 and result["duration"] == 1
    samples = array.array("h")
    samples.frombytes(
        subprocess.check_output(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(output),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "s16le",
                "-",
            ]
        )
    )
    import math

    # Both original 800Hz and looped 400Hz remain present after music's first 0.2s.
    section = samples[4000:7200]
    for frequency in (400, 800):
        power = abs(
            sum(v * math.cos(2 * math.pi * frequency * i / 8000) for i, v in enumerate(section))
        ) + abs(
            sum(v * math.sin(2 * math.pi * frequency * i / 8000) for i, v in enumerate(section))
        )
        assert power > 100000
