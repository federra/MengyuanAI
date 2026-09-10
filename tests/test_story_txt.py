"""TXT import preserves source bytes and atomically switches the active story."""

# ruff: noqa: F811
from uuid import uuid4

import pytest
from test_story import client, model, new_project, post  # noqa: F401


def imported(client, base, text="  原文第一句。\r\n第二行\n", selected=None, key=None):
    return post(
        client,
        base + "/stories/import-txt",
        {
            "filename": "完整故事.txt",
            "text": text,
            "expected_story_version_id": selected,
        },
        key,
    )


def test_txt_fulltext_idempotency_history_and_scope(client):
    base = f"/api/v1/projects/{new_project(client)}"
    text = " \n" + "长篇全文。" * 12000 + "\r\n尾声  "
    key = str(uuid4())
    response = imported(client, base, text, key=key)
    assert response.status_code == 200, response.text
    data = response.json()
    item = data["items"][0]
    assert data["source_mode"] == "txt" and data["total"] == 1
    assert data["selected_version_id"] == item["version_id"]
    assert item["body"]["text"] == text
    assert item["body"]["title"] == "完整故事"
    assert "原文摘录" in item["body"]["direction"]
    assert imported(client, base, text, key=key).json() == data
    assert imported(client, base, "不同", key=key).status_code == 409
    assert imported(client, base).status_code == 409
    other = f"/api/v1/projects/{new_project(client)}"
    assert imported(client, other, selected=item["version_id"]).status_code == 409
    assert client.get(other + f"/versions/{item['version_id']}").status_code == 404
    saved = client.put(base + f"/stories/{item['id']}", json={"revision": 1, "body": item["body"]})
    assert saved.status_code == 200 and saved.json()["body"]["text"] == text
    blocked = post(
        client,
        base + "/stages/script/generate",
        {
            "source_version_id": item["version_id"],
            "target_revision": 0,
        },
    )
    assert blocked.status_code == 422 and "改编范围" in blocked.text
    next_data = imported(client, base, "新全文", selected=item["version_id"]).json()
    assert next_data["total"] == 1
    assert client.get(base + f"/versions/{item['version_id']}").json()["body"]["text"] == text
    assert client.get(base + "/stories").json() == next_data


@pytest.mark.parametrize(
    "filename,text",
    [
        ("a.pdf", "内容"),
        ("a.txt", " \n\t"),
        ("a.txt", "中" * 349526),
        ("a.txt", "二进制\x00内容"),
    ],
    ids=["extension", "blank", "oversize", "binary"],
)
def test_txt_invalid_input_retains_existing_story(client, filename, text):
    base = f"/api/v1/projects/{new_project(client)}"
    before = imported(client, base).json()
    response = post(
        client,
        base + "/stories/import-txt",
        {
            "filename": filename,
            "text": text,
            "expected_story_version_id": before["selected_version_id"],
        },
    )
    assert response.status_code == 422
    assert client.get(base + "/stories").json() == before


def test_txt_ai_batch_restores_candidates_and_import_invalidates_downstream(client, model):
    from shortfilm.creation.service import append_version
    from shortfilm.db import Session
    from shortfilm.jobs.service import execute_job
    from shortfilm.models import ContentItem, Project

    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    original = imported(client, base).json()["items"][0]
    with Session.begin() as db:
        project = db.get(Project, pid)
        script = ContentItem(id=uuid4(), project_id=project.id, kind="script", revision=0)
        db.add(script)
        db.flush()
        from uuid import UUID

        append_version(
            db, project, script, {"text": "旧剧本"}, "manual", UUID(original["version_id"])
        )
        script_id = str(script.id)
    assert not client.get(base + "/stages/script").json()["item"]["stale"]
    imported(client, base, "替换全文", selected=original["version_id"])
    assert client.get(base + "/stages/script").json()["item"]["stale"]
    assert client.get(base + f"/contents/{script_id}/versions").status_code == 200
    idea = client.put(base + "/idea", json={"revision": 0, "text": "生成新批次"}).json()
    job = post(client, base + "/story-batches", {"idea_version_id": idea["version_id"]})
    assert job.status_code == 202
    execute_job(job.json()["id"])
    stories = client.get(base + "/stories").json()
    assert stories["source_mode"] == "idea"
    assert stories["total"] == 5 and len(stories["items"]) == 3


def test_txt_manual_edit_rejects_blank_without_whitespace_loss(client):
    base = f"/api/v1/projects/{new_project(client)}"
    item = imported(client, base).json()["items"][0]
    response = client.put(
        base + f"/stories/{item['id']}",
        json={
            "revision": 1,
            "body": {**item["body"], "text": " \n "},
        },
    )
    assert response.status_code == 422
    assert client.get(base + "/stories").json()["items"][0]["body"] == item["body"]
