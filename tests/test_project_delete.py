# ruff: noqa: F401, F811
from test_story import client, new_project


def test_delete_preserves_history_and_restore(client):
    pid = new_project(client)
    base = f'/api/v1/projects/{pid}'
    idea = client.put(base + '/idea', json={'revision': 0, 'text': '保留这段创意'}).json()
    project = client.get(base).json()
    assert client.delete(base, params={'revision': project['revision'] + 1}).status_code == 409
    assert client.delete(base, params={'revision': project['revision']}).status_code == 200
    assert client.delete(base, params={'revision': project['revision']}).status_code == 200
    assert client.get(base).status_code == 404
    assert client.put(base + '/idea', json={'revision': 1, 'text': '不能修改'}).status_code == 404
    assert pid not in [p['id'] for p in client.get('/api/v1/projects?limit=100').json()['items']]
    assert client.post(base + '/restore').status_code == 200
    assert client.get(base + '/idea').json()['version_id'] == idea['version_id']
    assert client.post(base + '/restore').status_code == 200


def test_delete_blocks_active_unknown_and_cross_owner(client, monkeypatch):
    from uuid import UUID, uuid4

    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.models import Job, Project
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    with Session.begin() as db:
        p = db.get(Project, UUID(pid))
        job = Job(project_id=p.id, owner_id=p.owner_id, kind="image.character", state="unknown", idempotency_key=str(uuid4()), source_fingerprint="test", snapshot={})
        db.add(job)
        db.flush()
        jid = job.id
    for state in ["unknown", "queued", "running", "waiting_provider", "waiting_dependency"]:
        with Session.begin() as db:
            db.get(Job, jid).state = state
        assert client.delete(base, params={"revision": 1}).status_code == 409
    with Session.begin() as db:
        db.get(Job, jid).state = "failed"
    with monkeypatch.context() as patch:
        patch.setattr(settings, "local_owner_id", uuid4())
        assert client.delete(base, params={"revision": 1}).status_code == 404
        assert client.post(base + "/restore").status_code == 404
    assert client.delete(base, params={"revision": 1}).status_code == 200
