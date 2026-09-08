from uuid import uuid4

import pytest
from test_m0 import client as client_fixture
from test_m0 import project


@pytest.fixture
def client():
    yield from client_fixture.__wrapped__()


def test_resource_versions_and_binding_snapshot(client):
    resource = client.post(
        "/api/v1/settings/resources",
        json={
            "name": "角色动机" + uuid4().hex,
            "kind": "skill",
            "stage": "story",
            "content": "建立角色目标",
        },
    )
    assert resource.status_code == 201, resource.text
    r = resource.json()
    p = project(client)
    path = f"/api/v1/settings/bindings/project:{p['id']}/method:story"
    assert (
        client.put(path, json={"base_version": 0, "value": {"resource_id": r["id"]}}).status_code
        == 200
    )
    snap = client.get(f"/api/v1/settings/resolve/{p['id']}/story.generate?stage=story").json()
    assert snap["method"]["content"] == "建立角色目标"
    update = {"base_version": 1, "name": r["name"], "content": "新增人物代价"}
    assert client.put(f"/api/v1/settings/resources/{r['id']}", json=update).status_code == 200
    assert client.put(f"/api/v1/settings/resources/{r['id']}", json=update).status_code == 409
    assert (
        client.get(f"/api/v1/settings/resources/{r['id']}?revision=1").json()["content"]
        == "建立角色目标"
    )
    assert snap["method"]["revision"] == 1
    assert (
        client.post(
            "/api/v1/settings/resources",
            json={"name": r["name"], "kind": "skill", "stage": "story", "content": "重复"},
        ).status_code
        == 409
    )


def test_model_inheritance_and_specifications(client):
    p = client.post(
        "/api/v1/projects", json={"name": "规格", "aspect_ratio": "16:9", "resolution": "4K"}
    ).json()
    assert p["generation_settings"]["width"] == 3840
    path = "/api/v1/settings/bindings/system/model:step:story.generate"
    prior = client.get(path).json()
    route = {
        "provider": "deepseek",
        "model": "independent",
        "endpoint": "https://api.deepseek.com",
        "capability": "text",
        "credential_ref": "DEEPSEEK_API_KEY",
        "timeout_seconds": 90,
    }
    saved = client.put(path, json={"base_version": prior["revision"], "value": route})
    assert saved.status_code == 200, saved.text
    url = f"/api/v1/settings/resolve/{p['id']}/story.generate?stage=story"
    snap = client.get(url).json()
    assert snap["model"]["value"]["model"] == "independent"
    assert snap["specification"]["resolution"] == "4K"
    assert (
        client.put(path, json={"base_version": saved.json()["revision"], "value": None}).status_code
        == 200
    )
    assert client.get(url).json()["model"]["source"] == "category_default"


def test_skill_upload_validations_and_types(client):
    for filename, body in [("evil.py", b"print(1)"), ("x.md", b"\xff"), ("x.txt", b"a" * 131073)]:
        assert (
            client.post(
                "/api/v1/settings/resources/import",
                data={"name": "导入", "stage": "story"},
                files={"file": (filename, body)},
            ).status_code
            == 422
        )
    name = "新增类型" + uuid4().hex
    a = client.post("/api/v1/projects/types", json={"name": name})
    assert a.status_code == 201, a.text
    assert client.post("/api/v1/projects/types", json={"name": name}).status_code == 409


