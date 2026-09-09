# ruff: noqa: F811
"""M2 project elements against real PostgreSQL; no paid calls."""

from test_story import client, new_project  # noqa: F401


def test_entity_versions_conflict_history_and_project_isolation(client):
    pid, other = new_project(client), new_project(client)
    root = f"/api/v1/projects/{pid}/entities"
    body = {"kind": "character", "name": "邮差", "description": "蓝制服", "voice": "voice-a"}
    created = client.post(root, json=body)
    assert created.status_code == 201, created.text
    entity = created.json()
    assert entity["revision"] == 1
    assert client.get(root).json() == [entity]
    update = {**body, "revision": 1, "name": "小林"}
    renamed = client.put(root + "/" + entity["id"], json=update)
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["id"] == entity["id"]
    assert renamed.json()["revision"] == 2
    assert client.put(root + "/" + entity["id"], json=update).status_code == 409
    history = client.get(root + "/" + entity["id"] + "/versions").json()
    assert [v["name"] for v in history] == ["小林", "邮差"]
    foreign = f"/api/v1/projects/{other}/entities/{entity['id']}"
    assert client.get(foreign + "/versions").status_code == 404
    assert client.put(foreign, json={**update, "revision": 2}).status_code == 404


def test_entity_rejects_empty_names_and_kind_change(client):
    root = f"/api/v1/projects/{new_project(client)}/entities"
    assert client.post(root, json={"kind": "character", "name": "  "}).status_code == 422
    entity = client.post(root, json={"kind": "scene", "name": "邮局"})
    assert entity.status_code == 201, entity.text
    changed = client.put(
        root + "/" + entity.json()["id"], json={"revision": 1, "kind": "prop", "name": "邮局"}
    )
    assert changed.status_code == 422
    assert client.get(root).json()[0]["revision"] == 1


def upload_image(client, pid):
    import io

    from PIL import Image

    stream = io.BytesIO()
    Image.new("RGB", (32, 32), "red").save(stream, "PNG")
    response = client.post(
        f"/api/v1/projects/{pid}/files",
        files={"file": ("test-fixture.png", stream.getvalue(), "image/png")},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_reference_confirmation_tracks_entity_content_and_retains_history(client):
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(
        base + "/entities", json={"kind": "character", "name": "邮差", "description": "蓝制服"}
    ).json()
    file_id = upload_image(client, pid)
    attached = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": 1, "file_id": file_id},
    )
    assert attached.status_code == 201, attached.text
    image = attached.json()
    assert not image["confirmed"] and not image["stale"]
    confirmed = client.post(
        base + f"/reference-images/{image['id']}/confirm", json={"specification_revision": 1}
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["confirmed"]
    renamed = client.put(
        base + "/entities/" + entity["id"],
        json={"revision": 1, "kind": "character", "name": "小林", "description": "蓝制服"},
    ).json()
    assert client.get(base + "/reference-images").json()[0]["confirmed"]
    client.put(
        base + "/entities/" + entity["id"],
        json={
            "revision": renamed["revision"],
            "kind": "character",
            "name": "小林",
            "description": "红制服",
        },
    )
    old = client.get(base + "/reference-images").json()[0]
    assert old["stale"] and not old["confirmed"]
    assert old["file_id"] == file_id
    assert (
        client.post(
            base + f"/reference-images/{image['id']}/confirm", json={"specification_revision": 1}
        ).status_code
        == 409
    )
    assert client.get(base + "/files/" + file_id).status_code == 200


def test_reference_rejects_cross_project_files_and_conflicting_sources(client):
    pid, other = new_project(client), new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(base + "/entities", json={"kind": "prop", "name": "信"}).json()
    foreign_file = upload_image(client, other)
    response = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": 1, "file_id": foreign_file},
    )
    assert response.status_code == 404, response.text
    local_file = upload_image(client, pid)
    response = client.post(
        base + "/reference-images",
        json={"entity_id": entity["id"], "entity_revision": 2, "file_id": local_file},
    )
    assert response.status_code == 409
    assert client.get(base + "/reference-images").json() == []


def test_reference_specification_change_requires_reconfirmation(client):
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(base + "/entities", json={"kind": "scene", "name": "邮局"}).json()
    body = {"entity_id": entity["id"], "entity_revision": 1, "file_id": upload_image(client, pid)}
    image = client.post(base + "/reference-images", json=body).json()
    assert client.post(base + "/reference-images", json=body).json()["id"] == image["id"]
    url = base + f"/reference-images/{image['id']}/confirm"
    assert client.post(url, json={"specification_revision": 1}).json()["confirmed"]
    # Existing configuration API persists output versions and marks media for review.
    saved = client.put(
        base + "/specification",
        json={"base_version": 1, "aspect_ratio": "16:9", "resolution": "720P"},
    )
    assert saved.status_code == 200, saved.text
    assert not client.get(base + "/reference-images").json()[0]["confirmed"]
    assert client.post(url, json={"specification_revision": 1}).status_code == 409


def test_reconfirmed_file_new_entity_version_is_usable_despite_old_binding(client):
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.media.sources import reference_valid
    from shortfilm.models import Project

    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    entity = client.post(base + "/entities", json={"kind": "prop", "name": "信"}).json()
    fid = upload_image(client, pid)
    old = client.post(
        base + "/reference-images",
        json={
            "entity_id": entity["id"],
            "entity_revision": 1,
            "file_id": fid,
        },
    ).json()
    client.post(base + f"/reference-images/{old['id']}/confirm", json={"specification_revision": 1})
    changed = client.put(
        base + "/entities/" + entity["id"],
        json={
            "revision": 1,
            "kind": "prop",
            "name": "信",
            "description": "新封面",
        },
    )
    assert changed.status_code == 200
    with Session() as db:
        assert not reference_valid(db, db.get(Project, UUID(pid)), fid)
    new = client.post(
        base + "/reference-images",
        json={
            "entity_id": entity["id"],
            "entity_revision": 2,
            "file_id": fid,
        },
    ).json()
    confirmed = client.post(
        base + f"/reference-images/{new['id']}/confirm", json={"specification_revision": 1}
    )
    assert confirmed.status_code == 200
    with Session() as db:
        assert reference_valid(db, db.get(Project, UUID(pid)), fid)
