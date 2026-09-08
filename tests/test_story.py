"""Story behavior against PostgreSQL; only the external model transport is replaced."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from shortfilm.main import app

    with TestClient(app) as client:
        yield client


def new_project(client):
    return client.post("/api/v1/projects", json={"name": "故事验收"}).json()["id"]


def post(client, url, body, key=None):
    return client.post(url, json=body, headers={"Idempotency-Key": key or str(uuid4())})


def test_idea_versions_conflict_and_owner_isolation(client):
    pid = new_project(client)
    url = f"/api/v1/projects/{pid}/idea"
    saved = client.put(url, json={"revision": 0, "text": "邮差收到未来的信"})
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert client.put(url, json={"revision": 0, "text": "覆盖"}).status_code == 409
    assert client.put(url, json={"revision": 1, "text": "  "}).status_code == 422
    version = saved.json()["version_id"]
    saved2 = client.put(url, json={"revision": 1, "text": "邮差决定不送最后一封信"}).json()
    history = client.get(f"/api/v1/projects/{pid}/contents/{saved2['id']}/versions").json()
    assert [v["revision"] for v in history] == [2, 1]
    assert history[1]["id"] == version
    assert history[1]["body"]["text"] == "邮差收到未来的信"
    other = new_project(client)
    assert (
        client.get(f"/api/v1/projects/{other}/contents/{saved2['id']}/versions").status_code == 404
    )


@pytest.fixture
def model(monkeypatch):
    from shortfilm.config import settings
    from shortfilm.creation import provider

    monkeypatch.setattr(settings, "text_endpoint", "https://model.example/v1")
    monkeypatch.setattr(settings, "text_model", "test-model")
    monkeypatch.setattr(settings, "text_credential_ref", "STORY_TEST_KEY")
    monkeypatch.setenv("STORY_TEST_KEY", "test-only-secret")

    def response(config, messages, schema):
        if "stories" in schema.get("properties", {}):
            return {
                "stories": [
                    {
                        "title": "迟到的信",
                        "logline": "邮差改变命运",
                        "direction": "悬疑",
                        "text": "邮差发现信来自未来，最终将它留给过去的自己。",
                    },
                    {
                        "title": "最后一站",
                        "logline": "邮差与父亲和解",
                        "direction": "亲情",
                        "text": "邮差找到退休的父亲，父子一同走完最后一段邮路。",
                    },
                    {
                        "title": "空白信封",
                        "logline": "小镇传递善意",
                        "direction": "喜剧",
                        "text": "空信封引发误会，小镇居民终于说出想说的话。",
                    },
                ]
            }, {"provider_request_id": "fixture-response", "usage": {"total_tokens": 100}}
        return {
            "text": "邮差发现未来的来信，决定先向父亲道歉。",
            "changeSummary": "强化亲情动机",
        }, {"provider_request_id": "fixture-revision", "usage": {}}

    monkeypatch.setattr(provider, "request_json", response)
    return provider


def generate(client, pid):
    from shortfilm.jobs.service import execute_job

    idea = client.put(
        f"/api/v1/projects/{pid}/idea", json={"revision": 0, "text": "邮差收到未来的信"}
    ).json()
    url = f"/api/v1/projects/{pid}/story-batches"
    body = {"idea_version_id": idea["version_id"], "instruction": "写出完整结局", "style": "温暖"}
    key = str(uuid4())
    response = post(client, url, body, key)
    assert response.status_code == 202, response.text
    job = response.json()
    assert post(client, url, body, key).json()["id"] == job["id"]
    assert post(client, url, {**body, "instruction": "改变结局"}, key).status_code == 409
    execute_job(job["id"])
    assert client.get(f"/api/v1/jobs/{job['id']}").json()["state"] == "succeeded"
    return idea, job, body


def test_generation_selection_revision_apply_and_history(client, model):
    from shortfilm.jobs.service import execute_job

    pid = new_project(client)
    _, job, body = generate(client, pid)
    url = f"/api/v1/projects/{pid}"
    page = client.get(url + "/stories").json()
    assert page["total"] == 3
    story = page["items"][0]
    assert not page["selected_version_id"]
    selected = post(
        client,
        url + f"/stories/{story['id']}/select",
        {"version_id": story["version_id"], "selection_revision": 0},
    )
    assert selected.status_code == 200, selected.text
    proposal_job = post(
        client,
        url + f"/contents/{story['id']}/messages",
        {"base_version_id": story["version_id"], "text": "强化亲情动机"},
    ).json()
    execute_job(proposal_job["id"])
    conversation = client.get(url + f"/contents/{story['id']}/conversation").json()
    proposal = conversation["proposals"][0]
    assert len(conversation["messages"]) == 2
    assert client.get(url + "/stories").json()["items"][0]["body"] == story["body"]
    applied = post(client, url + f"/proposals/{proposal['id']}/apply", {})
    assert applied.status_code == 200, applied.text
    assert applied.json()["revision"] == 2
    assert (
        post(client, url + f"/proposals/{proposal['id']}/apply", {}).json()["version_id"]
        == applied.json()["version_id"]
    )
    page = client.get(url + "/stories").json()
    assert page["selected_version_id"] is None
    assert page["selection_revision"] == 2
    history = client.get(url + f"/contents/{story['id']}/versions").json()
    assert history[1]["body"] == story["body"]
    again = post(client, url + "/story-batches", body).json()
    execute_job(again["id"])
    execute_job(again["id"])
    assert client.get(url + "/stories").json()["total"] == 6
    assert len(client.get(url + "/stories?offset=3").json()["items"]) == 3
    assert "test-only-secret" not in client.get(f"/api/v1/jobs/{job['id']}").text


def test_stale_proposal_rejected_without_losing_manual_version(client, model):
    from shortfilm.jobs.service import execute_job

    pid = new_project(client)
    generate(client, pid)
    url = f"/api/v1/projects/{pid}"
    story = client.get(url + "/stories").json()["items"][0]
    job = post(
        client,
        url + f"/contents/{story['id']}/messages",
        {"base_version_id": story["version_id"], "text": "改变结尾"},
    ).json()
    edited = client.put(
        url + f"/stories/{story['id']}",
        json={"revision": 1, "body": {**story["body"], "text": "人工保存的新结局"}},
    )
    assert edited.status_code == 200, edited.text
    execute_job(job["id"])
    proposal = client.get(url + f"/contents/{story['id']}/conversation").json()["proposals"][0]
    assert post(client, url + f"/proposals/{proposal['id']}/apply", {}).status_code == 409
    other = new_project(client)
    assert (
        post(client, f"/api/v1/projects/{other}/proposals/{proposal['id']}/apply", {}).status_code
        == 404
    )
    assert client.get(url + "/stories").json()["items"][0]["body"]["text"] == "人工保存的新结局"


def test_invalid_output_and_unknown_recovery(client, model, monkeypatch):
    from shortfilm.db import Session
    from shortfilm.jobs.service import claim_job, execute_job, finish_job, recover_jobs
    from sqlalchemy import text

    pid = new_project(client)
    _, _, body = generate(client, pid)
    url = f"/api/v1/projects/{pid}"
    monkeypatch.setattr(model, "request_json", lambda *args: ({"stories": []}, {}))
    job = post(client, url + "/story-batches", body).json()
    execute_job(job["id"])
    assert client.get(f"/api/v1/jobs/{job['id']}").json()["state"] == "failed"
    assert client.get(url + "/stories").json()["total"] == 3
    retry = post(client, f"/api/v1/jobs/{job['id']}/retry", {"confirm_unknown": False}).json()
    token = claim_job(retry["id"])
    with Session.begin() as db:
        db.execute(
            text("UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=:id"),
            {"id": retry["id"]},
        )
    recover_jobs()
    assert client.get(f"/api/v1/jobs/{retry['id']}").json()["state"] == "unknown"
    assert not finish_job(retry["id"], token, {})
    assert (
        post(client, f"/api/v1/jobs/{retry['id']}/retry", {"confirm_unknown": False}).status_code
        == 409
    )
    new = post(client, f"/api/v1/jobs/{retry['id']}/retry", {"confirm_unknown": True})
    assert new.status_code == 202, new.text
    assert new.json()["snapshot"]["retry_of"] == retry["id"]


def test_retry_parent_cannot_fork_duplicate_paid_attempts(client, model, monkeypatch):
    from shortfilm.jobs.service import execute_job

    pid = new_project(client)
    _, _, body = generate(client, pid)
    monkeypatch.setattr(model, "request_json", lambda *args: ({"stories": []}, {}))
    job = post(client, f"/api/v1/projects/{pid}/story-batches", body).json()
    execute_job(job["id"])
    first = post(client, f"/api/v1/jobs/{job['id']}/retry", {}).json()
    duplicate = post(client, f"/api/v1/jobs/{job['id']}/retry", {}).json()
    assert duplicate["id"] == first["id"]


def test_concurrent_story_edit_only_one_version_wins(client, model):
    from concurrent.futures import ThreadPoolExecutor

    pid = new_project(client)
    generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]

    def save(text):
        return client.put(
            base + f"/stories/{story['id']}",
            json={"revision": 1, "body": {**story["body"], "text": text}},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ["第一个结局", "第二个结局"]))
    assert sorted(r.status_code for r in results) == [200, 409]
    history = client.get(base + f"/contents/{story['id']}/versions").json()
    assert [v["revision"] for v in history] == [2, 1]