def test_preview_validates_variables_and_binding_conflicts(client):
    bad = client.post(
        "/api/v1/settings/resources",
        json={
            "name": "缺变量",
            "kind": "prompt",
            "stage": "story",
            "content": "正文",
            "required_variables": ["story"],
        },
    )
    assert bad.status_code == 422
    result = client.post(
        "/api/v1/settings/preview",
        json={
            "content": "改编{{story}}",
            "variables": {"story": "旧钟"},
            "required_variables": ["story"],
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["content"] == "改编旧钟"
    assert (
        client.post(
            "/api/v1/settings/preview",
            json={"content": "{{story}}", "variables": {}, "required_variables": ["story"]},
        ).status_code
        == 422
    )
    route = {
        "provider": "deepseek",
        "model": "v1",
        "endpoint": "https://api.deepseek.com?api_key=x",
        "capability": "text",
        "credential_ref": "DEEPSEEK_API_KEY",
    }
    assert (
        client.put(
            "/api/v1/settings/bindings/system/model:step:test",
            json={"base_version": 0, "value": route},
        ).status_code
        == 422
    )


def test_project_spec_history_and_statistics(client):
    p = project(client)
    before = client.get("/api/v1/projects/statistics").json()
    path = f"/api/v1/projects/{p['id']}/specification"
    payload = {"base_version": 1, "aspect_ratio": "1:1", "resolution": "720P"}
    saved = client.put(path, json=payload)
    assert saved.status_code == 200
    assert saved.json()["generation_settings"]["width"] == 720
    assert client.put(path, json=payload).status_code == 409
    history = client.get(f"/api/v1/settings/bindings/project:{p['id']}/output/history").json()
    assert len(history) == 2
    assert history[-1]["value"]["aspect_ratio"] == "9:16"
    assert client.get("/api/v1/projects/statistics").json() == before
    rows = client.get("/api/v1/projects?status=in_progress&sort=name").json()["items"]
    assert all(r["status"] == "in_progress" for r in rows)


def test_project_inheritance_scope_and_stage_safety(client):
    p = project(client)
    created = client.post(
        "/api/v1/settings/resources",
        json={
            "name": "模板" + uuid4().hex,
            "kind": "prompt",
            "stage": "story",
            "content": "系统{{idea}}",
            "required_variables": ["idea"],
        },
    ).json()
    system = "/api/v1/settings/bindings/system/scenario:story.generate"
    base = client.get(system).json()["revision"]
    assert (
        client.put(
            system, json={"base_version": base, "value": {"resource_id": created["id"]}}
        ).status_code
        == 200
    )
    path = f"/api/v1/settings/bindings/project:{p['id']}/scenario:story.generate"
    assert (
        client.put(
            path,
            json={
                "base_version": 0,
                "value": {"resource_id": created["id"], "content": "项目{{idea}}"},
            },
        ).status_code
        == 200
    )
    url = f"/api/v1/settings/resolve/{p['id']}/story.generate?stage=story"
    frozen = client.get(url).json()
    assert frozen["template"]["source"] == "project"
    assert client.put(path, json={"base_version": 0, "value": None}).status_code == 409
    assert client.put(path, json={"base_version": 1, "value": None}).status_code == 200
    assert client.get(url).json()["template"]["content"] == "系统{{idea}}"
    assert frozen["template"]["content"] == "项目{{idea}}"
    wrong = f"/api/v1/settings/bindings/project:{p['id']}/method:script"
    assert (
        client.put(
            wrong, json={"base_version": 0, "value": {"resource_id": created["id"]}}
        ).status_code
        == 422
    )
    assert (
        client.put(
            path,
            json={"base_version": 2, "value": {"resource_id": created["id"], "content": "缺变量"}},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/v1/settings/bindings/system/model:category:audio",
            json={
                "base_version": 0,
                "value": {
                    "provider": "x",
                    "model": "x",
                    "endpoint": "https://example.com",
                    "credential_ref": "EXAMPLE_KEY",
                    "capability": "text",
                },
            },
        ).status_code
        == 422
    )
    assert client.get(f"/api/v1/settings/bindings/project:{uuid4()}/style").status_code == 404


def test_binding_rejects_invalid_resource_revision_and_unknown_key(client):
    r = client.post(
        "/api/v1/settings/resources",
        json={
            "name": "revision" + uuid4().hex,
            "kind": "skill",
            "stage": "story",
            "content": "指令",
        },
    ).json()
    assert (
        client.put(
            "/api/v1/settings/bindings/system/method:story",
            json={"base_version": 0, "value": {"resource_id": r["id"], "revision": 0}},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/v1/settings/bindings/system/nonsense", json={"base_version": 0, "value": None}
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/v1/settings/bindings/system/model:category:text",
            json={
                "base_version": 1,
                "value": {
                    "provider": "x",
                    "model": "x",
                    "endpoint": "http://remote.example",
                    "capability": "text",
                    "credential_ref": "EXAMPLE_KEY",
                },
            },
        ).status_code
        == 422
    )
