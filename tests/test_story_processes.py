"""Real text worker crash/restart. External HTTP only is a deterministic fixture."""

import json
import os
import signal
import subprocess
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
from redis import Redis
from sqlalchemy import func, select, text
from test_processes import wait_for


def test_text_worker_unknown_requires_explicit_retry(tmp_path, monkeypatch):
    from shortfilm.config import settings
    from shortfilm.db import Session
    from shortfilm.jobs.service import recover_jobs
    from shortfilm.jobs.worker import celery
    from shortfilm.main import app
    from shortfilm.models import ContentItem, Job, JobResult

    monkeypatch.setenv("STORY_PROCESS_KEY", "test-only-value")
    monkeypatch.setattr(settings, "text_credential_ref", "STORY_PROCESS_KEY")
    client = TestClient(app)
    binding_url = "/api/v1/settings/bindings/system/model:category:text"
    saved_binding = client.get(binding_url).json()
    value = {**saved_binding["value"], "credential_ref": "STORY_PROCESS_KEY"}
    assert (
        client.put(
            binding_url, json={"base_version": saved_binding["revision"], "value": value}
        ).status_code
        == 200
    )
    pid = client.post("/api/v1/projects", json={"name": "文本进程恢复验收"}).json()["id"]
    base = f"/api/v1/projects/{pid}"
    idea = client.put(
        base + "/idea", json={"revision": 0, "text": "一个邮差收到来自未来的信"}
    ).json()
    job = client.post(
        base + "/story-batches",
        json={"idea_version_id": idea["version_id"]},
        headers={"Idempotency-Key": str(uuid4())},
    ).json()
    queue = "story-process-" + uuid4().hex
    marker = tmp_path / "provider-accepted"
    calls = tmp_path / "provider-calls"
    output = {
        "stories": [
            {
                "title": "未来来信",
                "logline": "邮差寻找自己",
                "direction": "悬疑",
                "text": "邮差循着信找到未来的自己，并改变最后一次投递。",
            },
            {
                "title": "父亲的邮路",
                "logline": "父子重逢",
                "direction": "亲情",
                "text": "邮差与父亲一起走完山间邮路，解开多年的误会。",
            },
            {
                "title": "全镇的信",
                "logline": "小镇传递善意",
                "direction": "喜剧",
                "text": "大家误以为中了奖，最终发现真正的奖品是彼此。",
            },
        ]
    }
    code = """import json, os, time
from pathlib import Path
from shortfilm.creation import provider
from shortfilm.jobs.worker import celery

def fixture(config, messages, schema):
    with Path(os.environ['CALLS']).open('a') as f: f.write('call\\n')
    if os.environ['BLOCK'] == '1':
        Path(os.environ['MARKER']).touch()
        while True: time.sleep(0.1)
    return json.loads(os.environ['OUTPUT']), {'provider_request_id':'process-fixture','usage':{}}
provider.request_json = fixture
celery.worker_main(['worker','--pool=solo','-Q',os.environ['QUEUE'],'-n',os.environ['QUEUE']+'@%h','--loglevel=WARNING','--without-gossip','--without-mingle'])
"""
    env = {
        **os.environ,
        "QUEUE": queue,
        "MARKER": str(marker),
        "CALLS": str(calls),
        "OUTPUT": json.dumps(output),
        "BLOCK": "1",
    }
    process = None
    try:
        with (tmp_path / "worker.log").open("w") as log:
            process = subprocess.Popen(
                [sys.executable, "-c", code],
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            celery.send_task("shortfilm.execute", args=[job["id"]], queue=queue)
            wait_for(marker.exists)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            with Session.begin() as db:
                db.execute(
                    text(
                        "UPDATE generation_jobs SET lease_until=now()-interval '1 second' WHERE id=:id"
                    ),
                    {"id": job["id"]},
                )
            recover_jobs()
            assert client.get("/api/v1/jobs/" + job["id"]).json()["state"] == "unknown"
            assert (
                client.post(
                    "/api/v1/jobs/" + job["id"] + "/retry",
                    json={"confirm_unknown": False},
                    headers={"Idempotency-Key": str(uuid4())},
                ).status_code
                == 409
            )
            retried = client.post(
                "/api/v1/jobs/" + job["id"] + "/retry",
                json={"confirm_unknown": True},
                headers={"Idempotency-Key": str(uuid4())},
            ).json()
            process = subprocess.Popen(
                [sys.executable, "-c", code],
                env={**env, "BLOCK": "0"},
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            # Redelivering the unknown original does not submit to the provider.
            celery.send_task("shortfilm.execute", args=[job["id"]], queue=queue)
            for _ in range(3):
                celery.send_task("shortfilm.execute", args=[retried["id"]], queue=queue)

            def done():
                with Session() as db:
                    return db.get(Job, retried["id"]).state == "succeeded"

            wait_for(done)
            with Session() as db:
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(JobResult)
                        .where(JobResult.job_id == retried["id"])
                    )
                    == 1
                )
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(ContentItem)
                        .where(ContentItem.project_id == pid, ContentItem.kind == "story")
                    )
                    == 3
                )
            assert calls.read_text().splitlines() == ["call", "call"]
            # Independent API process reads the persisted candidates after restart.
            read_code = (
                "from fastapi.testclient import TestClient; from shortfilm.main import app; assert TestClient(app).get('/api/v1/projects/"
                + pid
                + "/stories').json()['total']==3"
            )
            subprocess.run([sys.executable, "-c", read_code], check=True)
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        Redis.from_url(settings.redis_url).delete(queue)
