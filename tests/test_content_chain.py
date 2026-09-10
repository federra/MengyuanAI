# ruff: noqa: F811
"""M1 full content chain: real PostgreSQL; only model transport is replaced."""

from copy import deepcopy
from uuid import uuid4

import pytest
from test_story import client, generate, model, new_project, post  # noqa: F401


@pytest.fixture
def chain_model(client, model, monkeypatch):
    original = model.request_json

    def response(config, messages, schema):
        import json

        context = json.loads(messages[1]["content"])
        fields = schema.get("properties", {})
        if "issues" in fields:
            result = {
                "summary": "存在修改建议",
                "issues": [
                    {
                        "id": "i1",
                        "message": "动机不足",
                        "evidence": "原作来信",
                        "suggestion": "补足动机",
                        "shotId": None,
                        "lineId": None,
                    }
                ],
            }
            if "scriptId" in fields:
                result.update(
                    schemaVersion=2,
                    scriptId=context["input"]["scriptId"],
                    baseBoardVersion=context["base_revision"],
                    proposedShots=context["input"]["shots"],
                )
            return result, {}
        script = {
            "text": "场景一：邮局。邮差：我先回家。",
            "scenes": [
                {
                    "id": "scene-1",
                    "heading": "邮局",
                    "actions": ["邮差收好信件。"],
                    "dialogues": [{"speaker": "邮差", "emotion": "坚定", "text": "我先回家。"}],
                }
            ],
            "estimatedSeconds": 20,
        }
        if "body" in fields:
            body = deepcopy(context["input"])
            if "text" in body:
                body["text"] += " 他推开门。"
            return {
                "body": body,
                "changeSummary": "补足动作",
                "resolvedIssueIds": ["i1"] if context.get("report") else [],
            }, {}
        if "shots" in fields:
            return {
                "schemaVersion": 2,
                "scriptId": context["source_version_id"],
                **({"catalog": [], "shotEntities": [{"shotIndex": 0, "characters": [], "scenes": [], "props": [], "lineCharacters": [None, None]}]} if "catalog" in fields else {}),
                "shots": [
                    {
                        "id": "shot-temp",
                        "dialogue": "我先回家。\n一起走。",
                        "dialogues": [
                            {
                                "id": "line-a",
                                "speaker": "邮差",
                                "emotion": "坚定",
                                "text": "我先回家。",
                                "voice": "",
                            },
                            {
                                "id": "line-b",
                                "speaker": "父亲",
                                "emotion": "欣慰",
                                "text": "一起走。",
                                "voice": "",
                            },
                        ],
                        "prompt": "邮局门口父子同行",
                        "refs": {"characters": [], "scenes": [], "props": [], "positions": []},
                        "duration": 8,
                    }
                ],
            }, {}
        if "scenes" in fields:
            return script, {}
        return original(config, messages, schema)

    monkeypatch.setattr(model, "request_json", response)
    return model


def run(client, response):
    from shortfilm.jobs.service import execute_job

    assert response.status_code == 202, response.text
    job = response.json()
    execute_job(job["id"])
    state = client.get("/api/v1/jobs/" + job["id"]).json()
    assert state["state"] == "succeeded", state
    return state


def chain(client):
    pid = new_project(client)
    idea, _, _ = generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]
    run(
        client,
        post(
            client,
            base + "/stages/script/generate",
            {"source_version_id": story["version_id"], "target_revision": 0},
        ),
    )
    script = client.get(base + "/stages/script").json()["item"]
    run(
        client,
        post(
            client,
            base + "/stages/board/generate",
            {"source_version_id": script["version_id"], "target_revision": 0},
        ),
    )
    board = client.get(base + "/stages/board").json()["item"]
    return base, idea, story, script, board


