import hashlib
import io
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select, text


def test_foundation_exists():
    from shortfilm.main import app

    assert app.title == "AI短片工坊"


@pytest.fixture
def client():
    from shortfilm.main import app

    with TestClient(app) as c:
        yield c


def project(client):
    response = client.post("/api/v1/projects", json={"name": "测试短片", "market": "zh"})
    assert response.status_code == 201, response.text
    return response.json()


def upload(client, pid):
    data = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(data, format="PNG")
    result = client.post(
        f"/api/v1/projects/{pid}/files",
        files={"file": ("a.png", data.getvalue(), "image/png")},
    )
    assert result.status_code == 201, result.text
    return result.json(), data.getvalue()


def test_project_persistence_conflict_validation(client):
    assert client.post("/api/v1/projects", json={"name": "  "}).status_code == 422
    p = project(client)
    assert p["generation_settings"]["aspect_ratio"] == "9:16"
    assert p["revision"] == 1
    assert (
        client.patch(
            f"/api/v1/projects/{p['id']}", json={"name": "新名字", "revision": 1}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/v1/projects/{p['id']}", json={"name": "覆盖", "revision": 1}
        ).status_code
        == 409
    )
    from shortfilm.db import engine

    engine.dispose()
    saved = client.get(f"/api/v1/projects/{p['id']}").json()
    assert saved["name"] == "新名字"
    assert saved["revision"] == 2


def test_file_integrity_and_project_isolation(client):
    p, other = project(client), project(client)
    f, raw = upload(client, p["id"])
    assert f["sha256"] == hashlib.sha256(raw).hexdigest()
    assert client.get(f"/api/v1/projects/{p['id']}/files/{f['id']}").content == raw
    assert client.get(f"/api/v1/projects/{other['id']}/files/{f['id']}").status_code == 404
    assert (
        client.post(
            f"/api/v1/projects/{p['id']}/files",
            files={"file": ("bad.png", b"not png", "image/png")},
        ).status_code
        == 422
    )


def test_storage_rejects_escape(tmp_path):
    from shortfilm.media.storage import LocalStorage

    storage = LocalStorage(tmp_path / "media")
    for key in ["../escape", "/tmp/escape", "a/../../escape", "", "a\\b"]:
        with pytest.raises(ValueError):
            storage.path(key)
    (tmp_path / "media" / "link").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError):
        storage.path("link/escape")


def test_job_idempotency_and_duplicate_delivery(client):
    from shortfilm.db import Session
    from shortfilm.jobs.service import execute_job
    from shortfilm.models import JobResult

    p = project(client)
    f, _ = upload(client, p["id"])
    url = f"/api/v1/projects/{p['id']}/jobs"
    key = str(uuid.uuid4())
    body = {"kind": "file.verify", "file_id": f["id"]}

    def submit(_):
        return client.post(url, json=body, headers={"Idempotency-Key": key})

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(submit, range(4)))
    assert all(r.status_code == 202 for r in responses)
    ids = {r.json()["id"] for r in responses}
    assert len(ids) == 1
    jid = ids.pop()
    f2, _ = upload(client, p["id"])
    assert (
        client.post(
            url, json={**body, "file_id": f2["id"]}, headers={"Idempotency-Key": key}
        ).status_code
        == 409
    )
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(execute_job, [jid] * 4))
    assert client.get(f"/api/v1/jobs/{jid}").json()["state"] == "succeeded"
    with Session() as s:
        assert (
            s.scalar(
                select(func.count())
                .select_from(JobResult)
                .where(JobResult.job_id == uuid.UUID(jid))
            )
            == 1
        )


def test_expired_lease_recovery_fences_old_worker(client):
    from shortfilm.db import Session
    from shortfilm.jobs.service import claim_job, execute_job, finish_job, recover_jobs

    p = project(client)
    f, _ = upload(client, p["id"])
    j = client.post(
        f"/api/v1/projects/{p['id']}/jobs",
        json={"kind": "file.verify", "file_id": f["id"]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    ).json()
    token = claim_job(j["id"])
    assert token
    with Session.begin() as s:
        s.execute(
            text("UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=:id"),
            {"id": j["id"]},
        )
    recover_jobs()
    assert not finish_job(j["id"], token, {"bad": "old result"})
    execute_job(j["id"])
    assert client.get(f"/api/v1/jobs/{j['id']}").json()["state"] == "succeeded"


def test_owner_isolation(client):
    from shortfilm.db import Session
    from shortfilm.models import Principal, Project

    with Session.begin() as s:
        owner = Principal(name="another")
        s.add(owner)
        s.flush()
        foreign = Project(name="private", owner_id=owner.id)
        s.add(foreign)
        s.flush()
        pid = str(foreign.id)
    assert client.get(f"/api/v1/projects/{pid}").status_code == 404
    assert (
        client.patch(f"/api/v1/projects/{pid}", json={"name": "leak", "revision": 1}).status_code
        == 404
    )


def test_settings_safe_and_seed_repeatable(client):
    from shortfilm.seed import seed

    seed()
    seed()
    config = client.get("/api/v1/settings").json()
    assert config["mode"] == "local"
    assert {"营销短视频", "通用短视频", "剧情短片"} <= {t["name"] for t in config["project_types"]}
    assert "database_url" not in config
    assert "redis_url" not in config
