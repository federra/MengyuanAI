"""V12 quantities against isolated PG; only model transport is replaced."""

# ruff: noqa: F811
import json
from uuid import uuid4

import pytest
from test_story import client, model, new_project, post  # noqa: F401


@pytest.mark.parametrize("count", [0, 4, 1.5, 1.0, True, None, "2"])
def test_invalid_count_rejected_before_writes(client, count):
    base = f"/api/v1/projects/{new_project(client)}"
    assert (
        client.put(
            base + "/idea", json={"revision": 0, "text": "保留创意", "story_count": count}
        ).status_code
        == 422
    )
    assert client.get(base + "/idea").json() is None
    assert (
        post(
            client, base + "/story-batches", {"idea_version_id": str(uuid4()), "story_count": count}
        ).status_code
        == 422
    )


@pytest.mark.parametrize("count", [1, 2, 3])
def test_count_persistence_frozen_transport_and_exact_output(client, model, monkeypatch, count):
    from shortfilm.jobs.service import execute_job

    base = f"/api/v1/projects/{new_project(client)}"
    source = "邮差收到未来来信。每份故事写800字，保留完整结局。"
    saved = client.put(
        base + "/idea", json={"revision": 0, "text": source, "story_count": count}
    ).json()
    assert saved["body"]["story_count"] == count
    assert client.get(base + "/idea").json()["body"]["story_count"] == count
    other = f"/api/v1/projects/{new_project(client)}"
    assert (
        client.put(other + "/idea", json={"revision": 0, "text": "其他项目"}).json()["body"][
            "story_count"
        ]
        == 3
    )
    same = client.put(base + "/idea", json={"revision": saved["revision"], "text": source}).json()
    assert same["version_id"] == saved["version_id"]
    body = {"idea_version_id": saved["version_id"]}
    key = str(uuid4())
    response = post(client, base + "/story-batches", body, key)
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["snapshot"]["story_count"] == count
    assert job["snapshot"]["applicationConstraints"] == {"storyCount": count}
    assert job["snapshot"]["sourceIdea"] == source
    changed = client.put(
        base + "/idea",
        json={"revision": saved["revision"], "text": source, "story_count": 1 if count != 1 else 2},
    ).json()
    assert changed["version_id"] == saved["version_id"]
    assert post(client, base + "/story-batches", body, key).json()["id"] == job["id"]
    assert (
        post(
            client, base + "/story-batches", {**body, "story_count": 1 if count != 1 else 2}, key
        ).status_code
        == 409
    )

    def response(config, messages, schema):
        context = json.loads(messages[1]["content"])
        assert context["sourceIdea"] == source
        assert context["applicationConstraints"]["storyCount"] == count
        assert str(count) in messages[0]["content"]
        assert schema["properties"]["stories"]["minItems"] == count
        assert schema["properties"]["stories"]["maxItems"] == count
        return {
            "stories": [
                {
                    "title": f"方案{i}",
                    "direction": f"方向{i}",
                    "logline": "邮差",
                    "text": f"完整正文{i}",
                }
                for i in range(count)
            ]
        }, {}

    monkeypatch.setattr(model, "request_json", response)
    execute_job(job["id"])
    assert client.get(f"/api/v1/jobs/{job['id']}").json()["state"] == "succeeded"
    page = client.get(base + "/stories").json()
    assert page["total"] == count
    assert [s["body"]["title"] for s in page["items"]] == [f"方案{i}" for i in range(count)]
    assert {s["batch_id"] for s in page["items"]} == {job["id"]}


def test_wrong_quantity_bounded_correction_keeps_history(client, model, monkeypatch):
    from shortfilm.jobs.service import execute_job

    base = f"/api/v1/projects/{new_project(client)}"
    idea = client.put(
        base + "/idea", json={"revision": 0, "text": "原始要求", "story_count": 1}
    ).json()
    calls = []

    def wrong(*args):
        calls.append(1)
        return {
            "stories": [
                {"title": f"{i}", "direction": f"{i}", "logline": "a", "text": f"{i}"}
                for i in range(2)
            ]
        }, {}

    monkeypatch.setattr(model, "request_json", wrong)
    job = post(client, base + "/story-batches", {"idea_version_id": idea["version_id"]}).json()
    execute_job(job["id"])
    assert client.get(f"/api/v1/jobs/{job['id']}").json()["state"] == "failed"
    assert len(calls) == 3
    assert client.get(base + "/stories").json()["total"] == 0
    assert client.get(base + "/idea").json()["version_id"] == idea["version_id"]


def test_legacy_task_count_defaults_three_and_pagination_is_stable(client, model):
    from shortfilm.jobs.service import execute_job

    base = f"/api/v1/projects/{new_project(client)}"
    idea = client.put(base + "/idea", json={"revision": 0, "text": "旧项目未设置数量"}).json()
    assert idea["body"]["story_count"] == 3
    for _ in range(2):
        job = post(client, base + "/story-batches", {"idea_version_id": idea["version_id"]}).json()
        execute_job(job["id"])
    first = client.get(base + "/stories").json()
    second = client.get(base + "/stories?offset=3").json()
    assert first["total"] == second["total"] == 6
    assert len(first["items"]) == len(second["items"]) == 3
    assert first == client.get(base + "/stories").json()
    assert not ({i["id"] for i in first["items"]} & {i["id"] for i in second["items"]})
    from pydantic import ValidationError
    from shortfilm.creation.stage_execution import validate_output

    valid = {"stories": [i["body"] for i in first["items"]]}
    assert len(validate_output(None, {"kind": "story.generate"}, valid)["stories"]) == 3
    with pytest.raises(ValidationError):
        validate_output(None, {"kind": "story.generate"}, {"stories": valid["stories"][:1]})


@pytest.mark.parametrize("stage", ["novel", "story.generate"])
def test_story_count_template_requires_variable_for_new_revision(client, stage):
    base = "/api/v1/settings/resources"
    body = {
        "name": "数量契约" + uuid4().hex,
        "kind": "prompt",
        "stage": stage,
        "content": "写三份故事",
    }
    assert client.post(base, json=body).status_code == 422
    valid = {**body, "content": "写{{storyCount}}份完整故事", "required_variables": ["storyCount"]}
    saved = client.post(base, json=valid)
    assert saved.status_code == 201, saved.text
    data = saved.json()
    assert (
        client.put(
            base + "/" + data["id"],
            json={"base_version": data["revision"], "name": body["name"], "content": "重新写三份"},
        ).status_code
        == 422
    )