def test_chain_confirmation_advisory_and_manual_conflict(client, chain_model):
    base, idea, story, script, board = chain(client)
    stage = client.get(base + "/stages/script").json()
    assert stage["confirmation"]["version_id"] == script["version_id"]
    assert stage["confirmation"]["report_state"] == "pending"
    for line in board["body"]["shots"][0]["dialogues"]:
        from uuid import UUID

        UUID(line["id"])
    confirmed = post(
        client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["decision"] == "keep_current"
    again = post(
        client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
    )
    assert again.json()["id"] == confirmed.json()["id"]
    body = {
        "revision": script["revision"],
        "source_version_id": story["version_id"],
        "body": {**script["body"], "text": "人工正文"},
    }
    edited = client.put(base + "/stages/script", json=body)
    assert edited.status_code == 200, edited.text
    assert client.put(base + "/stages/script", json=body).status_code == 409
    assert client.get(base + "/stages/board").json()["item"]["stale"]
    assert (
        post(
            client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
        ).status_code
        == 409
    )


def test_board_semantics_and_repair_preview(client, chain_model):
    base, _, _, script, board = chain(client)
    for mutate in ("duplicate", "summary", "ref", "borrow"):
        body = deepcopy(board["body"])
        shot = body["shots"][0]
        if mutate == "duplicate":
            shot["dialogues"][1]["id"] = shot["dialogues"][0]["id"]
        if mutate == "summary":
            shot["dialogue"] = "不同摘要"
        if mutate == "ref":
            shot["refs"]["characters"] = [str(uuid4())]
        if mutate == "borrow":
            body["scriptId"] = str(uuid4())
        res = client.put(
            base + "/stages/board",
            json={"revision": 1, "source_version_id": script["version_id"], "body": body},
        )
        assert res.status_code == 422, res.text
    run(
        client,
        post(
            client,
            base + f"/contents/{board['id']}/review",
            {"base_version_id": board["version_id"]},
        ),
    )
    report = client.get(base + "/stages/board").json()["reports"][0]
    run(
        client,
        post(
            client,
            base + f"/contents/{board['id']}/repair",
            {
                "base_version_id": board["version_id"],
                "report_id": report["id"],
                "text": "按报告修复",
            },
        ),
    )
    proposal = client.get(base + f"/contents/{board['id']}/conversation").json()["proposals"][0]
    assert client.get(base + "/stages/board").json()["item"]["revision"] == 1
    applied = post(client, base + f"/proposals/{proposal['id']}/apply", {})
    assert applied.status_code == 200, applied.text
    assert applied.json()["revision"] == 2
    assert (
        post(client, base + f"/proposals/{proposal['id']}/apply", {}).json()["version_id"]
        == applied.json()["version_id"]
    )
    assert client.get(base + "/stages/board").json()["reports"][0]["state"] == "pending"


def test_late_generation_and_unknown_script_retry(client, chain_model, monkeypatch):
    from shortfilm.jobs.service import execute_job

    base, _, story, script, board = chain(client)
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": script["revision"]},
    )
    assert pending.status_code == 202, pending.text
    edited = client.put(
        base + "/stages/script",
        json={
            "revision": script["revision"],
            "source_version_id": story["version_id"],
            "body": {**script["body"], "text": "保留人工版"},
        },
    ).json()
    execute_job(pending.json()["id"])
    assert client.get(base + "/stages/script").json()["item"]["version_id"] == edited["version_id"]
    versions = client.get(base + f"/contents/{script['id']}/versions").json()
    assert len(versions) == 3

    def unknown(*args):
        raise chain_model.ProviderFailure("provider_acceptance_unknown", unknown=True)

    monkeypatch.setattr(chain_model, "request_json", unknown)
    job = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": edited["revision"]},
    ).json()
    execute_job(job["id"])
    assert client.get("/api/v1/jobs/" + job["id"]).json()["state"] == "unknown"
    assert post(client, "/api/v1/jobs/" + job["id"] + "/retry", {}).status_code == 409
    assert (
        post(client, "/api/v1/jobs/" + job["id"] + "/retry", {"confirm_unknown": True}).status_code
        == 202
    )


