# ruff: noqa: F811
"""Explicit library snapshots own bytes; adoptions create project-owned copies."""

from uuid import uuid4

from test_media_assets import upload_image
from test_story import client, new_project  # noqa: F401


def snapshot_fixture(client):
    pid = new_project(client)
    source = upload_image(client, pid)
    entity = client.post(
        f"/api/v1/projects/{pid}/entities",
        json={
            "kind": "character",
            "name": "松鼠",
            "description": "蓝围巾",
            "voice": "warm",
            "three_view": True,
            "input_file_id": source,
            "output_file_id": source,
        },
    )
    assert entity.status_code == 201, entity.text
    eid = entity.json()["id"]
    response = client.post(
        f"/api/v1/projects/{pid}/entities/{eid}/library-snapshots",
        json={"entity_revision": 1},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 201, response.text
    return pid, source, entity.json(), response.json()


def test_library_explicit_snapshot_bytes_and_source_changes(client):
    pid, fid, entity, asset = snapshot_fixture(client)
    assert asset["source_entity_id"] == entity["id"]
    assert asset["version"] == 1
    assert asset["input_image"]["id"] != asset["output_image"]["id"]
    raw = client.get(f"/api/v1/projects/{pid}/files/{fid}").content
    for role in ("input_image", "output_image"):
        assert client.get(asset[role]["url"]).content == raw
    changed = client.put(
        f"/api/v1/projects/{pid}/entities/{entity['id']}",
        json={
            "revision": 1,
            "kind": "character",
            "name": "改名",
            "description": "红围巾",
        },
    )
    assert changed.status_code == 200, changed.text
    listed = next(
        row for row in client.get("/api/v1/library/assets").json() if row["id"] == asset["id"]
    )
    assert listed["name"] == "松鼠" and listed["description"] == "蓝围巾"
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.media.storage import LocalStorage
    from shortfilm.models import MediaFile

    with Session() as db:
        source = db.get(MediaFile, fid)
        LocalStorage(settings.storage_root).path(source.object_key).unlink()
    assert client.get(asset["input_image"]["url"]).content == raw
    assert client.get(f"/api/v1/library/assets/{asset['id']}/images/{fid}").status_code == 404


def test_library_adoption_owns_copies_and_idempotency(client):
    source_pid, fid, _, asset = snapshot_fixture(client)
    pid = new_project(client)
    url = f"/api/v1/projects/{pid}/library-assets/{asset['id']}/adoptions"
    body = {"library_version": 1, "id": str(uuid4())}
    headers = {"Idempotency-Key": str(uuid4())}
    assert client.post(url, json=body).status_code == 422
    response = client.post(url, json=body, headers=headers)
    assert response.status_code == 201, response.text
    adopted = response.json()
    assert adopted["id"] == body["id"]
    assert adopted["library_asset_id"] == asset["id"]
    assert adopted["library_version"] == 1
    assert adopted["input_file_id"] != fid
    assert adopted["output_file_id"] != adopted["input_file_id"]
    assert client.post(url, json=body, headers=headers).json() == adopted
    assert client.post(url, json={**body, "id": str(uuid4())}, headers=headers).status_code == 409
    assert (
        client.post(
            url, json={**body, "library_version": 2}, headers={"Idempotency-Key": str(uuid4())}
        ).status_code
        == 409
    )
    for key in ("input_file_id", "output_file_id"):
        assert client.get(f"/api/v1/projects/{pid}/files/{adopted[key]}").status_code == 200
        assert client.get(f"/api/v1/projects/{source_pid}/files/{adopted[key]}").status_code == 404
    refs = client.get(f"/api/v1/projects/{pid}/reference-images").json()
    assert any(row["file_id"] == adopted["output_file_id"] and not row["confirmed"] for row in refs)


def test_library_snapshot_requires_current_owned_entity(client):
    pid, _, entity, _ = snapshot_fixture(client)
    other = new_project(client)
    path = f"/api/v1/projects/{pid}/entities/{entity['id']}/library-snapshots"
    assert (
        client.post(
            path, json={"entity_revision": 99}, headers={"Idempotency-Key": str(uuid4())}
        ).status_code
        == 409
    )
    foreign = f"/api/v1/projects/{other}/entities/{entity['id']}/library-snapshots"
    assert (
        client.post(
            foreign, json={"entity_revision": 1}, headers={"Idempotency-Key": str(uuid4())}
        ).status_code
        == 404
    )


def test_library_snapshot_missing_source_rolls_back_and_hides_other_owner(client, monkeypatch):
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.media.storage import LocalStorage
    from shortfilm.models import MediaFile

    pid, _, entity, asset = snapshot_fixture(client)
    before = {row["id"] for row in client.get("/api/v1/library/assets").json()}
    with Session() as db:
        file = db.get(MediaFile, entity["output_file_id"])
        LocalStorage(settings.storage_root).path(file.object_key).unlink()
    response = client.post(
        f"/api/v1/projects/{pid}/entities/{entity['id']}/library-snapshots",
        json={"entity_revision": 1},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 409, response.text
    assert {row["id"] for row in client.get("/api/v1/library/assets").json()} == before
    monkeypatch.setattr(settings, "local_owner_id", uuid4())
    assert client.get("/api/v1/library/assets").json() == []
    assert client.get(asset["input_image"]["url"]).status_code == 404


def test_library_failed_adoption_keeps_project_empty_and_removes_partial_copy(client):
    from pathlib import Path

    from shortfilm.assets.library_models import LibraryAsset
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.media.storage import LocalStorage

    _, _, _, asset = snapshot_fixture(client)
    pid = new_project(client)
    with Session() as db:
        library = db.get(LibraryAsset, asset["id"])
        LocalStorage(settings.storage_root).path(library.images["output"]["object_key"]).unlink()
    response = client.post(
        f"/api/v1/projects/{pid}/library-assets/{asset['id']}/adoptions",
        json={"library_version": 1, "id": str(uuid4())},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 409, response.text
    assert client.get(f"/api/v1/projects/{pid}/entities").json() == []
    assert client.get(f"/api/v1/projects/{pid}/files").json() == []
    assert not [
        path
        for path in (Path(settings.storage_root) / "projects" / pid).glob("*")
        if path.is_file()
    ]


def test_library_snapshot_replay_returns_original_without_more_files(client):
    from pathlib import Path

    from shortfilm.config import settings

    pid, _, entity, _ = snapshot_fixture(client)
    url = f"/api/v1/projects/{pid}/entities/{entity['id']}/library-snapshots"
    body, headers = {"entity_revision": 1}, {"Idempotency-Key": str(uuid4())}
    first = client.post(url, json=body, headers=headers)
    assert first.status_code == 201, first.text
    library_root = Path(settings.storage_root) / "library"
    files = {str(p) for p in library_root.rglob("*") if p.is_file()}
    count = len(client.get("/api/v1/library/assets").json())
    # Replaying a response lost after commit must not recopy any source bytes.
    repeated = client.post(url, json=body, headers=headers)
    assert repeated.json() == first.json()
    assert len(client.get("/api/v1/library/assets").json()) == count
    assert {str(p) for p in library_root.rglob("*") if p.is_file()} == files
    assert client.post(url, json={"entity_revision": 2}, headers=headers).status_code == 409


def test_library_backup_inventory_includes_independent_snapshot_bytes(client):
    import importlib.util
    from pathlib import Path

    from psycopg import connect
    from shortfilm.config import settings
    from sqlalchemy.engine import make_url

    _, _, _, asset = snapshot_fixture(client)
    spec = importlib.util.spec_from_file_location(
        "backup_inventory", Path(__file__).resolve().parents[1] / "scripts/backup.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    url = (
        make_url(settings.database_url)
        .set(drivername="postgresql")
        .render_as_string(hide_password=False)
    )
    with connect(url) as conn:
        inventory = dict(module.stored_files(conn))
    for image in [asset["input_image"], asset["output_image"]]:
        assert inventory[f"library/{asset['id']}/{image['id']}"] == image["sha256"]