def test_late_archive_can_be_followed_by_save_and_other_story_selection(client, chain_model):
    from shortfilm.jobs.service import execute_job

    base, _, story, script, _ = chain(client)
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 1},
    ).json()
    saved = client.put(
        base + "/stages/script",
        json={
            "revision": 1,
            "source_version_id": story["version_id"],
            "body": {**script["body"], "text": "新的人工分场"},
        },
    ).json()
    execute_job(pending["id"])
    next_save = client.put(
        base + "/stages/script",
        json={
            "revision": saved["revision"],
            "source_version_id": story["version_id"],
            "body": {**saved["body"], "text": "第二次人工分场"},
        },
    )
    assert next_save.status_code == 200, next_save.text
    assert next_save.json()["revision"] == 4
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 4},
    ).json()
    stories = client.get(base + "/stories").json()
    other = next(s for s in stories["items"] if s["id"] != story["id"])
    assert (
        post(
            client,
            base + f"/stories/{other['id']}/select",
            {
                "version_id": other["version_id"],
                "selection_revision": stories["selection_revision"],
            },
        ).status_code
        == 200
    )
    execute_job(pending["id"])
    assert client.get(base + "/stages/script").json()["item"]["revision"] == 4


def test_report_failure_pending_stale_and_issues_never_block_continue(
    client, chain_model, monkeypatch
):
    from shortfilm.jobs.service import execute_job

    base, _, story, script, board = chain(client)
    report = client.get(base + "/stages/board").json()["reports"][0]
    original = chain_model.request_json
    monkeypatch.setattr(chain_model, "request_json", lambda *args: ({}, {}))
    execute_job(report["job_id"])
    assert client.get(base + "/stages/board").json()["reports"][0]["state"] == "failed"
    keep = post(
        client, base + f"/contents/{board['id']}/confirm", {"version_id": board["version_id"]}
    )
    assert keep.status_code == 200, keep.text
    assert keep.json()["report_state"] == "failed"
    monkeypatch.setattr(chain_model, "request_json", original)
    run(
        client,
        post(
            client,
            base + f"/contents/{script['id']}/review",
            {"base_version_id": script["version_id"]},
        ),
    )
    report = client.get(base + "/stages/script").json()["reports"][0]
    assert report["output"]["issues"]
    # A new explicit decision after a new report captures that evidence without rewriting the old decision.
    keep = post(
        client, base + f"/contents/{script['id']}/confirm", {"version_id": script["version_id"]}
    )
    assert keep.status_code == 200
    assert keep.json()["report_state"] == "succeeded"
    assert keep.json()["report_id"] == report["id"]
    edited = client.put(
        base + "/stages/script",
        json={
            "revision": 1,
            "source_version_id": story["version_id"],
            "body": {**script["body"], "text": "人工保留不同剧情"},
        },
    ).json()
    assert client.get(base + "/stages/script").json()["reports"][0]["stale"]
    run(
        client,
        post(
            client,
            base + "/stages/board/generate",
            {"source_version_id": edited["version_id"], "target_revision": board["revision"]},
        ),
    )
    assert client.get(base + "/stages/script").json()["confirmation"]["report_state"] == "stale"


def test_idea_assistant_freezes_configuration_and_requires_apply(client, chain_model):
    pid = new_project(client)
    base = f"/api/v1/projects/{pid}"
    idea = client.put(base + "/idea", json={"revision": 0, "text": "邮差收到未来来信"}).json()
    binding = "/api/v1/settings/bindings/system/model:step:ideaRefine"
    old = client.get(binding).json()
    value = {
        "provider": "test",
        "model": "idea-only",
        "endpoint": "https://model.example/v1",
        "capability": "text",
        "credential_ref": "STORY_TEST_KEY",
        "timeout_seconds": 30,
    }
    assert (
        client.put(binding, json={"base_version": old["revision"], "value": value}).status_code
        == 200
    )
    job = run(
        client,
        post(
            client,
            base + f"/contents/{idea['id']}/messages",
            {"base_version_id": idea["version_id"], "text": "强调冲突"},
        ),
    )
    assert job["snapshot"]["interaction_key"] == "ideaRefine"
    assert job["snapshot"]["configuration"]["method"] is None
    assert job["snapshot"]["model"]["model"] == "idea-only"
    assert client.get(base + "/idea").json()["version_id"] == idea["version_id"]
    proposal = client.get(base + f"/contents/{idea['id']}/conversation").json()["proposals"][0]
    applied = post(client, base + f"/proposals/{proposal['id']}/apply", {})
    assert applied.status_code == 200, applied.text
    assert applied.json()["revision"] == 2
    assert post(client, base + f"/proposals/{proposal['id']}/apply", {}).json()["revision"] == 2
    current = client.get(binding).json()
    client.put(binding, json={"base_version": current["revision"], "value": old["value"]})


def test_semantically_invalid_board_repair_fails_after_bounded_corrections(
    client, chain_model, monkeypatch
):
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.jobs.service import execute_job
    from shortfilm.models import JobAttempt
    from sqlalchemy import select

    base, _, _, _, board = chain(client)
    run(
        client,
        post(
            client,
            base + f"/contents/{board['id']}/review",
            {"base_version_id": board["version_id"]},
        ),
    )
    report = client.get(base + "/stages/board").json()["reports"][0]

    def invalid(*args):
        value = deepcopy(board["body"])
        value["shots"][0]["dialogues"].pop()
        value["shots"][0]["dialogue"] = value["shots"][0]["dialogues"][0]["text"]
        return {"body": value, "changeSummary": "删台词", "resolvedIssueIds": ["i1"]}, {}

    monkeypatch.setattr(chain_model, "request_json", invalid)
    job = post(
        client,
        base + f"/contents/{board['id']}/repair",
        {"base_version_id": board["version_id"], "report_id": report["id"]},
    ).json()
    execute_job(job["id"])
    result = client.get("/api/v1/jobs/" + job["id"]).json()
    assert result["state"] == "failed", result
    assert result["error"] == "invalid_model_output"
    with Session() as db:
        attempt = db.scalar(select(JobAttempt).where(JobAttempt.job_id == UUID(job["id"])))
        assert len(attempt.provider_calls) == 3
    assert client.get(base + "/stages/board").json()["item"]["version_id"] == board["version_id"]
    assert not client.get(base + f"/contents/{board['id']}/conversation").json()["proposals"]


def test_board_manual_ids_reorder_and_cross_project_reservations(client, chain_model):
    base, _, _, script, board = chain(client)
    other, _, _, other_script, other_board = chain(client)
    body = deepcopy(board["body"])
    extra = deepcopy(body["shots"][0])
    extra["id"] = str(uuid4())
    for line in extra["dialogues"]:
        line["id"] = str(uuid4())
    body["shots"].insert(0, extra)
    result = client.put(
        base + "/stages/board",
        json={"revision": 1, "source_version_id": script["version_id"], "body": body},
    )
    assert result.status_code == 200, result.text
    assert result.json()["body"]["shots"][1]["id"] == board["body"]["shots"][0]["id"]
    borrowed = deepcopy(other_board["body"])
    borrowed["shots"][0]["id"] = extra["id"]
    bad = client.put(
        other + "/stages/board",
        json={"revision": 1, "source_version_id": other_script["version_id"], "body": borrowed},
    )
    assert bad.status_code == 422, bad.text


def test_script_repair_freezes_story_full_report_and_rechecks_after_apply(client, chain_model):
    base, _, story, script, _ = chain(client)
    run(
        client,
        post(
            client,
            base + f"/contents/{script['id']}/review",
            {"base_version_id": script["version_id"]},
        ),
    )
    report = client.get(base + "/stages/script").json()["reports"][0]
    job = run(
        client,
        post(
            client,
            base + f"/contents/{script['id']}/repair",
            {
                "base_version_id": script["version_id"],
                "report_id": report["id"],
                "text": "保持原作",
            },
        ),
    )
    assert job["snapshot"]["source"] == story["body"]
    assert job["snapshot"]["report"] == report["output"]
    assert job["snapshot"]["interaction_key"] == "scriptRepair"
    proposal = client.get(base + f"/contents/{script['id']}/conversation").json()["proposals"][0]
    applied = post(client, base + f"/proposals/{proposal['id']}/apply", {})
    assert applied.status_code == 200, applied.text
    assert client.get(base + "/stages/script").json()["reports"][0]["state"] == "pending"


def test_dispatcher_routes_all_text_jobs_to_real_redis_ai_queue(client, chain_model):
    import base64
    import json

    from redis import Redis
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.jobs.dispatcher import dispatch_once
    from shortfilm.models import Job
    from sqlalchemy import select

    redis = Redis.from_url(settings.redis_url)
    base, idea, story, script, board = chain(client)
    pending = []
    for item in (idea, script, board):
        job = post(
            client,
            base + f"/contents/{item['id']}/messages",
            {"base_version_id": item["version_id"], "text": "补足动作"},
        ).json()
        pending.append(job["id"])
    with Session() as db:
        database_ids = {str(i) for i in db.scalars(select(Job.id)).all()}
    try:
        for _ in range(20):
            if dispatch_once() == 0:
                break
        received = {}
        for queue in ("ai", "media"):
            for raw in redis.lrange(queue, 0, -1):
                envelope = json.loads(raw)
                payload = json.loads(base64.b64decode(envelope["body"]))
                if payload[0] and str(payload[0][0]) in pending:
                    received[str(payload[0][0])] = queue
        assert received == {i: "ai" for i in pending}
    finally:
        # Remove only this disposable database's messages, preserving other app queues.
        for queue in ("ai", "media"):
            for raw in redis.lrange(queue, 0, -1):
                payload = json.loads(base64.b64decode(json.loads(raw)["body"]))
                if payload[0] and str(payload[0][0]) in database_ids:
                    redis.lrem(queue, 0, raw)


def test_frozen_method_wrapper_drive_actual_call_after_config_changes(
    client, chain_model, monkeypatch
):
    pid = new_project(client)
    generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]
    resources = "/api/v1/settings/resources"
    method = client.post(
        resources,
        json={
            "name": "冻结方法-" + uuid4().hex,
            "kind": "skill",
            "stage": "script",
            "content": "FROZEN-METHOD",
            "required_variables": [],
        },
    ).json()
    wrapper = client.post(
        resources,
        json={
            "name": "冻结模板-" + uuid4().hex,
            "kind": "prompt",
            "stage": "script",
            "content": "FROZEN-WRAPPER {{market}} {{instruction}}",
            "required_variables": ["market", "instruction"],
        },
    ).json()
    for key, rid in [("method:script", method["id"]), ("scenario:script", wrapper["id"])]:
        binding = f"/api/v1/settings/bindings/project:{pid}/{key}"
        assert (
            client.put(binding, json={"base_version": 0, "value": {"resource_id": rid}}).status_code
            == 200
        )
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 0, "instruction": "完整结局"},
    )
    assert pending.status_code == 202, pending.text
    for resource in (method, wrapper):
        assert (
            client.put(
                resources + "/" + resource["id"],
                json={
                    "base_version": 1,
                    "name": resource["name"],
                    "content": "LATER-CHANGED",
                    "required_variables": [],
                },
            ).status_code
            == 200
        )
    original = chain_model.request_json

    def transport(config, messages, schema):
        system = messages[0]["content"]
        assert "FROZEN-METHOD" in system and "FROZEN-WRAPPER zh 完整结局" in system
        assert "LATER-CHANGED" not in system
        assert config["model"] == "test-model"
        return original(config, messages, schema)

    monkeypatch.setattr(chain_model, "request_json", transport)
    result = run(client, pending)
    assert result["snapshot"]["configuration"]["method"]["id"] == method["id"]
    assert result["snapshot"]["configuration"]["template"]["id"] == wrapper["id"]


def test_script_job_runs_in_independent_real_redis_worker(client, chain_model, tmp_path):
    import json
    import os
    import signal
    import subprocess
    import sys

    from redis import Redis
    from shortfilm.config import settings
    from shortfilm.jobs.worker import celery
    from test_processes import wait_for

    pid = new_project(client)
    generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]
    job = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 0},
    ).json()
    output = {
        "text": "父子一起回家",
        "scenes": [
            {"id": "scene-1", "heading": "邮局", "actions": ["父子一起回家"], "dialogues": []}
        ],
        "estimatedSeconds": 10,
    }
    code = """import json,os
from shortfilm.creation import provider
from shortfilm.jobs.worker import celery
provider.request_json=lambda *args:(json.loads(os.environ['OUTPUT']),{'provider_request_id':'script-worker-fixture'})
celery.worker_main(['worker','--pool=solo','-Q',os.environ['QUEUE'],'-n',os.environ['QUEUE']+'@%h','--loglevel=WARNING','--without-gossip','--without-mingle'])
"""
    queue = "script-process-" + uuid4().hex
    process = None
    try:
        with (tmp_path / "worker.log").open("w") as log:
            process = subprocess.Popen(
                [sys.executable, "-c", code],
                env={**os.environ, "QUEUE": queue, "OUTPUT": json.dumps(output)},
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            celery.send_task("shortfilm.execute", args=[job["id"]], queue=queue)
            wait_for(lambda: client.get("/api/v1/jobs/" + job["id"]).json()["state"] == "succeeded")
        script = client.get(base + "/stages/script").json()
        assert script["item"]["body"]["scenes"][0]["actions"] == ["父子一起回家"]
        assert script["reports"][0]["state"] == "pending"
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        Redis.from_url(settings.redis_url).delete(queue)


def test_pending_stage_has_no_confirmable_content_and_spec_reaches_model(
    client, chain_model, monkeypatch
):
    pid = new_project(client)
    generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 0},
    )
    iid = pending.json()["snapshot"]["item_id"]
    result = post(client, base + f"/contents/{iid}/confirm", {"version_id": str(uuid4())})
    assert result.status_code == 409, result.text
    original = chain_model.request_json

    def transport(config, messages, schema):
        import json

        context = json.loads(messages[1]["content"])
        assert context["specification"]["aspect_ratio"] == "9:16"
        assert context["specification"]["resolution"] == "1080P"
        return original(config, messages, schema)

    monkeypatch.setattr(chain_model, "request_json", transport)
    run(client, pending)


def test_auto_review_renders_frozen_template_with_generated_version(client, chain_model):
    pid = new_project(client)
    generate(client, pid)
    base = f"/api/v1/projects/{pid}"
    story = client.get(base + "/stories").json()["items"][0]
    template = client.post(
        "/api/v1/settings/resources",
        json={
            "name": "自动报告-" + uuid4().hex,
            "kind": "prompt",
            "stage": "scriptReview",
            "content": "REVIEW {{base_version_id}} {{input}}",
            "required_variables": ["base_version_id", "input"],
        },
    ).json()
    assert (
        client.put(
            f"/api/v1/settings/bindings/project:{pid}/scenario:scriptReview",
            json={"base_version": 0, "value": {"resource_id": template["id"]}},
        ).status_code
        == 200
    )
    pending = post(
        client,
        base + "/stages/script/generate",
        {"source_version_id": story["version_id"], "target_revision": 0},
    )
    assert (
        client.put(
            "/api/v1/settings/resources/" + template["id"],
            json={
                "base_version": 1,
                "name": template["name"],
                "content": "NEWER-DO-NOT-USE",
                "required_variables": [],
            },
        ).status_code
        == 200
    )
    run(client, pending)
    stage = client.get(base + "/stages/script").json()
    report = stage["reports"][0]
    assert report["state"] == "pending", report
    snapshot = client.get("/api/v1/jobs/" + report["job_id"]).json()["snapshot"]
    assert stage["item"]["version_id"] in snapshot["prompt"]["template"]
    assert stage["item"]["body"]["scenes"][0]["heading"] in snapshot["prompt"]["template"]
    assert "NEWER-DO-NOT-USE" not in snapshot["prompt"]["template"]


def test_unchanged_manual_script_save_preserves_confirmed_downstream(client, chain_model):
    base, _, story, script, board = chain(client)
    edited = client.put(
        base + "/stages/script",
        json={
            "revision": script["revision"],
            "source_version_id": story["version_id"],
            "body": {**script["body"], "text": "人工正文"},
        },
    )
    assert edited.status_code == 200, edited.text
    saved = edited.json()
    run(
        client,
        post(
            client,
            base + "/stages/board/generate",
            {"source_version_id": saved["version_id"], "target_revision": board["revision"]},
        ),
    )
    downstream = client.get(base + "/stages/board").json()["item"]
    confirmed = post(
        client,
        base + f"/contents/{downstream['id']}/confirm",
        {"version_id": downstream["version_id"]},
    )
    assert confirmed.status_code == 200, confirmed.text
    before_script = client.get(base + "/stages/script").json()
    before_board = client.get(base + "/stages/board").json()
    repeated = client.put(
        base + "/stages/script",
        json={
            "revision": saved["revision"],
            "source_version_id": story["version_id"],
            "body": saved["body"],
        },
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == saved
    assert client.get(base + "/stages/script").json() == before_script
    assert client.get(base + "/stages/board").json() == before_board
    assert not before_board["item"]["stale"]
    changed = client.put(
        base + "/stages/script",
        json={
            "revision": saved["revision"],
            "source_version_id": story["version_id"],
            "body": {**saved["body"], "text": "人工正文，补充新的结局。"},
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] > saved["revision"]
    assert changed.json()["version_id"] != saved["version_id"]
    assert client.get(base + "/stages/board").json()["item"]["stale"]


def test_board_correction_receives_specific_validation_reason(client, chain_model, monkeypatch):
    import json
    from uuid import UUID

    from shortfilm.db import Session
    from shortfilm.models import JobAttempt
    from sqlalchemy import select

    base, _, _, script, board = chain(client)
    calls = []

    def corrected(config, messages, schema):
        calls.append(deepcopy(messages))
        body = deepcopy(board["body"])
        body.update(catalog=[], shotEntities=[{"shotIndex": 0, "characters": [], "scenes": [], "props": [], "lineCharacters": [None, None]}])
        if len(calls) == 1:
            body["shots"][0]["dialogue"] = "private-invalid-output-marker"
        else:
            assert "台词摘要必须与逐段正文一致" in messages[-1]["content"]
        return body, {}

    monkeypatch.setattr(chain_model, "request_json", corrected)
    result = run(
        client,
        post(
            client,
            base + "/stages/board/generate",
            {
                "source_version_id": script["version_id"],
                "target_revision": board["revision"],
            },
        ),
    )
    assert len(calls) == 2
    with Session() as db:
        attempt = db.scalar(select(JobAttempt).where(JobAttempt.job_id == UUID(result["id"])))
        errors = attempt.provider_calls[0]["validation_errors"]
        assert "台词摘要必须与逐段正文一致" in json.dumps(errors, ensure_ascii=False)
        assert errors[0]["path"] == ["shots", 0]
        assert "private-invalid-output-marker" not in json.dumps(errors)
